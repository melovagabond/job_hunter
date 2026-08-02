// Lever postings API, per company slug. Like Greenhouse, Lever postings
// have a programmatic apply endpoint, making these prime targets for the
// auto-apply phase. Populate config/sources.json companies[] with slugs,
// e.g. "netflix" from jobs.lever.co/netflix. No key required.

const { normalize } = require('../lib/normalize');

async function fetchLever(cfg) {
  const jobs = [];
  for (const company of cfg.companies) {
    const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[lever:${company}] HTTP ${res.status}, skipping company`);
      continue;
    }
    const data = await res.json();
    for (const j of Array.isArray(data) ? data : []) {
      jobs.push(normalize({
        source: `lever:${company}`,
        sourceId: j.id,
        title: j.text,
        company,
        location: j.categories && j.categories.location,
        remote: (j.workplaceType || '').toLowerCase() === 'remote',
        url: j.hostedUrl,
        description: j.descriptionPlain,
        postedAt: j.createdAt ? new Date(j.createdAt).toISOString() : null
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchLever };
