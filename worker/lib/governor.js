// The 100/week governor, implementing two rules from the project spec:
//
// 1. Hard cap: no more than criteria.weekly_apply_cap applications per
//    ISO week.
// 2. No auto-restart: when a NEW week begins, applying stays blocked
//    until every job left in 'applied' status has been manually
//    dispositioned (to needs_followup, followed_up, or rejected).
//    Translation: the pipeline does not resume until you have sorted
//    your follow-ups. You wrote the rule; the machine just enforces it.
//
// Mid-week, jobs sitting in 'applied' do NOT block further applies;
// they only block the start of the next week's batch.

const db = require('../db/db');

function backlogCount() {
  const conn = db.connect();
  const row = conn.prepare(
    "SELECT COUNT(*) AS n FROM jobs WHERE status = 'applied'"
  ).get();
  return row.n;
}

function status(cap) {
  const applied = db.appliedThisWeek();
  const backlog = backlogCount();

  if (applied >= cap) {
    return {
      allowed: false,
      reason: 'weekly_cap_reached',
      applied_this_week: applied,
      cap,
      backlog
    };
  }

  // Fresh week (nothing applied yet) with unsorted carryover: blocked.
  if (applied === 0 && backlog > 0) {
    return {
      allowed: false,
      reason: 'unsorted_backlog',
      applied_this_week: applied,
      cap,
      backlog
    };
  }

  return {
    allowed: true,
    reason: null,
    applied_this_week: applied,
    cap,
    remaining: cap - applied,
    backlog
  };
}

module.exports = { status, backlogCount };
