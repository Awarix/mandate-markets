import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  resolveWindow, median, dailyByPair, fixedBasket, pairOver, elevation,
  type DailyByPair,
} from "./feed-sigma.ts";
import type { Poll } from "./expectancy.ts";
import { FEED_REGIMES } from "../risk/regimes.ts";

// A pair's sigma on a day, as a poll the archive could have produced. Only the three
// fields `dailyByPair` reads are set; everything else is irrelevant to it by design.
function poll(t: string, rows: [string, string, number][]): Poll {
  return {
    t: new Date(t),
    series: rows.map(([asset, anchor, sigma]) => ({
      asset_key: asset, anchor_type: anchor, outlook: { sigma_total: sigma },
    })) as unknown as Poll["series"],
  };
}

test("a bare date is refused as a baseline, and the message says why", () => {
  assert.throws(() => resolveWindow("2026-09-03", ["2026-09-03"]), /a single day is not a window/);
  // The whole point of the refusal: the day named is a real day in the archive, so this
  // is not a parse failure. It is a statistic that cannot be read that way.
  assert.throws(() => resolveWindow("2026-09-03", ["2026-09-03"]), /2026-09-03\.\.YYYY-MM-DD/);
});

test("an unparseable window names the regimes rather than returning NaN", () => {
  // `backtest --since` learned this the hard way: a value that parsed to nothing swept
  // the whole archive under one feed's label and did not complain.
  assert.throws(() => resolveWindow("reverted-ish", ["2026-09-08"]), /not a regime name/);
  assert.throws(() => resolveWindow("reverted-ish", ["2026-09-08"]), /sigma0\.5-again/);
});

test("an explicit range is taken as given", () => {
  assert.deepEqual(resolveWindow("2026-08-30..2026-09-03", []),
    { from: "2026-08-30", to: "2026-09-03", label: "2026-08-30..2026-09-03" });
});

test("a regime window ends the day before the next regime opens, and the newest runs to the archive", () => {
  const days = ["2026-09-10", "2026-09-11"];
  // `09-04 famine` is followed by `sigma0.5` at 2026-09-07T09:46:03Z, so the famine's
  // last whole day is 09-06. This is the boundary the fourth reading's 1.23x covers.
  assert.deepEqual(resolveWindow("09-04 famine", days), { from: "2026-09-04", to: "2026-09-06", label: "09-04 famine" });
  const newest = FEED_REGIMES.at(-1)!;
  assert.equal(resolveWindow(newest.name, days).to, "2026-09-11");
});

test("the basket keeps only pairs present on every day", () => {
  const daily = dailyByPair([
    poll("2026-09-01T00:00:00Z", [["gold", "weekly", 0.02], ["copper", "weekly", 0.03]]),
    poll("2026-09-02T00:00:00Z", [["gold", "weekly", 0.02]]),
  ]);
  // copper is absent on day two, so it has no comparable baseline and is dropped
  // rather than compared against a window it does not span.
  assert.deepEqual(fixedBasket(daily, ["2026-09-01", "2026-09-02"]), ["gold|weekly"]);
});

test("a pair's day is the median over that day's polls, not the last one", () => {
  const daily = dailyByPair([
    poll("2026-09-01T01:00:00Z", [["gold", "weekly", 0.01]]),
    poll("2026-09-01T02:00:00Z", [["gold", "weekly", 0.02]]),
    poll("2026-09-01T03:00:00Z", [["gold", "weekly", 0.09]]),
  ]);
  assert.equal(daily.get("2026-09-01")!.get("gold|weekly"), 0.02);
});

test("non-positive and missing sigmas are skipped rather than poisoning a median", () => {
  const daily = dailyByPair([
    poll("2026-09-01T01:00:00Z", [["gold", "weekly", 0.02], ["gold", "daily", 0]]),
    poll("2026-09-01T02:00:00Z", [["gold", "weekly", 0.04]]),
  ]);
  assert.equal(daily.get("2026-09-01")!.has("gold|daily"), false);
  assert.equal(daily.get("2026-09-01")!.get("gold|weekly"), 0.03);
});

// ── The two statistics that must never be substituted for each other ──────────────
//
// This is the test that pins the 2026-09-07 finding. A pair sits at 0.02 for the whole
// baseline, spikes to 0.04 for one day, and returns. The window that contains the spike
// reads elevated; the day after it does not. Both are correct, and the constant was
// moved on the first while the desk was living in the second.

function spikeFixture(): { daily: DailyByPair; basket: string[] } {
  const polls: Poll[] = [];
  const level: Record<string, number> = {
    "2026-08-30": 0.02, "2026-08-31": 0.02, "2026-09-01": 0.02,
    "2026-09-04": 0.02, "2026-09-05": 0.04, "2026-09-06": 0.02,
  };
  for (const [day, sigma] of Object.entries(level)) {
    polls.push(poll(`${day}T00:00:00Z`, [["gold", "weekly", sigma], ["copper", "weekly", sigma * 1.5]]));
  }
  const daily = dailyByPair(polls);
  return { daily, basket: fixedBasket(daily, Object.keys(level)) };
}

test("a window containing a spike reads elevated; the day after the spike does not", () => {
  const { daily, basket } = spikeFixture();
  const base = ["2026-08-30", "2026-08-31", "2026-09-01"];
  assert.equal(elevation(daily, basket, ["2026-09-05"], base).median, 2);
  assert.equal(elevation(daily, basket, ["2026-09-06"], base).median, 1);
  // Three days, one of them the spike: the per-pair median is the middle value, which
  // here is the baseline level — so this window reads 1.0 and not the 2.0 of its spike.
  assert.equal(elevation(daily, basket, ["2026-09-04", "2026-09-05", "2026-09-06"], base).median, 1);
});

test("the mean and the median of the ratios are reported separately because they differ", () => {
  const daily = dailyByPair([
    poll("2026-09-01T00:00:00Z", [["a", "weekly", 0.02], ["b", "weekly", 0.02], ["c", "weekly", 0.02]]),
    // one pair moves a long way and two do not: the median says "nothing happened to the
    // typical pair", the mean says "the feed rose 34%". Quoting either alone is the error.
    poll("2026-09-02T00:00:00Z", [["a", "weekly", 0.02], ["b", "weekly", 0.02], ["c", "weekly", 0.04]]),
  ]);
  const basket = fixedBasket(daily, ["2026-09-01", "2026-09-02"]);
  const e = elevation(daily, basket, ["2026-09-02"], ["2026-09-01"]);
  assert.equal(e.median, 1);
  assert.equal(Number(e.mean.toFixed(4)), 1.3333);
});

test("pairOver is the median of a pair's daily medians", () => {
  const { daily } = spikeFixture();
  assert.equal(pairOver(daily, "gold|weekly", ["2026-09-04", "2026-09-05", "2026-09-06"]), 0.02);
});

test("median handles an even count and an empty list", () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.ok(Number.isNaN(median([])));
});

// The script refuses to read a gate out of this output, and says so in the text it
// prints. That sentence is load-bearing — it is the difference between a report and a
// constant that moves itself — so it is pinned rather than left to survive an edit.
test("the script does not offer its output as a recommendation", () => {
  const src = readFileSync(new URL("./feed-sigma.ts", import.meta.url), "utf8");
  assert.match(src, /Neither of those is a recommendation/);
  assert.match(src, /does not move the gate, and nothing should wire it to one/);
});
