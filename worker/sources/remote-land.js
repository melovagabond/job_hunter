// Remote Land exposes a public, read-only feed of ATS-direct remote jobs.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { parseCompensation } = require('../lib/salary');
const { isUsEligibleRemote } = require('../lib/regions');

async function fetchRemoteLand(cfg) {
  const rows = [];
  for (let page = 1; page <= (cfg.max_pages || 3); page++) {
    const params = new URLSearchParams({
      category: cfg.category || 'Engineering',
      limit: String(Math.min(cfg.results_per_page || 100, 100)),
      page: String(page)
    });
    const res = await fetchWithPolicy(`https://remotelanders.com/api/jobs?${params}`);
    if (!res.ok) {
      console.warn(`[remote_landers:${page}] HTTP ${res.status}, stopping`);
      break;
    }
    const data = await res.json();
    rows.push(...(data.jobs || []));
    if (!data.jobs?.length || rows.length >= Number(data.total || Infinity)) break;
  }
  return rows
    .filter(job => !cfg.us_eligible_only || isUsEligibleRemote(job.location))
    .map(job => normalize({
      source: 'remote_landers',
      sourceId: job.slug,
      title: job.title,
      company: job.company,
      location: `Remote - ${job.location || 'Worldwide'}`,
      remote: true,
      ...parseCompensation(job.salary),
      url: job.url,
      description: (job.subtags || []).join(' '),
      postedAt: job.postedDate,
      employmentType: job.type,
      workplaceType: 'remote',
      seniority: job.level
    })).filter(Boolean);
}

module.exports = { fetch: fetchRemoteLand };
