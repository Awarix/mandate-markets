import assert from "node:assert/strict";
import { test } from "node:test";
import { RISK_PARAMS, DEFAULT_USER_SETTINGS } from "./params.ts";
import { SITE_OFFERS } from "../web/discovery.ts";
import { CLAMP_PCT } from "../../design/src/limits.ts";
import {
  clampLeverage, clampStopPct, computeExitPrices, computeSize, liqDistanceFrac,
  maintenanceMarginRate, maxStopPct, stopIsInsideLiqBuffer, stopLossFracOfMargin,
  targetIsAhead,
} from "./sizing.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/** The shipped buffer, read from the constant rather than typed (`tasks/46` §3.3).
 *  Ten call sites below passed a literal `0.7`, so every one of them kept passing if
 *  `liqBufferFrac` moved and none of them was a test of the shipped clamp. Where an
 *  expected value follows from it, it is re-derived from `liqBufferFrac ×
 *  (1/L − 1/(2·Lmax))` — the formula, not `maxStopPct`, which is the code under test. */
const B = RISK_PARAMS.liqBufferFrac;
const ceiling = (lev: number, maxLev: number) => B * (1 / lev - 1 / (2 * maxLev));

// The table in docs/ACCOUNT-MODEL.md §5, verified against live HL maxLeverage
// (2026-08-30): BTC 40x, ETH/xyz:GOLD 25x, xyz:NVDA/TSLA/META 20x, xyz:HOOD/PLTR 10x.
test("liquidation distance reproduces the documented per-asset table", () => {
  close(liqDistanceFrac(20, 40), 0.0375, 1e-12);   // BTC at 20x
  close(liqDistanceFrac(10, 40), 0.0875, 1e-12);
  close(liqDistanceFrac(5, 40), 0.1875, 1e-12);
  close(liqDistanceFrac(20, 25), 0.03, 1e-12);     // ETH at 20x
  close(liqDistanceFrac(20, 20), 0.025, 1e-12);    // xyz:NVDA at 20x
  close(liqDistanceFrac(10, 10), 0.05, 1e-12);     // xyz:HOOD at 10x
  close(maintenanceMarginRate(40), 0.0125, 1e-12);
});

test("20x is unavailable on a 10x-max asset and the clamp says so", () => {
  assert.deepEqual(clampLeverage(20, 10), { leverage: 10, clamped: true });
  assert.deepEqual(clampLeverage(10, 40), { leverage: 10, clamped: false });
  assert.deepEqual(clampLeverage(20, 20), { leverage: 20, clamped: false });
});

// The finding that makes the clamp non-optional: on a 20x-max asset at 20x,
// liquidation is 2.5%, so a 3% stop would never fire. (3% was the default until
// 2026-09-10; it is 2% now, and the site still sells stops to 8%.)
test("a 3% stop is clamped on a 20x-max asset at 20x", () => {
  const { stopPct, clamped } = clampStopPct(0.03, 20, 20, B);
  close(stopPct, ceiling(20, 20), 1e-12);
  assert.equal(clamped, true);
});

test("the same 3% stop passes untouched at 10x on BTC", () => {
  assert.deepEqual(clampStopPct(0.03, 10, 40, B), { stopPct: 0.03, clamped: false });
  close(maxStopPct(10, 40, B), ceiling(10, 40), 1e-12);
});

// The figures the desk publishes: `docs/ACCOUNT-MODEL.md` §5, `CLAUDE.md`'s gotcha list
// and the connect screen all quote them, and `design/src/limits.ts` recomputes them for
// every slider drag. **This is a deliberate tripwire on `liqBufferFrac`** — it is the one
// test here that a change to the constant is *meant* to break, because the change is not
// finished until those three places have been edited too.
test("TRIPWIRE: the published stop ceilings are 1.75% at 20x, 5.25% at 10x, 12.25% at 5x", () => {
  close(maxStopPct(20, 20, B), 0.0175, 1e-12);
  close(maxStopPct(10, 20, B), 0.0525, 1e-12);
  close(maxStopPct(5, 20, B), 0.1225, 1e-12);
  assert.equal(B, 0.7, "liqBufferFrac moved — every ceiling the site quotes moved with it");
});

// "At the widest permitted stop the loss is ≈ 50–60% of that signal's margin at any
// leverage" — because x_liq × L = 1 − L/(2·Lmax) is roughly flat.
test("the widest permitted stop costs 50-60% of margin at every leverage", () => {
  for (const [lev, max] of [[5, 40], [10, 40], [20, 40], [10, 25], [20, 20], [10, 10]] as const) {
    const loss = stopLossFracOfMargin(maxStopPct(lev, max, B), lev);
    assert.ok(loss > 0.34 && loss < 0.66, `L=${lev} Lmax=${max}: loss ${(loss * 100).toFixed(1)}% of margin`);
  }
});

test("a 3% stop costs 30% of margin at 10x and 60% at 20x", () => {
  close(stopLossFracOfMargin(0.03, 10), 0.30, 1e-12);
  close(stopLossFracOfMargin(0.03, 20), 0.60, 1e-12);
});

test("sizing: $100 of margin at 10x controls $1000 of notional", () => {
  const r = computeSize({ marginUsd: 100, leverage: 10, refPx: 218.855, szDecimals: 3, minOrderNotionalUsd: 10 });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.sizeAbs === 4.569, `got ${r.ok && r.sizeAbs}`);   // 1000/218.855 = 4.5693..., truncated
  assert.ok(r.ok && r.notionalUsd < 1000, "lot truncation must never spend more than budgeted");
});

test("sizing rejects rather than rounding up when the lot is coarse", () => {
  // szDecimals 0 (whole units) with a $12 budget at 1x on a $50 asset: 0.24 → 0.
  const r = computeSize({ marginUsd: 12, leverage: 1, refPx: 50, szDecimals: 0, minOrderNotionalUsd: 10 });
  assert.deepEqual(r, { ok: false, reason: "rounds-to-zero", notionalUsd: 0 });
});

// The bucket test account: $5.36 at 10% and 10x is a $5.36 order, under HL's $10 floor.
test("sizing rejects below HL's $10 minimum notional", () => {
  const r = computeSize({ marginUsd: 0.536, leverage: 10, refPx: 78026, szDecimals: 5, minOrderNotionalUsd: 10 });
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason === "below-min-notional");
});

test("exit prices land on the correct side of entry for both directions", () => {
  const long = computeExitPrices(218.86, "long", 0.03, true, 230, 3);
  assert.ok(long.stopPx !== null && long.stopPx < 218.86);
  assert.ok(long.targetPx !== null && long.targetPx > 218.86);
  const short = computeExitPrices(218.86, "short", 0.03, true, 210, 3);
  assert.ok(short.stopPx !== null && short.stopPx > 218.86);
  assert.ok(short.targetPx !== null && short.targetPx < 218.86);
});

test("a target on the wrong side of entry is dropped, not traded backwards", () => {
  assert.equal(targetIsAhead(100, "long", 90), false);
  const e = computeExitPrices(218.86, "long", 0.03, true, 210, 3);
  assert.equal(e.targetPx, null, "a long with a target below spot has no take-profit");
  assert.ok(e.stopPx !== null, "but it still gets a stop");
});

test("stop off means no stop price and no stop distance", () => {
  const e = computeExitPrices(218.86, "long", 0.03, false, 230, 3);
  assert.equal(e.stopPx, null);
  assert.equal(e.effectiveStopPct, 0);
});

// Tick rounding is the last thing that can push a stop outside the buffer, so the
// check runs on the rounded price, not the intended percentage.
test("the liquidation-buffer check passes on the clamp and fails past it", () => {
  const { stopPct } = clampStopPct(0.03, 20, 20, B);
  const e = computeExitPrices(218.86, "long", stopPct, true, null, 3);
  assert.ok(stopIsInsideLiqBuffer(e.effectiveStopPct, 20, 20, B), "a clamped stop must pass");
  assert.equal(stopIsInsideLiqBuffer(0.03, 20, 20, B), false, "an unclamped 3% stop at 20x must fail");
  assert.equal(stopIsInsideLiqBuffer(0.025, 20, 20, B), false, "a stop exactly at liquidation must fail");
});

test("every clamped stop on the real universe survives tick rounding", () => {
  // symbol, live maxLeverage, live szDecimals, a plausible price
  const universe = [
    ["BTC", 40, 5, 78026.5], ["ETH", 25, 4, 2610.4], ["xyz:NVDA", 20, 3, 218.855],
    ["xyz:GOLD", 25, 4, 4321.9], ["xyz:HOOD", 10, 3, 96.42], ["xyz:PLTR", 10, 3, 172.03],
  ] as const;
  for (const [coin, maxLev, szDec, px] of universe) {
    for (const requested of SITE_OFFERS.leverage) {
      const { leverage } = clampLeverage(requested, maxLev);
      const { stopPct } = clampStopPct(0.03, leverage, maxLev, B);
      for (const side of ["long", "short"] as const) {
        const e = computeExitPrices(px, side, stopPct, true, null, szDec);
        assert.ok(
          stopIsInsideLiqBuffer(e.effectiveStopPct, leverage, maxLev, B),
          `${coin} ${side} @${requested}x: rounded stop ${(e.effectiveStopPct * 100).toFixed(4)}% > clamp`,
        );
      }
    }
  }
});

// ── 18×, and why it exists ────────────────────────────────────────────────────────
//
// Item 25, `notes/2026-09-12-how-a-20x-account-arms-a-2-percent-stop.md`. The owner's
// 20× account chose a 2% stop and could not arm it: on a 20×-max asset liquidation is
// 2.50% away, `liqBufferFrac` is 0.70, so the ceiling is 1.75% and the clamp fired on 46
// of its trips. 18× is the answer that moves no risk constant — it is the highest
// leverage at which a 2% stop arms in full with the buffer untouched.
//
// This is the assertion the whole change rests on. If `liqBufferFrac` or the default
// stop ever moves, one of these two halves fails and says which.

test("18x arms the default stop on a 20x-max asset and 20x does not — the reason 18x is offered", () => {
  const stop = DEFAULT_USER_SETTINGS.stopPct;           // 2% since 2026-09-12

  assert.equal(clampStopPct(stop, 18, 20, B).clamped, false, "18x must arm the default in full");
  close(clampStopPct(stop, 18, 20, B).stopPct, stop, 1e-12);

  assert.equal(clampStopPct(stop, 20, 20, B).clamped, true, "20x cannot, which is the whole point");
  close(clampStopPct(stop, 20, 20, B).stopPct, ceiling(20, 20), 1e-12);

  // 19x is not enough, so 18 is not a round number someone picked — it is the boundary.
  assert.equal(clampStopPct(stop, 19, 20, B).clamped, true, "19x still clamps, so 18 is the boundary");
});

// The number that decided this against the obvious alternative — raising `liqBufferFrac`
// to 0.80 so that 20× arms 2%. The stop is a stop-LIMIT: the limit rests `slippageBps`
// beyond the trigger, and on 2026-09-10 a 20× position was liquidated because price went
// through both. So the figure to compare is where the LIMIT sits, not the trigger.
test("18x leaves more room to liquidation than 20x does today, and than buffer 0.80 would", () => {
  const stop = DEFAULT_USER_SETTINGS.stopPct;
  const band = RISK_PARAMS.slippageBps / 10_000;
  const headroom = (lev: number, buffer: number) =>
    liqDistanceFrac(lev, 20) - (clampStopPct(stop, lev, 20, buffer).stopPct + band);

  const at18 = headroom(18, RISK_PARAMS.liqBufferFrac);      // 0.76pp
  const at20 = headroom(20, RISK_PARAMS.liqBufferFrac);      // 0.45pp — today
  const at20Loosened = headroom(20, 0.80);                   // 0.20pp — the refused option

  assert.ok(at18 > at20, `18x must not be tighter than today: ${at18} vs ${at20}`);
  assert.ok(at20Loosened < at20, "raising the buffer to arm 2% at 20x makes the fill TIGHTER, not safer");
  // And tighter than the position that was actually liquidated had: its limit sat at
  // 2.02% against a 2.50% liquidation, 0.48pp, and the market went through it anyway.
  assert.ok(at20Loosened < 0.0048, "buffer 0.80 leaves less room than the COPPER trade that was liquidated");
});

test("every leverage the site offers has a stop ceiling the screens can quote", () => {
  // `CLAMP_PCT[lev]!` in connect.ts and `?? 0` in deskLimits.ts — a missing entry is
  // either a crash or a silent zero, and neither says "we do not know".
  for (const lev of SITE_OFFERS.leverage) {
    const quoted = CLAMP_PCT[lev];
    assert.ok(quoted !== undefined, `${lev}x has no CLAMP_PCT entry`);
    // The screens quote a typical 40x-max market. What they must never do is promise
    // more room than the clamp allows there; being conservative is fine and 5x is.
    const ceiling = maxStopPct(lev, 40, RISK_PARAMS.liqBufferFrac) * 100;
    assert.ok(quoted! <= ceiling + 0.1, `${lev}x quotes ${quoted}% against a ${ceiling.toFixed(2)}% ceiling`);
  }
});
