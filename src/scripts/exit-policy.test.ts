import assert from "node:assert/strict";
import { test } from "node:test";
import { replay, replayWindow } from "./exit-policy.ts";

// `replay` decides which of two levels a price path reached first, and the answer is
// the whole counterfactual — so it is tested rather than trusted, for the same reason
// the sizing arithmetic is.

const k = (l: number, h: number, c = h, T = 0) => ({ t: 0, T, o: String(l), h: String(h), l: String(l), c: String(c) });

test("a long takes its target when the high reaches it", () => {
  const r = replay("long", 110, 90, [k(99, 101), k(100, 112)]);
  assert.deepEqual(r, { reason: "target", px: 110, at: 0, ambiguous: false });
});

test("a long takes its stop when the low reaches it", () => {
  const r = replay("long", 110, 90, [k(99, 101), k(88, 100)]);
  assert.deepEqual(r, { reason: "stop", px: 90, at: 0, ambiguous: false });
});

// A short's levels sit the other way up, and getting this backwards would silently
// invert every short in the report.
test("a short takes its target on the low and its stop on the high", () => {
  assert.deepEqual(replay("short", 90, 110, [k(88, 100)]), { reason: "target", px: 90, at: 0, ambiguous: false });
  assert.deepEqual(replay("short", 90, 110, [k(100, 112)]), { reason: "stop", px: 110, at: 0, ambiguous: false });
});

test("whichever level comes first in time wins, not whichever is nearer", () => {
  // The stop is hit in candle 1; the target would have come in candle 2 and must not.
  const r = replay("long", 110, 90, [k(88, 100), k(100, 115)]);
  assert.deepEqual(r, { reason: "stop", px: 90, at: 0, ambiguous: false });
});

// One candle cannot say which of its own extremes came first. Giving the tie to the
// stop is conservative for the policy under test — holding — and the report counts
// how often it had to.
test("a candle that straddles both levels is resolved to the stop, and says so", () => {
  const r = replay("long", 110, 90, [k(85, 115)]);
  assert.deepEqual(r, { reason: "stop", px: 90, at: 0, ambiguous: true });
});

test("a path that touches neither level exits at the last close", () => {
  const r = replay("long", 110, 90, [k(99, 101), k(98, 103, 102)]);
  assert.deepEqual(r, { reason: "horizon", px: 102, at: 0, ambiguous: false });
});

// A missing level is a real state: `planIntent` places no take-profit when the signal
// gave no usable target, and that must not read as "the target was never reached".
test("a missing level is never hit", () => {
  assert.deepEqual(replay("long", null, 90, [k(99, 500)]), { reason: "horizon", px: 500, at: 0, ambiguous: false });
});

test("no candles at all is not an exit", () => {
  assert.equal(replay("long", 110, 90, []), null);
});

// `at` dates the exit to the candle that triggered it, NOT to the end of the window the
// caller passed. `backtest.ts` had no exit time before 2026-09-12 and used the window's
// last candle, so a target taken in hour one of a ten-hour window read as a ten-hour
// hold — which is the occupancy figure `tasks/42` and the capacity note both quote.
test("the exit is dated to the candle it happened in, not to the end of the window", () => {
  const path = [k(99, 101, 101, 1_000), k(100, 112, 112, 2_000), k(50, 400, 400, 3_000)];
  assert.equal(replay("long", 110, 90, path)?.at, 2_000);
  // And a path that reaches neither level is dated to the last candle it was given.
  assert.equal(replay("long", 10_000, 1, path)?.at, 3_000);
});

// The window is decided here rather than in the loop that talks to Hyperliquid,
// because getting it wrong is not a wrong answer but a 500 from the venue that takes
// the whole reading down — which is how it was found, mid-`tasks/02`, on 2026-09-05.

const NOW = Date.parse("2026-09-05T12:00:00Z");

test("a trade whose horizon has not passed is still running", () => {
  const w = replayWindow("2026-09-05T11:00:00Z", "2026-09-05T13:00:00Z", NOW);
  assert.equal(w.kind, "running");
});

test("a horizon close has no counterfactual — it closed after its own horizon", () => {
  // The force-close lands on the tick *after* the horizon passes, so closed_at is
  // always a little later than horizon_at. Every horizon close looks like this.
  const w = replayWindow("2026-09-05T11:00:24.013Z", "2026-09-05T11:00:00.000Z", NOW);
  assert.equal(w.kind, "at-horizon", "and must never become a candle request");
});

test("a zero-length window is also no counterfactual", () => {
  const w = replayWindow("2026-09-05T11:00:00Z", "2026-09-05T11:00:00Z", NOW);
  assert.equal(w.kind, "at-horizon");
});

test("a trade that left early gives a real window, start before end", () => {
  const w = replayWindow("2026-09-05T10:00:00Z", "2026-09-05T11:00:00Z", NOW);
  assert.equal(w.kind, "ok");
  if (w.kind !== "ok") return;
  assert.equal(w.startTime, Date.parse("2026-09-05T10:00:00Z"));
  assert.equal(w.endTime, Date.parse("2026-09-05T11:00:00Z"));
  assert.ok(w.startTime < w.endTime, "the venue refuses anything else");
});
