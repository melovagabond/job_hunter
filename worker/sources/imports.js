// Batch inbox for jobs saved or exported from sites without an approved
// search API (including LinkedIn, Indeed, and Dice). Files stay local.

const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/normalize');

function loadFile(file) {
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(parsed) ? parsed : parsed.jobs || [];
}

async function fetchImports(cfg) {
  const jobs = [];
  for (const configuredPath of cfg.files || []) {
    const file = path.resolve(process.cwd(), configuredPath);
    for (const j of loadFile(file)) {
      jobs.push(normalize({
        source: String(j.source || 'manual').toLowerCase(),
        sourceId: j.sourceId || j.source_id || j.id || j.url,
        title: j.title,
        company: j.company,
        location: j.location,
        remote: j.remote ?? j.is_remote,
        salaryMin: Number(j.salaryMin ?? j.salary_min),
        salaryMax: Number(j.salaryMax ?? j.salary_max),
        currency: j.currency,
        url: j.url,
        description: j.description,
        postedAt: j.postedAt || j.posted_at
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchImports };
