import type { PerpsSeries } from "../signals/types.ts";
import type { Side, SkipReason } from "../types.ts";

// Quotient `/signals/perps` → a provider-agnostic `SignalCall`, plus the entry gate.
//
// This is the ONLY file that knows Quotient's field names. Everything downstream
// (risk, exec, store) sees `SignalCall` and `TradeIntent`, so a second signal source
// is a new file here rather than a change to the executor.
//
// Grounded in a real captured payload, not the published reference — which omits
// `side`, `strength`, the percentile band, the sigma fields, and the Hyperliquid
// `resolution_reference` entirely. See notes/2026-08-30-perps-payload-findings.md.

export type SignalCall = {
  provider: "quotient";
  /** Stable id of the outlook this call came from. */
  signalRef: string;
  signalRevision: number;
  /** Hyperliquid market symbol, exactly as Quotient states it: "BTC", "xyz:NVDA". */
  coin: string;
  side: Side;
  /** The take-profit the vendor published. */
  targetPx: number;
  /** Fractional volatility over the horizon, from the vendor's own model. */
  sigmaTotal: number;
  /** Displacement in sigmas as the vendor computed it, against *their* observed spot. */
  displacementSigma: number;
  /** The spot the vendor computed against. Stale by up to one poll interval. */
  observedSpot: number;
  /** When the vendor observed that spot — `observed_at`, not when we fetched it.
   *
   *  This is the age of the whole snapshot, not just of `observedSpot`, because
   *  `ref_median`, `targetPx` and `sigmaTotal` are all computed at the same instant and
   *  all three move together on a revision. `liveDisplacementSigma` repairs the first
   *  and cannot repair the rest, which is why the executor compares this against its own
   *  closes (`notes/2026-09-16-the-snapshot-that-predates-the-fill.md`). */
  observedAt: string;
  /** Close unconditionally at this time. */
  horizonAt: string;
  mode: string;
  strength: string | null;
  /** Quotient's settlement bookkeeping, not a tradeability flag. Carried for Phase 0. */
  mappingStatus: string | null;
  /** For the dashboard's "why". */
  headline: string;
  assetClass: string;
  anchorType: string;
};

export type Gate = {
  minDisplacementSigma: number;
  allowedModes: readonly string[];
  allowedStrengths: readonly string[];
  maxHoldHours: number;
};

export type Evaluation =
  | { ok: true; call: SignalCall }
  | { ok: false; reason: SkipReason; detail: string; coin: string | null };

/** The Hyperliquid instrument Quotient names for this series.
 *
 *  **Validate, never infer.** Quotient states the venue symbol; our job is to look it
 *  up in HL `meta` and reject if it is absent. Never substring-match, never guess from
 *  `asset_key`, never fall back to a nearest match — OutcomeMaker's bucket bot
 *  inferred a market from a description and bought the wrong one for $192.
 *
 *  `mapping_status` is **not** part of that check, though the docs originally said it
 *  was. It is Quotient's *settlement* bookkeeping, confirmed by the vendor and then
 *  verified against 252 distinct outlooks in the archive — a clean 2×2 with two empty
 *  cells and no counterexamples:
 *
 *      verified   ⟺ anchor still in the future   (222)
 *      unresolved ⟺ anchor already passed         (30)
 *
 *  ⚠ **`unresolved` has since left the feed entirely**: 30 of 76 basis groups on the
 *  2026-08-30 capture, **0 of 60** on 2026-09-10, because no modern poll carries an
 *  anchor that has already passed. The equivalence is unrefuted — the two cells that must
 *  stay empty are still empty on both captures, which `quotient.test.ts` asserts — but one
 *  of the two populated cells is now empty too, so the 2×2 is a historical measurement
 *  rather than a live one, and a test that required an `unresolved` row would fail on the
 *  feed rather than on the code.
 *
 *  So it says nothing about whether the market is tradeable; it is a lossy proxy for
 *  a question the horizon gate already answers directly and more precisely. Gating on
 *  it bought us nothing and risked a false negative — a transient `unresolved` on a
 *  live outlook would have thrown away a signal on a feed that yields roughly one per
 *  snapshot. The status is carried through to the store so Phase 0 can still split on
 *  it.
 *
 *  ⚠ **This paragraph used to end "a stale vendor reference cannot hurt us either way,
 *  because the entry re-gates on the live Hyperliquid mark rather than on `spot_at_obs`".
 *  That was wrong and it cost fifteen positions on 2026-09-15.** `liveDisplacementSigma`
 *  substitutes the live mark for the stale spot and then keeps the stale `targetPx` and
 *  the stale `sigmaTotal` — but Quotient moves all three on a revision, and after a move
 *  it re-bases `ref_median` to the new spot. On the ETH outlook that day the desk hit its
 *  target at 20:01; the snapshot it still held read 0.687σ against the live mark and
 *  passed, while the revision landing seven seconds later read **0.354σ** and would have
 *  been refused at the published gate. The re-gate corrects a stale *spot*; it cannot
 *  correct a stale *snapshot*. `considerSignals` compares `observedAt` against our own
 *  closes for that reason (`notes/2026-09-16-the-snapshot-that-predates-the-fill.md`). */
function hyperliquidSymbol(series: PerpsSeries): { symbol: string | null; status: string | null } {
  for (const bg of series.basis_groups) {
    const rr = bg.resolution_reference;
    if (rr?.provider !== "hyperliquid") continue;
    return { symbol: rr.symbol, status: rr.mapping_status };
  }
  return { symbol: null, status: null };
}

/** The outlook's identity **across revisions and across epochs**, which `outlook_id`
 *  is not — and which this function did not return either, until 2026-09-13.
 *
 *  Quotient re-publishes an outlook under a *new* `outlook_id` on every revision: the
 *  final `:`-component is a per-revision content hash. **The component before it is a
 *  global epoch tag**, identical across every series in a poll and rewritten for all of
 *  them at the same instant, and dropping only the last one kept it:
 *
 *      ...:monthly:2026-08-31:07a8a1be7f379196:b683f308a9c6e822   rev 213
 *      ...:monthly:2026-08-31:07a8a1be7f379196:61736a1b944004aa   rev 214
 *      ...:monthly:2026-08-31:ad418704103bb56d:474388c7b0f31805   rev 215, after a rotation
 *
 *  **The original measurement was right and its conclusion was not.** On the 2026-08-30
 *  archive — 21 polls over 8.4 hours — 44 of 76 series rotated their `outlook_id` and
 *  the id-minus-one-component churned on none of them. It could not have been otherwise:
 *  those 8.4 hours sat inside a single epoch. Over the full 551-poll archive the vendor
 *  rewrote the tag three times, and 127 of 398 `(series_id, anchor_at)` pairs rotated
 *  their key under it (`tasks/41`).
 *
 *  This is load-bearing, and both wrong answers cost real money to notice. Two places
 *  key off it, and a rotating key breaks both in the same direction — an outlook still
 *  being published looks like a brand-new one:
 *
 *    - `exec/loop.ts` retires an open intent whose signal has left the feed, so an
 *      hourly revision bump force-closed healthy live positions (2026-08-30), and a
 *      vendor epoch rewrite closed and reopened twelve WTI positions for −$3.13
 *      (2026-09-11T05:49:54Z).
 *    - `store.hasLiveIntentFor` is "one live intent per outlook"; only the
 *      per-coin guard behind it stopped the same signal opening twice.
 *
 *  The `signals` table's `PRIMARY KEY (signal_ref, revision)` was written for a stable
 *  ref and only dedupes republications now that it has one.
 *
 *  **Total by choice.** An id whose shape we do not recognise keys as itself, which is
 *  what it did before and is no worse — a shape change is `tasks/47` step 6's
 *  feed-contract fingerprint, not a branch here. `stableOutlookKey` below is the strict
 *  form, for the migration and the count, where a guess must be a refusal. */
export function stableOutlookId(outlookId: string): string {
  return stableOutlookKey(outlookId) ?? outlookId;
}

/** The key that is actually stable, from a `signal_ref` as the ledger stores it.
 *
 *  `stableOutlookId` strips one `:`-component and keeps a **global epoch tag** — the
 *  component second from the end, identical across every series in a poll and rewritten
 *  for all of them at the same instant. Quotient rewrote it on 2026-08-31, 09-02 and
 *  09-11; each rewrite ends one key and begins another, so the executor reads a live
 *  outlook as retired and every reading counts one call as two (`tasks/41`).
 *
 *      po:commodity:copper:price-outlook:daily:2026-08-31:eb92e5a7…:b683f308…
 *      └────────────── the stable key, six ──────────────┘ └ epoch ┘ └ revision ┘
 *
 *  **Counted, not stripped, and that is the whole point.** The ledger holds two forms:
 *  seven components for everything `stableOutlookId` wrote, and **eight for the rows
 *  written before it existed** — 2 in `signals` and 13 in `skips`, all from the first
 *  forty minutes of the archive on 2026-08-30. Both trailing components are sixteen hex
 *  characters, so a rule that drops "the last one" cannot tell the two forms apart and
 *  would leave the oldest rows one component short, still carrying an epoch tag and
 *  still splitting. Truncating to a **count** is well defined for both.
 *
 *  Returns `null` for anything else, which is the guard rather than a convenience: a
 *  six-component ref is already migrated, and applying a truncation twice would take the
 *  anchor date with it and merge every anchor of a series into one key. **Anything
 *  reading or migrating a stored ref must branch on the `null`, never assume.** */
const STABLE_PARTS = 6;

export function stableOutlookKey(signalRef: string): string | null {
  const parts = signalRef.split(":");
  if (parts.length !== 7 && parts.length !== 8) return null;
  if (!parts.slice(STABLE_PARTS).every((p) => /^[0-9a-f]{16}$/.test(p))) return null;
  return parts.slice(0, STABLE_PARTS).join(":");
}

/** The model's own two numbers, for a skip that would otherwise be a bare state.
 *
 *  A neutral outlook still publishes where it thinks the price is going and how far
 *  that is in sigmas, and `state=neutral` alone throws both away — which makes every
 *  neutral row on the desk identical and unreadable. They are different facts: a target
 *  sitting on top of the reference is a model with nothing to say, while a large
 *  displacement it will not commit to is a model that is unsure, and only the numbers
 *  tell them apart.
 *
 *  Formatted like `rationale()` in `mapping/intent.ts` — `toPrecision(6)` for prices,
 *  two decimals for sigma — so the same figure reads the same wherever it appears.
 *  Returns "" rather than guessing when the outlook carries nothing usable. */
function outlookNumbers(o: PerpsSeries["outlook"]): string {
  if (!(o.median_price > 0) || !(o.ref_median > 0)) return "";
  const sigma = Number.isFinite(o.displacement_sigma)
    ? ` (${o.displacement_sigma >= 0 ? "+" : ""}${o.displacement_sigma.toFixed(2)}σ)`
    : "";
  return ` · target ${o.median_price.toPrecision(6)} vs ${o.ref_median.toPrecision(6)}${sigma}`;
}

/** The entry gate, in the order that produces the most useful skip reason.
 *  Nothing here touches the network; `coin` still has to resolve against live HL
 *  `meta` before an intent is built. */
export function evaluateSeries(series: PerpsSeries, now: Date, gate: Gate): Evaluation {
  const o = series.outlook;
  const { symbol, status } = hyperliquidSymbol(series);

  // Most of the feed is neutral: tracked, but no opinion. 64 of 76 on the 2026-08-30
  // capture, 42 of 60 on the 09-10 one, and 53 of 55 on a quiet Saturday — the share has
  // run 84% to 96% and the count has never been a constant. Only `side` is tradeable —
  // the vendor publishes a second, wider opinion on every series including the neutral
  // ones, and reading it is a decision nobody has taken (`docs/STATUS.md` item 28b).
  // ⚠ Do not name that field here: `quotient.test.ts` greps this file for it by name.
  if (o.side === null) {
    return { ok: false, reason: "no-direction", detail: `state=${o.state}${outlookNumbers(o)}`, coin: symbol };
  }
  if (o.status !== "active") {
    return { ok: false, reason: "not-active", detail: `status=${o.status}`, coin: symbol };
  }
  // `coverage` is universe-filling and always neutral, so it never reaches here; the
  // live question is `signal` (two venues disagree) vs `projection` (Q's model vs spot).
  if (!gate.allowedModes.includes(series.mode)) {
    return { ok: false, reason: "mode-excluded", detail: `mode=${series.mode}`, coin: symbol };
  }
  if (o.strength !== null && !gate.allowedStrengths.includes(o.strength)) {
    return { ok: false, reason: "strength-excluded", detail: `strength=${o.strength}`, coin: symbol };
  }
  if (symbol === null) {
    return { ok: false, reason: "unmapped-symbol", detail: `no hyperliquid basis group on ${series.series_id}`, coin: null };
  }

  const horizonMs = Date.parse(o.anchor_at) - now.getTime();
  if (!Number.isFinite(horizonMs)) {
    return { ok: false, reason: "horizon-passed", detail: `unparseable anchor_at=${o.anchor_at}`, coin: symbol };
  }
  if (horizonMs <= 0) {
    return { ok: false, reason: "horizon-passed", detail: `anchor_at ${o.anchor_at} is in the past`, coin: symbol };
  }
  // ⚠ **This is an entry filter, and the funding argument it was written from is false.**
  // It read *"funding is charged on notional, so at 10x it costs ~2.4%/day of the
  // signal's margin"*, and printed that model into every skipped row the desk shows an
  // owner. Measured over the whole ledger, funding is **0.169% of margin per trip** and
  // is negative on the weekly cell — we are paid — so the stated model was ~28× the cost
  // it described (`notes/2026-09-11-the-anchors-we-trade.md` §2.1). Fees, which it never
  // mentioned, are about twice it.
  //
  // What the constant does is select *when in a forecast's life we enter*: no position in
  // 458 trips has been held past 19.2h, so it has never once bound as a hold cap
  // (`RISK_PARAMS.maxHoldHours` carries the argument, and `tasks/45` the sweep). The
  // detail says that, because a refusal an owner reads should name the rule it applied
  // and not a cost nobody pays.
  const hours = horizonMs / 3_600_000;
  if (hours > gate.maxHoldHours) {
    return {
      ok: false,
      reason: "horizon-too-long",
      detail: `${hours.toFixed(1)}h to this outlook's deadline, cap ${gate.maxHoldHours}h ` +
        "— an entry filter on how far out the forecast still runs, not a limit on how long we hold",
      coin: symbol,
    };
  }

  // Gate on displacement in sigmas, never on a raw percentage: a 1.5% edge over a
  // 30-minute horizon is 5σ, the same 1.5% over a week is noise.
  if (Math.abs(o.displacement_sigma) < gate.minDisplacementSigma) {
    return {
      ok: false,
      reason: "displacement-below-gate",
      detail: `|${o.displacement_sigma.toFixed(2)}σ| < ${gate.minDisplacementSigma}σ`,
      coin: symbol,
    };
  }
  if (!(o.sigma_total > 0) || !(o.median_price > 0) || !(o.spot_at_obs > 0)) {
    return { ok: false, reason: "not-active", detail: "sigma_total / median_price / spot missing", coin: symbol };
  }

  return {
    ok: true,
    call: {
      provider: "quotient",
      signalRef: stableOutlookId(o.outlook_id),
      signalRevision: o.revision,
      coin: symbol,
      side: o.side,
      targetPx: o.median_price,
      sigmaTotal: o.sigma_total,
      displacementSigma: o.displacement_sigma,
      observedSpot: o.spot_at_obs,
      observedAt: o.observed_at,
      horizonAt: o.anchor_at,
      mappingStatus: status,
      mode: series.mode,
      strength: o.strength,
      headline: series.headline,
      assetClass: series.asset_class,
      anchorType: series.anchor_type,
    },
  };
}

/** Displacement recomputed against the price we can actually trade at.
 *
 *  Reverse-engineered from the capture and exact to 1e-13 on all 12 directional
 *  series: `displacement_sigma = ln(median_price / ref_median) / sigma_total`, with
 *  `ref_median == spot_at_obs` throughout. It is a **log**-return z-score, so
 *  `sigma_total` is log-volatility — the linear form `(median/spot − 1)/sigma` is
 *  wrong by 4% on BTC's −2.57σ, which is the difference between passing and failing
 *  a 2.5σ gate.
 *
 *  The published number is measured against the vendor's observed spot, which is up
 *  to one poll interval stale — 30 minutes at the current 1800s interval. If the
 *  market has already walked to the target the edge is gone and the published sigma
 *  count is a fiction, so the live gate uses this and the store keeps both. */
export function liveDisplacementSigma(call: SignalCall, markPx: number): number {
  return Math.log(call.targetPx / markPx) / call.sigmaTotal;
}
