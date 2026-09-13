// Config driven matcher. Returns a verdict with reasons so the UI can
// show WHY something was skipped instead of leaving you guessing.
//
// Design: exclusions veto first, then the title must hit the allowlist,
// then salary floor, then the geo rule (radius OR remote). Score is a
// simple additive signal for ranking the review queue, not a gate.

const { classifyLocation } = require('./geo');
const { scoreAgainstProfile } = require('./profile');

function evaluate(job, criteria, profile = null) {
  const reasons = [];
  let score = 0;
  const title = (job.title || '').toLowerCase();

  // 1. Exclusions veto everything, including titles that also hit the
  // allowlist. "Junior Cloud Security Analyst" dies here on purpose.
  const excluded = criteria.titles.exclude.find(x => title.includes(x));
  if (excluded) {
    return { matched: false, score: 0, reasons: [`title_excluded:${excluded}`] };
  }

  // 2. Title allowlist.
  const primaryHits = criteria.titles.must_match_any.filter(x => title.includes(x));
  const assistedHits = (criteria.titles.resume_assisted || []).filter(x => title.includes(x));
  const hits = [...primaryHits, ...assistedHits];
  if (hits.length === 0) {
    return { matched: false, score: 0, reasons: ['title_no_match'] };
  }
  const profileMatch = scoreAgainstProfile(job, profile);
  const profileSkillHits = profileMatch.reasons.length;
  if (primaryHits.length === 0 && assistedHits.length > 0 && profileSkillHits < 2) {
    return {
      matched: false,
      score: profileMatch.score,
      reasons: [
        ...assistedHits.map(h => `title_hit:${h}`),
        ...profileMatch.reasons,
        `resume_evidence_too_weak:${profileSkillHits}`
      ]
    };
  }
  score += hits.length;
  reasons.push(...hits.map(h => `title_hit:${h}`));

  // 3. Salary floor. Compare against the max of the posted range so a
  // 120k-160k posting survives a 140k floor.
  const floor = criteria.salary.floor_usd;
  const best = job.salary_max ?? job.salary_min;
  if (best != null) {
    if (best < floor) {
      return { matched: false, score, reasons: [...reasons, `salary_below_floor:${best}`] };
    }
    score += 2;
    reasons.push(`salary_ok:${best}`);
  } else if (criteria.salary.accept_missing_salary) {
    reasons.push('salary_unknown_accepted');
  } else {
    return { matched: false, score, reasons: [...reasons, 'salary_missing'] };
  }

  // 4. Geo: remote OR within radius of home.
  const geo = classifyLocation(job, criteria.location);
  switch (geo) {
    case 'remote':
      if (!criteria.location.accept_remote) {
        return { matched: false, score, reasons: [...reasons, 'remote_not_accepted'] };
      }
      score += 1;
      reasons.push('geo:remote');
      break;
    case 'in_radius':
    case 'metro_keyword':
      score += 2;
      reasons.push(`geo:${geo}`);
      break;
    case 'unknown':
      if (!criteria.location.accept_unknown_location) {
        return { matched: false, score, reasons: [...reasons, 'geo_unknown'] };
      }
      reasons.push('geo:unknown_accepted');
      break;
    default:
      return { matched: false, score, reasons: [...reasons, 'geo:out_of_area'] };
  }

  score += profileMatch.score;
  reasons.push(...profileMatch.reasons);

  return { matched: true, score, reasons };
}

module.exports = { evaluate };
