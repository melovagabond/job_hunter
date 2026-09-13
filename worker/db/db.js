// SQLite persistence layer. Single source of truth for job state.
// Redis, if you keep it, is a cache. This file is the ledger.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.JOB_DB_PATH
  || path.join(__dirname, '..', '..', 'data', 'jobs.sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id                INTEGER PRIMARY KEY,
  dedupe_key        TEXT NOT NULL UNIQUE,
  source            TEXT NOT NULL,
  source_id         TEXT,
  title             TEXT NOT NULL,
  company           TEXT,
  location          TEXT,
  is_remote         INTEGER NOT NULL DEFAULT 0,
  salary_min        INTEGER,
  salary_max        INTEGER,
  currency          TEXT DEFAULT 'USD',
  url               TEXT,
  description       TEXT,
  posted_at         TEXT,
  fetched_at        TEXT NOT NULL DEFAULT (datetime('now')),
  match_score       REAL,
  match_reasons     TEXT,
  status            TEXT NOT NULL DEFAULT 'new',
  status_updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);

CREATE TABLE IF NOT EXISTS status_history (
  id          INTEGER PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id),
  from_status TEXT,
  to_status   TEXT NOT NULL,
  note        TEXT,
  changed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id             INTEGER PRIMARY KEY,
  job_id         INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  applied_at     TEXT NOT NULL DEFAULT (datetime('now')),
  week_key       TEXT NOT NULL,
  resume_variant TEXT,
  notes          TEXT
);

CREATE INDEX IF NOT EXISTS idx_applications_week ON applications(week_key);

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(
  title, company, location, description,
  content='jobs', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS jobs_fts_insert AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, location, description)
  VALUES (new.id, new.title, new.company, new.location, new.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_delete AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description)
  VALUES ('delete', old.id, old.title, old.company, old.location, old.description);
END;
CREATE TRIGGER IF NOT EXISTS jobs_fts_update AFTER UPDATE OF title, company, location, description ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, location, description)
  VALUES ('delete', old.id, old.title, old.company, old.location, old.description);
  INSERT INTO jobs_fts(rowid, title, company, location, description)
  VALUES (new.id, new.title, new.company, new.location, new.description);
END;
`;

// Allowed state transitions. Anything not listed throws.
// rejected and skipped are reachable from any non-terminal state.
const TRANSITIONS = {
  new:            ['matched', 'skipped'],
  matched:        ['queued', 'skipped', 'rejected'],
  queued:         ['applied', 'skipped'],
  applied:        ['needs_followup', 'rejected'],
  needs_followup: ['followed_up', 'rejected'],
  followed_up:    ['rejected'],
  rejected:       [],
  skipped:        ['matched']
};

let db = null;

function connect() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')");
  return db;
}

// ISO week key like 2026-W30, used by the weekly apply governor.
function isoWeekKey(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Insert if unseen, ignore if the dedupe key already exists.
// Returns { inserted: bool, id }.
function upsertJob(job) {
  const conn = connect();
  const existing = conn
    .prepare('SELECT id FROM jobs WHERE dedupe_key = ?')
    .get(job.dedupe_key);
  if (existing) return { inserted: false, id: existing.id };

  const info = conn.prepare(`
    INSERT INTO jobs (
      dedupe_key, source, source_id, title, company, location, is_remote,
      salary_min, salary_max, currency, url, description, posted_at
    ) VALUES (
      @dedupe_key, @source, @source_id, @title, @company, @location, @is_remote,
      @salary_min, @salary_max, @currency, @url, @description, @posted_at
    )
  `).run({
    currency: 'USD',
    source_id: null,
    company: null,
    location: null,
    salary_min: null,
    salary_max: null,
    url: null,
    description: null,
    posted_at: null,
    ...job,
    is_remote: job.is_remote ? 1 : 0
  });
  return { inserted: true, id: info.lastInsertRowid };
}

function transition(jobId, toStatus, note = null) {
  const conn = connect();
  const row = conn.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
  if (!row) throw new Error(`job ${jobId} not found`);

  const allowed = TRANSITIONS[row.status] || [];
  if (!allowed.includes(toStatus)) {
    throw new Error(
      `illegal transition ${row.status} -> ${toStatus} for job ${jobId}`
    );
  }

  const move = conn.transaction(() => {
    conn.prepare(`
      UPDATE jobs SET status = ?, status_updated_at = datetime('now') WHERE id = ?
    `).run(toStatus, jobId);
    conn.prepare(`
      INSERT INTO status_history (job_id, from_status, to_status, note)
      VALUES (?, ?, ?, ?)
    `).run(jobId, row.status, toStatus, note);
  });
  move();
  return { from: row.status, to: toStatus };
}

function setMatchResult(jobId, score, reasons) {
  connect().prepare(
    'UPDATE jobs SET match_score = ?, match_reasons = ? WHERE id = ?'
  ).run(score, JSON.stringify(reasons), jobId);
}

// Governor helpers. Phase 1 stores the data; the enforcement loop is phase 2.
function appliedThisWeek(date = new Date()) {
  const row = connect().prepare(
    'SELECT COUNT(*) AS n FROM applications WHERE week_key = ?'
  ).get(isoWeekKey(date));
  return row.n;
}

function recordApplication(jobId, resumeVariant = null, notes = null) {
  connect().prepare(`
    INSERT INTO applications (job_id, week_key, resume_variant, notes)
    VALUES (?, ?, ?, ?)
  `).run(jobId, isoWeekKey(), resumeVariant, notes);
}

function governorStatus(cap, date = new Date()) {
  const conn = connect();
  const weekKey = isoWeekKey(date);
  const applied = conn.prepare(
    'SELECT COUNT(*) AS n FROM applications WHERE week_key = ?'
  ).get(weekKey).n;
  const backlog = conn.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'applied'"
  ).get().n;

  if (applied >= cap) {
    return {
      allowed: false, reason: 'weekly_cap_reached',
      applied_this_week: applied, cap, backlog
    };
  }
  if (applied === 0 && backlog > 0) {
    return {
      allowed: false, reason: 'unsorted_backlog',
      applied_this_week: applied, cap, backlog
    };
  }
  return {
    allowed: true, reason: null, applied_this_week: applied,
    cap, remaining: cap - applied, backlog
  };
}

// Check the governor, transition the job, and record the application in
// one IMMEDIATE transaction. This prevents a partial application record
// and keeps concurrent API requests from racing past the weekly cap.
function applyJob(jobId, cap, resumeVariant = null, notes = null) {
  const conn = connect();
  const apply = conn.transaction(() => {
    const before = governorStatus(cap);
    if (!before.allowed) return { applied: false, governor: before };

    const row = conn.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId);
    if (!row) throw new Error(`job ${jobId} not found`);
    if (row.status !== 'queued') {
      throw new Error(`illegal transition ${row.status} -> applied for job ${jobId}`);
    }

    conn.prepare(`
      UPDATE jobs SET status = 'applied', status_updated_at = datetime('now')
      WHERE id = ?
    `).run(jobId);
    conn.prepare(`
      INSERT INTO status_history (job_id, from_status, to_status, note)
      VALUES (?, 'queued', 'applied', ?)
    `).run(jobId, notes || 'applied via api');
    conn.prepare(`
      INSERT INTO applications (job_id, week_key, resume_variant, notes)
      VALUES (?, ?, ?, ?)
    `).run(jobId, isoWeekKey(), resumeVariant, notes);

    return {
      applied: true,
      from: 'queued',
      to: 'applied',
      governor: governorStatus(cap)
    };
  });
  return apply.immediate();
}

function countByStatus() {
  const rows = connect().prepare(
    'SELECT status, COUNT(*) AS n FROM jobs GROUP BY status'
  ).all();
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}

function getByStatus(status, limit = 200) {
  return connect().prepare(
    'SELECT * FROM jobs WHERE status = ? ORDER BY match_score DESC, fetched_at DESC LIMIT ?'
  ).all(status, limit);
}

function ftsQuery(query) {
  const tokens = String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) || [];
  return tokens.slice(0, 12).map(token => `"${token.replace(/"/g, '""')}"*`).join(' OR ');
}

function searchJobs(query, status = null, limit = 100) {
  const match = ftsQuery(query);
  if (!match) return [];
  const conn = connect();
  const statusClause = status ? 'AND j.status = ?' : '';
  const params = status ? [match, status, limit] : [match, limit];
  return conn.prepare(`
    SELECT j.*, -bm25(jobs_fts, 8.0, 3.0, 1.0, 1.0) AS search_rank
    FROM jobs_fts
    JOIN jobs j ON j.id = jobs_fts.rowid
    WHERE jobs_fts MATCH ? ${statusClause}
    ORDER BY search_rank DESC, j.match_score DESC, j.fetched_at DESC
    LIMIT ?
  `).all(...params);
}

function rebuildSearchIndex() {
  connect().exec("INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')");
}

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  connect, upsertJob, transition, setMatchResult,
  appliedThisWeek, recordApplication, governorStatus, applyJob,
  countByStatus, getByStatus,
  searchJobs, rebuildSearchIndex,
  isoWeekKey, close, TRANSITIONS, DB_PATH
};
