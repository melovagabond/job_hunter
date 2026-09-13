// We Work Remotely explicitly publishes this RSS feed for reuse with attribution.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { parseRss } = require('../lib/rss');
const { parseCompensation } = require('../lib/salary');
const { isUsEligibleRemote } = require('../lib/regions');

async function fetchWeWorkRemotely(cfg) {
  const res = await fetchWithPolicy(cfg.feed);
  if (!res.ok) return [];
  const rows = parseRss(await res.text());
  return rows
    .filter(row => !cfg.us_eligible_only || isUsEligibleRemote(`${row.region} ${row.country} ${row.state}`))
    .map(row => {
      const separator = row.title.indexOf(':');
      const company = separator > 0 ? row.title.slice(0, separator).trim() : null;
      const title = separator > 0 ? row.title.slice(separator + 1).trim() : row.title;
      return normalize({
        source: 'we_work_remotely',
        sourceId: row.guid || row.link,
        title,
        company,
        location: `Remote - ${row.region || row.country || row.state || 'Worldwide'}`,
        remote: true,
        ...parseCompensation(row.description),
        url: row.link,
        description: row.description,
        postedAt: row.pubDate,
        expiresAt: row.expiresAt,
        employmentType: row.type,
        workplaceType: 'remote'
      });
    }).filter(Boolean);
}

module.exports = { fetch: fetchWeWorkRemotely };
