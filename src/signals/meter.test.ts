import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCall, monthKey, type MeterState } from "./meter.ts";

test("applyCall accumulates within a month", () => {
  const at = new Date("2026-08-30T00:00:00Z");
  let s: MeterState = { month: monthKey(at), calls: 0, usd: 0 };
  s = applyCall(s, 0.01, at);
  s = applyCall(s, 0.01, at);
  assert.deepEqual(s, { month: "2026-08", calls: 2, usd: 0.02 });
});

test("applyCall rolls over at a month boundary", () => {
  const s = applyCall({ month: "2026-08", calls: 900, usd: 9 }, 0.01, new Date("2026-09-01T00:00:00Z"));
  assert.deepEqual(s, { month: "2026-09", calls: 1, usd: 0.01 });
});

test("float accumulation stays exact to the cent", () => {
  const at = new Date("2026-08-30T00:00:00Z");
  let s: MeterState = { month: "2026-08", calls: 0, usd: 0 };
  for (let i = 0; i < 300; i++) s = applyCall(s, 0.01, at);
  assert.equal(s.usd, 3, "300 x $0.01 must be exactly $3.00, not 2.9999…");
});

import { parseCreditsRemaining, CREDITS_PER_USD } from "./client.ts";

test("parseCreditsRemaining reads the billing header", () => {
  const h = new Headers({ "x-billing-credits-remaining": "9980" });
  assert.equal(parseCreditsRemaining(h), 9980);
  assert.equal(9980 / CREDITS_PER_USD, 9.98);
});

test("parseCreditsRemaining is null when absent or junk", () => {
  assert.equal(parseCreditsRemaining(new Headers()), null);
  assert.equal(parseCreditsRemaining(new Headers({ "x-billing-credits-remaining": "n/a" })), null);
});
