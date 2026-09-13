// Greenhouse hosted board API, per company board token. This is also the
// source that matters most later: Greenhouse boards accept programmatic
// applications, so anything found here is a candidate for true API apply
// in the next phase. Populate config/sources.json boards[] with tokens,
// e.g. "datadog" from boards.greenhouse.io/datadog. No key required.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');

async function fetchGreenhouse(cfg) {
  const jobs = [];
  for (const board of cfg.boards) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`;
    const res = await fetchWithPolicy(url);
    if (!res.ok) {
      console.warn(`[greenhouse:${board}] HTTP ${res.status}, skipping board`);
      continue;
    }
    const data = await res.json();
    for (const j of data.jobs || []) {
      jobs.push(normalize({
        source: `greenhouse:${board}`,
        sourceId: j.id,
        title: j.title,
        company: board,
        location: j.location && j.location.name,
        url: j.absolute_url,
        description: j.content,
        postedAt: j.updated_at
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchGreenhouse };
