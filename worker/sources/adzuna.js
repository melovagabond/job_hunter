// Adzuna search API. Does salary and geo filtering server side, which
// is exactly why it is our primary source. Docs: developer.adzuna.com
// Env: ADZUNA_APP_ID, ADZUNA_APP_KEY
// Note: Adzuna's distance param is kilometers, not miles.

const { normalize } = require('../lib/normalize');
const { isConfigured } = require('../lib/env');

async function fetchAdzuna(cfg, criteria) {
  const id = process.env.ADZUNA_APP_ID;
  const key = process.env.ADZUNA_APP_KEY;
  if (!isConfigured(id) || !isConfigured(key)) {
    console.warn('[adzuna] credentials missing or still placeholders, skipping');
    return [];
  }

  const jobs = [];
  for (let page = 1; page <= cfg.max_pages; page++) {
    const params = new URLSearchParams({
      app_id: id,
      app_key: key,
      what: cfg.what,
      where: cfg.where,
      distance: String(cfg.distance_km),
      results_per_page: String(cfg.results_per_page),
      salary_min: String(criteria.salary.floor_usd),
      content_type: 'application/json'
    });
    const url = `https://api.adzuna.com/v1/api/jobs/${cfg.country}/search/${page}?${params}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[adzuna] page ${page} HTTP ${res.status}, stopping`);
      break;
    }
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) break;

    for (const r of results) {
      jobs.push(normalize({
        source: 'adzuna',
        sourceId: r.id,
        title: r.title,
        company: r.company && r.company.display_name,
        location: r.location && r.location.display_name,
        salaryMin: r.salary_min,
        salaryMax: r.salary_max,
        url: r.redirect_url,
        description: r.description,
        postedAt: r.created,
        lat: r.latitude,
        lon: r.longitude
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchAdzuna };
