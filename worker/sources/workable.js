// Official public Workable careers-page endpoint for published jobs.
const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');

async function fetchWorkable(cfg) {
  const jobs = [];
  for (const account of cfg.accounts || []) {
    const res = await fetchWithPolicy(
      `https://www.workable.com/api/accounts/${encodeURIComponent(account)}?details=true`
    );
    if (!res.ok) {
      console.warn(`[workable:${account}] HTTP ${res.status}, skipping account`);
      continue;
    }
    const data = await res.json();
    for (const j of data.jobs || []) {
      const loc = j.location || {};
      const location = typeof loc === 'string'
        ? loc
        : [loc.city, loc.region, loc.country_name || loc.country].filter(Boolean).join(', ');
      jobs.push(normalize({
        source: `workable:${account}`,
        sourceId: j.shortcode || j.id,
        title: j.title,
        company: data.name || account,
        location,
        remote: j.workplace_type === 'remote' || /remote/i.test(location),
        salaryMin: Number(j.salary?.salary_from),
        salaryMax: Number(j.salary?.salary_to),
        currency: j.salary?.salary_currency,
        url: j.url || j.application_url,
        description: j.description || j.full_description,
        postedAt: j.published_on || j.created_at,
        employmentType: j.employment_type,
        workplaceType: j.workplace_type
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchWorkable };
