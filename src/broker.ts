import type { AccountView, DesiredOrder, PlaceResult } from "./types.ts";
import type { Market } from "./mapping/intent.ts";

export type { PlaceResult };

// The seam between "decide what should be true" and "make it true on a venue".
//
// It sits at the root rather than under `exec/` on purpose: `hl/` implements it and
// `exec/` consumes it, so putting it in either one would make the venue layer depend
// on the layer that drives it, or the reverse. A contract both sides import belongs
// next to the domain types, not inside one of the two.
//
// The reconcile loop, the position lifecycle and every risk check run against this
// interface, so paper and live exercise **the same code**. That is what makes the
// Phase 1 gate — 7 days unattended, zero unexplained intents, no orphaned state after
// a forced restart — a meaningful test of the thing we will later run with money.

export interface Broker {
  readonly mode: "live" | "paper";
  /** Fresh account truth. Never cached across a decision. */
  view(): Promise<AccountView>;
  /** Isolated margin at the intended leverage, before the entry is signed. */
  ensureIsolated(market: Market, leverage: number): Promise<void>;
  place(order: DesiredOrder, market: Market): Promise<PlaceResult>;
  /** Cancel by our own client order id. `cancelAll` is forbidden — the account may
   *  hold orders that are not ours, and cancelling those is not ours to do. */
  cancel(market: Market, cloid: string): Promise<boolean>;
}
