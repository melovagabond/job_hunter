require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db/db');
const { evaluate } = require('./lib/match');
const { loadProfile } = require('./lib/profile');

const criteria = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'criteria.json'), 'utf8'
));
const profile = loadProfile();
const conn = db.connect();
const jobs = conn.prepare(`
  SELECT j.*, EXISTS(SELECT 1 FROM job_feedback f WHERE f.job_id = j.id) AS has_feedback
  FROM jobs j
`).all();
const stats = { indexed: 0, promoted: 0, demoted: 0 };

for (const job of jobs) {
  const verdict = evaluate(job, criteria, profile);
  db.setMatchResult(
    job.id, verdict.score, verdict.reasons,
    verdict.breakdown, verdict.missingSkills
  );
  if (!job.has_feedback && job.status === 'skipped' && verdict.matched) {
    db.transition(job.id, 'matched', 'resume reindex');
    stats.promoted++;
  } else if (!job.has_feedback && job.status === 'matched' && !verdict.matched) {
    db.transition(job.id, 'skipped', 'resume reindex');
    stats.demoted++;
  }
  stats.indexed++;
}
db.rebuildSearchIndex();
console.log('[reindex] complete:', JSON.stringify(stats));
db.close();
