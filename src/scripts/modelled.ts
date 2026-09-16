import { BUILDER_FEE, RISK_PARAMS } from "../risk/params.ts";

// `tasks/46` §2.5 and `tasks/47` Rule 3: **one table of what is modelled, printed at the
// top of every run, and the same function a test reads.**
//
// Until 2026-09-13 every caveat these three scripts carry was a paragraph in a different
// place — `backtest.ts`'s six numbered "honesty rules" in a header comment nobody's
// terminal ever shows, `stop-sweep.ts`'s two carried-over bullets, `exit-policy.ts`'s
// four, and a scatter of `⚠` blocks printed under the tables they qualify. Three
// consequences, all of them observed:
//
//   · **A reader sees the table and not the comment.** The 2% stop default was argued on
//     `backtest`'s Table 4, which until 2026-09-12 printed no calibration at all
//     (`tasks/46` §1.3), while the caveat that would have qualified it sat at line 72 of
//     the source.
//   · **A caveat could be true of one script and quietly false of another.** The line
//     *"no stop has ever fired on this account, so there is no live evidence to price the
//     slippage with"* is still in `exit-policy.ts`'s header today; 107 have fired, and
//     `stop-sweep.ts` was corrected on 2026-09-12 while the file beside it was not.
//   · **Nothing could check any of it.** A prose bullet has no test. This function does,
//     and `modelled.test.ts` asserts against the constants rather than against the words.
//
// **What this table is not.** It is not a correction factor. Two calibrations exist —
// `CALIBRATION` in `backtest.ts`, on returns and on the worst-day column — and each is a
// ratio measured once on one window. This table says which *mechanisms* differ; those say
// how far the difference carried on one occasion. A row that reads `no` is a reason a
// number here is not a number from the ledger, and the replication row (`tasks/47` Rule 3)
// is what measures whether the total of them matters.

/** Whether this script does what the executor does. `partial` always carries the part
 *  that is missing in `how` — a `partial` whose clause does not name what is left out is
 *  a `yes` that has not been checked. */
export type Fidelity = "yes" | "no" | "partial";

export type ModelledRow = {
  /** The mechanism, named the way the executor's own code names it. */
  what: string;
  /** What the desk does. The thing being reproduced, in one clause. */
  executor: string;
  fidelity: Fidelity;
  /** What this script does about it, and — for `no` and `partial` — which direction the
   *  difference pushes a number. Never a bare "not modelled". */
  how: string;
};

export type ScriptName = "backtest" | "stop-sweep" | "exit-policy";

export type ModelledOpts = {
  /** `backtest`'s `--interval`. The row that names it must name the one in force, because
   *  the interval sets both the fill granularity and how far back the venue will serve
   *  (`candlesFor`'s row cap). */
  interval?: string;
  /** `backtest`'s re-entry model: on unless `--no-reentry`. */
  reentry?: boolean;
  /** `backtest`'s builder fee: charged unless `--no-builder-fee`. */
  builderFee?: boolean;
  /** `backtest`'s `MEASURED_ENTRY_SLIP_BPS` — **what an entry fill lands at**, which is
   *  not `RISK_PARAMS.slippageBps`, the price the order accepts. Passed in rather than
   *  imported because `backtest.ts` imports this file, and the measurement belongs beside
   *  the ledger query that produced it (`tasks/50` §1.1). */
  entrySlipBps?: number;
};

const bps = (x: number) => `${x}bps`;

/** The executor's side of every row. One source, so three scripts cannot describe the
 *  same desk three ways — which is exactly what happened to the stop-slippage line. */
const EXECUTOR = {
  entry: `IOC marketable limit at the mark ± ${bps(RISK_PARAMS.slippageBps)} (plan.ts:80)`,
  stop: `reduce-only trigger, limit ${bps(RISK_PARAMS.slippageBps)} past the trigger; CAN MISS (plan.ts:109)`,
  target: `reduce-only trigger limit, same band (plan.ts:118)`,
  fee: `venue taker, inclusive of the builder fee (fills.ts:133)`,
  funding: `charged to the isolated position's own margin; in net_pnl`,
  band: `${bps(RISK_PARAMS.slippageBps)}, four uses: entry, forced close, stop, target`,
  reentry: `after a retirement or a target, yes; after a stop, refused since 2026-09-11`,
  regate: `|liveσ| ≥ ${RISK_PARAMS.minDisplacementSigma} against the live mark AND sign agrees (loop.ts:373)`,
  halt: `${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% of the day's opening equity, marked to market, STICKY — it needs a person (tasks/30)`,
  interval: `60s tick; the recorder's median poll gap is 30.3 min, so a retirement is marked up to ~25 min late`,
} as const;

/** What each script does, as of the commit that last touched it.
 *
 *  **Every `no` here is a task or a decision, not an oversight**, and the clause says
 *  which. A row that becomes `yes` is a change to this table in the same commit as the
 *  change to the script — the rule `FEED_REGIMES` states for regimes, applied to fidelity. */
export function modelled(script: ScriptName, opts: ModelledOpts = {}): ModelledRow[] {
  const interval = opts.interval ?? "5m";
  const row = (what: string, executor: string, fidelity: Fidelity, how: string): ModelledRow =>
    ({ what, executor, fidelity, how });

  if (script === "backtest") {
    const reentry = opts.reentry ?? false;
    const builderFee = opts.builderFee ?? false;
    // What the entry fill is charged. `undefined` means the caller did not say — the row
    // then describes the mechanism without inventing a magnitude, because the one number
    // that must never appear here by default is the accept band (`tasks/50` §1.1).
    const slip = opts.entrySlipBps === undefined ? null : bps(opts.entrySlipBps);
    return [
      row("entry", EXECUTOR.entry, "partial",
        `plans on the last close at or before the poll, fills at the NEXT ${interval} candle's open`
        + (slip === null
          ? ", charged the measured entry slippage rather than the accept band"
          : `, charged ${slip} — what fills MEASURE against the planning mark, not the ${bps(RISK_PARAMS.slippageBps)} the order accepts`)),
      row("stop", EXECUTOR.stop, "partial",
        "fills AT the trigger. A stop that misses is not modelled and cannot be — intra-bar order is unknowable at any interval the venue serves"),
      row("target", EXECUTOR.target, "yes",
        "fills at the trigger, which the six live take-profits beat by 3–6bps"),
      row("fee", EXECUTOR.fee, builderFee ? "yes" : "partial",
        builderFee
          ? `taker both legs, plus ${BUILDER_FEE.tenthsBp} tenths of a bp per order`
          : `taker both legs; the builder fee is NOT charged, so every row flatters the cohort that pays it (${BUILDER_FEE.tenthsBp} tenths of a bp per order)`),
      row("funding", EXECUTOR.funding, "no",
        "bounded by measurement rather than assumed away: $0.0126 against $0.4579 of fees across the live ledger"),
      row("band", EXECUTOR.band, "partial",
        "charged on the entry and on a forced close, both of which cross the spread, "
        + (slip === null ? "at the measured entry slippage" : `at ${slip} and not at the ${bps(RISK_PARAMS.slippageBps)} accept band`)
        + " — the forced-close leg is UNMEASURED and carries the entry figure; NOT charged on a stop or target trigger, where modelling the fill would need intra-bar data no interval the venue serves supplies"),
      row("re-entry", EXECUTOR.reentry, reentry ? "partial" : "no",
        reentry
          ? "re-opened whenever the outlook is live and no intent holds THAT COIN — `hasLiveIntentOn`, so a second outlook on a held market is refused and a TARGET re-enters without the feed changing; blockReentryAfterStop then spends that coin AND SIDE for the UTC day, keyed as stoppedOutToday keys it. What is left: the walk uses the live policy's close for both columns, so the holding column's book is the live one's"
          : "--no-reentry: ONE trade per stable outlook id, ever — stronger than blockReentryAfterStop, and it removes 73 of 220 real pairs. This is not the desk"),
      row("re-gate", EXECUTOR.regate, "yes",
        "liveDisplacementSigma against the FILL, on magnitude and on sign, exactly as loop.ts does against the mark it is about to trade at; refusals counted as stale-at-fill"),
      row("halt", EXECUTOR.halt, "partial",
        "Table 4 only, and it releases at the UTC roll — so every \"with halt\" figure is the best case"),
      row("interval", EXECUTOR.interval, "partial",
        `${interval} candles; a retirement lands at the poll's candle close, which is earlier than the desk's next tick`),
    ];
  }

  if (script === "stop-sweep") {
    return [
      row("entry", EXECUTOR.entry, "yes", "the real fill, off the ledger's own intent row"),
      row("stop", EXECUTOR.stop, "partial",
        "re-derived from ref_px and filled AT the trigger. 107 live sl fills came a mean of 3.3bps past it, worst 30.1 — and a miss appears nowhere"),
      row("target", EXECUTOR.target, "yes", "the real target_px, unchanged; a target-first trade is left exactly as it ended"),
      row("fee", EXECUTOR.fee, "partial", "takerRate on both legs for the modelled close; the real trip's settled fees are in net_pnl"),
      row("funding", EXECUTOR.funding, "yes", "the real trip's funding is in net_pnl and the counterfactual does not extend the hold"),
      row("band", EXECUTOR.band, "no", "the modelled stop fills at its trigger, so the band is neither charged nor able to miss"),
      row("re-entry", EXECUTOR.reentry, "partial",
        "the `chain` column prices what followed a real stop; the modelled stop ends the trade and stops thinking (tasks/42)"),
      row("re-gate", EXECUTOR.regate, "yes", "every trade here really opened, so it cleared both gates at the time"),
      row("halt", EXECUTOR.halt, "no",
        "a modelled stop can push an account past the daily loss and this sweep keeps trading it — which flatters a TIGHT stop most"),
      row("interval", EXECUTOR.interval, "yes",
        "no candles at all: the price path is summarised onto the intent row at close (cf_mae_to_target_px), so the sample stops decaying"),
    ];
  }

  return [
    row("entry", EXECUTOR.entry, "yes", "the real fill; entry, size and leverage are untouched"),
    row("stop", EXECUTOR.stop, "partial",
      "fills at stop_px. 107 live sl fills came a mean of 3.3bps past it, worst 30.1 — so every \"holding was better\" line is an upper bound"),
    row("target", EXECUTOR.target, "yes", "fills at target_px, which the six live take-profits beat by 3–6bps"),
    row("fee", EXECUTOR.fee, "yes", "the trip's own settled fees, unchanged — only the exit PRICE moves"),
    row("funding", EXECUTOR.funding, "no",
      "the extra holding time is unfunded here; bounded at $0.0126 against $0.4579 of fees"),
    row("band", EXECUTOR.band, "no", "both modelled exits fill at their level, so neither the band nor a miss is priced"),
    row("re-entry", EXECUTOR.reentry, "no", "one closed trip, held longer. What the desk did next is stop-sweep's `chain` column"),
    row("re-gate", EXECUTOR.regate, "yes", "every trade here really opened"),
    row("halt", EXECUTOR.halt, "no", "a longer hold can cross the daily loss and this replay does not stop"),
    row("interval", EXECUTOR.interval, "partial",
      "1m candles, the finest HL serves — which reach 3.5 days, so the sample shrinks as trades age"),
  ];
}

const MARK: Record<Fidelity, string> = { yes: "yes    ", no: "NO     ", partial: "partial" };

/** The table, as the block it prints. One column of `how` wrapped to the terminal, because
 *  the clause is the part that is load-bearing and a truncated one is worse than none. */
export function modelledTable(script: ScriptName, opts: ModelledOpts = {}): string {
  const rows = modelled(script, opts);
  const w = Math.max(...rows.map((r) => r.what.length));
  const out: string[] = [
    `what \`npm run ${script}\` models, and what it does not (tasks/46 §2.5):`,
    "",
  ];
  for (const r of rows) {
    out.push(`  ${r.what.padEnd(w)}  ${MARK[r.fidelity]}  ${r.how}`);
    out.push(`  ${" ".repeat(w)}           desk: ${r.executor}`);
  }
  const no = rows.filter((r) => r.fidelity === "no").length;
  const partial = rows.filter((r) => r.fidelity === "partial").length;
  out.push("");
  out.push(
    `  ${rows.length - no - partial} of ${rows.length} reproduced, ${partial} partial, ${no} not. ` +
    "This table says WHICH mechanisms differ; it is not a correction",
  );
  out.push("  factor — two errors of opposite sign cancel in any total.");
  // The two counterfactual scripts have no replication row and must not imply one. Every
  // trade they replay really happened, so what is modelled is the **exit** they did not
  // take; `backtest` invents the entries as well, which is what Rule 3's check is for.
  out.push(script === "backtest"
    ? "  Whether the total still agrees with the ledger is the replication row below (tasks/47 Rule 3)."
    : "  Every trade below really opened — what is modelled here is the exit it did not take — so the\n" +
      "  replication check that `npm run backtest` prints does not apply and is not implied.");
  return out.join("\n");
}
