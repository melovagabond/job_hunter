const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Point the DB at a throwaway file BEFORE requiring the db module.
process.env.JOB_DB_PATH = path.join(os.tmpdir(), `jobs-test-${Date.now()}.sqlite`);

const db = require('../worker/db/db');
const { normalize, dedupeKey } = require('../worker/lib/normalize');
const { evaluate } = require('../worker/lib/match');
const { haversineMiles } = require('../worker/lib/geo');
const { isConfigured } = require('../worker/lib/env');
const { extractProfile, scoreAgainstProfile } = require('../worker/lib/profile');
const { annualSalary } = require('../worker/sources/jobicy');

const criteria = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'config', 'criteria.json'), 'utf8'
));

function makeJob(overrides = {}) {
  return normalize({
    source: 'test',
    sourceId: 'x1',
    title: 'DevSecOps Engineer',
    company: 'Acme Corp',
    location: 'Philadelphia, PA',
    salaryMin: 150000,
    salaryMax: 180000,
    url: 'https://example.com/job/1',
    ...overrides
  });
}

test('dedupe key ignores punctuation, case, and corp suffixes', () => {
  assert.strictEqual(
    dedupeKey('Acme, Inc.', 'DevSecOps Engineer'),
    dedupeKey('acme', 'devsecops engineer')
  );
});

test('same job from two sources collapses to one row', () => {
  const a = makeJob({ source: 'adzuna' });
  const b = makeJob({ source: 'remotive' });
  const r1 = db.upsertJob(a);
  const r2 = db.upsertJob(b);
  assert.strictEqual(r1.inserted, true);
  assert.strictEqual(r2.inserted, false);
  assert.strictEqual(r1.id, r2.id);
});

test('matcher accepts a qualifying Philly job', () => {
  const v = evaluate(makeJob({ company: 'Match Co' }), criteria);
  assert.strictEqual(v.matched, true);
  assert.ok(v.reasons.some(r => r.startsWith('title_hit:')));
});

test('exclusion vetoes even with an allowlist hit', () => {
  const v = evaluate(
    makeJob({ title: 'Junior Cloud Security Analyst' }), criteria
  );
  assert.strictEqual(v.matched, false);
  assert.ok(v.reasons[0].startsWith('title_excluded:'));
});

test('salary floor compares against range max', () => {
  const survives = evaluate(
    makeJob({ salaryMin: 120000, salaryMax: 160000 }), criteria
  );
  assert.strictEqual(survives.matched, true);

  const dies = evaluate(
    makeJob({ salaryMin: 90000, salaryMax: 110000 }), criteria
  );
  assert.strictEqual(dies.matched, false);
  assert.ok(dies.reasons.at(-1).startsWith('salary_below_floor'));
});

test('missing salary passes when accept_missing_salary is true', () => {
  const v = evaluate(
    makeJob({ salaryMin: undefined, salaryMax: undefined }), criteria
  );
  assert.strictEqual(v.matched, true);
  assert.ok(v.reasons.includes('salary_unknown_accepted'));
});

test('remote job outside radius matches; onsite NYC job does not', () => {
  const remote = evaluate(
    makeJob({ location: 'Remote - US', remote: true }), criteria
  );
  assert.strictEqual(remote.matched, true);
  assert.ok(remote.reasons.includes('geo:remote'));

  // NYC is ~80 miles out. Coordinates force the haversine path.
  const nyc = evaluate(
    makeJob({ location: 'New York, NY', lat: 40.7128, lon: -74.0060 }), criteria
  );
  assert.strictEqual(nyc.matched, false);
});

test('haversine sanity: Philly to Wilmington under 50, to NYC over 50', () => {
  const wilmington = haversineMiles(39.9526, -75.1652, 39.7391, -75.5398);
  const nyc = haversineMiles(39.9526, -75.1652, 40.7128, -74.0060);
  assert.ok(wilmington < 50, `wilmington ${wilmington}`);
  assert.ok(nyc > 50, `nyc ${nyc}`);
});

test('metro keyword rescues jobs without coordinates', () => {
  const v = evaluate(
    makeJob({ title: 'Cloud Security Architect', company: 'KoP Co', location: 'King of Prussia, PA' }),
    criteria
  );
  assert.strictEqual(v.matched, true);
  assert.ok(v.reasons.includes('geo:metro_keyword'));
});

test('state machine enforces legal transitions and logs history', () => {
  const { id } = db.upsertJob(makeJob({ company: 'FSM Co', sourceId: 'fsm1' }));
  db.transition(id, 'matched');
  db.transition(id, 'queued');
  db.transition(id, 'applied');
  db.transition(id, 'needs_followup');
  db.transition(id, 'followed_up');

  const conn = db.connect();
  const history = conn.prepare(
    'SELECT from_status, to_status FROM status_history WHERE job_id = ? ORDER BY id'
  ).all(id);
  assert.strictEqual(history.length, 5);
  assert.strictEqual(history[0].from_status, 'new');
  assert.strictEqual(history.at(-1).to_status, 'followed_up');
});

test('illegal transitions throw', () => {
  const { id } = db.upsertJob(makeJob({ company: 'Illegal Co', sourceId: 'i1' }));
  assert.throws(() => db.transition(id, 'applied'), /illegal transition/);
  db.transition(id, 'matched');
  assert.throws(() => db.transition(id, 'followed_up'), /illegal transition/);
});

test('weekly application counter counts only this ISO week', () => {
  const { id } = db.upsertJob(makeJob({ company: 'Weekly Co', sourceId: 'w1' }));
  db.transition(id, 'matched');
  db.transition(id, 'queued');
  db.transition(id, 'applied');
  const before = db.appliedThisWeek();
  db.recordApplication(id, 'devsecops_v2');
  assert.strictEqual(db.appliedThisWeek(), before + 1);
});

test('isoWeekKey handles year boundary', () => {
  // Jan 1 2027 is a Friday, ISO week 53 of 2026.
  assert.strictEqual(db.isoWeekKey(new Date(Date.UTC(2027, 0, 1))), '2026-W53');
});

test('placeholder credentials are treated as unconfigured', () => {
  assert.strictEqual(isConfigured('your_key_here'), false);
  assert.strictEqual(isConfigured('you@example.com'), false);
  assert.strictEqual(isConfigured('real-key-value'), true);
});

test('resume profile extraction and scoring are explainable', () => {
  const profile = extractProfile('AWS Azure Kubernetes Terraform DevSecOps');
  const result = scoreAgainstProfile(makeJob({
    title: 'Cloud Security Architect',
    description: 'Build secure platforms on AWS with Kubernetes and Terraform.'
  }), profile);
  assert.ok(result.score >= 3);
  assert.ok(result.reasons.includes('resume_skill:aws'));
  assert.ok(result.reasons.includes('resume_skill:kubernetes'));
});

test('full-text index searches job title and description', () => {
  db.upsertJob(makeJob({
    sourceId: 'fts1', company: 'Searchable Co',
    description: 'Kubernetes platform security and Terraform automation'
  }));
  const results = db.searchJobs('kubernetes terraform');
  assert.ok(results.some(job => job.company === 'Searchable Co'));
});

test('broad resume-assisted titles require multiple skill signals', () => {
  const profile = extractProfile('AWS Kubernetes Terraform DevOps');
  const weak = evaluate(makeJob({
    title: 'Payments Solutions Architect',
    description: 'Compliance reporting for payment processing.'
  }), criteria, profile);
  assert.strictEqual(weak.matched, false);
  assert.ok(weak.reasons.some(reason => reason.startsWith('resume_evidence_too_weak:')));

  const strong = evaluate(makeJob({
    title: 'Cloud Platform Engineer',
    description: 'Build AWS Kubernetes platforms using Terraform.'
  }), criteria, profile);
  assert.strictEqual(strong.matched, true);
});

test('Jobicy salaries are annualized without turning missing values into zero', () => {
  assert.strictEqual(annualSalary(80, 'hourly'), 166400);
  assert.strictEqual(annualSalary(12000, 'monthly'), 144000);
  assert.strictEqual(annualSalary(null, 'yearly'), undefined);
  assert.strictEqual(annualSalary('', 'yearly'), undefined);
});
