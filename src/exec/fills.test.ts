import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { makeCloid } from "../hl/cloid.ts";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { Store, type FillRow, type FundingRow } from "../store/db.ts";
import {
  attributeFill, attributeFunding, exitFromFills, ingestAccount, settleClosed, settleIntent,
  shouldIngestFills, type AttributionMaps, type VenueFill, type VenueFunding,
} from "./fills.ts";

const ACCOUNT = "0xacc00001c53162712f3d8d10764b5e7b17d1c08a";

const maps = (over: Partial<AttributionMaps> = {}): AttributionMaps => ({
  inScope: (c) => c === "BTC" || c.startsWith("xyz:"),
  heldAt: () => null,
  cloidToIntent: new Map(),
  prefixToIntent: new Map(),
  oidToIntent: new Map(),
  ...over,
});

const venueFill = (over: Partial<VenueFill> = {}): VenueFill => ({
  coin: "xyz:COPPER", px: "6.7187", sz: "14.88", side: "B", time: 1_788_000_000_000,
  dir: "Open Long", closedPnl: "0.0", hash: "0xabc", oid: 999, crossed: true,
  fee: "0.008637", tid: 1, feeToken: "USDC", ...over,
});

const fill = (over: Partial<FillRow> = {}): FillRow => ({
  account: ACCOUNT, tid: 1, time: 1_788_000_000_000, coin: "xyz:COPPER", side: "B",
  dir: "Open Long", px: 6.7187, sz: 14.88, closed_pnl: 0, fee: 0.008637,
  fee_token: "USDC", crossed: 1, oid: 1, cloid: null, hash: null,
  intent_id: "i", attribution: "cloid", liquidation: null, ...over,
});

const fundingRow = (over: Partial<FundingRow> = {}): FundingRow => ({
  account: ACCOUNT, time: 1_788_000_000_000, coin: "xyz:COPPER", usdc: -0.000725,
  szi: 14.88, funding_rate: 0.00000625, intent_id: "i", ...over,
});

// ── attribution ────────────────────────────────────────────────────────────

test("a fill carrying our cloid is attributed by the exact order it filled", () => {
  const id = randomUUID();
  const cloid = makeCloid(id, "entry");
  const r = attributeFill(venueFill({ cloid }), maps({ cloidToIntent: new Map([[cloid, id]]) }));
  assert.deepEqual(r, { intentId: id, attribution: "cloid" });
});

// The process can die between `broker.place()` returning and `recordOrder()` writing.
// The tag is on the venue, so the intent is still recoverable without that row.
test("our cloid still finds its intent when the order row was never written", () => {
  const id = randomUUID();
  const prefix = id.replace(/-/g, "").slice(0, 16);
  const r = attributeFill(
    venueFill({ cloid: makeCloid(id, "sl") }),
    maps({ prefixToIntent: new Map([[prefix, id]]) }),
  );
  assert.deepEqual(r, { intentId: id, attribution: "cloid" });
});

// Ours-but-unplaceable is a hole in our bookkeeping, not a second actor. Halting the
// account for it would punish the owner for our own missing row.
test("a fill with our tag and no matching intent is still not foreign", () => {
  const r = attributeFill(venueFill({ cloid: makeCloid(randomUUID(), "tp") }), maps());
  assert.equal(r.attribution, "cloid");
  assert.equal(r.intentId, null);
});

test("a fill with no cloid falls back to the order id", () => {
  const r = attributeFill(venueFill({ oid: 42 }), maps({ oidToIntent: new Map([[42, "i-42"]]) }));
  assert.deepEqual(r, { intentId: "i-42", attribution: "oid" });
});

// The halt condition. Measured live: the owner of one managed account hand-traded
// HYPE, and the owner of another hand-traded PONS — neither fill carries a tag.
test("an untagged fill on a market we manage is foreign", () => {
  const r = attributeFill(venueFill({ coin: "BTC", oid: 7 }), maps());
  assert.deepEqual(r, { intentId: null, attribution: "foreign" });
});

// `userFillsByTime` returns spot fills and other dexes too. We never claimed to watch
// those, and halting a live account because its owner converted spot dust would be our
// fault rather than detection working.
test("a fill outside the dexes we read is out of scope, not foreign", () => {
  const r = attributeFill(venueFill({ coin: "@151", dir: "Spot Dust Conversion" }), maps());
  assert.equal(r.attribution, "out-of-scope");
});

// ── the arithmetic that touches money ──────────────────────────────────────

// Real numbers, from intent e84634ca on the live account, 2026-09-01: a long of 14.88
// xyz:COPPER opened at 6.7187 and closed at 6.5993. The ledger's estimate for this one
// was −$2.06.
test("net P&L reproduces a real live round trip", () => {
  const s = settleIntent(
    [
      fill({ tid: 1, dir: "Open Long", closed_pnl: 0, fee: 0.008637 }),
      fill({ tid: 2, dir: "Close Long", closed_pnl: -1.776672, fee: 0.008484, px: 6.5993 }),
    ],
    [fundingRow({ usdc: -0.000725 })],
  );
  assert.equal(s.grossUsd, -1.776672);
  assert.equal(s.feeUsd, 0.017121);
  assert.equal(s.fundingUsd, -0.000725);
  assert.equal(s.netUsd, -1.794518);
  assert.equal(s.note, null);
});

// The sign that is easiest to get backwards, and the only one that can be wrong in
// both directions. `usdc` is signed from the account's side: a short in a positive
// funding regime *receives*.
test("funding received is added, funding paid is subtracted", () => {
  const legs = [
    fill({ tid: 1, dir: "Open Short", closed_pnl: 0, fee: 0 }),
    fill({ tid: 2, dir: "Close Short", closed_pnl: 1, fee: 0 }),
  ];
  assert.equal(settleIntent(legs, [fundingRow({ usdc: 0.25 })]).netUsd, 1.25);
  assert.equal(settleIntent(legs, [fundingRow({ usdc: -0.25 })]).netUsd, 0.75);
});

// The SDK types a negative fee as a rebate. No live fill has produced one, maker fills
// included — so it is subtracted unconditionally, and a rebate adds back on its own
// rather than needing a branch that has never been exercised.
test("a fee is subtracted whatever its sign", () => {
  const legs = (fee: number) => [
    fill({ tid: 1, dir: "Open Long", closed_pnl: 0, fee: 0 }),
    fill({ tid: 2, dir: "Close Long", closed_pnl: 1, fee }),
  ];
  assert.equal(settleIntent(legs(0.1), []).netUsd, 0.9);
  assert.equal(settleIntent(legs(-0.1), []).netUsd, 1.1, "a rebate is a credit");
});

test("an intent with no attributed fills is flagged, not reported as zero", () => {
  const s = settleIntent([], []);
  assert.equal(s.netUsd, null);
  assert.match(s.note ?? "", /no venue fills/);
});

// Reporting −fee on a position that is still running would read as a small loss on a
// trade that has not happened yet.
test("an opening fill with no close has no net return to report", () => {
  const s = settleIntent([fill({ dir: "Open Long", fee: 0.5 })], []);
  assert.equal(s.netUsd, null);
  assert.equal(s.feeUsd, 0.5, "the cost is still known");
  assert.match(s.note ?? "", /never closed by us/);
});

test("a fee charged in something other than USDC is not silently treated as dollars", () => {
  const s = settleIntent(
    [fill({ tid: 1, dir: "Open Long" }), fill({ tid: 2, dir: "Close Long", closed_pnl: 1, fee_token: "USDH" })],
    [],
  );
  assert.match(s.note ?? "", /USDH/);
});

// ── funding windows ────────────────────────────────────────────────────────

function ledgerWith(intents: { id: string; coin: string; status: string }[]): Store {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(ACCOUNT, 100, DEFAULT_USER_SETTINGS, "live");
  for (const i of intents) {
    store.db.prepare(
      `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
        coin, side, leverage, margin_usd, size_abs, ref_px, horizon_at, rationale, status)
       VALUES (?, ?, '2026-09-01T00:00:00Z', 'quotient', 'ref', 1, ?, 'long', 10, 10, 1, 1,
        '2026-09-02T00:00:00Z', '', ?)`,
    ).run(i.id, ACCOUNT.toLowerCase(), i.coin, i.status);
  }
  return store;
}

// Funding belongs to no fill — it is charged hourly against whatever is open — so it
// has to be matched to the window an intent held the coin.
test("funding lands on the intent that held the coin at that hour", () => {
  const store = ledgerWith([
    { id: "first", coin: "xyz:NATGAS", status: "closed" },
    { id: "second", coin: "xyz:NATGAS", status: "closed" },
  ]);
  const hour = 3600_000;
  const t0 = 1_788_000_000_000;
  store.insertFill(fill({ tid: 1, intent_id: "first", coin: "xyz:NATGAS", time: t0, dir: "Open Long" }));
  store.insertFill(fill({ tid: 2, intent_id: "first", coin: "xyz:NATGAS", time: t0 + 2 * hour, dir: "Close Long" }));
  store.insertFill(fill({ tid: 3, intent_id: "second", coin: "xyz:NATGAS", time: t0 + 5 * hour, dir: "Open Long" }));
  store.insertFill(fill({ tid: 4, intent_id: "second", coin: "xyz:NATGAS", time: t0 + 7 * hour, dir: "Close Long" }));
  for (const h of [1, 6]) {
    store.insertFunding(fundingRow({ coin: "xyz:NATGAS", time: t0 + h * hour, usdc: -0.01, intent_id: null }));
  }
  // And one that belongs to neither — charged in the gap between them.
  store.insertFunding(fundingRow({ coin: "xyz:NATGAS", time: t0 + 3 * hour, usdc: -0.01, intent_id: null }));

  assert.equal(attributeFunding(store, ACCOUNT), 2);
  assert.equal(store.fundingFor("first").length, 1);
  assert.equal(store.fundingFor("second").length, 1);
  const orphan = store.db.prepare("SELECT COUNT(*) AS n FROM funding WHERE intent_id IS NULL").get() as { n: number };
  assert.equal(orphan.n, 1, "funding while we held nothing stays unattributed");
  store.close();
});

// A live intent has no closing fill yet, so its window has to stay open — otherwise
// funding on an open position is never attributed at all.
test("an open intent's window runs to now, not to its last fill", () => {
  const store = ledgerWith([{ id: "live", coin: "BTC", status: "open" }]);
  const t0 = 1_788_000_000_000;
  store.insertFill(fill({ tid: 1, intent_id: "live", coin: "BTC", time: t0, dir: "Open Long" }));
  store.insertFunding(fundingRow({ coin: "BTC", time: t0 + 3600_000, usdc: 0.01, intent_id: null }));
  assert.equal(attributeFunding(store, ACCOUNT, new Date(t0 + 2 * 3600_000)), 1);
  store.close();
});

// ── the ingester ───────────────────────────────────────────────────────────

function fakeInfo(fills: VenueFill[], funding: VenueFunding[] = []) {
  return {
    userFillsByTime: async ({ startTime }: { startTime: number }) => fills.filter((f) => f.time >= startTime),
    userFunding: async ({ startTime }: { startTime: number }) => funding.filter((f) => f.time >= startTime),
  } as never;
}

const universe = { resolve: (c: string) => (c === "BTC" || c.startsWith("xyz:") ? {} : null) } as never;

const ingestDeps = (store: Store, info: ReturnType<typeof fakeInfo>) => ({
  info, store, universe, master: ACCOUNT, log: () => {}, notify: async () => undefined,
});

// The first pass over an account is a backfill of trades that predate us watching.
// Halting on those would re-halt every account whose owner ever hand-traded — on the
// live ledger, two of four — for halts an operator has already cleared.
test("a backfill records foreign fills and halts nothing", async () => {
  const store = ledgerWith([]);
  const r = await ingestAccount(ingestDeps(store, fakeInfo([venueFill({ coin: "BTC", tid: 5, time: Date.now() })])));
  assert.equal(r.backfill, true);
  assert.equal(r.newForeign, 0);
  assert.equal(r.fills, 1);
  assert.equal(store.account(ACCOUNT)?.halted, 0);
  store.close();
});

// Once there is a watermark, a foreign fill is a second actor arriving — including one
// that opened and closed inside a single tick, which the position-level check cannot
// see at all.
test("a foreign fill after the watermark halts the account", async () => {
  const store = ledgerWith([]);
  const t = Date.now();
  const info = fakeInfo([venueFill({ coin: "BTC", tid: 5, time: t })]);
  await ingestAccount(ingestDeps(store, info));

  const later = fakeInfo([
    venueFill({ coin: "BTC", tid: 5, time: t }),
    venueFill({ coin: "BTC", tid: 6, time: t + 1000 }),
  ]);
  const r = await ingestAccount(ingestDeps(store, later));
  assert.equal(r.newForeign, 1);
  assert.equal(store.account(ACCOUNT)?.halted, 1);
  assert.match(store.account(ACCOUNT)?.halt_reason ?? "", /not placed by us/);
  store.close();
});

// Re-reading the same window must be free: the process restarts, and HL returns fills
// at or after `startTime` inclusive.
test("ingesting twice inserts nothing the second time", async () => {
  const store = ledgerWith([]);
  const info = fakeInfo([venueFill({ coin: "xyz:COPPER", tid: 5, cloid: undefined, time: Date.now() })]);
  await ingestAccount(ingestDeps(store, info));
  const second = await ingestAccount(ingestDeps(store, info));
  assert.equal(second.fills, 0);
  store.close();
});

// The whole point of the table: a closed intent gets a number that includes what it
// cost, alongside the estimate rather than over it.
test("a closed intent is settled from its fills, and the estimate survives", async () => {
  const store = ledgerWith([{ id: "i1", coin: "xyz:COPPER", status: "closed" }]);
  store.db.prepare("UPDATE intents SET realized_pnl = -2.06, closed_at = '2026-09-01T15:39:13Z' WHERE intent_id = 'i1'").run();
  store.insertFill(fill({ tid: 1, intent_id: "i1", dir: "Open Long", closed_pnl: 0, fee: 0.008637 }));
  store.insertFill(fill({ tid: 2, intent_id: "i1", dir: "Close Long", closed_pnl: -1.776672, fee: 0.008484 }));
  assert.equal(settleClosed(store, ACCOUNT), 1);

  const row = store.intent("i1")!;
  assert.equal(row.net_pnl, -1.793793);
  assert.equal(row.fee_usd, 0.017121);
  assert.equal(row.realized_pnl, -2.06, "the estimate is not overwritten");
  assert.equal(settleClosed(store, ACCOUNT), 0, "settling again is a no-op");
  store.close();
});

// ── why it closed, read from the venue ─────────────────────────────────────
//
// The bug these cover cost nothing in money and everything in interpretation: six
// live trades hit their take-profit and were shown to their owner as "the forecast
// was withdrawn", and because all of the profit sat in those six, retirement looked
// like the profitable exit. `notes/2026-09-02-close-reason-misattributed.md`.

test("a take-profit that closed the whole position is a target, whatever the plan said", () => {
  const id = randomUUID();
  const r = exitFromFills([
    fill({ tid: 1, coin: "xyz:NATGAS", dir: "Open Short", cloid: makeCloid(id, "entry") }),
    fill({ tid: 2, coin: "xyz:NATGAS", dir: "Close Short", cloid: makeCloid(id, "tp") }),
  ]);
  assert.equal(r, "target");
});

test("a stop that closed the whole position is a stop", () => {
  const id = randomUUID();
  const r = exitFromFills([
    fill({ tid: 1, dir: "Open Long", cloid: makeCloid(id, "entry") }),
    fill({ tid: 2, dir: "Close Long", cloid: makeCloid(id, "sl") }),
  ]);
  assert.equal(r, "stop");
});

// A `close` order is placed for a horizon, a retirement and a halt alike, so the
// venue cannot say which — only the plan can, and this must not guess.
test("an IOC close says nothing about why, and does not overrule the plan", () => {
  const id = randomUUID();
  const r = exitFromFills([
    fill({ tid: 1, dir: "Open Long", cloid: makeCloid(id, "entry") }),
    fill({ tid: 2, dir: "Close Long", cloid: makeCloid(id, "close") }),
  ]);
  assert.equal(r, null);
});

// The partial the note left undecided. Both things are true; the one that finished
// the job is the plan's, so the plan keeps the label.
test("a partial take-profit finished off by a retirement is not a target", () => {
  const id = randomUUID();
  const r = exitFromFills([
    fill({ tid: 1, dir: "Open Long", sz: 10, cloid: makeCloid(id, "entry") }),
    fill({ tid: 2, dir: "Close Long", sz: 4, cloid: makeCloid(id, "tp") }),
    fill({ tid: 3, dir: "Close Long", sz: 6, cloid: makeCloid(id, "close") }),
  ]);
  assert.equal(r, null);
});

test("an untagged closing fill makes the exit ambiguous rather than ours", () => {
  const id = randomUUID();
  const r = exitFromFills([
    fill({ tid: 1, dir: "Open Long", cloid: makeCloid(id, "entry") }),
    fill({ tid: 2, dir: "Close Long", cloid: null }),
  ]);
  assert.equal(r, null);
});

test("an intent still open has no exit to read", () => {
  const id = randomUUID();
  assert.equal(exitFromFills([fill({ tid: 1, dir: "Open Long", cloid: makeCloid(id, "entry") })]), null);
});

// The re-derive: the reason is corrected on a later pass, for an intent whose money
// settled long ago. That is why the correction sits outside the `unchanged` guard.
test("settling corrects a close reason the plan got wrong, after the P&L is already final", () => {
  const store = ledgerWith([{ id: "i1", coin: "xyz:NATGAS", status: "closed" }]);
  store.db.prepare("UPDATE intents SET close_reason = 'retired', closed_at = '2026-09-01T15:39:13Z' WHERE intent_id = 'i1'").run();
  store.insertFill(fill({ tid: 1, coin: "xyz:NATGAS", intent_id: "i1", dir: "Open Short", cloid: makeCloid("i1000000-0000-4000-8000-000000000000", "entry"), closed_pnl: 0 }));
  store.insertFill(fill({ tid: 2, coin: "xyz:NATGAS", intent_id: "i1", dir: "Close Short", cloid: makeCloid("i1000000-0000-4000-8000-000000000000", "tp"), closed_pnl: 0.8 }));

  assert.equal(settleClosed(store, ACCOUNT), 1);
  assert.equal(store.intent("i1")!.close_reason, "target");
  assert.equal(settleClosed(store, ACCOUNT), 0, "correcting again is a no-op");
  store.close();
});

// ── the liquidation, which is the 2026-09-10 event replayed ─────────────────
//
// One fill produced three wrong answers: the account halted saying it had a second
// actor that does not exist, the ledger recorded `retired`, and nothing attributed the
// fill to an intent — so a −$15.75 trip settled to NULL and went on reading its own
// −$11.36 estimate. `notes/2026-09-10-liquidation-and-the-stop-that-did-not-fill.md`.
//
// The numbers below are the venue's own, from `data/snap-0912.sqlite`: `xyz:COPPER`
// long, 87.66 units, entry 6.8129 on a 0.051599 fee, closed at 6.6332 for −15.752502 on
// a 0.050238 fee with −0.004655 of funding charged across the half hour it was held —
// and the object we used to ingest past.

const LIQUIDATION = { liquidatedUser: ACCOUNT, markPx: "6.6372", method: "market" };
const LIQ_TIME = 1_789_034_921_570;
const OPEN_TIME = LIQ_TIME - 1_829_570;

const liquidationFill = (over: Partial<VenueFill> = {}): VenueFill => venueFill({
  coin: "xyz:COPPER", tid: 583_629_333_754_119, time: LIQ_TIME, side: "A", dir: "Close Long",
  px: "6.6332", sz: "87.66", closedPnl: "-15.752502", fee: "0.050238", cloid: undefined,
  liquidation: LIQUIDATION, ...over,
});

test("a liquidation is the venue's own close, not a second actor, and it finds its intent", () => {
  const r = attributeFill(liquidationFill(), maps({ heldAt: () => "290e70da" }));
  assert.deepEqual(r, { intentId: "290e70da", attribution: "liquidation" });
});

// The field is what says so. `method` is the venue's enum and we have seen exactly one
// value of it, so asserting on the string would be guessing at a range nobody gave us.
test("an untagged fill with no liquidation object is still foreign", () => {
  assert.equal(attributeFill(liquidationFill({ liquidation: null }), maps()).attribution, "foreign");
  assert.equal(attributeFill(liquidationFill({ liquidation: undefined }), maps()).attribution, "foreign");
  assert.equal(
    attributeFill(liquidationFill({ liquidation: { method: "backstop" } }), maps({ heldAt: () => "i" })).attribution,
    "liquidation",
    "a method we have never seen is still a liquidation",
  );
});

test("a liquidated position closes as `liquidated`, whatever else filled", () => {
  const liq = fill({ tid: 2, dir: "Close Long", cloid: null, liquidation: JSON.stringify(LIQUIDATION) });
  assert.equal(exitFromFills([fill({ tid: 1, dir: "Open Long" }), liq]), "liquidated");

  // The one exit that does not have to be unambiguous. A take-profit that closed part
  // of a position beside a liquidation that took the rest reports the liquidation:
  // there is no reading under which the position was not liquidated, and reporting
  // null would put it back in the column it was invisible in.
  const tp = fill({ tid: 3, dir: "Close Long", cloid: makeCloid(randomUUID(), "tp") });
  assert.equal(exitFromFills([tp, liq]), "liquidated");
  assert.equal(exitFromFills([tp]), "target", "and an ordinary partial exit is unchanged");
});

test("a liquidation is a closing fill, so the trip settles instead of reading `never closed by us`", () => {
  const s = settleIntent([
    fill({ tid: 1, dir: "Open Long", closed_pnl: 0, fee: 0.051599 }),
    fill({ tid: 2, dir: "Close Long", cloid: null, closed_pnl: -15.752502, fee: 0.050238,
      liquidation: JSON.stringify(LIQUIDATION) }),
  ], [fundingRow({ usdc: -0.004655 })]);
  assert.equal(s.grossUsd, -15.752502);
  assert.equal(s.feeUsd, 0.101837);
  assert.equal(s.fundingUsd, -0.004655);
  // The truth, against the −11.36 estimate the board has been quoting: a gap of $4.50,
  // and in the direction `tasks/08` predicted rather than the one the 2026-09-02
  // measurement found — because the omitted term here is not a slippage band we never
  // paid, it is a close we never made.
  assert.equal(s.netUsd, -15.858994);
  assert.equal(s.note, null, "nothing about this trip is unexplained");
});

/** The ledger as it stood on 2026-09-10: an intent recorded `retired` with an estimate
 *  and no settled result, and its closing fill stored as somebody else's. */
function ledgerAfterTheLiquidation(): Store {
  const store = ledgerWith([{ id: "290e70da", coin: "xyz:COPPER", status: "closed" }]);
  store.db.prepare(
    "UPDATE intents SET close_reason = 'retired', realized_pnl = -11.36, " +
    "closed_at = ?, entry_px = 6.8129, filled_sz = 87.66 WHERE intent_id = '290e70da'",
  ).run(new Date(LIQ_TIME + 16_694).toISOString());
  store.insertFill(fill({
    tid: 1, intent_id: "290e70da", coin: "xyz:COPPER", time: OPEN_TIME, dir: "Open Long",
    px: 6.8129, sz: 87.66, closed_pnl: 0, fee: 0.051599, cloid: "0x5d0101290e70da00",
  }));
  store.insertFunding(fundingRow({
    coin: "xyz:COPPER", time: OPEN_TIME + 1_000, usdc: -0.004655, szi: 87.66, intent_id: "290e70da",
  }));
  // As it was ingested before the column existed: no liquidation, no intent, `foreign`.
  store.insertFill(fill({
    tid: 583_629_333_754_119, intent_id: null, attribution: "foreign", coin: "xyz:COPPER",
    time: LIQ_TIME, side: "A", dir: "Close Long", px: 6.6332, sz: 87.66,
    closed_pnl: -15.752502, fee: 0.050238, cloid: null,
  }));
  store.setWatermark(ACCOUNT, "fills", LIQ_TIME);
  return store;
}

// The repair, and the reason the rescan exists: a liquidation is far behind the
// watermark by the time the column ships, so resuming normally would fix nothing.
test("the first pass after the column ships repairs the row the board was wrong by", async () => {
  const store = ledgerAfterTheLiquidation();
  const before = store.db.prepare("SELECT net_pnl, close_reason FROM intents WHERE intent_id = '290e70da'")
    .get() as { net_pnl: number | null; close_reason: string };
  assert.equal(before.net_pnl, null, "before: the trip had no settled result at all");
  assert.equal(before.close_reason, "retired");

  const r = await ingestAccount(ingestDeps(store, fakeInfo([liquidationFill()])));
  assert.equal(r.rescanned, true);
  assert.equal(r.fills, 0, "nothing new — every row was already there");
  assert.equal(r.newLiquidations, 0, "a repair is not news, so it must not re-halt");
  assert.equal(store.account(ACCOUNT)?.halted, 0);

  const row = store.db.prepare("SELECT attribution, intent_id, liquidation FROM fills WHERE tid = ?")
    .get(583_629_333_754_119) as { attribution: string; intent_id: string; liquidation: string };
  assert.equal(row.attribution, "liquidation");
  assert.equal(row.intent_id, "290e70da");
  assert.deepEqual(JSON.parse(row.liquidation), LIQUIDATION);

  const after = store.db.prepare("SELECT net_pnl, close_reason, realized_pnl FROM intents WHERE intent_id = '290e70da'")
    .get() as { net_pnl: number; close_reason: string; realized_pnl: number };
  assert.equal(after.close_reason, "liquidated");
  assert.equal(after.net_pnl, -15.858994, "the ≈$16 the board was wrong by, settled");
  assert.equal(after.realized_pnl, -11.36, "and the estimate is kept beside it, as it always is");
  store.close();
});

test("the rescan runs once per account and then resumes from the watermark", async () => {
  const store = ledgerAfterTheLiquidation();
  const info = fakeInfo([liquidationFill()]);
  assert.equal((await ingestAccount(ingestDeps(store, info))).rescanned, true);
  assert.equal((await ingestAccount(ingestDeps(store, info))).rescanned, false);
  store.close();
});

// A liquidation that happens while we are watching halts the account — that part was
// always right. What changes is the sentence, which used to send an operator looking
// for a person who does not exist.
test("a liquidation after the watermark halts under its own name, not the second actor's", async () => {
  const store = ledgerWith([{ id: "290e70da", coin: "xyz:COPPER", status: "open" }]);
  store.insertFill(fill({ tid: 1, intent_id: "290e70da", coin: "xyz:COPPER", time: OPEN_TIME, dir: "Open Long" }));
  await ingestAccount(ingestDeps(store, fakeInfo([])));          // a watermark exists

  const r = await ingestAccount(ingestDeps(store, fakeInfo([liquidationFill()])));
  assert.equal(r.newLiquidations, 1);
  assert.equal(r.newForeign, 0, "it is not a foreign fill and must not be counted as one");
  assert.equal(store.account(ACCOUNT)?.halted, 1);
  const reason = store.account(ACCOUNT)?.halt_reason ?? "";
  assert.match(reason, /Hyperliquid liquidated/);
  assert.doesNotMatch(reason, /second actor and our position accounting/);
  store.close();
});

// ── tasks/51: the ingest a close cannot wait for ────────────────────────────────────
//
// `blockReentryAfterStop` reads `close_reason = 'stop'`, and on a live account the
// only thing that ever writes that value is `exitFromFills`, from this ingest.
// `settleLedger` records every venue-side trigger exit as `retired` — it has nothing
// to read it off, because our `orders` row is stamped once at placement and HL cancels
// the sibling trigger the moment the position goes. So on the slow cycle alone the
// guard is blind for up to `fillIngestSec` after a stop while the loop comes round
// every `loopIntervalSec`, and the desk re-enters the market that stopped it out.
//
// Measured on the live ledger 2026-09-14: 22 of 22 post-stop re-entries since the
// guard shipped on 09-11 landed 73–193s after their own stop, and all 19 refusals came
// at 202s or more. The guard only ever won when the ingest happened to land first.

const INGEST_MS = RISK_PARAMS.fillIngestSec * 1000;

test("a close ingests immediately, however recently the last one ran", () => {
  assert.equal(shouldIngestFills("live", true, 0), true);
  assert.equal(shouldIngestFills("live", true, 1000), true);
});

test("without a close it is the slow cycle, unchanged", () => {
  assert.equal(shouldIngestFills("live", false, INGEST_MS - 1), false);
  assert.equal(shouldIngestFills("live", false, INGEST_MS), true);
});

// The window the fix closes, stated as the two constants that opened it.
test("a loop interval after a close is inside the ingest interval, and that was the hole", () => {
  const oneLoop = RISK_PARAMS.loopIntervalSec * 1000;
  assert.ok(oneLoop < INGEST_MS, "if this stops being true the argument above changes");
  assert.equal(shouldIngestFills("live", false, oneLoop), false, "the old condition, at the tick that re-entered");
  assert.equal(shouldIngestFills("live", true, oneLoop), true, "the new one, at the tick that closed");
});

// A paper account has no venue fills, so ingesting one would flag every simulated trip
// as an unattributable mystery. A close does not change that.
test("paper never ingests, close or no close", () => {
  for (const closed of [true, false]) {
    assert.equal(shouldIngestFills("paper", closed, INGEST_MS * 10), false);
  }
});

// And the dependency itself, end to end: the guard cannot see a stop until this module
// has named it one. This is the live shape and `loop.test.ts` cannot produce it — the
// paper broker stamps its own fired trigger `filled`, so `settleLedger` reads the exit
// off our orders table and records `stop` directly. A real venue never updates that row.
test("a venue-side stop is invisible to blockReentryAfterStop until the ingest names it", () => {
  const store = ledgerWith([{ id: "0a8c7932", coin: "xyz:COPPER", status: "closed" }]);
  const closedAt = "2026-09-14T12:38:51.334Z";
  const at = new Date(closedAt);
  // What `settleLedger` writes for a trigger exit it cannot attribute, verbatim.
  store.db.prepare("UPDATE intents SET close_reason = 'retired', closed_at = ? WHERE intent_id = '0a8c7932'")
    .run(closedAt);
  assert.equal(store.stoppedOutToday(ACCOUNT, "xyz:COPPER", "long", at), false,
    "this is the hole: the desk re-enters here, and did, eight times on 2026-09-14");

  // The venue's own row for the same exit — our `sl` cloid on a closing fill.
  const closing = fill({
    tid: 2, intent_id: "0a8c7932", coin: "xyz:COPPER", side: "A", dir: "Close Long",
    px: 6.3868, sz: 6.42, closed_pnl: -0.83, cloid: makeCloid("0a8c7932-0000-4000-8000-000000000000", "sl"),
  });
  assert.equal(exitFromFills([closing]), "stop");
  store.setCloseReason("0a8c7932", "stop");
  assert.equal(store.stoppedOutToday(ACCOUNT, "xyz:COPPER", "long", at), true);
  store.close();
});
