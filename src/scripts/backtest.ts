import "dotenv/config";
import { isTestnet, makeInfoClient } from "../hl/clients.ts";
import { Universe } from "../hl/universe.ts";
import { GATE } from "../exec/loop.ts";
import { evaluateSeries, liveDisplacementSigma, stableOutlookId } from "../mapping/quotient.ts";
import { buildIntent, type Market } from "../mapping/intent.ts";
import { BUILDER_FEE, DEFAULT_USER_SETTINGS, RISK_PARAMS, minFundedForLiveUsd, type UserSettings } from "../risk/params.ts";
import { tenthsBpToFraction } from "../hl/approve-builder-fee.ts";
import { maxStopPct } from "../risk/sizing.ts";
import { FEED_REGIMES } from "../risk/regimes.ts";
import { SITE_OFFERS } from "../web/discovery.ts";
import { readArchive, type Poll } from "../signals/archive.ts";
import { replay } from "./exit-policy.ts";
import { collapse, loadTrips } from "./expectancy.ts";
import { modelledTable } from "./modelled.ts";
import { Store } from "../store/db.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

// `tasks/02`'s simulator, built 2026-09-07 for one question the live ledger cannot
// answer: **what would a lower `minDisplacementSigma` have traded, and would it have
// made money?**
//
//   npm run backtest                    # last 3 days, σ sweep, both exit policies
//   npm run backtest -- --days 8        # the whole archive
//   npm run backtest -- --sigmas 1,0.7,0.5
//   npm run backtest -- --since 2026-09-08          # one feed regime, by date
//   npm run backtest -- --since reverted            # the same window, by its name
//   npm run backtest -- --hold-hours 48,72,96,120,168 --sigmas 0.5
//                                       # sweep maxHoldHours instead, at one sigma
//   npm run backtest -- --sigmas 0 --stop 0.02     # every directional call, 2% stop
//   npm run backtest -- --sigmas 0 --stop 2,4,6,8,10,12 --leverage 5
//                                       # wide stops need low leverage: the clamp
//                                       # caps the stop at 5.25% at 10x
//   npm run backtest -- --stop 1,2,3,4,6 --sigmas 1.0,0.7,0.5,0
//                                       # the stop x sigma SURFACE, one command
//   npm run backtest -- --until 2026-09-06 --stop 1,2,3,4,6 --sigmas 0.5
//   npm run backtest -- --since 2026-09-06 --stop 1,2,3,4,6 --sigmas 0.5
//                                       # pick a cell on the first half, score it on
//                                       # the second. `--until` is exclusive, so the
//                                       # two halves share no poll.
//   npm run backtest -- --hold-hours 96 --sigmas 0 --max-concurrent 7
//                                       # the 96h cap's entries, the 48h cap's book
//   npm run backtest -- --no-reentry    # the pre-2026-09-13 model: one trade per outlook,
//                                       # ever. NOT this desk; kept to read old notes by
//   npm run backtest -- --no-builder-fee   # the grandfathered cohort, which pays no fee
//
// ── Why this exists now, when `tasks/02` deliberately refused to write it ─────────
//
// That task says its next reading "starts by re-running that count, not by writing a
// simulator", because a simulator built before the sample exists is how a gate becomes
// theatre. That reasoning was about **validating the strategy**, and it still stands:
// nothing here is evidence that following Quotient's signals makes money.
//
// What changed on 2026-09-07 is a different question. `minDisplacementSigma` moved
// 1.0 → 0.5 on an argument about the feed's own σ scale
// (`notes/2026-09-07-phase3-fourth-reading.md`), and **there is no live P&L at 0.5σ at
// all** — every one of the 21 measured events cleared 1.0. So the constant now in
// production was chosen with zero evidence about the trades it admits, and the archive
// is the only place that evidence can come from. That is a narrower claim than
// "does the strategy work", and it is the only claim this file makes.
//
// ── The honesty rules, and where each comes from ─────────────────────────────────
//
//  1. **The gate, the sizing and the replay are imported, never reimplemented.**
//     `evaluateSeries`, `GATE`, `buildIntent` and `replay` are the same functions the
//     executor and the exit-policy counterfactual run. `tasks/02`: "a backtest that
//     reimplements the entry gate measures a strategy we will not run, which is exactly
//     how a gate becomes theatre."
//  2. **The plan is made on what we saw; the fill happens at what came next.** The
//     intent is built from the last close at or before the poll, and filled at the
//     *next* candle's open. `tasks/02`: "never enter at `observed_at` — we could not
//     have known."
//  3. **Outlooks are keyed on `stableOutlookId`**, because the raw id rotates per
//     revision and counting on it inflates the event count several-fold — the direction
//     that would manufacture a sample this task does not have. ⚠ **This rule used to end
//     "one trade per stable outlook id, ever"**, which was stronger than anything the
//     desk does: `considerSignals` refuses `already-open` against live intents, so an
//     outlook is tradeable again the moment its position closes. Since 2026-09-13 the
//     model re-enters as the desk does, `blockReentryAfterStop` included
//     (`tasks/46` §2.3). `--no-reentry` restores the old behaviour, which is not this desk.
//  4. **A candle that touches target and stop resolves to the stop.** `replay`'s own
//     rule, conservative, and it counts how often it had to.
//  5. **Fees are charged as taker on both legs, plus the builder fee.** Every exit in the
//     live ledger was a taker — 21 of 21 — so there is no maker leg to model. The builder
//     fee has been in `net_pnl` since 2026-09-10 and in no model until 2026-09-13;
//     `--no-builder-fee` prices the grandfathered cohort instead (`tasks/46` §2.2).
//  6. **Funding is not modelled.** Bounded by measurement rather than assumed away:
//     across the live ledger funding totals $0.0126 against $0.4579 of fees. At these
//     hold lengths it does not move an answer, and `notes/2026-09-04-…` shows it is
//     charged to the isolated position's own margin either way.
//  7. **The published sigma is re-tested against the fill** (`tasks/46` §2.1), on
//     magnitude and on sign, exactly as `loop.ts` re-tests it against the mark it is about
//     to trade at. The archive's median poll gap is 30.3 minutes, so a market that has
//     already walked to the target carries no edge — and this used to admit every one of
//     those. Refusals print as `stale at the fill`, and there were **29 of them against 28
//     admitted** at σ1.0 over 09-08 → 09-11.
//  8. **The 30bps band is charged on the entry and on a forced close** (`tasks/46` §2.4),
//     never on a trigger fill, where modelling it would need intra-bar data no interval
//     the venue serves supplies. Charging it in full is the worst case rather than the
//     expected fill: the band is the price the order accepts, not where it lands.
//
// ── What this is NOT ─────────────────────────────────────────────────────────────
//
// **Not a reason to move σ again.** The value a sweep picks on the events that produced
// it is a hypothesis for the next block of trades, not a measurement of that value —
// the same flattery `stop-sweep` refuses on its own output
// (`notes/2026-09-06-thirty-events-is-a-floor-not-a-threshold.md` §4).
//
// *"Read the σ=1.0 row against the live ledger first"* used to be the last line here, and
// it was advice nobody could act on without a second script and an afternoon. It is the
// **replication row** now: printed above every table, on the shipped gate and the shipped
// stop, against `expectancy`'s own figure for the same window, with a banner when it does
// not agree (`tasks/47` Rule 3).

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
/** The same ledger `expectancy` reads, resolved the same way, for the replication row.
 *  Opened read-only and only if it is there: this script runs on the dev Mac against an
 *  archive and a venue, and a box with no ledger must print *"unreplicated"* rather than
 *  create one. */
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

/** Hyperliquid's tier-0 perp schedule, read off the venue's own fee page 2026-09-06
 *  (`notes/2026-09-01-builder-fee-decision.md`): taker 0.0450%, maker 0.0150%.
 *  HIP-3 `xyz:` markets are charged at **0.2× the native schedule on both sides** —
 *  measured from real fills, not documented anywhere
 *  (`notes/2026-09-02-fill-truth-findings.md`); `deployerFeeScale` is not on `perpDexs`
 *  and cannot be read from metadata. */
const TAKER_NATIVE = 0.00045;
const HIP3_FEE_SCALE = 0.2;

export function takerRate(dex: string): number {
  return dex === "" ? TAKER_NATIVE : TAKER_NATIVE * HIP3_FEE_SCALE;
}

/** The dex a Hyperliquid symbol belongs to: `""` native, `"xyz"` for `xyz:NVDA`. */
export function dexOf(coin: string): string {
  const i = coin.indexOf(":");
  return i < 0 ? "" : coin.slice(0, i);
}

/** **What an entry fill actually lands at, against the mark it was planned on.**
 *
 *  `RISK_PARAMS.slippageBps` is 30 and this is 0.28, and the two are not competing
 *  estimates of the same thing: **30bps is the price the IOC will accept, this is where
 *  it lands.** Until 2026-09-14 this script charged the accept band in full on the entry
 *  and again on every forced close (`tasks/46` §2.4, deliberately as a worst case), which
 *  at 10x is 3% of margin twice on ~62% of trades — ~5% of margin per signal, on a
 *  surface whose cells span about two points. It was not a conservative assumption, it
 *  was the dominant term (`tasks/50` §1.1).
 *
 *  **Measured, on every filled intent the ledger holds** — `entry_px` against `ref_px`,
 *  signed so that positive is against us, operator-test intents excluded:
 *
 *      n = 631     mean +0.28bps     mean |x| 1.57bps     worst against us 20.99bps
 *      long  392   +0.27bps          short 239  +0.30bps
 *
 *  measured 2026-09-14 on `data/snap-0914.sqlite`, and +0.283bps on the 580 fills of
 *  `snap-0912` two days earlier — the figure is not a single window's accident.
 *
 *  ⚠ **The forced-close leg is not measured and is charged this figure too.** A close
 *  crosses the spread the same way an entry does, but nothing stores the mark at the tick
 *  the close was sent, so there is no `entry_px`-shaped column to measure it from
 *  (`tasks/50` §1.1 names the query that would produce one). Charging the entry figure on
 *  both legs is the best available assumption and it is stated rather than hidden.
 *
 *  ⚠⚠ **A mean is not a tail.** One fill in 631 landed 21bps against us. A model that
 *  charges the mean prices the typical trade correctly and prices the worst one at a
 *  thirtieth of what it cost; nothing in this file is a claim about the tail. */
export const MEASURED_ENTRY_SLIP_BPS = 0.28;

/** Where that figure came from, printed under the band line so the number is never a
 *  bare constant in the output. Same discipline as `CALIBRATION`: a measurement carries
 *  its day and its sample or it becomes folklore. */
export const ENTRY_SLIP_SOURCE =
  "631 filled intents, entry_px against ref_px, measured 2026-09-14 "
  + "(mean 0.28bps against us, 1.57 absolute, worst 21)";

/** How far the measured slip may drift from what the ledger charges before `npm run
 *  fills` says so. **2× either way**, which is much wider than the fee schedule's ±20%
 *  and has to be: this is a mean of a signed quantity that sits near zero, so it moves on
 *  a handful of fills in a way a rate charged per fill never does. What the band is for
 *  is a regime change — a venue that starts filling us at the limit rather than inside
 *  it — not a re-measurement. */
export const ENTRY_SLIP_TOLERANCE = 2;

/** The fields of an `intents` row the slip reconciliation needs. Structural, like
 *  `FeeFill`, so the test hands it literals and `npm run fills` hands it the ledger. */
export type EntryFill = { side: string; ref_px: number; entry_px: number };

export type SlipReconciliation = {
  n: number;
  /** Mean of `(entry − ref)/ref`, in bps, **signed so positive is against us** — the
   *  quantity the simulator charges. The absolute mean is a different number and is
   *  printed beside it rather than instead of it. */
  observedBps: number;
  meanAbsBps: number;
  /** The single worst fill against us. A mean cannot see it and the model does not
   *  charge it; it is printed so nobody reads the mean as a bound. */
  worstBps: number;
  /** `MEASURED_ENTRY_SLIP_BPS` — what this file charges. */
  assumedBps: number;
  ratio: number;
  ok: boolean;
};

/** **The measured band against the ledger's own fills** — `tasks/50` §1.1, and the same
 *  shape as `reconcileFeeSchedule` for the same reason: a constant that decides every row
 *  of a sweep and is reconciled against nothing is a constant that will be wrong quietly.
 *
 *  Returns `null` on an empty sample rather than a zero, because "no fills to check
 *  against" and "the fills agree" must never print the same way. */
export function reconcileEntrySlip(
  fills: readonly EntryFill[],
  assumedBps: number = MEASURED_ENTRY_SLIP_BPS,
  tolerance: number = ENTRY_SLIP_TOLERANCE,
): SlipReconciliation | null {
  const xs: number[] = [];
  for (const f of fills) {
    if (!(f.ref_px > 0) || !(f.entry_px > 0)) continue;
    xs.push((f.side === "long" ? 1 : -1) * (f.entry_px - f.ref_px) / f.ref_px * 10_000);
  }
  if (xs.length === 0) return null;
  const observedBps = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanAbsBps = xs.reduce((a, b) => a + Math.abs(b), 0) / xs.length;
  const ratio = observedBps / assumedBps;
  return {
    n: xs.length, observedBps, meanAbsBps, worstBps: Math.max(...xs), assumedBps, ratio,
    ok: ratio >= 1 / tolerance && ratio <= tolerance,
  };
}

/** One block for a script to print, saying what it could not check rather than nothing. */
export function entrySlipLines(r: SlipReconciliation | null): string[] {
  if (r === null) {
    return ["entry slippage: no filled intent to reconcile against — the band is unchecked"];
  }
  const bp = (x: number) => `${x.toFixed(2)}bps`;
  return [
    `entry slippage vs the ledger's own fills (tolerance ${ENTRY_SLIP_TOLERANCE}x either way):`,
    `  ${String(r.n).padStart(4)} filled intent(s): entry_px lands ${bp(r.observedBps)} against us on average ` +
    `(${bp(r.meanAbsBps)} absolute, worst ${bp(r.worstBps)}),`,
    `       against the ${bp(r.assumedBps)} \`npm run backtest\` charges (${r.ratio.toFixed(2)}x)` +
    (r.ok
      ? " — ok"
      : " — ⚠ OFF: every return figure in `npm run backtest` carries this band twice on a forced close"),
    `       ⚠ RISK_PARAMS.slippageBps is ${RISK_PARAMS.slippageBps}bps and is NOT this number: it is the price the`,
    "         IOC accepts, not where it lands. The two are different facts about one order.",
  ];
}

/** How far the schedule above may drift from what the venue actually charged before a
 *  run says so. 20% is wide on purpose: the two rates are 4.5 and 0.9 basis points, so a
 *  tolerance tight enough to catch a tier change would also fire on rounding. */
export const FEE_RECONCILE_TOLERANCE = 0.20;

/** The fields of a `fills` row this needs. Structural, so the test can hand it literals
 *  and `npm run fills` can hand it the ledger's own rows. */
export type FeeFill = {
  coin: string; px: number; sz: number; fee: number; fee_token: string; crossed: number;
};

export type FeeReconciliation = {
  dex: string;
  fills: number;
  notionalUsd: number;
  feeUsd: number;
  /** `Σ fee / Σ notional` over taker fills — what the venue really charged. */
  observedRate: number;
  /** `takerRate(dex)` — what this file assumes. */
  scheduleRate: number;
  /** observed / schedule. `notes/2026-09-02-fill-truth-findings.md` measured **0.2×**
   *  for `xyz:` against the native schedule, which is where `HIP3_FEE_SCALE` comes from;
   *  this is the figure that re-measures it. */
  ratio: number;
  /** What the schedule permits: the venue rate alone for a grandfathered account, up to
   *  the venue rate **plus the builder fee** for one that approved it. The fill row does
   *  not say which, so both ends are allowed. */
  band: [number, number];
  ok: boolean;
};

/** **`TAKER_NATIVE` and `HIP3_FEE_SCALE` against the venue's own receipts** —
 *  `tasks/46` §3.4, and the gap it names: two constants that decide every fee figure
 *  this script prints, reconciled against nothing since they were written. The 0.2× is
 *  from 2026-09-02 and `deployerFeeScale` is not on `perpDexs`, so there is no metadata
 *  to read it from — the ledger's own fills are the only source there has ever been.
 *
 *  Taker fills only (`crossed`), because the maker schedule is a different number; USDC
 *  fees only, because a fee charged in another token is not dollars and `settleIntent`
 *  already refuses to subtract it as such.
 *
 *  **First run, 2026-09-13, on 1,284 taker fills across 15 accounts** (`data/snap-0912`).
 *  Both constants reconcile exactly, and the per-account rates decompose into three
 *  components rather than two:
 *
 *      native  4.320bp   4.500bp   4.920bp   5.100bp
 *      xyz:    0.864bp   0.900bp   1.464bp   1.500bp
 *              ─────────────────────────────────────
 *              referral  schedule  referral  builder
 *              only                +builder  only
 *
 *  `0.864 / 0.96 = 0.900 = 0.2 × 4.5`, so **`HIP3_FEE_SCALE` is 0.2 to three decimal
 *  places** and `TAKER_NATIVE` is exactly the published rate. ⚠ The third component is
 *  the **4% Hyperliquid referral discount** (`tasks/37`), which nothing in this file
 *  models: it applies to the venue fee only and the builder fee is added on top of the
 *  discounted number, undiscounted. It makes every fee figure here ~4% pessimistic on
 *  the venue leg — 0.04bp on an `xyz:` round trip — which is why it is recorded rather
 *  than modelled, and why the band's ±20% has to be wide enough to hold it. */
export function reconcileFeeSchedule(
  fills: readonly FeeFill[],
  builderRate: number = BUILDER_RATE,
  tolerance: number = FEE_RECONCILE_TOLERANCE,
): FeeReconciliation[] {
  const byDex = new Map<string, { n: number; notional: number; fee: number }>();
  for (const f of fills) {
    if (!f.crossed || f.fee_token !== "USDC") continue;
    const notional = Math.abs(f.px * f.sz);
    if (!(notional > 0)) continue;
    const dex = dexOf(f.coin);
    const acc = byDex.get(dex) ?? { n: 0, notional: 0, fee: 0 };
    acc.n++; acc.notional += notional; acc.fee += f.fee;
    byDex.set(dex, acc);
  }
  return [...byDex.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dex, a]) => {
    const observedRate = a.fee / a.notional;
    const scheduleRate = takerRate(dex);
    const band: [number, number] = [scheduleRate, scheduleRate + builderRate];
    return {
      dex, fills: a.n, notionalUsd: a.notional, feeUsd: a.fee, observedRate, scheduleRate,
      ratio: observedRate / scheduleRate,
      band,
      ok: observedRate >= band[0] * (1 - tolerance) && observedRate <= band[1] * (1 + tolerance),
    };
  });
}

/** One block for a script to print. Says what it could not check rather than nothing. */
export function feeReconciliationLines(rows: readonly FeeReconciliation[]): string[] {
  if (rows.length === 0) {
    return ["fee schedule: no taker fills in USDC to reconcile against — the schedule is unchecked"];
  }
  const bp = (x: number) => `${(x * 10_000).toFixed(2)}bp`;
  return [
    `fee schedule vs the ledger's own fills (tolerance ±${(FEE_RECONCILE_TOLERANCE * 100).toFixed(0)}%, ` +
    "band is the venue rate up to the venue rate plus the builder fee):",
    ...rows.map((r) =>
      `  ${(r.dex === "" ? "native" : r.dex).padEnd(7)} ${String(r.fills).padStart(4)} taker fill(s), ` +
      `$${r.notionalUsd.toFixed(0)} notional: charged ${bp(r.observedRate)} against a schedule of ` +
      `${bp(r.scheduleRate)} (${r.ratio.toFixed(2)}×), band ${bp(r.band[0])}–${bp(r.band[1])} ` +
      (r.ok ? "— ok" : "— ⚠ OFF SCHEDULE: every fee figure in `npm run backtest` is wrong by this much")),
  ];
}

/** Basis points as a fraction. One place, so a band and a fee cannot be divided by
 *  different powers of ten in two files. */
export const bps = (x: number): number => x / 10_000;

/** **The builder fee, per order, as a fraction of notional.** `BUILDER_FEE.tenthsBp` is
 *  tenths of a basis point and `tenthsBpToFraction` is the conversion the signing path
 *  itself uses — imported rather than re-derived, because a rail charged at ten times the
 *  rate it was approved at is the kind of arithmetic that should exist once
 *  (`tasks/46` §2.2). */
export const BUILDER_RATE = tenthsBpToFraction(BUILDER_FEE.tenthsBp);

// ── how far this simulator sits from the ledger, and when that was last measured ───
//
// Two figures, both measured once, both quoted all over `notes/` and `docs/`, and
// neither dated in the output until 2026-09-12. They are calibrations, not constants:
// each is a ratio between **this script on one window** and **the live ledger on the
// same window**, so each goes stale when either side changes — and both sides have.
// The simulator does not re-gate at the fill, pay the builder fee or re-enter; the
// ledger since 09-11 refuses post-stop re-entry, so part of the gap has already been
// removed by a change neither number has been re-measured against.
//
// The rule they exist to enforce: **a row of this script is a hypothesis for the next
// block of trades, never a measurement**. Printing the ratio beside the table is what
// makes that unignorable; printing the date is what stops the ratio becoming folklore.
//
// `backtest.test.ts` asserts that both are printed **from this constant**, not that any
// particular digits appear. A re-measurement is then a one-line change here that the
// test accepts and a reader can see the date of — the previous test regex-matched
// "+3.49% against a live +0.83%" in the source, so it would have passed just as well at
// 1x or 40x and failed on a re-measurement for the wrong reason.
export const CALIBRATION = {
  /** Table 1/2's returns column. `notes/2026-09-09-phase3-fifth-reading.md` §5.
   *
   *  ⚠⚠ **Superseded 2026-09-13 — not by a re-measurement, but by the model changing
   *  underneath it.** `tasks/46` §2.1–§2.4 gave this script the live re-gate, the builder
   *  fee, re-entry and the band, which are four of the reasons the gap existed. Re-run on
   *  this very window afterwards, σ0.5 reads **−2.78%** where it read +3.49% when the
   *  ratio was measured, against a live +0.83%. So on that window the simulator is no
   *  longer ~4x optimistic: it is **pessimistic**. The pair is kept because it is the
   *  dated evidence for what the old model did and for why the four gaps were worth
   *  closing, and it prints as history rather than as a correction factor — the live
   *  check is the replication row above the tables. */
  returns: {
    what: "returns",
    modelled: 0.0349,
    live: 0.0083,
    measuredOn: "2026-09-09",
    window: "--since sigma0.5 --until reverted",
    why: "it models taker fees and not funding, slippage, partial\n"
      + "    fills, queue position, or the 29.5% of published edge lost to poll lag",
    /** What the same window reads after `tasks/46` §2.1–§2.4, and the day the model moved. */
    supersededOn: "2026-09-13",
    supersededBy: -0.0278,
    supersededWhy: "the live re-gate, the builder fee, re-entry and the band (tasks/46 §2.1-§2.4)",
  },
  /** Table 4's worst-day column. Measured against the ledger's own worst account-days
   *  at matched settings and recorded in `src/risk/params.ts` (the 2% stop's argument)
   *  and four notes — but **never printed by this script**, so the one table the 2%
   *  default was argued on carried no caveat at all. */
  worstDay: {
    what: "the worst-day column",
    ratio: 1.6,
    measuredOn: "2026-09-12",
    window: "the ledger's worst account-days at matched settings",
    why: "the halt here is not sticky, the desk re-enters, and a stop-limit can miss",
  },
} as const;

/** `tasks/47` Rule 3's tolerance: **how far the modelled per-signal price return may sit
 *  from the ledger's on the same window before a sweep is printed under a banner.**
 *
 *  In percentage points of price return per signal, which is the unit both sides can be
 *  read in (`tasks/46` §1.1) and the only one that does not move when the leverage mix
 *  does. 0.25pp is not a statistical threshold and does not pretend to be — it is *the
 *  size of the gap already known to exist*: `CALIBRATION.returns` measured +3.49%
 *  modelled against a live +0.83% on margin at 10x, which is 0.349% against 0.083% in
 *  price, a gap of 0.27pp. So a simulator that still carries the whole of the known
 *  2026-09-09 discrepancy fails this check, and one that has closed most of it passes.
 *
 *  ⚠ **That makes it a floor on fidelity and never a licence.** Passing means the totals
 *  agree on one window; it does not mean the mechanisms do, and `modelled()` is where
 *  that is read. Two errors of opposite sign cancel in a mean. */
export const REPLICATION_TOLERANCE_PP = 0.25;

/** The returns caveat, as the block it prints: the ratio, the window it was measured
 *  on, the day it was measured, and why the two sides differ. */
export function calibrationLine(c: typeof CALIBRATION.returns): string {
  const signed = (x: number) => (x >= 0 ? "+" : "") + pc(x);
  return "⚠ These rows are comparable to EACH OTHER and not to the ledger. On the one\n" +
    `    window where both exist — \`${c.window}\`,\n` +
    `    measured ${c.measuredOn} — this simulator read ${signed(c.modelled)} against a live ${signed(c.live)},\n` +
    `    ~${(c.modelled / c.live).toFixed(1)}x, because ${c.why}.\n` +
    `    ⚠⚠ THAT RATIO IS HISTORY, superseded ${c.supersededOn}: ${c.supersededWhy} landed,\n` +
    `    and the same window now reads ${signed(c.supersededBy)} — so there this simulator is no longer\n` +
    "    optimistic at all, it is pessimistic. The live check is the replication row above the\n" +
    "    tables; this pair is kept as the dated evidence for what the old model did.\n" +
    "    A row is a hypothesis for the next block of trades, never a measurement of that gate.";
}

type Candle = { t: number; T: number; o: string; h: string; l: string; c: string };

/** Candles for one coin over [start, end].
 *
 *  **Hyperliquid caps a `candleSnapshot` at ~5000 rows, and the cap is on rows rather
 *  than on time**, so the reachable history is set by the interval and nothing else.
 *  Measured 2026-09-07 on `xyz:COPPER`, asking for far more than was returned:
 *
 *      1m   5009 rows →   3.5 days back
 *      5m   5002 rows →  17.4 days
 *      15m  5001 rows →  52.1 days
 *      1h   2881 rows → 120.0 days
 *
 *  That is why the default here is **5m and not 1m**: at 1m the price data runs out
 *  four days into an eight-day archive, and a first run of this script silently lost
 *  19 of 23 events at σ1.0 to it — the whole calibration sample. Requesting an older
 *  window does not help, because the cap is not a window.
 *
 *  What 5m costs is intra-bar *ordering*, never detection: a bar's high and low still
 *  say whether the target or the stop was touched. When one bar contains both, `replay`
 *  resolves it to the stop, and the count of those is printed — a coarser bar makes
 *  that happen more often, in the conservative direction. */
type Interval = "1m" | "5m" | "15m" | "1h";

/** One bar, in milliseconds. **The halt walk's grid was a `300_000` literal regardless
 *  of `--interval` until 2026-09-13** (`tasks/46` §2.5), which was a no-op at the 5m
 *  default and wrong in both directions elsewhere: at `--interval 1m` it floored five
 *  distinct mark samples onto one grid instant, so which of the five the walk read was
 *  decided by where a binary search happened to land; at 1h it put every open and close
 *  on a lattice twelve times finer than any sample that could confirm it. Derived here so
 *  the walk cannot disagree with the candles it walks over. */
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000,
};

/** The backoff a rate-limited fetch walks, in milliseconds, one entry per retry.
 *
 *  **Six seconds of backing off was not enough and the cost of losing was a whole
 *  market** (`tasks/50` §1.5). The old schedule was three tries over 2s + 4s; a 429 that
 *  outlasts it drops every trade on that coin from every table, which on 2026-09-14 was
 *  all ten COPPER trades in a window — the window's biggest losers. Nearly two minutes of
 *  patience is cheap against re-running a four-minute sweep, and cheaper still against
 *  reading one that quietly lost a market.
 *
 *  ⚠ Backing off is the *only* lever: the venue rate-limits per IP and returns no headers
 *  to pace against. **Never run two of these at once from one IP** — the second run's
 *  retries make the first run's worse, and both come back short. */
const CANDLE_BACKOFF_MS = [2_000, 5_000, 12_000, 30_000, 60_000];

async function candlesFor(
  info: ReturnType<typeof makeInfoClient>, coin: string, interval: Interval, start: number, end: number,
): Promise<Candle[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await info.candleSnapshot({ coin, interval, startTime: start, endTime: end }) as Candle[];
      await new Promise((r) => setTimeout(r, 120));
      return rows.sort((a, b) => a.t - b.t);
    } catch (e) {
      const wait = CANDLE_BACKOFF_MS[attempt];
      if (wait === undefined) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/** The universe load, with the same patience the candles get.
 *
 *  It had **no retry at all**, so the 429 that cost one market above crashed the whole
 *  run when it landed on this call instead — four minutes of fetching thrown away by the
 *  first request of the next run (`tasks/50` §1.5). */
async function loadUniverse(info: ReturnType<typeof makeInfoClient>): Promise<Universe> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await Universe.load(info);
    } catch (e) {
      const wait = CANDLE_BACKOFF_MS[attempt];
      if (wait === undefined) throw e;
      console.log(`  universe load failed (${e instanceof Error ? e.message.slice(0, 48) : e}) — retrying in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export type Trade = {
  sigma: number;
  signalRef: string;
  coin: string;
  side: string;
  openedAt: Date;
  leverage: number;
  /** The outlook's anchor, and where in its life this entry sits. A `--hold-hours` sweep
   *  is unreadable without these: the cap does not change how long we hold — the desk
   *  exits on the neutral turn at a median 2.3h either way — it changes **when in a
   *  forecast's life we enter**. */
  anchor: string;
  /** `crypto` / `equity` / `commodity`, as Quotient labels the series. **A book of nine
   *  positions that is eight commodity longs is not the same risk as nine spread across
   *  asset classes** — that is the 2026-09-10 mechanism, three accounts halted in six
   *  minutes — and a concurrency count cannot tell the two apart (`tasks/45` §2.2). */
  assetClass: string;
  horizonAtEntryH: number;
  sigmaAtEntry: number;
  /** The stop as armed, after the liquidation clamp and tick rounding — never the one
   *  that was asked for. */
  effStopPct: number | null;
  /** Net of fees, as a fraction of the position's margin, under each policy.
   *  `resolved` is false when the data ran out before the policy's exit would have
   *  arrived — the trade is still running, and half a counterfactual is not a result.
   *
   *  `priceRet` is the same exit in **price**, signed by side and before any fee —
   *  `dir × (exit − fill) / fill`. It is the only unit in this file that can be set
   *  beside the ledger's own figure, because it is the one that does not move when the
   *  leverage does (`tasks/46` §1.1), and it is what the replication row compares. */
  live: { reason: string; net: number; priceRet: number; heldH: number; resolved: boolean };
  hold: { reason: string; net: number; priceRet: number; heldH: number; resolved: boolean };
  /** Unrealised mark while the position is open, as a fraction of its own margin, one
   *  sample per `--interval` bar and taking each bar's adverse extreme. Under the **live** policy
   *  only — the halt walk is a question about the desk we run. Empty for a trade whose
   *  fill candle is its exit candle. */
  path: { t: number; mark: number }[];
  ambiguous: boolean;
};

/** One UTC day of the halt walk. */
export type HaltDay = {
  day: string;
  /** Equity at the day's open, as a multiple of the mandate — the walk compounds. */
  openEquity: number;
  /** The worst equity the day reached, as a fraction of `openEquity`. Negative. */
  worstDrawdown: number;
  halted: boolean;
  /** Entries the halt refused, because they would have opened after it fired. */
  refused: number;
};

/** **Would the daily-loss cap have fired, and what did it cost?**
 *
 *  The one thing every return figure in this file is blind to. `notes/2026-09-11-the-
 *  stop-the-leverage-and-the-capacity.md` §1.1 says it plainly: *"every figure in this
 *  note is computed on a desk that never stops trading"*, and a halt is the one event
 *  that removes a day's **winners** along with its losers — an asymmetry a mean over
 *  per-signal returns cannot see by construction. That matters most for exactly the
 *  configuration this was written for: a wide stop makes each loss larger, and
 *  `stopOutOfMandate` is `stopPct × leverage × perSignalPct × (1 − reserveFrac)`.
 *
 *  The model, stated so it can be argued with:
 *
 *  - **Equity is marked, not realised.** `E(t) = 1 + closed(t) + Σ open marks(t)`, in
 *    multiples of the mandate, because `tick()` reads the venue's `equityUsd`.
 *  - **A trade costs `net × perSignalPct × (1 − reserveFrac)` of the mandate**, which is
 *    `stopOutOfMandate`'s own arithmetic with the realised return in place of the stop.
 *  - **The halt binds.** When `E(t) ≤ E(day open) × (1 − dailyLossPct)` the rest of that
 *    UTC day opens nothing, which is what `considerSignals` does. Resting exits stay, so
 *    positions already open still close normally — that is the real behaviour and it is
 *    why the halt is not simply "stop the day".
 *  - **The budget is not modelled**, here or anywhere in this file. Under the live policy
 *    occupancy p90 is 5 against 10 slots, so it rarely binds; under `hold` it binds
 *    constantly, which is why this walk is live-policy only.
 *  - ⚠ **Equity compounds across days but the position size does not.** Margin is a
 *    fraction of the mandate as it was on day one. Over 12 days the difference is small
 *    and it understates a losing streak slightly.
 *  - ⚠ **One bar's grid and a bar's adverse extreme.** Two positions whose worst ticks
 *    fall in the same bar are treated as simultaneous. That overstates coincidence
 *    within a bar and understates it never — so a coarser `--interval` makes the halt
 *    fire more readily, and `barMs` is an input rather than a literal for that reason. */
export function haltWalk(
  trades: readonly Trade[],
  opts: { perSignalPct: number; reserveFrac: number; dailyLossPct: number; barMs: number },
): { days: HaltDay[]; haltedDays: number; refused: number; kept: Trade[] } {
  const m = opts.perSignalPct * (1 - opts.reserveFrac);
  const byOpen = [...trades].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  // Required rather than defaulted: a default here is the `300_000` literal back again,
  // and it would be silently wrong at every interval but one.
  const bar = (t: number) => Math.floor(t / opts.barMs) * opts.barMs;

  // Every instant the walk has to look at: an open, a close, and each mark sample.
  const grid = new Set<number>();
  for (const t of byOpen) {
    grid.add(bar(t.openedAt.getTime()));
    grid.add(bar(closeMs(t)));
    for (const s of t.path) grid.add(s.t);
  }
  const times = [...grid].sort((a, b) => a - b);

  const kept: Trade[] = [];
  const days: HaltDay[] = [];
  let equity = 1;                       // multiples of the mandate
  let closed = 0;                       // realised, in the same unit
  let day = "";
  let openEquity = 1;
  let halted = false;
  let worst = 0;
  let refused = 0;
  const open: Trade[] = [];
  let next = 0;

  const closeDay = () => {
    if (day !== "") days.push({ day, openEquity, worstDrawdown: worst, halted, refused });
  };

  for (const now of times) {
    const key = new Date(now).toISOString().slice(0, 10);
    if (key !== day) {
      closeDay();
      // `rollDay` rebaselines on the UTC boundary from whatever equity is then — including
      // the marks of positions still open, which is why the baseline is `equity` and not
      // `1 + closed`. It is also why a halt cannot outlive its own day here; on the real
      // desk it is sticky and needs a person (`tasks/30`), which this deliberately does
      // not model — the question is how often the line is crossed, not how long an
      // operator takes to clear it.
      day = key; openEquity = equity; halted = false; worst = 0; refused = 0;
    }

    // Opens at this instant, in the order the feed ranked them.
    while (next < byOpen.length && bar(byOpen[next]!.openedAt.getTime()) <= now) {
      const t = byOpen[next]!;
      next++;
      if (halted) { refused++; continue; }
      open.push(t);
      kept.push(t);
    }

    // Closes at this instant. A resting exit fills whether or not the account is halted.
    for (let i = open.length - 1; i >= 0; i--) {
      const t = open[i]!;
      if (bar(closeMs(t)) > now) continue;
      closed += t.live.net * m;
      open.splice(i, 1);
    }

    // The last sample at or before `now`, not an exact-grid match: a coin whose candles
    // do not land on this instant is still holding its position, and treating it as flat
    // would quietly erase an open loss from the equity the cap reads.
    let marked = closed;
    for (const t of open) {
      let lo = 0, hi = t.path.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (t.path[mid]!.t <= now) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      if (at >= 0) marked += t.path[at]!.mark * m;
    }
    equity = 1 + marked;
    const dd = openEquity > 0 ? (equity - openEquity) / openEquity : 0;
    worst = Math.min(worst, dd);
    if (!halted && dd <= -opts.dailyLossPct) halted = true;
  }
  closeDay();

  return { days, haltedDays: days.filter((d) => d.halted).length, refused: days.reduce((a, d) => a + d.refused, 0), kept };
}

function closeMs(t: Trade): number {
  return t.openedAt.getTime() + Math.max(0, t.live.heldH) * 3_600_000;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function ci(xs: number[]): { n: number; mean: number; sd: number; lo: number; hi: number } {
  const n = xs.length;
  if (n === 0) return { n, mean: NaN, sd: NaN, lo: NaN, hi: NaN };
  const m = mean(xs);
  const sd = n < 2 ? 0 : Math.sqrt(xs.reduce((t, x) => t + (x - m) ** 2, 0) / (n - 1));
  const half = 1.96 * sd / Math.sqrt(n);
  return { n, mean: m, sd, lo: m - half, hi: m + half };
}

const pc = (x: number) => `${(x * 100).toFixed(2)}%`;

/** **The stop as armed, against the mark it was planned from** (`tasks/50` §1.3).
 *
 *  `buildIntent` derives `stopPx` from the planning mark, so this division recovers
 *  exactly what `clampStopPct` and the venue's tick left of what was asked for — and
 *  nothing else. Measuring it against the *fill* instead mixed in the band and one bar of
 *  price movement, which is a fact about the entry and not about the stop.
 *
 *  Separate from `Trade.effStopPct` only so the arithmetic can be pinned in a unit test;
 *  `simulate` calls it. */
export function armedStopPct(stopPx: number | null, markPx: number): number | null {
  if (stopPx === null || !(markPx > 0)) return null;
  return Math.abs(stopPx - markPx) / markPx;
}

/** How many of a set of armed stops came out below what was asked.
 *
 *  The 0.5% slack is what separates "clamped or rounded" from a float that differs in the
 *  twelfth decimal. One function, so the grid's block and the sweep's block cannot count
 *  the same thing two ways. */
export function clampedCount(armed: readonly number[], asked: number): number {
  return armed.filter((x) => x < asked * 0.995).length;
}

/** **The position size at which the concurrency cap starts refusing signals.**
 *
 *  `fitsBudget` refuses once `maxConcurrentSignals(s) = floor(1 / perSignalPct)` positions
 *  are open, so a book whose p90 is `n` first meets the cap where `floor(1/p) < n` — and
 *  `floor(x) < n` iff `x < n` for integer `n`, so that is exactly `p > 1/n`. Arithmetic,
 *  not a sample. Below that size the cap buys nothing at all, which is `tasks/45` §2.2's
 *  question and `notes/2026-09-11-…-capacity.md` §4.1's answer for the default. */
function bindsAbove(p90: number): string {
  if (p90 <= 0) return "never";
  const p = 1 / p90;
  return p > SITE_OFFERS.perSignalPct.max ? "never" : `${(p * 100).toFixed(1)}%`;
}

export type Replication = {
  /** `n` is **outlooks**, `legs` the trades inside them — the ledger's own unit, where
   *  one signal is one event however many legs an account ran on it (`tasks/50` §1.2). */
  modelled: { n: number; legs: number; priceRet: number } | null;
  ledger: { n: number; trips: number; priceRet: number } | null;
  /** Modelled minus ledger, in percentage points of price return per signal. Null when
   *  either side has nothing in the window. */
  gapPP: number | null;
  /** Whether the sweep below may be read without a banner. **False when either side is
   *  empty**, deliberately: "we could not check" and "it reproduces" must never print the
   *  same way, which is the mistake `stop-sweep` made by treating a trade with no stored
   *  price path as a trade that was not stopped. **False, too, when a market the window
   *  wanted has no candles** (`tasks/50` §1.5): one rate-limited market on 2026-09-14
   *  removed all ten COPPER trades from a window and read +0.9% of margin per signal
   *  better for it, with nothing in the output saying a market was gone. */
  ok: boolean;
  /** Markets the run wanted and could not price. Empty on an ordinary run. */
  missingMarkets: readonly string[];
  why: string;
};

/** `tasks/47` Rule 3: **a model may justify a change only after it reproduces the desk it
 *  will change.**
 *
 *  On 2026-09-10 a stop-sweep that ends a trade at its modelled stop argued the default
 *  down to 1%; the desk then re-opened 87 of those trades on the next tick. The decision
 *  was made in the first world and executed in the second, and nothing printed by either
 *  script said the two were different. This is that check, as a number: model the desk as
 *  run over the same window the sweep covers, set the per-signal **price** return beside
 *  the ledger's own, and print the gap.
 *
 *  **Price, and per signal, for the same reason the readings moved to it** — it is the one
 *  unit that does not move when a new account is funded or an old one changes leverage
 *  (`tasks/46` §1.1). A replication check denominated in margin would drift every time the
 *  population did, and would read as the simulator improving or decaying when nothing
 *  about it had changed.
 *
 *  ⚠ **The price is why it is also blind to costs, and that is a real limit rather than a
 *  quibble.** `exit/entry` cannot see a fee, so `--no-builder-fee` replicates exactly as
 *  well as the default does and a fee schedule that was wrong by a factor of ten would
 *  pass this check unchanged. The `fee` row of `modelled()` is where that fidelity is
 *  read, and Table 1's *% of margin* column is what it moves. A check that could see both
 *  would have to be denominated in margin, and would then move whenever the population
 *  did — which is the trade `tasks/46` §1.1 already made, in this direction, deliberately.
 *
 *  Pure, and structurally typed on both sides, so the arithmetic is decided in a unit test
 *  rather than against a live ledger and a venue. */
export function replicate(i: {
  /** The sweep's own trades at the **shipped** gate, under the live exit policy. */
  modelledTrades: readonly Trade[];
  /** The ledger's events, already collapsed one-per-signal. */
  ledgerEvents: readonly { priceRet: number | null; trips: number; openedAt: Date; holdToTarget: boolean }[];
  windowStartMs: number;
  windowEndMs: number;
  tolerancePP?: number;
  /** Markets the run wanted and could not fetch candles for. A missing market removes
   *  every trade on it from the modelled side and nothing else changes, so the check
   *  refuses rather than grading the remainder (`tasks/50` §1.5). */
  missingMarkets?: readonly string[];
}): Replication {
  const tol = i.tolerancePP ?? REPLICATION_TOLERANCE_PP;
  const missingMarkets = i.missingMarkets ?? [];

  // Only resolved trades: a position still running has no exit and scoring it at the last
  // candle is the fiction `resolved` exists to refuse.
  const mt = i.modelledTrades.filter((t) => t.live.resolved);

  // ── The unit, and it is the ledger's (`tasks/50` §1.2) ──────────────────────────
  //
  // `collapse` makes one **signal** one event: an account's legs are summed and the sum
  // is what enters the mean, so a call re-entered four times is one follower of one call
  // rather than four draws. This side averaged over **legs** until 2026-09-14, which is
  // the mixing `tasks/46` §1.1 retired for the readings — inside the check that is
  // supposed to guard them. The numerator is the same either way, so the gap moved by the
  // ratio of legs to outlooks: on 09-08 → 09-11 a −0.46% per leg is −0.69% per outlook,
  // and a gap recorded as −0.17pp was −0.40pp on the unit it is compared against.
  const byOutlook = new Map<string, number>();
  for (const t of mt) byOutlook.set(t.signalRef, (byOutlook.get(t.signalRef) ?? 0) + t.live.priceRet);
  const modelled = mt.length === 0 ? null : {
    n: byOutlook.size,
    legs: mt.length,
    priceRet: [...byOutlook.values()].reduce((a, x) => a + x, 0) / byOutlook.size,
  };

  // The ledger's side: opened inside the window, priced by the venue, and on the **same
  // exit policy** the modelled column runs. A `holdToTarget` account is a different desk
  // — that is the whole reason `blocks()` splits on it — so pooling it here would measure
  // the policy mix rather than the simulator.
  const le = i.ledgerEvents.filter((e) =>
    e.priceRet !== null && !e.holdToTarget
    && e.openedAt.getTime() >= i.windowStartMs && e.openedAt.getTime() <= i.windowEndMs);
  const ledger = le.length === 0 ? null : {
    n: le.length,
    trips: le.reduce((a, e) => a + e.trips, 0),
    priceRet: le.reduce((a, e) => a + (e.priceRet as number), 0) / le.length,
  };

  if (modelled === null || ledger === null) {
    return {
      modelled, ledger, gapPP: null, ok: false, missingMarkets,
      why: modelled === null && ledger === null
        ? "neither side has a resolved trade in this window — nothing was checked, which is not the same as agreeing"
        : modelled === null
          ? "the simulator opened nothing it could resolve in this window; the sweep below has no replication behind it"
          : "the ledger holds no settled, venue-priced trade opened in this window (a fresh box, a snapshot, or a window "
            + "that predates the desk) — so this run is unreplicated rather than replicated",
    };
  }

  const gapPP = (modelled.priceRet - ledger.priceRet) * 100;
  // A missing market is not a smaller sample of the same run: it deletes whichever trades
  // that market held, and the deleted set has a P&L of its own. So the verdict is
  // **unreplicated** even when the arithmetic on what is left happens to land inside the
  // tolerance — the number is still printed, because a reader who re-fetches the market
  // needs to know which way it moved.
  if (missingMarkets.length > 0) {
    return {
      modelled, ledger, gapPP, ok: false, missingMarkets,
      why: `${missingMarkets.length} market(s) missing (${missingMarkets.join(", ")}). `
        + `The gap below is ${(gapPP >= 0 ? "+" : "") + gapPP.toFixed(2)}pp on what remains, `
        + "which is a different window from the one asked for",
    };
  }
  const ok = Math.abs(gapPP) <= tol;
  return {
    modelled, ledger, gapPP, ok, missingMarkets,
    why: ok
      ? `within the ${tol.toFixed(2)}pp tolerance — the totals agree on this window, which is a floor on fidelity and not a licence`
      : `${Math.abs(gapPP).toFixed(2)}pp ${gapPP > 0 ? "BETTER" : "worse"} than the desk, against a ${tol.toFixed(2)}pp tolerance`,
  };
}

/** The replication row, as the block it prints. Above the sweep, because a reader who
 *  stops at the first table must have met it. */
export function replicationBlock(r: Replication, opts: { windowLabel: string }): string {
  const signed = (x: number) => (x >= 0 ? "+" : "") + pc(x);
  const out = [`replication (tasks/47 Rule 3) — does this simulator reproduce the desk on ${opts.windowLabel}?`, ""];
  if (r.modelled === null || r.ledger === null) {
    out.push(`  ⚠ NOT REPLICATED. ${r.why}.`);
    out.push(`     modelled: ${r.modelled === null ? "no resolved trade" : `${r.modelled.n} signals, ${signed(r.modelled.priceRet)} price`}`);
    out.push(`     ledger:   ${r.ledger === null ? "no settled priced trade" : `${r.ledger.n} signals, ${signed(r.ledger.priceRet)} price`}`);
    if (r.missingMarkets.length > 0) {
      out.push(`     ⚠ and ${r.missingMarkets.length} market(s) had no candles at all: ${r.missingMarkets.join(", ")}.`);
    }
    out.push("     Read every row below as arithmetic on a desk nobody has checked against a real one.");
    return out.join("\n");
  }
  out.push(`  modelled  ${String(r.modelled.n).padStart(4)} signals   ${signed(r.modelled.priceRet).padStart(8)} per signal, in price   (${r.modelled.legs} legs)`);
  out.push(`  ledger    ${String(r.ledger.n).padStart(4)} signals   ${signed(r.ledger.priceRet).padStart(8)} per signal, in price   (${r.ledger.trips} account-trips)`);
  out.push(`  gap       ${(r.gapPP! >= 0 ? "+" : "") + r.gapPP!.toFixed(2)}pp`);
  out.push("");
  out.push("  Both sides are per OUTLOOK: an outlook's legs are summed and the sum is what enters");
  out.push("  the mean, so a call re-entered twice is one follower of one call on either side.");
  out.push("  The counts in brackets are the legs underneath (tasks/50 §1.2).");
  out.push("");
  if (r.missingMarkets.length > 0) {
    out.push(`  ⚠⚠ UNREPLICATED — ${r.why}.`);
    out.push("     A missing market does not shrink the sample evenly: it deletes whichever trades");
    out.push("     that market held, and on 2026-09-14 one rate-limited market took all ten COPPER");
    out.push("     trades out of a window — its biggest losers — and read +0.9% of margin per signal");
    out.push("     better for it. Re-run when the venue is not rate-limiting, one process at a time.");
  } else if (r.ok) {
    out.push(`  ✓ ${r.why}.`);
    out.push("    Which mechanisms still differ is the table above, not this number: two errors of");
    out.push("    opposite sign cancel in a mean, and a total that agrees can hide both.");
    out.push("    ⚠ And this unit is blind to COSTS by construction. A price return is exit/entry, so");
    out.push("      the fee schedule and the builder fee cannot move it — a run with --no-builder-fee");
    out.push("      replicates exactly as well as one without. Fee fidelity is the `fee` row above,");
    out.push("      and it is Table 1's \"% of margin\" column that it moves.");
  } else {
    out.push(`  ⚠⚠ THIS SIMULATOR DOES NOT REPRODUCE THE DESK — ${r.why}.`);
    out.push("     Every row below is a hypothesis about a desk we do not run. `tasks/47` Rule 3 is");
    out.push("     that a model may justify a change only after it reproduces the one it will change;");
    out.push("     the 1% stop default of 2026-09-10 was argued on a model that ended a trade at its");
    out.push("     stop while the desk re-entered it 87 times. Read the `no` rows above for where the");
    out.push("     difference comes from before reading a row below for a direction.");
  }
  return out.join("\n");
}

/** Every simulated trade at one gate, over the polls given.
 *
 *  `over` names whichever constant this run is sweeping — `minDisplacementSigma` or
 *  `maxHoldHours`. They cannot be swept together and `main` refuses it: the two interact
 *  rather than compose, because `sigma_total` is volatility over the **remaining**
 *  horizon and scales as sqrt(t), so widening the cap admits a long-anchor outlook
 *  earlier *and* at a deflated sigma. A grid of the two reads as a surface to pick a
 *  corner off, and the corner would be fitted to one archive
 *  (`notes/2026-09-11-the-gate-is-partly-a-clock.md`). */
async function runGate(
  over: Partial<typeof GATE>, polls: Poll[], universe: Universe, settings: UserSettings,
  candles: Map<string, Candle[]>, marginUsd: number,
  opts: { entryEndMs: number; maxOpen: number | null; reentry: boolean; builderFee: boolean },
): Promise<{ trades: Trade[]; noCandles: number; maxConcurrent: number; peakBook: Trade[];
  refusedByBudget: number; staleAtFill: number; reentries: number;
  blockedAfterStop: number; blockedOutlooks: number;
  refusedAlreadyOpen: number; alreadyOpenOutlooks: number;
  occupancy: { live: ReturnType<typeof occupancy>; hold: ReturnType<typeof occupancy> } }> {
  const { reentry } = opts;
  const builderRate = opts.builderFee ? BUILDER_RATE : 0;
  const gate = { ...GATE, ...over };
  const sigma = gate.minDisplacementSigma;
  const trades: Trade[] = [];
  let noCandles = 0;
  // `tasks/46` §2.1: entries the desk would have refused as stale by the time it could
  // act. Counted rather than silently dropped, because the count is the finding.
  let staleAtFill = 0;
  let reentries = 0;
  // `tasks/50` §1.4. Both count **opportunities** — one per poll per series, which is what
  // the desk records a skip row for — and the id sets beside them count how many distinct
  // outlooks that was, because the two numbers differ by the poll rate and a reader wants
  // the second.
  let blockedAfterStop = 0;
  let refusedAlreadyOpen = 0;
  const blockedIds = new Set<string>();
  const alreadyOpenIds = new Set<string>();

  // First pass: every moment each stable id was tradeable, and every moment it retired.
  // Retirement is the executor's own rule (`src/exec/loop.ts`): an id is live while some
  // series carries it with `side !== null && status === "active"`, and is retired on the
  // first fresh poll that no longer does.
  //
  // ⚠ **This used to keep the FIRST of each and nothing else** — one opportunity per id,
  // ever, and the first retirement — which is how "one trade per stable outlook id, ever"
  // was implemented. That is stronger than anything the desk does and it removed 73 of
  // 220 real pairs from the model (`tasks/46` §2.3). Both are lists now, and which
  // opportunities are taken is decided in the second pass, where the previous leg's exit
  // is known.
  // `coin` and `side` are carried on the opportunity rather than re-derived later,
  // because the two refusals below are keyed on them and `evaluateSeries` has already
  // decided both here.
  type Opened = {
    at: Date; seq: number; coin: string; side: string;
    series: Parameters<typeof evaluateSeries>[0]; market: Market;
  };
  const opens = new Map<string, Opened[]>();
  let seq = 0;
  const retiredAt = new Map<string, number[]>();
  const liveNow = new Set<string>();

  for (const poll of polls) {
    const stillLive = new Set(
      poll.series
        .filter((s) => s.outlook.side !== null && s.outlook.status === "active")
        .map((s) => stableOutlookId(s.outlook.outlook_id)),
    );
    for (const id of [...liveNow]) {
      if (stillLive.has(id)) continue;
      const xs = retiredAt.get(id) ?? [];
      xs.push(poll.t.getTime());
      retiredAt.set(id, xs);
      // Left the feed, so a later reappearance is a fresh retirement rather than the
      // same one seen twice.
      liveNow.delete(id);
    }
    for (const id of stillLive) liveNow.add(id);

    // **Entries stop at the window's right edge; retirement does not.** `--until` cuts
    // the half a cell may be fitted on, and a trade opened inside that half still closes
    // on the feed that came after it. Without this, every late entry in an out-of-sample
    // half would find no retirement and score as a horizon close — a bias introduced by
    // the very flag that exists to remove one.
    if (poll.t.getTime() > opts.entryEndMs) continue;

    for (const s of poll.series) {
      const id = stableOutlookId(s.outlook.outlook_id);
      const ev = evaluateSeries(s, poll.t, gate);
      if (!ev.ok) continue;
      const market = universe.resolve(ev.call.coin);
      if (!market) continue;
      const xs = opens.get(id) ?? [];
      // `seq` is the feed's own order — poll by poll, series by series within a poll —
      // and it is what breaks ties in the walk below. Two outlooks on one coin in one
      // poll are considered in the order the feed ranked them, which is the order
      // `considerSignals` reads them in.
      xs.push({ at: poll.t, seq: seq++, coin: ev.call.coin, side: ev.call.side, series: s, market });
      opens.set(id, xs);
    }
  }

  // ── Second pass: one chronological walk over every opportunity, not one per id ────
  //
  // **The desk's two refusals are keyed on the COIN, and this was keyed on the outlook**
  // (`tasks/50` §1.4). Every coin in the archive carries four or five outlooks, so the
  // difference is not cosmetic:
  //
  //   · `already-open` — `hasLiveIntentOn(account, coin)`: a second outlook on a coin we
  //     already hold is refused on the desk and used to be taken here. The model held two
  //     positions on one market where the desk holds one.
  //   · `stoppedOutToday(account, coin, side, day)` — a stop on outlook A of `xyz:COPPER`
  //     long spends that coin and side for the UTC day, outlook B included. Keyed per
  //     outlook it refused A and let B straight back in, which is the mechanism
  //     `tasks/42` measured as 54% of the net loss, re-created inside the model of it.
  //
  // Both are optimistic by construction — they add entries the desk would not have taken
  // — which is why `modelled()`'s re-entry row said `partial` and `PREREGISTERED.md` row 2
  // said the direction. A per-id pass cannot express either, because both refusals are
  // facts about what *another* id is doing, so the walk is global and in the feed's own
  // order.
  //
  // The re-entry rule itself is unchanged and is not *"re-enter after a retirement"*:
  // `considerSignals` refuses against **live** intents, so the moment a position closes
  // the outlook is tradeable again if it is still in the feed with a side. A retirement
  // reaches that state by closing the position; a **target** reaches it without the feed
  // changing at all (`tasks/46` §2.3).
  const opportunities: { id: string; o: Opened }[] = [];
  for (const [id, xs] of opens) for (const o of xs) opportunities.push({ id, o });
  opportunities.sort((a, b) => a.o.at.getTime() - b.o.at.getTime() || a.o.seq - b.o.seq);

  /** Coin → the position we hold on it: when it closes, and **which outlook opened it**.
   *  One entry per coin, because that is exactly the invariant `already-open` enforces on
   *  the desk. The id is kept because the desk's two refusals are different events: a
   *  republication of the outlook we already hold is `hasLiveIntentFor` and is silent
   *  (`continue`, no skip row), while a *different* outlook on that coin is
   *  `hasLiveIntentOn` and writes an `already-open` skip row. Counting them together would
   *  make this figure incomparable to the `skips` table it describes. */
  const heldUntil = new Map<string, { until: number; id: string }>();
  /** `coin\0side` → the UTC roll that ends the block a stop opened. */
  const stoppedUntil = new Map<string, number>();
  const legsById = new Map<string, number>();
  for (const { id, o } of opportunities) {
    const t = o.at.getTime();
    // `--no-reentry` is the pre-2026-09-13 model and has to stay comparable to the notes
    // written off it: one trade per stable id, ever, and **neither** of the two refusals
    // below, which that model did not have either.
    if (!reentry) {
      if ((legsById.get(id) ?? 0) > 0) continue;
    } else {
      const held = heldUntil.get(o.coin);
      if (held !== undefined && t < held.until) {
        // Only the cross-outlook case is new and only it is counted: a republication of
        // the id we are holding is the per-id pass's own rule, and the desk records
        // nothing for it either.
        if (held.id !== id) { refusedAlreadyOpen++; alreadyOpenIds.add(id); }
        continue;
      }
      const spent = stoppedUntil.get(`${o.coin}\u0000${o.side}`);
      if (spent !== undefined && t < spent) {
        blockedAfterStop++; blockedIds.add(id);
        continue;
      }
    }
    const retireMs = (retiredAt.get(id) ?? []).find((r) => r > t) ?? Infinity;
    const done = simulate(o, retireMs);
    if (done === null) continue;
    const legs = legsById.get(id) ?? 0;
    if (legs > 0) reentries++;
    legsById.set(id, legs + 1);
    trades.push(done.trade);
    if (!reentry) continue;
    heldUntil.set(o.coin, { until: done.closeMs, id });
    if (done.trade.live.reason === "stop" && RISK_PARAMS.blockReentryAfterStop) {
      // The UTC day the stop landed on is spent for this coin and side — the same
      // boundary `rollDay` uses, so there is no second clock.
      const roll = Date.parse(`${new Date(done.closeMs).toISOString().slice(0, 10)}T00:00:00Z`) + 86_400_000;
      stoppedUntil.set(`${o.coin}\u0000${o.side}`, Math.max(roll, done.closeMs));
    }
  }

  /** One trade, or null when it could not be scored. Returns the close instant too, so
   *  the caller above knows when the outlook became tradeable again. */
  function simulate(o: Opened, retireMs: number): { trade: Trade; closeMs: number } | null {
    const ev = evaluateSeries(o.series, o.at, gate);
    if (!ev.ok) return null;
    const ks = candles.get(ev.call.coin);
    if (!ks || ks.length === 0) { noCandles++; return null; }

    // Rule 2: plan on the last close we could have seen, fill at the next open.
    const tMs = o.at.getTime();
    const markCandle = [...ks].reverse().find((k) => k.t <= tMs);
    const fillCandle = ks.find((k) => k.t > tMs);
    if (!markCandle || !fillCandle) { noCandles++; return null; }
    const markPx = Number(markCandle.c);
    const rawFillPx = Number(fillCandle.o);
    if (!(markPx > 0 && rawFillPx > 0)) { noCandles++; return null; }

    // ── `tasks/46` §2.1: the live re-gate ──────────────────────────────────────
    //
    // `loop.ts:373-382` re-tests the published sigma against the price we can actually
    // trade at, and refuses on either magnitude or sign. The published count was measured
    // against a spot up to one poll interval old — the archive's median gap is 30.3
    // minutes — so a market that has already walked to the target carries no edge and the
    // number is a fiction. Without this the simulator admitted exactly those entries.
    //
    // **Against the fill, not the planning mark.** The mark is what we saw; the fill is
    // what the desk sees at the tick it acts on, and the gap between them is the whole
    // point of the check. Before the band, because the executor re-gates on the mark and
    // *then* sends a marketable limit — the band is the price it will accept, not a fact
    // about the edge.
    const liveSigma = liveDisplacementSigma(ev.call, rawFillPx);
    if (Math.abs(liveSigma) < gate.minDisplacementSigma) { staleAtFill++; return null; }
    if (Math.sign(liveSigma) !== (ev.call.side === "long" ? 1 : -1)) { staleAtFill++; return null; }

    const built = buildIntent(ev.call, o.market, settings, marginUsd, markPx, o.at);
    if (!built.ok) return null;
    const it = built.intent;

    const horizonMs = Date.parse(it.exit.horizonAt);
    const after = ks.filter((k) => k.t >= fillCandle.t);
    // ── `tasks/46` §2.2: the fee the ledger already pays ───────────────────────
    //
    // `net_pnl` has carried the builder fee since 2026-09-10 for every account required
    // to approve it, and no model has ever charged it — a gap that grows as the charging
    // cohort does. Charged by default here and removed by `--no-builder-fee`, rather than
    // the other way round, because the default should be **the desk a new account meets**
    // and a new account cannot connect without approving it.
    const rate = takerRate(o.market.dex) + builderRate;
    const dir = it.side === "long" ? 1 : -1;

    // ── `tasks/46` §2.4 and `tasks/50` §1.1: the band, at what the desk pays ───
    //
    // `RISK_PARAMS.slippageBps` has four uses in the executor and was imported by no
    // model. Two of them are chargeable here: the **entry IOC** and the **forced close**,
    // both marketable limits that cross the spread. The other two — the stop and target
    // triggers — are not, and modelling them would need intra-bar data no interval the
    // venue serves can supply, so those still fill at their level and `modelled()` says
    // so.
    //
    // ⚠ **The magnitude charged is the measured one and not the accept band.** From
    // 2026-09-13 to 09-14 this charged `slippageBps` in full — 30bps, twice on ~62% of
    // trades, ~5% of margin per signal at 10x — on the argument that the worst case is
    // the conservative choice. It is not conservative when it is the largest term in the
    // answer: at 30bps the simulator missed the ledger by 0.47pp per signal over the
    // archive against a 0.25pp tolerance, and at the measured figure it lands inside it
    // (`notes/2026-09-14-the-band-the-desk-does-not-pay.md` §2.2). The 30 is still what
    // the order *accepts* and `modelled()` says so; this is where it *lands*.
    const band = bps(MEASURED_ENTRY_SLIP_BPS);
    const fillPx = rawFillPx * (1 + dir * band);
    /** A close that crosses the spread: the forced exits, never a trigger fill. */
    const crossed = (px: number) => px * (1 - dir * band);

    /** The price move this trade caught, signed by side and before any cost. */
    const priceRet = (exitPx: number) => dir * (exitPx - fillPx) / fillPx;

    /** Net of both taker legs, as a fraction of margin. */
    const net = (exitPx: number) =>
      it.leverage * (priceRet(exitPx) - 2 * rate);

    /** The exit price as filled: a forced close pays the band, a trigger does not. */
    const exitPxOf = (reason: string, px: number) =>
      reason === "retired" || reason === "horizon" ? crossed(px) : px;

    // Policy "hold": target, stop or horizon. Retirement is ignored.
    const holdWin = after.filter((k) => k.t <= horizonMs);
    const h = replay(it.side, it.exit.targetPx, it.exit.stopPx, holdWin);
    if (!h) { noCandles++; return null; }

    // Policy "live": whichever comes first of target, stop, retirement or horizon —
    // which is what the executor actually does, since the exits rest on the venue while
    // a vanished forecast force-closes on the next poll.
    const liveEnd = Math.min(retireMs, horizonMs);
    const liveWin = after.filter((k) => k.t <= liveEnd);
    const l = replay(it.side, it.exit.targetPx, it.exit.stopPx, liveWin);
    if (!l) { noCandles++; return null; }
    // `replay` calls "neither was hit" a horizon. When the window ended at a retirement
    // instead, that is what actually closed the trade, and the label must say so.
    const liveReason = l.reason === "horizon" && retireMs < horizonMs ? "retired" : l.reason;

    const hrs = (endMs: number) => (endMs - fillCandle.t) / 3_600_000;
    // ⚠ **These were the last candle of each WINDOW until 2026-09-12, not the exit.** A
    // target taken in the first hour of a ten-hour window was recorded as a ten-hour
    // hold, so Table 1's median hold and Table 1c's occupancy were overstated for every
    // exit that was not a retirement — 71 of 141 trades at σ0. `replay` now returns the
    // triggering candle's close time and this uses it. The direction of the old error
    // was to make the book look *fuller* than it was, so `notes/2026-09-11-…-capacity`'s
    // "the cap is not binding" conclusion survives it and reads stronger.
    const lastLive = l.at;
    const lastHold = h.at;

    // **A trade the data outlived is not a result.** `replay` reports "neither was hit"
    // as a horizon close at the last candle it was given — which is right when the
    // horizon really has passed, and fiction when the candles simply ran out first.
    // Three of the ten trades in a 3-day window are opened on its final day, so folding
    // them in would score positions that are still running. `exit-policy.ts` makes the
    // same refusal for the same reason: half a counterfactual is not a result.
    const dataEnd = ks.at(-1)!.T;
    const resolved = (reason: string, end: number) =>
      reason !== "horizon" ? true : horizonMs <= dataEnd && end >= horizonMs - 60_000;

    // The mark-to-market path, for the halt walk (Table 4) and nothing else.
    //
    // **The daily-loss cap is a threshold on EQUITY, not on realised P&L** — `tick()`
    // reads `view.equityUsd` off the venue, which carries every open position's
    // unrealised mark. So a book of five losing positions halts an account before any
    // of them close, and a walk over closes alone would miss it. Each sample takes the
    // bar's *adverse* extreme (the low for a long, the high for a short), which is the
    // worst equity the venue could have shown inside that bar.
    //
    // Only the entry taker leg is charged: the exit fee has not been paid yet while the
    // position is open, and the close event in the walk uses `net`, which charges both.
    const path: { t: number; mark: number }[] = [];
    for (const k of liveWin) {
      if (k.t > l.at) break;
      const adverse = Number(dir === 1 ? k.l : k.h);
      if (!(adverse > 0)) continue;
      path.push({
        // The candle's own open, not a floor of it: `k.t` already sits on the interval's
        // lattice, and flooring it to a coarser one collapsed distinct samples together.
        t: k.t,
        mark: it.leverage * (dir * (adverse - fillPx) / fillPx - rate),
      });
    }

    const trade: Trade = {
      sigma, signalRef: ev.call.signalRef, coin: ev.call.coin, side: it.side, openedAt: o.at,
      leverage: it.leverage,
      // Where in the forecast's life this entry happened, and how strong the call read
      // at that moment. Both are needed to read a `--hold-hours` sweep at all: a wider
      // cap moves entries earlier, and earlier means a larger `sigma_total` denominator,
      // so the same price gap reads as fewer sigmas and may not clear the gate.
      anchor: o.series.anchor_type,
      assetClass: ev.call.assetClass,
      horizonAtEntryH: (Date.parse(o.series.outlook.anchor_at) - o.at.getTime()) / 3_600_000,
      sigmaAtEntry: Math.abs(o.series.outlook.displacement_sigma),
      // What the stop ACTUALLY is after `clampStopPct` and tick rounding. At 10x the
      // liquidation buffer caps it at 5.25% on a 20x-max market, so an `--stop 8` row is
      // not an 8% row and must not print as one.
      //
      // **Against the planning mark, which is what the stop was planned from**
      // (`tasks/50` §1.3). `buildIntent` derives `stopPx` from `markPx`; dividing by
      // `fillPx` instead measured the stop against a price the band had already moved,
      // so every "as asked → as armed" line read the band wide — `1.0% → 1.30%` at a
      // 30bps band, and at 20x `--stop 2` counted **1 of 162** clamped where the 1.75%
      // ceiling clamps every trade on a 20x-max market. It also put Table 4's *one stop
      // costs* at 2.28% against the connect screen's 1.98%, which is exactly the
      // disagreement `tasks/46` §1.2 removed from `stop-sweep` and this had re-created.
      effStopPct: armedStopPct(it.exit.stopPx, markPx),
      live: {
        reason: liveReason, net: net(exitPxOf(liveReason, l.px)), priceRet: priceRet(exitPxOf(liveReason, l.px)),
        heldH: hrs(lastLive),
        // A retirement we actually observed is an exit, whatever the horizon says.
        resolved: liveReason === "retired" ? true : resolved(liveReason, lastLive),
      },
      hold: {
        reason: h.reason, net: net(exitPxOf(h.reason, h.px)), priceRet: priceRet(exitPxOf(h.reason, h.px)),
        heldH: hrs(lastHold),
        resolved: resolved(h.reason, lastHold),
      },
      path,
      ambiguous: l.ambiguous || h.ambiguous,
    };
    return { trade, closeMs: lastLive };
  }

  // **The budget, when a run asks for it.** Everything below is derived from `kept`, so
  // a capped run's occupancy, peak book, returns and halt walk all describe the same
  // desk rather than a mixture of two.
  const { kept, refused } = opts.maxOpen === null
    ? { kept: trades as Trade[], refused: 0 }
    : capConcurrency(trades, opts.maxOpen);

  // How many would have been open at once — with no `--max-concurrent` the budget is not
  // modelled, so this is the number that says whether it would have bound.
  const edges: { t: number; d: number }[] = [];
  for (const t of kept) {
    edges.push({ t: t.openedAt.getTime(), d: 1 });
    edges.push({ t: t.openedAt.getTime() + t.live.heldH * 3_600_000, d: -1 });
  }
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0, maxConcurrent = 0, peakAt = 0;
  for (const e of edges) { cur += e.d; if (cur > maxConcurrent) { maxConcurrent = cur; peakAt = e.t; } }
  // **What was in the book at its fullest**, not just how much was in it. Closes sort
  // before opens at the same instant, so a position closing exactly at the peak is out.
  const peakBook = kept.filter((t) =>
    t.openedAt.getTime() <= peakAt && t.openedAt.getTime() + t.live.heldH * 3_600_000 > peakAt);

  return {
    trades: kept, noCandles, maxConcurrent, peakBook, refusedByBudget: refused,
    staleAtFill, reentries,
    blockedAfterStop, blockedOutlooks: blockedIds.size,
    refusedAlreadyOpen, alreadyOpenOutlooks: alreadyOpenIds.size,
    occupancy: { live: occupancy(kept, "live"), hold: occupancy(kept, "hold") },
  };
}

/** How many positions are open at a randomly chosen moment — not just at the peak.
 *
 *  **A capacity decision needs the distribution and not the maximum.** `maxConcurrentSignals`
 *  is `floor(1 / perSignalPct)`, so raising it means cutting the position size, and a cap
 *  set to a peak that is reached once buys idle slots at the cost of making every position
 *  smaller. Time-weighted, so a level held for six hours counts for six hours.
 *
 *  Both exit policies, because they give very different answers: retiring on the neutral
 *  turn closes at a median ~4h and holding runs to a level or the horizon. "What if we
 *  ran no stop" is a question about the second one. */
export function occupancy(trades: readonly Trade[], policy: "live" | "hold"): {
  max: number; median: number; p90: number; meanOpenH: number;
} {
  const edges: { t: number; d: number }[] = [];
  for (const t of trades) {
    const heldH = policy === "live" ? t.live.heldH : t.hold.heldH;
    edges.push({ t: t.openedAt.getTime(), d: 1 });
    edges.push({ t: t.openedAt.getTime() + Math.max(0, heldH) * 3_600_000, d: -1 });
  }
  if (edges.length === 0) return { max: 0, median: 0, p90: 0, meanOpenH: 0 };
  edges.sort((a, b) => a.t - b.t || a.d - b.d);
  // Duration spent at each concurrency level, in ms.
  const at = new Map<number, number>();
  let cur = 0, max = 0, prev = edges[0]!.t;
  for (const e of edges) {
    if (e.t > prev) at.set(cur, (at.get(cur) ?? 0) + (e.t - prev));
    prev = e.t;
    cur += e.d;
    max = Math.max(max, cur);
  }
  const total = [...at.values()].reduce((a, b) => a + b, 0);
  const levels = [...at.keys()].sort((a, b) => a - b);
  const quantile = (q: number) => {
    let seen = 0;
    for (const l of levels) { seen += at.get(l)!; if (seen >= q * total) return l; }
    return levels.at(-1) ?? 0;
  };
  const openMs = [...at].reduce((acc, [l, ms]) => acc + l * ms, 0);
  return { max, median: quantile(0.5), p90: quantile(0.9), meanOpenH: total ? openMs / total : 0 };
}

/** **What the book held at its fullest, not just how much of it.**
 *
 *  `tasks/45` §2.2: *"Nine simultaneous positions that are eight commodity longs is the
 *  2026-09-10 mechanism; nine spread across asset classes is not."* A concurrency count
 *  cannot separate those two and this string can. */
export function bookMix(ts: readonly Trade[]): string {
  if (ts.length === 0) return "—";
  const by = new Map<string, number>();
  for (const t of ts) by.set(t.assetClass, (by.get(t.assetClass) ?? 0) + 1);
  const longs = ts.filter((t) => t.side === "long").length;
  return `${ts.length}: ${[...by].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(", ")}`
    + ` (${longs} long)`;
}

/** **The one cap the simulator never modelled: how many positions may be open at once.**
 *
 *  `maxConcurrentSignals(s)` is `floor(1 / perSignalPct)` and `fitsBudget` refuses a
 *  signal with `max-concurrent` the moment the book is full. Every table in this file
 *  used to run without it, which was defensible while the live column's p90 was 5
 *  against 10 slots — and stops being defensible the moment a run asks what a *fuller*
 *  book does, which is exactly `tasks/45` §2.2's question about the 96h horizon cap.
 *
 *  **The model is the conservative one: a refused signal is lost, not deferred.** The
 *  real desk re-considers it on the next tick while the outlook is still live, so a slot
 *  freeing up two minutes later gets the trade at a slightly worse price. Here it never
 *  gets it at all. That difference cannot flatter a wider cap — it only ever removes
 *  entries — which is the direction that keeps the §2.2 attribution honest: if holding
 *  the book at the 48h level rescues the 96h row, the rescue is real and not an artefact
 *  of re-timed entries.
 *
 *  Live-policy holds, like the halt walk, and for the same reason: it is a question
 *  about the desk we run. */
export function capConcurrency(
  trades: readonly Trade[], maxOpen: number,
): { kept: Trade[]; refused: number } {
  const byOpen = [...trades].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime());
  const kept: Trade[] = [];
  const closes: number[] = [];
  let refused = 0;
  for (const t of byOpen) {
    const now = t.openedAt.getTime();
    for (let i = closes.length - 1; i >= 0; i--) if (closes[i]! <= now) closes.splice(i, 1);
    if (closes.length >= maxOpen) { refused++; continue; }
    kept.push(t);
    closes.push(closeMs(t));
  }
  return { kept, refused };
}

/** The best cell of a surface, **and how many cells it cannot be told apart from**.
 *
 *  The second number is the point. A grid always has a best corner; whether that corner
 *  means anything is a question about its interval, and printing the count of cells
 *  whose mean falls inside it is the cheapest way to make the answer unskippable. On the
 *  09-12 archive it is most of the table. */
export function bestCell<T extends { mean: number; lo: number; hi: number }>(
  cells: readonly T[],
): { best: T; inside: number; total: number } | null {
  if (cells.length === 0) return null;
  const best = cells.reduce((a, c) => (c.mean > a.mean ? c : a));
  const inside = cells.filter((c) => c !== best && c.mean >= best.lo && c.mean <= best.hi).length;
  return { best, inside, total: cells.length };
}

// ── the window ───────────────────────────────────────────────────────────────────
//
// `--days N` counts back from the archive's last poll, which is fine for "the last few
// days" and wrong for everything else: isolating the feed that began 2026-09-08 means
// `--days 1.5` today and a different fraction tomorrow, and nobody will get it right
// twice (`tasks/31` §3.1). `--since` pins the left edge to an instant instead.
//
// It also takes a **regime name**, because the windows worth isolating are exactly the
// boundaries `src/risk/regimes.ts` already argues — and a name cannot be mistyped into
// a window that is off by a day the way a date can.

/** `--since` as an instant: a UTC date (`2026-09-08`), a full ISO timestamp, or the name
 *  of a feed regime (`reverted`). Throws rather than returning NaN — a `--since` that
 *  silently parsed to nothing would replay the whole archive and label it as one feed.
 *
 *  **`--until` parses with the same function**, which is what makes a regime name work as
 *  a right edge: a boundary belongs to the regime it opens, so `--until reverted` ends
 *  exactly where `--since reverted` begins and the two halves share no poll. */
export function resolveSince(v: string): number {
  const regime = FEED_REGIMES.find((r) => r.name === v);
  if (regime) return Date.parse(regime.from);
  // Bare dates are UTC midnight. `Date.parse("2026-09-08")` already is; spelling it out
  // so a future reader does not have to remember that a bare date and a bare datetime
  // are read in different zones.
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
  if (!Number.isFinite(ms)) {
    throw new Error(`--since ${v}: not a date and not a regime name (${FEED_REGIMES.map((r) => r.name).join(", ")})`);
  }
  return ms;
}

/** The polls a run reads. `since` is **inclusive** — a poll exactly on a boundary belongs
 *  to the regime that boundary opens, which is the convention `regimeAt` uses and the one
 *  the σ0.5 deploy needs: its first intent opened four seconds after the restart.
 *
 *  **`until` is exclusive, and that asymmetry is the whole point of it.** `--until X` and
 *  `--since X` partition the archive with no poll in both halves, so a cell picked on the
 *  first half is scored on a window it was not picked on. The nested windows the 09-12
 *  reading used for robustness (`--since 09-05`, `--since 09-08`) all share their tail
 *  with the whole archive and are therefore not independent of it (`tasks/45` §1.4).
 *
 *  **Two lists come back, and they are not the same one.** `entryPolls` is what may open
 *  a trade; `polls` runs to the end of the archive so a trade opened inside the window
 *  still sees the retirement that closed it. */
export function windowOf(
  all: Poll[], opts: { sinceMs?: number; untilMs?: number; days: number },
): { startMs: number; endMs: number; entryEndMs: number; polls: Poll[]; entryPolls: Poll[] } {
  const endMs = opts.untilMs ?? all.at(-1)!.t.getTime();
  const entryEndMs = opts.untilMs === undefined ? endMs : opts.untilMs - 1;
  const startMs = opts.sinceMs ?? endMs - opts.days * 86_400_000;
  const polls = all.filter((p) => p.t.getTime() >= startMs);
  return { startMs, endMs, entryEndMs, polls, entryPolls: polls.filter((p) => p.t.getTime() <= entryEndMs) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const arg = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(arg("--days") ?? 3);
  const since = arg("--since");
  // `--until` pins the RIGHT edge, and `--days` still composes with it — `--until X
  // --days 3` is the three days before X. Only `--since` and `--days` disagree about
  // the same edge, which is why only that pair is refused.
  const until = arg("--until");
  // Refused rather than resolved by precedence: two ways to say where the window opens,
  // disagreeing, is exactly the silent-wrong-window failure `--since` exists to prevent.
  if (since !== undefined && argv.includes("--days")) {
    console.log("\n  --since and --days both set. Pass one: --since pins the left edge, --days counts back.\n");
    process.exitCode = 1;
    return;
  }
  const interval = (arg("--interval") ?? "5m") as Interval;
  const sigmas = (arg("--sigmas") ?? "1.0,0.8,0.7,0.6,0.5").split(",").map(Number);
  const holdHoursArg = arg("--hold-hours");
  const holdHours = holdHoursArg === undefined ? null : holdHoursArg.split(",").map(Number);
  // Refused rather than gridded. The two constants interact: `sigma_total` is volatility
  // over the *remaining* horizon and scales as sqrt(t), so a wider cap admits a weekly
  // outlook earlier AND at a denominator up to 1.87x larger, which the sigma gate then
  // has to clear. A 2-D table of the two invites picking a corner, and the corner would
  // be fitted to one archive.
  if (holdHours && sigmas.length > 1) {
    console.log("\n  --hold-hours sweeps one constant at one sigma. Pass a single --sigmas value.");
    console.log("  The two are not independent: sigma_total shrinks as sqrt(remaining horizon),");
    console.log("  so widening the cap admits long-anchor outlooks earlier and at a deflated");
    console.log("  sigma. A grid of both reads as a surface to pick a corner off.\n");
    process.exitCode = 1;
    return;
  }
  if (holdHours?.some((h) => !Number.isFinite(h) || h <= 0)) {
    console.log(`\n  --hold-hours ${holdHoursArg}: expected positive hours, e.g. 48,72,96,120,168.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`network: ${isTestnet() ? "TESTNET" : "MAINNET"}`);
  if (isTestnet()) {
    console.log("\n  Refusing to backtest a mainnet archive against testnet candles — the universe is");
    console.log("  different and the prices are fiction. Re-run with HYPERLIQUID_TESTNET=false.\n");
    process.exitCode = 1;
    return;
  }

  const all = readArchive(DATA_ROOT);
  if (all.length === 0) {
    console.log(`no archive under ${DATA_ROOT}/quotient/perps — pull it from the VPS first`);
    process.exitCode = 1;
    return;
  }
  let sinceMs: number | undefined;
  let untilMs: number | undefined;
  try {
    sinceMs = since === undefined ? undefined : resolveSince(since);
    untilMs = until === undefined ? undefined : resolveSince(until);
  } catch (e) {
    console.log(`\n  ${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
    return;
  }
  if (sinceMs !== undefined && untilMs !== undefined && untilMs <= sinceMs) {
    console.log(`\n  --until ${until} is not after --since ${since}: that window is empty.\n`);
    process.exitCode = 1;
    return;
  }
  const { startMs, endMs, entryEndMs, polls, entryPolls } = windowOf(all, { sinceMs, untilMs, days });
  // A window the archive does not reach is refused, not swept. Asking for `--since
  // reverted` against an archive that stops on 09-02 produced a **negative** span and a
  // sweep over zero polls, which is the silently-wrong-window failure this flag exists
  // to prevent, arriving through the flag itself.
  if (entryPolls.length === 0) {
    console.log(`\n  no polls in that window. The archive here runs ${all[0]!.t.toISOString().slice(0, 16)}Z`);
    console.log(`  → ${new Date(endMs).toISOString().slice(0, 16)}Z — pull a newer one from the VPS.\n`);
    process.exitCode = 1;
    return;
  }

  // `--stop` is the third thing this can sweep, and like the other two it is swept
  // ALONE. The one-dimensional rule is the same one the `--hold-hours` refusal states:
  // a grid has a best corner and the corner is fitted to one archive.
  //
  // Sweeping the stop is cheap in a way the other two are not — it changes nothing about
  // *which* signals are admitted, only how each one is replayed — so every row comes out
  // of a single set of candle fetches.
  const stopArg = arg("--stop");
  const baseSettings: UserSettings = { ...DEFAULT_USER_SETTINGS };
  let stops: number[] | null = null;
  if (stopArg !== undefined) {
    // Accepts 0.01 or 1 — both spellings appear in this repo's own notes, and guessing
    // wrong silently models a 100% stop, which never fires and would read as a strategy.
    // >= 1 is read as percent, < 1 as a fraction. `--stop 1` is one percent, not 100%:
    // nobody models a stop that can never fire, and the fraction spelling is 0.01.
    stops = stopArg.split(",").map((x) => { const n = Number(x); return n >= 1 ? n / 100 : n; });
    if (stops.some((f) => !Number.isFinite(f) || f <= 0 || f >= 1)) {
      console.log(`\n  --stop ${stopArg}: expected stop distances, e.g. 0.01 or 1 for one percent.\n`);
      process.exitCode = 1;
      return;
    }
  }
  // **`--stop` x `--sigmas` prints the surface. Every other pair is still refused.**
  //
  // The refusal this replaces was right about the danger and wrong about the remedy. Its
  // own sentence — *"the best corner of a surface is fitted to the archive that produced
  // it"* — is an argument against **reading a corner off** what you look at, not against
  // looking; and the 09-12 reading needed the surface anyway, so it ran this script four
  // times and pasted the rows together in a text editor. That is the shape that lets a
  // transcription error into a note about money (`tasks/45` §1.1). So it is printed, with
  // `n` and an interval in **every** cell, and the refusal's sentence becomes the header
  // nobody can skip. `--until` is the other half of the answer: a cell picked here can be
  // scored on a window it was not picked on, which is a different claim from "best on
  // everything I looked at".
  //
  // **`--stop` x `--hold-hours` stays refused**, and not out of symmetry. Those two do
  // not merely make a surface, they make an unreadable one: the cap changes which events
  // are admitted *and* the sigma they are admitted at, because `sigma_total` scales as
  // sqrt(remaining horizon). Two cells would differ in their sample as well as in their
  // constant (`notes/2026-09-11-the-gate-is-partly-a-clock.md`).
  const grid = (stops?.length ?? 0) > 1 && sigmas.length > 1;
  if (stops && stops.length > 1 && holdHours && holdHours.length > 1) {
    console.log("\n  --stop and --hold-hours cannot be swept together. Two swept dimensions make a");
    console.log("  surface, and the best corner of a surface is fitted to the archive that produced");
    console.log("  it — which is true of the stop x sigma grid too, and it prints anyway, with every");
    console.log("  cell's interval. This pair is refused for the extra reason: the cap moves the");
    console.log("  SAMPLE, admitting long-anchor outlooks at a deflated sigma, so two cells differ");
    console.log("  in which events they contain and not only in a constant.\n");
    process.exitCode = 1;
    return;
  }
  if (stops?.length === 1) baseSettings.stopPct = stops[0]!;

  // `--leverage` is a scalar, and it exists because **the stop and the leverage are one
  // knob**. `clampStopPct` caps the stop at `liqBufferFrac` of the distance to
  // liquidation, so at 10x nothing above ~5.25% can be armed at all and `--stop 6,7,8`
  // returns three identical rows. Testing a genuinely wide stop means dropping leverage:
  // the ceiling is 5.25% at 10x, 12.25% at 5x and 21.6% at 3x on a 20x-max asset.
  //
  // Read the rows knowing what the unit does: return is a fraction of MARGIN, so halving
  // leverage halves the same price move. The comparison that isolates "price room" from
  // "risk per trade" is a constant `stopPct x leverage` — 3% at 10x, 6% at 5x and 10% at
  // 3x all lose 30% of margin when they fire.
  const levArg = arg("--leverage");
  if (levArg !== undefined) {
    const lv = Number(levArg);
    // **Any integer the venue accepts, not only the three the site offers** — widened
    // 2026-09-12 for one question the old restriction could not ask.
    //
    // It used to refuse anything but 5/10/20, on the argument that modelling a leverage
    // nobody can choose measures a desk we will not run. That is right when the leverage
    // is an input. It is wrong when the leverage is the *question*: the stop ceiling is
    // `liqBufferFrac × (1/L − 1/2Lmax)`, so **L is the only thing that sets how much
    // price room a stop can have**, and 5/10/20 samples that continuum at three points
    // with a hole in exactly the interesting place:
    //
    //   20x -> 1.75%   18x -> 2.14%   10x -> 5.25%   9x -> 6.03%   8x -> 7.00%   5x -> 12.25%
    //
    // Asking "what leverage arms a 6% stop" is unanswerable inside {5,10,20}, and the
    // answer (9x, or 8x with room to spare) is a `SITE_OFFERS` proposal rather than a
    // backtest artefact. ⚠ **That is how 18x got onto the site on 2026-09-12** — not for a
    // wider stop, which this sweep says nobody wants, but because 20x could not arm the
    // 2% default at all on a 20x-max asset (item 25). So the flag models it and the banner says it is not on offer —
    // the refusal moves from the simulator, where it blocked a measurement, to the place
    // where it is actually a decision about other people's money.
    if (!Number.isInteger(lv) || lv < 2 || lv > 20) {
      console.log(`\n  --leverage ${levArg}: expected a whole number from 2 to 20 (Hyperliquid takes integers,`);
      console.log(`  and 20x is the highest any market we trade offers).\n`);
      process.exitCode = 1;
      return;
    }
    // The cast is the one place this file steps outside `UserSettings`. The type is
    // `5 | 10 | 20` because that is what `parseSettings` accepts from the web, and
    // nothing downstream of here cares: `buildIntent` clamps against the market's own
    // max and treats leverage as a number throughout.
    baseSettings.leverage = lv as UserSettings["leverage"];
  }
  // `--per-signal` is a scalar too, and it is here because it is the dial that decides
  // whether a wide stop halts an account. `stopOutOfMandate` is
  // `stopPct × leverage × perSignalPct × (1 − reserveFrac)`, so the first three set what
  // a stop-out costs in *margin* and this one converts it to mandate. Table 4 is
  // unreadable without being able to move it.
  const perSignalArg = arg("--per-signal");
  if (perSignalArg !== undefined) {
    const p = Number(perSignalArg);
    const frac = p >= 1 ? p / 100 : p;
    if (!Number.isFinite(frac) || frac <= 0 || frac > 1) {
      console.log(`\n  --per-signal ${perSignalArg}: expected a position size, e.g. 0.10 or 10 for a tenth.\n`);
      process.exitCode = 1;
      return;
    }
    baseSettings.perSignalPct = frac;
  }

  // `--max-concurrent` is the budget this file has never modelled, and it exists for one
  // question: `tasks/45` §2.2 asks whether the 96h horizon cap collapses because it holds
  // more positions at once or because the entries it adds are worse. Holding the book at
  // the narrower cap's level while admitting the wider cap's entries separates the two.
  const maxOpenArg = arg("--max-concurrent");
  let maxOpen: number | null = null;
  if (maxOpenArg !== undefined) {
    const n = Number(maxOpenArg);
    if (!Number.isInteger(n) || n < 1) {
      console.log(`\n  --max-concurrent ${maxOpenArg}: expected a whole number of slots, e.g. 7.`);
      console.log(`  maxConcurrentSignals is floor(1 / perSignalPct): 10% per signal is 10 slots.\n`);
      process.exitCode = 1;
      return;
    }
    maxOpen = n;
  }

  // ── `tasks/46` §2.3 and §2.2: the two things the desk does that this did not ──
  //
  // Both **on** by default, and both off by a flag rather than on by one. A default is a
  // claim about which desk the rows describe, and the desk re-enters and pays the fee. The
  // off switches exist for one question each: what the model looked like before
  // 2026-09-13, and what the grandfathered cohort pays.
  const reentry = !process.argv.includes("--no-reentry");
  const builderFee = !process.argv.includes("--no-builder-fee");

  const sweptStop = (stops?.length ?? 0) > 1;
  const marginUsd = 100;   // the unit is % of margin, so the figure only sets rounding

  const spanD = (endMs - startMs) / 86_400_000;
  // The feed regimes the window touches, named on the same line as the window — because
  // a sweep that spans a boundary is a sweep over two populations, and `tasks/31` §1 is
  // that pooling them answers a question nobody asked.
  const spanned = FEED_REGIMES.filter((r, i) => {
    const from = Date.parse(r.from);
    const to = FEED_REGIMES[i + 1] ? Date.parse(FEED_REGIMES[i + 1]!.from) : Infinity;
    return from < endMs && to > startMs;
  });
  console.log(
    `window: ${new Date(startMs).toISOString()} → ${new Date(endMs).toISOString()}  ` +
    `(${spanD.toFixed(1)}d, ${entryPolls.length} polls, ` +
    `${since === undefined ? `--days ${days}` : `--since ${since}`}${until === undefined ? "" : ` --until ${until}`})`,
  );
  console.log(
    `feed: ${spanned.map((r) => r.name).join(" + ")}` +
    (spanned.length > 1
      ? "   ⚠ more than one regime — these rows pool populations that differ in what was offered"
      : "   one regime, which is the unit `tasks/31` §1 asks for"),
  );
  console.log(
    `account modelled: ${baseSettings.leverage}x, stop ${sweptStop ? "swept" : pc(baseSettings.stopPct)}, ` +
    `${pc(baseSettings.perSignalPct)} per signal — one canonical account` +
    (maxOpen === null ? "" : `, at most ${maxOpen} open at once`),
  );
  if (maxOpen !== null) {
    console.log(
      `  ⚠ --max-concurrent ${maxOpen}: the budget is modelled, which it is not by default. ` +
      `${pc(baseSettings.perSignalPct)} per signal\n    really buys ` +
      `${Math.floor(1 / baseSettings.perSignalPct)} slots — this run is NOT that desk unless the two agree. ` +
      `A refused\n    signal is lost rather than deferred, so the cap can only remove entries.`,
    );
  }
  if (until !== undefined) {
    console.log(
      `  out of sample: --until is exclusive, so \`--since ${until}\` is the other half and shares no poll\n` +
      `    with this one. Entries stop at the edge; retirements are still read past it.`,
    );
  }
  if (!(SITE_OFFERS.leverage as readonly number[]).includes(baseSettings.leverage)) {
    console.log(
      `  ⚠ ${baseSettings.leverage}x is NOT on offer — the site sells ${SITE_OFFERS.leverage.join("/")}x and ` +
      `\`UserSettings.leverage\` is typed to them.\n` +
      `    Every row below is a desk nobody can choose today. Adopting it is a SITE_OFFERS change, not a run of this script.`,
    );
  }
  console.log(
    `fees: taker both legs, ${(TAKER_NATIVE * 10_000).toFixed(1)}bps native / ` +
    `${(TAKER_NATIVE * HIP3_FEE_SCALE * 10_000).toFixed(1)}bps on xyz:` +
    (builderFee
      ? `, plus the builder fee at ${(BUILDER_RATE * 10_000).toFixed(1)}bps per order (BUILDER_FEE.tenthsBp = ${BUILDER_FEE.tenthsBp})`
      : ` — builder fee OFF (--no-builder-fee): the grandfathered cohort, not the desk a new account meets`) +
    `. Funding not modelled (§6).`,
  );
  console.log(
    `band: ${MEASURED_ENTRY_SLIP_BPS}bps charged on the entry and on a forced close, ` +
    `never on a trigger fill (§2.4).` +
    (reentry ? "" : "   ⚠ re-entry OFF (--no-reentry): one trade per outlook, ever, which is not this desk."),
  );
  console.log(
    `      measured, not assumed: ${ENTRY_SLIP_SOURCE}.\n` +
    `      RISK_PARAMS.slippageBps is ${RISK_PARAMS.slippageBps}bps and is a different fact — the price the IOC accepts,\n` +
    `      not where it lands. Charging it in full cost ~5% of margin per signal and is what\n` +
    `      stopped this simulator reproducing the desk until 2026-09-14 (tasks/50 §1.1).\n` +
    `      ⚠ The forced-close leg is charged the ENTRY figure: nothing stores the mark at the\n` +
    `      close tick, so that leg has never been measured.`,
  );
  console.log("");

  // `tasks/46` §2.5 — one table, at the top, before any number. It used to be six
  // numbered rules in a header comment and a scatter of `⚠` blocks under the tables they
  // qualified, which is to say: in the one place a reader of the output never looks.
  console.log(modelledTable("backtest", { interval, reentry, builderFee, entrySlipBps: MEASURED_ENTRY_SLIP_BPS }));
  console.log("");

  // The ledger's own trades over this window, for the replication row below. Read here,
  // before the venue is touched, so a missing or unreadable ledger is one line at the top
  // rather than a throw after four minutes of candle fetching. `loadTrips` and `collapse`
  // are `expectancy`'s — the comparison has to be against the number that script prints,
  // not against this one's idea of it (`tasks/47` Rule 3).
  let ledgerEvents: ReturnType<typeof collapse> = [];
  if (existsSync(LEDGER)) {
    const store = new Store(LEDGER, { readOnly: true });
    try {
      ledgerEvents = collapse(loadTrips(store).trips);
    } finally {
      store.close();
    }
  } else {
    console.log(`  (no ledger at ${LEDGER} — the replication row below will say so.)\n`);
  }

  const info = makeInfoClient();
  const universe = await loadUniverse(info);

  // The gates this run sweeps. One dimension, always — see the refusal in the args.
  const legs: { label: string; over: Partial<typeof GATE>; settings: UserSettings }[] =
    grid
      ? sigmas.flatMap((sg) => stops!.map((f) => ({
        // Grouped by σ then stop, so the flattened tables below read down a column of the
        // surface rather than across it.
        label: `${(f * 100).toFixed(1)}%@${sg.toFixed(1)}`,
        over: holdHours
          ? { minDisplacementSigma: sg, maxHoldHours: holdHours[0]! }
          : { minDisplacementSigma: sg },
        settings: { ...baseSettings, stopPct: f },
      })))
      : stops && stops.length > 1
      ? stops.map((f) => ({
        label: `${(f * 100).toFixed(1)}%`,
        over: holdHours ? { minDisplacementSigma: sigmas[0]!, maxHoldHours: holdHours[0]! } : { minDisplacementSigma: sigmas[0]! },
        settings: { ...baseSettings, stopPct: f },
      }))
      : holdHours
        ? holdHours.map((h) => ({ label: `${h}h`, over: { minDisplacementSigma: sigmas[0]!, maxHoldHours: h }, settings: baseSettings }))
        : sigmas.map((s) => ({ label: s.toFixed(1), over: { minDisplacementSigma: s }, settings: baseSettings }));

  // Which coins does any gate in the sweep want? Fetch each once.
  const wanted = new Set<string>();
  for (const leg of legs) {
    const gate = { ...GATE, ...leg.over };
    for (const poll of entryPolls) {
      for (const ser of poll.series) {
        const ev = evaluateSeries(ser, poll.t, gate);
        if (ev.ok && universe.resolve(ev.call.coin)) wanted.add(ev.call.coin);
      }
    }
  }
  console.log(`fetching ${interval} candles for ${wanted.size} market(s)…`);
  const candles = new Map<string, Candle[]>();
  // **Which markets this run could not price** (`tasks/50` §1.5). A `no candles` line and
  // nothing else was the whole report until 2026-09-14: every table printed without that
  // market's trades and the replication verdict printed without a word. The list is
  // carried into the verdict and banners every table below.
  const missingMarkets: string[] = [];
  let shortest: number | null = null;
  for (const coin of [...wanted].sort()) {
    try {
      const ks = await candlesFor(info, coin, interval, startMs, endMs + 3 * 86_400_000);
      if (ks.length === 0) {
        // An empty answer is not an error and is exactly as damaging: the market is
        // wanted, has no prices, and every trade on it silently disappears.
        console.log(`  ${coin}: no candles (the venue returned an empty range)`);
        missingMarkets.push(coin);
        continue;
      }
      candles.set(coin, ks);
      shortest = Math.max(shortest ?? 0, ks[0]!.t);
    } catch (e) {
      console.log(`  ${coin}: no candles (${e instanceof Error ? e.message.slice(0, 48) : e})`);
      missingMarkets.push(coin);
    }
  }
  // The row cap is the real limit on how far back this can see, so say where it bit
  // rather than leaving it to be inferred from a skip count.
  if (shortest !== null && shortest > startMs) {
    const lost = (shortest - startMs) / 86_400_000;
    console.log(`\n  ⚠ the venue's ~5000-row cap starts the price data at ${new Date(shortest).toISOString().slice(0, 16)}Z,`);
    console.log(`    ${lost.toFixed(1)} day(s) after the window opens. Everything before that is skipped for want`);
    console.log(`    of candles, whatever the window says. A coarser --interval reaches further back.`);
  }
  // **The banner the missing market never had** (`tasks/50` §1.5). One `no candles` line
  // scrolls past four minutes before the first table; this sits on top of every table
  // that was computed without it, because the tables are what a reader quotes.
  const banner = () => {
    if (missingMarkets.length === 0) return;
    console.log(`\n  ⚠⚠ ${missingMarkets.length} MARKET(S) MISSING: ${missingMarkets.join(", ")}. Every row that follows was`);
    console.log(`     computed without their trades, and a missing market deletes a P&L rather than`);
    console.log(`     shrinking a sample evenly — on 2026-09-14 one rate-limited market took a window's`);
    console.log(`     ten biggest losers out and read +0.9% of margin per signal better for it.`);
  };
  console.log("");

  const rows: { sigma: number; stopPct: number; label: string; r: Awaited<ReturnType<typeof runGate>> }[] = [];
  for (const leg of legs) {
    rows.push({
      sigma: leg.over.minDisplacementSigma ?? GATE.minDisplacementSigma,
      stopPct: leg.settings.stopPct, label: leg.label,
      r: await runGate(leg.over, polls, universe, leg.settings, candles, marginUsd,
        { entryEndMs, maxOpen, reentry, builderFee }),
    });
  }
  // ── The replication row (`tasks/47` Rule 3), above every table it qualifies ───────
  //
  // The sweep's own leg at the **shipped** gate and the **shipped** stop is the only leg
  // that claims to be the desk; every other one is a counterfactual and has no ledger to
  // be checked against. When the run does not sweep across the shipped values at all —
  // `--sigmas 1.0 --stop 6` — there is no such leg and the row says so rather than
  // grading the nearest one, which would silently compare two different desks.
  const shippedLeg = rows.find((x) =>
    Math.abs(x.sigma - GATE.minDisplacementSigma) < 1e-9
    && Math.abs(x.stopPct - DEFAULT_USER_SETTINGS.stopPct) < 1e-9);
  const rep = replicate({
    modelledTrades: shippedLeg?.r.trades ?? [],
    ledgerEvents: ledgerEvents,
    windowStartMs: startMs,
    windowEndMs: entryEndMs,
    missingMarkets,
  });
  console.log(replicationBlock(rep, {
    windowLabel: shippedLeg === undefined
      ? `this window (no leg at the shipped σ${GATE.minDisplacementSigma}/${pc(DEFAULT_USER_SETTINGS.stopPct)})`
      : `σ${GATE.minDisplacementSigma} / ${pc(DEFAULT_USER_SETTINGS.stopPct)}, this window`,
  }));
  console.log("");

  // Every table below prints one row per leg, and a grid has many more legs than a sweep.
  const lw = Math.max(5, ...legs.map((l) => l.label.length));
  const swept = sweptStop ? "stopPct" : holdHours ? "maxHoldHours" : "minDisplacementSigma";
  // Only a sigma sweep gets the sigma prefix. The other two label themselves.
  const rowPrefix = swept === "minDisplacementSigma" ? "\u03c3" : "";
  if (holdHours) {
    console.log(`sweeping maxHoldHours at minDisplacementSigma ${sigmas[0]!.toFixed(2)}. `
      + `The cap does not change how long we hold —\nthe desk exits on the neutral turn — it changes when in a forecast's life we enter.\n`);
  }

  // ── Table 3: the surface, and the header that says what it is not for ───────
  //
  // `tasks/45` §1.2 asks for three things the four-command version could not carry: an
  // `n` in every cell (the σ column changes the sample by 4x), a best-cell line that
  // refuses to name a winner, and the stop-as-armed block per σ.
  if (grid) {
    const cellOf = (f: number, sg: number) =>
      rows.find((x) => x.stopPct === f && Math.abs(x.sigma - sg) < 1e-9);
    const stat = (f: number, sg: number) => {
      const c = cellOf(f, sg);
      const done = (c?.r.trades ?? []).filter((t) => t.live.resolved);
      return done.length === 0 ? null : { ...ci(done.map((t) => t.live.net)), stopPct: f, sigma: sg };
    };
    banner();
    console.log("Table 3 — the stop x sigma surface, in one command. It was four commands and a");
    console.log("table pasted together in a text editor on 2026-09-12, which is how a transcription");
    console.log("error gets into a note about money.\n");
    console.log("  ⚠ TWO SWEPT DIMENSIONS, and this table's own former refusal is still true of it:");
    console.log("    \"the best corner of a surface is fitted to the archive that produced it\".");
    console.log("    Read the SHAPE — which columns lose money at every stop, whether the stop's");
    console.log("    advantage narrows as the gate loosens. Never read a cell off it, and never a");
    console.log("    pair: moving sigma and stopPct together would be two constants changed on one");
    console.log("    archive with the corner chosen after seeing it.\n");
    const W = 14;
    console.log(`  per leg, net of both taker legs, as % of the position's margin`);
    console.log(`  ${"stop".padEnd(5)} │${sigmas.map((sg) => `σ${sg.toFixed(1)}`.padStart(W)).join("")}`);
    console.log(`${"─".repeat(8)}┼${"─".repeat(W * sigmas.length)}`);
    for (const f of stops!) {
      const cs = sigmas.map((sg) => stat(f, sg));
      console.log(`  ${`${(f * 100).toFixed(1)}%`.padStart(5)} │`
        + cs.map((c) => (c === null ? "—" : pc(c.mean)).padStart(W)).join(""));
      console.log(`${" ".repeat(8)}│`
        + cs.map((c) => (c === null ? "" : `n=${c.n} ±${(100 * (c.hi - c.lo) / 2).toFixed(2)}`).padStart(W)).join(""));
    }
    console.log(`\n  The second line of each row is that cell's own sample and the half-width of its`);
    console.log(`  95% interval: the interval is mean ± that figure. A cell at n=11 and a cell at`);
    console.log(`  n=145 printed in the same table with no counts is the likeliest way this is`);
    console.log(`  misread, which is why the counts are not in a footnote.`);

    const cells = stops!.flatMap((f) => sigmas.map((sg) => stat(f, sg)))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const b = bestCell(cells);
    if (b) {
      console.log(`\n  best cell: ${(b.best.stopPct * 100).toFixed(1)}% stop at σ${b.best.sigma.toFixed(1)},`
        + ` ${pc(b.best.mean)} per leg (n=${b.best.n}, 95% CI ${pc(b.best.lo)}…${pc(b.best.hi)})`);
      console.log(`  **${b.inside} of the other ${b.total - 1} cells have a mean inside that interval.**`);
      console.log(`  That count is the safeguard, not the coordinates above it. A grid always has a`);
      console.log(`  best corner; whether it means anything is a question about its interval.`);
    }

    console.log(`\n  stop as asked → median as armed (clampStopPct, then tick rounding), per σ:`);
    for (const sg of sigmas) {
      const parts = stops!.map((f) => {
        const eff = (cellOf(f, sg)?.r.trades ?? []).map((t) => t.effStopPct)
          .filter((x): x is number => x !== null).sort((a, b) => a - b);
        if (eff.length === 0) return `${(f * 100).toFixed(1)}%→—`;
        const clamped = clampedCount(eff, f);
        return `${(f * 100).toFixed(1)}%→${pc(eff[eff.length >> 1]!)}`
          + (clamped > 0 ? ` (${clamped}/${eff.length})` : "");
      });
      console.log(`    σ${sg.toFixed(1)}  ${parts.map((x) => x.padEnd(22)).join("")}`);
    }
    // ⚠ These ceilings were hardcoded at their 10x values until 2026-09-12 and printed
    // under whatever `--leverage` said, so a 5x run claimed a 3.5% floor it does not
    // have (the true one is 7.0%) and called its 6% row clamped when it arms in full.
    // The flag takes any leverage 2–20, so the legend has to be computed like everything
    // else here — from `maxStopPct`, the function the executor itself clamps with.
    const lev = baseSettings.leverage;
    // The tightest ceiling ANY market can impose at this leverage is the one where the
    // market's own max equals it: liqBufferFrac x (1/L - 1/2L) = liqBufferFrac / 2L.
    // A higher asset max leaves MORE room, never less.
    const tightest = maxStopPct(lev, lev, RISK_PARAMS.liqBufferFrac);
    console.log(`  (n/m) is how many of that cell's stops came out below what was asked — by`);
    console.log(`  clampStopPct, or by rounding to the venue's tick, and **the column mixes the**`);
    console.log(`  **two**. At ${lev}x **nothing under ${pc(tightest)} can be clamped at all** — that is the`);
    console.log(`  tightest ceiling any market can impose (liqBufferFrac / 2L, when the market's own`);
    console.log(`  max leverage equals ours), against ${pc(maxStopPct(lev, 20, RISK_PARAMS.liqBufferFrac))} on a 20x-max market. Every count`);
    console.log(`  in a row below ${pc(tightest)} is therefore tick rounding, which bites a tight stop harder`);
    console.log(`  because the threshold is relative. Rows above it mix the two and the median-armed`);
    console.log(`  figure beside the count is what says which.`);
    console.log(`  **The clamp does not interact with σ** — it is liqBufferFrac x the distance to`);
    console.log(`  liquidation, a property of the leverage and the market — but the market MIX`);
    console.log(`  changes down a σ column, so the counts move and the reader will not remember why.\n`);
  }

  // ── Table 1: what each gate produces, under the policy we actually run ───────
  banner();
  console.log("Table 1 — what each entry gate would have traded, exiting the way we do:");
  console.log("target, stop, a retired forecast, or the horizon, whichever came first.");
  console.log("Net of taker fees on both legs, as % of the position's margin, **per leg**.\n");
  // **Per leg, and it says so** (`tasks/50` §1.2). `n` counts trades and the mean averages
  // them, so an outlook re-entered three times is three draws here — which is a different
  // unit from the replication row above and from `npm run expectancy`, where an outlook's
  // legs are summed and the sum is one event. The two are not interchangeable and the
  // column used to call itself "per signal" in both places.
  console.log(`  ${(grid ? "cell" : sweptStop ? "stop" : holdHours ? "cap" : "σ").padEnd(lw)} │    n      per leg        95% CI          hit     worst    median hold   concurrent`);
  console.log(`${"─".repeat(lw + 3)}┼─────────────────────────────────────────────────────────────────────────────────────`);
  for (const { label, r } of rows) {
    const done = r.trades.filter((t) => t.live.resolved);
    if (done.length === 0) { console.log(`  ${label.padEnd(lw)} │    0   — nothing resolved in this window`); continue; }
    const c = ci(done.map((t) => t.live.net));
    const held = done.map((t) => t.live.heldH).sort((a, b) => a - b);
    const worst = Math.min(...done.map((t) => t.live.net));
    console.log(
      `  ${label.padEnd(lw)} │ ${String(c.n).padStart(4)}   ${pc(c.mean).padStart(9)}   ` +
      `${pc(c.lo).padStart(9)}…${pc(c.hi).padStart(9)}  ` +
      `${`${done.filter((t) => t.live.net > 0).length}/${done.length}`.padStart(6)}  ${pc(worst).padStart(8)}   ` +
      `${(held[Math.floor(held.length / 2)] ?? 0).toFixed(1).padStart(6)}h        ${String(r.maxConcurrent).padStart(2)}`,
    );
  }

  if (maxOpen !== null) {
    console.log(`\n  entries the ${maxOpen}-slot budget refused: `
      + rows.map(({ label, r }) => `${label} ${r.refusedByBudget}`).join("   "));
    console.log(`  A refused signal is lost here, not deferred to the next tick as the desk would.`);
  }

  // ── Table 1c: the capacity question, and it is the distribution that answers it.
  //
  // `maxConcurrentSignals` is `floor(1 / perSignalPct)`, so raising the cap means cutting
  // the position size — and a cap set to a peak reached once buys idle slots at the cost
  // of making every position smaller. Time-weighted, both exit policies, because "what if
  // we ran no stop" is a question about the holding one and it holds far longer.
  banner();
  console.log(`\nTable 1c — how many positions are open at a randomly chosen moment.`);
  console.log(`Time-weighted, so a level held for six hours counts for six hours.\n`);
  console.log(`  ${(grid ? "cell" : sweptStop ? "stop" : holdHours ? "cap" : "σ").padEnd(lw)} │  exit on retirement          hold to tp/sl/horizon      │ the cap binds above`);
  console.log(`${" ".repeat(lw + 3)}│  median   p90   max   mean    median   p90   max   mean │    live   holding`);
  console.log(`${"─".repeat(lw + 3)}┼─────────────────────────────────────────────────────────┼────────────────────`);
  for (const { label, r } of rows) {
    const l = r.occupancy.live, h = r.occupancy.hold;
    console.log(
      `  ${label.padEnd(lw)} │ ${String(l.median).padStart(7)} ${String(l.p90).padStart(5)} ${String(l.max).padStart(5)}`
      + ` ${l.meanOpenH.toFixed(1).padStart(6)}  ${String(h.median).padStart(8)} ${String(h.p90).padStart(5)} `
      + `${String(h.max).padStart(5)} ${h.meanOpenH.toFixed(1).padStart(6)} │ `
      + `${bindsAbove(l.p90).padStart(7)} ${bindsAbove(h.p90).padStart(9)}`,
    );
  }
  console.log(`\n  The desk's own cap is maxConcurrentSignals = floor(1 / perSignalPct):`);
  console.log(`    20% per signal ->  5 slots      10% (default) -> 10      5% -> 20      2.5% -> 40`);
  console.log(`  **"binds above" is the position size at which that cap starts REFUSING signals**,`);
  console.log(`  which is the first point at which it buys anything at all. floor(1/p) < p90 exactly`);
  console.log(`  when p > 1/p90, so the crossing is arithmetic and needs no sample — and "never"`);
  console.log(`  means no size the site offers (${pc(SITE_OFFERS.perSignalPct.min)}–${pc(SITE_OFFERS.perSignalPct.max)}) reaches it, which is every row whose`);
  console.log(`  p90 is ${Math.floor(1 / SITE_OFFERS.perSignalPct.max)} or below.`);
  console.log(`  A cap above the p90 is idle capacity bought by shrinking every position, and`);
  console.log(`  it raises the funding floor with it: minFundedForLiveUsd is`);
  console.log(`  minOrderNotionalUsd / (perSignalPct x leverage), so 5% at 5x needs `
    + `$${minFundedForLiveUsd({ perSignalPct: 0.05, leverage: 5 }).toFixed(2)} and`);
  console.log(`  2.5% at 5x needs $${minFundedForLiveUsd({ perSignalPct: 0.025, leverage: 5 }).toFixed(2)} before an account can trade at all.`);

  // ⚠ A stop sweep must print what was ARMED, not what was asked for. `clampStopPct`
  // caps the stop at `liqBufferFrac` of the distance to liquidation — near 7% at 10x,
  // and tighter on the markets that cap leverage at 10x — and it is a note on the intent
  // rather than a refusal, so an `--stop 8` row is silently a ~7% row.
  // The grid prints its own armed block, per σ, up in Table 3.
  if (sweptStop && !grid) {
    console.log(`\n  stop as asked → as armed (clampStopPct, then tick rounding):`);
    for (const { label, r } of rows) {
      const eff = r.trades.map((t) => t.effStopPct).filter((x): x is number => x !== null).sort((a, b) => a - b);
      if (eff.length === 0) { console.log(`    ${label.padEnd(lw + 1)} — no trade armed a stop`); continue; }
      const m = eff[eff.length >> 1]!;
      const asked = Number(label.replace("%", "")) / 100;
      const clamped = clampedCount(eff, asked);
      console.log(`    ${label.padEnd(lw + 1)}median armed ${pc(m).padStart(7)}   `
        + `widest ${pc(eff.at(-1)!).padStart(7)}   ${clamped} of ${eff.length} clamped`);
    }
  }

  // ── Table 1b: only for a cap sweep, and it is the table that answers the question.
  //
  // A wider cap does not buy hold time, it buys *entries earlier in a forecast's life*.
  // Whether that is worth anything is not visible in a mean — it is visible in which
  // anchors appear at all, and at what sigma they were admitted. `sigma_total` scales as
  // sqrt(remaining horizon) (measured slope 0.501 over 342 outlooks), so an outlook
  // admitted at 168h rather than 48h carries a denominator 1.87x larger and the same
  // price gap reads as barely half the sigmas.
  if (holdHours) {
    banner();
    console.log(`\nTable 1b — where in each forecast's life the entries happened, and which`);
    console.log(`anchors got in at all. This is what the cap actually moves.\n`);
    console.log(`  ${"cap".padEnd(lw)} │  events   med h   med |σ| │ daily  next-day  weekly  monthly │ crypto  equity  commodity │ the book at its fullest`);
    console.log(`${"─".repeat(lw + 3)}┼${"─".repeat(118)}`);
    for (const { label, r } of rows) {
      const done = r.trades.filter((t) => t.live.resolved);
      if (done.length === 0) { console.log(`  ${label.padEnd(lw)} │       0`); continue; }
      const m = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] ?? NaN; };
      const byA = (a: string) => done.filter((t) => t.anchor === a).length;
      const byC = (c: string) => done.filter((t) => t.assetClass === c).length;
      console.log(
        `  ${label.padEnd(lw)} │ ${String(done.length).padStart(7)}  ${m(done.map((t) => t.horizonAtEntryH)).toFixed(1).padStart(6)}  `
        + `${m(done.map((t) => t.sigmaAtEntry)).toFixed(2).padStart(8)} │ `
        + `${String(byA("daily")).padStart(5)}  ${String(byA("next-day")).padStart(8)}  ${String(byA("weekly")).padStart(6)}  ${String(byA("monthly")).padStart(7)} │ `
        + `${String(byC("crypto")).padStart(6)}  ${String(byC("equity")).padStart(6)}  ${String(byC("commodity")).padStart(9)} │ ${bookMix(r.peakBook)}`,
      );
    }
    console.log(`\n  ⚠ Concurrency is not correlation. The last column is the book at its fullest`);
    console.log(`    moment: nine positions that are eight commodity longs is the 2026-09-10`);
    console.log(`    mechanism — three accounts halted in six minutes — and nine spread across`);
    console.log(`    asset classes is not. The count alone cannot tell those apart, and every`);
    console.log(`    proportional cap this desk runs binds on the count.`);
    console.log(`\n  ⚠ A wider cap buys fewer extra entries than the refused population implies, and`);
    console.log(`    the sigma column is why it is not obvious. sigma_total is volatility over the`);
    console.log(`    REMAINING horizon and scales as sqrt(t) (measured slope 0.501 over 342`);
    console.log(`    outlooks), so an outlook seen at 168h carries a denominator ~1.87x the one it`);
    console.log(`    carries at 48h: the same price gap reads as barely half the sigmas, and some`);
    console.log(`    of what the cap was refusing still cannot clear ${sigmas[0]!.toFixed(2)} once the cap is gone.`);
    console.log(`    Widening the cap therefore does two things at once — it moves entries earlier`);
    console.log(`    AND it raises the bar they are entered on. That is the finding rather than a`);
    console.log(`    defect of the sweep (notes/2026-09-11-the-gate-is-partly-a-clock.md).`);
    console.log(`\n    And the cap does not buy hold time: the median hold barely moves across`);
    console.log(`    every row, because the desk exits on the neutral turn, not on the horizon.`);
  }

  // The one number that stops these rows being read as returns, printed where they are
  // read rather than in a note somebody has to have read. The most repeated misuse of
  // this script has been quoting a row as an expected return, and it has happened in
  // three separate notes. **Both figures now carry the day and window they were measured
  // on**, and the test asserts the constant rather than the digits (`tasks/46` §1.3).
  console.log(`\n  ${calibrationLine(CALIBRATION.returns)}`);

  // ── Table 2: the exit policy, on trades resolved under BOTH ──────────────────
  //
  // Paired, and it has to be. A trade opened on the window's last day has retired
  // (so the live column can score it) while its horizon is still in the future (so
  // the holding column cannot). Comparing the two columns' unpaired means would then
  // be comparing different samples — and at σ0.5 the three unpaired trades are all
  // winners, which would flatter the policy we happen to run by 0.57 points.
  banner();
  console.log("\nTable 2 — the same trades, exited two ways. Paired: only trades whose horizon");
  console.log("has passed, so both policies can be scored on the same set.\n");
  console.log(`  ${(grid ? "cell" : sweptStop ? "stop" : holdHours ? "cap" : "σ").padEnd(lw)} │  n   exit on retirement      hold to tp/sl       difference        95% CI`);
  console.log(`${" ".repeat(lw + 3)}│        mean     worst        mean     worst`);
  console.log(`${"─".repeat(lw + 3)}┼──────────────────────────────────────────────────────────────────────────────────`);
  for (const { label, r } of rows) {
    const both = r.trades.filter((t) => t.live.resolved && t.hold.resolved);
    if (both.length === 0) { console.log(`  ${label.padEnd(lw)} │  0   — no trade is resolved under both`); continue; }
    const cl = ci(both.map((t) => t.live.net));
    const ch = ci(both.map((t) => t.hold.net));
    const cd = ci(both.map((t) => t.hold.net - t.live.net));
    const wl = Math.min(...both.map((t) => t.live.net));
    const wh = Math.min(...both.map((t) => t.hold.net));
    console.log(
      `  ${label.padEnd(lw)} │ ${String(both.length).padStart(2)}   ${pc(cl.mean).padStart(8)} ${pc(wl).padStart(9)}   ` +
      `${pc(ch.mean).padStart(9)} ${pc(wh).padStart(9)}   ` +
      `${pc(cd.mean).padStart(10)}   ${pc(cd.lo).padStart(8)}…${pc(cd.hi).padStart(8)}`,
    );
  }
  console.log("\n  \"difference\" is holding minus retiring. Positive means holding won.");
  console.log("  \"worst\" is the single worst trade in the paired set, so a mean can never be");
  console.log("  read without the tail that produced it. Both are inside their column's mean.\n");
  for (const { label, r } of rows) {
    const both = r.trades.filter((t) => t.live.resolved && t.hold.resolved);
    if (both.length === 0) continue;
    const wl = both.reduce((a, b) => (b.live.net < a.live.net ? b : a));
    const wh = both.reduce((a, b) => (b.hold.net < a.hold.net ? b : a));
    console.log(
      `  ${rowPrefix}${label.padEnd(lw)}  worst retiring: ${wl.coin} ${wl.live.reason} ${pc(wl.live.net)}` +
      `  ·  worst holding: ${wh.coin} ${wh.hold.reason} ${pc(wh.hold.net)}` +
      `  (that trade retired at ${pc(wh.live.net)})`,
    );
  }
  console.log("");

  for (const { label, r } of rows) {
    if (r.trades.length === 0) continue;
    const amb = r.trades.filter((t) => t.ambiguous).length;
    const reasons = (pick: (t: Trade) => string) => {
      const m = new Map<string, number>();
      for (const t of r.trades) m.set(pick(t), (m.get(pick(t)) ?? 0) + 1);
      return [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join("  ");
    };
    console.log(
      `  ${rowPrefix}${label.padEnd(lw)}  live exits: ${reasons((t) => t.live.reason).padEnd(42)}` +
      `holding: ${reasons((t) => t.hold.reason)}`,
    );
    console.log(
      `        still running: ${r.trades.filter((t) => !t.live.resolved).length} live / ` +
      `${r.trades.filter((t) => !t.hold.resolved).length} holding · ` +
      `${amb} candle(s) hit both, resolved to the stop · ` +
      `${r.noCandles} skipped for want of candles`,
    );
    // `tasks/46` §2.1 asks for this beside `noCandles`, and §2.3 for the re-entry count.
    // They are the two numbers that say how far this run sits from the one before them.
    console.log(
      `        ${r.staleAtFill} refused as stale at the fill (the live re-gate, §2.1) · ` +
      `${r.reentries} re-entry leg(s)`,
    );
    // The two coin-keyed refusals, printed as the desk counts them — one per poll per
    // series, with the distinct outlooks beside it (`tasks/50` §1.4).
    console.log(
      `        ${r.refusedAlreadyOpen} refused as already-open on the coin ` +
      `(${r.alreadyOpenOutlooks} outlook(s)) · ` +
      `${r.blockedAfterStop} refused by blockReentryAfterStop on coin+side ` +
      `(${r.blockedOutlooks} outlook(s))`,
    );
  }

  // ── Table 4: the daily-loss halt, which every row above is blind to ─────────
  //
  // Added 2026-09-12 to close the gap `notes/2026-09-11-…-capacity.md` §1.1 names: every
  // return in this file is computed on a desk that never stops trading. A halt removes a
  // day's WINNERS along with its losers, which no mean over per-signal returns can see —
  // and it is the objection to a wide stop, since `stopOutOfMandate` scales with
  // `stopPct × leverage`. See `haltWalk` for the model and its caveats.
  banner();
  console.log(`\nTable 4 — the daily-loss halt, modelled. ${pc(RISK_PARAMS.dailyLossPct)} of the day's opening`);
  console.log(`equity, marked to market, at ${pc(baseSettings.perSignalPct)} per signal. The halt stops new opens for`);
  console.log(`the rest of the UTC day; resting exits still fill.\n`);
  // The two right-hand columns are fractions of **different** denominators and were
  // formatted identically with no label: "mandate over the window" is every resolved
  // trade's return x position size, summed, compounding nothing; "worst day" is a
  // fraction of that day's own compounded opening equity. Reading them as the same unit
  // makes a bad day look like a small share of the window (`tasks/46` §1.3).
  console.log(`  ${(grid ? "cell" : sweptStop ? "stop" : holdHours ? "cap" : "σ").padEnd(lw)} │ one stop  halt is  │ days  halted  refused │  Σ over the window, % of  │ worst day,`);
  console.log(`${" ".repeat(lw + 3)}│ costs     N away    │                       │  mandate (no compounding) │ % of that`);
  console.log(`${" ".repeat(lw + 3)}│                     │                       │  no halt      with halt   │ day's equity`);
  console.log(`${"─".repeat(lw + 3)}┼─────────────────────┼───────────────────────┼───────────────────────────┼─────────────`);
  const haltRows: { label: string; w: ReturnType<typeof haltWalk>; armed: number; armedLev: number }[] = [];
  for (const { label, r } of rows) {
    const w = haltWalk(r.trades, {
      perSignalPct: baseSettings.perSignalPct,
      reserveFrac: RISK_PARAMS.reserveFrac,
      dailyLossPct: RISK_PARAMS.dailyLossPct,
      barMs: INTERVAL_MS[interval],
    });
    // The stop as ARMED, not as asked — the clamp is what decides this arithmetic. And
    // **the leverage the trades were entered at, not the one that was requested**: the
    // returns in this row all used `it.leverage` after `clampLeverage`, so multiplying
    // the clamped stop by the unclamped `baseSettings.leverage` printed a 20x stop cost
    // over 10x returns on any market that caps below the ask (`tasks/46` §1.3).
    const eff = r.trades.map((t) => t.effStopPct).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const armed = eff[eff.length >> 1] ?? 0;
    const levs = r.trades.map((t) => t.leverage).sort((a, b) => a - b);
    const armedLev = levs[levs.length >> 1] ?? baseSettings.leverage;
    const perStop = armed * armedLev * baseSettings.perSignalPct * (1 - RISK_PARAMS.reserveFrac);
    const mandate = (ts: readonly Trade[]) =>
      ts.filter((t) => t.live.resolved).reduce((a, t) => a + t.live.net, 0)
      * baseSettings.perSignalPct * (1 - RISK_PARAMS.reserveFrac);
    const worstDay = w.days.length === 0 ? 0 : Math.min(...w.days.map((d) => d.worstDrawdown));
    haltRows.push({ label, w, armed, armedLev });
    console.log(
      `  ${label.padEnd(lw)} │ ${pc(perStop).padStart(7)}  ${(perStop > 0 ? (RISK_PARAMS.dailyLossPct / perStop).toFixed(1) : "—").padStart(7)}    │ `
      + `${String(w.days.length).padStart(4)}  ${String(w.haltedDays).padStart(6)}  ${String(w.refused).padStart(7)} │ `
      + `${pc(mandate(r.trades)).padStart(8)}    ${pc(mandate(w.kept)).padStart(9)}     │ ${pc(worstDay).padStart(8)}`,
    );
  }
  console.log(`\n  "one stop costs" is stopOutOfMandate — the armed stop x the leverage the trades were`);
  console.log(`  entered at x perSignalPct x (1 - reserveFrac) — and "halt is N away" is ${pc(RISK_PARAMS.dailyLossPct)} divided`);
  console.log(`  by it, which is the count the connect screen shows. Arithmetic; it needs no sample.`);
  for (const { label, armed, armedLev } of haltRows) {
    if (armedLev === baseSettings.leverage) continue;
    console.log(`    ${rowPrefix}${label.padEnd(lw + 1)}armed ${pc(armed)} at ${armedLev}x, not the requested `
      + `${baseSettings.leverage}x — clampLeverage, and the returns in this row used ${armedLev}x too.`);
  }
  for (const { label, w } of haltRows) {
    const bad = w.days.filter((d) => d.halted);
    if (bad.length === 0) continue;
    console.log(`    ${rowPrefix}${label.padEnd(lw + 1)}halted on ${bad.map((d) => `${d.day} (${pc(d.worstDrawdown)}, ${d.refused} refused)`).join(", ")}`);
  }
  console.log(`\n  ⚠ The halt here is NOT sticky: it releases at the UTC roll, and on the real desk it`);
  console.log(`    needs a person (tasks/30) — five accounts sat halted for days in September. So`);
  console.log(`    every "with halt" figure is the BEST case, and a desk that halts twice has lost`);
  console.log(`    more trading days than this shows.`);
  // The calibration this table had never carried. The ~4x banner sits above Table 2 and
  // speaks of returns; the 2% stop default was argued on the worst-day column here, with
  // no caveat at all (`tasks/46` §1.3).
  console.log(`  ⚠ And the worst-day column reads ~${CALIBRATION.worstDay.ratio.toFixed(1)}x optimistic against ${CALIBRATION.worstDay.window}`);
  console.log(`    (measured ${CALIBRATION.worstDay.measuredOn}) — ${CALIBRATION.worstDay.why}.`);
  console.log(`    That is a different figure from the ~${(CALIBRATION.returns.modelled / CALIBRATION.returns.live).toFixed(1)}x on returns above (itself superseded ${CALIBRATION.returns.supersededOn}), measured on a`);
  console.log(`    window; neither is a correction factor to divide a row by.`);

  // ── Per-trade detail at the shipped gate, so the rows above are checkable ────
  const shipped = rows.find((x) => Math.abs(x.sigma - GATE.minDisplacementSigma) < 1e-9) ?? rows.at(-1);
  if (shipped && shipped.r.trades.length > 0) {
    banner();
    console.log(`\nEvery trade at ${grid ? `cell ${shipped.label}` : `σ${shipped.sigma.toFixed(1)}`} — the shipped gate:\n`);
    console.log("  opened            market        side   lev   live exit      net        holding exit    net");
    for (const t of [...shipped.r.trades].sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())) {
      const mark = (ok: boolean, v: number) => (ok ? pc(v).padStart(8) : "  running");
      console.log(
        `  ${t.openedAt.toISOString().slice(5, 16)}   ${t.coin.padEnd(13)} ${t.side.padEnd(6)} ${String(t.leverage).padStart(2)}x   ` +
        `${t.live.reason.padEnd(9)} ${mark(t.live.resolved, t.live.net)}   ${t.hold.reason.padEnd(9)} ${mark(t.hold.resolved, t.hold.net)}`,
      );
    }
    console.log("\n  \"running\" is a trade whose horizon has not passed yet. It is excluded from its");
    console.log("  column's mean rather than scored at the last candle, which would be fiction.");
  }

  console.log(`
  Read the σ${(rows[0]?.sigma ?? 1).toFixed(1)} row against the live ledger before believing any other row: if the
  simulator cannot reproduce trades that really happened, the rows below it are
  arithmetic on fiction. \`npm run expectancy\` prints the real ones.

  A stop is modelled as filling at its trigger, so every "holding" number is an
  upper bound — a real stop fires into the move already going against it. And the
  best σ here is a hypothesis for the next block of trades, never a result of this
  one; adopting it on the events that produced it is the flattery \`stop-sweep\`
  refuses on its own output.`);
}

// Guarded so `resolveSince` and `windowOf` can be imported by their test without the
// import calling Hyperliquid and printing a sweep — `expectancy.ts` and `exit-policy.ts`
// are guarded the same way and for the same reason.
if (import.meta.main) {
  await main();
}
