import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";
import { priceDecimals, quantizeExitPx, quantizePx, quantizeSz, pxToWire, szToWire } from "./numbers.ts";

// Real values from live HL metadata (2026-08-30): BTC szDecimals 5 @ ~78026,
// xyz:NVDA szDecimals 3 @ ~218.86, xyz:GOLD szDecimals 4.
const CASES = [[78026.5, 5], [218.855, 3], [1.234567, 5], [4321.987, 4], [0.0123456, 2], [123456.7, 0]] as const;

test("priceDecimals honours both the 5-sig-fig and the (6 - szDecimals) ceilings", () => {
  assert.equal(priceDecimals(78026.5, 5), 0, "BTC: 5 sig figs is already spent on the integer part");
  assert.equal(priceDecimals(218.855, 3), 2, "NVDA: 5 sig figs leaves 2 decimals");
  assert.equal(priceDecimals(1.23456, 5), 1, "6 - szDecimals binds before sig figs");
  assert.equal(priceDecimals(0.0123456, 2), 4, "small price: the decimal ceiling binds");
});

// The property that matters is legality, not agreement on a rounding mode: the SDK
// truncates, we round directionally. Feeding our output back through the vendor's
// formatter must be a no-op, which is exactly "HL would accept this price".
test("every quantized price is one the SDK accepts unchanged", () => {
  for (const [px, sz] of CASES) {
    for (const dir of ["up", "down", "nearest"] as const) {
      const q = quantizePx(px, sz, dir);
      assert.equal(formatPrice(q, sz), String(q), `px=${px} sz=${sz} dir=${dir}`);
    }
  }
});

test("quantizePx moves in the direction asked and by less than one tick", () => {
  for (const [px, sz] of CASES) {
    const up = quantizePx(px, sz, "up");
    const down = quantizePx(px, sz, "down");
    assert.ok(up >= px, `up ${up} < ${px}`);
    assert.ok(down <= px, `down ${down} > ${px}`);
    assert.ok(up - down <= 10 ** -priceDecimals(px, sz) + 1e-9, `${px}: gap wider than a tick`);
  }
});

test("an already-legal price is left alone in every direction", () => {
  assert.equal(quantizePx(218.85, 3, "up"), 218.85);
  assert.equal(quantizePx(218.85, 3, "down"), 218.85);
  assert.equal(quantizePx(78026, 5, "up"), 78026);
});

test("quantizeSz truncates, never rounds up — rounding up spends unbudgeted margin", () => {
  assert.equal(quantizeSz(1.23456789, 5), 1.23456);
  assert.equal(quantizeSz(0.99999, 3), 0.999);
  assert.equal(String(quantizeSz(1.23456789, 5)), formatSize(1.23456789, 5));
});

test("quantizeSz is not defeated by float representation", () => {
  // 0.07 * 3 = 0.21000000000000002; a naive floor at 3dp would return 0.209.
  assert.equal(quantizeSz(0.07 * 3, 3), 0.21);
});

test("an exit price only ever rounds toward entry", () => {
  const entry = 218.86;
  const stop = quantizeExitPx(entry * 0.97, entry, 3);      // long stop, 3% below
  assert.ok(stop >= entry * 0.97, `stop ${stop} rounded away from entry`);
  assert.ok(stop - entry * 0.97 <= 0.01, "and by at most a tick");
  const shortStop = quantizeExitPx(entry * 1.03, entry, 3); // short stop, 3% above
  assert.ok(shortStop <= entry * 1.03, `stop ${shortStop} rounded away from entry`);
});

test("wire format never emits exponential or trailing-zero noise", () => {
  assert.equal(pxToWire(78026.5, 5), "78027");
  assert.equal(pxToWire(218.85, 3), "218.85");
  assert.equal(szToWire(0.001, 5), "0.001");
  assert.equal(szToWire(1e-7, 8), "0.0000001");
  assert.ok(!szToWire(1e-7, 8).includes("e"));
});
