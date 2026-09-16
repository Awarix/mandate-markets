import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS, DEFAULT_USER_SETTINGS_LAST_TESTED } from "../risk/params.ts";
import { canUnlink, parseReferralCode, parseSettings, seedForNewConnect } from "./connect.ts";
import { SITE_OFFERS } from "./discovery.ts";

/** The body every test below posts. **Not one field may equal the shipped default**
 *  (`tasks/46` §3.3): the failure this file exists to catch is a parser that silently
 *  falls back instead of refusing, and a body that already reads like the default makes
 *  "passed through" and "quietly replaced" the same observation. It was
 *  `{ leverage: 10, stopPct: 0.03, perSignalPct: 0.1 }` — three of four fields were the
 *  default, and `stopPct` became the fourth on 2026-09-12. */
const BASE = { leverage: 18 as const, stopLoss: false, stopPct: 0.04, perSignalPct: 0.15 };

test("the body every test here posts is not the default in any field", () => {
  for (const k of ["leverage", "stopLoss", "stopPct", "perSignalPct"] as const) {
    assert.notEqual(BASE[k], DEFAULT_USER_SETTINGS[k], `${k} equals the default — this file proves less than it looks`);
  }
});

// Anything this parser drops instead of refusing becomes a request for real money,
// because that is what a connection is. An earlier version type-checked each field and
// silently fell back to the default when the check failed, which turned `mode: "turbo"`
// into a live account. Every field is passed through and refused by `validate` since.

test("a valid body is passed through exactly, field by field", () => {
  const r = parseSettings({ ...BASE });
  assert.ok(r.ok, !r.ok ? r.error : "");
  assert.deepEqual({ ...r.settings }, { ...BASE, holdToTarget: false, mode: "live" });
});

test("connecting is a request for live, and there is no way to ask for anything else", () => {
  const r = parseSettings({ ...BASE });
  assert.ok(r.ok);
  assert.equal(r.ok && r.settings.mode, "live");
  assert.equal(DEFAULT_USER_SETTINGS.mode, "live");
});

// The site has no simulation switch: paper is an operator tool, set by writing
// `accounts/<address>.json` on the box. A body carrying `mode` did not come from our
// UI, so it is refused rather than ignored — including `mode: "paper"`, which is the
// one value that would otherwise look harmless. Silently answering a request for paper
// with a live account is the failure worth being loud about.
test("mode is refused from the web whatever it says, valid values included", () => {
  for (const mode of ["live", "paper", "turbo", true, 1, null, "LIVE", "Paper", ""]) {
    const r = parseSettings({ ...BASE, mode });
    assert.equal(r.ok, false, `mode=${JSON.stringify(mode)} must be refused`);
    assert.ok(!r.ok && /not a setting/.test(r.error), "and must say it is not a setting");
  }
});

test("every other field is refused rather than quietly replaced", () => {
  for (const bad of [
    { leverage: 40 }, { leverage: "10" }, { leverage: null },
    { stopPct: 5 }, { stopPct: 0 }, { stopPct: "0.03" },
    { perSignalPct: 0 }, { perSignalPct: 2 },
    { stopLoss: "yes" }, { stopLoss: 1 },
    { holdToTarget: "yes" }, { holdToTarget: 1 }, { holdToTarget: null },
  ]) {
    const r = parseSettings({ ...BASE, ...bad });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} must be refused`);
    assert.ok(!r.ok && r.error.length > 0, "and must say why");
  }
});

// The control ships disabled in the markup, and a POST does not read markup. The lock
// is a date rather than a flag because it is one measurement finishing: the σ0.5 block
// began 2026-09-07 09:46Z against a prediction written under the current exit policy,
// and letting the other one loose on the same block would make neither change readable.
const OPENS = SITE_OFFERS.holdToTargetOpensAt;
const dayBefore = new Date(`${OPENS}T00:00:00Z`).getTime() - 86_400_000;

test("hold-to-resolve is refused from the web until it opens, and says when that is", () => {
  const r = parseSettings({ ...BASE, holdToTarget: true }, new Date(dayBefore));
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.error.includes(OPENS), "the refusal has to name the date, not just decline");
});

// Only `true` is gated. `false` is asking for what it would get anyway, and refusing it
// would break every client that sends the whole settings object back.
test("hold-to-resolve false is accepted before it opens, and true is accepted after", () => {
  const before = parseSettings({ ...BASE, holdToTarget: false }, new Date(dayBefore));
  assert.ok(before.ok && before.settings.holdToTarget === false);

  const after = parseSettings({ ...BASE, holdToTarget: true }, new Date(`${OPENS}T00:00:00Z`));
  assert.ok(after.ok && after.settings.holdToTarget === true, "the lock lifts on the day, not after it");
});

test("a valid request round-trips exactly what was asked for", () => {
  const r = parseSettings({ leverage: 20, stopLoss: false, stopPct: 0.05, perSignalPct: 0.25 });
  assert.ok(r.ok);
  assert.deepEqual({ ...r.settings }, {
    leverage: 20, stopLoss: false, stopPct: 0.05, perSignalPct: 0.25,
    holdToTarget: false, mode: "live",
  });
});

// Backing out of a connect that never completed.
//
// The guard read "is there an accounts row?", which is true of a *connected* account
// and false of everything else — including a connect still waiting on approval, where
// the agent key is already minted and the executor retries the address every loop. So
// someone who signed in, got a key, thought better of it and wanted to stop was told
// "This account is not connected, so there is nothing to unlink", forever, while the
// desk kept trying. That is the one state you most want a way out of.

test("a connected account can be unlinked", () => {
  assert.equal(canUnlink({ hasAccountRow: true, connectionStatus: "active", unlinkAlreadyRequested: false }), true);
});

test("a connect still pending can be cancelled — the key is minted and the desk is retrying", () => {
  for (const status of ["awaiting_approval", "minting", "active"]) {
    assert.equal(
      canUnlink({ hasAccountRow: false, connectionStatus: status, unlinkAlreadyRequested: false }),
      true,
      `${status} must be stoppable without an accounts row`,
    );
  }
});

test("pressing it twice is safe while the executor has not caught up", () => {
  assert.equal(canUnlink({ hasAccountRow: false, connectionStatus: "disconnected", unlinkAlreadyRequested: true }), true);
});

test("but there is genuinely nothing to stop when nothing was ever started", () => {
  assert.equal(canUnlink({ hasAccountRow: false, connectionStatus: null, unlinkAlreadyRequested: false }), false);
  // Already released: stopping it again is not a thing.
  assert.equal(canUnlink({ hasAccountRow: false, connectionStatus: "disconnected", unlinkAlreadyRequested: false }), false);
});

// Our own account, pinned by accounts/0x4fe5….json, was unlinked from the desk on
// 2026-09-04: released, re-admitted from the file one second later, and then released
// and re-admitted on every loop for seven minutes, because the executor never deletes
// a serviced unlink row and the file lists the account whatever the row says. A
// request the executor cannot honour must be refused, not recorded.
test("an account pinned by an operator's file cannot be unlinked from the web", () => {
  assert.equal(canUnlink({ hasAccountRow: true, connectionStatus: "active", unlinkAlreadyRequested: false, pinned: true }), false);
  assert.equal(canUnlink({ hasAccountRow: false, connectionStatus: "awaiting_approval", unlinkAlreadyRequested: false, pinned: true }), false);
  assert.equal(canUnlink({ hasAccountRow: true, connectionStatus: "active", unlinkAlreadyRequested: false, pinned: false }), true);
});

// ── parseReferralCode (tasks/37 §7.5) ───────────────────────────────────────
//
// This string leaves the building as a signed L1 action, so it gets the treatment
// `src/web/cards.ts` gives a share card's parameters: a bounded shape, checked, never
// a sanitiser applied to whatever arrived.

test("skipping is a choice, and it is not an error", () => {
  assert.deepEqual(parseReferralCode({}), { ok: true, code: null });
  assert.deepEqual(parseReferralCode({ referralCode: null }), { ok: true, code: null });
  assert.deepEqual(parseReferralCode({ referralCode: "" }), { ok: true, code: null });
  assert.deepEqual(parseReferralCode({ referralCode: "   " }), { ok: true, code: null });
});

test("a code is taken, trimmed, and left in the case it was typed", () => {
  assert.deepEqual(parseReferralCode({ referralCode: "OPINION" }), { ok: true, code: "OPINION" });
  assert.deepEqual(parseReferralCode({ referralCode: " OPINION " }), { ok: true, code: "OPINION" });
  // Somebody else's code is as valid as ours: they get their 4% and we get nothing,
  // which is the honest shape of an offer.
  assert.deepEqual(parseReferralCode({ referralCode: "RABBYWALLET" }), { ok: true, code: "RABBYWALLET" });
});

test("anything that is not a code is refused, never cleaned up", () => {
  for (const bad of ["has space", "dash-ed", "a".repeat(21), "<script>", "'; DROP TABLE", "../../etc"]) {
    const r = parseReferralCode({ referralCode: bad });
    assert.equal(r.ok, false, bad);
  }
  assert.equal(parseReferralCode({ referralCode: 42 }).ok, false);
  assert.equal(parseReferralCode({ referralCode: { code: "OPINION" } }).ok, false);
});

// ── `tasks/47` Rule 4, first part: what a new cohort meets ──────────────────────
//
// On 2026-09-10 the stop default moved 3% → 1% in the evening and seven alpha accounts
// connected onto it within hours; 157 of the next day's 176 trips ran the new value, so
// the control arm was nineteen trips. A default reaching a new cohort inside its own
// first block is how the control disappears.

test("a new connect meets the last block-tested default while the current one is untested", () => {
  assert.deepEqual(seedForNewConnect({ blockComplete: false }), DEFAULT_USER_SETTINGS_LAST_TESTED);
  assert.deepEqual(seedForNewConnect({ blockComplete: true }), DEFAULT_USER_SETTINGS);
});

test("the seed fills only the fields a body omits — a value the user chose always wins", () => {
  const seed = { ...DEFAULT_USER_SETTINGS, stopPct: 0.03 };
  const omitted = parseSettings({ leverage: 10, stopLoss: true, perSignalPct: 0.1 }, new Date(), seed);
  assert.ok(omitted.ok);
  assert.equal(omitted.ok && omitted.settings.stopPct, 0.03, "omitted, so it comes from the seed");

  const chosen = parseSettings({ ...BASE, stopPct: 0.05 }, new Date(), seed);
  assert.ok(chosen.ok);
  assert.equal(chosen.ok && chosen.settings.stopPct, 0.05,
    "a stranger who moved the slider gets what they asked for — the seed is a fallback, never a clamp");
});

test("with no seed passed, the shipped default is the fallback — every existing caller is unchanged", () => {
  const r = parseSettings({ leverage: 10, stopLoss: true, perSignalPct: 0.1 });
  assert.ok(r.ok);
  assert.equal(r.ok && r.settings.stopPct, DEFAULT_USER_SETTINGS.stopPct,
    "/api/settings passes no seed: an existing account's own limits are theirs (Rule 5 is alert-only there)");
});

// ⚠ The two are EQUAL today, deliberately — the value 2% superseded is the 1% that was
// moved off for cause, and `DEFAULT_USER_SETTINGS_LAST_TESTED` carries that argument. This
// test is the tripwire for the next default move: when they diverge, it fails and the
// author has to have decided what a new connection meets, and to have moved the page's
// slider literals with it (`design/src/limits.test.ts` pins those to the seed).
test("the seed and the default agree today, and diverging is a decision somebody makes on purpose", () => {
  assert.deepEqual(DEFAULT_USER_SETTINGS_LAST_TESTED, DEFAULT_USER_SETTINGS,
    "if you moved DEFAULT_USER_SETTINGS, decide DEFAULT_USER_SETTINGS_LAST_TESTED in the same PR: " +
    "either the value it superseded, or — when that value was moved off for cause, as 1% was on " +
    "2026-09-12 — the new one. Then update design/views/connect.html's slider values to match the " +
    "seed and say which you chose in the PR. tasks/47 §5.3.");
});
