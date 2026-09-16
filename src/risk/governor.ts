import type { HaltKind, Side, SkipReason } from "../types.ts";
import { checkCapacity, type Book } from "./capacity.ts";
import { cents, dailyLossBreached, dayLossFrac, fitsBudget, type Allocation } from "./ledger.ts";
import { RISK_PARAMS, reserveFor, type UserSettings } from "./params.ts";

// The pre-trade check. **It is a veto, not an advisor** — nothing signs an order
// without passing through here, and it can only ever say no.
//
// It runs on a live account read (docs/ARCHITECTURE.md §4): Hyperliquid is
// authoritative for free collateral and margin, so the caller re-reads before every
// decision and hands the numbers in. Everything below is pure and tested.

export type GovernorInput = {
  halted: boolean;
  /** Which way the position would go. The capacity check is asymmetric: a long has to
   *  sell into the bids to leave, a short has to buy back through the asks. */
  side: Side;
  haltReason: string | null;
  /** Seconds since the last successful signal poll. A dead feed stops us opening;
   *  it never touches existing positions, whose stops live on the venue. */
  feedAgeSec: number;
  allocation: Allocation;
  settings: UserSettings;
  /** Collateral the venue says is actually free right now. */
  freeCollateralUsd: number;
  /** When the agent approval lapses, ms since epoch — or null when there is no
   *  approval to read: a paper account, or a live one whose expiry the venue did not
   *  report. Null never blocks; a missing expiry is not evidence of a near one. */
  agentValidUntil: number | null;
  /** When this signal's thesis expires and we would force-close it whatever the P&L. */
  horizonAt: Date;
  /** The book and the 24h volume for this market, or **null** when we could not read
   *  them.
   *
   *  Null refuses. That is deliberate and it is the same posture as everywhere else
   *  here: an account we cannot fully verify is one we do not trade, and a book we
   *  cannot see is one we cannot promise to get out of. Cassie's Polymarket adapter
   *  reaches the same default by catching every volume error and returning 0, which is
   *  below any floor — `tasks/07` calls that fail-closed behaviour worth copying
   *  deliberately rather than arriving at by accident. */
  capacity: { book: Book; volume24hUsd: number } | null;
  now: Date;
};

export type GovernorVerdict =
  | { approved: true; marginUsd: number }
  | { approved: false; reason: SkipReason; detail: string };

export function preTradeCheck(i: GovernorInput): GovernorVerdict {
  if (i.halted) {
    return { approved: false, reason: "account-halted", detail: i.haltReason ?? "halted" };
  }
  if (i.feedAgeSec > RISK_PARAMS.staleFeedSec) {
    return {
      approved: false,
      reason: "stale-feed",
      detail: `last successful poll ${Math.round(i.feedAgeSec / 60)} min ago ` +
        `(cap ${Math.round(RISK_PARAMS.staleFeedSec / 60)} min)`,
    };
  }
  if (dailyLossBreached(i.allocation)) {
    return {
      approved: false,
      reason: "account-halted",
      detail: `daily loss ${(dayLossFrac(i.allocation) * 100).toFixed(1)}% ≥ ` +
        `${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% cap`,
    };
  }

  // Hyperliquid prunes an API wallet when its approval lapses, and there is no
  // "extend" — renewing means the master wallet approving again, which is a human
  // action we cannot take and cannot schedule. An approval that runs out mid-position
  // leaves us able to read the account but not to place the order that closes it, so
  // the force-close we promise at horizon would simply fail.
  //
  // Every intent's rationale tells the user "Closes at <horizon> whatever the P&L".
  // Opening one we already know we could not close would make that sentence false at
  // the moment it was written, so this refuses the signal instead.
  //
  // It covers the already-lapsed case for free: every horizon is past a `validUntil`
  // in the past, so once an approval expires every signal skips here with a recorded
  // reason — rather than the account continuing to look healthy right up until the
  // first order fails to sign.
  if (i.agentValidUntil !== null && i.horizonAt.getTime() > i.agentValidUntil) {
    const days = (i.agentValidUntil - i.now.getTime()) / 86_400_000;
    return {
      approved: false,
      reason: "agent-expires-before-horizon",
      detail: days <= 0
        ? `the agent approval lapsed ${Math.abs(days).toFixed(1)} days ago — re-approve it ` +
          "on Hyperliquid (approving again replaces it; there is no extend)"
        : `the agent approval lapses in ${days.toFixed(1)} days, before this signal's horizon ` +
          `at ${i.horizonAt.toISOString()} — we could not close it`,
    };
  }

  const budget = fitsBudget(i.allocation, i.settings);
  if (!budget.fits) return { approved: false, reason: budget.reason, detail: budget.detail };

  // Can the book let us out? Checked here rather than after `buildIntent` so there is
  // one veto path and nothing routes around it, which is why `checkCapacity` takes a
  // notional rather than a lot-rounded size.
  //
  // The notional is computed at the user's *requested* leverage, before the per-asset
  // clamp `buildIntent` applies. That can overstate the position on a market whose max
  // leverage is below the user's setting — which makes this check stricter than the
  // order it is checking, and stricter is the safe direction for a veto.
  if (i.capacity === null) {
    return {
      approved: false,
      reason: "thin-book",
      detail: "could not read the order book — refusing rather than sizing into a book we cannot see",
    };
  }
  const cap = checkCapacity({
    side: i.side,
    book: i.capacity.book,
    volume24hUsd: i.capacity.volume24hUsd,
    desiredNotionalUsd: budget.marginUsd * i.settings.leverage,
    slippageBps: RISK_PARAMS.slippageBps,
    floors: RISK_PARAMS.capacity,
  });
  if (!cap.ok) return { approved: false, reason: cap.reason, detail: cap.detail };

  // Never post the last of the collateral. The reason is **not** the one this check
  // was written with: funding does not come out of free collateral. Measured on
  // mainnet across a funding hour — 17 isolated positions, 11 accounts — every charge
  // landed on the position's own isolated margin and free collateral did not move,
  // including on accounts holding thousands of dollars of it
  // (`notes/2026-09-04-isolated-margin-and-the-reserve.md`). What the reserve actually
  // covers is entry fees, at most 0.90% of the mandate for a full book.
  //
  // Sizing already runs off `baseCapital − reserve`, so on a whole account this check
  // is arithmetic that comes out even. It bites when the venue disagrees with our
  // frozen base — an account that is **down**, whose equity no longer covers the
  // mandate it agreed to. That is the case `maxDeployedPct = 0.50` used to absorb
  // silently and `1.00` does not, and reporting it as `insufficient-collateral` is the
  // true reason rather than a `no-budget` that would blame our own cap.
  //
  // Compared to the cent for the same reason `fitsBudget` is: the last position of a
  // full book lands *exactly* on the reserve, so a raw float comparison would refuse it
  // on dust and undo the raise one position from the end.
  const reserveUsd = reserveFor(i.allocation.baseCapital);
  const after = i.freeCollateralUsd - budget.marginUsd;
  if (cents(after) < cents(reserveUsd)) {
    return {
      approved: false,
      reason: "insufficient-collateral",
      detail: `$${i.freeCollateralUsd.toFixed(2)} free, posting $${budget.marginUsd.toFixed(2)} ` +
        `would leave $${after.toFixed(2)} against a $${reserveUsd.toFixed(2)} reserve ` +
        `(${(RISK_PARAMS.reserveFrac * 100).toFixed(0)}% of the mandate)`,
    };
  }

  return { approved: true, marginUsd: budget.marginUsd };
}

/** `sticky` decides whether the halt outlives the condition that caused it.
 *
 *  A foreign position or a breached daily-loss cap is sticky: it is persisted to the
 *  account row and needs a person to clear it, because "the condition went away" is
 *  not evidence the account is safe — a hand-placed position that gets closed still
 *  means someone else is trading here.
 *
 *  The operator halt file is **not** sticky. It stops opening while it exists and
 *  stops stopping when it is removed, which is what makes it a usable kill switch. */
export type HaltCheck =
  | { halt: true; reason: string; sticky: boolean; kind: HaltKind }
  | { halt: false };

/** Conditions that halt an account outright, checked every loop before anything else.
 *
 *  The foreign-actor rule is the honest failure mode: a halt says "someone else traded
 *  here", which is true and actionable, rather than silently trading on a wrong
 *  picture. We cannot prevent the user trading their own account — they hold the
 *  master key, as they should — so we detect it. */
export function haltCheck(i: {
  foreignOrders: number;
  foreignPositions: number;
  allocation: Allocation;
  globalHalt: boolean;
}): HaltCheck {
  if (i.globalHalt) return { halt: true, reason: "operator halt file present", sticky: false, kind: "operator" };
  if (i.foreignPositions > 0) {
    return {
      halt: true,
      sticky: true,
      kind: "foreign-position",
      reason: `${i.foreignPositions} position(s) on this account were not opened by us — ` +
        "the account has a second actor and our position accounting can no longer be trusted",
    };
  }
  if (i.foreignOrders > 0) {
    return {
      halt: true,
      sticky: true,
      kind: "foreign-order",
      reason: `${i.foreignOrders} open order(s) on this account were not placed by us`,
    };
  }
  if (dailyLossBreached(i.allocation)) {
    return {
      halt: true,
      sticky: true,
      kind: "daily-loss",
      reason: `daily loss ${(dayLossFrac(i.allocation) * 100).toFixed(1)}% reached the ` +
        `${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% cap`,
    };
  }
  return { halt: false };
}
