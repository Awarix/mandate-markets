import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { InfoClient } from "@nktkas/hyperliquid";
import type { PerpsSeries } from "../signals/types.ts";
import { CAPTURES, directionalSeries } from "../signals/captures.ts";
import type { Snapshot } from "../signals/source.ts";
import { Universe } from "../hl/universe.ts";
import { makeCloid } from "../hl/cloid.ts";
import {
  DEFAULT_USER_SETTINGS, maxConcurrentSignals, minFundedForLiveUsd, RISK_PARAMS, type UserSettings,
} from "../risk/params.ts";
import { stopOutOfMargin, stopsToHalt } from "../risk/halt.ts";
import { SETTINGS_CASES } from "../risk/settings-cases.ts";
import { clampStopPct, maxStopPct } from "../risk/sizing.ts";
import { cents, maxDeployedUsd } from "../risk/ledger.ts";
import { Store, type IntentRow, type OrderRow } from "../store/db.ts";
import { WebStore } from "../web/sessions.ts";
import { serviceChangeRequests } from "./change-queue.ts";
import { PaperBroker } from "./paper.ts";
import { cancelOurRestingOrders, leftOnTheStopSide, tick, type LoopDeps } from "./loop.ts";

// End-to-end lifecycle, driven through the real loop with a paper broker and a
// scripted price series. This is the test the Phase 1 gate is actually about:
// signal → intent → entry → venue-side stop and target → close → clean ledger,
// with a forced restart in the middle.

const MASTER = "0xaccount";
/** BTC's spot on the 2026-08-30 capture, which is what the marks below are set to. */
const SPOT = 78_083.5;

/** Live HL metadata, 2026-08-30: BTC is asset 0, szDecimals 5, 40x. */
const FAKE_INFO = {
  perpDexs: async () => [null, { name: "xyz" }],
  meta: async (p?: { dex?: string }) =>
    p?.dex === "xyz"
      ? { universe: [{ name: "xyz:NVDA", szDecimals: 3, maxLeverage: 20, marginTableId: 20 }], marginTables: [], collateralToken: 0 }
      // BTC plus four more so a book can actually be filled: `tasks/21` needs four
      // positions open at once, and one coin can only ever hold one.
      : {
        universe: [
          { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
          { name: "ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 56 },
          { name: "SOL", szDecimals: 2, maxLeverage: 20, marginTableId: 56 },
          { name: "DOGE", szDecimals: 2, maxLeverage: 10, marginTableId: 56 },
          { name: "AVAX", szDecimals: 2, maxLeverage: 10, marginTableId: 56 },
        ],
        marginTables: [], collateralToken: 0,
      },
} as unknown as InfoClient;

/** The harness's signal: a −2.57σ short on BTC, anchored 24 hours out.
 *
 *  **Constructed, never found** (`tasks/46` §3.1). It used to be
 *  `crypto:btc:price-outlook:next-day` taken from the 08-30 capture, which was a −2.57σ
 *  short there and is neutral at +0.00σ twelve days later — so every lifecycle test
 *  below opened its position on whichever series happened to be directional at 09:40Z
 *  on a Saturday, and a feed change would have failed all of them for a reason that has
 *  nothing to do with the loop. The numbers are the capture's; the shape is the test's.
 *  `src/signals/captures.ts` builds it and keeps the vendor's identity
 *  `displacement_sigma = ln(median/ref) / sigma_diffusive` true, which the live re-gate
 *  in `loop.ts` recomputes. */
function btcSeries(now: Date, hoursAhead = 24): PerpsSeries {
  return directionalSeries({ sigmas: -2.57, spot: SPOT, now, hoursAhead });
}

/** That same signal, on another market — used to fill a book, which needs more signals
 *  than one. `resolution_reference.symbol` is what the mapper reads, so a distinct
 *  symbol and `outlook_id` make a distinct tradeable signal. */
function seriesOn(now: Date, coin: string, n: number): PerpsSeries {
  return directionalSeries({
    sigmas: -2.57, spot: SPOT, now, coin,
    seriesId: `test:${coin.toLowerCase()}:price-outlook:next-day`,
    outlookId: `po:test:${coin.toLowerCase()}:price-outlook:next-day-${n}:2026-08-31:07a8a1be7f379196:0fad777dc6bc7895`,
  });
}

type Harness = {
  deps: LoopDeps;
  store: Store;
  marks: Map<string, number>;
  setNow: (d: Date) => void;
  setSnapshot: (s: Snapshot | null, fresh?: boolean) => void;
  logs: string[];
  dir: string;
};

async function harness(
  now: Date,
  opts: { series?: PerpsSeries[]; baseCapital?: number; settings?: UserSettings } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-test-"));
  const store = new Store(join(dir, "db.sqlite"));
  const universe = await Universe.load(FAKE_INFO);
  const marks = new Map<string, number>([["BTC", SPOT]]);
  const baseCapital = opts.baseCapital ?? 1000;
  const settings = opts.settings ?? DEFAULT_USER_SETTINGS;
  store.connectAccount(MASTER, baseCapital, settings, "paper", now);
  const broker = new PaperBroker(store, () => marks, baseCapital, MASTER);
  const logs: string[] = [];
  const deps: LoopDeps = {
    store, master: MASTER, universe, settings, baseCapital, broker,
    refreshMarks: async () => {},
    // A book deep enough that the capacity veto never binds here: these tests are about
    // lifecycle, and `capacity.test.ts` is about the veto.
    readDepth: async () => ({
      book: {
        bids: Array.from({ length: 20 }, (_, i) => ({ px: String(78000 - i), sz: "1000" })),
        asks: Array.from({ length: 20 }, (_, i) => ({ px: String(78001 + i), sz: "1000" })),
      },
      volume24hUsd: 5_000_000_000,
    }),
    snapshot: { at: now, polledAt: now, series: opts.series ?? [btcSeries(now)], source: "test" },
    fresh: true,
    feedAgeSec: 0,
    globalHalt: { halted: false, reason: "" },
    // Paper: there is no agent, so there is no approval to expire.
    agentValidUntil: null,
    now,
    log: (m) => logs.push(m),
    notify: async () => true,
  };
  return {
    deps, store, marks, logs, dir,
    setNow: (d) => { deps.now = d; },
    setSnapshot: (s, fresh = true) => { deps.snapshot = s; deps.fresh = fresh; },
  };
}

const NOW = new Date("2026-08-30T10:00:00Z");
const cleanup = (h: Harness) => { h.store.close(); rmSync(h.dir, { recursive: true, force: true }); };

test("a signal becomes an intent, an entry, and a venue-side stop and target", async () => {
  const h = await harness(NOW);
  try {
    const t1 = await tick(h.deps);
    assert.equal(t1.opened, 1, "one intent from the one series that clears the gate");
    assert.equal(t1.placed, 3, "the entry, and its stop and target, in the same tick");

    const intents = h.store.liveIntents(MASTER);
    assert.equal(intents.length, 1);
    const i = intents[0]!;
    assert.equal(i.coin, "BTC");
    assert.equal(i.side, "short");
    assert.equal(i.status, "open", "the IOC entry filled, so the intent is open");
    assert.equal(cents(i.margin_usd), cents(DEFAULT_USER_SETTINGS.perSignalPct * 1000 * (1 - RISK_PARAMS.reserveFrac)),
      "the per-signal share of the $1,000 frozen base, less the reserve");
    assert.ok(i.stop_px !== null && i.stop_px > i.entry_px!, "a short's stop sits above entry");
    assert.ok(i.target_px !== null && i.target_px < i.entry_px!, "and its target below");

    // The exits are on the venue before this tick returns. They used to wait for the
    // next one, which on the live 60s loop left a 20x position with no venue-side stop
    // for 63 measured seconds (`notes/2026-09-05-tasks-15-18-19-21-live-check.md` §2).
    const view = await h.deps.broker.view();
    assert.equal(view.orders.length, 2, "stop and target resting already");
    for (const o of view.orders) {
      assert.equal(o.isTrigger, true, "exits live on the venue as trigger orders, not in our loop");
      assert.equal(o.reduceOnly, true);
      assert.equal(o.sz, Math.abs(view.positions[0]!.szi), "sized to what actually filled");
    }

    // And the next tick is a no-op: the exits are already there, so nothing is
    // re-placed and nothing is cancelled.
    const t2 = await tick(h.deps);
    assert.equal(t2.placed, 0, "nothing left to place");
    assert.equal(t2.cancelled, 0, "and nothing to undo");
  } finally { cleanup(h); }
});

test("the loop is idempotent — a second tick against an unchanged venue does nothing", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const t3 = await tick(h.deps);
    assert.equal(t3.opened, 0, "the same outlook must not open a second position");
    assert.equal(t3.placed, 0);
    assert.equal(t3.cancelled, 0);
  } finally { cleanup(h); }
});

test("the stop fires on the venue and the close is attributed to the stop", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;

    // Short BTC: the mark runs up through the stop.
    h.marks.set("BTC", i.stop_px! + 50);
    const t = await tick(h.deps);
    assert.equal(t.closed, 1);

    const closed = h.store.intent(i.intent_id)!;
    assert.equal(closed.status, "closed");
    assert.equal(closed.close_reason, "stop");
    assert.ok(closed.realized_pnl !== null && closed.realized_pnl < 0, "a stop-out is a loss");
    const view = await h.deps.broker.view();
    assert.equal(view.positions.length, 0);
  } finally { cleanup(h); }
});

test("the target fires and the close is attributed to the target", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;

    h.marks.set("BTC", i.target_px! - 50);
    await tick(h.deps);

    const closed = h.store.intent(i.intent_id)!;
    assert.equal(closed.close_reason, "target");
    assert.ok(closed.realized_pnl !== null && closed.realized_pnl > 0);
  } finally { cleanup(h); }
});

// The time stop is not optional: the outlook expired, so the thesis did. It is also
// the exit that bounds funding cost, which at 10x is ~2.4%/day of the signal's margin.
test("a passed horizon closes the position and pulls the resting exits", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;

    h.setNow(new Date(Date.parse(i.horizon_at) + 60_000));
    h.setSnapshot(null, false);
    const t = await tick(h.deps);
    assert.ok(t.cancelled >= 2, "the stop and the target come off");

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.status, "closed");
    assert.equal(after.close_reason, "horizon");
    assert.equal((await h.deps.broker.view()).orders.length, 0, "nothing of ours may be left resting");
  } finally { cleanup(h); }
});

test("a signal that disappears from a fresh snapshot is closed as retired", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [], source: "test" }, true);
    await tick(h.deps);
    assert.equal(h.store.intent(i.intent_id)!.close_reason, "retired");
  } finally { cleanup(h); }
});

// The vendor re-publishes an outlook under a NEW `outlook_id` on every revision —
// 44 of 76 series rotated theirs inside 8.4 hours on 2026-08-30. Keying retirement on
// the raw id therefore read every routine revision as "this signal is gone" and
// force-closed a healthy live position, roughly hourly, at taker cost both ways.
// Found on the live account with real money on it; see the phase 2 notes.
test("a revision bump rotates the outlook_id and must NOT retire the position", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.status, "open");

    const bumped = btcSeries(NOW);
    bumped.outlook.revision += 1;
    // Only the last component moves: a revision of the same outlook, in the same epoch.
    const parts = bumped.outlook.outlook_id.split(":");
    bumped.outlook.outlook_id = [...parts.slice(0, -1), "0fad777dc6bc7895"].join(":");
    assert.notEqual(bumped.outlook.outlook_id, i.signal_ref, "the raw id must actually have changed");

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [bumped], source: "test" }, true);
    await tick(h.deps);

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.status, "open", "a revision of an outlook we hold is the same signal");
    assert.equal(after.close_reason, null);
    assert.equal(h.store.liveIntents(MASTER).length, 1, "and it must not open a second intent either");
  } finally { cleanup(h); }
});

// `tasks/41`, and the reason the test above could not catch it: the component *second*
// from the end is a **global epoch tag**, rewritten for every series in the feed at the
// same instant — 2026-08-31T02:51:41Z, 09-02T08:43:01Z, 09-11T05:49:54Z. The 8.4-hour
// capture the fixture comes from sits inside one epoch, so no fixture of one poll
// contains a rotation. The third one closed and reopened twelve WTI positions for
// −$3.13 before anybody noticed, because to `loop.ts` the outlook had left the feed.
test("an epoch rewrite rotates every id at once and must NOT retire the book", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.status, "open");

    const rotated = btcSeries(NOW);
    rotated.outlook.revision += 1;
    const parts = rotated.outlook.outlook_id.split(":");
    assert.equal(parts.length, 8, "the vendor's own shape, or this proves nothing");
    // Both trailing components move, which is what a rotation looks like on the wire.
    rotated.outlook.outlook_id = [...parts.slice(0, -2), "ad418704103bb56d", "474388c7b0f31805"].join(":");
    assert.notEqual(rotated.outlook.outlook_id.split(":").slice(0, -1).join(":"), i.signal_ref,
      "the old key — id minus one component — really does stop matching");

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [rotated], source: "test" }, true);
    await tick(h.deps);

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.status, "open", "a new epoch of an outlook we hold is the same outlook");
    assert.equal(after.close_reason, null);
    assert.equal(h.store.liveIntents(MASTER).length, 1, "and it must not open a second intent under the new key");
  } finally { cleanup(h); }
});

// The retirement above uses an empty feed, which is the rare shape. The ordinary one
// is the series staying put and losing its direction: Quotient runs ~95% no-direction,
// 53–63 neutral of 56–65 outlooks a day since 2026-09-04. `loop.ts` keeps a position
// only while its outlook is `side !== null && status === "active"`, so this is the path
// that actually fires in production and the one the two tests below have to drive.
const neutralised = (now: Date): PerpsSeries => {
  const s = btcSeries(now);
  s.outlook.side = null;
  return s;
};

test("a call that goes neutral closes the position, and the row records that it did", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.hold_to_target, 0, "the default policy, and what the live ledger was traded under");
    assert.equal(i.withdrawn_at, null);

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [neutralised(NOW)], source: "test" }, true);
    await tick(h.deps);

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.close_reason, "retired", "a series with no side is not a signal we hold");
    assert.equal(after.withdrawn_at, NOW.toISOString(), "and when it went neutral is on the row");
  } finally { cleanup(h); }
});

// The setting `tasks/18` cannot reach: hold-to-resolve turns off ONE exit reason.
//
// The test asserts both halves, because only the pair is the feature. Turning the exit
// off without keeping the horizon would be an unbounded position, which is the failure
// venue-side stops and the time stop both exist to prevent — and the backtest's holding
// column leaves through the horizon 18 times in 44, so this is the common exit, not a
// backstop nobody reaches.
test("hold-to-resolve keeps a position through a neutral call, and still closes on the horizon", async () => {
  const h = await harness(NOW, { settings: { ...DEFAULT_USER_SETTINGS, holdToTarget: true } });
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.hold_to_target, 1, "the policy is frozen onto the intent at open");

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [neutralised(NOW)], source: "test" }, true);
    await tick(h.deps);

    const held = h.store.intent(i.intent_id)!;
    assert.equal(held.status, "open", "a neutral call must not close this position");
    assert.equal(held.close_reason, null);
    assert.equal(held.withdrawn_at, NOW.toISOString(),
      "but it is still recorded, or the two policies stop being comparable on live trades");
    assert.ok(
      h.logs.some((l) => l.includes("went neutral") && l.includes("holding")),
      "and the log says why a position is outliving its forecast",
    );

    // The horizon is untouched by the setting, so the position still leaves on time.
    const past = new Date(Date.parse(held.horizon_at) + 60_000);
    h.setNow(past);
    await tick(h.deps);
    await tick(h.deps);

    const closed = h.store.intent(i.intent_id)!;
    assert.equal(closed.status, "closed");
    assert.equal(closed.close_reason, "horizon");
    assert.equal((await h.deps.broker.view()).orders.length, 0, "nothing of ours may be left resting");
  } finally { cleanup(h); }
});

// ── `tasks/44`: the call reverses while we hold it ─────────────────────────────
//
// The gap this closes: `tick()` used to decide a position was retired by MEMBERSHIP, so
// an outlook that went long -> short still carried `side !== null && status ===
// "active"` and stayed in the live set. We would have held a long while Quotient called
// it short, until a target, a stop, a horizon or a *later* neutral turn — and nothing
// anywhere recorded that the thesis had inverted. Three direct flips in twelve days of
// archive and **0 of 461 closed trips affected**, which is the argument for building it
// now rather than meeting it first at 10x and size.
//
// The capture's BTC outlook is a SHORT (-2.57 sigma), so a flip here is short -> long.
//
// Flipping `side` alone is NOT a flip and the mapper says so — it refuses the call with
// *"live displacement -2.57 sigma contradicts side=long"*, which is the unmapped-symbol
// rule's sibling and a good guard to have run into. A real reversal moves the price
// claim: `displacement_sigma` is `ln(median_price / ref_median) / sigma_total`, so the
// median is mirrored about the reference and every signed field with it.
const flipped = (now: Date): PerpsSeries => {
  const s = btcSeries(now);
  const o = s.outlook;
  o.side = "long";
  o.state = "long";
  o.median_price = 2 * o.ref_median! - o.median_price!;
  o.displacement_sigma = -o.displacement_sigma!;
  o.spot_gap_sigma = -o.spot_gap_sigma!;
  o.spot_gap_pct = -o.spot_gap_pct!;
  o.edge_pct = -o.edge_pct!;
  return s;
};

test("a call that reverses closes the position as `flipped`, which is not `retired`", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.side, "short");
    assert.equal(i.flipped_at, null);

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [flipped(NOW)], source: "test" }, true);
    await tick(h.deps);

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.close_reason, "flipped", "a reversal is its own fact and must not pool with retired");
    assert.equal(after.flipped_at, NOW.toISOString());
    assert.equal(after.withdrawn_at, null, "the call never went neutral — it went the other way");
    assert.ok(
      h.logs.some((l) => l.includes("reversed this call") && l.includes("short → long")),
      "three of these in twelve days, so each one is worth reading in the log",
    );
  } finally { cleanup(h); }
});

// The placebo. If keying the live set on the side had broken the ordinary exit, the
// desk would force-close its whole book on the next poll — so the neutral path is
// re-asserted here beside the new one rather than left to the test above it.
test("a neutral turn still retires, and does not read as a flip", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [neutralised(NOW)], source: "test" }, true);
    await tick(h.deps);

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.close_reason, "retired");
    assert.equal(after.flipped_at, null, "a side of null is an absence of a call, not the other call");
    assert.equal(after.withdrawn_at, NOW.toISOString());
  } finally { cleanup(h); }
});

// `tasks/44` section 3.2, and the owner's actual ask: *"agree on flip if it cheap —
// anyway need to track such."* The policy is frozen at open, so hold-to-resolve must
// not close on a flip any more than it closes on a neutral turn. What it must do is
// leave a record, because otherwise the position exits on a level or on time and its
// close reason carries no trace that the forecast ever reversed.
test("hold-to-resolve keeps a reversed position, and the reversal is recorded anyway", async () => {
  const h = await harness(NOW, { settings: { ...DEFAULT_USER_SETTINGS, holdToTarget: true } });
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.hold_to_target, 1);

    h.setSnapshot({ at: NOW, polledAt: NOW, series: [flipped(NOW)], source: "test" }, true);
    await tick(h.deps);
    // Twice, because the stamp and the skip row are both first-writer-wins and the
    // flipped call stays in the feed for the rest of the position's life. Without that
    // guard this would fire once a loop and lose the date it exists to carry.
    await tick(h.deps);

    const held = h.store.intent(i.intent_id)!;
    assert.equal(held.status, "open", "the policy is frozen at open — a flip does not override it");
    assert.equal(held.close_reason, null);
    assert.equal(held.flipped_at, NOW.toISOString());
    const rows = h.store.signalHistory(MASTER, "2000-01-01").filter((x) => x.reason === "side-flipped");
    assert.equal(rows.length, 1, "one row, not one per loop");
    assert.match(rows[0]!.detail ?? "", /held short while the forecast turned long/);
  } finally { cleanup(h); }
});

// Acceptance: the reopen is not a special path. It goes back through `considerSignals`
// and every gate applies — including `blockReentryAfterStop`, which is keyed on
// (account, coin, side) and therefore has to survive a flip and a flip back.
test("a flip and a flip back does not smuggle a stopped-out side past blockReentryAfterStop", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const short = h.store.liveIntents(MASTER)[0]!;

    // The short stops out. BTC short is now refused for the rest of the UTC day.
    h.marks.set("BTC", short.stop_px! + 50);
    await tick(h.deps);
    assert.equal(h.store.intent(short.intent_id)!.close_reason, "stop");

    // The call reverses. A LONG is a different key, so it is allowed — this is the one
    // false positive `tasks/42` section 4.4 added `side` to the key to avoid.
    h.marks.set("BTC", short.ref_px);
    h.setSnapshot({ at: h.deps.now, polledAt: h.deps.now, series: [flipped(h.deps.now)], source: "test" }, true);
    await tick(h.deps);
    const long = h.store.liveIntents(MASTER)[0];
    assert.ok(long, "a genuinely new call on the other side is not what the stop blocked");
    assert.equal(long!.side, "long");

    // And it reverses back. The long closes as `flipped`; the short must NOT reopen,
    // because that side stopped out earlier today.
    h.setSnapshot({ at: h.deps.now, polledAt: h.deps.now, series: [btcSeries(h.deps.now)], source: "test" }, true);
    await tick(h.deps);
    await tick(h.deps);
    assert.equal(h.store.intent(long!.intent_id)!.close_reason, "flipped");
    assert.deepEqual(h.store.liveIntents(MASTER), [], "the stopped side stays refused for the rest of the day");
    const skips = h.store.signalHistory(MASTER, "2000-01-01").filter((x) => x.reason === "stopped-recently");
    assert.ok(skips.length > 0, "and the refusal is in `skips`, replayable");
  } finally { cleanup(h); }
});

// `CLAUDE.md`: settings are frozen into each position at open and can be changed
// between positions. The exit policy is a setting like the others, so a change from the
// desk must not reach a position that is already running — in either direction. This is
// the direction that costs money if it is wrong: an owner who switches back to closing
// on neutral would otherwise have every open position closed at taker cost the moment
// the change landed, which is precisely the hourly force-close that `stableOutlookId`
// was written to stop.
test("the exit policy is frozen at open — changing the setting does not touch a live position", async () => {
  const h = await harness(NOW, { settings: { ...DEFAULT_USER_SETTINGS, holdToTarget: true } });
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.hold_to_target, 1);

    // What `serviceChangeRequests` does between ticks: replace the settings in place.
    h.deps.settings = { ...DEFAULT_USER_SETTINGS, holdToTarget: false };
    h.setSnapshot({ at: NOW, polledAt: NOW, series: [neutralised(NOW)], source: "test" }, true);
    await tick(h.deps);

    const after = h.store.intent(i.intent_id)!;
    assert.equal(after.status, "open", "the position keeps the policy it opened under");
    assert.equal(after.close_reason, null);
  } finally { cleanup(h); }
});

// A failed poll must never read as "every signal was retired" — that would liquidate
// the whole book on a network blip.
test("a failed poll does not retire anything", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;

    h.setSnapshot(h.deps.snapshot, false);   // stale snapshot, fresh=false
    await tick(h.deps);
    assert.equal(h.store.intent(i.intent_id)!.status, "open", "a stale feed must not close positions");
  } finally { cleanup(h); }
});

// The Phase 1 gate: "zero orphaned state after a forced restart mid-position".
test("a restart mid-position re-derives the same state and places nothing new", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const before = h.store.liveIntents(MASTER)[0]!;
    const ordersBefore = (await h.deps.broker.view()).orders.map((o) => o.cloid).sort();
    h.store.close();

    // Cold start on the same database, as systemd would do it.
    const store = new Store(join(h.dir, "db.sqlite"));
    const marks = h.marks;
    const broker = new PaperBroker(store, () => marks, 1000, MASTER);
    const deps: LoopDeps = { ...h.deps, store, broker };
    const t = await tick(deps);

    assert.equal(t.placed, 0, "the venue already has what the ledger wants");
    assert.equal(t.cancelled, 0, "and nothing of ours is orphaned");
    const after = store.liveIntents(MASTER)[0]!;
    assert.equal(after.intent_id, before.intent_id);
    assert.equal(after.status, "open");
    assert.deepEqual((await broker.view()).orders.map((o) => o.cloid).sort(), ordersBefore);
    store.close();
  } finally { rmSync(h.dir, { recursive: true, force: true }); }
});

// docs/ACCOUNT-MODEL.md §1 — two actors on one account cannot be reconciled.
test("a position we did not open halts the account and stops new intents", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    // The user opens something by hand.
    h.marks.set("xyz:NVDA", 218.86);
    h.store.db.prepare(
      "INSERT INTO paper_positions (account, coin, szi, entry_px, margin_used, leverage, opened_at) VALUES (?,?,?,?,?,?,?)",
    ).run(MASTER, "xyz:NVDA", 5, 218.86, 109, 10, NOW.toISOString());

    const t = await tick(h.deps);
    assert.equal(t.foreignPositions, 1);
    assert.equal(t.halted, true);
    assert.ok(t.haltReason!.includes("second actor"), t.haltReason ?? "");

    // And it stays halted, refusing to open, while still managing its own exits.
    h.setSnapshot({ at: NOW, polledAt: NOW, series: [btcSeries(NOW)], source: "test" }, true);
    const t2 = await tick(h.deps);
    assert.equal(t2.opened, 0, "a halted account opens nothing");
  } finally { cleanup(h); }
});

test("an order we did not place halts the account and is never cancelled", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    h.store.db.prepare(
      "INSERT INTO paper_orders (cloid, account, coin, is_buy, sz, px, trigger_px, fire_below, reduce_only, oid, placed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ).run("0x" + "ab".repeat(16), MASTER, "BTC", 1, 0.001, 70000, null, 0, 0, 999, NOW.toISOString());

    const t = await tick(h.deps);
    assert.equal(t.foreignOrders, 1);
    assert.equal(t.halted, true);
    const view = await h.deps.broker.view();
    assert.ok(view.orders.some((o) => o.cloid === "0x" + "ab".repeat(16)), "a user's own order must survive our halt");
  } finally { cleanup(h); }
});

// deploy/server-cmds.md tells the operator "delete the file to resume". It has to
// be true: a kill switch that cannot be un-flipped is a decommission switch.
test("the operator halt file stops opening and releases when removed", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);                                    // opens the BTC intent
    h.deps.globalHalt = { halted: true, reason: "operator" };
    h.setSnapshot({ at: NOW, polledAt: NOW, series: [btcSeries(NOW)], source: "test" }, true);
    const held = await tick(h.deps);
    assert.equal(held.opened, 0, "nothing opens while the file is there");
    assert.equal(h.store.account(MASTER)!.halted, 0, "and the halt is NOT persisted");

    h.deps.globalHalt = { halted: false, reason: "" };
    const freed = await tick(h.deps);
    assert.equal(freed.halted, false, "removing the file resumes the account");
  } finally { cleanup(h); }
});

test("a foreign position halt persists across the condition disappearing", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    h.marks.set("xyz:NVDA", 218.86);
    h.store.db.prepare(
      "INSERT INTO paper_positions (account, coin, szi, entry_px, margin_used, leverage, opened_at) VALUES (?,?,?,?,?,?,?)",
    ).run(MASTER, "xyz:NVDA", 5, 218.86, 109, 10, NOW.toISOString());
    assert.equal((await tick(h.deps)).halted, true);

    // The user closes their hand-placed position. That is not evidence we are safe.
    h.store.db.prepare("DELETE FROM paper_positions WHERE account = ? AND coin = ?").run(MASTER, "xyz:NVDA");
    const after = await tick(h.deps);
    assert.equal(after.halted, true, "a sticky halt needs a person, not a quiet market");
    assert.equal(after.opened, 0);
  } finally { cleanup(h); }
});

// A halt must not strip the protection off positions that are already open.
test("halting does not cancel the venue-side stops", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    h.deps.globalHalt = { halted: true, reason: "operator" };
    await tick(h.deps);
    const view = await h.deps.broker.view();
    assert.equal(view.orders.filter((o) => o.isTrigger).length, 2, "the stop and target stay on the venue");
  } finally { cleanup(h); }
});

// A whole real poll through the whole loop, on **both** captures and each at its own
// instant — the one place the tests still meet the feed as it actually arrives. What is
// asserted is that nothing falls through unexplained, never a count: 76 series on 08-30
// and 60 on 09-10 refuse for different reasons, and the point is that every one of them
// refuses *with* a reason and a detail a user could act on.
for (const capture of CAPTURES) {
  test(`every skip is recorded with a reason a user could act on — ${capture.name}`, async () => {
    const h = await harness(capture.at, { series: capture.payload.series });
    try {
      await tick(h.deps);
      const skips = h.store.signalHistory(MASTER, "2000-01-01").filter((r) => r.outcome === "skipped");
      assert.ok(skips.length > 0, "a real poll must produce explained refusals");
      for (const s of skips) {
        assert.ok((s.reason ?? "").length > 0 && (s.detail ?? "").length > 0, JSON.stringify(s));
      }
      const reasons = new Set(skips.map((s) => s.reason));
      assert.ok(reasons.has("no-direction"), [...reasons].join(","));
    } finally { cleanup(h); }
  });
}

test("the concurrency cap is what stops the sixth signal, and it says so", async () => {
  // Six distinct outlooks on one coin would collide, so vary the coin via BTC clones
  // with distinct ids: only one can hold BTC, so the rest skip as already-open.
  // Ids carry a trailing revision hash like the vendor's do, so that three *distinct*
  // outlooks do not collapse onto one `stableOutlookId` and dedupe as republications.
  const h = await harness(NOW, { series: Array.from({ length: 3 }, (_, n) => {
    const s = btcSeries(NOW);
    s.outlook.outlook_id = `po:test:${n}:0fad777dc6bc7895`;
    return s;
  }) });
  try {
    const t = await tick(h.deps);
    assert.equal(t.opened, 1, "one position per coin");
    const skips = h.store.signalHistory(MASTER, "2000-01-01").filter((s) => s.reason === "already-open");
    assert.equal(skips.length, 2);
    assert.ok(skips[0]!.detail!.includes("BTC"));
  } finally { cleanup(h); }
});

// `tasks/21` §10's acceptance test, and the property the two caps did not have before
// it: at 25% per position four positions are a full book *and* the whole budget, so
// they now bind at exactly the same point. The fifth must be refused for
// `max-concurrent` and not for `no-budget` — the reason the owner is shown has to be
// the true one, and under the old pair it was whichever cap happened to be lower.
test("a full book at 25% is four positions and the whole budget, and the fifth is max-concurrent", async () => {
  const coins = ["BTC", "ETH", "SOL", "DOGE", "AVAX"];
  const h = await harness(NOW, { series: coins.map((c, n) => seriesOn(NOW, c, n)) });
  try {
    h.deps.settings = { ...DEFAULT_USER_SETTINGS, perSignalPct: 0.25 };
    for (const c of coins) h.marks.set(c, 78083.5);
    const t = await tick(h.deps);

    assert.equal(t.opened, 4, "four positions fit at 25%, and only four");
    const open = h.store.liveIntents(MASTER);
    assert.equal(open.length, 4);

    // Σ margin lands exactly on the budget: $1,000 less the 1% reserve.
    const deployed = open.reduce((sum, i) => sum + i.margin_usd, 0);
    assert.equal(cents(deployed), cents(maxDeployedUsd(1000)), `deployed $${deployed}`);
    assert.equal(cents(deployed), cents(990));

    // And the fifth says so honestly.
    const refused = h.store.signalHistory(MASTER, "2000-01-01")
      .filter((s) => s.outcome === "skipped" && s.reason === "max-concurrent");
    assert.equal(refused.length, 1, "exactly one signal refused, and for the count: "
      + JSON.stringify(h.store.signalHistory(MASTER, "2000-01-01").map((x) => [x.outcome, x.coin, x.reason])));
    assert.ok(refused[0]!.detail!.includes("4/4"), refused[0]!.detail!);
    assert.equal(
      h.store.signalHistory(MASTER, "2000-01-01").filter((s) => s.reason === "no-budget").length, 0,
      "never no-budget: the budget and the count are the same wall now",
    );
  } finally { cleanup(h); }
});

// "Stopping the bot" must not leave orders that can OPEN a position — but pulling a
// reduce-only stop on the way out would leave a 10x position naked for the length of
// a deploy, which is the failure the venue-side stop exists to prevent.
test("SIGTERM cancels what could open exposure and leaves the venue-side stops on", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const foreign = "0x" + "cd".repeat(16);
    const ours = makeCloid(h.store.liveIntents(MASTER)[0]!.intent_id, "entry");
    for (const [cloid, oid] of [[foreign, 998], [ours, 997]] as const) {
      h.store.db.prepare(
        "INSERT INTO paper_orders (cloid, account, coin, is_buy, sz, px, trigger_px, fire_below, reduce_only, oid, placed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ).run(cloid, MASTER, "BTC", 1, 0.001, 70000, null, 0, 0, oid, NOW.toISOString());
    }

    const n = await cancelOurRestingOrders(h.deps);
    assert.equal(n, 1, "only our own non-reduce-only order comes off");
    const view = await h.deps.broker.view();
    assert.equal(view.orders.filter((o) => o.isTrigger && o.reduceOnly).length, 2, "the stop and target stay on the venue");
    assert.ok(view.orders.some((o) => o.cloid === foreign), "a user's own order is never touched");
    assert.ok(!view.orders.some((o) => o.cloid === ours), "ours, which could have opened exposure, is gone");
  } finally { cleanup(h); }
});

test("an intent's orders are all tagged as ours and traceable to it", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const i = h.store.liveIntents(MASTER)[0]!;
    const orders = h.store.ordersFor(i.intent_id);
    assert.equal(orders.length, 3, "entry, stop, target");
    assert.deepEqual(orders.map((o) => o.role).sort(), ["entry", "sl", "tp"]);
    // The tag is what makes an order recognisable on the venue without our database.
    for (const o of orders) assert.ok(o.cloid.startsWith("0x5d01"), o.cloid);
    assert.notEqual(makeCloid(i.intent_id, "sl"), orders.find((o) => o.role === "sl")!.cloid);
  } finally { cleanup(h); }
});

// ── Changing the limits and the mandate on a connected account (tasks/18) ──
//
// The property early users asked for — open positions keep their terms — is one the
// executor already had: every intent freezes its own leverage, margin, stop and target
// at open, and the desired order set is derived from that row, never from the
// settings. These drive it end to end so it stays a fact rather than an argument.

test("changing the limits touches nothing open, and the next position opens on the new terms", async () => {
  const h = await harness(NOW);
  try {
    const spot = h.marks.get("BTC")!;
    await tick(h.deps);
    await tick(h.deps);
    const before = h.store.liveIntents(MASTER)[0]!;
    const ordersBefore = (await h.deps.broker.view()).orders.map((o) => o.cloid).sort();

    // The runner replaces `settings` on the ManagedAccount between ticks and builds
    // the next tick's deps from it. Nothing in flight reads it.
    //
    // ⚠ Every field of the new object differs from the default (`tasks/46` §3.3): the
    // stop here was `0.02`, which **became the default on 2026-09-12**, so from that day
    // "the next position opened on the new terms" could not be told from "it opened on
    // the defaults" for the one setting this test is mostly about.
    const newTerms = { ...DEFAULT_USER_SETTINGS, leverage: 5 as const, stopPct: 0.04, perSignalPct: 0.15 };
    for (const k of ["leverage", "stopPct", "perSignalPct"] as const) {
      assert.notEqual(newTerms[k], DEFAULT_USER_SETTINGS[k], `${k} is not actually a change`);
    }
    h.deps.settings = newTerms;
    const t = await tick(h.deps);
    assert.equal(t.placed, 0, "no order for the open position");
    assert.equal(t.cancelled, 0);
    const held = h.store.intent(before.intent_id)!;
    assert.equal(held.leverage, DEFAULT_USER_SETTINGS.leverage);
    assert.equal(cents(held.margin_usd), cents(DEFAULT_USER_SETTINGS.perSignalPct * 1000 * (1 - RISK_PARAMS.reserveFrac)));
    assert.equal(held.stop_px, before.stop_px, "the stop it opened with, to the cent");
    assert.deepEqual((await h.deps.broker.view()).orders.map((o) => o.cloid).sort(), ordersBefore);

    // It closes at its own stop, on the terms it opened with.
    h.marks.set("BTC", before.stop_px! + 50);
    await tick(h.deps);
    assert.equal(h.store.intent(before.intent_id)!.status, "closed");

    // A new outlook opens on the new terms: 5x, a 4% stop (well inside the 13.1% ceiling
    // at 5x on BTC), 15% of the mandate.
    //
    // **The clock moves past the UTC boundary first**, and it has to since `tasks/42`:
    // that position closed at its stop, so a same-side BTC entry is refused as
    // `stopped-recently` for the rest of the day. Rolling the day is what releases it,
    // which is the rule this test now also pins. The outlook's anchor is 08-31T10:00Z,
    // so it is still 9.9h out and inside `maxHoldHours`.
    h.deps.now = new Date("2026-08-31T00:05:00Z");
    h.marks.set("BTC", spot);
    const next = btcSeries(NOW);
    next.outlook.outlook_id = "po:test:next:0fad777dc6bc7895";
    h.setSnapshot({ at: h.deps.now, polledAt: h.deps.now, series: [next], source: "test" }, true);
    const t2 = await tick(h.deps);
    assert.equal(t2.opened, 1);
    const fresh = h.store.liveIntents(MASTER)[0]!;
    assert.equal(fresh.leverage, newTerms.leverage);
    assert.equal(cents(fresh.margin_usd), cents(newTerms.perSignalPct * 1000 * (1 - RISK_PARAMS.reserveFrac)),
      "the new share of the same $1,000 mandate, less the reserve");
    assert.ok(Math.abs(fresh.stop_px! / fresh.ref_px - (1 + newTerms.stopPct)) < 1e-4,
      `a short's ${newTerms.stopPct * 100}% stop, tick-rounded: ${fresh.stop_px} vs ${fresh.ref_px}`);
  } finally { cleanup(h); }
});

test("a mandate re-read waits for the book to be flat, then the next position is sized off the new base", async () => {
  const h = await harness(NOW);
  const web = new WebStore(join(h.dir, "web.sqlite"));
  try {
    const spot = h.marks.get("BTC")!;
    await tick(h.deps);
    await tick(h.deps);
    const open = h.store.liveIntents(MASTER)[0]!;

    web.requestMandate(MASTER, NOW.getTime() + 1000);
    const managed = { master: MASTER as `0x${string}`, mode: "paper" as const, settings: h.deps.settings, baseCapital: 1000 };
    const service = () => serviceChangeRequests({
      store: h.store, requestsDb: join(h.dir, "web.sqlite"), accounts: [managed],
      accountsDir: join(h.dir, "accounts"),
      readCollateral: async () => ({ ok: true, usableUsd: 0, message: "" }),
      log: () => {}, now: () => h.deps.now,
    });

    assert.equal((await service()).mandatesApplied, 0, "pending while the position is open");
    await tick(h.deps);
    assert.equal(h.store.intent(open.intent_id)!.margin_usd, 99, "it keeps the mandate it opened under");
    assert.equal(h.store.account(MASTER)!.base_capital, 1000);

    // The target fires: closed at a gain, today.
    h.marks.set("BTC", open.target_px! - 50);
    await tick(h.deps);
    const closed = h.store.intent(open.intent_id)!;
    assert.equal(closed.status, "closed");
    assert.ok(closed.realized_pnl! > 0);
    const equity = h.store.paperEquity(MASTER)!;
    assert.ok(equity > 1000, "the paper book banked the gain");

    // The next loop applies the rebase. The base is what the account holds; the day's
    // baseline is that less today's realised result — which is the equity the day
    // opened on, so the gain still counts towards the day and nothing was forgiven.
    assert.equal((await service()).mandatesApplied, 1);
    const row = h.store.account(MASTER)!;
    assert.ok(Math.abs(row.base_capital - equity) < 1e-6, `${row.base_capital} vs ${equity}`);
    assert.ok(Math.abs(row.day_start_equity! - 1000) < 0.05, `day baseline ${row.day_start_equity}`);
    assert.equal(managed.baseCapital, row.base_capital);

    // The runner hands the new base to the next tick, and the next signal sizes off it.
    h.deps.baseCapital = managed.baseCapital;
    h.marks.set("BTC", spot);
    const next = btcSeries(NOW);
    next.outlook.outlook_id = "po:test:rebased:0fad777dc6bc7895";
    h.setSnapshot({ at: NOW, polledAt: NOW, series: [next], source: "test" }, true);
    const t = await tick(h.deps);
    assert.equal(t.opened, 1);
    const fresh = h.store.liveIntents(MASTER)[0]!;
    assert.ok(Math.abs(fresh.margin_usd - 0.10 * equity * (1 - RISK_PARAMS.reserveFrac)) < 1e-6,
      `${fresh.margin_usd} is 10% of the new $${equity} mandate, less the reserve`);
    assert.ok(Math.abs(t.allocation.dayStartEquity - 1000) < 0.05, "and the tick reads the corrected baseline");
  } finally { web.close(); cleanup(h); }
});

// ── tasks/42: the executor does not get back into a market that stopped it out ──────
//
// The hole this closes was worth 54% of the desk's entire net loss to 2026-09-11.
// `hasLiveIntentFor` and `hasLiveIntentOn` both ask whether an intent is *running*, so a
// closed one constrained nothing and a stopped-out position reopened on the next tick —
// the call is still in the feed, because a stop firing is a statement about price and
// the outlook does not know it happened. 50 such re-entries returned −6.31% of margin
// against +0.24% after a `retired` close, and not one of the fifty reached its target.
//
// ⚠ **These three tests pass for a reason the live desk cannot reproduce, and that gap
// shipped the defect `tasks/51` fixes.** `PaperBroker.settleTriggers` stamps its own
// fired trigger `filled`, so `settleLedger` reads `seenTrigger = "stop"` off our orders
// table and the close is attributed inside the tick. On a real venue that row stays
// `placed` forever and HL cancels the sibling trigger, so the exit is recorded
// `retired` and only the fill ingest ever relabels it — which is what the guard reads.
// The live shape is pinned in `fills.test.ts` ("a venue-side stop is invisible to
// blockReentryAfterStop until the ingest names it"), and what closes the window is
// `shouldIngestFills`, in the runner, not anything below.

test("a stopped-out market is not re-entered on the next tick, and the refusal says why", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const first = h.store.liveIntents(MASTER)[0]!;

    // Walk the mark into the stop. The same outlook is still in the snapshot and still
    // carries a side, which is exactly the condition that used to reopen it.
    h.marks.set("BTC", first.stop_px! + 50);
    await tick(h.deps);
    assert.equal(h.store.intent(first.intent_id)!.status, "closed");
    assert.equal(h.store.intent(first.intent_id)!.close_reason, "stop");

    h.marks.set("BTC", first.ref_px);
    const t = await tick(h.deps);
    assert.equal(t.opened, 0, "the stop is information; the unchanged call is not");
    assert.equal(h.store.liveIntents(MASTER).length, 0);
    const skips = h.store.signalHistory(MASTER, "2000-01-01").filter((s) => s.reason === "stopped-recently");
    assert.equal(skips.length, 1);
    assert.match(skips[0]!.detail!, /BTC/);
    assert.match(skips[0]!.detail!, /UTC day/);
  } finally { cleanup(h); }
});

test("the refusal is same-side and same-market: the other side and another market still open", async () => {
  const h = await harness(NOW, { series: [btcSeries(NOW), seriesOn(NOW, "ETH", 1)] });
  try {
    h.marks.set("ETH", h.marks.get("BTC")!);
    await tick(h.deps);
    await tick(h.deps);
    const btc = h.store.liveIntents(MASTER).find((i) => i.coin === "BTC")!;
    const side = btc.side;
    h.marks.set("BTC", btc.stop_px! + 50);
    await tick(h.deps);
    assert.equal(h.store.intent(btc.intent_id)!.close_reason, "stop");

    // ETH was never stopped and is untouched — one market never blocks another.
    assert.ok(h.store.liveIntents(MASTER).some((i) => i.coin === "ETH"), "ETH keeps running");
    assert.equal(h.store.stoppedOutToday(MASTER, "ETH", side, h.deps.now), false);
    // And the opposite side on BTC is a different call, which the ledger has never seen
    // follow a stop — so it is deliberately not refused.
    assert.equal(h.store.stoppedOutToday(MASTER, "BTC", side === "long" ? "short" : "long", h.deps.now), false);
  } finally { cleanup(h); }
});

test("the block releases when the UTC day rolls, and the same call opens again", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const first = h.store.liveIntents(MASTER)[0]!;
    h.marks.set("BTC", first.stop_px! + 50);
    await tick(h.deps);
    h.marks.set("BTC", first.ref_px);
    assert.equal((await tick(h.deps)).opened, 0);

    // Past midnight UTC. The outlook's anchor is 08-31T10:00Z, so it is still 9.9h out.
    h.deps.now = new Date("2026-08-31T00:05:00Z");
    const next = btcSeries(NOW);
    next.outlook.outlook_id = "po:test:day2:0fad777dc6bc7895";
    h.setSnapshot({ at: h.deps.now, polledAt: h.deps.now, series: [next], source: "test" }, true);
    assert.equal((await tick(h.deps)).opened, 1, "a new day is a new book");
  } finally { cleanup(h); }
});

// ── Clearing a halt (`tasks/30` §1) ─────────────────────────────────────────
//
// **The acceptance test `tasks/30` names, and the one that matters:** clear a halt on an
// account still below the cap and assert it re-halts on the next tick. That is what
// makes a Clear button safe *by construction* rather than by policy — the budget is
// measured from `day_start_equity`, and the clear does not touch it, so it cannot buy a
// second one. `notes/2026-08-31-halt-survives-unlink.md` closed the version of this that
// did: unlink, wait a loop, reconnect cleared the halt **and** rebased the baseline, and
// another 10% could be lost from there, repeatedly, in about two minutes.

test("a cleared halt re-halts on the next tick while the account is still below the cap", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    // Put the account past the daily cap: the baseline is the day's opening equity and
    // the paper book's cash is what `view.equityUsd` reads.
    const before = h.store.account(MASTER)!;
    h.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?")
      .run((before.day_start_equity ?? 1000) * 0.85, MASTER);
    const halted = await tick(h.deps);
    assert.equal(halted.halted, true);
    assert.equal(h.store.account(MASTER)!.halt_kind, "daily-loss", "and it is typed, so a button can branch on it");

    const atHalt = h.store.account(MASTER)!;
    h.store.clearHalt(MASTER, "owner", "cleared in a test");
    const cleared = h.store.account(MASTER)!;
    assert.equal(cleared.halted, 0);
    assert.equal(cleared.day, atHalt.day, "the day is untouched");
    assert.equal(cleared.day_start_equity, atHalt.day_start_equity, "and so is the baseline it is measured from");

    const again = await tick(h.deps);
    assert.equal(again.halted, true, "the condition is still there, so the next tick re-halts");
    assert.equal(again.opened, 0, "and nothing opened in between");
  } finally { cleanup(h); }
});

// The other half: once the condition has genuinely gone, the clear sticks.
test("a cleared halt stays clear once the account is back inside the cap", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    const base = h.store.account(MASTER)!.day_start_equity ?? 1000;
    h.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(base * 0.85, MASTER);
    assert.equal((await tick(h.deps)).halted, true);

    h.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(base * 0.95, MASTER);
    h.store.clearHalt(MASTER, "owner", "cleared in a test");
    assert.equal((await tick(h.deps)).halted, false);
  } finally { cleanup(h); }
});

// `events` held a `halt` row and nothing for the clear, because every clear so far was a
// hand `UPDATE` that went round `recordEvent` — so the ledger recorded that accounts
// stopped and never that they started again.
test("the clear is on the ledger, with who did it and the baseline it did not touch", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    const base = h.store.account(MASTER)!.day_start_equity ?? 1000;
    h.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(base * 0.85, MASTER);
    await tick(h.deps);
    h.store.clearHalt(MASTER, "owner", "Looked first: the day had rolled.");

    const rows = h.store.db.prepare("SELECT detail FROM events WHERE account = ? AND kind = 'unhalt'")
      .all(MASTER) as unknown as { detail: string }[];
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.detail, /cleared by the owner/);
    assert.match(rows[0]!.detail, /daily-loss/);
    assert.match(rows[0]!.detail, /baseline is untouched/);
    assert.equal(h.store.clearHalt(MASTER, "owner", "again"), null, "clearing a clear account writes nothing");
  } finally { cleanup(h); }
});

// ⚠ The halts on the desk the day `halt_kind` shipped: already halted, no kind, and a
// daily-loss condition that has since gone. `tick()` types one where the condition is
// still true — and writes no event and sends no alert, because nothing happened.
test("a halt that predates the column is typed on the next tick, silently", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    const base = h.store.account(MASTER)!.day_start_equity ?? 1000;
    h.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(base * 0.85, MASTER);
    await tick(h.deps);
    // Rewind to the pre-migration shape: halted, with a reason, and no kind.
    h.store.db.prepare("UPDATE accounts SET halt_kind = NULL WHERE account = ?").run(MASTER);
    const events = () => (h.store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE account = ? AND kind = 'halt'")
      .get(MASTER) as { n: number }).n;
    const before = events();

    await tick(h.deps);
    assert.equal(h.store.account(MASTER)!.halt_kind, "daily-loss");
    assert.equal(events(), before, "no second halt event: this is the halt that was already there");
  } finally { cleanup(h); }
});

// ── The five settings that are not the default (`tasks/46` §3.2) ───────────────────
//
// Until 2026-09-13 `DEFAULT_USER_SETTINGS` was the only complete settings object any
// test in this file instantiated — so the site sold four leverages, three of which no
// test had ever placed an order at, and stops to 8%, which no test had ever armed.
// `src/risk/settings-cases.ts` holds the list and the reason for each corner;
// `risk/governor.test.ts` runs the same five through `preTradeCheck`.

const budget = (base: number) => base * (1 - RISK_PARAMS.reserveFrac);

test("5x / 5% / 8% — the weakest combination the site offers, end to end", async () => {
  const settings = SETTINGS_CASES[0]!.settings;
  // The reason it is the weakest: the funding floor is `minOrderNotional / (perSignal ×
  // leverage)`, so the lowest offered pair needs the most money before a signal can
  // produce a legal order — four times the default's. The exact $40.41 is pinned as a
  // published figure in `web/mode.test.ts`; what is asserted here is the ordering.
  assert.equal(
    DEFAULT_USER_SETTINGS.perSignalPct * DEFAULT_USER_SETTINGS.leverage,
    4 * settings.perSignalPct * settings.leverage,
    "this pair buys a quarter of the default's notional per dollar of mandate",
  );
  assert.ok(minFundedForLiveUsd(settings) > minFundedForLiveUsd(DEFAULT_USER_SETTINGS),
    `${minFundedForLiveUsd(settings)} against ${minFundedForLiveUsd(DEFAULT_USER_SETTINGS)}`);

  const h = await harness(NOW, { settings });
  try {
    const t = await tick(h.deps);
    assert.equal(t.opened, 1);
    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.leverage, 5);
    assert.equal(cents(i.margin_usd), cents(0.05 * budget(1000)));
    // BTC caps at 40x, so 5x leaves 13.1% of room to liquidation and the 8% arms in
    // full. The same 8% at 10x arms 6.13% and at 20x 2.63% — the clamp is the leverage.
    assert.equal(clampStopPct(settings.stopPct, 5, 40, RISK_PARAMS.liqBufferFrac).clamped, false);
    assert.ok(Math.abs(i.stop_px! / i.ref_px - (1 + settings.stopPct)) < 1e-4,
      `a short's 8% stop, tick-rounded: ${i.stop_px} vs ${i.ref_px}`);
    assert.doesNotMatch(i.rationale, /stop clamped/);
    // And the account is far from its halt: one stop costs 2.0% of the mandate here.
    assert.ok(stopsToHalt(settings) > 5, `${stopsToHalt(settings)} stops to the daily cap`);
  } finally { cleanup(h); }
});

// `notes/2026-09-12-how-a-20x-account-arms-a-2-percent-stop.md`, run through the loop
// rather than through `clampStopPct` alone: 18x exists **because of the clamp and not
// because of the leverage**. On a 20x-max market it is the highest tier that can arm the
// shipped 2% default; 20x on the same market arms 1.75% and cannot arm its own default.
test("18x arms a full 2% on a 20x-max market where 20x arms 1.75%", async () => {
  const armed = async (leverage: 18 | 20) => {
    const h = await harness(NOW, { settings: { ...DEFAULT_USER_SETTINGS, leverage }, series: [seriesOn(NOW, "SOL", 1)] });
    try {
      h.marks.set("SOL", SPOT);
      assert.equal((await tick(h.deps)).opened, 1);
      const i = h.store.liveIntents(MASTER)[0]!;
      assert.equal(i.coin, "SOL");
      assert.equal(i.leverage, leverage, "SOL caps at 20x, so neither tier is clamped on leverage");
      return { pct: i.stop_px! / i.ref_px - 1, rationale: i.rationale };
    } finally { cleanup(h); }
  };

  const at18 = await armed(18);
  assert.ok(Math.abs(at18.pct - DEFAULT_USER_SETTINGS.stopPct) < 1e-4, `18x armed ${(at18.pct * 100).toFixed(2)}%`);
  assert.doesNotMatch(at18.rationale, /stop clamped/, "18x arms the default in full — that is the whole tier");

  const at20 = await armed(20);
  assert.ok(Math.abs(at20.pct - maxStopPct(20, 20, RISK_PARAMS.liqBufferFrac)) < 1e-4, `20x armed ${(at20.pct * 100).toFixed(2)}%`);
  assert.ok(at20.pct < at18.pct, "and 20x, the higher leverage, leaves LESS room than 18x");
  assert.match(at20.rationale, /stop clamped/, "the clamp is a note on the intent, never a refusal");
});

// The account that halted three times on 2026-09-10, driven end to end. Three facts in
// one test because they are one account: the clamp bites, four positions are the whole
// book *and* the whole budget, and the daily-loss halt is reachable **with the book
// open** — which no loop test had ever done at any size, on the setting that actually
// reached it. The halt is marked to market, so it fires on unrealised loss well before
// any of these positions is near its own stop.
test("20x / 25% — a clamped stop, a full book, and a daily-loss halt with it open", async () => {
  const settings = SETTINGS_CASES[2]!.settings;
  const coins = ["SOL", "BTC", "ETH", "DOGE"];
  const h = await harness(NOW, { settings, series: coins.map((c, n) => seriesOn(NOW, c, n)) });
  try {
    for (const c of coins) h.marks.set(c, SPOT);
    const t = await tick(h.deps);
    assert.equal(t.opened, maxConcurrentSignals(settings), "four positions at 25%, and only four");

    const open = h.store.liveIntents(MASTER);
    assert.equal(cents(open.reduce((s, i) => s + i.margin_usd, 0)), cents(budget(1000)), "Σ margin is the whole budget");

    // SOL caps at 20x so the leverage is what the owner asked for and the *stop* is
    // clamped; DOGE caps at 10x so the leverage is clamped and the 2% stop fits.
    const sol = open.find((i) => i.coin === "SOL")!;
    assert.equal(sol.leverage, 20);
    assert.ok(Math.abs(sol.stop_px! / sol.ref_px - 1 - maxStopPct(20, 20, RISK_PARAMS.liqBufferFrac)) < 1e-4);
    assert.match(sol.rationale, /stop clamped 2\.00% → 1\.75%/);
    const doge = open.find((i) => i.coin === "DOGE")!;
    assert.equal(doge.leverage, 10, "DOGE caps at 10x — the other clamp, on the same book");
    assert.doesNotMatch(doge.rationale, /stop clamped/);

    // The mark walks 0.6% against all four shorts. Every stop is 1.75% or 2% away, so
    // nothing exits — and the unrealised loss on $17,325 of notional is already past
    // 10% of a $1,000 account. This is the mechanism, not a contrived number: at 25%
    // per signal `stopsToHalt` is 1.01, so the cap sits inside one position's stop.
    for (const c of coins) h.marks.set(c, SPOT * 1.006);
    const halted = await tick(h.deps);
    assert.equal(halted.halted, true, `equity ${JSON.stringify(halted.allocation)}`);
    assert.equal(h.store.account(MASTER)!.halt_kind, "daily-loss");
    assert.equal(h.store.liveIntents(MASTER).length, 4, "the halt does not close the book");
    assert.equal((await h.deps.broker.view()).orders.filter((o) => o.isTrigger).length, 8,
      "and it must not strip the venue-side exits off four open positions");
    assert.equal((await tick(h.deps)).opened, 0, "a halted account opens nothing");
  } finally { cleanup(h); }
});

// With `stopLoss: false` nothing rests on the venue but a take-profit, and isolated
// margin is the entire protection — `stopOutOfMargin` is 1 rather than `stopPct ×
// leverage`. The position still has to leave: on its target, on its horizon, or when
// the call goes neutral. Only `computeExitPrices` and one arithmetic test had ever seen
// this branch.
test("the stop off rests only a target, and the position still leaves on it", async () => {
  const settings = SETTINGS_CASES[3]!.settings;
  assert.equal(stopOutOfMargin(settings), 1, "no stop means the whole margin is what one position can lose");
  const h = await harness(NOW, { settings });
  try {
    const t = await tick(h.deps);
    assert.equal(t.opened, 1);
    assert.equal(t.placed, 2, "the entry and a target — there is no stop to place");

    const i = h.store.liveIntents(MASTER)[0]!;
    assert.equal(i.stop_px, null, "and none is frozen onto the intent either");
    assert.ok(i.target_px !== null);
    const view = await h.deps.broker.view();
    assert.equal(view.orders.length, 1);
    assert.equal(view.orders[0]!.reduceOnly, true, "the one resting order can only reduce");
    assert.doesNotMatch(i.rationale, /Stop /);

    h.marks.set("BTC", i.target_px! - 50);
    await tick(h.deps);
    assert.equal(h.store.intent(i.intent_id)!.close_reason, "target");
  } finally { cleanup(h); }
});

test("the stop off still leaves on the horizon and on a neutral call", async () => {
  const settings = SETTINGS_CASES[3]!.settings;
  for (const [why, drive] of [
    ["horizon", (h: Harness, i: { horizon_at: string }) => { h.setNow(new Date(Date.parse(i.horizon_at) + 60_000)); h.setSnapshot(null, false); }],
    ["retired", (h: Harness) => { h.setSnapshot({ at: NOW, polledAt: NOW, series: [neutralised(NOW)], source: "test" }, true); }],
  ] as const) {
    const h = await harness(NOW, { settings });
    try {
      await tick(h.deps);
      const i = h.store.liveIntents(MASTER)[0]!;
      drive(h, i);
      await tick(h.deps);
      assert.equal(h.store.intent(i.intent_id)!.close_reason, why, `an unstopped position must still leave (${why})`);
      assert.equal((await h.deps.broker.view()).orders.length, 0, "nothing of ours may be left resting");
    } finally { cleanup(h); }
  }
});

// ⚠ `blockReentryAfterStop` is a `RISK_PARAMS` constant, not a user setting, so this is
// the only place its `false` branch can be executed at all — the governor cannot be
// handed it and the site cannot set it. `tasks/46` §3.2 listed it among the five
// settings; it is not one, and `src/risk/settings-cases.ts` records that.
//
// What the test is for: the constant is worth 54% of the desk's net loss to 2026-09-11
// (`tasks/42`), and nothing anywhere showed what turning it off does. This does — the
// same call, the same tick, the same account, and the position comes straight back.
test("with blockReentryAfterStop off, the stopped-out market is re-entered on the next tick", async () => {
  const params = RISK_PARAMS as { blockReentryAfterStop: boolean };
  const on = params.blockReentryAfterStop;
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const first = h.store.liveIntents(MASTER)[0]!;
    h.marks.set("BTC", first.stop_px! + 50);
    await tick(h.deps);
    assert.equal(h.store.intent(first.intent_id)!.close_reason, "stop");

    // The outlook has not changed and does not know the stop fired. With the block on
    // the desk stays out for the rest of the UTC day; with it off it is back in the
    // market within 60 seconds, at taker cost, on no new information.
    h.marks.set("BTC", first.ref_px);
    params.blockReentryAfterStop = false;
    const back = await tick(h.deps);
    assert.equal(back.opened, 1, "this is the behaviour the constant exists to prevent");
    const second = h.store.liveIntents(MASTER)[0]!;
    assert.notEqual(second.intent_id, first.intent_id);
    assert.equal(second.coin, "BTC");
    assert.equal(second.side, first.side, "same market, same side, same call");
    assert.equal(
      h.store.signalHistory(MASTER, "2000-01-01").filter((s) => s.reason === "stopped-recently").length, 0,
      "and no refusal is recorded, because none happened",
    );
  } finally {
    params.blockReentryAfterStop = on;
    cleanup(h);
  }
});

test("the constant is on, which is what every test above this one assumes", () => {
  assert.equal(RISK_PARAMS.blockReentryAfterStop, true,
    "if this is ever turned off deliberately, the re-entry test above is the shipped behaviour");
});

// ── tasks/51 §5a: the exit price against the stop, decided inside the tick ──────────
//
// `blockReentryAfterStop` used to read `close_reason` alone, which on a live account
// only the fill ingest can write — so the guard was blind for the minutes between the
// close and the next ingest and the desk walked back into 22 markets that had just
// stopped it out. `shouldIngestFills` narrowed that to one round trip; this closes it,
// by answering the guard's real question from two numbers already frozen on the intent.
//
// ⚠ The test is **nearest trigger**, not at-or-through the stop. `exitPx` here is the
// mark up to a loop interval after the trigger fired, and it bounces back over the
// level: measured over the 645 closed intents on the box, at-or-through missed **51 of
// 115** real stops. Nearest-trigger separated the same population perfectly — 115 of
// 115 caught, 0 missed, all 102 targets ignored, plus the 2026-09-10 liquidation, which
// is a stop that went further and is exactly what the block is for.

const stopSideIntent = (over: Partial<IntentRow> = {}): IntentRow => ({
  intent_id: "0a8c7932", account: MASTER, created_at: NOW.toISOString(), provider: "quotient",
  signal_ref: "po:commodity:copper:price-outlook:daily", signal_revision: 1,
  coin: "xyz:COPPER", side: "long", leverage: 10, margin_usd: 4.19, size_abs: 6.42,
  ref_px: 6.5172, target_px: 6.5557, stop_px: 6.3868, horizon_at: "2026-09-14T21:00:00Z",
  hold_to_target: 0, withdrawn_at: null, flipped_at: null, stopped_at: null,
  rationale: "", status: "closed", entry_px: 6.5172, filled_sz: 6.42,
  closed_at: NOW.toISOString(), close_reason: "retired", realized_pnl: -0.85,
  fee_usd: null, funding_usd: null, net_pnl: null, pnl_note: null, ...over,
});

const order = (role: string): OrderRow => ({
  cloid: "0x00", intent_id: "0a8c7932", role, coin: "xyz:COPPER", is_buy: 0,
  px: 0, trigger_px: null, sz: 6.42, reduce_only: 1, placed_at: NOW.toISOString(),
  oid: 1, status: "placed", detail: null,
});

// The live shape, from the box: the resting triggers are still `placed` because nothing
// ever updates them, and the mark at settle is just under the stop.
test("a trigger exit at the stop is caught with no order of ours ever marked filled", () => {
  assert.equal(leftOnTheStopSide(stopSideIntent(), [order("entry"), order("sl"), order("tp")], 6.3848), true);
});

// `xyz:CL` 76dfe704 — a real stop whose mark had recovered **1.7 bps above** the stop by
// the time we looked. At-or-through says no; nearest-trigger says yes, and it is right.
test("a stop the mark has already recovered above is still caught", () => {
  const i = stopSideIntent({ coin: "xyz:CL", entry_px: 100.89, ref_px: 100.89, stop_px: 99.872, target_px: 102.43 });
  assert.ok(99.889 > i.stop_px!, "the exit is above the stop — this is why at-or-through fails");
  assert.equal(leftOnTheStopSide(i, [order("sl"), order("tp")], 99.889), true);
});

test("a target exit is not a stop, however the day went", () => {
  assert.equal(leftOnTheStopSide(stopSideIntent(), [order("sl"), order("tp")], 6.5557), false);
});

// A retirement, a horizon, a flip and a halt all place a `close` order. They are our
// decision rather than the market's, and re-entry after one is a path the desk keeps.
test("a close we placed ourselves is never a stop, even at the stop price", () => {
  assert.equal(leftOnTheStopSide(stopSideIntent(), [order("sl"), order("tp"), order("close")], 6.3848), false);
});

test("no stop on the account is nothing to be blocked by; no target falls back to at-or-through", () => {
  assert.equal(leftOnTheStopSide(stopSideIntent({ stop_px: null }), [order("sl")], 6.3848), false);
  const noTarget = stopSideIntent({ target_px: null });
  assert.equal(leftOnTheStopSide(noTarget, [order("sl")], 6.3848), true, "through the stop");
  assert.equal(leftOnTheStopSide(noTarget, [order("sl")], 6.3900), false, "above it, and nothing to compare against");
});

test("a short is the mirror of a long", () => {
  const i = stopSideIntent({ side: "short", entry_px: 2656.6, ref_px: 2656.6, stop_px: 2709.7, target_px: 2469 });
  assert.equal(leftOnTheStopSide(i, [order("sl"), order("tp")], 2700.0), true);
  assert.equal(leftOnTheStopSide(i, [order("sl"), order("tp")], 2480.0), false);
});

// And end to end: the stamp is written by the tick that closes, so the guard is armed
// before the next tick can ask — whatever `close_reason` says at that moment.
test("the stamp is written at close, and the guard reads it without close_reason", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const first = h.store.liveIntents(MASTER)[0]!;
    h.marks.set("BTC", first.stop_px! + 50);
    await tick(h.deps);

    const closed = h.store.intent(first.intent_id)!;
    assert.ok(closed.stopped_at, "stamped inside the tick that closed it");

    // Now the live shape: forget the venue's attribution entirely. The ingest has not
    // run, `close_reason` says what `settleLedger` could work out on its own, and the
    // guard must still refuse.
    h.store.db.prepare("UPDATE intents SET close_reason = 'retired' WHERE intent_id = ?").run(first.intent_id);
    assert.equal(h.store.stoppedOutToday(MASTER, "BTC", first.side, h.deps.now), true,
      "this is the 2026-09-14 state, and it used to return false");

    h.marks.set("BTC", first.ref_px);
    const back = await tick(h.deps);
    assert.equal(back.opened, 0, "no re-entry, on the stamp alone");
    const skips = h.store.signalHistory(MASTER, "2000-01-01").filter((s) => s.reason === "stopped-recently");
    assert.equal(skips.length, 1);
  } finally { cleanup(h); }
});

// ── The snapshot that predates the fill (2026-09-16) ────────────────────────────────
//
// A target close is the one exit that leaves the vendor's call bit-identical: the side
// does not turn, the revision does not move, and the outlook does not know it paid out.
// Quotient re-bases `ref_median` to the new spot on the revision that follows, dropping
// its own displacement — 0.847σ to 0.354σ on the ETH call of 2026-09-15 — but until that
// revision arrives the desk holds a forecast observed before its own exit.
// `liveDisplacementSigma` cannot repair it, because the target and the denominator went
// stale with the spot. `notes/2026-09-16-the-snapshot-that-predates-the-fill.md`.

test("a forecast observed before our own exit is refused, and the refusal is replayable", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const first = h.store.liveIntents(MASTER)[0]!;

    // Twenty minutes pass and the target fires. The snapshot in hand is unchanged and
    // still carries `observed_at` from before the fill.
    const later = new Date(NOW.getTime() + 20 * 60_000);
    h.setNow(later);
    h.marks.set("BTC", first.target_px! - 50);
    await tick(h.deps);
    assert.equal(h.store.intent(first.intent_id)!.close_reason, "target");

    // Price comes back to where we entered, so the live re-gate re-arms: displacement is
    // measured against a target the vendor has not moved yet. This is exactly the state
    // that put fifteen accounts back into ETH on 2026-09-15.
    h.marks.set("BTC", first.ref_px);
    const back = await tick(h.deps);
    assert.equal(back.opened, 0, "the forecast is older than the exit it has not seen");
    assert.deepEqual(h.store.liveIntents(MASTER), []);

    const skips = h.store.signalHistory(MASTER, "2000-01-01")
      .filter((s) => s.reason === "snapshot-predates-close");
    assert.equal(skips.length, 1, "and it lands in `skips`, replayable");
    assert.match(skips[0]!.detail ?? "", /observed .* but we closed this outlook at/);
  } finally { cleanup(h); }
});

test("a forecast the vendor observed after our exit is admitted", async () => {
  const h = await harness(NOW);
  try {
    await tick(h.deps);
    await tick(h.deps);
    const first = h.store.liveIntents(MASTER)[0]!;

    const later = new Date(NOW.getTime() + 20 * 60_000);
    h.setNow(later);
    h.marks.set("BTC", first.target_px! - 50);
    await tick(h.deps);
    assert.equal(h.store.intent(first.intent_id)!.close_reason, "target");

    // The next poll lands. Same outlook, same side, same everything — the only thing that
    // changed is that the vendor has now looked at the market since we left it. That is
    // the whole condition, and the guard releases on it with nothing to wait out.
    const fresh = new Date(later.getTime() + 60_000);
    h.setNow(fresh);
    h.setSnapshot({ at: fresh, polledAt: fresh, series: [btcSeries(fresh)], source: "test" }, true);
    h.marks.set("BTC", first.ref_px);
    const back = await tick(h.deps);
    assert.equal(back.opened, 1, "a forecast newer than our exit is new information");
    const second = h.store.liveIntents(MASTER)[0]!;
    assert.notEqual(second.intent_id, first.intent_id);
    assert.equal(second.side, first.side);
    assert.equal(
      h.store.signalHistory(MASTER, "2000-01-01").filter((s) => s.reason === "snapshot-predates-close").length,
      0, "and nothing was refused on the way in");
  } finally { cleanup(h); }
});

test("the guard is keyed on the outlook, so another call on that market is untouched", async () => {
  const h = await harness(NOW, { series: [btcSeries(NOW), seriesOn(NOW, "ETH", 1)] });
  try {
    h.marks.set("ETH", SPOT);
    await tick(h.deps);
    await tick(h.deps);
    const btc = h.store.liveIntents(MASTER).find((i) => i.coin === "BTC")!;

    const later = new Date(NOW.getTime() + 20 * 60_000);
    h.setNow(later);
    h.marks.set("BTC", btc.target_px! - 50);
    await tick(h.deps);
    assert.equal(h.store.intent(btc.intent_id)!.close_reason, "target");

    // `ref_median` is per-outlook, so it is BTC's own reference that went stale against
    // our fill. ETH's call carries its own and is not refused — which is also why the
    // key needs no `side`: a side change needs a revision, and a revision carries a
    // newer `observed_at`.
    assert.ok(h.store.liveIntents(MASTER).some((i) => i.coin === "ETH"),
      "a different outlook keeps running");
    h.marks.set("BTC", btc.ref_px);
    await tick(h.deps);
    const skips = h.store.signalHistory(MASTER, "2000-01-01")
      .filter((s) => s.reason === "snapshot-predates-close");
    assert.equal(skips.length, 1, "exactly one outlook was refused");
    assert.equal(skips[0]!.coin, "BTC");
  } finally { cleanup(h); }
});
