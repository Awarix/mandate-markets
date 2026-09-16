import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, RISK_PARAMS } from "./params.ts";
import { cents, type Allocation } from "./ledger.ts";
import { stopOutOfMandate, stopOutOfMargin, stopsToHalt } from "./halt.ts";
import { SETTINGS_CASES } from "./settings-cases.ts";
import { haltCheck, preTradeCheck, type GovernorInput } from "./governor.ts";

const alloc = (over: Partial<Allocation> = {}): Allocation => ({
  baseCapital: 1000, deployedUsd: 0, openCount: 0, dayStartEquity: 1000, equityNow: 1000, ...over,
});

const NOW = new Date("2026-08-30T00:00:00Z");
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000);

/** A book deep enough that the capacity veto is out of the way unless a test puts it
 *  in the way — 20 levels of 10,000 units at ~$100 on each side. */
const deepBook = () => ({
  bids: Array.from({ length: 20 }, (_, i) => ({ px: String(100 - 0.01 * (i + 1)), sz: "10000" })),
  asks: Array.from({ length: 20 }, (_, i) => ({ px: String(100 + 0.01 * (i + 1)), sz: "10000" })),
});

const input = (over: Partial<GovernorInput> = {}): GovernorInput => ({
  halted: false, side: "long", haltReason: null, feedAgeSec: 60, allocation: alloc(),
  settings: DEFAULT_USER_SETTINGS, freeCollateralUsd: 1000,
  capacity: { book: deepBook(), volume24hUsd: 50_000_000 },
  // A long-lived approval and a horizon well inside it, so the expiry veto is out of
  // the way unless a test deliberately puts it in the way.
  agentValidUntil: inDays(180).getTime(), horizonAt: inDays(1), now: NOW, ...over,
});

test("a healthy account approves the per-signal budget", () => {
  // $99, not $100: sizing runs off the mandate less the 1% reserve (`tasks/21` §6).
  assert.deepEqual(preTradeCheck(input()), { approved: true, marginUsd: 99 });
});

test("a halted account opens nothing, and says why", () => {
  const v = preTradeCheck(input({ halted: true, haltReason: "foreign position detected" }));
  assert.equal(v.approved, false);
  assert.ok(!v.approved && v.reason === "account-halted" && v.detail.includes("foreign position"));
});

// A dead signal feed stops us opening. It must never touch existing positions —
// their stops live on the venue and survive us entirely.
test("a stale feed stops opening", () => {
  const v = preTradeCheck(input({ feedAgeSec: RISK_PARAMS.staleFeedSec + 1 }));
  assert.ok(!v.approved && v.reason === "stale-feed");
  assert.ok(preTradeCheck(input({ feedAgeSec: RISK_PARAMS.staleFeedSec })).approved, "the cap itself is still fine");
});

test("the daily loss cap vetoes before any budget arithmetic runs", () => {
  const v = preTradeCheck(input({ allocation: alloc({ equityNow: 900 }) }));
  assert.ok(!v.approved && v.detail.includes("daily loss"));
});

// They now bind at the same point by construction, which makes the *reason* the more
// important half: an owner told "no budget" when the truth is "ten already open" is
// being told something false about their own account.
test("the concurrency cap and the deployed cap are separate refusals", () => {
  const crowded = preTradeCheck(input({ allocation: alloc({ openCount: 10 }) }));
  assert.ok(!crowded.approved && crowded.reason === "max-concurrent", JSON.stringify(crowded));
  const broke = preTradeCheck(input({ allocation: alloc({ deployedUsd: 940.50 }) }));
  assert.ok(!broke.approved && broke.reason === "no-budget", JSON.stringify(broke));
});

// The reserve is 1% of the $1,000 mandate — $10 — and the position costs $99, so the
// account needs $109 free. It replaced a flat $5 floor on 2026-09-04; funding, which
// that floor was written for, turns out never to touch free collateral at all
// (`notes/2026-09-04-isolated-margin-and-the-reserve.md`).
test("we never post the last of the collateral", () => {
  const v = preTradeCheck(input({ freeCollateralUsd: 108.99 }));
  assert.ok(!v.approved && v.reason === "insufficient-collateral", JSON.stringify(v));
  assert.ok(!v.approved && v.detail.includes("$10.00 reserve"), v.approved ? "" : v.detail);
  assert.ok(preTradeCheck(input({ freeCollateralUsd: 109 })).approved, "exactly at the reserve is allowed");
});

// The reserve lands *exactly* on the last position of a full book, so this comparison
// has the same sum-versus-product shape `fitsBudget` does and needs the same cent
// tolerance. Without it the raise would be undone one position from the end.
test("the last position of a full book is not refused on collateral dust", () => {
  const shape = { positions: 10, margin: 99 };
  const v = preTradeCheck(input({
    allocation: alloc({ deployedUsd: (shape.positions - 1) * shape.margin, openCount: shape.positions - 1 }),
    freeCollateralUsd: 1000 - (shape.positions - 1) * shape.margin,
  }));
  assert.ok(v.approved, v.approved ? "" : `${v.reason}: ${v.detail}`);
});

test("the budget is the frozen base's fraction, not a fraction of live equity", () => {
  // Account doubled through profits; the approved margin is unchanged.
  const v = preTradeCheck(input({
    allocation: alloc({ equityNow: 2000, dayStartEquity: 2000 }), freeCollateralUsd: 2000,
  }));
  assert.deepEqual(v, { approved: true, marginUsd: 99 });
});

// docs/ACCOUNT-MODEL.md §1 — detect, then halt. Never trade on a wrong picture.
test("a position we did not open halts the account", () => {
  const h = haltCheck({ foreignOrders: 0, foreignPositions: 1, allocation: alloc(), globalHalt: false });
  assert.ok(h.halt && h.reason.includes("second actor"));
});

test("an order we did not place halts the account", () => {
  const h = haltCheck({ foreignOrders: 2, foreignPositions: 0, allocation: alloc(), globalHalt: false });
  assert.ok(h.halt && h.reason.includes("not placed by us"));
});

test("the operator halt file beats everything, and is reversible", () => {
  const h = haltCheck({ foreignOrders: 0, foreignPositions: 0, allocation: alloc(), globalHalt: true });
  assert.ok(h.halt && h.reason.includes("operator halt"));
  // Not sticky: it stops opening while the file exists and stops stopping when it is
  // removed. A one-way kill switch is not a kill switch, it is a decommission.
  assert.equal(h.halt && h.sticky, false);
});

// "The condition went away" is not evidence the account is safe: a hand-placed
// position that gets closed still means someone else is trading here.
test("a foreign actor and a breached loss cap both halt STICKILY", () => {
  const foreign = haltCheck({ foreignOrders: 0, foreignPositions: 1, allocation: alloc(), globalHalt: false });
  assert.equal(foreign.halt && foreign.sticky, true);
  const orders = haltCheck({ foreignOrders: 1, foreignPositions: 0, allocation: alloc(), globalHalt: false });
  assert.equal(orders.halt && orders.sticky, true);
  const loss = haltCheck({ foreignOrders: 0, foreignPositions: 0, allocation: alloc({ equityNow: 890 }), globalHalt: false });
  assert.equal(loss.halt && loss.sticky, true);
});

test("a clean account does not halt", () => {
  assert.deepEqual(haltCheck({ foreignOrders: 0, foreignPositions: 0, allocation: alloc(), globalHalt: false }), { halt: false });
});

test("the daily loss cap halts the account, not just the next open", () => {
  const h = haltCheck({ foreignOrders: 0, foreignPositions: 0, allocation: alloc({ equityNow: 890 }), globalHalt: false });
  assert.ok(h.halt && h.reason.includes("daily loss"));
});

// Hyperliquid has no "extend": an approval is renewed only by the master wallet
// approving again. So an approval that lapses before a position's horizon is a
// position we could not close, and the rationale we write ("closes at <horizon>
// whatever the P&L") would be false the moment it was written.
test("a signal whose horizon outlives the agent approval is refused", () => {
  const v = preTradeCheck(input({ agentValidUntil: inDays(1).getTime(), horizonAt: inDays(2) }));
  assert.ok(!v.approved && v.reason === "agent-expires-before-horizon");
  assert.match(v.approved ? "" : v.detail, /lapses in 1\.0 days/);
});

test("a horizon inside the approval is fine, even close to it", () => {
  const v = preTradeCheck(input({ agentValidUntil: inDays(2).getTime(), horizonAt: inDays(1.9) }));
  assert.equal(v.approved, true);
});

// The lapsed case falls out of the same comparison: every horizon is past a
// validUntil in the past. This is what stops an expired account looking healthy
// right up until the first order fails to sign.
test("an approval that has already lapsed refuses every signal", () => {
  const v = preTradeCheck(input({ agentValidUntil: inDays(-2).getTime(), horizonAt: inDays(0.5) }));
  assert.ok(!v.approved && v.reason === "agent-expires-before-horizon");
  assert.match(v.approved ? "" : v.detail, /lapsed 2\.0 days ago/);
  assert.match(v.approved ? "" : v.detail, /there is no extend/);
});

// A paper account has no agent, and a live one can have an approval the venue did
// not report an expiry for. Neither is evidence of a near expiry, so neither blocks.
test("no recorded expiry never blocks", () => {
  assert.equal(preTradeCheck(input({ agentValidUntil: null, horizonAt: inDays(3650) })).approved, true);
});

// Ordering: the account-wide vetoes are cheaper and more important than a
// per-signal one, so a halted account says "halted", not "agent expiring".
test("a halt outranks the expiry veto", () => {
  const v = preTradeCheck(input({
    halted: true, haltReason: "foreign position detected",
    agentValidUntil: inDays(-1).getTime(), horizonAt: inDays(1),
  }));
  assert.ok(!v.approved && v.reason === "account-halted");
});

// ── Capacity (tasks/07) ────────────────────────────────────────────────────

// The veto sits inside `preTradeCheck` so there is one path and nothing routes around
// it — the placement `tasks/07` says is the part of the reference worth copying.
test("a market too quiet to leave is refused with a reason the user can read", () => {
  const v = preTradeCheck(input({ capacity: { book: deepBook(), volume24hUsd: 0 } }));
  assert.equal(v.approved, false);
  assert.ok(!v.approved && v.reason === "below-volume-floor");
});

test("a book too thin on the exit side is refused", () => {
  const thinBids = { bids: [{ px: "99.99", sz: "0.01" }], asks: deepBook().asks };
  const v = preTradeCheck(input({ side: "long", capacity: { book: thinBids, volume24hUsd: 50_000_000 } }));
  assert.equal(v.approved, false);
  assert.ok(!v.approved && v.reason === "thin-book");
});

// A book we cannot see is one we cannot promise to get back out of, and opening anyway
// is the failure this check exists to prevent.
test("a book we could not read refuses rather than opens", () => {
  const v = preTradeCheck(input({ capacity: null }));
  assert.equal(v.approved, false);
  assert.ok(!v.approved && v.detail.includes("could not read the order book"));
});

// It runs after the budget check, because it needs the margin to know the notional —
// and before the collateral floor, so the cheaper refusals still come first.
test("the capacity veto does not pre-empt a halt or a stale feed", () => {
  const dead = { book: { bids: [], asks: [] }, volume24hUsd: 0 };
  const reasonOf = (over: Partial<GovernorInput>) => {
    const v = preTradeCheck(input(over));
    return v.approved ? "approved" : v.reason;
  };
  assert.equal(reasonOf({ halted: true, haltReason: "x", capacity: dead }), "account-halted");
  assert.equal(reasonOf({ feedAgeSec: 999_999, capacity: dead }), "stale-feed");
});

// ── The five settings that are not the default (`tasks/46` §3.2) ───────────────────
//
// Until 2026-09-13 not one of the 23 tests above overrode `DEFAULT_USER_SETTINGS`, so
// every number this file pinned was 10x / 10% / 2% — on a desk where the accounts that
// carried the losses ran 20% and 25% per signal. `SETTINGS_CASES` says why each corner
// is in the list; `exec/loop.test.ts` runs the same five end to end.

for (const c of SETTINGS_CASES) {
  test(`the governor approves the per-signal budget at ${c.name}`, () => {
    const v = preTradeCheck(input({ settings: c.settings }));
    assert.ok(v.approved, `${c.why}: ${!v.approved && v.detail}`);
    // The one number the governor returns, derived rather than typed: the mandate less
    // the reserve, times the user's own share of it.
    assert.equal(cents(v.marginUsd), cents(1000 * (1 - RISK_PARAMS.reserveFrac) * c.settings.perSignalPct));
  });

  test(`the concurrency cap binds at floor(1 / perSignalPct) at ${c.name}`, () => {
    const n = maxConcurrentSignals(c.settings);
    const full = preTradeCheck(input({ settings: c.settings, allocation: alloc({ openCount: n }) }));
    assert.ok(!full.approved && full.reason === "max-concurrent", `${n} open: ${JSON.stringify(full)}`);
    const room = preTradeCheck(input({ settings: c.settings, allocation: alloc({ openCount: n - 1 }) }));
    assert.ok(room.approved, `${n - 1} open must still fit: ${!room.approved && room.detail}`);
  });
}

// The corner the desk actually met. At 25% per signal and 20x a single stopped-out
// position costs **9.9% of the mandate against a 10% daily cap** — `stopsToHalt` is
// 1.01, and the 0.01 is the 1% reserve. So the account that halted three times on
// 2026-09-10 sat one ordinary loss from the cap by arithmetic rather than by bad luck,
// and the second position does not need to reach its stop to finish the job: 0.1pp of
// adverse mark on anything open is enough.
test("one stopped-out position at 25% lands 0.1pp short of the daily cap", () => {
  const quarter = SETTINGS_CASES.find((c) => c.settings.perSignalPct === 0.25)!.settings;
  assert.ok(stopsToHalt(quarter) > 1 && stopsToHalt(quarter) < 1.05,
    `${stopsToHalt(quarter)} — this case is in the list because it is about one stop`);

  // Equity down by exactly what one stop costs the mandate, and no further.
  const oneStop = preTradeCheck(input({ settings: quarter, allocation: alloc({ equityNow: 1000 * (1 - stopOutOfMandate(quarter)) }) }));
  assert.ok(oneStop.approved, `9.9% is not yet 10%: ${!oneStop.approved && oneStop.detail}`);

  // A dollar further and the governor refuses as halted, naming the cap rather than
  // blaming a budget the account still has.
  const over = preTradeCheck(input({ settings: quarter, allocation: alloc({ equityNow: 1000 * (1 - RISK_PARAMS.dailyLossPct) }) }));
  assert.ok(!over.approved && over.reason === "account-halted", JSON.stringify(over));
  assert.match(!over.approved ? over.detail : "", /daily loss/);
});

// With the stop off, isolated margin is the whole protection and one position can lose
// all of its own margin — which at 10% per signal is the same 9.9% of the mandate the
// 25% case reaches through leverage. Two different settings, one arithmetic.
test("the stop off costs a whole margin, which is the same distance to the halt", () => {
  const noStop = SETTINGS_CASES.find((c) => !c.settings.stopLoss)!.settings;
  assert.equal(stopOutOfMargin(noStop), 1, "no stop means the venue's own liquidation is the bound");
  assert.equal(stopOutOfMandate(noStop), stopOutOfMandate(SETTINGS_CASES.find((c) => c.settings.perSignalPct === 0.25)!.settings));
});
