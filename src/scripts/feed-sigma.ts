import "dotenv/config";
import { FEED_REGIMES } from "../risk/regimes.ts";
import { RISK_PARAMS } from "../risk/params.ts";
import { readArchive, type Poll } from "../signals/archive.ts";

// **What Quotient's `sigma_total` is doing, measured rather than remembered.**
//
//   npm run feed-sigma                              # every day, against the pre-09-04 feed
//   npm run feed-sigma -- --baseline reverted       # against a different regime
//   npm run feed-sigma -- --window sigma0.5-again   # summarise a different block
//
// ── Why this is a command and not a number in a note ─────────────────────────────
//
// `sigma_total` is the **denominator of our entry gate**: `displacement_sigma` is
// `ln(median_price / ref_median) / sigma_total`, so when their estimate moves, the price
// displacement `minDisplacementSigma` demands moves with it and neither side has done
// anything. That has happened twice in twelve days and moved a live constant both times.
//
// It had been measured with throwaway scripts and the answer written into prose, and the
// prose then outlived the measurement (`notes/2026-09-11-sigma-elevation-recomputed.md`).
// Two properties of this output exist because of that:
//
//  1. **The per-day column is printed before any window summary, and the summary says
//     which days it covers.** The 1.23x that sized the 2026-09-07 gate change is a
//     correct median over **09-04..09-06**. The constant moved on **09-07**, when the
//     elevation read **1.03x**. Nothing was miscomputed; a window that had already
//     closed was used to describe the state on the day of a decision, and the note's own
//     per-day table showed the decay it then argued past.
//  2. **The window median and the per-day medians disagree, by 18 points here, and both
//     are shown.** They are different questions — "the typical pair's elevation on this
//     day" against "the typical pair's typical elevation over this window" — and with
//     one spike day in a three-day window the per-pair median lands *on* the spike for
//     34 of 51 pairs. Neither is wrong. Quoting a window figure as a current state is.
//
// The mean is printed beside every median for the same reason: the ratio distribution is
// right-skewed (1.33x mean against 1.23x median on the famine window, and **1.17x on
// 09-03, a baseline day where nothing happened**), so a mean quoted alone reads as a
// revision that is not there.
//
// ── The method, and the three things it controls for ─────────────────────────────
//
//  1. **A fixed basket.** Only (asset_key, anchor_type) pairs present on *every* day of
//     the archive. `sigma_total` is volatility over the outlook's own horizon, so it is
//     larger on longer anchors by construction — which means a change in the anchor mix
//     moves the feed-wide median with no change to any estimate. That is most of what a
//     raw median showed on 2026-09-04, when the `two-day` anchor (21% of the feed)
//     disappeared entirely.
//  2. **Per-pair ratios, not a ratio of medians.** Each pair is compared to its own
//     baseline and the ratios are then summarised, so a pair entering or leaving the
//     feed cannot masquerade as a revision.
//  3. **A baseline that is a window, never a day.** A single day is inside this
//     statistic's own noise — see the `spread within the baseline` line, which is
//     printed precisely so nobody sets a threshold below it again. `--baseline` takes a
//     regime name or an explicit `A..B` range and **refuses a bare date**.
//
// ── What this does NOT do ────────────────────────────────────────────────────────
//
// **It does not move the gate, and nothing should wire it to one.** A gate that
// rescales itself from a vendor statistic is a live risk constant that moves without a
// commit, on accounts holding other people's money — `CLAUDE.md` puts strategy
// parameters in version control for exactly that reason. This reports; a human decides,
// in a commit. `tasks/43` is the standing argument for the two honest alternatives: a
// denominator we compute ourselves, or a constant in git plus an alarm on this output.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

/** A window of whole UTC days, inclusive of both edges. */
export type Window = { from: string; to: string; label: string };

/** `--baseline` / `--window`: a regime name, or an explicit `YYYY-MM-DD..YYYY-MM-DD`.
 *
 *  **A bare date is refused rather than accepted as a one-day window.** Reading the
 *  elevation against a single day is the error this script was written after: 09-03 is
 *  a perfectly ordinary day whose basket median is 1.45x the quietest day in the same
 *  untouched week, so anything measured against it inherits that. The refusal is the
 *  point — it costs a keystroke and it removes a whole class of wrong answer. */
export function resolveWindow(v: string, days: readonly string[]): Window {
  const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(v);
  if (range) return { from: range[1]!, to: range[2]!, label: v };

  const i = FEED_REGIMES.findIndex((r) => r.name === v);
  if (i >= 0) {
    const from = FEED_REGIMES[i]!.from.slice(0, 10);
    // A regime runs to the day before the next one opens. The newest runs to the archive.
    const next = FEED_REGIMES[i + 1];
    const to = next ? prevDay(next.from.slice(0, 10)) : days.at(-1)!;
    return { from, to, label: v };
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new Error(
      `--baseline/--window ${v}: a single day is not a window. This statistic's own `
      + `day-to-day spread is wider than the revisions it is used to detect, so a one-day `
      + `baseline reads whatever that day happened to be. Pass a regime name `
      + `(${FEED_REGIMES.map((r) => r.name).join(", ")}) or an explicit ${v}..YYYY-MM-DD.`,
    );
  }
  throw new Error(
    `--baseline/--window ${v}: not a regime name (${FEED_REGIMES.map((r) => r.name).join(", ")}) `
    + `and not a YYYY-MM-DD..YYYY-MM-DD range.`,
  );
}

function prevDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export type PairKey = string;
/** day -> pair -> that pair's median `sigma_total` across the day's polls. */
export type DailyByPair = Map<string, Map<PairKey, number>>;

/** One row per (day, pair), the pair's own median over that day's polls.
 *
 *  Polls, not series: an unchanged poll is carried forward by `readArchive`, so a
 *  quiet hour is represented the same way a busy one is and a pair is not weighted by
 *  how often the recorder happened to see it change. */
export function dailyByPair(polls: readonly Poll[]): DailyByPair {
  const raw = new Map<string, Map<PairKey, number[]>>();
  for (const p of polls) {
    const day = p.t.toISOString().slice(0, 10);
    const byPair = raw.get(day) ?? new Map<PairKey, number[]>();
    for (const s of p.series) {
      const sigma = s.outlook?.sigma_total;
      if (!s.asset_key || !s.anchor_type || !Number.isFinite(sigma) || !(sigma > 0)) continue;
      const key = `${s.asset_key}|${s.anchor_type}`;
      byPair.set(key, [...(byPair.get(key) ?? []), sigma]);
    }
    raw.set(day, byPair);
  }
  const out: DailyByPair = new Map();
  for (const [day, byPair] of raw) {
    out.set(day, new Map([...byPair].map(([k, v]) => [k, median(v)])));
  }
  return out;
}

/** The pairs present on **every** day given. A pair that appears halfway through the
 *  archive is excluded rather than compared against a baseline it has no value in. */
export function fixedBasket(daily: DailyByPair, days: readonly string[]): PairKey[] {
  const sets = days.map((d) => new Set(daily.get(d)?.keys() ?? []));
  if (sets.length === 0) return [];
  return [...sets[0]!].filter((k) => sets.every((s) => s.has(k))).sort();
}

/** A pair's value over a window: the median of its daily medians. */
export function pairOver(daily: DailyByPair, pair: PairKey, days: readonly string[]): number {
  const xs = days.map((d) => daily.get(d)?.get(pair)).filter((v): v is number => v !== undefined);
  return median(xs);
}

export type Elevation = { median: number; mean: number; p10: number; p90: number; above: number; n: number };

/** Per-pair ratios of `window` against `baseline`, summarised.
 *
 *  A pair's value over a window is the median of its daily medians, so **a window is not
 *  the average of its days**: with one spike day in three, the middle value lands on the
 *  spike for most pairs and the window reads above two of the three days it contains
 *  (1.23x over 09-04..09-06, whose days read 1.05x, 1.28x, 1.05x). That is a real
 *  property of the statistic rather than a defect, and it is why the caller prints the
 *  per-day column too. */
export function elevation(
  daily: DailyByPair, basket: readonly PairKey[], windowDays: readonly string[], baseDays: readonly string[],
): Elevation {
  const rs: number[] = [];
  for (const p of basket) {
    const b = pairOver(daily, p, baseDays);
    const w = pairOver(daily, p, windowDays);
    if (Number.isFinite(b) && Number.isFinite(w) && b > 0) rs.push(w / b);
  }
  rs.sort((a, b) => a - b);
  const q = (f: number) => rs[Math.min(rs.length - 1, Math.floor(f * rs.length))] ?? NaN;
  return {
    median: median(rs), mean: mean(rs), p10: q(0.1), p90: q(0.9),
    above: rs.filter((r) => r > 1).length / rs.length, n: rs.length,
  };
}

function daysBetween(all: readonly string[], w: Window): string[] {
  return all.filter((d) => d >= w.from && d <= w.to);
}

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };

  const polls = readArchive(DATA_ROOT);
  if (polls.length === 0) {
    console.log(`\n  No archive under ${DATA_ROOT}/quotient/perps. This reads the recorder's own files.\n`);
    process.exitCode = 1;
    return;
  }
  const daily = dailyByPair(polls);
  const days = [...daily.keys()].sort();

  let baseline: Window, window: Window;
  try {
    baseline = resolveWindow(arg("--baseline") ?? FEED_REGIMES[0]!.name, days);
    window = resolveWindow(arg("--window") ?? FEED_REGIMES.at(-1)!.name, days);
  } catch (e) {
    console.log(`\n  ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }

  const baseDays = daysBetween(days, baseline);
  const windowDays = daysBetween(days, window);
  if (baseDays.length < 3) {
    console.log(`\n  --baseline ${baseline.label} covers ${baseDays.length} day(s) of archive. Three is the`);
    console.log(`  minimum this will summarise: below that the baseline is noise and everything`);
    console.log(`  measured against it inherits that noise.\n`);
    process.exitCode = 1;
    return;
  }

  const basket = fixedBasket(daily, days);
  console.log(`archive   ${days[0]} .. ${days.at(-1)}   ${polls.length} polls, ${days.length} days`);
  console.log(`basket    ${basket.length} (asset x anchor) pairs present on every day`);
  console.log(`baseline  ${baseline.label}  =  ${baseDays[0]} .. ${baseDays.at(-1)}  (${baseDays.length} days)`);

  // ── the per-day column, printed before any summary
  console.log(`\n  day          basket median   per-pair ratio vs baseline`);
  console.log(`                sigma_total      median      mean`);
  for (const d of days) {
    const vals = basket.map((p) => daily.get(d)!.get(p)).filter((v): v is number => v !== undefined);
    const e = elevation(daily, basket, [d], baseDays);
    const mark = windowDays.includes(d) ? " <" : "";
    console.log(`  ${d}      ${median(vals).toFixed(5)}       ${e.median.toFixed(2)}x     ${e.mean.toFixed(2)}x${mark}`);
  }

  // ── the noise floor, which is what a threshold has to clear
  const baseMedians = baseDays.map((d) => median(basket.map((p) => daily.get(d)!.get(p)!).filter(Number.isFinite)));
  const lo = Math.min(...baseMedians), hi = Math.max(...baseMedians);
  console.log(`\n  spread within the baseline itself: ${lo.toFixed(5)} .. ${hi.toFixed(5)} `
    + `(${(hi / lo).toFixed(2)}x) with nothing happening.`);
  console.log(`  A threshold on the absolute median narrower than that fires on noise.`);

  // ── the window summary
  const e = elevation(daily, basket, windowDays, baseDays);
  console.log(`\n  window  ${window.label}  =  ${windowDays[0]} .. ${windowDays.at(-1)}  (${windowDays.length} days)`);
  console.log(`    elevation   median ${e.median.toFixed(2)}x   mean ${e.mean.toFixed(2)}x   `
    + `p10 ${e.p10.toFixed(2)}x  p90 ${e.p90.toFixed(2)}x   ${(100 * e.above).toFixed(0)}% of pairs above 1.0`);

  // ── by anchor, which is the part that says whether it reaches what we trade
  console.log(`\n    by anchor`);
  const byAnchor = new Map<string, PairKey[]>();
  for (const p of basket) {
    const a = p.slice(p.lastIndexOf("|") + 1);
    byAnchor.set(a, [...(byAnchor.get(a) ?? []), p]);
  }
  for (const [a, pairs] of [...byAnchor].sort()) {
    const ea = elevation(daily, pairs, windowDays, baseDays);
    console.log(`      ${a.padEnd(10)} n=${String(ea.n).padStart(3)}   median ${ea.median.toFixed(2)}x   mean ${ea.mean.toFixed(2)}x`);
  }

  // ── what it means for the gate, in the only unit that matters
  const live = RISK_PARAMS.minDisplacementSigma;
  console.log(`\n  what it is worth to the gate`);
  console.log(`    minDisplacementSigma is ${live} in git.`);
  console.log(`    At ${e.median.toFixed(2)}x, ${live} demands the price displacement `
    + `${(live * e.median).toFixed(2)} sigma demanded in the baseline feed.`);
  console.log(`    Holding the baseline gate still today would take minDisplacementSigma `
    + `${(1 / e.median).toFixed(2)}.`);
  console.log(`\n  Neither of those is a recommendation. They are the conversion the gate's own`);
  console.log(`  denominator implies; moving the constant is a commit and a human's call (tasks/43).\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
