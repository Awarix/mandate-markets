import { RISK_PARAMS, maxConcurrentSignals, reserveFor, tradeableBudgetUsd, type UserSettings } from "./params.ts";

// The allocation ledger: pure arithmetic over a frozen base capital.
// docs/ARCHITECTURE.md §4. No exchange calls, no I/O — the governor supplies live
// state, this decides whether a signal fits.
//
// Fixed base, no compounding. $1,000 in, $100 per signal; when the account grows to
// $2,000 the allocation still runs off $1,000 and the surplus sits idle. That is the
// user's stated preference and the right default: risk stays bounded by a number they
// consciously deposited, and a good run cannot silently escalate position size. The
// base moves only when the owner asks and nothing is open (`tasks/18` §4) — pressing
// that button is the same conscious choice.

export type Allocation = {
  /** Frozen at connect and under every open position; re-read at the owner's request
   *  when nothing is (`src/exec/change-queue.ts`). */
  baseCapital: number;
  /** Margin currently posted to our open positions. */
  deployedUsd: number;
  /** Positions we currently hold. */
  openCount: number;
  /** Equity at the start of the current UTC day, for the daily-loss cap. */
  dayStartEquity: number;
  /** Equity now, including unrealised P&L. */
  equityNow: number;
};

export type BudgetVerdict =
  | { fits: true; marginUsd: number }
  | { fits: false; reason: "no-budget" | "max-concurrent"; detail: string };

/** Margin for one signal.
 *
 *  Off the **budget**, not off `baseCapital`: the reserve comes out before anything is
 *  sized, so that `Σ margin` over a full book lands exactly on the budget and free
 *  collateral lands exactly on the reserve (`tasks/21` §6). Sized off the base instead,
 *  the last position of a full book would come back `insufficient-collateral` and the
 *  raised cap would have changed nothing. */
export function perSignalBudget(baseCapital: number, s: UserSettings): number {
  return tradeableBudgetUsd(baseCapital) * s.perSignalPct;
}

export function maxDeployedUsd(baseCapital: number): number {
  return tradeableBudgetUsd(baseCapital) * RISK_PARAMS.maxDeployedPct;
}

/** How many positions this account's own settings allow, and what a full book of them
 *  deploys. The desk and the connect screen both show these, so they are derived once
 *  here rather than recomputed beside each screen. */
export function bookShape(baseCapital: number, s: UserSettings): {
  positions: number;
  marginPerPositionUsd: number;
  deployedAtFullUsd: number;
  reserveUsd: number;
} {
  const positions = maxConcurrentSignals(s);
  const marginPerPositionUsd = perSignalBudget(baseCapital, s);
  return {
    positions,
    marginPerPositionUsd,
    deployedAtFullUsd: positions * marginPerPositionUsd,
    reserveUsd: reserveFor(baseCapital),
  };
}

/** Dollars as whole cents.
 *
 *  `fitsBudget` compares a float *sum* (margin already posted) against a float
 *  *product* (the cap), and at the default settings those two are the same number by
 *  construction: five positions at 10% is exactly the 50% cap. So the last position of
 *  a full book is decided on the fifteenth decimal place, and on 2026-09-04 two live
 *  accounts lost it by **1.2 × 10⁻¹⁴ dollars** — which is why every account on the
 *  default setting has held four positions and not five since the beginning
 *  (`tasks/21` §7).
 *
 *  Quantising both sides to the cent is the fix, and it is the comparison that was
 *  meant all along: margin is money posted to Hyperliquid, which cannot post a
 *  fraction of a cent. A shortfall too small to express in dollars is not a shortfall.
 *  It is not a change of basis — sizing off `base − reserve` was tried against real
 *  balances and nine of fifteen combinations still lost the last position, because
 *  both bases have the sum-versus-product shape that causes this. */
export const cents = (usd: number): number => Math.round(usd * 100);

/** Does one more signal fit?
 *
 *  A signal that does not fit is skipped and logged — we never shrink an existing
 *  position to make room. Existing positions have stops attached; resizing them
 *  invalidates the plan they were opened under. The skip log is itself data about
 *  whether the caps are right. */
export function fitsBudget(a: Allocation, s: UserSettings): BudgetVerdict {
  const maxOpen = maxConcurrentSignals(s);
  if (a.openCount >= maxOpen) {
    return {
      fits: false,
      reason: "max-concurrent",
      detail: `${a.openCount}/${maxOpen} positions open`,
    };
  }
  const want = perSignalBudget(a.baseCapital, s);
  const room = maxDeployedUsd(a.baseCapital) - a.deployedUsd;
  if (cents(want) > cents(room)) {
    return {
      fits: false,
      reason: "no-budget",
      detail: `needs $${want.toFixed(2)}, $${Math.max(0, room).toFixed(2)} left of the ` +
        `$${maxDeployedUsd(a.baseCapital).toFixed(2)} budget`,
    };
  }
  return { fits: true, marginUsd: want };
}

/** Day-over-day loss as a fraction of the day's opening equity. Positive = a loss. */
export function dayLossFrac(a: Allocation): number {
  if (a.dayStartEquity <= 0) return 0;
  return (a.dayStartEquity - a.equityNow) / a.dayStartEquity;
}

export function dailyLossBreached(a: Allocation): boolean {
  return dayLossFrac(a) >= RISK_PARAMS.dailyLossPct;
}

/** UTC day key. The daily-loss cap resets on this boundary, not on a rolling window,
 *  so "what halted us" is answerable from a date. */
export function dayKey(at = new Date()): string {
  return at.toISOString().slice(0, 10);
}
