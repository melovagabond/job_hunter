// Startup Jobs provides a public RSS feed and asks consumers to preserve its links.

const { normalize } = require('../lib/normalize');
const { fetchWithPolicy } = require('../lib/http');
const { parseRss } = require('../lib/rss');
const { parseCompensation } = require('../lib/salary');
const { isUsEligibleRemote } = require('../lib/regions');

function splitTitle(value) {
  const separator = value.lastIndexOf(' at ');
  return separator > 0
    ? { title: value.slice(0, separator), company: value.slice(separator + 4) }
    : { title: value, company: null };
}

function locationFromDescription(description) {
  const lines = String(description || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const location = [...lines].reverse().find(line => /^remote\b/i.test(line));
  return location ? location.split(/\s+·\s+/)[0] : 'Remote';
}

async function fetchStartupJobs(cfg) {
  const res = await fetchWithPolicy(cfg.feed);
  if (!res.ok) return [];
  return parseRss(await res.text())
    .filter(row => !cfg.us_eligible_only || isUsEligibleRemote(locationFromDescription(row.description)))
    .map(row => {
      const parts = splitTitle(row.title);
      return normalize({
        source: 'startup_jobs',
        sourceId: row.guid || row.link,
        title: parts.title,
        company: parts.company,
        location: locationFromDescription(row.description),
        remote: true,
        ...parseCompensation(row.description),
        url: row.link,
        description: `${row.description} ${(row.categories || []).join(' ')}`,
        postedAt: row.pubDate,
        workplaceType: 'remote'
      });
    }).filter(Boolean);
}

module.exports = { fetch: fetchStartupJobs, splitTitle, locationFromDescription };
