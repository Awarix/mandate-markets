import assert from "node:assert/strict";
import { test } from "node:test";
import type { HaltKind } from "../types.ts";
import {
  canClearHalt, checkCapConsistency, type ClearInput, correlatedStopOfMandate, haltDistance, stopsToHalt,
} from "./halt.ts";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, RISK_PARAMS, type UserSettings } from "./params.ts";

const D = DEFAULT_USER_SETTINGS;
const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} ≠ ${b}`);

// The worked set in docs/ACCOUNT-MODEL.md §6. Every per-position figure is one percent
// smaller than it was before `tasks/21`, because `perSignalPct` is now a fraction of
// the budget — the mandate less the 1% reserve — and not of the mandate itself.
// ⚠ Every figure here doubled on 2026-09-12 with the default stop (`tasks/42` §7): it
// was $0.99, 10% of margin and 10.1 stops at the 1% default, and $2.97 / 30% / 3.4 at
// the 3% one before that. The arithmetic is `stopPct × leverage × perSignalPct ×
// (1 − reserveFrac)` and nothing else, so the whole row tracks the constant.
test("TRIPWIRE: at the defaults on a $100 mandate, $1.98 a stop, 20% of the margin, about 5.1 stops", () => {
  const h = haltDistance(D, 100, 102.09);
  near(h.stopOut.usd, 1.98);
  near(h.stopOut.ofMandate, 0.0198);
  near(h.stopOut.ofMargin, 0.20, "a fraction of the position, not of the mandate");
  // The cap over what one stop costs, both halves derived: `10 / 1.98` was two literals
  // and would have kept passing through a move of `dailyLossPct` (`tasks/46` §3.3).
  near(h.stopsToHalt, RISK_PARAMS.dailyLossPct * 100 / h.stopOut.usd);
  near(h.haltAtUsd!, 10.209, "10% of the day's opening equity, not of the mandate");
  // The property that actually has to hold, rather than the number: an owner on the
  // shipped defaults is told "you are fine", not "two bad days would pause you". The
  // boundary `limitsNote` branches on is 2 and this sits at 5.1.
  assert.ok(h.stopsToHalt > 2, "the defaults must not land in the warned region");
});

// With the stop off a position can lose its whole margin. At 10% that used to be
// exactly the day's allowance; off the budget it is $9.90 against $10, so one of them
// now falls a hair short of the halt rather than landing on it.
test("with the stop off, one position's whole margin all but reaches the halt", () => {
  const h = haltDistance({ ...D, stopLoss: false }, 100, 100);
  near(h.stopOut.usd, 9.90);
  near(h.stopOut.ofMargin, 1);
  near(h.stopsToHalt, 1 / (1 - RISK_PARAMS.reserveFrac));
  assert.ok(h.stopsToHalt > 1, "a single stopless position no longer quite pauses the account");
});

// Both ends of what the site offers (`SITE_OFFERS` in src/web/discovery.ts).
test("the weakest settings take forty stops; the strongest halt inside one", () => {
  near(stopsToHalt({ ...D, perSignalPct: 0.05, leverage: 5, stopPct: 0.01 }), 40 / (1 - RISK_PARAMS.reserveFrac));
  const strongest = haltDistance({ ...D, perSignalPct: 0.25, leverage: 20, stopPct: 0.08 }, 100, 100);
  assert.ok(strongest.stopsToHalt < 1, `one stop halts: ${strongest.stopsToHalt}`);
  // 8% at 20x is 160% of the margin on paper. Isolated margin cannot lose more than
  // itself, and the per-asset clamp keeps a real stop under liquidation, so the
  // figure is capped at the whole margin rather than stated as an impossibility.
  near(strongest.stopOut.ofMargin, 1);
  near(strongest.stopOut.usd, 24.75);
});

test("no opening equity yet is no halt level, never zero", () => {
  const h = haltDistance(D, 100, null);
  assert.equal(h.haltAtUsd, null);
  near(h.stopOut.usd, 1.98, "the stop-out cost needs only the mandate");
});

// The startup warning and the desk sentence are one number.
// The settings are `0xacc00004fd…`'s, live on 2026-09-10 and the account that hit the
// daily cap first. At the 1% default no offerable combination of size alone can trip
// this warning any more — it takes a wide stop — so the case that exercises it has to
// be one, and a real one is better than an invented one.
test("checkCapConsistency reads the same count the desk prints", () => {
  const s: UserSettings = { ...D, stopPct: 0.08, perSignalPct: 0.20 };
  const warnings = checkCapConsistency(s);
  assert.ok(warnings.some((w) => w.includes(`${stopsToHalt(s).toFixed(1)} stopped signals`)), warnings.join(" | "));
  // Still true at the 2% default — two stopped signals cost 4% of the mandate against a
  // 10% cap — but the margin is half what it was, and four of them now reach it.
  assert.ok(2 * D.stopPct * D.leverage * D.perSignalPct < RISK_PARAMS.dailyLossPct, "two ordinary losses must not halt");
});

// `tasks/21` §4's table, from the other side: the count of positions that fit times
// what each one loses at its stop. `src/risk/ledger.test.ts` asserts the percentages;
// this asserts they are the same arithmetic the desk's own stop-out figure is built on.
test("the correlated stop is the position count times one stop-out", () => {
  for (const perSignalPct of [0.05, 0.10, 0.15, 0.20, 0.25]) {
    const s: UserSettings = { ...D, perSignalPct };
    near(correlatedStopOfMandate(s), maxConcurrentSignals(s) * haltDistance(s, 1, null).stopOut.ofMandate,
      `${perSignalPct}`);
  }
});

// ── Clearing a halt (`tasks/30` §1) ─────────────────────────────────────────

const CLEAR: ClearInput = {
  actor: "operator",
  kind: "daily-loss",
  haltedAt: "2026-09-11T18:30:11.255Z",
  day: "2026-09-12",
  dayStartEquity: 100,
  equityUsd: 99,
  now: new Date("2026-09-12T09:00:00Z"),
};
const clear = (over: Partial<ClearInput> = {}) => canClearHalt({ ...CLEAR, ...over });

// **The rule `docs/LOG.md` records being learned three times.** Cleared early at
// 2026-09-10 22:23Z, two accounts re-halted at 14.4% and 15.2% on the next tick and a
// third opened three losers in 35 minutes. `rollDay` rebaselines at the UTC boundary,
// so the condition is gone by construction after it and is not gone before it.
test("a daily-loss halt does not clear on the day it fired", () => {
  const same = clear({ haltedAt: "2026-09-12T02:00:00Z" });
  assert.equal(same.ok, false);
  assert.match(same.ok ? "" : same.reason, /fired today/);
  // The same halt, one UTC day later, on a rolled baseline.
  assert.equal(clear().ok, true);
});

// An unrealised recovery inside the day is not the condition going away: the account is
// still free to lose another 10% of a baseline it has already spent.
test("it does not clear while the account is still below the cap", () => {
  const down = clear({ equityUsd: 89 });
  assert.equal(down.ok, false);
  assert.match(down.ok ? "" : down.reason, /11\.0% below/);
  assert.equal(clear({ equityUsd: 91 }).ok, true, "inside the cap again, and the day has rolled");
});

// `0xacc00004fd…` on 2026-09-13: halted, day baseline still 2026-09-12, because nothing
// is ticking it. Clearing the flag would not bring the account back.
test("it does not clear an account nothing is rolling the day for", () => {
  const stale = clear({ day: "2026-09-11" });
  assert.equal(stale.ok, false);
  assert.match(stale.ok ? "" : stale.reason, /nothing is ticking this account/);
});

test("with nothing reporting the account it clears, and says it could not check", () => {
  const blind = clear({ equityUsd: null });
  assert.equal(blind.ok, true);
  assert.match(blind.ok ? blind.note : "", /without an equity to check it against/);
});

// The whole content of a foreign-actor halt is *our position accounting can no longer
// be trusted*, and the account's owner is the one person who cannot confirm that for
// us — they are the second actor.
test("only a daily-loss halt is the owner's, and each refusal says why in its own words", () => {
  for (const kind of ["foreign-position", "foreign-order", "liquidation", "operator"] as const) {
    const v = clear({ actor: "owner", kind });
    assert.equal(v.ok, false, kind);
    const reason = v.ok ? "" : v.reason;
    assert.ok(reason.length > 40, `${kind} needs a sentence, not a disabled control`);
    assert.doesNotMatch(reason, /daily/i, `${kind} must not borrow the daily-loss wording`);
  }
  assert.equal(clear({ actor: "owner" }).ok, true, "and the daily-loss one is theirs");
});

// No time rule on the kinds that do not expire: waiting for midnight buys nothing when
// the condition is not measured against the day.
test("an operator clears a foreign-actor halt the day it fired", () => {
  const v = clear({ kind: "foreign-position", haltedAt: "2026-09-12T02:00:00Z" });
  assert.equal(v.ok, true);
});

// ⚠ The state every halt on the desk was in the day this shipped: a kind is written
// when the condition fires or is still true on a later tick, and a daily-loss condition
// has gone by the time anybody clears it. Refusing these would leave the hand `UPDATE`
// in place on exactly the halts this replaces.
test("an untyped halt is the operator's under the strictest rules, and never the owner's", () => {
  assert.equal(clear({ kind: null, actor: "owner" }).ok, false);
  const v = clear({ kind: null });
  assert.equal(v.ok, true);
  assert.match(v.ok ? v.note : "", /kind was not recorded/);
  // And it is held to the daily-loss rules rather than waved through.
  assert.equal(clear({ kind: null, haltedAt: "2026-09-12T02:00:00Z" }).ok, false);
  assert.equal(clear({ kind: null, equityUsd: 80 }).ok, false);
});

// ⚠ A **read-only** opener — the public web tier — does not run `addMissingColumns`, so
// against a ledger an older executor wrote the column is absent and the field is
// `undefined`, not null. A strict check here read every pre-migration halt as typed.
test("undefined is the same fact as null, because a read-only ledger has no column", () => {
  assert.deepEqual(
    clear({ kind: undefined as unknown as HaltKind | null, actor: "owner" }),
    clear({ kind: null, actor: "owner" }),
  );
});
