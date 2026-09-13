const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

process.env.JOB_DB_PATH = path.join(os.tmpdir(), `jobs-api-test-${Date.now()}.sqlite`);

const db = require('../worker/db/db');
const governor = require('../worker/lib/governor');
const { buildApp } = require('../api/index');
const { normalize } = require('../worker/lib/normalize');

const CAP = 3; // small cap so tests do not need 100 inserts

function seedJob(name, status = 'matched') {
  const { id } = db.upsertJob(normalize({
    source: 'test', sourceId: name, title: 'DevSecOps Engineer',
    company: name, location: 'Philadelphia, PA',
    salaryMin: 150000, salaryMax: 180000, url: 'https://example.com/' + name
  }));
  if (status !== 'new') db.transition(id, 'matched');
  if (['queued', 'applied'].includes(status)) db.transition(id, 'queued');
  if (status === 'applied') db.transition(id, 'applied');
  return id;
}

let server, base;
test.before(async () => {
  const app = buildApp({ weeklyCap: () => CAP });
  await new Promise(res => { server = app.listen(0, res); });
  base = `http://localhost:${server.address().port}`;
});
test.after(() => { server.close(); db.close(); });

async function req(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

test('governor allows applying under cap with empty ledger', () => {
  const g = governor.status(CAP);
  assert.strictEqual(g.allowed, true);
  assert.strictEqual(g.remaining, CAP);
});

test('governor blocks at the weekly cap', () => {
  for (let i = 0; i < CAP; i++) {
    const id = seedJob('cap' + i, 'queued');
    db.transition(id, 'applied');
    db.recordApplication(id);
  }
  const g = governor.status(CAP);
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'weekly_cap_reached');
});

test('fresh week stays blocked until applied backlog is sorted', () => {
  // Rewrite this week's applications into last week to simulate rollover.
  const conn = db.connect();
  conn.prepare("UPDATE applications SET week_key = '2020-W01'").run();

  let g = governor.status(CAP);
  assert.strictEqual(g.allowed, false);
  assert.strictEqual(g.reason, 'unsorted_backlog');
  assert.ok(g.backlog >= CAP);

  // Disposition every applied job; the gate should open.
  const appliedIds = conn.prepare("SELECT id FROM jobs WHERE status = 'applied'").all();
  for (const { id } of appliedIds) db.transition(id, 'needs_followup');

  g = governor.status(CAP);
  assert.strictEqual(g.allowed, true);
});

test('GET /api/stats returns counts and governor state', async () => {
  const { status, body } = await req('GET', '/api/stats');
  assert.strictEqual(status, 200);
  assert.ok(body.by_status);
  assert.ok('allowed' in body.governor);
  assert.match(body.week, /^\d{4}-W\d{2}$/);
});

test('GET /api/jobs filters by status and rejects junk statuses', async () => {
  seedJob('listme', 'matched');
  const ok = await req('GET', '/api/jobs?status=matched');
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.some(j => j.company === 'listme'));

  const bad = await req('GET', '/api/jobs?status=definitely_hired');
  assert.strictEqual(bad.status, 400);
});

test('POST transition moves a job and 409s on illegal moves', async () => {
  const id = seedJob('mover', 'matched');
  const ok = await req('POST', `/api/jobs/${id}/transition`, { to: 'queued' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual({ from: ok.body.from, to: ok.body.to }, { from: 'matched', to: 'queued' });

  const bad = await req('POST', `/api/jobs/${id}/transition`, { to: 'followed_up' });
  assert.strictEqual(bad.status, 409);
});

test('transition endpoint refuses to enter applied directly', async () => {
  const id = seedJob('sneaky', 'queued');
  const res = await req('POST', `/api/jobs/${id}/transition`, { to: 'applied' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /apply/);
});

test('POST /apply records an application and reports governor state', async () => {
  const id = seedJob('legit', 'queued');
  const before = db.appliedThisWeek();
  const res = await req('POST', `/api/jobs/${id}/apply`, { resume_variant: 'v1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(db.appliedThisWeek(), before + 1);
  assert.ok('allowed' in res.body.governor);
});

test('POST /apply returns 429 when the governor says no', async () => {
  let i = 0;
  while (db.appliedThisWeek() < CAP) {
    const id = seedJob('fill-cap-' + i++, 'queued');
    const filled = await req('POST', `/api/jobs/${id}/apply`);
    assert.strictEqual(filled.status, 200);
  }

  const blockedId = seedJob('blocked-at-cap', 'queued');
  const blocked = await req('POST', `/api/jobs/${blockedId}/apply`);
  assert.strictEqual(blocked.status, 429);
  assert.strictEqual(blocked.body.error, 'governor_blocked');
  assert.strictEqual(blocked.body.governor.reason, 'weekly_cap_reached');

  const job = db.connect().prepare('SELECT status FROM jobs WHERE id = ?').get(blockedId);
  assert.strictEqual(job.status, 'queued');
});

test('GET /api/jobs/:id includes status history', async () => {
  const id = seedJob('historian', 'queued');
  const { status, body } = await req('GET', `/api/jobs/${id}`);
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(body.history));
  assert.strictEqual(body.history[0].from_status, 'new');
});

test('external indexes return safe search links', async () => {
  const { status, body } = await req('GET', '/api/indexes');
  assert.strictEqual(status, 200);
  assert.deepStrictEqual(body.map(index => index.name), ['LinkedIn', 'Indeed', 'Dice']);
  assert.ok(body.every(index => index.url.startsWith('https://')));
});

test('manual import normalizes, matches, and becomes searchable', async () => {
  const imported = await req('POST', '/api/jobs/import', {
    source: 'linkedin',
    title: 'Cloud Security Architect',
    company: 'Imported Co',
    location: 'Remote - US',
    url: 'https://www.linkedin.com/jobs/view/123',
    description: 'AWS Kubernetes Terraform security architecture'
  });
  assert.strictEqual(imported.status, 201);
  assert.strictEqual(imported.body.job.status, 'matched');

  const searched = await req('GET', '/api/search?q=kubernetes+terraform');
  assert.strictEqual(searched.status, 200);
  assert.ok(searched.body.some(job => job.company === 'Imported Co'));
});

test('feedback, digest, metrics, and health expose operational state', async () => {
  const row = db.connect().prepare("SELECT id FROM jobs WHERE company = 'Imported Co'").get();
  const feedback = await req('POST', `/api/jobs/${row.id}/feedback`, {
    action: 'queue', reason: 'strong_resume_alignment'
  });
  assert.strictEqual(feedback.status, 201);

  const metrics = await req('GET', '/api/metrics');
  assert.strictEqual(metrics.status, 200);
  assert.ok(metrics.body.feedback.some(item => item.reason === 'strong_resume_alignment'));

  const digest = await req('GET', '/api/digest?hours=72');
  assert.strictEqual(digest.status, 200);
  assert.ok(digest.body.some(job => job.company === 'Imported Co'));

  const health = await req('GET', '/api/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(health.body.database, true);
});
