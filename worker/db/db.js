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

function close() {
  if (db) { db.close(); db = null; }
}

module.exports = {
  connect, upsertJob, transition, setMatchResult,
  appliedThisWeek, recordApplication, countByStatus, getByStatus,
  isoWeekKey, close, TRANSITIONS, DB_PATH
};
