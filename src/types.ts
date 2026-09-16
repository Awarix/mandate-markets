// Domain types shared across mapping, risk, execution and the store.
//
// Deliberately provider-agnostic: nothing below mentions Quotient's field names.
// `src/mapping/` is the only place that knows where a signal came from, so a second
// signal source drops in without touching the executor
// (notes/2026-08-30-deferred-ideas.md).

export type Side = "long" | "short";

/** Why a position left the book. Every close records one.
 *
 *  **`flipped` is not `retired` and the two must never be pooled** (`tasks/44` §3.1).
 *  `retired` means the call went neutral — Quotient stopped having an opinion.
 *  `flipped` means it published the *opposite* one while we held the position, which
 *  is a different fact about the forecast and a different fact about the trade.
 *  `expectancy.ts`, the desk and the share cards all read this column.
 *
 *  **Every value but `liquidated` is written by us**, from our own plan or from which of
 *  our exit orders stopped resting. `liquidated` is the venue's and is the only one we
 *  never chose: Hyperliquid closed the position because the margin ran out. It exists
 *  because the alternative was recording it as `retired` — which is what happened on
 *  2026-09-10, making the worst outcome this system can produce invisible to the
 *  analysis that decides whether the system works
 *  (`notes/2026-09-10-liquidation-and-the-stop-that-did-not-fill.md`).
 *
 *  ⚠ **Append, never insert.** `cards.ts`'s `reasonCode` is the INDEX of the reason in
 *  `CLOSE_REASONS`, and that index is inside the HMAC of every share card already
 *  issued. Inserting a reason mid-list would re-point every live card at a different
 *  sentence. */
export type CloseReason =
  | "target" | "stop" | "horizon" | "retired" | "halt" | "disconnect" | "flipped" | "liquidated";

/** Which condition stopped the account.
 *
 *  - `daily-loss` — equity fell `dailyLossPct` below the day's opening equity. The one
 *    kind whose condition **goes away on its own**, at the UTC boundary, and therefore
 *    the only one the account's owner can clear from the desk (`tasks/30` §1).
 *  - `foreign-position` / `foreign-order` — something on the account was not ours. The
 *    whole content of these is *our position accounting can no longer be trusted*, and
 *    the account's owner is the one person who cannot verify that, since they are the
 *    second actor. Operator-only, and the screen says why rather than showing a
 *    disabled control with no explanation.
 *  - `liquidation` — Hyperliquid closed a position itself. Not a second actor and our
 *    accounting is fine, but the risk machinery did not do its job and somebody should
 *    look before it trades again. Operator-only.
 *  - `operator` — the halt file. Not sticky and never written to a row; it exists here
 *    so the type covers every branch of `haltCheck`. */
export type HaltKind = "daily-loss" | "foreign-position" | "foreign-order" | "liquidation" | "operator";


/** The exit is an object, not a hardcoded take-profit, so laddered / inside-the-target
 *  exits drop in later without reworking the execution path. */
export type ExitPlan = {
  kind: "target-stop-horizon";
  /** Take-profit price. Null when the signal gave no usable target. */
  targetPx: number | null;
  /** Venue-side stop price. Null only when the user turned the stop off. */
  stopPx: number | null;
  /** Close unconditionally at this time — the outlook expired, so the thesis did. */
  horizonAt: string;
  /** What to do when Quotient stops calling a direction before the outlook expires.
   *
   *  **The trigger is almost always the call going neutral, not the series
   *  disappearing.** `loop.ts` keeps a position while its outlook is in the feed with
   *  `side !== null && status === "active"`, so any of three things ends it: the side
   *  goes null, the status leaves `active`, or the series is gone. On the measured
   *  feed the first dominates — Quotient runs ~95% `no-direction`, 53–63 neutral of
   *  56–65 outlooks a day since 2026-09-04 — so "they went neutral on it" describes
   *  this far better than "they withdrew it", and the UI says so.
   *
   *  False — the default, and what every trade in the live ledger was run under —
   *  closes on the next fresh poll that shows the direction gone. True keeps the
   *  position and lets it run to its target, its stop or its horizon.
   *
   *  It never disables the horizon: that is the time stop, it bounds funding cost,
   *  and the backtest's holding column exits through it 18 times in 44. What this
   *  turns off is one exit reason, not the plan. */
  holdToTarget: boolean;
};

export type TradeIntent = {
  intentId: string;
  provider: string;
  /** Stable id of the source signal, so every position traces back to one. */
  signalRef: string;
  signalRevision: number;
  createdAt: string;
  /** Hyperliquid market symbol, exactly as `meta` spells it: "BTC", "xyz:NVDA". */
  coin: string;
  side: Side;
  /** Reference price the sizing was computed from. */
  refPx: number;
  /** Leverage after the per-asset clamp. */
  leverage: number;
  /** Isolated margin posted to this signal. */
  marginUsd: number;
  /** Position size in base units, already lot-rounded. */
  sizeAbs: number;
  exit: ExitPlan;
  /** Human-readable "why", for the dashboard. USER-JOURNEY §5.13. */
  rationale: string;
};

/** Every rejection is recorded with a reason — a user seeing "3 skipped: no budget"
 *  understands the caps are working; a user seeing nothing assumes we are broken. */
export type SkipReason =
  | "no-direction"
  | "not-active"
  | "mode-excluded"
  | "strength-excluded"
  | "displacement-below-gate"
  | "unmapped-symbol"
  | "horizon-too-long"
  | "horizon-passed"
  | "already-open"
  | "stopped-recently"
  /** The forecast in hand was observed by the vendor *before* our own exit on that
   *  outlook, so it cannot have priced the move we just took. Quotient re-bases
   *  `ref_median` to the new spot on the revision that follows a move, and the whole
   *  snapshot — target and `sigma_total` included — moves with it, so the live re-gate
   *  cannot repair it (`notes/2026-09-16-the-snapshot-that-predates-the-fill.md`). */
  | "snapshot-predates-close"
  /** We hold this outlook under `hold_to_target` and it has just flipped side. The
   *  position stays — the policy is frozen at open — and this row is the only record
   *  anywhere that the thesis inverted (`tasks/44` §3.2). Under the default policy the
   *  position closes as `flipped` instead and no skip is written. */
  | "side-flipped"
  | "no-budget"
  | "max-concurrent"
  | "account-halted"
  | "below-min-notional"
  | "stop-inside-liquidation"
  | "insufficient-collateral"
  | "leverage-unavailable"
  | "thin-book"
  | "below-volume-floor"
  | "agent-expires-before-horizon"
  | "stale-feed";

export type Skip = {
  at: string;
  signalRef: string;
  /** The outlook revision this decision was made against. The vendor re-publishes an
   *  outlook with a rising revision — roughly every five hours, measured over 72h of
   *  archive — so this is what distinguishes "we refused the same forecast again" from
   *  "we refused a new one", and it is recorded as a *range* on the stored row rather
   *  than as part of its key. See `Store.recordSkip`. */
  revision: number;
  coin: string | null;
  reason: SkipReason;
  detail: string;
};

/** What we want resting on the venue. The reconcile loop's unit of work. */
export type OrderRole = "entry" | "tp" | "sl" | "close";

export type DesiredOrder = {
  intentId: string;
  role: OrderRole;
  coin: string;
  isBuy: boolean;
  sz: number;
  /** Limit price. For trigger orders this is the (slippage-capped) execution limit. */
  px: number;
  /** Set for tp/sl — the mark price that arms the order. */
  triggerPx?: number;
  reduceOnly: boolean;
  /** IOC for entries and forced closes; Gtc/trigger for resting exits. */
  ioc: boolean;
};

/** What a venue said when we asked it to place an order. A trigger order that is
 *  accepted and resting reports `filledSz: 0` — it has not traded, it is armed. */
export type PlaceResult =
  | { ok: true; cloid: string; oid: number | null; filledSz: number; avgPx: number | null }
  | { ok: false; cloid: string; error: string };

/** A position as the venue reports it. Hyperliquid is authoritative for this. */
export type LivePosition = {
  coin: string;
  /** Signed: positive long, negative short. */
  szi: number;
  entryPx: number;
  marginUsed: number;
  unrealizedPnl: number;
  liquidationPx: number | null;
  leverage: number;
};

/** An order resting on the venue. */
export type LiveOrder = {
  coin: string;
  oid: number;
  cloid: string | null;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  triggerPx: number | null;
  isTrigger: boolean;
  reduceOnly: boolean;
};

/** One read of account truth. Never cached across a decision. */
export type AccountView = {
  at: string;
  /** Perp account value, summed across every dex we touch. */
  equityUsd: number;
  /** Collateral available for a new position. */
  freeUsd: number;
  positions: LivePosition[];
  orders: LiveOrder[];
  /** coin → mark price. */
  marks: Map<string, number>;
};
