// Official public Ashby job-board API.
const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { parseAnnualSalary } = require('../lib/salary');

async function fetchAshby(cfg) {
  const jobs = [];
  for (const board of cfg.boards || []) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`;
    const res = await fetchWithPolicy(url);
    if (!res.ok) {
      console.warn(`[ashby:${board}] HTTP ${res.status}, skipping board`);
      continue;
    }
    const data = await res.json();
    for (const j of data.jobs || []) {
      if (j.isListed === false) continue;
      const compensation = j.compensation || {};
      jobs.push(normalize({
        source: `ashby:${board}`,
        sourceId: j.id || j.jobUrl,
        title: j.title,
        company: board,
        location: j.location,
        remote: /remote|anywhere/i.test(j.workplaceType || j.location || ''),
        ...parseAnnualSalary(
          compensation.scrapeableCompensationSalarySummary ||
          compensation.compensationTierSummary
        ),
        url: j.jobUrl || j.applyUrl,
        description: j.descriptionHtml || j.descriptionPlain,
        postedAt: j.publishedAt,
        employmentType: j.employmentType,
        workplaceType: j.workplaceType,
        seniority: j.jobLevel
      }));
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchAshby };
