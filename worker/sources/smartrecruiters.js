// Official public SmartRecruiters Posting API.
const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');

function sectionText(detail) {
  const sections = detail.jobAd?.sections || {};
  return Object.values(sections).map(section => section?.text || '').join('\n');
}

async function fetchSmartRecruiters(cfg) {
  const jobs = [];
  for (const company of cfg.companies || []) {
    let offset = 0;
    const limit = Math.min(cfg.results_per_page || 100, 100);
    for (let page = 0; page < (cfg.max_pages || 3); page++) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (cfg.query) params.set('q', cfg.query);
      if (cfg.country) params.set('country', cfg.country);
      const res = await fetchWithPolicy(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings?${params}`
      );
      if (!res.ok) {
        console.warn(`[smartrecruiters:${company}] HTTP ${res.status}, skipping`);
        break;
      }
      const data = await res.json();
      const rows = data.content || [];
      for (const summary of rows) {
        let detail = summary;
        if (summary.ref) {
          const detailRes = await fetchWithPolicy(summary.ref);
          if (detailRes.ok) detail = await detailRes.json();
        }
        const loc = detail.location || summary.location || {};
        jobs.push(normalize({
          source: `smartrecruiters:${company}`,
          sourceId: detail.id || summary.id || detail.uuid,
          title: detail.name || summary.name,
          company: detail.company?.name || company,
          location: [loc.city, loc.region, loc.country].filter(Boolean).join(', '),
          remote: /remote/i.test(`${loc.city || ''} ${detail.typeOfEmployment?.label || ''}`),
          url: detail.ref || summary.ref || `https://jobs.smartrecruiters.com/${company}/${detail.id || summary.id}`,
          description: sectionText(detail),
          postedAt: detail.releasedDate || summary.releasedDate,
          employmentType: detail.typeOfEmployment?.label,
          seniority: detail.experienceLevel?.label
        }));
      }
      offset += rows.length;
      if (!rows.length || offset >= (data.totalFound || 0)) break;
    }
  }
  return jobs.filter(Boolean);
}

module.exports = { fetch: fetchSmartRecruiters };
