import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BUILDER_RATE, CALIBRATION, ENTRY_SLIP_SOURCE, ENTRY_SLIP_TOLERANCE, INTERVAL_MS,
  MEASURED_ENTRY_SLIP_BPS, REPLICATION_TOLERANCE_PP, armedStopPct, bestCell, bookMix,
  bps, calibrationLine, capConcurrency, clampedCount, dexOf, entrySlipLines,
  feeReconciliationLines, haltWalk, reconcileEntrySlip, reconcileFeeSchedule, replicate,
  replicationBlock, resolveSince, takerRate, windowOf,
  type EntryFill, type FeeFill, type Trade,
} from "./backtest.ts";

/** The scale the reconciliation must catch a change in, derived from the two rates the
 *  script exports rather than typed a second time. */
const HIP3_FEE_SCALE_FOR_TEST = takerRate("xyz") / takerRate("");
import { FEED_REGIMES } from "../risk/regimes.ts";
import { BUILDER_FEE, DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { tenthsBpToFraction } from "../hl/approve-builder-fee.ts";
import { clampStopPct, maxStopPct } from "../risk/sizing.ts";
import type { Poll } from "./expectancy.ts";

// `tasks/31` §3.1. `--days N` counts back from the archive's last poll, so isolating the
// feed that began 2026-09-08 meant `--days 1.5` today and a different fraction tomorrow.
// That is how a window silently becomes the wrong one, and the window decides which
// population every row in the sweep describes.

const poll = (t: string): Poll => ({ t: new Date(t), series: [] });

test("a bare date is UTC midnight, a timestamp is itself", () => {
  assert.equal(resolveSince("2026-09-08"), Date.parse("2026-09-08T00:00:00Z"));
  assert.equal(resolveSince("2026-09-07T09:46:03Z"), Date.parse("2026-09-07T09:46:03Z"));
});

// The windows worth isolating are exactly the boundaries `regimes.ts` already argues, and
// a name cannot be mistyped into a window that is off by a day the way a date can.
test("a regime name resolves to that regime's own boundary", () => {
  for (const r of FEED_REGIMES) assert.equal(resolveSince(r.name), Date.parse(r.from));
  assert.equal(resolveSince("reverted"), Date.parse("2026-09-08T00:00:00Z"));
});

// A `--since` that parsed to NaN would replay the whole archive and label it as one
// feed — the exact failure this flag exists to prevent, arriving silently.
test("anything else throws rather than becoming NaN", () => {
  assert.throws(() => resolveSince("last tuesday"), /not a date and not a regime name/);
  assert.throws(() => resolveSince("revertd"), /reverted/);
});

// Inclusive on the left, matching `regimeAt`: a poll exactly on a boundary belongs to the
// regime that boundary opens. The σ0.5 deploy is why — its first intent opened four
// seconds after the restart, and an exclusive edge would drop the poll that produced it.
test("the boundary poll is in the window, and the one before it is not", () => {
  const all = [
    poll("2026-09-07T23:59:59.999Z"),
    poll("2026-09-08T00:00:00.000Z"),
    poll("2026-09-08T00:00:00.001Z"),
  ];
  const w = windowOf(all, { sinceMs: resolveSince("2026-09-08"), days: 3 });
  assert.deepEqual(w.polls.map((p) => p.t.toISOString()), [
    "2026-09-08T00:00:00.000Z", "2026-09-08T00:00:00.001Z",
  ]);
  assert.equal(w.startMs, Date.parse("2026-09-08T00:00:00Z"));
  assert.equal(w.endMs, Date.parse("2026-09-08T00:00:00.001Z"));
});

// Without `--since` nothing changes: the old behaviour is the fallback, not a special case.
test("no --since counts back from the archive's last poll, as before", () => {
  const all = [poll("2026-09-01T00:00:00Z"), poll("2026-09-05T00:00:00Z"), poll("2026-09-08T00:00:00Z")];
  const w = windowOf(all, { days: 3 });
  assert.equal(w.startMs, Date.parse("2026-09-05T00:00:00Z"));
  assert.equal(w.polls.length, 2);
});

// The caveat is the difference between a simulator and a claim about returns, and it has
// been ignored in three separate notes while living only in prose. It now prints beside
// the rows it qualifies, so it is pinned the way `feed-sigma`'s refusal is.
//
// **Pinned on the constant, not on the digits** (`tasks/46` §1.3). This test used to
// regex-match "+3.49% against a live +0.83%" in the source, so it would have passed at a
// ratio of 1x or 40x and would have failed on a re-measurement for the wrong reason.
test("Table 1 prints the ~4x caveat beside the rows, not only in a note", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /comparable to EACH OTHER and not to the ledger/);
  // The sentence is built from CALIBRATION, and carries its window and its date.
  assert.match(src, /calibrationLine\(CALIBRATION\.returns\)/);
  // ⚠ And it says the ratio is history. `tasks/46` §2.1–§2.4 changed the model the 4× was
  // measured against — the same window went +3.49% → −2.78% — so printing the ratio
  // without that sentence would hand a reader a correction factor for a simulator that no
  // longer exists, in the wrong direction.
  const caveat = calibrationLine(CALIBRATION.returns);
  assert.match(caveat, /THAT RATIO IS HISTORY/);
  assert.match(caveat, new RegExp(CALIBRATION.returns.supersededOn));
  assert.ok(CALIBRATION.returns.supersededBy < 0 && CALIBRATION.returns.live > 0,
    "the supersession is the sign flip: modelled below zero against a live figure above it");
  const line = calibrationLine(CALIBRATION.returns);
  assert.match(line, /~4\.2x/, `the ratio the constant now implies: ${line}`);
  assert.match(line, /comparable to EACH OTHER and not to the ledger/);
  assert.ok(line.includes(CALIBRATION.returns.measuredOn), "the caveat does not say when it was measured");
  assert.ok(line.includes(CALIBRATION.returns.window), "the caveat does not say what window it was measured on");
});

// Table 4 is the one the 2% stop default was argued on, and it printed no calibration at
// all: the ~4x banner sits above Table 2 and speaks of returns. The worst-day figure
// lived in a params.ts comment and four notes.
test("Table 4 prints the worst-day calibration, with its own date and window", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /CALIBRATION\.worstDay\.ratio/);
  assert.match(src, /CALIBRATION\.worstDay\.measuredOn/);
  assert.match(src, /CALIBRATION\.worstDay\.window/);
  // The two are different numbers on different windows. A reader dividing a row by
  // either is the misuse both exist to prevent, so neither may be called the other.
  assert.notEqual(CALIBRATION.worstDay.ratio,
    CALIBRATION.returns.modelled / CALIBRATION.returns.live);
  assert.notEqual(CALIBRATION.worstDay.window, CALIBRATION.returns.window);
});

// Table 4's "one stop costs" multiplied the median ARMED stop (post-clamp) by the
// UNCLAMPED requested leverage, while every return in the same row used the leverage
// after `clampLeverage`. A `--leverage 20` run on a 10x-max market printed a 20x stop
// cost over 10x returns.
test("Table 4's stop cost uses the leverage the trades were entered at", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /const perStop = armed \* armedLev \* baseSettings\.perSignalPct/);
  assert.doesNotMatch(src, /const perStop = armed \* baseSettings\.leverage/);
  // And it says so when the two differ, rather than printing a number nobody can check.
  assert.match(src, /not the requested/);
});

// ── `--hold-hours`, and the refusal that keeps it one-dimensional ────────────────
//
// The two constants interact rather than compose: `sigma_total` is volatility over the
// remaining horizon and scales as sqrt(t), so widening the cap admits a long-anchor
// outlook earlier AND at a denominator up to 1.87x larger. A 2-D grid of the two reads
// as a surface to pick a corner off, and the corner would be fitted to one archive.
test("--hold-hours refuses to be gridded against a multi-value --sigmas", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /if \(holdHours && sigmas\.length > 1\)/);
  assert.match(src, /--hold-hours sweeps one constant at one sigma/);
});

test("--hold-hours refuses a value that is not positive hours", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  // NaN here would silently become a cap of `undefined` and sweep the shipped value
  // five times, printing five identical rows as if they were a comparison.
  assert.match(src, /holdHours\?\.some\(\(h\) => !Number\.isFinite\(h\) \|\| h <= 0\)/);
});

test("a cap sweep reports where in a forecast's life it entered, not only the mean", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  // Without these the sweep is unreadable: the cap moves entry phase, not hold time,
  // and a mean alone cannot show that.
  assert.match(src, /horizonAtEntryH/);
  assert.match(src, /sigmaAtEntry/);
  assert.match(src, /Table 1b/);
});

// ── `--stop`, the third sweep dimension ─────────────────────────────────────────
test("--stop reads 1 as one percent, not as a stop that can never fire", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  // `n > 1` rejected `--stop 1` outright and would have read `--stop 1` in a list as a
  // 100% stop had the bound been looser. Both spellings appear in this repo's notes.
  assert.match(src, /const n = Number\(x\); return n >= 1 \? n \/ 100 : n;/);
});

// ⚠ Was "--stop refuses to be swept alongside another dimension" until 2026-09-12.
// The refusal was right about the danger and wrong about the remedy: its own sentence
// argues against READING A CORNER OFF a surface, not against printing one, and the
// 09-12 reading needed the surface anyway — it ran this script four times and pasted
// the rows together by hand (`tasks/45` §1.1). So σ × stop prints, with an `n` and an
// interval in every cell and a best-cell line that refuses to name a winner.
test("--stop x --sigmas prints the surface rather than refusing it", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /const grid = \(stops\?\.length \?\? 0\) > 1 && sigmas\.length > 1;/);
  assert.match(src, /Table 3 . the stop x sigma surface/);
  // The safeguard is the count, not the coordinates: a grid always has a best corner.
  assert.match(src, /of the other \$\{b\.total - 1\} cells have a mean inside that interval/);
});

// **`--stop` x `--hold-hours` is still refused, and not out of symmetry.** The cap moves
// the SAMPLE — `sigma_total` scales as sqrt(remaining horizon), so a wider cap admits
// long-anchor outlooks at a deflated sigma — and two cells would then differ in which
// events they contain as well as in a constant.
test("--stop and --hold-hours are still refused together", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /stops && stops\.length > 1 && holdHours && holdHours\.length > 1/);
});

test("a stop sweep prints what was armed, because the liquidation clamp binds above ~5%", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  // Measured: at 10x every one of 141 trades clamps at --stop 7 and 8, median armed
  // 5.25%, so those two rows are identical and are not 7% and 8% rows.
  assert.match(src, /stop as asked . as armed/);
  assert.match(src, /effStopPct/);
});

test("only a sigma sweep labels its rows with a sigma", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /const rowPrefix = swept === "minDisplacementSigma"/);
});

// ⚠ Was "offers only the three the site offers" until 2026-09-12. The restriction was
// right while leverage was an input and wrong once it became the question: the stop
// ceiling is liqBufferFrac x (1/L - 1/2Lmax), so L is the ONLY thing that sets how much
// price room a stop can have, and {5,10,20} has a hole exactly where a 6-7% stop lives
// (9x -> 6.03%, 8x -> 7.00%). The refusal moved to where it is a decision about other
// people's money — SITE_OFFERS — and the banner says so on every run.
test("--leverage takes any whole leverage the venue does, and shouts when it is not on offer", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /!Number\.isInteger\(lv\) \|\| lv < 2 \|\| lv > 20/);
  assert.match(src, /20x -> 1\.75%   18x -> 2\.14%   10x -> 5\.25%   9x -> 6\.03%   8x -> 7\.00%   5x -> 12\.25%/);
  // The banner is the whole safety property of widening the flag.
  assert.match(src, /is NOT on offer/);
  assert.match(src, /Adopting it is a SITE_OFFERS change/);
});

// The ceiling the comment above quotes, recomputed rather than trusted: every one of
// those pairs is `clampStopPct` at that leverage on a 20x-max asset. A future edit that
// changes `liqBufferFrac` has to change the banner too, and this is what says so.
test("the stop ceilings the leverage banner quotes are clampStopPct's own", () => {
  const at = (lev: number) => clampStopPct(1, lev, 20, RISK_PARAMS.liqBufferFrac).stopPct;
  assert.equal((at(20) * 100).toFixed(2), "1.75");
  assert.equal((at(18) * 100).toFixed(2), "2.14");
  assert.equal((at(10) * 100).toFixed(2), "5.25");
  assert.equal((at(9) * 100).toFixed(2), "6.03");
  assert.equal((at(8) * 100).toFixed(2), "7.00");
  assert.equal((at(5) * 100).toFixed(2), "12.25");
});

// ── `haltWalk`: the daily-loss cap, which every return in this file is blind to ──
//
// A halt removes a day's winners along with its losers, so it is the one objection to a
// wide stop that survives `notes/2026-09-11-…-capacity.md` §1.1's correction. The model
// is worth testing rather than trusting for the reason the sizing arithmetic is: it
// decides whether a constant in front of fifteen accounts is safe.

const T = (opts: {
  open: string; heldH: number; net: number; marks?: { t: string; mark: number }[];
  assetClass?: string; side?: string;
  /** The stable outlook id. Two trades sharing one are two **legs of one signal**, which
   *  is the unit the replication row works in (`tasks/50` §1.2) — so a fixture that wants
   *  two signals has to say two ids, and one that wants a re-entry says one. */
  ref?: string;
}): Trade => ({
  sigma: 0, signalRef: opts.ref ?? "s", coin: "xyz:CL", side: opts.side ?? "long", openedAt: new Date(opts.open),
  leverage: 10, anchor: "daily", assetClass: opts.assetClass ?? "commodity",
  horizonAtEntryH: 24, sigmaAtEntry: 1, effStopPct: 0.01,
  // `priceRet` is the same exit in price at this fixture's 10x, so a trade that reads
  // -10% of margin caught a -1% price move. Derived rather than typed, so the two can
  // never drift apart inside a fixture and make a replication test pass on arithmetic
  // that does not hold.
  live: { reason: "retired", net: opts.net, priceRet: opts.net / 10, heldH: opts.heldH, resolved: true },
  hold: { reason: "retired", net: opts.net, priceRet: opts.net / 10, heldH: opts.heldH, resolved: true },
  path: (opts.marks ?? []).map((m) => ({ t: Date.parse(m.t), mark: m.mark })),
  ambiguous: false,
});

// `barMs` is required rather than defaulted (`tasks/46` §2.5): the walk's grid was a
// `300_000` literal regardless of `--interval`, so it is now an input and every caller
// states it. These fixtures place their marks on 5-minute boundaries.
// The three money constants the walk reads, from the constants rather than typed
// (`tasks/46` §3.3): as literals they described a desk that happened to match and would
// have gone on passing through a move of any of the three. The comments beside each
// assertion below quote the arithmetic these produce, so a move fails them loudly.
const WALK = {
  perSignalPct: DEFAULT_USER_SETTINGS.perSignalPct,
  reserveFrac: RISK_PARAMS.reserveFrac,
  dailyLossPct: RISK_PARAMS.dailyLossPct,
  barMs: INTERVAL_MS["5m"],
};

test("an ordinary losing day does not halt", () => {
  // Three stopped signals at a 1% stop and 10x: -10% of margin each, 0.99% of mandate.
  const w = haltWalk([0, 1, 2].map((i) => T({ open: `2026-09-01T0${i}:00:00Z`, heldH: 0.5, net: -0.10 })), WALK);
  assert.equal(w.haltedDays, 0);
  assert.equal(w.refused, 0);
});

test("losses past the cap halt the day, and everything after it is refused", () => {
  // -47% of margin is -4.65% of mandate, so three of them cross 10%.
  const trades = [0, 1, 2, 3, 4].map((i) => T({ open: `2026-09-01T0${i}:00:00Z`, heldH: 0.5, net: -0.47 }));
  const w = haltWalk(trades, WALK);
  assert.equal(w.haltedDays, 1);
  // The third close is what crosses the line, so the fourth and fifth never open.
  assert.equal(w.refused, 2);
  assert.equal(w.kept.length, 3);
});

test("the cap reads UNREALISED marks, so a book of open losers halts before any of them close", () => {
  // Two positions that end flat but are each -55% of margin at 02:00. Realised P&L is
  // zero all day; equity is not, and `tick()` reads equity. 0.55 x 0.099 = 5.45% of
  // mandate each, so the pair is 10.9% and past the cap — at -0.50 each the pair lands
  // on 9.9% and does NOT halt, which is how close this arithmetic runs.
  const marks = [{ t: "2026-09-01T02:00:00Z", mark: -0.55 }];
  const w = haltWalk([
    T({ open: "2026-09-01T01:00:00Z", heldH: 6, net: 0, marks }),
    T({ open: "2026-09-01T01:00:00Z", heldH: 6, net: 0, marks }),
  ], WALK);
  assert.equal(w.haltedDays, 1, "two open positions at -5.45% of mandate each cross the 10% cap");
  // And with the marks dropped it is an uneventful day, which is the whole point.
  const realisedOnly = haltWalk([
    T({ open: "2026-09-01T01:00:00Z", heldH: 6, net: 0 }),
    T({ open: "2026-09-01T01:00:00Z", heldH: 6, net: 0 }),
  ], WALK);
  assert.equal(realisedOnly.haltedDays, 0);
});

test("the halt is per UTC day and the next day opens again", () => {
  const trades = [
    ...[0, 1, 2].map((i) => T({ open: `2026-09-01T0${i}:00:00Z`, heldH: 0.5, net: -0.47 })),
    T({ open: "2026-09-01T20:00:00Z", heldH: 0.5, net: 0.10 }),
    T({ open: "2026-09-02T02:00:00Z", heldH: 0.5, net: 0.10 }),
  ];
  const w = haltWalk(trades, WALK);
  assert.equal(w.haltedDays, 1);
  assert.equal(w.refused, 1, "the 20:00 winner is inside the halted day");
  assert.ok(w.kept.some((t) => t.openedAt.toISOString().startsWith("2026-09-02")), "the next day trades");
});

test("a smaller position size moves the halt further away, which is the only dial that does", () => {
  // -47% of margin is -4.65% of mandate at 10% per signal and -2.33% at 5%, so the same
  // three trades halt the day at one size and are an ordinary bad morning at the other.
  const trades = [0, 1, 2].map((i) => T({ open: `2026-09-01T0${i}:00:00Z`, heldH: 0.5, net: -0.47 }));
  assert.equal(haltWalk(trades, WALK).haltedDays, 1);
  assert.equal(haltWalk(trades, { ...WALK, perSignalPct: 0.05 }).haltedDays, 0);
});

test("the halt refuses opens and never cancels a resting exit", () => {
  // The loser that halts the day is still open when it does; it must still close, or the
  // walk would model a desk whose venue-side exits vanish at a halt. They do not
  // (CLAUDE.md: SIGTERM leaves the reduce-only exits resting).
  const w = haltWalk([
    T({ open: "2026-09-01T01:00:00Z", heldH: 4, net: -1.05, marks: [{ t: "2026-09-01T02:00:00Z", mark: -1.05 }] }),
    T({ open: "2026-09-01T05:00:00Z", heldH: 1, net: 0.5 }),
  ], WALK);
  assert.equal(w.haltedDays, 1);
  assert.equal(w.kept.length, 1, "the 05:00 entry is refused");
  // -1.05 x 0.099 = -10.4% of mandate, realised at 05:00 whether or not we are halted.
  assert.ok(w.days[0]!.worstDrawdown <= -0.10);
});

// ── `--until`: the right edge, and why it is exclusive ──────────────────────────
//
// `tasks/45` §1.4. The 09-12 reading got its robustness from NESTED windows, which share
// their tail with the whole archive and are therefore not independent of it. A genuine
// first-half/second-half split needs a right edge, and the two halves must not share a
// poll or the second one is not out of sample.

test("--until is exclusive and --since inclusive, so the two halves partition the archive", () => {
  const all = [
    poll("2026-09-05T23:59:59.999Z"),
    poll("2026-09-06T00:00:00.000Z"),
    poll("2026-09-06T00:00:00.001Z"),
  ];
  const first = windowOf(all, { untilMs: resolveSince("2026-09-06"), days: 30 });
  const second = windowOf(all, { sinceMs: resolveSince("2026-09-06"), days: 30 });
  assert.deepEqual(first.entryPolls.map((p) => p.t.toISOString()), ["2026-09-05T23:59:59.999Z"]);
  assert.deepEqual(second.entryPolls.map((p) => p.t.toISOString()),
    ["2026-09-06T00:00:00.000Z", "2026-09-06T00:00:00.001Z"]);
  // Every poll in exactly one half, which is what makes the second half a test.
  assert.equal(first.entryPolls.length + second.entryPolls.length, all.length);
});

// Entries stop at the edge; the feed does not. Without this a trade opened on the last
// day of an out-of-sample half would find no retirement and score as a horizon close —
// a bias introduced by the flag that exists to remove one.
test("--until cuts entries at the edge and still reads the feed past it", () => {
  const all = [poll("2026-09-04T00:00:00Z"), poll("2026-09-06T00:00:00Z"), poll("2026-09-08T00:00:00Z")];
  const w = windowOf(all, { sinceMs: resolveSince("2026-09-04"), untilMs: resolveSince("2026-09-06"), days: 30 });
  assert.equal(w.entryPolls.length, 1);
  assert.equal(w.polls.length, 3);
  assert.equal(w.entryEndMs, resolveSince("2026-09-06") - 1);
});

test("--days counts back from the --until edge, not from the archive's end", () => {
  const all = [poll("2026-09-01T00:00:00Z"), poll("2026-09-05T00:00:00Z"), poll("2026-09-08T00:00:00Z")];
  const w = windowOf(all, { untilMs: resolveSince("2026-09-06"), days: 3 });
  assert.equal(w.startMs, Date.parse("2026-09-03T00:00:00Z"));
  assert.deepEqual(w.entryPolls.map((p) => p.t.toISOString()), ["2026-09-05T00:00:00.000Z"]);
});

// ── `capConcurrency`: the budget, which nothing in this file modelled ───────────
//
// `tasks/45` §2.2 asks whether the 96h horizon cap collapses because it holds more
// positions at once or because the entries it adds are worse. Holding the book at the
// narrower cap's level while admitting the wider cap's entries is what separates them.

test("a signal arriving at a full book is refused, and one arriving after a close is not", () => {
  const ts = [
    T({ open: "2026-09-01T00:00:00Z", heldH: 2, net: 0.1 }),
    T({ open: "2026-09-01T00:30:00Z", heldH: 2, net: 0.1 }),
    T({ open: "2026-09-01T01:00:00Z", heldH: 1, net: 0.1 }),   // third, book full
    T({ open: "2026-09-01T02:30:00Z", heldH: 1, net: 0.1 }),   // both have closed
  ];
  const { kept, refused } = capConcurrency(ts, 2);
  assert.equal(refused, 1);
  assert.deepEqual(kept.map((t) => t.openedAt.toISOString()),
    ["2026-09-01T00:00:00.000Z", "2026-09-01T00:30:00.000Z", "2026-09-01T02:30:00.000Z"]);
});

// A position closing exactly as the next opens frees its slot: the desk reads the venue
// before it decides, so a closed position is not open.
test("a slot freed at the same instant is available", () => {
  const ts = [
    T({ open: "2026-09-01T00:00:00Z", heldH: 1, net: 0.1 }),
    T({ open: "2026-09-01T01:00:00Z", heldH: 1, net: 0.1 }),
  ];
  assert.equal(capConcurrency(ts, 1).refused, 0);
});

test("the cap can only remove entries, never re-time them", () => {
  const ts = [0, 1, 2, 3, 4].map((i) => T({ open: `2026-09-01T0${i}:00:00Z`, heldH: 10, net: 0.1 }));
  const { kept, refused } = capConcurrency(ts, 3);
  assert.equal(kept.length + refused, ts.length);
  assert.deepEqual(kept.map((t) => t.openedAt.getTime()), ts.slice(0, 3).map((t) => t.openedAt.getTime()));
});

// ── `bestCell`: a grid always has a best corner ────────────────────────────────
//
// Whether it means anything is a question about its interval, and the count of cells it
// cannot be told apart from is the whole safeguard `tasks/45` §1.2 asks for.

test("the best cell is named with how many others sit inside its interval", () => {
  const b = bestCell([
    { mean: 0.0124, lo: -0.002, hi: 0.027 },
    { mean: 0.0117, lo: -0.003, hi: 0.026 },
    { mean: 0.0050, lo: -0.005, hi: 0.015 },
    { mean: -0.0195, lo: -0.040, hi: 0.001 },
  ])!;
  assert.equal(b.best.mean, 0.0124);
  assert.equal(b.total, 4);
  // 1.17% and 0.50% are inside -0.20%…+2.70%; -1.95% is not.
  assert.equal(b.inside, 2);
});

test("an empty grid names no best cell", () => {
  assert.equal(bestCell([]), null);
});

// ── `bookMix`: nine at once is not a risk reading; what the nine are is ────────
test("the book at its fullest is reported by asset class and direction", () => {
  const ts = [
    T({ open: "2026-09-01T00:00:00Z", heldH: 1, net: 0, assetClass: "commodity" }),
    T({ open: "2026-09-01T00:00:00Z", heldH: 1, net: 0, assetClass: "commodity" }),
    T({ open: "2026-09-01T00:00:00Z", heldH: 1, net: 0, assetClass: "equity", side: "short" }),
  ];
  assert.equal(bookMix(ts), "3: 2 commodity, 1 equity (2 long)");
  assert.equal(bookMix([]), "—");
});

// ── the armed block's legend, which was wrong at every leverage but 10x ─────────
//
// It printed "the clamp's ceiling is 3.5% ... and 5.25%" under whatever `--leverage`
// said, so a 5x run claimed a floor it does not have (7.0%) and called its 6% row
// clamped when 6% arms in full there. `--leverage` takes 2-20, so the figures are
// computed from `maxStopPct` — the executor's own function — rather than typed.
test("the clamp floor in the legend is derived, not a 10x literal", () => {
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /const tightest = maxStopPct\(lev, lev, RISK_PARAMS\.liqBufferFrac\)/);
  assert.doesNotMatch(src, /ceiling is 3\.5% on a 10x-max market/);
});

// The tightest ceiling at a leverage is the market whose own max equals it; anything
// higher leaves more room. That is what makes one number a floor for the whole run.
test("no market can clamp a stop below liqBufferFrac / 2L", () => {
  for (const lev of [5, 10, 18, 20]) {
    const floor = maxStopPct(lev, lev, RISK_PARAMS.liqBufferFrac);
    // `1/L - 1/2L` and `1/2L` differ in the last bit at 18x, which is a float and not a
    // disagreement — the identity is exact in arithmetic.
    assert.ok(Math.abs(floor - RISK_PARAMS.liqBufferFrac / (2 * lev)) < 1e-15);
    for (const assetMax of [lev, 20, 25, 40]) {
      assert.ok(maxStopPct(lev, assetMax, RISK_PARAMS.liqBufferFrac) >= floor - 1e-12);
    }
  }
  // The two figures CLAUDE.md publishes, derived from the constant rather than typed —
  // so moving `liqBufferFrac` fails here and the docs quoting it get looked at.
  const f = RISK_PARAMS.liqBufferFrac;
  assert.equal((maxStopPct(10, 20, f) * 100).toFixed(2), "5.25");
  assert.equal((maxStopPct(10, 10, f) * 100).toFixed(2), "3.50");
  assert.equal((maxStopPct(5, 20, f) * 100).toFixed(2), "12.25");
  assert.equal((maxStopPct(5, 5, f) * 100).toFixed(2), "7.00");
});

// ── `replicate`: `tasks/47` Rule 3, the check that the model is the desk ─────────
//
// **A model may justify a change only after it reproduces the desk it will change.** The
// 1% stop default of 2026-09-10 was argued on a sweep that ended a trade at its modelled
// stop; the desk re-opened 87 of them. What follows pins the arithmetic and — the part
// that matters more — the three ways this can decline to answer, because "we could not
// check" printing like "it reproduces" is the whole failure being guarded against.

const EV = (opts: { priceRet: number | null; open: string; trips?: number; holdToTarget?: boolean }) => ({
  priceRet: opts.priceRet, trips: opts.trips ?? 1,
  openedAt: new Date(opts.open), holdToTarget: opts.holdToTarget ?? false,
});

const WINDOW = { windowStartMs: Date.parse("2026-09-08T00:00:00Z"), windowEndMs: Date.parse("2026-09-11T00:00:00Z") };

test("the gap is modelled minus ledger, in percentage points of price", () => {
  const r = replicate({
    // Two modelled signals averaging +1.00% in price.
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0.20, ref: "a" }),
                     T({ open: "2026-09-09T01:00:00Z", heldH: 1, net: 0, ref: "b" })],
    ledgerEvents: [EV({ priceRet: 0.005, open: "2026-09-09T00:00:00Z" })],
    ...WINDOW,
  });
  // T() derives priceRet as net/10, so +0.20 and 0 are +2.00% and 0.00% → +1.00% mean.
  assert.equal(r.modelled!.n, 2);
  assert.equal(r.modelled!.legs, 2, "two outlooks, one leg each");
  assert.ok(Math.abs(r.modelled!.priceRet - 0.01) < 1e-12);
  assert.ok(Math.abs(r.ledger!.priceRet - 0.005) < 1e-12);
  assert.ok(Math.abs(r.gapPP! - 0.5) < 1e-9, "1.00% against 0.50% is a +0.50pp gap");
  assert.equal(r.ok, false, "0.50pp is outside the stated tolerance");
});

// ── `tasks/50` §1.2: the two sides must be in the same unit ─────────────────────
//
// `collapse` makes one signal one event and sums an account's legs into it. This side
// averaged over legs, so a model that re-entered twice contributed two draws against the
// ledger's one — the mixing `tasks/46` §1.1 retired for the readings, inside the check
// that guards them. The numerator is unchanged, so the error is exactly the ratio of legs
// to outlooks and it grows with re-entry.
test("a re-entered outlook is ONE signal on both sides, with its legs summed", () => {
  const r = replicate({
    // One outlook, two legs: −1% then +3% in price. Per leg that is +1%; per outlook +2%.
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: -0.10, ref: "one" }),
                     T({ open: "2026-09-09T05:00:00Z", heldH: 1, net: 0.30, ref: "one" })],
    ledgerEvents: [EV({ priceRet: 0.02, open: "2026-09-09T00:00:00Z", trips: 2 })],
    ...WINDOW,
  });
  assert.equal(r.modelled!.n, 1, "one outlook, however many legs it ran");
  assert.equal(r.modelled!.legs, 2);
  assert.ok(Math.abs(r.modelled!.priceRet - 0.02) < 1e-12, "the legs are summed, not averaged");
  assert.ok(Math.abs(r.gapPP!) < 1e-12, "against a ledger event that summed its own legs the same way");
  assert.equal(r.ok, true);
});

test("a missing market refuses the verdict rather than grading what is left", () => {
  const args = {
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0, ref: "a" })],
    ledgerEvents: [EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" })],
    ...WINDOW,
  };
  const clean = replicate(args);
  assert.equal(clean.ok, true, "with every market priced this window replicates exactly");

  const lost = replicate({ ...args, missingMarkets: ["xyz:COPPER"] });
  assert.equal(lost.ok, false, "a gap of zero on a window missing a market is not a pass");
  assert.match(lost.why, /market\(s\) missing/);
  assert.match(lost.why, /xyz:COPPER/);
  assert.equal(lost.gapPP, 0, "the arithmetic on what remains is still printed");

  const block = replicationBlock(lost, { windowLabel: "w" });
  assert.match(block, /UNREPLICATED/);
  assert.match(block, /xyz:COPPER/);
  assert.doesNotMatch(block, /✓/, "a run that lost a market must never carry a passing tick");
});

test("a gap inside the tolerance passes, and the tolerance is the constant", () => {
  // A gap of exactly the tolerance is inside it: the boundary is inclusive, so a
  // re-measurement that lands on the line does not flip the banner on rounding.
  const r = replicate({
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: REPLICATION_TOLERANCE_PP / 100 * 10 })],
    ledgerEvents: [EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" })],
    ...WINDOW,
  });
  assert.ok(Math.abs(r.gapPP! - REPLICATION_TOLERANCE_PP) < 1e-9);
  assert.equal(r.ok, true);
});

test("an empty side is NOT a pass — \"we could not check\" never prints like \"it agrees\"", () => {
  const noLedger = replicate({
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0 })], ledgerEvents: [], ...WINDOW,
  });
  assert.equal(noLedger.ok, false);
  assert.equal(noLedger.gapPP, null);
  assert.match(noLedger.why, /unreplicated/);

  const noModel = replicate({
    modelledTrades: [], ledgerEvents: [EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" })], ...WINDOW,
  });
  assert.equal(noModel.ok, false);

  const neither = replicate({ modelledTrades: [], ledgerEvents: [], ...WINDOW });
  assert.equal(neither.ok, false);
  assert.match(neither.why, /not the same as agreeing/);
});

test("a running trade is not scored, and an unpriced ledger event is not counted", () => {
  const r = replicate({
    modelledTrades: [
      T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0 }),
      { ...T({ open: "2026-09-09T02:00:00Z", heldH: 1, net: -5 }), live: { reason: "horizon", net: -5, priceRet: -0.5, heldH: 1, resolved: false } },
    ],
    ledgerEvents: [EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" }),
                   EV({ priceRet: null, open: "2026-09-09T03:00:00Z" })],
    ...WINDOW,
  });
  assert.equal(r.modelled!.n, 1, "the unresolved trade is excluded, not scored at the last candle");
  assert.equal(r.ledger!.n, 1, "an event with no venue exit price has no price return to compare");
  assert.equal(r.gapPP, 0);
});

test("the ledger side is bounded by the window and by the exit policy", () => {
  const r = replicate({
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0 })],
    ledgerEvents: [
      EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" }),
      EV({ priceRet: 0.5, open: "2026-09-01T00:00:00Z" }),           // before the window
      EV({ priceRet: 0.5, open: "2026-09-20T00:00:00Z" }),           // after it
      EV({ priceRet: 0.5, open: "2026-09-09T06:00:00Z", holdToTarget: true }),  // a different desk
    ],
    ...WINDOW,
  });
  assert.equal(r.ledger!.n, 1,
    "a hold-to-target account is a different exit policy — pooling it measures the policy mix, not the simulator");
});

test("the block says NOT REPLICATED loudly, and names Rule 3 when it fails", () => {
  const bad = replicationBlock(replicate({
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0.5 })],
    ledgerEvents: [EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" })],
    ...WINDOW,
  }), { windowLabel: "w" });
  assert.match(bad, /DOES NOT REPRODUCE THE DESK/);
  assert.match(bad, /Rule 3/);

  const none = replicationBlock(replicate({ modelledTrades: [], ledgerEvents: [], ...WINDOW }), { windowLabel: "w" });
  assert.match(none, /NOT REPLICATED/);
  assert.doesNotMatch(none, /✓/, "an unchecked run must never carry the tick a passing one does");

  const good = replicationBlock(replicate({
    modelledTrades: [T({ open: "2026-09-09T00:00:00Z", heldH: 1, net: 0 })],
    ledgerEvents: [EV({ priceRet: 0, open: "2026-09-09T00:00:00Z" })],
    ...WINDOW,
  }), { windowLabel: "w" });
  assert.match(good, /✓/);
  assert.match(good, /opposite sign cancel/, "a pass must still refuse to be read as mechanism-level agreement");
});

// ── `tasks/46` §2.1–§2.4: the four things the desk did that this did not ────────
//
// Each was a `no` row in `modelled()` on 2026-09-13 and each flattered the model, which
// is why the replication row read +0.31pp BETTER than the desk before they landed. The
// arithmetic is pinned here; that the rows stay closed is pinned in `modelled.test.ts`.

test("the builder fee derives from the constant the rail is signed at, never a literal", () => {
  // `net_pnl` has carried this since 2026-09-10 and no model charged it. If the rate moves
  // and the simulator keeps the old one, every row silently describes a cohort that no
  // longer exists — the class of error `tasks/46` was written about.
  assert.equal(BUILDER_RATE, tenthsBpToFraction(BUILDER_FEE.tenthsBp));
  assert.equal(BUILDER_RATE, 0.00006, "6 tenths of a bp is 0.6bp is 0.00006 of notional");
  // And it is charged ON TOP of the venue's schedule, not instead of it.
  assert.ok(BUILDER_RATE > 0 && takerRate("xyz") > 0);
  assert.ok(takerRate("xyz") + BUILDER_RATE > takerRate("xyz"));
});

test("bps is one conversion, so a band and a fee cannot be divided by different powers of ten", () => {
  assert.equal(bps(30), 0.003);
  assert.equal(bps(RISK_PARAMS.slippageBps), RISK_PARAMS.slippageBps / 10_000);
});

test("the band is charged adversely on both sides, and it is the worst case not the expected fill", () => {
  // The entry crosses up for a long and down for a short; a forced close does the
  // opposite. The direction is what this pins; the magnitude is the test below.
  const band = bps(MEASURED_ENTRY_SLIP_BPS);
  const px = 100;
  const longFill = px * (1 + 1 * band);
  const shortFill = px * (1 + -1 * band);
  assert.ok(longFill > px, "a long buys worse than the mark");
  assert.ok(shortFill < px, "a short sells worse than the mark");
  const longClose = px * (1 - 1 * band);
  assert.ok(longClose < px, "a long's forced close sells worse than the mark");
  // Round trip: a long that neither moves nor pays a fee still loses two bands — exactly
  // `-2b/(1+b)`, because the return is taken against the price we bought at and that price
  // is already a band above the mark. Slightly less than `2b`, and stated as the identity
  // rather than approximated, so a future change to where the band is applied fails here.
  const round = (longClose - longFill) / longFill;
  assert.ok(Math.abs(round - -2 * band / (1 + band)) < 1e-12);
  assert.ok(round > -2 * band, "against the banded entry, not against the mark");
});

// ── `tasks/50` §1.1: the band the desk pays, not the band the order accepts ──────
//
// Charging `RISK_PARAMS.slippageBps` in full was defended as the worst case. It was not
// conservative, it was the dominant term: 30bps at 10x is 3% of margin on the entry and
// again on the ~62% of trades that close by force, against a surface whose cells span
// about two points. The simulator missed the ledger by 0.47pp per signal over the whole
// archive because of it, and lands inside the 0.25pp tolerance at the measured figure.
test("the entry band charged is the measured fill, and the accept band is a different fact", () => {
  assert.ok(MEASURED_ENTRY_SLIP_BPS > 0, "fills do land against us on average, just barely");
  assert.ok(MEASURED_ENTRY_SLIP_BPS < RISK_PARAMS.slippageBps / 10,
    "the measured slip is an order of magnitude inside the band the IOC accepts; if these " +
    "ever converge the venue has started filling us at the limit and the model must be re-read");
  // The source of the figure travels with it, the way `CALIBRATION` does. A measurement
  // printed without its sample and its day becomes folklore in a fortnight.
  assert.match(ENTRY_SLIP_SOURCE, /2026-09-14/);
  assert.match(ENTRY_SLIP_SOURCE, /filled intents/);
  const src = readFileSync(new URL("./backtest.ts", import.meta.url), "utf8");
  assert.match(src, /const band = bps\(MEASURED_ENTRY_SLIP_BPS\)/,
    "the simulator must charge the measured figure, not RISK_PARAMS.slippageBps");
  // And the output says which number is which, because the two will be read side by side.
  assert.match(src, /RISK_PARAMS\.slippageBps is \$\{RISK_PARAMS\.slippageBps\}bps and is a different fact/);
});

const slipFill = (side: string, refPx: number, bpsAgainst: number): EntryFill => ({
  side, ref_px: refPx,
  entry_px: refPx * (1 + (side === "long" ? 1 : -1) * bpsAgainst / 10_000),
});

test("the measured band reconciles against the ledger, and a regime change fails it", () => {
  // A long filled 0.28bps above its mark and a short 0.28bps below are the SAME slip:
  // both paid the band, in opposite price directions.
  const ok = reconcileEntrySlip([
    slipFill("long", 100, MEASURED_ENTRY_SLIP_BPS), slipFill("short", 50, MEASURED_ENTRY_SLIP_BPS),
  ])!;
  assert.equal(ok.n, 2);
  assert.ok(Math.abs(ok.observedBps - MEASURED_ENTRY_SLIP_BPS) < 1e-9);
  assert.ok(Math.abs(ok.ratio - 1) < 1e-9);
  assert.equal(ok.ok, true);

  // Filling at the accept band instead of inside it is the regime change this exists to
  // catch, and it is far past 2x.
  const atTheLimit = reconcileEntrySlip([slipFill("long", 100, RISK_PARAMS.slippageBps)])!;
  assert.equal(atTheLimit.ok, false);
  assert.ok(atTheLimit.ratio > ENTRY_SLIP_TOLERANCE);
  assert.match(entrySlipLines(atTheLimit).join("\n"), /OFF/);

  // A mean is not a tail, and the worst fill is printed beside it rather than folded in.
  const withTail = reconcileEntrySlip([
    slipFill("long", 100, 0), slipFill("long", 100, 21),
  ])!;
  assert.ok(Math.abs(withTail.worstBps - 21) < 1e-9);
  assert.ok(withTail.observedBps < withTail.worstBps);

  // "Nothing to check against" never prints like "it agrees" — the same rule the fee
  // schedule's empty case follows.
  assert.equal(reconcileEntrySlip([]), null);
  assert.match(entrySlipLines(null).join("\n"), /unchecked/);
});

// ── `tasks/50` §1.3: the stop as armed is measured against the planning mark ─────
//
// `buildIntent` plans the stop from the mark; measuring it against the banded fill mixed
// the entry's own cost into a statistic about the stop. Every "as asked → as armed" line
// read the band wide, and the count that is supposed to say *the clamp bound here* said
// the opposite of the truth at the one leverage where the clamp always binds.
test("at 20x a 2% stop is clamped on a 20x-max market, and the fill used to hide it", () => {
  const asked = DEFAULT_USER_SETTINGS.stopPct;
  assert.equal(asked, 0.02, "the default this is stated for");
  const { stopPct: armed, clamped } = clampStopPct(asked, 20, 20, RISK_PARAMS.liqBufferFrac);
  assert.equal(clamped, true, "1.75% is all a 20x account can arm on a 20x-max market");

  // A long: the stop sits below the mark and `buildIntent` derives it from the mark.
  const markPx = 100;
  const stopPx = markPx * (1 - armed);
  const againstMark = armedStopPct(stopPx, markPx)!;
  assert.ok(Math.abs(againstMark - armed) < 1e-12, "the armed fraction comes back exactly");
  assert.equal(clampedCount([againstMark], asked), 1, "every trade on that market is clamped");

  // What the old measurement did, at the band that was charged with it: the distance to
  // a fill 30bps above the mark reads WIDER than the ask, so the clamp that bound on
  // every trade counted as binding on none — `2.0% → 2.11%, 1 of 162 clamped`.
  const oldBand = bps(RISK_PARAMS.slippageBps);
  const fillPx = markPx * (1 + oldBand);
  const againstFill = Math.abs(stopPx - fillPx) / fillPx;
  assert.ok(againstFill > asked, `the old figure read ${(againstFill * 100).toFixed(2)}% against a 2% ask`);
  assert.equal(clampedCount([againstFill], asked), 0, "which is why the count read 1 of 162");

  // And the consequence Table 4 prints: `one stop costs` is the armed stop x leverage x
  // position size x (1 − reserve). Against the mark at the shipped default it is the
  // connect screen's own figure; against the fill it was 2.28% where the screen says 1.98%.
  const shipped = DEFAULT_USER_SETTINGS;
  const cost = (stop: number) => stop * 10 * shipped.perSignalPct * (1 - RISK_PARAMS.reserveFrac);
  assert.equal((cost(asked) * 100).toFixed(2), "1.98");
  assert.ok(cost(asked * (1 + oldBand / asked)) > cost(asked), "the band inflated it");
});

// The one that is worth stating as a claim rather than as arithmetic, because it is the
// calibration's whole story: the four gaps all pointed the same way.
test("every gap that was closed was one that flattered the model", () => {
  assert.ok(CALIBRATION.returns.modelled > CALIBRATION.returns.live,
    "before: the simulator read better than the ledger on the one window where both existed");
  assert.ok(CALIBRATION.returns.supersededBy < CALIBRATION.returns.live,
    "after: on that same window it reads worse — the correction overshot, which is why the " +
    "replication row is a live check and not a factor anybody divides by");
});

// ── The fee schedule against the venue's own receipts (`tasks/46` §3.4) ────────────
//
// `TAKER_NATIVE` and `HIP3_FEE_SCALE` decide every fee figure this script prints and
// were reconciled against nothing. The 0.2× behind the second was measured once, on
// 2026-09-02 (`notes/2026-09-02-fill-truth-findings.md`), and the venue publishes no
// `deployerFeeScale` to read it from — so the ledger's own fills are the only source
// there has ever been. `npm run fills` runs this against the real rows; what is tested
// here is the arithmetic that decides whether they agree.

const feeFill = (over: Partial<FeeFill> = {}): FeeFill =>
  ({ coin: "BTC", px: 100, sz: 10, fee: 0.45, fee_token: "USDC", crossed: 1, ...over });

/** A fill whose fee is exactly `rate × notional`. */
const atRate = (coin: string, rate: number, notional = 1000): FeeFill =>
  feeFill({ coin, px: notional, sz: 1, fee: rate * notional });

test("a venue charging exactly the schedule reconciles, on both dexes", () => {
  const rows = reconcileFeeSchedule([
    atRate("BTC", takerRate("")),
    atRate("xyz:NVDA", takerRate("xyz")),
  ]);
  assert.deepEqual(rows.map((r) => r.dex), ["", "xyz"]);
  for (const r of rows) {
    assert.equal(r.ok, true, `${r.dex}: ${r.ratio}`);
    assert.ok(Math.abs(r.ratio - 1) < 1e-12);
  }
});

// The fill row does not say whether the account had approved the builder fee, and seven
// of fourteen accounts had by 2026-09-11 — so both ends of that band have to reconcile
// or the check fires on the cohort rather than on the schedule.
test("a builder fee on top of the schedule is inside the band, not a failure", () => {
  const withFee = reconcileFeeSchedule([atRate("BTC", takerRate("") + BUILDER_RATE)]);
  assert.equal(withFee[0]!.ok, true);
  assert.ok(withFee[0]!.ratio > 1.1, "and it really is a materially higher rate: 5.1bp against 4.5bp");
  // On `xyz:` the builder fee is most of the charge — 0.6bp on top of 0.9bp — which is
  // why a band rather than a point comparison is the only workable shape here.
  const hip3 = reconcileFeeSchedule([atRate("xyz:NVDA", takerRate("xyz") + BUILDER_RATE)]);
  assert.equal(hip3[0]!.ok, true);
  assert.ok(hip3[0]!.ratio > 1.6, `${hip3[0]!.ratio}`);
});

test("a schedule more than 20% off the receipts fails, and says by how much", () => {
  const doubled = reconcileFeeSchedule([atRate("BTC", takerRate("") * 2)]);
  assert.equal(doubled[0]!.ok, false);
  assert.ok(Math.abs(doubled[0]!.ratio - 2) < 1e-12);
  assert.match(feeReconciliationLines(doubled).join("\n"), /OFF SCHEDULE/);

  // The specific regression this exists to catch: `HIP3_FEE_SCALE` stops being 0.2 and
  // `xyz:` starts being charged at the native rate. Every `xyz:` fee in every table
  // would be five times too small, and `xyz:` is most of what the desk trades.
  const unscaled = reconcileFeeSchedule([atRate("xyz:NVDA", takerRate(""))]);
  assert.equal(unscaled[0]!.ok, false);
  assert.ok(Math.abs(unscaled[0]!.ratio - 1 / HIP3_FEE_SCALE_FOR_TEST) < 1e-9, `${unscaled[0]!.ratio}`);
});

test("maker fills and non-USDC fees are left out rather than averaged in", () => {
  // A maker fill is a different schedule (1.5bp native), so including it would drag the
  // taker rate down and read as a tier change that never happened.
  const rows = reconcileFeeSchedule([
    atRate("BTC", takerRate("")),
    feeFill({ crossed: 0, fee: 0.15 }),
    feeFill({ fee_token: "HYPE", fee: 99 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.fills, 1, "one taker fill in USDC, and only that one");
  assert.equal(rows[0]!.ok, true);
});

test("no taker fills says the schedule is unchecked rather than saying it agrees", () => {
  assert.deepEqual(reconcileFeeSchedule([]), []);
  assert.match(feeReconciliationLines([]).join("\n"), /unchecked/);
});

// ⚠ The first real run of this, 2026-09-13 on 1,284 taker fills, found a **third**
// component nobody had recorded: the 4% Hyperliquid referral discount (`tasks/37`). It
// applies to the venue fee and **not** to the builder fee, which is added on top of the
// discounted number — which is what makes the four per-account native rates exactly
// these four and nothing else. Nothing here models it; this is where the decomposition
// is written down, and it is why the band needs a tolerance wide enough to hold a rate
// 4% *below* the schedule.
const REFERRAL_DISCOUNT = 0.04;

test("the four rates a real account is charged decompose into schedule, referral and builder", () => {
  const bp = (x: number) => Number((x * 10_000).toFixed(3));
  const referred = (rate: number) => rate * (1 - REFERRAL_DISCOUNT);

  assert.equal(bp(takerRate("")), 4.5, "schedule only");
  assert.equal(bp(referred(takerRate(""))), 4.32, "referred, grandfathered off the builder fee");
  assert.equal(bp(takerRate("") + BUILDER_RATE), 5.1, "builder fee, no referral");
  assert.equal(bp(referred(takerRate("")) + BUILDER_RATE), 4.92, "referred AND charged the builder fee");

  assert.equal(bp(takerRate("xyz")), 0.9);
  assert.equal(bp(referred(takerRate("xyz"))), 0.864);
  assert.equal(bp(takerRate("xyz") + BUILDER_RATE), 1.5);
  assert.equal(bp(referred(takerRate("xyz")) + BUILDER_RATE), 1.464);

  // And the reconciliation accepts the discounted end, which is the point of the ±20%.
  const discounted = reconcileFeeSchedule([atRate("xyz:NVDA", referred(takerRate("xyz")))]);
  assert.equal(discounted[0]!.ok, true, `${discounted[0]!.ratio}`);
});

test("the dex is read off the symbol, the way the venue spells it", () => {
  assert.equal(dexOf("BTC"), "");
  assert.equal(dexOf("xyz:NVDA"), "xyz");
  assert.equal(dexOf("xyz:PLATINUM"), "xyz");
});
