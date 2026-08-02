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

const PORT = process.env.API_PORT || 3001;
const VALID_STATUSES = Object.keys(db.TRANSITIONS);

function weeklyCap() {
  const p = path.join(__dirname, '..', 'config', 'criteria.json');
  return JSON.parse(fs.readFileSync(p, 'utf8')).weekly_apply_cap;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/api/health', (req, res) => res.json({ ok: true }));

  app.get('/api/stats', (req, res) => {
    res.json({
      by_status: db.countByStatus(),
      governor: governor.status(weeklyCap()),
      week: db.isoWeekKey()
    });
  });

  app.get('/api/jobs', (req, res) => {
    const status = req.query.status || 'matched';
    if (!VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: `unknown status: ${status}` });
    }
    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    res.json(db.getByStatus(status, limit));
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
    const gov = governor.status(weeklyCap());
    if (!gov.allowed) {
      return res.status(429).json({ error: 'governor_blocked', governor: gov });
    }
    const { resume_variant, notes } = req.body || {};
    try {
      const result = db.transition(req.params.id, 'applied', notes || 'applied via api');
      db.recordApplication(req.params.id, resume_variant || null, notes || null);
      res.json({ ...result, governor: governor.status(weeklyCap()) });
    } catch (err) {
      const code = /illegal transition/.test(err.message) ? 409 : 500;
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
