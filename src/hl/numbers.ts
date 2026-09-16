// Tick and lot arithmetic. Pure, and tested against the SDK's own formatter before
// anything is wired to an exchange.
//
// Hyperliquid's rules (https://hyperliquid.gitbook.io/.../tick-and-lot-size):
//   price — at most 5 significant figures AND at most (6 − szDecimals) decimals for
//           perps; integer prices are always legal regardless of significant figures.
//   size  — truncated to szDecimals.
//
// The SDK ships `formatPrice`, which rounds to the nearest legal price. We need a
// *directional* version as well: a stop rounded away from entry silently widens past
// the liquidation buffer we just proved it was inside. So stops and targets round
// toward entry, which can only ever make them tighter.

/** Legal decimal places for a perp price at this magnitude. */
export function priceDecimals(px: number, szDecimals: number): number {
  const maxDecimals = 6 - szDecimals;
  if (!(px > 0)) return Math.max(0, maxDecimals);
  // 5 significant figures: a price of 78026.5 gets 0 decimals, 218.855 gets 2.
  const sigDecimals = 4 - Math.floor(Math.log10(px));
  return Math.max(0, Math.min(maxDecimals, sigDecimals));
}

/** Quantise a price to a legal Hyperliquid tick, in a chosen direction. */
export function quantizePx(px: number, szDecimals: number, dir: "up" | "down" | "nearest"): number {
  const d = priceDecimals(px, szDecimals);
  const f = 10 ** d;
  const scaled = px * f;
  // Values a hair off an exact multiple (78026.499999999996) must not be pushed a
  // whole tick by ceil/floor. 1e-9 is far below a tick and far above float noise.
  const eps = 1e-9;
  const n = dir === "up" ? Math.ceil(scaled - eps)
    : dir === "down" ? Math.floor(scaled + eps)
      : Math.round(scaled);
  return n / f;
}

/** Sizes always truncate. Rounding a size up spends margin we did not budget. */
export function quantizeSz(sz: number, szDecimals: number): number {
  const f = 10 ** szDecimals;
  return Math.floor(sz * f + 1e-9) / f;
}

/** Wire format. HL wants strings, and `1e-7` or `1.2000000000000002` are rejected. */
export function pxToWire(px: number, szDecimals: number): string {
  return trimNumber(px, priceDecimals(px, szDecimals));
}

export function szToWire(sz: number, szDecimals: number): string {
  return trimNumber(sz, szDecimals);
}

function trimNumber(n: number, decimals: number): string {
  return decimals <= 0 ? String(Math.round(n)) : n.toFixed(decimals).replace(/\.?0+$/, "");
}

/** An exit price rounded so it can only move toward entry, never away from it. */
export function quantizeExitPx(px: number, entryPx: number, szDecimals: number): number {
  return quantizePx(px, szDecimals, px < entryPx ? "up" : "down");
}
