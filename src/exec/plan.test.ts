import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { LivePosition } from "../types.ts";
import type { IntentRow } from "../store/db.ts";
import type { Market } from "../mapping/intent.ts";
import { RISK_PARAMS } from "../risk/params.ts";
import { planIntent } from "./plan.ts";

const NVDA: Market = { coin: "xyz:NVDA", assetId: 110002, dex: "xyz", szDecimals: 3, maxLeverage: 20 };
const NOW = new Date("2026-08-30T12:00:00Z");
// The band the executor actually charges, read from the constant rather than typed
// (`tasks/46` §3.3). It was a literal `30` for the whole suite, so every assertion about
// where a limit sits kept passing if `slippageBps` moved.
const CTX = { now: NOW, markPx: 218.86, slippageBps: RISK_PARAMS.slippageBps };

const intent = (over: Partial<IntentRow> = {}): IntentRow => ({
  intent_id: randomUUID(), account: "0xacct", created_at: NOW.toISOString(), provider: "quotient",
  signal_ref: "po:x", signal_revision: 1, coin: "xyz:NVDA", side: "long",
  leverage: 10, margin_usd: 100, size_abs: 4.569, ref_px: 218.86,
  hold_to_target: 0, withdrawn_at: null, flipped_at: null, stopped_at: null,
  target_px: 230, stop_px: 212.3, horizon_at: "2026-08-31T20:00:00Z",
  rationale: "", status: "pending", entry_px: null, filled_sz: 0,
  closed_at: null, close_reason: null, realized_pnl: null,
  fee_usd: null, funding_usd: null, net_pnl: null, pnl_note: null, ...over,
});

const pos = (szi: number): LivePosition => ({
  coin: "xyz:NVDA", szi, entryPx: 218.86, marginUsed: 100, unrealizedPnl: 0, liquidationPx: 208, leverage: 10,
});

test("a pending intent with no position wants exactly one IOC entry", () => {
  const p = planIntent(intent(), null, NVDA, CTX);
  assert.equal(p.desired.length, 1);
  const e = p.desired[0]!;
  assert.equal(e.role, "entry");
  assert.equal(e.isBuy, true);
  assert.equal(e.ioc, true);
  assert.equal(e.reduceOnly, false);
  assert.ok(e.px > CTX.markPx, "a buy entry must be marketable, so priced above the mark");
  assert.ok(e.px < CTX.markPx * 1.005, "but only by the slippage allowance");
});

test("a short's entry is a marketable sell", () => {
  const p = planIntent(intent({ side: "short" }), null, NVDA, CTX);
  const e = p.desired[0]!;
  assert.equal(e.isBuy, false);
  assert.ok(e.px < CTX.markPx);
});

test("an open position wants a stop and a target, both reduce-only triggers", () => {
  const p = planIntent(intent({ status: "open", filled_sz: 4.569 }), pos(4.569), NVDA, CTX);
  const roles = p.desired.map((d) => d.role).sort();
  assert.deepEqual(roles, ["sl", "tp"]);
  for (const d of p.desired) {
    assert.equal(d.reduceOnly, true, `${d.role} must be reduce-only`);
    assert.equal(d.isBuy, false, `${d.role} on a long must be a sell`);
    assert.ok(d.triggerPx !== undefined, `${d.role} must be a trigger order, not a resting limit`);
    assert.equal(d.ioc, false);
  }
});

// The fix for the failure mode that cost OutcomeMaker 270 units: HL only attaches
// child TP/SL on a FULL parent fill, so a partial fill left open has no stop at all.
test("exits are sized to what actually filled, not to what we intended", () => {
  const p = planIntent(intent({ status: "open", size_abs: 4.569, filled_sz: 1.2 }), pos(1.2), NVDA, CTX);
  for (const d of p.desired) assert.equal(d.sz, 1.2, `${d.role} must cover the real position`);
  assert.ok(p.notes.some((n) => n.includes("partial fill")), p.notes.join("|"));
});

test("a stop's limit price is past its trigger, so it can actually fill", () => {
  const p = planIntent(intent({ status: "open" }), pos(4.569), NVDA, CTX);
  const sl = p.desired.find((d) => d.role === "sl")!;
  assert.ok(sl.px < sl.triggerPx!, "a long's stop sells below the trigger");
  assert.ok(sl.px > sl.triggerPx! * 0.99, "but the slippage cap is tight, not HL's 10% market tolerance");
});

test("a short's stop trigger is above entry and buys back above it", () => {
  const p = planIntent(intent({ side: "short", status: "open", stop_px: 225.4, target_px: 205 }), pos(-4.569), NVDA, CTX);
  const sl = p.desired.find((d) => d.role === "sl")!;
  assert.equal(sl.isBuy, true);
  assert.ok(sl.px > sl.triggerPx!);
});

test("stop off means no stop order and a note saying so", () => {
  const p = planIntent(intent({ status: "open", stop_px: null }), pos(4.569), NVDA, CTX);
  assert.deepEqual(p.desired.map((d) => d.role), ["tp"]);
  assert.ok(p.notes.some((n) => n.includes("user turned the stop off")));
});

// The time stop is not optional: the outlook expired, so the thesis did.
test("a passed horizon closes the position and stops wanting the exits", () => {
  const p = planIntent(
    intent({ status: "open", horizon_at: "2026-08-30T11:00:00Z" }), pos(4.569), NVDA, CTX,
  );
  assert.equal(p.closing, "horizon");
  assert.deepEqual(p.desired.map((d) => d.role), ["close"]);
  const c = p.desired[0]!;
  assert.equal(c.reduceOnly, true);
  assert.equal(c.ioc, true);
  assert.equal(c.sz, 4.569, "the close covers the whole position");
  assert.equal(c.isBuy, false);
});

test("a passed horizon before the entry filled abandons the entry rather than opening late", () => {
  const p = planIntent(intent({ horizon_at: "2026-08-30T11:00:00Z" }), null, NVDA, CTX);
  assert.deepEqual(p.desired, []);
  assert.equal(p.closing, "horizon");
});

test("a retired signal closes the position", () => {
  const p = planIntent(intent({ status: "open" }), pos(4.569), NVDA, { ...CTX, forceClose: "retired" });
  assert.equal(p.closing, "retired");
  assert.deepEqual(p.desired.map((d) => d.role), ["close"]);
});

test("an intent already marked closing keeps closing across restarts", () => {
  const p = planIntent(intent({ status: "closing", close_reason: "halt" }), pos(4.569), NVDA, CTX);
  assert.equal(p.closing, "halt");
  assert.deepEqual(p.desired.map((d) => d.role), ["close"]);
});

test("an open intent whose position is gone wants nothing", () => {
  const p = planIntent(intent({ status: "open", filled_sz: 4.569 }), null, NVDA, CTX);
  assert.deepEqual(p.desired, []);
});
