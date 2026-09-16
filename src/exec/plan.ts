import type { CloseReason, DesiredOrder, LivePosition } from "../types.ts";
import type { Market } from "../mapping/intent.ts";
import type { IntentRow } from "../store/db.ts";
import { quantizePx, quantizeSz } from "../hl/numbers.ts";

// What *should* be resting on the venue for one intent, given what is actually there.
//
// The pattern is OutcomeMaker's one genuinely good idea, kept and stripped of
// everything around it: compute a desired set, diff it against reality, emit only the
// delta. Idempotent, restart-safe, self-healing. The difference here is what the
// desired set is derived from — an intent ledger rather than a price grid.
//
// The rule that shapes this file: **exits are sized to the position that actually
// exists**, never to the size we intended. A partial fill therefore gets a stop
// covering exactly what filled, on the next loop at the latest, instead of no stop
// at all (which is what attached TP/SL children give you on HL).

export type PlanContext = {
  now: Date;
  markPx: number;
  slippageBps: number;
  /** Set when something outside the intent forces an exit. */
  forceClose?: CloseReason;
};

export type IntentPlan = {
  intentId: string;
  desired: DesiredOrder[];
  /** Set when this loop should be closing the position rather than holding it. */
  closing: CloseReason | null;
  notes: string[];
};

const bps = (n: number) => n / 10_000;

/** Aggressive rounding: a buy rounds up and a sell rounds down, so a limit meant to
 *  be marketable stays marketable after quantisation. */
function marketableLimit(markPx: number, isBuy: boolean, slippageBps: number, szDecimals: number): number {
  const raw = isBuy ? markPx * (1 + bps(slippageBps)) : markPx * (1 - bps(slippageBps));
  return quantizePx(raw, szDecimals, isBuy ? "up" : "down");
}

/** A trigger order's limit price: past the trigger by the slippage allowance, in the
 *  direction the fill has to go. Capping it is the whole point — a *market* trigger
 *  on HL carries a 10% slippage tolerance, which on a stop is the difference between
 *  the 30%-of-margin loss we planned and most of the position. */
function triggerLimit(triggerPx: number, isBuy: boolean, slippageBps: number, szDecimals: number): number {
  return marketableLimit(triggerPx, isBuy, slippageBps, szDecimals);
}

export function planIntent(
  intent: IntentRow,
  position: LivePosition | null,
  market: Market,
  ctx: PlanContext,
): IntentPlan {
  const notes: string[] = [];
  const isLong = intent.side === "long";
  const held = position ? Math.abs(position.szi) : 0;

  // The time stop is not optional: the outlook has expired, so the thesis has. This
  // is also the exit that bounds funding cost, which at 10x is ~2.4%/day of margin.
  const horizonPassed = Date.parse(intent.horizon_at) <= ctx.now.getTime();
  const closing: CloseReason | null =
    ctx.forceClose ?? (intent.status === "closing" ? (intent.close_reason as CloseReason | null) ?? "retired" : null) ??
    (horizonPassed && held > 0 ? "horizon" : null);

  // Nothing held and nothing to open.
  if (held === 0) {
    if (intent.status !== "pending") return { intentId: intent.intent_id, desired: [], closing, notes };
    if (horizonPassed) {
      return { intentId: intent.intent_id, desired: [], closing: "horizon", notes: ["horizon passed before the entry filled"] };
    }
    if (closing) return { intentId: intent.intent_id, desired: [], closing, notes };
    const sz = quantizeSz(intent.size_abs, market.szDecimals);
    return {
      intentId: intent.intent_id,
      desired: [{
        intentId: intent.intent_id, role: "entry", coin: intent.coin, isBuy: isLong, sz,
        px: marketableLimit(ctx.markPx, isLong, ctx.slippageBps, market.szDecimals),
        reduceOnly: false, ioc: true,
      }],
      closing: null,
      notes,
    };
  }

  // Held, and on the way out: one reduce-only IOC for the whole position. The resting
  // exits are not in the desired set, so reconcile cancels them — a stop left behind a
  // closed position is an order that can re-open it.
  if (closing) {
    return {
      intentId: intent.intent_id,
      desired: [{
        intentId: intent.intent_id, role: "close", coin: intent.coin, isBuy: !isLong, sz: held,
        px: marketableLimit(ctx.markPx, !isLong, ctx.slippageBps, market.szDecimals),
        reduceOnly: true, ioc: true,
      }],
      closing,
      notes,
    };
  }

  // Held and holding: the exits, sized to what is actually there.
  const desired: DesiredOrder[] = [];
  if (intent.stop_px !== null) {
    desired.push({
      intentId: intent.intent_id, role: "sl", coin: intent.coin, isBuy: !isLong, sz: held,
      px: triggerLimit(intent.stop_px, !isLong, ctx.slippageBps, market.szDecimals),
      triggerPx: intent.stop_px, reduceOnly: true, ioc: false,
    });
  } else {
    notes.push("no venue-side stop: the user turned the stop off");
  }
  if (intent.target_px !== null) {
    desired.push({
      intentId: intent.intent_id, role: "tp", coin: intent.coin, isBuy: !isLong, sz: held,
      px: triggerLimit(intent.target_px, !isLong, ctx.slippageBps, market.szDecimals),
      triggerPx: intent.target_px, reduceOnly: true, ioc: false,
    });
  }
  if (held + 1e-12 < intent.size_abs) {
    notes.push(`partial fill: ${held} of ${intent.size_abs} — exits sized to what filled`);
  }
  return { intentId: intent.intent_id, desired, closing: null, notes };
}
