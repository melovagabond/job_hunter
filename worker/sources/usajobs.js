// USAJobs search API. Real salary data, honest location fields, and a
// Radius param in actual miles. Env: USAJOBS_API_KEY, USAJOBS_EMAIL
// Docs: developer.usajobs.gov

const { normalize } = require('../lib/normalize');
const { isConfigured } = require('../lib/env');

function parseRemuneration(item) {
  const rem = item.PositionRemuneration && item.PositionRemuneration[0];
  if (!rem) return {};
  // Only trust per-annum figures; hourly rates would nuke the salary floor.
  if ((rem.RateIntervalCode || '').toLowerCase().startsWith('per')
      && !(rem.RateIntervalCode || '').toLowerCase().includes('hour')) {
    return {
      salaryMin: parseFloat(rem.MinimumRange),
      salaryMax: parseFloat(rem.MaximumRange)
    };
  }
  return {};
}

async function fetchUsaJobs(cfg) {
  const key = process.env.USAJOBS_API_KEY;
  const email = process.env.USAJOBS_EMAIL;
  if (!isConfigured(key) || !isConfigured(email)) {
    console.warn('[usajobs] credentials missing or still placeholders, skipping');
    return [];
  }

  const headers = {
    Host: 'data.usajobs.gov',
    'User-Agent': email,
    'Authorization-Key': key
  };

  const jobs = [];
  for (let page = 1; page <= cfg.max_pages; page++) {
    const params = new URLSearchParams({
      Keyword: cfg.keyword,
      LocationName: cfg.location_name,
      Radius: String(cfg.radius_miles),
      ResultsPerPage: '100',
      Page: String(page)
    });
    const res = await fetch(`https://data.usajobs.gov/api/search?${params}`, { headers });
    if (!res.ok) {
      console.warn(`[usajobs] page ${page} HTTP ${res.status}, stopping`);
      break;
    }
    const data = await res.json();
    const items = data.SearchResult?.SearchResultItems || [];
    if (items.length === 0) break;

    for (const wrap of items) {
      const d = wrap.MatchedObjectDescriptor;
      if (!d) continue;
      const loc = (d.PositionLocation && d.PositionLocation[0]) || {};
      jobs.push(normalize({
        source: 'usajobs',
        sourceId: d.PositionID,
        title: d.PositionTitle,
        company: d.OrganizationName,
        location: d.PositionLocationDisplay,
        remote: /remote|telework/i.test(d.PositionLocationDisplay || ''),
        ...parseRemuneration(d),
        url: d.PositionURI,
        description: d.UserArea?.Details?.JobSummary,
        postedAt: d.PublicationStartDate,
        lat: parseFloat(loc.Latitude),
        lon: parseFloat(loc.Longitude)
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchUsaJobs };
