import type { Side } from "../types.ts";
import { quantizeExitPx, quantizeSz } from "../hl/numbers.ts";

// Sizing, the leverage clamp, the stop clamp and the liquidation-buffer check.
// Pure functions only — they get tests before anything is wired to an exchange.
// The math is worked in docs/ACCOUNT-MODEL.md §4–§5.

/** HL maintenance margin rate is 1 / (2 × the tier's max leverage). */
export function maintenanceMarginRate(assetMaxLeverage: number): number {
  return 1 / (2 * assetMaxLeverage);
}

/** Adverse move to liquidation on an isolated position, as a fraction of entry:
 *  `x_liq = 1/L − 1/(2·Lmax)`. Ignores fees and funding, both of which make it
 *  nearer, never further — so this is the optimistic bound. */
export function liqDistanceFrac(leverage: number, assetMaxLeverage: number): number {
  return 1 / leverage - maintenanceMarginRate(assetMaxLeverage);
}

/** 20x is simply unavailable on a third of the universe — 5 of the 16 symbols
 *  Quotient references cap at 10x. Clamping is silent to the venue but must not be
 *  silent to the user: the caller reports `clamped`. */
export function clampLeverage(requested: number, assetMaxLeverage: number): { leverage: number; clamped: boolean } {
  const leverage = Math.min(requested, assetMaxLeverage);
  return { leverage, clamped: leverage < requested };
}

/** The widest stop that still fires well before liquidation. */
export function maxStopPct(leverage: number, assetMaxLeverage: number, liqBufferFrac: number): number {
  return liqBufferFrac * liqDistanceFrac(leverage, assetMaxLeverage);
}

/** The user's stop percentage, clamped per asset and per leverage.
 *
 *  This is not a formality. On a 20x-max asset at 20x, liquidation sits at 2.5%, so a
 *  3% stop would never fire — the position is gone first — and the clamped maximum
 *  there is 1.75%.
 *
 *  ⚠ **The default is 2% since 2026-09-12 and it does NOT clear that clamp at every
 *  leverage.** It clears it at 5x, 10x and 18x and is clamped to 1.75% at 20x on a
 *  20x-max market — which is the whole reason `SITE_OFFERS` gained an 18x tier the same
 *  day (`notes/2026-09-12-how-a-20x-account-arms-a-2-percent-stop.md`): 18x is the
 *  highest leverage that arms the shipped default in full. So the clamp now binds on the
 *  default itself for one tier, not only on a stop the user widened. It binds harder
 *  above that: the site offers up to 8%, one live account runs 8%, and at 10x on a
 *  20x-max market 8% arms 5.25%. */
export function clampStopPct(
  requestedPct: number,
  leverage: number,
  assetMaxLeverage: number,
  liqBufferFrac: number,
): { stopPct: number; clamped: boolean } {
  const max = maxStopPct(leverage, assetMaxLeverage, liqBufferFrac);
  const stopPct = Math.min(requestedPct, max);
  return { stopPct, clamped: stopPct < requestedPct };
}

/** Loss when the stop fires, as a fraction of the signal's margin: `stopPct × L`.
 *  This is the number to show the user when they move the sliders — not the leverage.
 *  A 3% stop at 10x costs 30% of the margin; the same stop at 20x costs 60%. */
export function stopLossFracOfMargin(stopPct: number, leverage: number): number {
  return stopPct * leverage;
}

export function stopPrice(entryPx: number, side: Side, stopPct: number): number {
  return side === "long" ? entryPx * (1 - stopPct) : entryPx * (1 + stopPct);
}

/** True when a target is on the right side of entry to be a take-profit at all.
 *  A "long" whose target sits below spot is a contradiction we refuse to trade. */
export function targetIsAhead(entryPx: number, side: Side, targetPx: number): boolean {
  return side === "long" ? targetPx > entryPx : targetPx < entryPx;
}

export type SizeInput = {
  marginUsd: number;
  leverage: number;
  refPx: number;
  szDecimals: number;
  minOrderNotionalUsd: number;
};

export type SizeResult =
  | { ok: true; sizeAbs: number; notionalUsd: number }
  | { ok: false; reason: "below-min-notional" | "rounds-to-zero"; notionalUsd: number };

/** Isolated margin: `M = perSignalPct × baseCapital`, notional `N = M × L`, and the
 *  size is `N / px` truncated to the asset's lot. Truncation only ever spends less
 *  margin than budgeted, which is the safe direction — but it can also drop the
 *  order below HL's $10 minimum notional, so that is checked after rounding. */
export function computeSize(i: SizeInput): SizeResult {
  const sizeAbs = quantizeSz((i.marginUsd * i.leverage) / i.refPx, i.szDecimals);
  const notionalUsd = sizeAbs * i.refPx;
  if (sizeAbs <= 0) return { ok: false, reason: "rounds-to-zero", notionalUsd };
  if (notionalUsd < i.minOrderNotionalUsd) return { ok: false, reason: "below-min-notional", notionalUsd };
  return { ok: true, sizeAbs, notionalUsd };
}

export type ExitPrices = {
  stopPx: number | null;
  targetPx: number | null;
  /** Distance from entry to the stop, after clamping and tick rounding. */
  effectiveStopPct: number;
};

/** Turn an entry price and a clamped stop percentage into venue prices, rounded so
 *  they can only move toward entry — a stop rounded outward would silently widen
 *  past the liquidation buffer we just proved it was inside. */
export function computeExitPrices(
  entryPx: number,
  side: Side,
  stopPct: number,
  stopEnabled: boolean,
  targetPx: number | null,
  szDecimals: number,
): ExitPrices {
  const rawStop = stopPrice(entryPx, side, stopPct);
  const stop = stopEnabled ? quantizeExitPx(rawStop, entryPx, szDecimals) : null;
  const target = targetPx !== null && targetIsAhead(entryPx, side, targetPx)
    ? quantizeExitPx(targetPx, entryPx, szDecimals)
    : null;
  return {
    stopPx: stop,
    targetPx: target,
    effectiveStopPct: stop === null ? 0 : Math.abs(entryPx - stop) / entryPx,
  };
}

/** The veto that makes a stop meaningful: it must sit strictly inside the liquidation
 *  buffer. Checked on the *rounded* price actually going to the venue, not on the
 *  percentage we intended, because rounding is the last thing that can break it. */
export function stopIsInsideLiqBuffer(
  effectiveStopPct: number,
  leverage: number,
  assetMaxLeverage: number,
  liqBufferFrac: number,
): boolean {
  // 1e-12 absorbs the float error of a stop that lands exactly on the clamp.
  return effectiveStopPct <= maxStopPct(leverage, assetMaxLeverage, liqBufferFrac) + 1e-12;
}
