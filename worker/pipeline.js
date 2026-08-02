// Orchestrator: fetch -> normalize (done in adapters) -> dedupe ->
// match -> persist with state. One source blowing up does not take
// down the run; it logs and moves on.

const fs = require('fs');
const path = require('path');
const db = require('./db/db');
const { evaluate } = require('./lib/match');

const SOURCES = {
  adzuna: require('./sources/adzuna'),
  usajobs: require('./sources/usajobs'),
  remotive: require('./sources/remotive'),
  remoteok: require('./sources/remoteok'),
  greenhouse: require('./sources/greenhouse'),
  lever: require('./sources/lever')
};

function loadConfig(name) {
  const p = path.join(__dirname, '..', 'config', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function runPipeline() {
  const criteria = loadConfig('criteria.json');
  const sourcesCfg = loadConfig('sources.json');

  const stats = {
    fetched: 0, new: 0, duplicates: 0, matched: 0, skipped: 0, errors: []
  };

  for (const [name, mod] of Object.entries(SOURCES)) {
    const cfg = sourcesCfg[name];
    if (!cfg || !cfg.enabled) continue;

    let jobs = [];
    try {
      jobs = await mod.fetch(cfg, criteria);
      console.log(`[${name}] fetched ${jobs.length}`);
    } catch (err) {
      console.error(`[${name}] failed: ${err.message}`);
      stats.errors.push({ source: name, error: err.message });
      continue;
    }
    stats.fetched += jobs.length;

    for (const job of jobs) {
      const { inserted, id } = db.upsertJob(job);
      if (!inserted) { stats.duplicates++; continue; }
      stats.new++;

      const verdict = evaluate(job, criteria);
      db.setMatchResult(id, verdict.score, verdict.reasons);
      if (verdict.matched) {
        db.transition(id, 'matched', verdict.reasons.join(','));
        stats.matched++;
      } else {
        db.transition(id, 'skipped', verdict.reasons.join(','));
        stats.skipped++;
      }
    }
  }

  console.log('[pipeline] run complete:', JSON.stringify(stats));
  console.log('[pipeline] db totals:', JSON.stringify(db.countByStatus()));
  return stats;
}

module.exports = { runPipeline };

if (require.main === module) {
  runPipeline().catch(err => { console.error(err); process.exit(1); });
}
