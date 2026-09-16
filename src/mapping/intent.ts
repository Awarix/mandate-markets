import { randomUUID } from "node:crypto";
import type { Skip, SkipReason, TradeIntent } from "../types.ts";
import type { SignalCall } from "./quotient.ts";
import type { UserSettings } from "../risk/params.ts";
import { RISK_PARAMS } from "../risk/params.ts";
import {
  clampLeverage, clampStopPct, computeExitPrices, computeSize, stopIsInsideLiqBuffer,
  stopLossFracOfMargin,
} from "../risk/sizing.ts";

// A gated `SignalCall` plus a market and a margin budget becomes a `TradeIntent`.
// Still pure: the caller supplies the market (resolved from live HL `meta`), the
// live mark and the budget the governor approved.

/** One HL market, as resolved from live `meta` — never hardcoded. */
export type Market = {
  coin: string;
  assetId: number;
  /** "" for the main perp dex, otherwise the HIP-3 dex name ("xyz"). */
  dex: string;
  szDecimals: number;
  /** Base-tier max leverage. Sets both the leverage clamp and the maintenance rate. */
  maxLeverage: number;
};

export type BuildResult =
  | { ok: true; intent: TradeIntent; notes: string[] }
  | { ok: false; reason: SkipReason; detail: string };

/** Build the intent. Every rejection here is a skip with a reason, never a silent drop. */
export function buildIntent(
  call: SignalCall,
  market: Market,
  settings: UserSettings,
  marginUsd: number,
  markPx: number,
  now = new Date(),
): BuildResult {
  const notes: string[] = [];

  const lev = clampLeverage(settings.leverage, market.maxLeverage);
  if (lev.leverage < 1) {
    return { ok: false, reason: "leverage-unavailable", detail: `${market.coin} maxLeverage=${market.maxLeverage}` };
  }
  if (lev.clamped) {
    // The user must be told their 20x became 10x on this trade — 5 of the 16 symbols
    // Quotient references cap at 10x, so this is routine, not exceptional.
    notes.push(`leverage clamped ${settings.leverage}x → ${lev.leverage}x (${market.coin} caps at ${market.maxLeverage}x)`);
  }

  const stop = clampStopPct(settings.stopPct, lev.leverage, market.maxLeverage, RISK_PARAMS.liqBufferFrac);
  if (stop.clamped) {
    notes.push(
      `stop clamped ${(settings.stopPct * 100).toFixed(2)}% → ${(stop.stopPct * 100).toFixed(2)}% ` +
      `(liquidation is ${((1 / lev.leverage - 1 / (2 * market.maxLeverage)) * 100).toFixed(2)}% away at ${lev.leverage}x)`,
    );
  }

  const size = computeSize({
    marginUsd,
    leverage: lev.leverage,
    refPx: markPx,
    szDecimals: market.szDecimals,
    minOrderNotionalUsd: RISK_PARAMS.minOrderNotionalUsd,
  });
  if (!size.ok) {
    return {
      ok: false,
      reason: size.reason === "rounds-to-zero" ? "below-min-notional" : size.reason,
      detail: `$${marginUsd.toFixed(2)} at ${lev.leverage}x on ${market.coin} = ` +
        `$${size.notionalUsd.toFixed(2)} notional (min $${RISK_PARAMS.minOrderNotionalUsd})`,
    };
  }

  const exits = computeExitPrices(
    markPx, call.side, stop.stopPct, settings.stopLoss, call.targetPx, market.szDecimals,
  );
  if (settings.stopLoss && exits.stopPx === null) {
    return { ok: false, reason: "stop-inside-liquidation", detail: "stop price did not resolve" };
  }
  // The last thing that can break the buffer is tick rounding, so the check runs on
  // the price actually going to the venue.
  if (settings.stopLoss && !stopIsInsideLiqBuffer(exits.effectiveStopPct, lev.leverage, market.maxLeverage, RISK_PARAMS.liqBufferFrac)) {
    return {
      ok: false,
      reason: "stop-inside-liquidation",
      detail: `rounded stop ${(exits.effectiveStopPct * 100).toFixed(3)}% exceeds ` +
        `${(RISK_PARAMS.liqBufferFrac * 100).toFixed(0)}% of the ` +
        `${((1 / lev.leverage - 1 / (2 * market.maxLeverage)) * 100).toFixed(2)}% liquidation distance`,
    };
  }
  if (exits.targetPx === null) {
    notes.push(`no take-profit: target ${call.targetPx} is not ahead of ${markPx} for a ${call.side}`);
  }

  return {
    ok: true,
    notes,
    intent: {
      intentId: randomUUID(),
      provider: call.provider,
      signalRef: call.signalRef,
      signalRevision: call.signalRevision,
      createdAt: now.toISOString(),
      coin: market.coin,
      side: call.side,
      refPx: markPx,
      leverage: lev.leverage,
      marginUsd,
      sizeAbs: size.sizeAbs,
      exit: {
        kind: "target-stop-horizon",
        targetPx: exits.targetPx,
        stopPx: exits.stopPx,
        horizonAt: call.horizonAt,
        // Frozen here, so the position keeps the policy it opened under even if the
        // owner changes the setting while it is running (`tasks/18`).
        holdToTarget: settings.holdToTarget,
      },
      rationale: rationale(
        call, markPx, lev.leverage, exits.stopPx, exits.effectiveStopPct, marginUsd,
        settings.holdToTarget, notes,
      ),
    },
  };
}

/** "Long NVDA, +$12" is a number. This is a reason to keep the thing connected.
 *  USER-JOURNEY §5.13: the dashboard answers "why", not just "what". */
function rationale(
  call: SignalCall, markPx: number, leverage: number,
  stopPx: number | null, stopPct: number, marginUsd: number, holdToTarget: boolean,
  notes: string[],
): string {
  const dir = call.side === "long" ? "Long" : "Short";
  const hours = (Date.parse(call.horizonAt) - Date.now()) / 3_600_000;
  const parts = [
    `${dir} ${call.coin} — ${call.headline}: Quotient's ${call.anchorType} ${call.mode} outlook ` +
    `targets ${call.targetPx.toPrecision(6)} vs ${markPx.toPrecision(6)} ` +
    `(${(call.displacementSigma).toFixed(2)}σ, strength ${call.strength ?? "n/a"}).`,
    `$${marginUsd.toFixed(2)} margin at ${leverage}x.`,
    stopPx === null
      ? "No stop (the user turned it off)."
      : `Stop ${stopPx.toPrecision(6)} — ${(stopPct * 100).toFixed(2)}% away, ` +
        `${(stopLossFracOfMargin(stopPct, leverage) * 100).toFixed(0)}% of this signal's margin if it fires.`,
    `Closes at ${call.horizonAt} (${hours.toFixed(1)}h) whatever the P&L — the outlook expires, so the thesis does.`,
    holdToTarget
      ? "If Quotient goes neutral on this call before then, the position is kept and runs to its target, its stop or that horizon."
      : "If Quotient goes neutral on this call before then, the position is closed on the next poll.",
  ];
  return [...parts, ...notes].join(" ");
}

export function skip(
  reason: SkipReason, detail: string, signalRef: string, revision: number,
  coin: string | null, at = new Date(),
): Skip {
  return { at: at.toISOString(), signalRef, revision, coin, reason, detail };
}
