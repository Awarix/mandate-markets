import assert from "node:assert/strict";
import { test } from "node:test";
import type { Desk } from "./api.ts";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../../src/risk/params.ts";
import { changeLine, holdsMore, same, secondsToLoop } from "./deskLimits.ts";

// The pure half of the desk's limits card (`tasks/18` §9). The controls themselves are
// DOM and are checked in a browser; these are the three rules that decide what the card
// *says*, and each of them is a sentence somebody acts on.

/** Only the fields these functions read. The payload is large and none of the rest of it
 *  changes any answer below. */
function desk(over: Partial<Desk>): Desk {
  return {
    halted: false,
    loopIntervalSec: RISK_PARAMS.loopIntervalSec,
    executorSeenSecondsAgo: 0,
    mandateUsd: 115.5,
    balanceUsd: 115.5,
    changes: {
      pendingSettings: null, pendingMandate: null,
      settingsAt: "2026-09-04T11:20:00.000Z", mandateAt: "2026-09-04T11:29:59.000Z",
      pinned: false, refused: null,
    },
    ...over,
  } as Desk;
}

/** A pending change has to be a *change*, so none of these may be the shipped default —
 *  `stopPct` was `0.02`, which became the default on 2026-09-12 and quietly stopped
 *  proving anything (`tasks/46` §3.3). The assertion below is what keeps it that way. */
const PENDING = {
  requestedAt: "2026-09-04T12:00:00.000Z",
  settings: { leverage: 20, stopLoss: true, stopPct: 0.04, perSignalPct: 0.15 },
};

test("the pending change really is a change from the shipped default", () => {
  const d = DEFAULT_USER_SETTINGS;
  assert.notEqual(PENDING.settings.leverage, d.leverage);
  assert.notEqual(PENDING.settings.stopPct, d.stopPct);
  assert.notEqual(PENDING.settings.perSignalPct, d.perSignalPct);
});

// The owner's ask, in his words: *"the card says Requested · applies on the next loop,
// in about N s"*. N is the loop interval less how long ago the executor was last seen,
// so the number shrinks as the loop approaches instead of restating the interval.
const LOOP = RISK_PARAMS.loopIntervalSec;

test("the countdown is what is left of the loop, not the loop", () => {
  assert.equal(secondsToLoop(desk({ executorSeenSecondsAgo: 12 })), LOOP - 12);
  assert.equal(secondsToLoop(desk({ executorSeenSecondsAgo: LOOP - 1 })), 1);
});

// The loop is due and the heartbeat that would say it had run is itself written once a
// loop, so zero is a real state and lasts a moment. Never negative.
test("a loop already due is due, not overdue by a negative number", () => {
  assert.equal(secondsToLoop(desk({ executorSeenSecondsAgo: LOOP })), 0);
  assert.equal(secondsToLoop(desk({ executorSeenSecondsAgo: LOOP + 140 })), 0);
});

// "Nothing is happening" is a much worse message than "the desk is not running" — the
// rule the connect screen already applies, at the same 300s.
test("a desk that is not running says so instead of counting", () => {
  assert.equal(secondsToLoop(desk({ executorSeenSecondsAgo: null })), null);
  assert.equal(secondsToLoop(desk({ executorSeenSecondsAgo: 301 })), null);
  assert.match(
    changeLine(desk({ executorSeenSecondsAgo: null, changes: { ...desk({}).changes!, pendingSettings: PENDING } })),
    /the desk is not running/,
  );
});

test("what the card says under the button, in each of its four states", () => {
  const pending = { ...desk({}).changes!, pendingSettings: PENDING };
  assert.match(changeLine(desk({ changes: pending, executorSeenSecondsAgo: 18 })), new RegExp(`in about ${LOOP - 18} s\\.`));
  assert.match(changeLine(desk({ changes: pending, executorSeenSecondsAgo: LOOP })), /due now\./);
  // A halted account accepts a change and does nothing with it until the halt is
  // cleared (`tasks/18` §3), so counting down to a loop would be a lie.
  assert.match(changeLine(desk({ changes: pending, halted: true })), /once the halt is cleared/);
  assert.match(changeLine(desk({})), /^In force since /);
});

// The Apply button is offered only for a change there is something to apply. With the
// stop off the executor places no stop at all, so the distance slider is not part of
// what is in force and moving it is not a change to ask for.
test("what counts as a change, and what does not", () => {
  const base = { lev: 10, stopPct: 3, per: 10, on: true, hold: false };
  assert.ok(same(base, { ...base }));
  assert.ok(!same(base, { ...base, lev: 20 }));
  assert.ok(!same(base, { ...base, per: 15 }));
  assert.ok(!same(base, { ...base, stopPct: 2 }));
  assert.ok(!same(base, { ...base, on: false }));
  // The exit policy is a change like any other, or the Apply button would stay dead
  // for the one setting whose wrong answer costs 30% of a position rather than 3%.
  assert.ok(!same(base, { ...base, hold: true }));
  const off = { ...base, on: false };
  assert.ok(same(off, { ...off, stopPct: 8 }), "with no stop the distance is not in force");
});

// `tasks/18` §4.4 asked for the line *you hold $300.00 and your mandate is $40.00*
// whenever the two differ materially — at least $1 and 1% of the mandate, so a dollar
// of funding does not put a button on the screen every day.
test("the mandate and the balance differ materially, or the card stays quiet", () => {
  assert.ok(holdsMore(desk({ mandateUsd: 40, balanceUsd: 300 })));
  assert.ok(!holdsMore(desk({ mandateUsd: 115.5, balanceUsd: 116.2 })), "under $1");
  assert.ok(!holdsMore(desk({ mandateUsd: 5000, balanceUsd: 5040 })), "over $1, under 1%");
  assert.ok(holdsMore(desk({ mandateUsd: 115.5, balanceUsd: 123.68 })), "the account that prompted this");
  assert.ok(holdsMore(desk({ mandateUsd: 300, balanceUsd: 40 })), "a withdrawal is material too");
  assert.ok(!holdsMore(desk({ balanceUsd: null })), "an unreachable venue offers nothing");
});
