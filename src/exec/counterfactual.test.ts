import assert from "node:assert/strict";
import { test } from "node:test";
import { Store } from "../store/db.ts";
import { replay, type Candle } from "../scripts/exit-policy.ts";
import {
  ingestCounterfactuals, intervalFor, pendingCounterfactuals, stopWouldFire, summarisePath,
} from "./counterfactual.ts";

// The stored summary exists to reproduce `replay`'s answer without the candles. So the
// test that matters is not "does it compute a minimum" — it is that the pair agree on
// every stop level, including the straddle that `replay` deliberately resolves to the
// stop. If they ever disagree, a sweep read from storage is quietly a different sweep.

const k = (l: number, h: number): Candle =>
  ({ t: 0, T: 0, o: String(l), h: String(h), l: String(l), c: String(h) });

test("the stored summary and a live replay agree on every stop level", () => {
  // A long that dips to 95, runs to 108 (touching a 105 target), on a 100 entry.
  const path = [k(98, 101), k(95, 99), k(97, 106), k(104, 108)];
  const s = summarisePath("long", 105, path);
  for (const level of [90, 93, 94.9, 95, 95.1, 96, 97, 99, 101]) {
    const live = replay("long", 105, level, path)?.reason === "stop";
    assert.equal(stopWouldFire("long", level, s.maeToTargetPx), live, `stop at ${level}`);
  }
});

test("a candle that straddles both levels is a stop under either route", () => {
  // The last candle touches the 105 target and a 96 stop at once. `replay` gives it to
  // the stop; the prefix is inclusive of that candle, so the summary must too.
  const path = [k(99, 101), k(96, 106)];
  assert.equal(replay("long", 105, 96, path)?.reason, "stop");
  assert.equal(stopWouldFire("long", 96, summarisePath("long", 105, path).maeToTargetPx), true);
});

test("a stop outside the run-up to the target does not fire, even if price got there later", () => {
  // 105 target touched in candle 2; the drop to 90 comes after and belongs to no stop
  // decision, because the trade was over. The two MAEs differ exactly here.
  const path = [k(99, 101), k(98, 106), k(90, 95)];
  const s = summarisePath("long", 105, path);
  assert.equal(s.maePx, 90);
  assert.equal(s.maeToTargetPx, 98);
  assert.equal(replay("long", 105, 95, path)?.reason, "target");
  assert.equal(stopWouldFire("long", 95, s.maeToTargetPx), false);
});

test("a short reads the other way round", () => {
  const path = [k(99, 102), k(98, 105)];
  const s = summarisePath("short", 95, path);
  assert.equal(s.maePx, 105);
  assert.equal(stopWouldFire("short", 103, s.maeToTargetPx), true);
  assert.equal(stopWouldFire("short", 106, s.maeToTargetPx), false);
});

test("no target means the whole window counts, and both numbers agree", () => {
  const s = summarisePath("long", null, [k(99, 101), k(94, 100)]);
  assert.equal(s.maePx, 94);
  assert.equal(s.maeToTargetPx, 94);
});

// "we never looked" and "it did not fire" move a sweep in opposite directions, so the
// missing case is null and never false.
test("an empty path is unknown, not safe", () => {
  const s = summarisePath("long", 105, []);
  assert.equal(s.maePx, null);
  assert.equal(stopWouldFire("long", 95, s.maeToTargetPx), null);
});

// The cap is on rows, not on time, so the interval alone decides how far back a window
// is reachable. Anything the fine interval still reaches gets it.
test("the interval follows how old the window is", () => {
  const now = Date.parse("2026-09-10T00:00:00Z");
  assert.equal(intervalFor(Date.parse("2026-09-09T12:00:00Z"), now), "1m");
  assert.equal(intervalFor(Date.parse("2026-09-06T00:00:00Z"), now), "5m");
});

// Real epoch milliseconds, because `intervalFor` reads the age of the window and a
// fixture timestamped near the epoch would silently be answered in 5m candles.
const OPEN_MS = Date.parse("2026-09-01T00:00:00Z");
const CLOSE_MS = Date.parse("2026-09-01T04:00:00Z");

function ledger(): Store {
  const store = new Store(":memory:", { log: () => {} });
  store.db.exec(
    "INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision, " +
    " coin, side, leverage, margin_usd, size_abs, ref_px, target_px, horizon_at, rationale, status, closed_at) " +
    "VALUES ('i1', '0xa', '2026-09-01T00:00:00Z', 'q', 'sig', 1, 'BTC', 'long', 10, 10, 0.1, 100, 105, " +
    " '2026-09-02T00:00:00Z', 'r', 'closed', '2026-09-01T04:00:00Z')",
  );
  store.db.exec(
    "INSERT INTO fills (account, tid, time, coin, side, dir, px, sz, closed_pnl, fee, fee_token, " +
    " crossed, intent_id, attribution) VALUES " +
    `('0xa', 1, ${OPEN_MS}, 'BTC', 'B', 'Open Long',  100, 0.1, 0,   0, 'USDC', 1, 'i1', 'cloid'), ` +
    `('0xa', 2, ${CLOSE_MS}, 'BTC', 'A', 'Close Long', 106, 0.1, 0.6, 0, 'USDC', 1, 'i1', 'cloid')`,
  );
  return store;
}

test("a summarised trade stops being pending, and an empty path still counts as answered", async () => {
  const store = ledger();
  assert.equal(pendingCounterfactuals(store, 10).length, 1);

  const empty = await ingestCounterfactuals({
    store, now: new Date("2026-09-01T05:00:00Z"), pauseMs: 0,
    candles: async () => [],
  });
  assert.deepEqual(
    { done: empty.done, empty: empty.empty, failed: empty.failed, remaining: empty.remaining },
    { done: 1, empty: 1, failed: 0, remaining: 0 },
  );
  // The candles for that window are gone for good, so asking again forever is the bug
  // this guards: it is answered, with nulls.
  assert.equal(pendingCounterfactuals(store, 10).length, 0);
  store.close();
});

test("a venue error leaves the trade pending, because that one is worth asking again", async () => {
  const store = ledger();
  const out = await ingestCounterfactuals({
    store, now: new Date("2026-09-01T05:00:00Z"), pauseMs: 0, log: () => {},
    candles: async () => { throw new Error("429"); },
  });
  assert.equal(out.failed, 1);
  assert.equal(out.done, 0);
  assert.equal(out.remaining, 1);
  assert.equal(pendingCounterfactuals(store, 10).length, 1);
  store.close();
});

test("the window asked for is the window the trade was held, at the right interval", async () => {
  const store = ledger();
  const asked: { coin: string; interval: string; start: number; end: number }[] = [];
  await ingestCounterfactuals({
    store, now: new Date("2026-09-01T05:00:00Z"), pauseMs: 0,
    candles: async (coin, interval, startTime, endTime) => {
      asked.push({ coin, interval, start: startTime, end: endTime });
      return [k(97, 101), k(99, 106)];
    },
  });
  assert.deepEqual(asked, [{ coin: "BTC", interval: "1m", start: OPEN_MS, end: CLOSE_MS }]);
  const row = store.db.prepare("SELECT * FROM intents WHERE intent_id = 'i1'").get() as unknown as {
    cf_at: string; cf_interval: string; cf_mae_px: number; cf_mae_to_target_px: number;
  };
  assert.equal(row.cf_interval, "1m");
  assert.equal(row.cf_mae_px, 97);
  // The target is touched in the second candle, so the prefix includes the dip to 97.
  assert.equal(row.cf_mae_to_target_px, 97);
  assert.ok(row.cf_at.startsWith("2026-09-01T05:00"));
  store.close();
});

test("a pass is bounded, so a backlog drains across loops instead of in one burst", async () => {
  const store = ledger();
  for (let i = 2; i <= 6; i++) {
    store.db.exec(
      `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
        coin, side, leverage, margin_usd, size_abs, ref_px, target_px, horizon_at, rationale, status, closed_at)
       VALUES ('i${i}', '0xa', '2026-09-01T00:00:00Z', 'q', 'sig', 1, 'BTC', 'long', 10, 10, 0.1, 100, 105,
        '2026-09-02T00:00:00Z', 'r', 'closed', '2026-09-01T04:00:00Z')`,
    );
    store.db.exec(
      `INSERT INTO fills (account, tid, time, coin, side, dir, px, sz, closed_pnl, fee, fee_token,
        crossed, intent_id, attribution) VALUES
       ('0xa', ${i * 10}, ${OPEN_MS + i}, 'BTC', 'B', 'Open Long',  100, 0.1, 0,   0, 'USDC', 1, 'i${i}', 'cloid'),
       ('0xa', ${i * 10 + 1}, ${CLOSE_MS}, 'BTC', 'A', 'Close Long', 106, 0.1, 0.6, 0, 'USDC', 1, 'i${i}', 'cloid')`,
    );
  }
  const out = await ingestCounterfactuals({
    store, now: new Date("2026-09-01T05:00:00Z"), pauseMs: 0, limit: 2,
    candles: async () => [k(97, 101)],
  });
  assert.equal(out.done, 2);
  assert.equal(out.remaining, 4);
  store.close();
});
