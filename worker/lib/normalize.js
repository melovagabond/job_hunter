// Every source adapter must return jobs in this shape. The pipeline
// refuses anything else, which keeps source quirks out of the core.

const crypto = require('crypto');

const REMOTE_HINTS = ['remote', 'work from home', 'wfh', 'anywhere', 'telework', 'virtual'];

function cleanText(s) {
  return (s || '').toString().replace(/\s+/g, ' ').trim();
}

// Company + title + location. Source IDs are tracked separately, while the
// location keeps distinct requisitions from being collapsed into one role.
function dedupeKey(company, title, location) {
  const norm = (s) => cleanText(s).toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(inc|llc|ltd|corp|corporation|co)\b/g, '')
    .trim();
  return crypto.createHash('sha1')
    .update(`${norm(company)}|${norm(title)}|${norm(location)}`)
    .digest('hex');
}

function looksRemote(locationText, explicitFlag) {
  if (explicitFlag === true) return true;
  const loc = cleanText(locationText).toLowerCase();
  return REMOTE_HINTS.some(h => loc.includes(h));
}

// raw fields a source adapter supplies; everything else is derived here.
function normalize({
  source, sourceId, title, company, location, remote,
  salaryMin, salaryMax, currency, url, description, postedAt, expiresAt,
  employmentType, workplaceType, seniority, lat, lon
}) {
  const t = cleanText(title);
  if (!t) return null;

  return {
    source,
    source_id: sourceId != null ? String(sourceId) : null,
    title: t,
    company: cleanText(company) || null,
    location: cleanText(location) || null,
    is_remote: looksRemote(location, remote),
    salary_min: Number.isFinite(salaryMin) ? Math.round(salaryMin) : null,
    salary_max: Number.isFinite(salaryMax) ? Math.round(salaryMax) : null,
    currency: currency || 'USD',
    url: cleanText(url) || null,
    description: (description || '').toString().slice(0, 20000) || null,
    posted_at: postedAt || null,
    expires_at: expiresAt || null,
    employment_type: cleanText(employmentType) || null,
    workplace_type: cleanText(workplaceType) || null,
    seniority: cleanText(seniority) || null,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    dedupe_key: dedupeKey(company, t, location)
  };
}

module.exports = { normalize, dedupeKey, looksRemote, cleanText };
