// Tracking API. Serves the dashboard from /public and exposes the
// job ledger over JSON. The apply endpoint is governor gated: the
// server, not the client, decides whether an application may be
// recorded. Never trust the UI, including your own.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../worker/db/db');
const governor = require('../worker/lib/governor');
const { normalize } = require('../worker/lib/normalize');
const { evaluate } = require('../worker/lib/match');
const { loadProfile } = require('../worker/lib/profile');

const PORT = process.env.API_PORT || 3001;
const VALID_STATUSES = Object.keys(db.TRANSITIONS);

function weeklyCap() {
  const p = path.join(__dirname, '..', 'config', 'criteria.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).weekly_apply_cap;
}

function buildApp(options = {}) {
  const app = express();
  const getWeeklyCap = options.weeklyCap || weeklyCap;
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/stats', (req, res) => {
    res.json({
      by_status: db.countByStatus(),
      governor: governor.status(getWeeklyCap()),
      week: db.isoWeekKey()
    });
  });

  app.get('/api/jobs', (req, res) => {
    const status = req.query.status || 'matched';
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `unknown status: ${status}` });
    }
    const parsedLimit = parseInt(req.query.limit || '100', 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 500))
      : 100;
    res.json(db.getByStatus(status, limit));
  });

  app.get('/api/search', (req, res) => {
    const query = String(req.query.q || '').trim();
    if (!query) return res.status(400).json({ error: 'q is required' });
    const status = req.query.status ? String(req.query.status) : null;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `unknown status: ${status}` });
    }
    const parsedLimit = parseInt(req.query.limit || '100', 10);
    const limit = Number.isFinite(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 500))
      : 100;
    res.json(db.searchJobs(query, status, limit));
  });

  app.get('/api/profile', (req, res) => {
    const profile = loadProfile();
    if (!profile) return res.status(404).json({ error: 'resume not found' });
    res.json(profile);
  });

  app.get('/api/indexes', (req, res) => {
    const criteria = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'config', 'criteria.json'), 'utf8'
    ));
    const keywords = criteria.titles.must_match_any.slice(0, 4).join(' OR ');
    const location = criteria.location.home.label;
    res.json([
      {
        name: 'LinkedIn', mode: 'search_and_import',
        url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}`
      },
      {
        name: 'Indeed', mode: 'search_and_import',
        url: `https://www.indeed.com/jobs?q=${encodeURIComponent(keywords)}&l=${encodeURIComponent(location)}`
      },
      {
        name: 'Dice', mode: 'search_and_import',
        url: `https://www.dice.com/jobs?q=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}`
      }
    ]);
  });

  app.post('/api/jobs/import', (req, res) => {
    const raw = req.body || {};
    const source = String(raw.source || 'manual').toLowerCase();
    if (!/^[a-z0-9:_-]{1,40}$/.test(source)) {
      return res.status(400).json({ error: 'invalid source' });
    }
    const job = normalize({
      source,
      sourceId: raw.sourceId || raw.source_id || raw.url,
      title: raw.title,
      company: raw.company,
      location: raw.location,
      remote: raw.remote ?? raw.is_remote,
      salaryMin: Number(raw.salaryMin ?? raw.salary_min),
      salaryMax: Number(raw.salaryMax ?? raw.salary_max),
      currency: raw.currency,
      url: raw.url,
      description: raw.description,
      postedAt: raw.postedAt || raw.posted_at
    });
    if (!job) return res.status(400).json({ error: 'title is required' });

    try {
      const result = db.upsertJob(job);
      if (!result.inserted) {
        const existing = db.connect().prepare(
          'SELECT id, status, match_score, match_reasons FROM jobs WHERE id = ?'
        ).get(result.id);
        return res.json({ inserted: false, job: existing });
      }
      const verdict = evaluate(job, JSON.parse(fs.readFileSync(
        path.join(__dirname, '..', 'config', 'criteria.json'), 'utf8'
      )), loadProfile());
      db.setMatchResult(result.id, verdict.score, verdict.reasons);
      const status = verdict.matched ? 'matched' : 'skipped';
      db.transition(result.id, status, verdict.reasons.join(','));
      res.status(201).json({
        inserted: true,
        job: { id: result.id, status, match_score: verdict.score, match_reasons: verdict.reasons }
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const conn = db.connect();
    const job = conn.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
    if (!job) return res.status(404).json({ error: 'not found' });
    const history = conn.prepare(
      'SELECT from_status, to_status, note, changed_at FROM status_history WHERE job_id = ? ORDER BY id'
    ).all(req.params.id);
    res.json({ ...job, history });
  });

  // Generic transition for everything EXCEPT entering 'applied', which
  // must go through /apply so the governor and the applications table
  // stay consistent.
  app.post('/api/jobs/:id/transition', (req, res) => {
    const { to, note } = req.body || {};
    if (!to || !VALID_STATUSES.includes(to)) {
      return res.status(400).json({ error: `invalid target status: ${to}` });
    }
    if (to === 'applied') {
      return res.status(400).json({ error: 'use POST /api/jobs/:id/apply' });
    }
    try {
      const result = db.transition(req.params.id, to, note || 'via api');
      res.json(result);
    } catch (err) {
      const code = /illegal transition/.test(err.message) ? 409 : 500;
      res.status(code).json({ error: err.message });
    }
  });

  app.post('/api/jobs/:id/apply', (req, res) => {
    const { resume_variant, notes } = req.body || {};
    try {
      const result = db.applyJob(
        req.params.id,
        getWeeklyCap(),
        resume_variant || null,
        notes || null
      );
      if (!result.applied) {
        return res.status(429).json({
          error: 'governor_blocked', governor: result.governor
        });
      }
      res.json(result);
    } catch (err) {
      const code = /not found/.test(err.message)
        ? 404
        : /illegal transition/.test(err.message) ? 409 : 500;
      res.status(code).json({ error: err.message });
    }
  });

  return app;
}

module.exports = { buildApp };

if (require.main === module) {
  buildApp().listen(PORT, () => {
    console.log(`[api] listening on http://localhost:${PORT}`);
  });
}
