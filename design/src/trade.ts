// Turning prices into the two numbers people actually ask about: how far, and what
// that was worth.
//
// Kept out of `dom.ts` on purpose — that file is formatting helpers that know nothing
// about this product, and every function here knows that a short profits when the
// price falls and that leverage multiplies both directions. Pure and separately
// tested, because these are the figures somebody will check against their own
// Hyperliquid screen.

export type Side = "long" | "short";

/** How far a price sits from entry, **signed by profit** rather than by direction.
 *
 *  Positive always means "this went your way". A short profits when the price falls,
 *  so the raw percentage is flipped — without which a short's stop reads `+3.01%`,
 *  which is a 3% loss wearing a plus sign. */
export function movePct(entryPx: number | null, px: number | null, side: Side): number | null {
  if (entryPx == null || px == null || !(entryPx > 0) || !Number.isFinite(px)) return null;
  const raw = (px - entryPx) / entryPx * 100;
  return side === "long" ? raw : -raw;
}

/** The same move as a share of the margin behind it.
 *
 *  This is the answer to "what does a 1σ forecast mean in profit": on its own a 0.85%
 *  move is nothing, and at 10× it is 8.5% of the money committed. It is also why a 3%
 *  stop costs 30% of a position's margin — the number the connect screen already
 *  states before anybody chooses a leverage. */
export function onMarginPct(movePercent: number | null, leverage: number): number | null {
  if (movePercent == null || !Number.isFinite(leverage)) return null;
  return movePercent * leverage;
}

/** `n` as a percentage of `d`, or null when either is unknown or `d` is zero.
 *
 *  Every P&L figure on the desk carries this beside its dollars (`tasks/19` §1), and
 *  the rule is that the denominator is named where it is shown: today's result is a
 *  share of the day's opening equity, the week's is a share of the mandate, a
 *  position's is a share of the margin it posted. Null draws a dash, never `0%` — the
 *  same rule `fmtUsd` follows for a venue we could not reach. */
export function share(n: number | null, d: number | null): number | null {
  if (n == null || d == null || !Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return n / d * 100;
}

/** `+0.85%` / `−3.00%`, with a real minus sign rather than a hyphen. */
export function pct(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "+";
  return sign + Math.abs(n).toFixed(digits) + "%";
}

/** `+0.85% → +8.5% of margin`, or just the move when leverage says nothing new.
 *
 *  Returns "" when there is no move to report, so a caller can append it to a price
 *  without having to decide whether it is there. */
export function moveAndGain(
  entryPx: number | null, px: number | null, side: Side, leverage: number,
  opts: { suffix?: string } = {},
): string {
  const move = movePct(entryPx, px, side);
  if (move === null) return "";
  const gain = onMarginPct(move, leverage);
  // One decimal on the margin figure: it is an order-of-magnitude statement ("about a
  // tenth of what you put in"), and two decimals invite a precision it does not have
  // once fees and slippage are in.
  return ` · ${pct(move)} → ${pct(gain, 1)}${opts.suffix ?? ""}`;
}
