import { FEED_SIGMA_WATCH, RISK_PARAMS } from "../risk/params.ts";
import { readArchive } from "../signals/archive.ts";
import { dailyByPair, elevation, fixedBasket, resolveWindow } from "../scripts/feed-sigma.ts";

// The watcher on `minDisplacementSigma`'s own denominator — `tasks/43` §2.
//
// `npm run feed-sigma` answers this question already, and that is the problem it has:
// it is a command somebody has to run, which is the same failure mode as a number in a
// note. Between 2026-09-10 and 2026-09-13 the gate carried no condition that could fire,
// and on 2026-09-12 the feed read its highest elevation in the archive with nobody
// looking.
//
// So this is the same arithmetic, wired to the watchdog's timer: one line a day with
// where the denominator is, and a loud one when it leaves the band. The band, the
// duration and the reference window are `FEED_SIGMA_WATCH` in `src/risk/params.ts`,
// where the argument for each is written down beside it.
//
// **It computes, it does not decide.** The alarm names the `minDisplacementSigma` that
// would demand today what the current value demanded in the reference window, and asks
// for that commit. Nothing here writes a constant.
//
// ⚠ **The reference window is not the day of the decision.** `minDisplacementSigma` was
// last chosen on the `reverted` feed, which is two days long — below the three
// `feed-sigma` will summarise, for the reason in `resolveWindow` — so every ratio here is
// against `pre-09-04`, the archive's quiet week, and the offset is stated rather than
// hidden: `reverted` itself read 0.92x and 0.90x of that baseline. So the line says "what
// X demanded in pre-09-04", never "what it demanded when it was chosen".

/** One UTC day's elevation: the median over pairs of that day's `sigma_total` against
 *  the same pair's baseline value. */
export type DayElevation = {
  day: string;
  ratio: number;
  pairs: number;
  /** False for the newest UTC day, whose polls are still arriving. A partial day is
   *  reported and never alarms: `sigma_total` is volatility over the outlook's
   *  *remaining* horizon, so it decays through the day and a morning-only median is not
   *  the same statistic as a whole day's. */
  complete: boolean;
};

export type FeedWatch = {
  baseline: { label: string; from: string; to: string; days: number };
  /** The config this read was scored under, carried on the result so a message can
   *  never describe a different band from the one that decided. */
  cfg: WatchConfig;
  days: DayElevation[];
  latest: DayElevation | null;
  partial: DayElevation | null;
  /** Consecutive complete days outside the band, ending at `latest`. */
  run: number;
  /** `run >= sustainedDays` — the bar for asking that the constant move. */
  firing: boolean;
  /** The `minDisplacementSigma` that would demand, at `latest`'s elevation, what the
   *  shipped value demanded in the baseline. Null when there is no complete day. */
  gateEquivalent: number | null;
  /** Why nothing was scored, when nothing was. */
  refusal: string | null;
};

export type WatchConfig = {
  band: readonly [number, number];
  sustainedDays: number;
  minBaselineDays: number;
};

const CFG: WatchConfig = {
  band: FEED_SIGMA_WATCH.band,
  sustainedDays: FEED_SIGMA_WATCH.sustainedDays,
  minBaselineDays: FEED_SIGMA_WATCH.minBaselineDays,
};

export function outsideBand(ratio: number, band: readonly [number, number]): boolean {
  return ratio < band[0] || ratio > band[1];
}

/** The run of consecutive **complete** days outside the band, ending at the newest one.
 *
 *  Counted from the end and stopping at the first day inside, so a spike two weeks ago
 *  contributes nothing: the question is whether the feed is outside *now*, not how often
 *  it has been. A partial day never counts, in either direction — it can neither start a
 *  run nor break one, because it is not the same statistic. */
export function runOutside(days: readonly DayElevation[], band: readonly [number, number]): number {
  let run = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i]!;
    if (!d.complete) continue;
    if (!outsideBand(d.ratio, band)) break;
    run++;
  }
  return run;
}

/** Everything but the archive read, so the decision is testable without one. */
export function assess(
  days: readonly DayElevation[],
  baseline: FeedWatch["baseline"],
  cfg: WatchConfig = CFG,
  sigma = RISK_PARAMS.minDisplacementSigma,
): FeedWatch {
  const complete = days.filter((d) => d.complete);
  const latest = complete.at(-1) ?? null;
  const partial = days.find((d) => !d.complete) ?? null;
  const base = { baseline, cfg, days: [...days], latest, partial };
  if (baseline.days < cfg.minBaselineDays) {
    return {
      ...base, run: 0, firing: false, gateEquivalent: null,
      refusal: `baseline ${baseline.label} covers ${baseline.days} day(s); ${cfg.minBaselineDays} is the minimum`,
    };
  }
  if (latest === null) {
    return { ...base, run: 0, firing: false, gateEquivalent: null, refusal: "no complete day in the archive" };
  }
  const run = runOutside(days, cfg.band);
  return {
    ...base,
    run,
    firing: run >= cfg.sustainedDays,
    gateEquivalent: sigma * latest.ratio,
    refusal: null,
  };
}

/** Reads the archive and scores every day in it. The only impure function here. */
export function readFeedWatch(dataRoot: string, nowMs = Date.now(), cfg: WatchConfig = CFG): FeedWatch {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const polls = readArchive(dataRoot);
  const daily = dailyByPair(polls);
  const allDays = [...daily.keys()].sort();
  const empty = { label: FEED_SIGMA_WATCH.baseline, from: "", to: "", days: 0 };
  if (allDays.length === 0) {
    return {
      baseline: empty, cfg, days: [], latest: null, partial: null, run: 0, firing: false,
      gateEquivalent: null, refusal: `no archive under ${dataRoot}/quotient/perps`,
    };
  }
  const w = resolveWindow(FEED_SIGMA_WATCH.baseline, allDays);
  const baseDays = allDays.filter((d) => d >= w.from && d <= w.to);
  const baseline = { label: w.label, from: w.from, to: w.to, days: baseDays.length };
  // The basket is the pairs present on every day, baseline included — the same fixed
  // basket `npm run feed-sigma` uses, so a pair that appears halfway through the archive
  // cannot be compared against a baseline it has no value in.
  const basket = fixedBasket(daily, allDays);
  const days = allDays.map((d): DayElevation => {
    const e = elevation(daily, basket, [d], baseDays);
    return { day: d, ratio: e.median, pairs: e.n, complete: d < today };
  });
  return assess(days, baseline, cfg);
}

const x = (r: number): string => `${r.toFixed(2)}x`;

/** The line that goes out every day whatever the number is. A watcher that only speaks
 *  when it is unhappy is one nobody can tell from a broken one. */
export function dailyLine(w: FeedWatch, sigma = RISK_PARAMS.minDisplacementSigma): string {
  if (w.refusal !== null) return `Feed sigma: not scored — ${w.refusal}.`;
  const l = w.latest!;
  const [lo, hi] = w.cfg.band;
  const state = outsideBand(l.ratio, w.cfg.band) ? "OUTSIDE the band" : "inside the band";
  return [
    `Feed sigma ${l.day}: ${x(l.ratio)} of ${w.baseline.label} (${state} ${x(lo)}-${x(hi)}), ${l.pairs} pairs.`,
    w.partial ? `Today so far: ${x(w.partial.ratio)}, partial and not counted.` : null,
    `minDisplacementSigma ${sigma} is demanding what ${(w.gateEquivalent ?? 0).toFixed(2)} demanded in the baseline.`,
    w.run > 0 ? `${w.run} consecutive day(s) outside; ${w.cfg.sustainedDays} is the bar.` : null,
  ].filter((s): s is string => s !== null).join("\n");
}

/** The loud one. Names the commit rather than making it. */
export function alarmMessage(w: FeedWatch, sigma = RISK_PARAMS.minDisplacementSigma): string {
  const l = w.latest!;
  const equiv = (w.gateEquivalent ?? 0).toFixed(2);
  const [lo, hi] = w.cfg.band;
  return [
    `Quotient's sigma_total has been outside ${x(lo)}-${x(hi)} of ` +
    `${w.baseline.label} for ${w.run} consecutive days — ${x(l.ratio)} on ${l.day}.`,
    "",
    `The gate divides by that number, so minDisplacementSigma ${sigma} is now demanding ` +
    `the displacement ${equiv} demanded in ${w.baseline.label}.`,
    `Holding the gate still takes minDisplacementSigma ${equiv} — a commit to ` +
    "`src/risk/params.ts`, a FEED_REGIMES row in the same commit, and a restart.",
    "",
    "Nothing has been changed. This has never fired before: every excursion in the",
    "archive so far lasted one day and corrected itself.",
    "npm run feed-sigma for the per-day column and the per-anchor split.",
  ].join("\n");
}

export function resolvedMessage(w: FeedWatch): string {
  const l = w.latest;
  return `Quotient's sigma_total is back inside ${x(w.cfg.band[0])}-${x(w.cfg.band[1])} of ` +
    `${w.baseline.label}${l ? ` — ${x(l.ratio)} on ${l.day}` : ""}.`;
}
