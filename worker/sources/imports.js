// Batch inbox for jobs saved or exported from sites without an approved
// search API (including LinkedIn, Indeed, and Dice). Files stay local.

const fs = require('fs');
const path = require('path');
const { normalize } = require('../lib/normalize');

function loadFile(file) {
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.jsonl')) {
    return raw.split(/\r?\n/).filter(line => line.trim()).map(line => JSON.parse(line));
  }
  const parsed = JSON.parse(raw);
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
        postedAt: j.postedAt || j.posted_at,
        expiresAt: j.expiresAt || j.expires_at,
        employmentType: j.employmentType || j.employment_type,
        workplaceType: j.workplaceType || j.workplace_type,
        seniority: j.seniority
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchImports };
