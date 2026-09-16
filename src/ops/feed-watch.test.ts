import assert from "node:assert/strict";
import { test } from "node:test";
import { FEED_SIGMA_WATCH } from "../risk/params.ts";
import {
  alarmMessage, assess, dailyLine, outsideBand, runOutside, type DayElevation, type WatchConfig,
} from "./feed-watch.ts";

// `tasks/43` §2. The watcher's whole job is to fire on the right day and on no other,
// so what is tested is the decision: what counts as outside, what counts as a run, and
// what a partial day is allowed to do to either.

const CFG: WatchConfig = { band: [0.90, 1.10], sustainedDays: 2, minBaselineDays: 3 };
const BASE = { label: "pre-09-04", from: "2026-08-30", to: "2026-09-03", days: 5 };

const day = (d: string, ratio: number, complete = true): DayElevation =>
  ({ day: d, ratio, pairs: 51, complete });

test("the band is wider than the statistic's own noise, and that is why it is this wide", () => {
  // Measured 2026-09-13: each baseline day scored against the other four reads
  // 0.983..1.046 with nothing happening. A band inside that fires on the archive's
  // quietest week. `notes/2026-09-13-a-watcher-for-the-denominator.md`.
  const [lo, hi] = FEED_SIGMA_WATCH.band;
  assert.ok(lo <= 0.983, `band floor ${lo} would fire on a quiet baseline day (0.983)`);
  assert.ok(hi >= 1.046, `band ceiling ${hi} would fire on a quiet baseline day (1.046)`);
});

test("outsideBand is inclusive of the edges", () => {
  assert.equal(outsideBand(0.90, CFG.band), false);
  assert.equal(outsideBand(1.10, CFG.band), false);
  assert.equal(outsideBand(0.8999, CFG.band), true);
  assert.equal(outsideBand(1.1001, CFG.band), true);
});

test("one day outside is reported and does not reach the bar", () => {
  // 2026-09-05 and 2026-09-12, the archive's only two excursions, both single days.
  const w = assess([day("2026-09-04", 1.05), day("2026-09-05", 1.28)], BASE, CFG, 0.5);
  assert.equal(w.run, 1);
  assert.equal(w.firing, false);
  assert.equal(w.gateEquivalent, 0.5 * 1.28);
});

test("two consecutive days outside is the bar, and it has never been reached live", () => {
  const w = assess([day("2026-09-11", 1.28), day("2026-09-12", 1.40)], BASE, CFG, 0.5);
  assert.equal(w.run, 2);
  assert.equal(w.firing, true);
  assert.match(alarmMessage(w, 0.5), /minDisplacementSigma 0\.70/);
});

test("a run is the days ending now, not the days ever", () => {
  const w = assess(
    [day("2026-09-05", 1.28), day("2026-09-06", 1.05), day("2026-09-07", 1.03)], BASE, CFG, 0.5,
  );
  assert.equal(runOutside(w.days, CFG.band), 0, "an old spike does not carry forward");
  assert.equal(w.firing, false);
});

test("a partial day can neither start a run nor break one", () => {
  const started = assess([day("2026-09-11", 1.00), day("2026-09-12", 1.40, false)], BASE, CFG, 0.5);
  assert.equal(started.run, 0, "today's polls are still arriving; sigma_total decays through the day");
  assert.equal(started.latest?.day, "2026-09-11");
  assert.equal(started.partial?.day, "2026-09-12");

  const broken = assess(
    [day("2026-09-10", 1.28), day("2026-09-11", 1.40), day("2026-09-12", 1.00, false)], BASE, CFG, 0.5,
  );
  assert.equal(broken.run, 2, "a quiet morning does not clear a two-day excursion");
  assert.equal(broken.firing, true);
});

test("a baseline too short to be a baseline scores nothing rather than a confident ratio", () => {
  const w = assess([day("2026-09-12", 1.40)], { ...BASE, days: 2 }, CFG, 0.5);
  assert.equal(w.firing, false);
  assert.equal(w.gateEquivalent, null);
  assert.match(w.refusal ?? "", /covers 2 day\(s\)/);
  assert.match(dailyLine(w, 0.5), /not scored/);
});

test("an archive with only today in it has no complete day and says so", () => {
  const w = assess([day("2026-09-13", 1.40, false)], BASE, CFG, 0.5);
  assert.equal(w.latest, null);
  assert.equal(w.firing, false);
  assert.match(w.refusal ?? "", /no complete day/);
});

test("the daily line always says where the gate is, and flags a partial day as partial", () => {
  const w = assess([day("2026-09-11", 0.96), day("2026-09-12", 1.36, false)], BASE, CFG, 0.5);
  const line = dailyLine(w, 0.5);
  assert.match(line, /2026-09-11/);
  assert.match(line, /inside the band/);
  assert.match(line, /partial and not counted/);
  assert.match(line, /0\.48 demanded in the baseline/);
});

test("the alarm asks for the commit and does not claim to have made it", () => {
  const w = assess([day("2026-09-11", 1.28), day("2026-09-12", 1.40)], BASE, CFG, 0.5);
  const msg = alarmMessage(w, 0.5);
  assert.match(msg, /Nothing has been changed/);
  assert.match(msg, /src\/risk\/params\.ts/);
  assert.match(msg, /FEED_REGIMES row in the same commit/);
});
