// Jobicy's public API explicitly supports internal apps and prototypes.
// It needs no key and allows up to 200 remote jobs per request.

const { normalize } = require('../lib/normalize');

function annualSalary(value, period) {
  if (value == null || value === '') return undefined;
  const amount = Number(value);
  if (!Number.isFinite(amount)) return undefined;
  const multipliers = { hourly: 2080, daily: 260, weekly: 52, monthly: 12, yearly: 1 };
  return amount * (multipliers[String(period || 'yearly').toLowerCase()] || 1);
}

async function fetchJobicy(cfg) {
  const tags = cfg.tags && cfg.tags.length ? cfg.tags : [null];
  const seen = new Set();
  const jobs = [];

  for (const tag of tags) {
    const params = new URLSearchParams({
      count: String(Math.min(cfg.count || 100, 200)),
      geo: cfg.geo || 'usa'
    });
    if (cfg.industry) params.set('industry', cfg.industry);
    if (tag) params.set('tag', tag);
    const res = await fetch(`https://jobicy.com/api/v2/remote-jobs?${params}`);
    if (!res.ok) {
      console.warn(`[jobicy:${tag || 'all'}] HTTP ${res.status}, skipping`);
      continue;
    }
    const data = await res.json();
    for (const j of data.jobs || []) {
      if (seen.has(String(j.id))) continue;
      seen.add(String(j.id));
      jobs.push(normalize({
        source: 'jobicy',
        sourceId: j.id,
        title: j.jobTitle,
        company: j.companyName,
        location: j.jobGeo || 'Remote',
        remote: true,
        salaryMin: annualSalary(j.salaryMin, j.salaryPeriod),
        salaryMax: annualSalary(j.salaryMax, j.salaryPeriod),
        currency: j.salaryCurrency,
        url: j.url,
        description: j.jobDescription || j.jobExcerpt,
        postedAt: j.pubDate
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchJobicy, annualSalary };
