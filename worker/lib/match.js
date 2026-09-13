// Config driven matcher. Returns a verdict with reasons so the UI can
// show WHY something was skipped instead of leaving you guessing.
//
// Design: exclusions veto first, then the title must hit the allowlist,
// then salary floor, then the geo rule (radius OR remote). Score is a
// simple additive signal for ranking the review queue, not a gate.

const { classifyLocation } = require('./geo');
const { scoreAgainstProfile } = require('./profile');

function analyzeEligibility(job, criteria) {
  const cfg = criteria.eligibility || {};
  const text = `${job.title || ''} ${job.description || ''}`.toLowerCase();
  const employment = String(job.employment_type || '').toLowerCase();
  const warnings = [];
  const blockers = [];
  if (/security clearance|secret clearance|top secret|ts\/sci/.test(text)) {
    warnings.push('clearance_mentioned');
    if (cfg.allow_clearance_required === false) blockers.push('clearance_required');
  }
  if (/u\.s\. citizen|us citizen|united states citizen/.test(text)) {
    warnings.push('citizenship_mentioned');
  }
  if (/no (visa )?sponsorship|unable to sponsor|not sponsor/.test(text)) {
    warnings.push('no_sponsorship');
    if (cfg.require_sponsorship === true) blockers.push('sponsorship_unavailable');
  }
  if (/contract|temporary|freelance/.test(employment) && cfg.allow_contract === false) {
    blockers.push('contract_not_accepted');
  }
  if (!employment && cfg.accept_unknown_employment_type === false) {
    blockers.push('employment_type_unknown');
  }
  return { blockers, warnings };
}

function evaluate(job, criteria, profile = null) {
  const reasons = [];
  let score = 0;
  const title = (job.title || '').toLowerCase();
  const eligibility = analyzeEligibility(job, criteria);
  if (eligibility.blockers.length) {
    return { matched: false, score: 0, reasons: eligibility.blockers, breakdown: { eligibility: 0 } };
  }

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
  // A range survives when its upper bound reaches the configured floor.
  const floor = criteria.salary.floor_usd;
  const best = job.salary_max ?? job.salary_min;
  const currency = String(job.currency || 'USD').toUpperCase();
  if (best != null && currency !== 'USD') {
    reasons.push(`salary_non_usd_unconverted:${currency}`);
  } else if (best != null) {
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
  reasons.push(...eligibility.warnings.map(warning => `warning:${warning}`));

  const confidence = [job.description, job.location, job.posted_at]
    .filter(Boolean).length + (job.salary_min != null || job.salary_max != null ? 1 : 0);
  return {
    matched: true,
    score,
    reasons,
    missingSkills: profileMatch.missingSkills,
    breakdown: {
      role: hits.length,
      skills: profileMatch.score,
      matched_skills: profileMatch.matchedSkills.length,
      job_skills_not_in_resume: profileMatch.missingSkills.length,
      eligibility: reasons.filter(reason => reason.startsWith('salary_') || reason.startsWith('geo:')).length,
      confidence
    }
  };
}

module.exports = { evaluate, analyzeEligibility };
