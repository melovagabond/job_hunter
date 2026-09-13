// Himalayas documents a free public JSON search API with no authentication.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { searchTerms } = require('../lib/profile');
const { annualizeSalary } = require('../lib/salary');

async function fetchHimalayas(cfg, criteria, profile) {
  const terms = searchTerms(profile, criteria, cfg.max_queries || 10);
  const seen = new Map();
  for (const term of terms) {
    for (let page = 1; page <= (cfg.max_pages_per_query || 1); page++) {
      const params = new URLSearchParams({ q: term, sort: cfg.sort || 'recent', page: String(page) });
      if (cfg.country) params.set('country', cfg.country);
      const res = await fetchWithPolicy(`https://himalayas.app/jobs/api/search?${params}`);
      if (!res.ok) {
        console.warn(`[himalayas:${term}] HTTP ${res.status}, skipping`);
        break;
      }
      const data = await res.json();
      for (const job of data.jobs || []) seen.set(String(job.guid || job.applicationLink), job);
    }
  }
  return [...seen.values()].map(job => normalize({
    source: 'himalayas',
    sourceId: job.guid || job.applicationLink,
    title: job.title,
    company: job.companyName,
    location: `Remote${job.locationRestrictions?.length ? ` - ${job.locationRestrictions.join(', ')}` : ''}`,
    remote: true,
    salaryMin: annualizeSalary(job.minSalary, job.salaryPeriod),
    salaryMax: annualizeSalary(job.maxSalary, job.salaryPeriod),
    currency: job.currency,
    url: job.applicationLink,
    description: job.description || job.excerpt,
    postedAt: job.pubDate,
    expiresAt: job.expiryDate,
    employmentType: job.employmentType,
    workplaceType: 'remote',
    seniority: Array.isArray(job.seniority) ? job.seniority.join(', ') : job.seniority
  })).filter(Boolean);
}

module.exports = { fetch: fetchHimalayas };
