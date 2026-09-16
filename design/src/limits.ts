// The connect screen's arithmetic, as a pure function.
//
// The card recomputes on every slider drag and cannot round-trip to the server for
// it, so this is a second copy of what `src/risk/halt.ts` computes for the desk and
// for the executor's startup warning. `limits.test.ts` pins this copy to that one at
// the defaults, so the number somebody reads before connecting is the number the desk
// shows them afterwards.

export type LimitsInput = {
  baseUsd: number;
  /** Per-position size, in percent (the slider's unit). */
  perPct: number;
  leverage: number;
  /** Stop distance from entry, in percent. */
  stopPct: number;
  stopOn: boolean;
  /** The widest stop the page allows at this leverage, in percent — the per-asset clamp
   *  (`docs/ACCOUNT-MODEL.md` §5) stated once per leverage tier for a typical market. */
  clampPct: number;
  /** `RISK_PARAMS.dailyLossPct`, as the server sent it. */
  dailyLossPct: number;
  minNotionalUsd: number;
  /** `RISK_PARAMS.reserveFrac`, as the server sent it — the part of the mandate that
   *  is never posted as margin. */
  reserveFrac: number;
};

export type LimitsOut = {
  marginUsd: number;
  notionalUsd: number;
  /** What one stopped-out position costs — the whole margin with the stop off. */
  lossUsd: number;
  /** About how many of those in one day pause the account. */
  stopsToHalt: number;
  /** The smallest deposit that can produce a legal order at these limits. */
  floorUsd: number;
  /** How many positions fit at this size — `floor(1 / perSignalPct)` since `tasks/21`.
   *  The number the card never showed, and the reason the slider looked like it did
   *  nothing above 10%. */
  positions: number;
  /** Margin at work with the book full, and what is left unposted. */
  deployedUsd: number;
  reserveUsd: number;
  /** **Every open position stopping in the same move**, in dollars and as a fraction
   *  of the mandate (`tasks/21` §4). Quotient publishes in same-side batches, so this
   *  is the number that roughly doubled when the deployed cap went to 100% — and the
   *  one an owner should read before turning the stop off. */
  correlatedStopUsd: number;
  correlatedStopOfMandate: number;
};

/** The widest stop worth offering at each leverage tier, in percent of the price:
 *  70% of the distance to liquidation on a typical market (`docs/ACCOUNT-MODEL.md`
 *  §5). Here rather than in one screen's module because two screens now choose
 *  limits — the connect card and the desk's own — and a second copy of 2.6 would let
 *  one of them price a stop the executor clamps. */
export const CLAMP_PCT: Record<number, number> = { 5: 12.5, 10: 6.2, 18: 3.0, 20: 2.6 };

/** `minFundedForLiveUsd()` in src/risk/params.ts, inverted the same way — including
 *  the reserve, which comes off the base before the notional is sized, and the
 *  round-up to the cent that stops a floor being quoted below itself. */
export function floorFor(minNotionalUsd: number, perPct: number, leverage: number, reserveFrac: number): number {
  return Math.ceil(minNotionalUsd / (perPct / 100 * leverage) / (1 - reserveFrac) * 100) / 100;
}

/** `maxConcurrentSignals()` in src/risk/params.ts. `floor`, never `round`: Σ margin
 *  must never be able to exceed the budget. */
export function positionsFor(perPct: number): number {
  return Math.floor(100 / perPct);
}

export function limitsMath(i: LimitsInput): LimitsOut {
  // Off the budget, not off the mandate: the reserve comes out before anything is
  // sized, so `positions × marginUsd` lands on the budget rather than over it.
  const reserveUsd = i.baseUsd * i.reserveFrac;
  const budgetUsd = i.baseUsd - reserveUsd;
  const marginUsd = budgetUsd * i.perPct / 100;
  const notionalUsd = marginUsd * i.leverage;
  const c = Math.min(i.stopPct, i.clampPct);
  // Isolated margin cannot lose more than itself — the same cap `stopOutOfMargin`
  // applies on the server.
  const lossUsd = i.stopOn ? Math.min(marginUsd, notionalUsd * c / 100) : marginUsd;
  const positions = positionsFor(i.perPct);
  const deployedUsd = positions * marginUsd;
  return {
    marginUsd, notionalUsd, lossUsd, positions, deployedUsd, reserveUsd,
    stopsToHalt: (i.baseUsd * i.dailyLossPct) / lossUsd,
    floorUsd: floorFor(i.minNotionalUsd, i.perPct, i.leverage, i.reserveFrac),
    correlatedStopUsd: positions * lossUsd,
    correlatedStopOfMandate: i.baseUsd > 0 ? (positions * lossUsd) / i.baseUsd : 0,
  };
}

/** Which warning the limits card shows. The four states below the floor check are the
 *  same on the connect screen and on the desk and only the wording differs, so the
 *  *thresholds* live here and each screen supplies its own markup. A second copy of
 *  `< 2` is how one of them came to tell an owner at 0.63 that "two bad days" would
 *  pause them — the sentence the account that halted on 2026-09-08 read at the moment
 *  it chose that setting (`notes/2026-09-09-daily-loss-halt-first-fire.md` §3.1,
 *  `tasks/30` §3).
 *
 *  Under the floor comes first: it is the only state where *nothing* trades, which
 *  beats every warning about trading badly. */
export type LimitsNote = "under-floor" | "one-pauses" | "two-pause" | "no-stop" | "ok";

export function limitsNote(i: { underFloor: boolean; stopsToHalt: number; stopOn: boolean }): LimitsNote {
  if (i.underFloor) return "under-floor";
  // `< 1` above `< 2`, because one stopped position reaching the cap is a different
  // statement from two bad days reaching it, and **26 of the 120 combinations the site
  // offers are in that region** — a region `notes/2026-09-02-settings-range.md` §1
  // declined to ship at 50%-per-position and never re-checked at 25%.
  if (i.stopsToHalt < 1) return "one-pauses";
  if (i.stopsToHalt < 2) return "two-pause";
  if (!i.stopOn) return "no-stop";
  return "ok";
}
