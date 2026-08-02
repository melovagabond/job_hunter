// Remotive public API. Everything here is remote by definition. No key.

const { normalize } = require('../lib/normalize');

function parseSalaryText(s) {
  // Remotive salary is free text like "$140,000 - $180,000". Best effort.
  if (!s) return {};
  const nums = (s.match(/\d[\d,]{4,}/g) || [])
    .map(n => parseInt(n.replace(/,/g, ''), 10))
    .filter(n => n >= 20000 && n <= 2000000);
  if (nums.length === 0) return {};
  return { salaryMin: Math.min(...nums), salaryMax: Math.max(...nums) };
}

async function fetchRemotive(cfg) {
  const url = `https://remotive.com/api/remote-jobs?search=${encodeURIComponent(cfg.search)}`;
  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[remotive] HTTP ${res.status}, skipping`);
    return [];
  }
  const data = await res.json();
  return (data.jobs || []).map(j => normalize({
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
