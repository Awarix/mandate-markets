import type { PmSignal } from "../signals/types.ts";

// **This is not the Polymarket mapper yet.** It holds one function — the identity a
// prediction-market intent is keyed on — because `npm run pm-census` and `tasks/52`'s
// backtest both need it before any order code exists, and two copies of this particular
// rule is how the perps side lost positions.
//
// `tasks/06` §8 Step 2 is **not** done until this file also turns a `PmSignal` into an
// intent and builds a rationale that **names Quotient**, with
// `src/mapping/quotient-pm.test.ts` asserting it does — the same requirement
// `src/mapping/intent.test.ts` enforces on the perps mapper (`tasks/12`). Phase 5 is the
// sharper case, not the softer one: `/signals` carries `thesis`, Quotient's own prose, so
// a prediction-market row presents their analysis far more directly than a perps row,
// which only paraphrases their numbers.

/** The identity of a prediction-market position: the venue, the market, and the side.
 *
 *  **The signal `id` is a per-revision UUID and must never be the key.** Measured over
 *  the 2026-08-30 → 09-14 archive: 127 stable keys carried a median of 2 ids each and one
 *  carried **21**; market 601819 sat in all 39 polls of the first two days with an
 *  unchanged `side: YES` under 7 different ids (`notes/2026-09-01-research-polymarket.md`
 *  §1). Keying on `id` reads every routine revision as a retirement plus a fresh entry —
 *  which is exactly the `outlook_id` bug that made the live executor force-close healthy
 *  Hyperliquid positions hourly (`tasks/41`). It is written down here before the first
 *  intent exists, which is the only improvement over last time.
 *
 *  **A market never appears twice in one poll**, checked across the whole archive, so the
 *  market is the identity and the id is the revision. The side is in the key because the
 *  same market can be called both ways over its life and those are different positions —
 *  in practice rarely: 127 keys over 123 markets.
 *
 *  ⚠ Under hold-to-resolution this key does **not** drive an exit — nothing sells because
 *  a revision stopped appearing. What it does is **dedupe the entry**, so a market already
 *  held is not bought again on its next revision. That is a different job from the perps
 *  side's and it is the one that survives the exit policy
 *  (`notes/2026-09-14-hold-to-resolution-and-the-book-that-never-empties.md` §5). */
export function stablePmKey(signal: PmSignal): string {
  return `${signal.market.venue}:${signal.market.nativeMarketId}:${signal.side}`;
}
