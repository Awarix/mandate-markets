import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { stopsToHalt } from "../risk/halt.ts";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { SWEEP, stopFirings } from "./stop-sweep.ts";

// `tasks/42`. The sweep's old model ended a trade at its stop; the desk re-entered on the
// next tick. `stopFirings` is the second world's counter, and it decides how much of a
// tighter stop's apparent benefit is real — so it gets the unit tests every pure function
// that touches money gets here.

test("a path that never reaches the stop fires nothing", () => {
  // Long from 100, worst price 99.5, stop at 1% (99.00).
  assert.equal(stopFirings("long", 100, 0.01, 99.5), 0);
  // And a path that went *for* us cannot fire a stop against us.
  assert.equal(stopFirings("long", 100, 0.01, 104), 0);
  assert.equal(stopFirings("short", 100, 0.01, 96), 0);
});

test("each re-entry resets the level, so the count compounds rather than divides", () => {
  // Long from 100 at a 1% stop: levels are 99.00, 98.01, 97.0299, 96.0596…
  // A worst price of 97.00 gets through three of them, not floor(3.00/1.00) = 3 by
  // accident — the fourth level is 96.06 and the path did not reach it.
  assert.equal(stopFirings("long", 100, 0.01, 97.0), 3);
  assert.equal(stopFirings("long", 100, 0.01, 99.0), 1, "touching the first level exactly fires it");
  assert.equal(stopFirings("long", 100, 0.01, 98.02), 1, "one tick above the second level is one firing");
  assert.equal(stopFirings("long", 100, 0.01, 98.00), 2);
  // The compounding is why this is not `excursion / frac`: at a 10% stop the naive
  // division says 5 and the levels say 6 (90, 81, 72.9, 65.61, 59.05, 53.14).
  assert.equal(stopFirings("long", 100, 0.10, 50), 6);
});

test("a short is the same arithmetic upward", () => {
  // Short from 100 at 1%: levels are 101.00, 102.01, 103.0301…
  assert.equal(stopFirings("short", 100, 0.01, 103.04), 3);
  assert.equal(stopFirings("short", 100, 0.01, 101.0), 1);
  assert.equal(stopFirings("short", 100, 0.01, 100.9), 0);
});

test("a tighter stop never fires fewer times than a looser one on the same path", () => {
  // The monotonicity the sweep's last column rests on: if it could invert, a tighter
  // stop could look cheaper under re-entry for a reason that is not a real one.
  for (const mae of [99.9, 99, 97, 95, 90, 80]) {
    let prev = Infinity;
    for (const frac of [0.005, 0.01, 0.015, 0.02, 0.03, 0.05]) {
      const k = stopFirings("long", 100, frac, mae);
      assert.ok(k <= prev, `mae ${mae}: ${frac} fired ${k} against ${prev} at the tighter level`);
      prev = k;
    }
  }
});

test("a missing or impossible path is zero, never a guess", () => {
  // "We never looked" and "no stop fired" push a sweep in opposite directions, and the
  // sweep drops unsummarised trades before this is called. Nothing here may invent one.
  assert.equal(stopFirings("long", 100, 0.01, null), 0);
  assert.equal(stopFirings("long", 0, 0.01, 99), 0);
  assert.equal(stopFirings("long", 100, 0, 99), 0);
  assert.equal(stopFirings("long", 100, 1, 99), 0, "a 100% stop has no level below it");
  assert.equal(stopFirings("long", 100, 0.01, 0), 0, "a zero price is not a 100% drawdown, it is bad data");
});

// ── the marker and the column that were literals (`tasks/46` §1.2) ─────────────────
//
// The sweep printed "← today" against a hardcoded 3.0 while the shipped default was
// 2.0%, and printed "of margin" as `frac × 10` over a ledger running 5x, 10x and 20x.
// Both survived the default moving twice in three days, because neither read it.

test("the shipped default is always a row in the sweep, whatever it is", () => {
  assert.ok(SWEEP.includes(DEFAULT_USER_SETTINGS.stopPct * 100),
    `the sweep ${SWEEP.join(",")} has no row at the shipped ${DEFAULT_USER_SETTINGS.stopPct * 100}%`);
  // Sorted, and no duplicate when the default already coincides with a fixed level.
  assert.deepEqual(SWEEP, [...new Set(SWEEP)].sort((a, b) => a - b));
});

// Reading the rendered line rather than the constant: the marker is a string a person
// acts on, and the failure being guarded is that it named the wrong row.
test("the ← today marker lands on the default's row and on no other", () => {
  const src = readFileSync(new URL("./stop-sweep.ts", import.meta.url), "utf8");
  assert.match(src, /Math\.abs\(frac - DEFAULT_USER_SETTINGS\.stopPct\) < 1e-9/);
  assert.doesNotMatch(src, /level === 3\.0 \? "   ← today"/);
  // And the margin column is the row's own leverage, not a canonical account's.
  assert.doesNotMatch(src, /pct\(frac \* 10\)/);
  assert.match(src, /mean\(rows\.map\(\(r\) => frac \* r\.leverage\)\)/);
});

// `stopsToHalt` rather than the multiplication: the recomputed version dropped the
// reserve factor and the min(1, …) cap, so the sweep and the connect screen disagreed
// about the same account by the reserve — which is exactly what limits.test.ts exists
// to catch one layer up.
test("stops-to-halt comes from halt.ts, so the sweep and the connect screen cannot drift", () => {
  const src = readFileSync(new URL("./stop-sweep.ts", import.meta.url), "utf8");
  assert.match(src, /stopsToHalt\(\{ \.\.\.DEFAULT_USER_SETTINGS, stopPct: frac \}\)/);
  // The two differ by the reserve at every level, so the old form was never a rounding
  // difference: at the shipped default it printed 5.0 against the desk's 5.05.
  const naive = RISK_PARAMS.dailyLossPct
    / (DEFAULT_USER_SETTINGS.stopPct * DEFAULT_USER_SETTINGS.leverage * DEFAULT_USER_SETTINGS.perSignalPct);
  assert.ok(Math.abs(stopsToHalt(DEFAULT_USER_SETTINGS) - naive) > 0.01,
    "the reserve factor stopped mattering; the test that guards it no longer does");
});
