import assert from "node:assert/strict";
import { test } from "node:test";
import { toSeries } from "./portfolio.ts";

// The shapes below are trimmed from real mainnet responses captured 2026-09-08
// (`notes/2026-09-08-balance-chart-feasibility.md`), including the three properties that
// are easy to assume and were not: the values arrive as **strings**, `pnlHistory` is
// deposit-adjusted while `accountValueHistory` is not, and **every window is padded
// backwards with `nav: 0.0` for time before the account existed**.

test("both series are zipped on their timestamps, and the strings become numbers", () => {
  const s = toSeries(
    [[1757251, "106.782287"], [1757258, "106.087702"], [1757265, "106.805248"]],
    [[1757251, "0.0"], [1757258, "-0.694585"], [1757265, "0.022961"]],
  );
  assert.deepEqual(s.points, [
    { t: 1757251, nav: 106.782287, pnl: 0 },
    { t: 1757258, nav: 106.087702, pnl: -0.694585 },
    { t: 1757265, nav: 106.805248, pnl: 0.022961 },
  ]);
});

test("the window's figure is the change across it, not the cumulative total", () => {
  // The real trap. `pnlHistory` counts from the day the account opened, so the last
  // point of the `day` series is an all-time number. Under a tab reading 24H that is
  // the wrong figure by however much the account made before today — on the measured
  // account, by $181.
  const s = toSeries(
    [[1, "100"], [2, "104"]],
    [[1, "-181.25"], [2, "-177.29"]],
  );
  // Within a cent: this is a subtraction of two floats and the screen formats to two
  // decimals, so the arithmetic is not asked to be exact — only right.
  assert.ok(Math.abs(s.changeUsd! - 3.96) < 0.005, `expected +3.96, got ${s.changeUsd}`);
});

test("a deposit shows in account value and not in the figure under it", () => {
  // Captured behaviour: account value climbed 0 → 115 while all-time P&L stayed
  // negative, because the climb was money paid in. A chart of account value would draw
  // that as profit.
  const s = toSeries(
    [[1, "5.36"], [2, "101.10"]],
    [[1, "0.0"], [2, "0.0"]],
  );
  assert.equal(s.points[1]!.nav, 101.10);
  assert.equal(s.changeUsd, 0, "paying money in is not a profit");
});

test("an account with no history is a series with no points, not a crash", () => {
  const s = toSeries([], []);
  assert.deepEqual(s.points, []);
  assert.equal(s.changeUsd, null, "a dash, never $0.00 — we do not know rather than know zero");
});

test("a timestamp in one series and not the other drops the point", () => {
  // Never seen in a live response — every one had the two series the same length on the
  // same grid — and the alternative is pairing an account value with another moment's
  // profit, which would draw a step that did not happen.
  const s = toSeries([[1, "100"], [2, "104"]], [[1, "0"]]);
  assert.deepEqual(s.points.map((p) => p.t), [1]);
});

test("a value that is not a number reads as zero rather than NaN", () => {
  // A NaN reaches the SVG as `M NaN NaN` and silently draws nothing at all.
  const s = toSeries([[1, "oops"]], [[1, "0"]]);
  assert.equal(s.points[0]!.nav, 0);
});

test("with no money paid in or out, the return is on the opening balance", () => {
  // $100 → $130 is +30%, not the +23% that dividing by the closing value would give.
  // The ordinary case, and every `week` window measured on a real account.
  const s = toSeries([[1, "100"], [2, "130"]], [[1, "0"], [2, "30"]]);
  assert.ok(Math.abs(s.changePct! - 0.30) < 0.0005, `expected +30%, got ${s.changePct}`);
});

test("a window that opened at nothing has no percentage, only a figure", () => {
  // A new account's first day: $0.01 → $29 is a true +290,000%, and printing it would
  // be alarming rather than informative. The dollars still stand.
  const s = toSeries([[1, "0.01"], [2, "29"]], [[1, "0"], [2, "28.99"]]);
  assert.equal(s.changePct, null);
  assert.ok(Math.abs(s.changeUsd! - 28.99) < 0.005);
});

test("a losing window is negative in both", () => {
  const s = toSeries([[1, "100"], [2, "90"]], [[1, "0"], [2, "-10"]]);
  assert.equal(s.changeUsd, -10);
  assert.ok(Math.abs(s.changePct! + 0.10) < 0.0005);
});

test("the zero padding before the account existed is dropped", () => {
  // Verbatim from the `week` window of a real account funded 2026-09-03: twelve
  // samples of `0.0` before its first deposit, because Hyperliquid fills the whole
  // window's grid whether or not there was an account in it.
  const pad = (n: number) => Array.from({ length: n }, (_, i) => [i, "0.0"] as const);
  const s = toSeries(
    [...pad(4), [4, "100"], [5, "130"]],
    [...pad(4), [4, "0"], [5, "30"]],
  );
  assert.deepEqual(s.points.map((p) => p.t), [4, 5], "the padding is not history");
  // And the percentage is now against $100 rather than a division by zero.
  assert.ok(Math.abs(s.changePct! - 0.30) < 0.0005, `expected +30%, got ${s.changePct}`);
});

test("a return to zero inside the window is kept", () => {
  // The single most important thing a chart of somebody's money can show. One of our
  // accounts really was emptied to $0 after a halt; only *leading* zeros are padding.
  const s = toSeries(
    [[1, "100"], [2, "0.0"], [3, "40"]],
    [[1, "0"], [2, "-100"], [3, "-60"]],
  );
  assert.deepEqual(s.points.map((p) => p.nav), [100, 0, 40]);
});

test("an account that has never held anything is a flat line, not a missing one", () => {
  // `0x…dEaD` answers with a full grid of zeros. Trimming it to nothing would make the
  // desk say "no history to draw", which is a different and wrong claim.
  const s = toSeries([[1, "0.0"], [2, "0.0"]], [[1, "0.0"], [2, "0.0"]]);
  assert.equal(s.points.length, 2);
  assert.equal(s.changeUsd, 0);
  assert.equal(s.changePct, null, "no percentage of nothing");
});

test("the change is measured from the first real sample, not the window's first", () => {
  // Hyperliquid rebases pnlHistory to zero at each window's start, so before trimming
  // the two are equal. After trimming they are not, and this is the one that is right.
  const s = toSeries(
    [[1, "0.0"], [2, "100"], [3, "112"]],
    [[1, "0.0"], [2, "5"], [3, "17"]],
  );
  assert.equal(s.changeUsd, 12, "since the account had money, not since the window opened");
});

test("a flow is recovered from the two series, and weighted by when it landed", () => {
  // Hyperliquid gives no deposit feed, and needs to give none: account value moves by
  // profit and by flows and by nothing else, so `flow = Δnav − Δpnl` recovers each one.
  // Here $100 opens the window, $100 more arrives exactly halfway, and $30 is made.
  // Modified Dietz: 30 / (100 + 0.5 × 100) = +20%. Dividing by the opening balance
  // alone would claim +30% on capital that was not there for half of it.
  const s = toSeries(
    [[0, "100"], [10, "200"], [20, "230"]],
    [[0, "0"], [10, "0"], [20, "30"]],
  );
  assert.ok(Math.abs(s.changePct! - 0.20) < 0.0005, `expected +20%, got ${s.changePct}`);
});

test("losing nearly everything does not read as losing more than everything", () => {
  // The case this exists for, from a real account on 2026-09-08: it opened the window
  // at $1,392.79, was topped up by $283.27 along the way, and lost $1,532.14. On the
  // opening balance alone that is −110%, which is not a thing that happened.
  const s = toSeries(
    [[0, "1392.79"], [50, "1676.06"], [100, "143.92"]],
    [[0, "0"], [50, "0"], [100, "-1532.14"]],
  );
  // The property that matters, and the one dividing by the opening balance breaks.
  assert.ok(s.changePct! > -1, `a loss cannot exceed the capital: got ${s.changePct}`);
  // This is the account's four real flows collapsed to one at the midpoint, so the
  // denominator is $1,534 rather than the $1,575 the real timings give and the answer
  // is −99.9% rather than −97.3%. Both are the right side of −100%, which is the point.
  assert.ok(Math.abs(s.changePct! + 0.9985) < 0.001, `got ${s.changePct}`);
});

test("a window with one sample has no return", () => {
  const s = toSeries([[1, "100"]], [[1, "0"]]);
  assert.equal(s.changePct, null);
});
