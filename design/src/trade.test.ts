import assert from "node:assert/strict";
import { test } from "node:test";
import { moveAndGain, movePct, onMarginPct, pct, share } from "./trade.ts";

// The bug this function exists to stop: a short's stop sits *above* its entry, so the
// raw percentage is positive — and it shipped that way, rendering a 3% loss as
// "(3.01%)" on a live desk. Positive must always mean "this went your way".
test("a move is signed by profit, not by direction", () => {
  // Long: target above entry is a gain, stop below it is a loss.
  assert.equal(movePct(100, 101, "long")?.toFixed(2), "1.00");
  assert.equal(movePct(100, 97, "long")?.toFixed(2), "-3.00");
  // Short: exactly the other way round, and the signs must come out the same.
  assert.equal(movePct(100, 99, "short")?.toFixed(2), "1.00");
  assert.equal(movePct(100, 103, "short")?.toFixed(2), "-3.00");
});

test("the real trade from the ledger comes out right", () => {
  // xyz:NATGAS short, entry 2.9733 → exit 2.9409, closed +$0.87 on $10 of margin at
  // 10×. The gross figure should land just above the net, with fees the difference.
  const move = movePct(2.9733, 2.9409, "short")!;
  assert.ok(move > 1.0 && move < 1.2, `${move}`);
  assert.ok(onMarginPct(move, 10)! > 10, "a 1.09% move at 10x is ~10.9% of margin");

  // xyz:COPPER long, entry 6.7187 → exit 6.5997, closed −$1.44.
  const loss = movePct(6.7187, 6.5997, "long")!;
  assert.ok(loss < -1.7 && loss > -1.8, `${loss}`);
  assert.ok(onMarginPct(loss, 10)! < -17);
});

// The whole point of showing this: 0.85% is nothing, and 8.5% of your money is not.
test("leverage is what makes a small move worth reporting", () => {
  assert.equal(onMarginPct(0.85, 10)?.toFixed(1), "8.5");
  assert.equal(onMarginPct(-3, 10)?.toFixed(1), "-30.0");
  assert.equal(onMarginPct(-3, 20)?.toFixed(1), "-60.0", "the same stop at 20x");
});

test("missing prices report nothing rather than zero", () => {
  assert.equal(movePct(null, 100, "long"), null);
  assert.equal(movePct(100, null, "long"), null);
  assert.equal(movePct(0, 100, "long"), null, "a zero entry is not a 100% move");
  assert.equal(movePct(NaN, 100, "long"), null);
  assert.equal(onMarginPct(null, 10), null);
  assert.equal(moveAndGain(null, 100, "long", 10), "", "nothing to append is an empty string");
});

test("percentages carry a real minus sign, not a hyphen", () => {
  assert.equal(pct(0.85), "+0.85%");
  assert.equal(pct(-3), "−3.00%");
  assert.equal(pct(-30, 1), "−30.0%");
  assert.equal(pct(null), "—");
  assert.equal(pct(Infinity), "—");
  assert.match(pct(-3), /−/, "U+2212, so it lines up in a tabular column");
});

test("the appended fragment reads as one clause", () => {
  assert.equal(moveAndGain(100, 101, "long", 10), " · +1.00% → +10.0%");
  assert.equal(moveAndGain(100, 97, "long", 10, { suffix: " of margin" }),
    " · −3.00% → −30.0% of margin");
});

// "$4 feels small but 4% makes sense" — and a bare percentage is read as whichever
// denominator the person last saw, so the caller names it. This only does the ratio.
test("a share is a percentage of a named denominator, and unknown is a dash", () => {
  assert.equal(share(0.93, 101.16)?.toFixed(1), "0.9", "today, of the day's opening equity");
  assert.equal(share(4.2, 100)?.toFixed(1), "4.2", "the week, of the mandate");
  assert.equal(share(1.2, 10)?.toFixed(1), "12.0", "a position, of the margin it posted");
  assert.equal(share(-2.13, 10)?.toFixed(1), "-21.3");
  assert.equal(share(null, 100), null);
  assert.equal(share(1, null), null);
  assert.equal(share(1, 0), null, "a zero denominator is unknown, not infinite");
  assert.equal(pct(share(0, 100), 1), "+0.0%", "a real zero is still a figure");
  assert.equal(pct(share(null, 100), 1), "—");
});
