import assert from "node:assert/strict";
import { test } from "node:test";
import { bookShape, cents, dailyLossBreached, dayKey, dayLossFrac, fitsBudget, maxDeployedUsd, perSignalBudget, type Allocation } from "./ledger.ts";
import { CORRELATED_STOP_WARN_MULTIPLE, checkCapConsistency, correlatedStopOfMandate } from "./halt.ts";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, RISK_PARAMS, reserveFor, tradeableBudgetUsd, type UserSettings } from "./params.ts";

const S = DEFAULT_USER_SETTINGS;
const base = (over: Partial<Allocation> = {}): Allocation => ({
  baseCapital: 1000, deployedUsd: 0, openCount: 0, dayStartEquity: 1000, equityNow: 1000, ...over,
});

// The worked set in docs/ACCOUNT-MODEL.md §6. Sizing runs off the budget — the
// mandate less the 1% reserve — never off the mandate itself (`tasks/21` §6).
test("$1,000 base at 10% is a $990 budget, $99 per signal and ten positions", () => {
  assert.equal(tradeableBudgetUsd(1000), 990);
  assert.equal(reserveFor(1000), 10);
  assert.equal(perSignalBudget(1000, S), 99);
  assert.equal(maxDeployedUsd(1000), 990);
  assert.equal(maxConcurrentSignals(S), 10);
});

// The property the two caps lacked before `tasks/21`: they now bind at exactly the
// same point, so Σ margin over a full book lands on the budget at every slider value
// and free collateral lands on the reserve. `tasks/21` §10.
test("a full book deploys the whole budget and leaves exactly the reserve, at every size", () => {
  for (const perSignalPct of [0.05, 0.10, 0.15, 0.20, 0.25]) {
    const s = { ...S, perSignalPct };
    const shape = bookShape(1000, s);
    assert.equal(shape.positions, Math.floor(1 / perSignalPct), `${perSignalPct}: position count`);
    assert.ok(shape.deployedAtFullUsd <= maxDeployedUsd(1000) + 1e-9,
      `${perSignalPct}: a full book must never exceed the budget`);
    // Where the size divides the budget evenly, "10% per position, ten positions" is
    // true to the cent: everything deployed, exactly the reserve left. 15% is the one
    // that does not divide — six positions leave a seventh's worth unused — so it is
    // asserted against its own floor rather than against the whole budget.
    const evenly = Number.isInteger(1 / perSignalPct);
    assert.equal(
      cents(shape.deployedAtFullUsd + shape.reserveUsd),
      evenly ? cents(1000) : cents(shape.positions * perSignalPct * 990 + 10),
      `${perSignalPct}: deployed + reserve`);
    // The one position past a full book is refused for concurrency, not for budget —
    // the reason the owner is shown must be the true one.
    const full = fitsBudget(
      base({ baseCapital: 1000, deployedUsd: shape.deployedAtFullUsd, openCount: shape.positions }), s);
    assert.equal(full.fits, false);
    assert.ok(!full.fits && full.reason === "max-concurrent",
      `${perSignalPct}: expected max-concurrent, got ${full.fits ? "fits" : full.reason}`);
  }
});

// `floor`, never `round`. 15% is the case that shows it: six positions deploying 90%
// of the budget, not seven deploying 105%.
test("the position count floors, so Σ margin can never exceed the budget", () => {
  assert.equal(maxConcurrentSignals({ perSignalPct: 0.15 }), 6);
  assert.equal(maxConcurrentSignals({ perSignalPct: 0.05 }), 20);
  assert.equal(maxConcurrentSignals({ perSignalPct: 0.20 }), 5);
  assert.equal(maxConcurrentSignals({ perSignalPct: 0.25 }), 4);
  const shape = bookShape(1000, { ...S, perSignalPct: 0.15 });
  assert.equal(shape.positions, 6);
  assert.ok(shape.deployedAtFullUsd < maxDeployedUsd(1000));
});

test("a signal fits until the budget is reached, then is skipped not shrunk", () => {
  assert.deepEqual(fitsBudget(base({ deployedUsd: 792, openCount: 8 }), S), { fits: true, marginUsd: 99 });
  const full = fitsBudget(base({ deployedUsd: 940.50, openCount: 9 }), S);
  assert.equal(full.fits, false);
  assert.ok(!full.fits && full.reason === "no-budget");
  assert.ok(!full.fits && full.detail.includes("$49.50 left"), full.fits ? "" : full.detail);
});

// tasks/21 §7. The live defect, with the numbers off the two accounts it refused:
// 0x1bec94 and 0x4fe513 were both told "needs $8.63, $8.63 left" on 2026-09-04.
//
// Moving the basis to `base − reserve` did not fix it and was never going to — the
// defect is comparing a float *sum* against a float *product* and both bases have that
// shape. Re-checked against the same fifteen real balances after the change: 28 of 75
// (balance × per-position) combinations still lose their last position to raw-float
// dust. The case below is one of them, on our own account's mandate.
test("the last position of a full book is not lost to float dust", () => {
  const acct = base({ baseCapital: 107.88, dayStartEquity: 107.88, equityNow: 107.88 });
  const s = { ...S, perSignalPct: 0.05 };
  const want = perSignalBudget(acct.baseCapital, s);
  const n = maxConcurrentSignals(s);
  assert.equal(n, 20);
  const deployed = (n - 1) * want;
  assert.equal(want > maxDeployedUsd(acct.baseCapital) - deployed, true, "the raw floats really do disagree");
  const last = fitsBudget({ ...acct, deployedUsd: deployed, openCount: n - 1 }, s);
  assert.ok(last.fits, last.fits ? "" : `${last.reason}: ${last.detail}`);

  // A cent is money and still refuses; the tolerance is dust, not slack.
  const over = fitsBudget({ ...acct, deployedUsd: deployed + 0.01, openCount: n - 1 }, s);
  assert.equal(over.fits, false);
  assert.ok(!over.fits && over.reason === "no-budget");
});

test("the concurrency cap is reported separately from the budget cap", () => {
  const v = fitsBudget(base({ deployedUsd: 0, openCount: 10 }), S);
  assert.equal(v.fits, false);
  assert.ok(!v.fits && v.reason === "max-concurrent", "an empty-but-crowded account is a different skip reason");
});

test("profits do not raise the base — allocation stays off the frozen number", () => {
  // Account doubled to $2,000; the per-signal budget is still $99.
  assert.equal(perSignalBudget(base({ equityNow: 2000 }).baseCapital, S), 99);
});

test("the daily-loss cap counts against the day's opening equity", () => {
  assert.equal(dayLossFrac(base({ equityNow: 900 })), 0.1);
  assert.equal(dailyLossBreached(base({ equityNow: 901 })), false);
  assert.equal(dailyLossBreached(base({ equityNow: 900 })), true);
  assert.equal(dailyLossBreached(base({ equityNow: 1200 })), false, "a profitable day never halts");
});

test("a fresh account with no equity does not read as a 100% loss", () => {
  assert.equal(dayLossFrac(base({ dayStartEquity: 0, equityNow: 0 })), 0);
  assert.equal(dailyLossBreached(base({ dayStartEquity: 0, equityNow: 0 })), false);
});

test("dayKey is a UTC date, so a halt is answerable from a date", () => {
  assert.equal(dayKey(new Date("2026-08-30T23:59:59Z")), "2026-08-30");
  assert.equal(dayKey(new Date("2026-08-31T00:00:01Z")), "2026-08-31");
});

// The four caps interact, and until `tasks/21` the shipped defaults passed this check
// silently. They no longer do, and that is the change rather than a regression: at
// `maxDeployedPct = 1.00` a correlated stop of a full book costs 30% of the mandate
// against a 10% daily halt. The threshold is 2× (owner, 2026-09-04), chosen knowing it
// warns at every setting the site offers — a threshold picked to keep the log quiet
// would be a threshold picked to hide what the raise did.
// **The shipped defaults warn about nothing, and at the 2% stop they only just do not.**
// A correlated stop-out of a full book costs **19.8%** of the mandate against a strict
// `> 2 x 10%`, so this passes by two tenths of a percentage point; it was 9.9% (1.0x) at
// the 1% stop of 2026-09-10 and 29.7% (3.0x) at the 3% one before it, when the warning
// fired on every account on the day three of them hit the cap together. ⚠ `params.ts`
// claimed the 2% move made this check "start warning at the shipped defaults again" —
// the assertion below is what says otherwise, and the claim is corrected there now
// (`tasks/46` §4).
test("the shipped defaults warn about nothing at all, and by two tenths of a point", () => {
  assert.deepEqual(checkCapConsistency(S), []);
  assert.ok(correlatedStopOfMandate(S) < CORRELATED_STOP_WARN_MULTIPLE * RISK_PARAMS.dailyLossPct);
  // Still a real check rather than one that can no longer fire: a wide stop trips it,
  // and this is `0xacc00004fd…`'s live setting on the day it halted.
  const wide = checkCapConsistency({ ...S, stopPct: 0.08, perSignalPct: 0.20 });
  assert.ok(wide.some((w) => w.includes("correlated stop-out")), wide.join(" | "));
  assert.ok(wide.some((w) => w.includes("stopped signals")), wide.join(" | "));
});

// `tasks/21` §4's table, which is the argument the cap raise was approved on. If these
// move, the number on the screens and in the docs moved with them.
test("the correlated stop matches the table tasks/21 §4 was approved on", () => {
  const pctOf = (over: Partial<UserSettings>) =>
    Math.round(correlatedStopOfMandate({ ...S, ...over }) * 100);
  // ⚠ 2026-09-12: 20, not 10. The default stop moved 1% → 2% (`tasks/42` §7), and this
  // figure is `stopPct × leverage` exactly — so it doubled with it, taking a correlated
  // stop-out of a full book from **1.0× the daily halt to 1.98×**. It was 30 (3.0×)
  // before 2026-09-10 and 10 (1.0×) between. The rounded 20 here is `stopPct × leverage`
  // before the reserve; what `checkCapConsistency` compares is 19.8%, which is why it
  // does **not** warn — see the test above.
  assert.equal(pctOf({}), 20, "10x / 2% — the default since 2026-09-12, was 10 at the 1% stop and 30 at 3%");
  assert.equal(pctOf({ leverage: 5, stopPct: 0.08 }), 40, "5x / 8%");
  assert.equal(pctOf({ leverage: 20, stopPct: 0.02 }), 40, "20x / 2%");
  assert.equal(pctOf({ stopLoss: false }), 99, "stop off — the whole budget");
});

test("the consistency check catches the 5% daily cap the docs rejected", () => {
  // The argument the 10% cap was chosen on, restated at the settings that still reach
  // it. An 8% stop x 10x x 20% per signal is 15.8% of base per stop-out, so one loss
  // clears a 10% cap and would clear a 5% one three times over. At the 1% default the
  // same sum is 2% of base and takes five.
  const warnings = checkCapConsistency({ ...S, stopPct: 0.08, perSignalPct: 0.20 });
  assert.ok(warnings.some((w) => w.includes("stopped signals")), warnings.join(" | "));
});

// Three until 2026-09-10, ten between, **five since 2026-09-12** — the count moves with
// `stopPct × leverage × perSignalPct` and nothing else, so it halved when the default
// stop doubled. Five is still comfortably above the "two bad days" boundary the connect
// screen branches on, which is the property that has to hold rather than the number.
//
// ⚠ And the measured version of this is not the arithmetic: at a 2% stop only 10 of 145
// simulated trades stop at all, against 26 at 1%, so a stop-out becomes both dearer and
// rarer. `haltWalk` over the whole archive reads **zero halted days at either stop** at
// this position size (`notes/2026-09-12-…` §3).
test("five stopped signals in a day is what trips the 10% cap", () => {
  const lossPerStop = S.stopPct * S.leverage * S.perSignalPct; // 2% of base
  assert.ok(4 * lossPerStop < RISK_PARAMS.dailyLossPct, "four ordinary losses must not halt");
  assert.ok(6 * lossPerStop > RISK_PARAMS.dailyLossPct, "six must");
});
