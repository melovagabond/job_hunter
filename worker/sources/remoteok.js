// RemoteOK public API. First array element is a legal notice, not a job.
// Their ToS requires linking back to the original posting, which we do
// by storing their URL as the apply link. No key required.

const { normalize } = require('../lib/normalize');

async function fetchRemoteOk(cfg) {
  const res = await fetch('https://remoteok.com/api', {
    headers: { 'User-Agent': 'job_hunter self-hosted (personal use)' }
  });
  if (!res.ok) {
    console.warn(`[remoteok] HTTP ${res.status}, skipping`);
    return [];
  }
  const data = await res.json();
  const rows = Array.isArray(data) ? data.filter(r => r && r.id) : [];
  const wanted = cfg.tags.map(t => t.toLowerCase());

  return rows
    .filter(r => (r.tags || []).some(t => wanted.includes(String(t).toLowerCase())))
    .map(r => normalize({
      source: 'remoteok',
      sourceId: r.id,
      title: r.position || r.title,
      company: r.company,
      location: r.location || 'Remote',
      remote: true,
      salaryMin: r.salary_min,
      salaryMax: r.salary_max,
      url: r.url,
      description: r.description,
      postedAt: r.date
    }))
    .filter(Boolean);
}

module.exports = { fetch: fetchRemoteOk };
