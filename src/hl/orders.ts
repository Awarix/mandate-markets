import type { ExchangeClient } from "@nktkas/hyperliquid";
import type { DesiredOrder, PlaceResult } from "../types.ts";
import type { Market } from "../mapping/intent.ts";
import type { BuilderConfig } from "./approve-builder-fee.ts";
import { pxToWire, szToWire } from "./numbers.ts";
import { RISK_PARAMS } from "../risk/params.ts";

// The order layer. Three decisions here are load-bearing.
//
// **1. No attached TP/SL children. Ever.**
// HL places a parent's child orders only if the parent *fully* fills. A parent that
// partially fills and is then cancelled has its children cancelled too — so a partial
// fill we leave open carries **no stop**. That is precisely the failure mode that rode
// 270 units to a zero settle on OutcomeMaker. So we never use `normalTpsl` /
// `positionTpsl` groupings against an entry. The entry goes in alone as IOC, we read
// the size that actually filled, and the exits are placed as independent reduce-only
// trigger orders sized to that. "A position with no stop" becomes a state the
// reconcile loop can see and fix in the next second, instead of a venue behaviour we
// cannot observe.
//
// **2. Trigger orders are limits, not markets.**
// A market trigger carries a 10% slippage tolerance. On a stop that is the difference
// between a planned 30%-of-margin loss and most of the position. We set an explicit
// limit `slippageBps` past the trigger instead, capping the damage. The cost is that a
// violently gapping market can leave the stop unfilled — which the horizon close and
// the reconcile loop then catch.
//
// **3. `expiresAfter` on every action.**
// A dead-man switch, so a stalled process cannot have a stale order land minutes later.

/** Trigger orders fire on **mark** price, not last trade. */
export function toWire(o: DesiredOrder, market: Market) {
  const common = {
    a: market.assetId,
    b: o.isBuy,
    p: pxToWire(o.px, market.szDecimals),
    s: szToWire(o.sz, market.szDecimals),
    r: o.reduceOnly,
  };
  if (o.triggerPx !== undefined) {
    return {
      ...common,
      t: {
        trigger: {
          isMarket: false,
          triggerPx: pxToWire(o.triggerPx, market.szDecimals),
          tpsl: (o.role === "tp" ? "tp" : "sl") as "tp" | "sl",
        },
      },
    };
  }
  return { ...common, t: { limit: { tif: (o.ioc ? "Ioc" : "Gtc") as "Ioc" | "Gtc" } } };
}

/** `builder` is the **resolved** config for this account — present only when its owner
 *  has approved at least the rate we charge — and it is a parameter rather than a
 *  global read on purpose. `builderConfig()` used to be called right here and knew
 *  nothing about whose order it was attaching a fee to, which is the shape that turned
 *  setting one environment variable into a rejected order on every account at once
 *  (`src/hl/approve-builder-fee.ts`). Omitted, the order carries no builder field and
 *  fills exactly as it does today. */
export async function placeOrder(
  ex: ExchangeClient,
  order: DesiredOrder,
  market: Market,
  cloid: `0x${string}`,
  builder?: BuilderConfig,
): Promise<PlaceResult> {
  try {
    const res = await ex.order({
      orders: [{ ...toWire(order, market), c: cloid }],
      grouping: "na",
      ...(builder ? { builder } : {}),
    }, { expiresAfter: Date.now() + RISK_PARAMS.actionExpirySec * 1000 });
    const status = res.response.data.statuses[0];
    if (status === undefined) return { ok: false, cloid, error: "empty status" };
    if (typeof status === "string") {
      // "waitingForFill" / "waitingForTrigger": accepted and resting.
      return { ok: true, cloid, oid: null, filledSz: 0, avgPx: null };
    }
    if ("error" in status) return { ok: false, cloid, error: String(status.error) };
    if ("filled" in status) {
      return { ok: true, cloid, oid: status.filled.oid, filledSz: Number(status.filled.totalSz), avgPx: Number(status.filled.avgPx) };
    }
    return { ok: true, cloid, oid: status.resting.oid, filledSz: 0, avgPx: null };
  } catch (e) {
    return { ok: false, cloid, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Cancel exactly one order of ours. There is no bulk path on purpose: `cancelAll`
 *  would reach orders the user placed, and on a client's account that is not a
 *  tolerable mistake to be one typo away from. */
export async function cancelOrder(ex: ExchangeClient, market: Market, cloid: `0x${string}`): Promise<boolean> {
  try {
    const res = await ex.cancelByCloid({ cancels: [{ asset: market.assetId, cloid }] });
    const s = res.response.data.statuses[0];
    return s === "success";
  } catch {
    // Already gone (filled, triggered, expired) is the common case and is not an error.
    return false;
  }
}

/** Isolated margin, always. Under cross margin a third signal going wrong can
 *  liquidate the first two; isolated makes the per-signal budget literally true. */
export async function setIsolatedLeverage(ex: ExchangeClient, market: Market, leverage: number): Promise<void> {
  await ex.updateLeverage({ asset: market.assetId, isCross: false, leverage });
}
