import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { DesiredOrder, LiveOrder, LivePosition } from "../types.ts";
import { makeCloid } from "../hl/cloid.ts";
import { orderActions, reconcile, type ReconcileInput } from "./reconcile.ts";

const ID = randomUUID();
const OTHER = randomUUID();
const szDecimalsFor = () => 3;

const want = (over: Partial<DesiredOrder> = {}): DesiredOrder => ({
  intentId: ID, role: "sl", coin: "xyz:NVDA", isBuy: false, sz: 4.569, px: 211.6,
  triggerPx: 212.3, reduceOnly: true, ioc: false, ...over,
});

const resting = (over: Partial<LiveOrder> = {}): LiveOrder => ({
  coin: "xyz:NVDA", oid: 1, cloid: makeCloid(ID, "sl"), isBuy: false, sz: 4.569,
  limitPx: 211.6, triggerPx: 212.3, isTrigger: true, reduceOnly: true, ...over,
});

const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
  desired: [], orders: [], positions: [], liveIntentIds: [ID], claimedCoins: ["xyz:NVDA"], szDecimalsFor, ...over,
});

test("a desired order with nothing resting is placed", () => {
  const r = reconcile(input({ desired: [want()] }));
  assert.deepEqual(r.actions, [{ kind: "place", order: want() }]);
});

test("a matching resting order produces no action at all — the loop is idempotent", () => {
  const r = reconcile(input({ desired: [want()], orders: [resting()] }));
  assert.deepEqual(r.actions, []);
});

test("a resting order the plan no longer wants is cancelled", () => {
  const r = reconcile(input({ desired: [], orders: [resting()] }));
  assert.equal(r.actions.length, 1);
  assert.ok(r.actions[0]!.kind === "cancel" && r.actions[0]!.reason === "unwanted");
});

test("a stop covering the wrong size is replaced, never left covering the wrong amount", () => {
  const r = reconcile(input({ desired: [want({ sz: 1.2 })], orders: [resting({ sz: 4.569 })] }));
  const kinds = r.actions.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ["cancel", "place"]);
  const cancel = r.actions.find((a) => a.kind === "cancel");
  assert.ok(cancel && cancel.kind === "cancel" && cancel.reason === "wrong-size");
});

test("a size difference below the lot is not churned", () => {
  // 3 decimals ⇒ anything under 0.0005 is the same order.
  const r = reconcile(input({ desired: [want({ sz: 4.5692 })], orders: [resting({ sz: 4.569 })] }));
  assert.deepEqual(r.actions, [], "re-placing on float noise would churn every loop");
});

test("a moved trigger price is replaced", () => {
  const r = reconcile(input({ desired: [want({ triggerPx: 215 })], orders: [resting({ triggerPx: 212.3 })] }));
  assert.ok(r.actions.some((a) => a.kind === "cancel" && a.reason === "wrong-trigger"));
  assert.ok(r.actions.some((a) => a.kind === "place"));
});

test("a duplicate order at the same role is cancelled once", () => {
  const r = reconcile(input({
    desired: [want()],
    orders: [resting({ oid: 1 }), resting({ oid: 2, cloid: makeCloid(ID, "sl") })],
  }));
  const cancels = r.actions.filter((a) => a.kind === "cancel");
  assert.equal(cancels.length, 1);
  assert.ok(cancels[0]!.kind === "cancel" && cancels[0]!.reason === "duplicate");
});

test("our own leftovers from a finished intent are cancelled, not halted on", () => {
  const r = reconcile(input({ desired: [], orders: [resting({ cloid: makeCloid(OTHER, "tp") })], liveIntentIds: [ID] }));
  assert.deepEqual(r.foreignOrders, []);
  assert.ok(r.actions[0]!.kind === "cancel" && r.actions[0]!.reason === "unwanted");
});

// docs/ACCOUNT-MODEL.md §1: two actors on one account cannot be reconciled, so we
// detect rather than defend. An untagged order is the user trading by hand.
test("an untagged order is reported as foreign and is NOT cancelled", () => {
  const hand = resting({ cloid: null, oid: 99 });
  const r = reconcile(input({ desired: [], orders: [hand] }));
  assert.deepEqual(r.foreignOrders, [hand]);
  assert.deepEqual(r.actions, [], "cancelling a user's own order is not ours to do");
});

test("an order tagged by something that is not us is foreign", () => {
  const r = reconcile(input({ orders: [resting({ cloid: "0x" + "ab".repeat(16) })] }));
  assert.equal(r.foreignOrders.length, 1);
});

test("a position no live intent claims is foreign", () => {
  const p: LivePosition = { coin: "BTC", szi: 0.01, entryPx: 78000, marginUsed: 78, unrealizedPnl: 0, liquidationPx: null, leverage: 10 };
  const r = reconcile(input({ positions: [p], claimedCoins: ["xyz:NVDA"] }));
  assert.deepEqual(r.foreignPositions, [p]);
});

test("a zero-size position entry is not mistaken for a foreign position", () => {
  const p: LivePosition = { coin: "BTC", szi: 0, entryPx: 0, marginUsed: 0, unrealizedPnl: 0, liquidationPx: null, leverage: 10 };
  assert.deepEqual(reconcile(input({ positions: [p], claimedCoins: [] })).foreignPositions, []);
});

test("a claimed position is not foreign", () => {
  const p: LivePosition = { coin: "xyz:NVDA", szi: 4.569, entryPx: 218, marginUsed: 100, unrealizedPnl: 0, liquidationPx: 208, leverage: 10 };
  assert.deepEqual(reconcile(input({ positions: [p] })).foreignPositions, []);
});

// A position with no stop resting against it is the state that cost 270 units.
test("stops and closes are actioned before targets, and entries last", () => {
  const ordered = orderActions([
    { kind: "place", order: want({ role: "entry", intentId: OTHER }) },
    { kind: "place", order: want({ role: "tp" }) },
    { kind: "place", order: want({ role: "sl" }) },
    { kind: "cancel", order: resting(), reason: "unwanted" },
    { kind: "cancel", order: resting(), reason: "wrong-size" },
  ]);
  assert.deepEqual(
    ordered.map((a) => (a.kind === "place" ? `place:${a.order.role}` : `cancel:${a.reason}`)),
    ["cancel:wrong-size", "place:sl", "place:tp", "cancel:unwanted", "place:entry"],
  );
});
