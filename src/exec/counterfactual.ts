import type { Store } from "../store/db.ts";
import type { Candle } from "../scripts/exit-policy.ts";

// The price path a closed trade lived through, summarised once and stored (`tasks/31` §5).
//
// **Why this exists.** `stop-sweep` and `exit-policy` both replay closed trades against
// Hyperliquid candles, and `candleSnapshot` caps at ~5000 rows — so 1m candles reach 3.5
// days and a trade older than that stops being replayable at all. The evidence was
// visibly decaying: `exit-policy`'s sample fell 12 → 9 on an unchanged ledger. And the
// replay costs one HTTP call per closed trade, unpaced, which killed four of five
// `stop-sweep` runs at 207 intents on 2026-09-09. Both problems have the same fix:
// compute the summary once, while the candles are still there, and keep it.
//
// **Where it sits.** Outside `tick()`, exactly like `fills.ts`, and for the same reason:
// this is what a trade *cost*, answered afterwards, and nothing in the decision path may
// read it. A failed pass is logged and the next one retries — it must never be able to
// stop the loop that manages real positions.
//
// **What it does not store.** The `exit-policy` counterfactual — what holding past the
// real exit to the horizon would have done — is the same mechanism over a different
// window (`closed_at` → `horizon_at`, which is in the future at close and so needs a
// later pass). It is not stored here because nothing reads it yet, and a column nobody
// reads is a column nobody maintains.

/** The summary. `null` prices mean the venue returned no candles for the window — an
 *  answer, and a different one from "not computed yet", which is `cf_at IS NULL`. */
export type PathSummary = {
  interval: string;
  maePx: number | null;
  maeToTargetPx: number | null;
};

/** Worst price the position saw against it, and the same restricted to the candles up to
 *  and including the first one that touched the target.
 *
 *  The second number is the one that matters and the reason this is not just a min/max.
 *  `replay` walks the path and stops at the *first* level touched, resolving a candle
 *  that straddles both to the stop — so a stop level changes a trade exactly when it is
 *  reached at or before the first target touch. Storing the adverse extreme over that
 *  prefix reproduces the rule for every stop level from one pass, which is what makes a
 *  sweep free after this.
 *
 *  Pure: the candles come from the caller, so the ordering rule is decided in a unit test
 *  rather than in a loop that talks to Hyperliquid. */
export function summarisePath(side: string, target: number | null, candles: Candle[]): {
  maePx: number | null; maeToTargetPx: number | null;
} {
  if (candles.length === 0) return { maePx: null, maeToTargetPx: null };
  const long = side === "long";
  const worse = (a: number, b: number) => (long ? Math.min(a, b) : Math.max(a, b));
  let mae = long ? Infinity : -Infinity;
  let toTarget: number | null = null;
  for (const k of candles) {
    mae = worse(mae, Number(long ? k.l : k.h));
    if (toTarget === null && target !== null && (long ? Number(k.h) >= target : Number(k.l) <= target)) {
      // Inclusive of this candle: `replay` gives a straddling candle to the stop, so a
      // stop touched in the same candle as the target still fires first.
      toTarget = mae;
    }
  }
  return { maePx: mae, maeToTargetPx: toTarget ?? mae };
}

/** Would a stop at this price have fired before the trade's own exit?
 *
 *  The single question `stop-sweep` asks of every level, answered from the stored column
 *  instead of from a fetch. `null` when the path was never summarised or came back empty
 *  — not `false`, because "we do not know" and "it did not fire" move a sweep in
 *  opposite directions and must not be conflated. */
export function stopWouldFire(side: string, stopPx: number, maeToTargetPx: number | null): boolean | null {
  if (maeToTargetPx === null) return null;
  return side === "long" ? maeToTargetPx <= stopPx : maeToTargetPx >= stopPx;
}

export type CandleInterval = "1m" | "5m";

/** 1m candles reach ~3.5 days and 5m ~17.4, because the cap is on rows and not on time
 *  (`notes/2026-09-07-backtest-sigma-and-exit-policy.md` §3). An extreme is the same at
 *  either resolution — a 5m low is the lowest of its five 1m lows — so a coarser interval
 *  costs only the precision of *when* a level was first touched, and that only matters
 *  inside a single candle. Anything the fine interval can still reach gets it. */
export function intervalFor(windowStartMs: number, nowMs: number): CandleInterval {
  const days = (nowMs - windowStartMs) / 86_400_000;
  return days < 3 ? "1m" : "5m";
}

export type CandleFetch = (
  coin: string, interval: CandleInterval, startTime: number, endTime: number,
) => Promise<Candle[]>;

type Pending = {
  intent_id: string; coin: string; side: string; target_px: number | null;
  first_fill: number; last_fill: number;
};

/** Closed trades whose path has not been summarised, oldest fill first — so a backlog
 *  drains in the order the candles are disappearing in. */
export function pendingCounterfactuals(store: Store, limit: number): Pending[] {
  return store.db.prepare(
    "SELECT i.intent_id, i.coin, i.side, i.target_px, f.first_fill, f.last_fill " +
    "FROM intents i " +
    "JOIN (SELECT intent_id, MIN(time) AS first_fill, MAX(time) AS last_fill FROM fills " +
    "      WHERE intent_id IS NOT NULL GROUP BY intent_id) f ON f.intent_id = i.intent_id " +
    "WHERE i.status = 'closed' AND i.cf_at IS NULL " +
    "ORDER BY f.first_fill ASC LIMIT ?",
  ).all(limit) as unknown as Pending[];
}

export function saveCounterfactual(store: Store, intentId: string, s: PathSummary, at: Date): void {
  store.db.prepare(
    "UPDATE intents SET cf_at = ?, cf_interval = ?, cf_mae_px = ?, cf_mae_to_target_px = ? " +
    "WHERE intent_id = ?",
  ).run(at.toISOString(), s.interval, s.maePx, s.maeToTargetPx, intentId);
}

/** Summarise up to `limit` closed trades that have no summary yet.
 *
 *  **Bounded on purpose.** The whole reason this module exists is that an unpaced fetch
 *  per closed trade took `stop-sweep` down four times out of five, so the same mistake is
 *  not repeated inside the executor: a pass does a fixed small number of trades and the
 *  backlog drains across loops. `pauseMs` spaces the calls; the backfill script raises
 *  the limit, not the rate.
 *
 *  A trade whose window returns no candles is still marked done, with null prices. It
 *  will never be answerable — the candles are gone — and leaving it pending would make
 *  every future pass re-ask the venue the same unanswerable question. */
export async function ingestCounterfactuals(deps: {
  store: Store; candles: CandleFetch; now: Date; limit?: number; pauseMs?: number;
  log?: (m: string) => void;
}): Promise<{ done: number; empty: number; failed: number; remaining: number }> {
  const { store, candles, now } = deps;
  const limit = deps.limit ?? 5;
  const pauseMs = deps.pauseMs ?? 250;
  const pending = pendingCounterfactuals(store, limit);
  let done = 0, empty = 0, failed = 0;

  for (const [i, p] of pending.entries()) {
    if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    const interval = intervalFor(p.first_fill, now.getTime());
    try {
      const path = await candles(p.coin, interval, p.first_fill, p.last_fill);
      const s = summarisePath(p.side, p.target_px, path);
      saveCounterfactual(store, p.intent_id, { interval, ...s }, now);
      done++;
      if (s.maePx === null) empty++;
    } catch (err) {
      // Logged and left pending: a venue error is transient in a way a missing candle is
      // not, so this one is worth asking again.
      failed++;
      deps.log?.(`counterfactual ${p.intent_id.slice(0, 8)} ${p.coin}: ${String(err)}`);
    }
  }

  const remaining = (store.db.prepare(
    "SELECT COUNT(*) AS n FROM intents i " +
    "JOIN (SELECT DISTINCT intent_id FROM fills WHERE intent_id IS NOT NULL) f " +
    "  ON f.intent_id = i.intent_id " +
    "WHERE i.status = 'closed' AND i.cf_at IS NULL",
  ).get() as unknown as { n: number }).n;

  return { done, empty, failed, remaining };
}
