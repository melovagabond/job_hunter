// Worker entrypoint. Three runs a day is plenty; job boards do not
// change minute to minute and every fetch costs API quota.
require('dotenv').config();
const { CronJob } = require('cron');
const { runPipeline } = require('./pipeline');

const SCHEDULE = process.env.FETCH_CRON || '0 7,13,19 * * *';

console.log(`[worker] starting, schedule: ${SCHEDULE}`);
new CronJob(SCHEDULE, () => {
  runPipeline().catch(err => console.error('[worker] run failed:', err));
}, null, true, 'America/New_York');

// Run once at boot so a fresh deploy is not empty until the next tick.
runPipeline().catch(err => console.error('[worker] initial run failed:', err));
