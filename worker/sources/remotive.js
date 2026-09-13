// Remotive public API. Everything here is remote by definition. No key.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { searchTerms } = require('../lib/profile');

function parseSalaryText(s) {
  // Remotive salary is free text like "$140,000 - $180,000". Best effort.
  if (!s) return {};
  const nums = (s.match(/\d[\d,]{4,}/g) || [])
    .map(n => parseInt(n.replace(/,/g, ''), 10))
    .filter(n => n >= 20000 && n <= 2000000);
  if (nums.length === 0) return {};
  return { salaryMin: Math.min(...nums), salaryMax: Math.max(...nums) };
}

async function fetchRemotive(cfg, criteria, profile) {
  const searches = cfg.resume_queries
    ? searchTerms(profile, criteria, cfg.max_queries || 6)
    : cfg.searches || [cfg.search];
  const jobs = new Map();
  for (const search of searches.filter(Boolean)) {
    const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(search)}`;
    const res = await fetchWithPolicy(url);
    if (!res.ok) {
      console.warn(`[remotive:${search}] HTTP ${res.status}, skipping`);
      continue;
    }
    const data = await res.json();
    for (const j of data.jobs || []) jobs.set(String(j.id), j);
  }
  return [...jobs.values()].map(j => normalize({
      source: 'remotive',
      sourceId: j.id,
      title: j.title,
      company: j.company_name,
      location: j.candidate_required_location || 'Remote',
      remote: true,
      ...parseSalaryText(j.salary),
      url: j.url,
      description: j.description,
      postedAt: j.publication_date
    })).filter(Boolean);
}

module.exports = { fetch: fetchRemotive };
