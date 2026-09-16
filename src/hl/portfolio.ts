import type { InfoClient } from "@nktkas/hyperliquid";

// The account's own history, as Hyperliquid keeps it.
//
// This is the one thing on the desk we do not compute. Hyperliquid's `portfolio` info
// endpoint answers with eight series — four whole-account windows and four perp-only —
// each carrying account value and profit-and-loss on the same timestamps. Measured
// 2026-09-08 against our own mainnet account, 18.8 KB and ~1.35 s:
//
//     day       n=13    ~2-hourly    week   n=66
//     month     n=47                 allTime n=34
//
// Three things about it decided the shape of everything below, and all three were
// measured rather than read off the documentation
// (`notes/2026-09-08-balance-chart-feasibility.md`):
//
// **`accountValueHistory` is exactly what `readAccountView` computes.** To the cent, on
// a `unifiedAccount` with a HIP-3 position — the case where the main dex reads
// `accountValue: 0.0` and the money is in spot USDC and an `xyz` dex. So the chart
// cannot disagree with the balance above it, and the cross-dex sum `src/hl/state.ts`
// does by hand comes free here.
//
// **`pnlHistory` is deposit-adjusted and `accountValueHistory` is not.** All-time P&L
// read −$181.25 while account value climbed $0.00 → $115.15 over the same span: the
// difference is money paid in. So the *chart* plots P&L. Drawing account value would
// render a deposit as a vertical climb that reads as profit, which is a lie about
// somebody's money on the screen they opened to check it.
//
// **It is a fixed grid, not an event log, and it is padded backwards with zeros.**
// `0x…dEaD`, an address with no Hyperliquid activity at all, answers with a full
// 13-point day. And a real account funded on 2026-09-03 answers its `week` window
// starting 09-01 with **twelve samples reading `nav: 0.0`** — the grid covers the whole
// window whether or not the account existed for it. Those leading zeros are padding,
// not history, and `trimPadding` below drops them: they cost a third of the chart's
// width drawing an account that did not exist, and they make the percentage beside it
// a division by zero.
//
// **`pnlHistory` is rebased to zero at each window's start.** Measured on the same
// account: `day` and `week` both open at `0.0` and close at +27.31 and +28.65, while
// `allTime` closes at −1638.75. So it is *not* cumulative since the account opened, and
// `changeUsd` below is still a subtraction rather than the last value — the subtraction
// is right under either behaviour, and after trimming the padding the first point is no
// longer necessarily zero, which is exactly when it starts to matter.

/** The four windows the desk offers, in the order they are drawn. The values are
 *  Hyperliquid's own period keys for the **whole-account** series; the `perp*` four are
 *  deliberately unused — an account holding spot USDC as collateral has money the perp
 *  series cannot see, which is the same trap `readAccountView` documents. */
export const PORTFOLIO_WINDOWS = ["day", "week", "month", "allTime"] as const;
export type PortfolioWindow = (typeof PORTFOLIO_WINDOWS)[number];

/** One sample. `nav` is what the account was worth; `pnl` is that less money paid in,
 *  which is the only one of the two it is honest to draw a trend line through. */
export type PortfolioPoint = { t: number; nav: number; pnl: number };

export type PortfolioSeries = {
  points: PortfolioPoint[];
  /** `pnl` at the end of the window less `pnl` at the start of it — what the desk puts
   *  under the balance as *past 7 days*. Null for a window with nothing in it.
   *
   *  A difference and not the last value. Hyperliquid happens to rebase `pnlHistory` to
   *  zero at each window's start, which makes the two equal *before* `trimPadding` and
   *  different after it: on an account younger than the window, the first real sample
   *  is not the window's first sample. The subtraction is correct either way, which is
   *  the reason to write it. */
  changeUsd: number | null;
  /** The window's return: `changeUsd` over the capital that was actually at work for
   *  it. See `modifiedDietz` for what that denominator is and why it is not simply what
   *  the account was worth when the window opened.
   *
   *  A fraction, not a percentage: every ratio crossing this boundary is one, and the
   *  screen multiplies. Null when the denominator is under a dollar, which is the case
   *  that produces `+290,000%` on an account that started at a cent and holds $29 now —
   *  true, useless, and alarming. */
  changePct: number | null;
};

/** Below this, a return is arithmetic rather than information. */
const MIN_BASE_USD = 1;

/** What the money paid in or taken out was, sample by sample.
 *
 *  Not a field Hyperliquid gives us and not one we have to ask for: account value moves
 *  by profit and by flows and by nothing else, so `flow = Δnav − Δpnl` recovers each
 *  one exactly from the two series we already have. A cent of tolerance, because both
 *  arrive as decimal strings. */
function flows(points: readonly PortfolioPoint[]): { t: number; usd: number }[] {
  const out: { t: number; usd: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const usd = (points[i]!.nav - points[i - 1]!.nav) - (points[i]!.pnl - points[i - 1]!.pnl);
    if (Math.abs(usd) > 0.01) out.push({ t: points[i]!.t, usd });
  }
  return out;
}

/** The capital the window's result was earned on.
 *
 *  **Why not just the opening balance.** Divide by that and an account that opened the
 *  window at $1,392, was topped up by $283 along the way and lost $1,532 reads
 *  **−110%** — losing more than everything, which is not a thing that happened and
 *  reads as a bug. Measured on a real account, 2026-09-08.
 *
 *  Modified Dietz is the standard answer: weight each flow by the fraction of the
 *  window it was present for, and divide by the opening balance plus that. The same
 *  account then reads −97.3%, which is what actually happened. Where nothing was paid
 *  in or out — the ordinary case, and every `week` window we have looked at — it is
 *  arithmetically identical to dividing by the opening balance, so this costs nothing
 *  in the common case and only fixes the pathological one.
 *
 *  It is not a claim about a *rate* of return, and the desk does not label it as one:
 *  it says `past 30 days`, not `30-day return`. */
export function modifiedDietz(points: readonly PortfolioPoint[]): number | null {
  const first = points[0], last = points[points.length - 1];
  if (!first || !last) return null;
  const pnl = last.pnl - first.pnl;
  const span = last.t - first.t;
  // One sample, or a window with no time in it: nothing to weight flows by, and no
  // period to have a return over.
  if (span <= 0) return null;
  let base = first.nav;
  for (const f of flows(points)) base += ((span - (f.t - first.t)) / span) * f.usd;
  return base >= MIN_BASE_USD ? pnl / base : null;
}

/** Drop the leading samples from before the account held anything.
 *
 *  Hyperliquid fills every window's grid whether or not the account existed for it, so
 *  an account funded four days ago has twelve `nav: 0.0` samples at the front of its
 *  `week`. Drawing them spends a third of the chart on a flat line at zero, and
 *  dividing by the first one to get a percentage is a division by zero.
 *
 *  **Leading only.** An account really can go to zero — one of ours was emptied to $0
 *  after a halt — and a return to zero in the middle of a window is the single most
 *  important thing a chart of somebody's money can show. */
function trimPadding(points: PortfolioPoint[]): PortfolioPoint[] {
  let i = 0;
  while (i < points.length && points[i]!.nav === 0) i++;
  // All zeros is an account that has never held anything: keep it, so the desk draws a
  // flat line and says $0.00 rather than showing the card's "no history" sentence,
  // which would be a different and wrong claim.
  return i === points.length ? points : points.slice(i);
}

export type Portfolio = Record<PortfolioWindow, PortfolioSeries>;

/** A `[timestamp, "123.45"]` pair, which is how both series arrive. */
function num(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Zip the two series on their shared timestamps.
 *
 *  They have always arrived the same length on the same grid, and this does not rely on
 *  that: it walks account value and looks P&L up by timestamp, so a mismatch drops the
 *  affected points instead of pairing a value with the wrong day's profit. Every
 *  measured response had `accountValueHistory.length === pnlHistory.length`.
 */
export function toSeries(
  accountValueHistory: readonly (readonly [number, string])[],
  pnlHistory: readonly (readonly [number, string])[],
): PortfolioSeries {
  const pnlAt = new Map(pnlHistory.map(([t, v]) => [t, num(v)]));
  const points: PortfolioPoint[] = [];
  for (const [t, v] of accountValueHistory) {
    const pnl = pnlAt.get(t);
    if (pnl === undefined) continue;
    points.push({ t, nav: num(v), pnl });
  }
  const kept = trimPadding(points);
  const first = kept[0], last = kept[kept.length - 1];
  const changeUsd = first && last ? last.pnl - first.pnl : null;
  return { points: kept, changeUsd, changePct: modifiedDietz(kept) };
}

/** Every window for one account, in one request.
 *
 *  The endpoint returns all eight whether or not we want them, so there is nothing to
 *  save by asking for one — which is why the desk gets the lot and switches tabs
 *  without another round trip. */
export async function readPortfolio(info: InfoClient, master: `0x${string}`): Promise<Portfolio> {
  const raw = await info.portfolio({ user: master });
  const byPeriod = new Map(raw);
  const out = {} as Portfolio;
  for (const w of PORTFOLIO_WINDOWS) {
    const d = byPeriod.get(w);
    out[w] = d ? toSeries(d.accountValueHistory, d.pnlHistory) : { points: [], changeUsd: null, changePct: null };
  }
  return out;
}
