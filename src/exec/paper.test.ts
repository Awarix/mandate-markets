import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import type { DesiredOrder } from "../types.ts";
import type { Market } from "../mapping/intent.ts";
import { Store } from "../store/db.ts";
import { PaperBroker } from "./paper.ts";

const BTC: Market = { coin: "BTC", assetId: 0, dex: "", szDecimals: 5, maxLeverage: 40 };

function rig(mark = 78000) {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-paper-"));
  const store = new Store(join(dir, "db.sqlite"));
  const marks = new Map([["BTC", mark]]);
  const broker = new PaperBroker(store, () => marks, 1000, "0xpaper");
  return { store, marks, broker, dir, done: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const order = (over: Partial<DesiredOrder> = {}): DesiredOrder => ({
  intentId: randomUUID(), role: "entry", coin: "BTC", isBuy: false, sz: 0.01, px: 77766,
  reduceOnly: false, ioc: true, ...over,
});

test("an IOC entry fills and posts margin at the leverage we set, not the asset's max", async () => {
  const r = rig();
  try {
    await r.broker.ensureIsolated(BTC, 10);
    const res = await r.broker.place(order({ sz: 0.0128 }), BTC);
    assert.ok(res.ok && res.filledSz === 0.0128);
    const v = await r.broker.view();
    // 0.0128 x 78000 = $998.40 of notional; at 10x that is ~$100 of margin, not $25 at 40x.
    assert.ok(Math.abs(v.positions[0]!.marginUsed - 99.84) < 0.01, String(v.positions[0]!.marginUsed));
  } finally { r.done(); }
});

test("an IOC that the limit price cannot reach simply does not fill", async () => {
  const r = rig();
  try {
    const res = await r.broker.place(order({ isBuy: true, px: 70000 }), BTC);
    assert.ok(res.ok && res.filledSz === 0, "a buy limited below the market must not fill");
    assert.deepEqual((await r.broker.view()).positions, []);
  } finally { r.done(); }
});

// Without this, a stop and a target both triggering on one gap would close the
// position and then REOPEN it inverted — a state the real venue cannot reach.
test("a reduce-only order against a flat book is a no-op, never a new position", async () => {
  const r = rig();
  try {
    const res = await r.broker.place(order({ role: "close", isBuy: true, px: 99999, reduceOnly: true }), BTC);
    assert.ok(res.ok);
    assert.deepEqual((await r.broker.view()).positions, [], "reduce-only must not open anything");
  } finally { r.done(); }
});

test("a reduce-only order larger than the position closes it and no more", async () => {
  const r = rig();
  try {
    await r.broker.ensureIsolated(BTC, 10);
    await r.broker.place(order({ sz: 0.01 }), BTC);                                  // short 0.01
    await r.broker.place(order({ role: "close", isBuy: true, sz: 0.05, px: 99999, reduceOnly: true }), BTC);
    assert.deepEqual((await r.broker.view()).positions, [], "flat, not long 0.04");
  } finally { r.done(); }
});

test("both exits firing on one gap leaves the account flat, not reversed", async () => {
  const r = rig();
  try {
    const id = randomUUID();
    await r.broker.ensureIsolated(BTC, 10);
    await r.broker.place(order({ intentId: id, sz: 0.01 }), BTC);                    // short at 78000
    await r.broker.place(order({ intentId: id, role: "sl", isBuy: true, sz: 0.01, px: 80500, triggerPx: 80340, reduceOnly: true, ioc: false }), BTC);
    await r.broker.place(order({ intentId: id, role: "tp", isBuy: true, sz: 0.01, px: 72500, triggerPx: 72400, reduceOnly: true, ioc: false }), BTC);

    // A gap that crosses the stop above and leaves the target armed below.
    r.marks.set("BTC", 81000);
    const v = await r.broker.view();
    assert.deepEqual(v.positions, [], "the stop closed it");
    assert.ok(v.equityUsd < 1000, "and it was a loss");
    r.marks.set("BTC", 60000);
    assert.deepEqual((await r.broker.view()).positions, [], "the still-resting target must not open a long");
  } finally { r.done(); }
});

test("a short's stop fires on a rise and its target on a fall", async () => {
  for (const [mark, expectLoss] of [[81000, true], [72000, false]] as const) {
    const r = rig();
    try {
      const id = randomUUID();
      await r.broker.ensureIsolated(BTC, 10);
      await r.broker.place(order({ intentId: id, sz: 0.01 }), BTC);
      await r.broker.place(order({ intentId: id, role: "sl", isBuy: true, sz: 0.01, px: 80500, triggerPx: 80340, reduceOnly: true, ioc: false }), BTC);
      await r.broker.place(order({ intentId: id, role: "tp", isBuy: true, sz: 0.01, px: 72500, triggerPx: 72400, reduceOnly: true, ioc: false }), BTC);
      r.marks.set("BTC", mark);
      const v = await r.broker.view();
      assert.deepEqual(v.positions, [], `mark ${mark} should have closed it`);
      assert.equal(v.equityUsd < 1000, expectLoss, `mark ${mark}: equity ${v.equityUsd}`);
    } finally { r.done(); }
  }
});

test("a trigger that has not been crossed stays resting", async () => {
  const r = rig();
  try {
    const id = randomUUID();
    await r.broker.ensureIsolated(BTC, 10);
    await r.broker.place(order({ intentId: id, sz: 0.01 }), BTC);
    await r.broker.place(order({ intentId: id, role: "sl", isBuy: true, sz: 0.01, px: 80500, triggerPx: 80340, reduceOnly: true, ioc: false }), BTC);
    r.marks.set("BTC", 80339);
    const v = await r.broker.view();
    assert.equal(v.positions.length, 1);
    assert.equal(v.orders.length, 1);
  } finally { r.done(); }
});

test("the book survives being reopened from disk mid-position", async () => {
  const r = rig();
  try {
    await r.broker.ensureIsolated(BTC, 10);
    await r.broker.place(order({ sz: 0.01 }), BTC);
    const before = await r.broker.view();
    r.store.close();

    const store = new Store(join(r.dir, "db.sqlite"));
    const broker = new PaperBroker(store, () => r.marks, 1000, "0xpaper");
    const after = await broker.view();
    assert.deepEqual(after.positions, before.positions);
    assert.equal(after.equityUsd, before.equityUsd);
    store.close();
  } finally { rmSync(r.dir, { recursive: true, force: true }); }
});

// The paper book was global until 2026-08-31 — one `paper_cash` row and three tables
// keyed by coin alone. Two paper accounts in one ledger shared one simulated book,
// which is the same failure as two agents on one Hyperliquid account. These pin the
// isolation, because it is invisible until a second account exists.

test("two paper accounts in one ledger do not share a book", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-paper-2-"));
  const store = new Store(join(dir, "db.sqlite"));
  try {
    const marks = new Map([["BTC", 78000]]);
    const alice = new PaperBroker(store, () => marks, 1000, "0xalice");
    const bob = new PaperBroker(store, () => marks, 250, "0xbob");

    // Each starts with the capital it was given, not the other's.
    assert.equal(alice.cashEquity(), 1000);
    assert.equal(bob.cashEquity(), 250);

    await alice.ensureIsolated(BTC, 10);
    await alice.place(order({ isBuy: true, sz: 0.01, px: 79000 }), BTC);

    const av = await alice.view();
    const bv = await bob.view();
    assert.equal(av.positions.length, 1, "alice holds her own position");
    assert.equal(bv.positions.length, 0, "bob must not see it");
    assert.equal(bv.equityUsd, 250, "and it must not move his equity");

    // Bob's leverage choice must not reprice Alice's position either.
    await bob.ensureIsolated(BTC, 40);
    assert.equal((await alice.view()).positions[0]!.leverage, 10);

    // A resting trigger belongs to one book.
    await bob.place(order({ role: "sl", isBuy: false, sz: 0.005, px: 70000, triggerPx: 70000, reduceOnly: true }), BTC);
    assert.equal((await bob.view()).orders.length, 1);
    assert.equal((await alice.view()).orders.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("order ids stay unique across accounts sharing a ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-paper-oid-"));
  const store = new Store(join(dir, "db.sqlite"));
  try {
    const marks = new Map([["BTC", 78000]]);
    const alice = new PaperBroker(store, () => marks, 1000, "0xalice");
    const bob = new PaperBroker(store, () => marks, 1000, "0xbob");

    const oids: number[] = [];
    for (const b of [alice, bob, alice, bob]) {
      const r = await b.place(order({ role: "sl", triggerPx: 70000, reduceOnly: true }), BTC);
      assert.ok(r.ok && r.oid !== null);
      oids.push(r.oid!);
    }
    assert.equal(new Set(oids).size, oids.length, `oids collided: ${oids.join(",")}`);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
