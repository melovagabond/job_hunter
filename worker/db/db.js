// SQLite persistence layer. Single source of truth for job state.
// Redis, if you keep it, is a cache. This file is the ledger.

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { dedupeKey } = require('../lib/normalize');

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
  expires_at        TEXT,
  employment_type   TEXT,
  workplace_type    TEXT,
  seniority         TEXT,
  fetched_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at      TEXT NOT NULL DEFAULT (datetime('now')),
  is_stale          INTEGER NOT NULL DEFAULT 0,
  match_score       REAL,
  match_reasons     TEXT,
  match_breakdown   TEXT,
  missing_skills    TEXT,
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

CREATE TABLE IF NOT EXISTS job_sources (
  id            INTEGER PRIMARY KEY,
  job_id        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  source_key    TEXT NOT NULL UNIQUE,
  source        TEXT NOT NULL,
  source_id     TEXT,
  url           TEXT,
  posted_at     TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_sources_job ON job_sources(job_id);
CREATE INDEX IF NOT EXISTS idx_job_sources_source ON job_sources(source);

CREATE TABLE IF NOT EXISTS source_runs (
  id          INTEGER PRIMARY KEY,
  source      TEXT NOT NULL,
  started_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  fetched     INTEGER NOT NULL DEFAULT 0,
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  matched     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_source_runs_source ON source_runs(source, started_at);

CREATE TABLE IF NOT EXISTS job_feedback (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  reason     TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_feedback_job ON job_feedback(job_id);

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

function ensureColumn(conn, table, column, definition) {
  const columns = conn.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  if (!columns.includes(column)) {
    conn.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function sourceKey(job) {
  const identity = job.source_id || job.url || job.dedupe_key;
  return crypto.createHash('sha1').update(`${job.source}|${identity}`).digest('hex');
}

function migrate(conn) {
  ensureColumn(conn, 'jobs', 'expires_at', 'TEXT');
  ensureColumn(conn, 'jobs', 'employment_type', 'TEXT');
  ensureColumn(conn, 'jobs', 'workplace_type', 'TEXT');
  ensureColumn(conn, 'jobs', 'seniority', 'TEXT');
  ensureColumn(conn, 'jobs', 'last_seen_at', "TEXT NOT NULL DEFAULT '1970-01-01 00:00:00'");
  ensureColumn(conn, 'jobs', 'is_stale', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(conn, 'jobs', 'match_breakdown', 'TEXT');
  ensureColumn(conn, 'jobs', 'missing_skills', 'TEXT');
  conn.exec('CREATE INDEX IF NOT EXISTS idx_jobs_last_seen ON jobs(last_seen_at)');

  const version = conn.pragma('user_version', { simple: true });
  if (version < 2) {
    const rows = conn.prepare('SELECT id, company, title, location FROM jobs').all();
    const update = conn.prepare(`
      UPDATE jobs SET dedupe_key = ?,
        last_seen_at = CASE WHEN last_seen_at = '1970-01-01 00:00:00' THEN fetched_at ELSE last_seen_at END
      WHERE id = ?
    `);
    conn.transaction(() => {
      for (const row of rows) {
        update.run(dedupeKey(row.company, row.title, row.location), row.id);
      }
    })();
    conn.pragma('user_version = 2');
  }

  const rows = conn.prepare(
    'SELECT id, dedupe_key, source, source_id, url, posted_at FROM jobs'
  ).all();
  const addSource = conn.prepare(`
    INSERT OR IGNORE INTO job_sources (job_id, source_key, source, source_id, url, posted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  conn.transaction(() => {
    for (const row of rows) {
      addSource.run(row.id, sourceKey(row), row.source, row.source_id, row.url, row.posted_at);
    }
  })();
}

function connect() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  const jobsCount = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
  const ftsCount = db.prepare('SELECT COUNT(*) AS n FROM jobs_fts').get().n;
  if (jobsCount !== ftsCount) {
    db.exec("INSERT INTO jobs_fts(jobs_fts) VALUES ('rebuild')");
  }
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

function recordSource(conn, jobId, job) {
  conn.prepare(`
    INSERT INTO job_sources (job_id, source_key, source, source_id, url, posted_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key) DO UPDATE SET
      last_seen_at = datetime('now'),
      url = COALESCE(excluded.url, url),
      posted_at = COALESCE(excluded.posted_at, posted_at)
  `).run(jobId, sourceKey(job), job.source, job.source_id, job.url, job.posted_at);
}

// Insert unseen jobs, but refresh canonical data and provenance whenever a
// posting reappears. Returns { inserted, updated, id }.
function upsertJob(job) {
  const conn = connect();
  const exact = conn.prepare(
    'SELECT job_id AS id FROM job_sources WHERE source_key = ?'
  ).get(sourceKey(job));
  const existing = exact || conn.prepare(
    'SELECT id FROM jobs WHERE dedupe_key = ?'
  ).get(job.dedupe_key);
  if (existing) {
    conn.transaction(() => {
      conn.prepare(`
        UPDATE jobs SET
          source = ?, source_id = COALESCE(?, source_id),
          company = COALESCE(?, company), location = COALESCE(?, location),
          is_remote = ?, salary_min = COALESCE(?, salary_min),
          salary_max = COALESCE(?, salary_max), currency = COALESCE(?, currency),
          url = COALESCE(?, url),
          description = CASE
            WHEN length(COALESCE(?, '')) >= length(COALESCE(description, '')) THEN ?
            ELSE description END,
          posted_at = COALESCE(?, posted_at), expires_at = COALESCE(?, expires_at),
          employment_type = COALESCE(?, employment_type),
          workplace_type = COALESCE(?, workplace_type),
          seniority = COALESCE(?, seniority),
          last_seen_at = datetime('now'), is_stale = 0
        WHERE id = ?
      `).run(
        job.source, job.source_id, job.company, job.location, job.is_remote ? 1 : 0,
        job.salary_min, job.salary_max, job.currency, job.url,
        job.description, job.description, job.posted_at, job.expires_at,
        job.employment_type, job.workplace_type, job.seniority, existing.id
      );
      recordSource(conn, existing.id, job);
    })();
    return { inserted: false, updated: true, id: existing.id };
  }

  const info = conn.prepare(`
    INSERT INTO jobs (
      dedupe_key, source, source_id, title, company, location, is_remote,
      salary_min, salary_max, currency, url, description, posted_at,
      expires_at, employment_type, workplace_type, seniority, last_seen_at
    ) VALUES (
      @dedupe_key, @source, @source_id, @title, @company, @location, @is_remote,
      @salary_min, @salary_max, @currency, @url, @description, @posted_at,
      @expires_at, @employment_type, @workplace_type, @seniority, datetime('now')
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
    expires_at: null,
    employment_type: null,
    workplace_type: null,
    seniority: null,
    ...job,
    is_remote: job.is_remote ? 1 : 0
  });
  recordSource(conn, info.lastInsertRowid, job);
  return { inserted: true, updated: false, id: info.lastInsertRowid };
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

function setMatchResult(jobId, score, reasons, breakdown = null, missingSkills = []) {
  connect().prepare(
    `UPDATE jobs SET match_score = ?, match_reasons = ?,
      match_breakdown = ?, missing_skills = ? WHERE id = ?`
  ).run(score, JSON.stringify(reasons), breakdown ? JSON.stringify(breakdown) : null,
    JSON.stringify(missingSkills || []), jobId);
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
    'SELECT status, COUNT(*) AS n FROM jobs WHERE is_stale = 0 GROUP BY status'
  ).all();
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}

function getByStatus(status, limitOrOptions = 200) {
  const options = typeof limitOrOptions === 'number'
    ? { limit: limitOrOptions }
    : limitOrOptions || {};
  const clauses = ['status = ?'];
  const params = [status];
  if (options.source) {
    clauses.push('EXISTS (SELECT 1 FROM job_sources js WHERE js.job_id = jobs.id AND js.source = ?)');
    params.push(options.source);
  }
  if (options.minScore != null) { clauses.push('COALESCE(match_score, 0) >= ?'); params.push(options.minScore); }
  if (!options.includeStale) clauses.push('is_stale = 0');
  if (options.days != null) {
    clauses.push("last_seen_at >= datetime('now', ?)");
    params.push(`-${Math.max(1, options.days)} days`);
  }
  const sort = options.sort === 'newest'
    ? 'COALESCE(posted_at, fetched_at) DESC'
    : options.sort === 'salary'
      ? 'salary_max DESC, salary_min DESC'
      : 'match_score DESC, COALESCE(posted_at, fetched_at) DESC';
  params.push(Math.max(1, Math.min(options.limit || 200, 500)));
  return connect().prepare(
    `SELECT * FROM jobs WHERE ${clauses.join(' AND ')} ORDER BY ${sort} LIMIT ?`
  ).all(...params);
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

function markStaleJobs(days = 14) {
  const modifier = `-${Math.max(1, Number(days) || 14)} days`;
  return connect().prepare(`
    UPDATE jobs SET is_stale = 1
    WHERE status IN ('new', 'matched', 'skipped')
      AND is_stale = 0
      AND last_seen_at < datetime('now', ?)
  `).run(modifier).changes;
}

function startSourceRun(source) {
  return connect().prepare(
    'INSERT INTO source_runs (source) VALUES (?)'
  ).run(source).lastInsertRowid;
}

function finishSourceRun(id, result) {
  connect().prepare(`
    UPDATE source_runs SET finished_at = datetime('now'), status = ?,
      fetched = ?, inserted = ?, updated = ?, matched = ?, skipped = ?,
      duration_ms = ?, error = ? WHERE id = ?
  `).run(
    result.status || 'ok', result.fetched || 0, result.inserted || 0,
    result.updated || 0, result.matched || 0, result.skipped || 0,
    result.duration_ms || 0, result.error || null, id
  );
}

function sourceMetrics(limit = 30) {
  return connect().prepare(`
    SELECT source,
      COUNT(*) AS runs,
      MAX(started_at) AS last_run,
      SUM(fetched) AS fetched,
      SUM(inserted) AS inserted,
      SUM(updated) AS updated,
      SUM(matched) AS matched,
      SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
      ROUND(AVG(duration_ms)) AS avg_duration_ms
    FROM (SELECT * FROM source_runs ORDER BY id DESC LIMIT ?)
    GROUP BY source ORDER BY source
  `).all(limit * 20);
}

function recordFeedback(jobId, action, reason, detail = null) {
  const allowedActions = ['queue', 'skip', 'reject', 'apply', 'followup', 'note'];
  if (!allowedActions.includes(action)) throw new Error(`invalid feedback action: ${action}`);
  return connect().prepare(`
    INSERT INTO job_feedback (job_id, action, reason, detail) VALUES (?, ?, ?, ?)
  `).run(jobId, action, reason, detail).lastInsertRowid;
}

function feedbackMetrics() {
  return connect().prepare(`
    SELECT action, reason, COUNT(*) AS n
    FROM job_feedback GROUP BY action, reason ORDER BY n DESC, action, reason
  `).all();
}

function digest(hours = 72, limit = 20) {
  const modifier = `-${Math.max(1, Number(hours) || 72)} hours`;
  return connect().prepare(`
    SELECT * FROM jobs
    WHERE status = 'matched' AND is_stale = 0
      AND last_seen_at >= datetime('now', ?)
    ORDER BY match_score DESC, COALESCE(posted_at, fetched_at) DESC LIMIT ?
  `).all(modifier, Math.max(1, Math.min(limit, 100)));
}

function close() {
  if (db) { db.close(); db = null; }
}

function withTransaction(fn) {
  return connect().transaction(fn)();
}

module.exports = {
  connect, upsertJob, transition, setMatchResult,
  appliedThisWeek, recordApplication, governorStatus, applyJob,
  countByStatus, getByStatus,
  searchJobs, rebuildSearchIndex,
  markStaleJobs, startSourceRun, finishSourceRun, sourceMetrics,
  recordFeedback, feedbackMetrics, digest,
  withTransaction,
  isoWeekKey, close, TRANSITIONS, DB_PATH
};
