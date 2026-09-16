import type { DesiredOrder, LiveOrder, LivePosition } from "../types.ts";
import { intentPrefix, parseCloid } from "../hl/cloid.ts";

// Diff the desired order set against what is actually resting, and emit only the
// delta. Pure: no clients, no clock, no database.

export type ReconcileAction =
  | { kind: "place"; order: DesiredOrder }
  | { kind: "cancel"; order: LiveOrder; reason: "unwanted" | "wrong-size" | "wrong-trigger" | "duplicate" };

export type ReconcilePlan = {
  actions: ReconcileAction[];
  /** Orders on the account that carry no tag of ours. Non-empty ⇒ halt. */
  foreignOrders: LiveOrder[];
  /** Positions on the account that no live intent claims. Non-empty ⇒ halt. */
  foreignPositions: LivePosition[];
};

export type ReconcileInput = {
  desired: DesiredOrder[];
  orders: LiveOrder[];
  positions: LivePosition[];
  /** Intent ids that are still live. Anything on the venue tagged for an intent
   *  outside this set is our own leftover and gets cancelled, not halted on. */
  liveIntentIds: string[];
  /** Coins a live intent legitimately holds a position in. */
  claimedCoins: string[];
  /** Lot size, for comparing an order's size to what we want. */
  szDecimalsFor: (coin: string) => number;
};

/** Two sizes are the same order if they agree to the asset's lot. */
function sameSize(a: number, b: number, szDecimals: number): boolean {
  return Math.abs(a - b) < 0.5 * 10 ** -szDecimals;
}

/** Trigger prices are compared exactly: we always send a quantised price, so a
 *  difference here is a genuinely different order, not float noise. */
function sameTrigger(a: number | null, b: number | undefined, szDecimals: number): boolean {
  if (a === null && b === undefined) return true;
  if (a === null || b === undefined) return false;
  return Math.abs(a - b) < 0.5 * 10 ** -(6 - szDecimals);
}

export function reconcile(i: ReconcileInput): ReconcilePlan {
  const livePrefixes = new Set(i.liveIntentIds.map(intentPrefix));
  const desiredByKey = new Map(i.desired.map((d) => [`${intentPrefix(d.intentId)}|${d.role}`, d]));

  const actions: ReconcileAction[] = [];
  const foreignOrders: LiveOrder[] = [];
  const seen = new Set<string>();
  const matched = new Set<string>();

  for (const o of i.orders) {
    const tag = parseCloid(o.cloid);
    // Anything we did not create halts the account. We do not cancel it: it is not
    // ours to cancel, and on a client's account that distinction is the product.
    if (tag === null) {
      foreignOrders.push(o);
      continue;
    }
    const key = `${tag.intentPrefix}|${tag.role}`;
    if (seen.has(key)) {
      actions.push({ kind: "cancel", order: o, reason: "duplicate" });
      continue;
    }
    seen.add(key);

    const want = desiredByKey.get(key);
    if (!want || !livePrefixes.has(tag.intentPrefix)) {
      actions.push({ kind: "cancel", order: o, reason: "unwanted" });
      continue;
    }
    const szDec = i.szDecimalsFor(o.coin);
    if (!sameSize(o.sz, want.sz, szDec)) {
      // The usual cause is a partial fill: the position shrank or grew, so the exit
      // covering it has to be re-sized. Cancel-and-replace, never leave a stop that
      // covers the wrong amount.
      actions.push({ kind: "cancel", order: o, reason: "wrong-size" });
      continue;
    }
    if (!sameTrigger(o.triggerPx, want.triggerPx, szDec)) {
      actions.push({ kind: "cancel", order: o, reason: "wrong-trigger" });
      continue;
    }
    matched.add(key);
  }

  for (const [key, d] of desiredByKey) {
    if (!matched.has(key)) actions.push({ kind: "place", order: d });
  }

  const claimed = new Set(i.claimedCoins);
  const foreignPositions = i.positions.filter((p) => p.szi !== 0 && !claimed.has(p.coin));

  return { actions, foreignOrders, foreignPositions };
}

/** A position with no venue-side stop resting against it is the highest-priority
 *  thing the loop can fix — it is the exact state that cost OutcomeMaker 270 units.
 *  Placements are ordered so stops go first, then targets, then entries. */
export function orderActions(actions: ReconcileAction[]): ReconcileAction[] {
  const rank = (a: ReconcileAction): number => {
    if (a.kind === "cancel") return a.reason === "wrong-size" || a.reason === "wrong-trigger" ? 0 : 3;
    return { sl: 1, close: 1, tp: 2, entry: 4 }[a.order.role];
  };
  return [...actions].sort((a, b) => rank(a) - rank(b));
}
