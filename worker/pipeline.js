// Orchestrator: fetch -> normalize (done in adapters) -> dedupe ->
// match -> persist with state. One source blowing up does not take
// down the run; it logs and moves on.

const fs = require('fs');
const path = require('path');
const db = require('./db/db');
const { evaluate } = require('./lib/match');
const { loadProfile } = require('./lib/profile');

const SOURCES = {
  adzuna: require('./sources/adzuna'),
  usajobs: require('./sources/usajobs'),
  remotive: require('./sources/remotive'),
  remoteok: require('./sources/remoteok'),
  greenhouse: require('./sources/greenhouse'),
  lever: require('./sources/lever'),
  jobicy: require('./sources/jobicy'),
  ashby: require('./sources/ashby'),
  smartrecruiters: require('./sources/smartrecruiters'),
  workable: require('./sources/workable'),
  himalayas: require('./sources/himalayas'),
  remote_landers: require('./sources/remote-land'),
  we_work_remotely: require('./sources/we-work-remotely'),
  startup_jobs: require('./sources/startup-jobs'),
  job_opportunities: require('./sources/job-opportunities'),
  imports: require('./sources/imports')
};

function loadConfig(name) {
  const p = path.join(__dirname, '..', 'config', name);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function runPipeline() {
  const criteria = loadConfig('criteria.json');
  const sourcesCfg = loadConfig('sources.json');
  const profile = loadProfile();

  const stats = {
    fetched: 0, new: 0, updated: 0, duplicates: 0,
    matched: 0, skipped: 0, stale: 0, errors: []
  };

  const enabled = Object.entries(SOURCES).filter(([name]) => {
    const cfg = sourcesCfg[name];
    return cfg && cfg.enabled;
  });

  async function fetchOne([name, mod]) {
    const cfg = sourcesCfg[name];
    const runId = db.startSourceRun(name);
    const started = Date.now();

    try {
      const jobs = await mod.fetch(cfg, criteria, profile);
      console.log(`[${name}] fetched ${jobs.length}`);
      return { name, jobs, runId, started, fetchDuration: Date.now() - started };
    } catch (err) {
      console.error(`[${name}] failed: ${err.message}`);
      db.finishSourceRun(runId, {
        status: 'error', error: err.message, duration_ms: Date.now() - started
      });
      return { name, jobs: [], runId, started, error: err.message };
    }
  }

  async function mapLimit(items, limit, mapper) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const index = next++;
        results[index] = await mapper(items[index]);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  const fetchedSources = await mapLimit(
    enabled, Math.max(1, sourcesCfg.concurrency || 3), fetchOne
  );

  for (const sourceResult of fetchedSources) {
    const { name, jobs, runId, fetchDuration, error } = sourceResult;
    if (error) {
      stats.errors.push({ source: name, error });
      continue;
    }
    const sourceStats = { fetched: jobs.length, inserted: 0, updated: 0, matched: 0, skipped: 0 };
    stats.fetched += jobs.length;

    db.withTransaction(() => {
      for (const job of jobs) {
        const { inserted, updated, id } = db.upsertJob(job);
        if (!inserted) {
          stats.duplicates++;
          if (updated) { stats.updated++; sourceStats.updated++; }
        } else {
          stats.new++;
          sourceStats.inserted++;
        }

        const verdict = evaluate(job, criteria, profile);
        db.setMatchResult(
          id, verdict.score, verdict.reasons,
          verdict.breakdown, verdict.missingSkills
        );
        if (inserted) {
          if (verdict.matched) {
            db.transition(id, 'matched', verdict.reasons.join(','));
            stats.matched++; sourceStats.matched++;
          } else {
            db.transition(id, 'skipped', verdict.reasons.join(','));
            stats.skipped++; sourceStats.skipped++;
          }
        }
      }
    });
    db.finishSourceRun(runId, {
      status: 'ok', ...sourceStats, duration_ms: fetchDuration
    });
  }

  stats.stale = db.markStaleJobs(sourcesCfg.stale_after_days || 14);

  const digestPath = path.join(__dirname, '..', 'data', 'digest.json');
  fs.writeFileSync(digestPath, JSON.stringify({
    generated_at: new Date().toISOString(),
    jobs: db.digest(72, 20)
  }, null, 2) + '\n');

  console.log('[pipeline] run complete:', JSON.stringify(stats));
  console.log('[pipeline] db totals:', JSON.stringify(db.countByStatus()));
  return stats;
}

module.exports = { runPipeline };

if (require.main === module) {
  runPipeline().catch(err => { console.error(err); process.exit(1); });
}
