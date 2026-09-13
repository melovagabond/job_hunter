// Job Opportunities API has a documented keyless surface capped at 50 rows/query.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { searchTerms } = require('../lib/profile');
const { annualizeSalary } = require('../lib/salary');

async function fetchJobOpportunities(cfg, criteria, profile) {
  const terms = searchTerms(profile, criteria, cfg.max_queries || 10);
  const jobs = new Map();
  for (const term of terms) {
    const params = new URLSearchParams({
      q: term,
      limit: String(Math.min(cfg.results_per_query || 50, 50))
    });
    if (cfg.country) params.set('country', cfg.country);
    if (cfg.remote) params.set('remote', cfg.remote);
    if (cfg.include_description) params.set('include_description', 'true');
    const res = await fetchWithPolicy(`https://api.jobopportunitiesapi.org/public/jobs?${params}`);
    if (!res.ok) {
      console.warn(`[job_opportunities:${term}] HTTP ${res.status}, skipping`);
      continue;
    }
    const data = await res.json();
    for (const job of data.data || []) jobs.set(String(job.id), job);
  }
  return [...jobs.values()].map(job => normalize({
    source: 'job_opportunities',
    sourceId: job.id,
    title: job.title,
    company: job.company,
    location: job.location || [job.city, job.country].filter(Boolean).join(', '),
    remote: job.remote === 'remote',
    salaryMin: annualizeSalary(job.salary_min, job.salary_period),
    salaryMax: annualizeSalary(job.salary_max, job.salary_period),
    currency: job.salary_currency,
    url: job.apply_url,
    description: job.description,
    postedAt: job.posted_at || job.first_seen_at,
    employmentType: job.employment_type,
    workplaceType: job.remote,
    seniority: job.seniority
  })).filter(Boolean);
}

module.exports = { fetch: fetchJobOpportunities };
