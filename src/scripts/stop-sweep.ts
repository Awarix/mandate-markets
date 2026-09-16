import "dotenv/config";
import { excludeSyntheticSql, syntheticNote } from "../store/synthetic.ts";
import { join } from "node:path";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { stopsToHalt } from "../risk/halt.ts";
import { Store } from "../store/db.ts";
import { stopWouldFire } from "../exec/counterfactual.ts";
import { resolveSince, takerRate } from "./backtest.ts";
import { modelledTable } from "./modelled.ts";

// What a tighter stop would have done — over the window each trade was actually held.
//
//   npm run stop-sweep                 # 1.0% … 3.0%
//   npm run stop-sweep -- --levels 1.5
//   npm run stop-sweep -- --levels 0.5,0.75,1,1.5,2,3
//   npm run stop-sweep -- --since sigma0.5 --until sigma1.0     # one gate, by name
//
// `npm run exit-policy` asked what happens *after* we leave. This asks the opposite:
// **holding the exit policy we actually run, what if the stop had been closer?** The
// two questions have opposite shapes and neither answers the other — a retirement exit
// only matters if the position survives to be retired, and a tighter stop is exactly
// what stops it surviving.
//
// The user's stop is `stopPct` — **2% since 2026-09-12**, 3% until 09-10 and 1% for the
// two days between — applied to the mark at plan time and multiplied by leverage to
// reach margin: 2% x 10x is 20% of margin, where 3% x 10x was the 30%
// `notes/2026-09-02-exit-policy-counterfactual.md` found was being risked to make 8.
// The question is what a tighter stop costs on the other side, because a stop close
// enough to cap the losers is close enough to catch the winners on the way up.
//
// **The leverage is the account's, not 10x.** The ledger runs 5x, 10x and 20x, so every
// "of margin" figure below is per-row rather than a canonical account's, and the summary
// column says so.
//
// ── What is modelled, and what is not ───────────────────────────────────────────
//
// Each trade is replayed across **the window it was really held** — first fill to last
// fill — against its own target and a re-derived stop. First touch wins:
//
//   · **stop first** — the trade ends there instead of where it really ended. This is
//     the only case that changes anything.
//   · **target first** — unchanged. The real take-profit fired and the tighter stop
//     never came into it.
//   · **neither** — unchanged. It ends where it really ended, at the price it really
//     got, whatever closed it.
//
// The stop is derived from `ref_px` because that is what the executor uses
// (`computeExitPrices(markPx, …)`, and `ref_px` is that mark: measured 2.995–2.999%
// against a requested 3.00% on every closed intent). **Sizing does not move.** Size is
// notional-first from the mandate — `margin × leverage / price` — so `stopPct` changes
// where the exit sits and never how much is bought. That is what makes this a clean
// one-variable counterfactual rather than a different strategy.
//
// Carried over from `exit-policy.ts`, and both still bias the same way:
//
//   · **A stop is modelled as filling at its trigger**, and there is now live evidence
//     about what that costs. 107 `sl` fills on `data/snap-0912.sqlite` filled a mean of
//     **3.3 bps worse than their trigger price, worst 30.1 bps** — the worst case being
//     exactly `RISK_PARAMS.slippageBps`, i.e. the limit sitting at the band edge and
//     filling there. (The claim here until 2026-09-12 was that no stop had ever fired;
//     87 fired on 09-11 alone.) So the flattery is small where the stop fills — but the
//     stop is a stop-LIMIT with a 30bps band and **can miss entirely**, which is what
//     the 09-10 COPPER liquidation was, and a miss appears in none of these numbers.
//     Every "the tighter stop saved money" figure is still an **upper bound**, and a
//     tighter stop is hit more often, so the flattery compounds with tightness. Read
//     the direction, not the magnitude.
//   · A candle touching both levels is resolved to the stop.
//
// ── Where the price path comes from ─────────────────────────────────────────────
//
// **Not from Hyperliquid, any more.** Until 2026-09-10 this fetched one
// `candleSnapshot` per closed trade, unpaced, with no error handling — which tripped the
// rate limiter and killed four of five runs at 207 intents on 2026-09-09, and which was
// going to keep getting worse because the ledger only grows. Worse, it was answering a
// question that was quietly shrinking: 1m candles reach 3.5 days, so a trade older than
// that had no path left to read and simply fell out of the sample.
//
// The path is now summarised once when the trade closes and kept on its intent row
// (`src/exec/counterfactual.ts`, `tasks/31` §5). `cf_mae_to_target_px` is the worst price
// the position saw before its target was first touched, which is exactly the number
// `replay`'s first-touch rule needs, for every stop level, from one pass. So this script
// makes **no network calls at all** and its sample stops decaying.
//
// A trade with no summary is **left out and counted**, never treated as unstopped: "we
// never looked" and "no stop fired" push a sweep in opposite directions. Run
// `npm run counterfactuals` to fill them in.
//
// ── ⚠ What this sweep assumes about what happens next (`tasks/42`) ──────────────
//
// **When a modelled stop fires, this script ends the trade there and stops thinking.**
// That is a model of the world, it was never stated, and until 2026-09-11 it was the
// wrong one: `loop.ts` guarded only against a *live* intent, so a stopped-out position
// **reopened on the next tick** if the call was still in the feed — which it usually is,
// because a stop firing is a statement about price and the outlook does not know it
// happened. So every number this script printed was answering a question about a desk
// that re-entered, with a model that did not.
//
// `--reentry chain` is that second world, modelled explicitly, and the arithmetic in it
// is worth reading before the table:
//
//   Stop at `P(1−f)`, re-enter there, stop again at `P(1−f)²`, and so on. Each stop
//   loses exactly the gap to the next entry, and the last leg runs from the final entry
//   to wherever the trade really ended. **The gaps telescope**: the total price P&L is
//   `exit − P`, which is the P&L of never having been stopped at all. Under this model a
//   tighter stop changes **nothing but fees**.
//
// Two things follow, and they point in opposite directions.
//
//   1. **The benefit of tightening in the `none` column is an artefact of the model.** It
//      banks a loss avoided at the stop and never charges for the fact that we went and
//      took that loss anyway on the next tick.
//   2. **The ledger is much worse than the telescoping predicts.** Real post-stop
//      re-entries returned **−6.31% of margin** over 50 trips, against +0.24% after a
//      `retired` close — far past what fees explain. The difference is the part the
//      identity cannot see: we re-enter at the *next tick's mark* rather than at the stop
//      level, up to a loop interval later, and the stop itself fills into the move.
//
// **So `--reentry chain` is a floor on the damage, not an estimate of it**, and the two
// columns bracket the truth: `none` is the desk with `blockReentryAfterStop` on, `chain`
// is the same desk with it off and every re-entry priced at its best possible case.
//
// **Which makes the headline result of `tasks/42` this:** `none` was always a model of a
// desk that refuses to re-enter, and shipping the block is what makes it true. The 1%
// default was decided on the `none` column while the desk ran the `chain` one.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

/** The levels swept when none is named. **The shipped default is always among them**,
 *  derived rather than typed, so the report reproduces today's ledger as its own
 *  control row on the day the default moves as well as on every other day. It was a
 *  literal `3.0` until 2026-09-12, by which time the default was 2% and the sweep
 *  marked the wrong row "today" (`tasks/46` §1.2). */
export const SWEEP = [...new Set([1.0, 1.5, 2.0, 2.5, 3.0, DEFAULT_USER_SETTINGS.stopPct * 100])]
  .sort((a, b) => a - b);

type Row = {
  intent_id: string; signal_ref: string; coin: string; side: string; leverage: number;
  ref_px: number; target_px: number | null; stop_px: number | null;
  margin_usd: number; filled_sz: number; net_pnl: number | null; exit_px: number | null;
  close_reason: string | null; created_at: string; cf_at: string | null; cf_interval: string | null;
  cf_mae_px: number | null; cf_mae_to_target_px: number | null;
};

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Per distinct signal, the mean return on margin — one Quotient outlook is one event
 *  however many accounts traded it, as `npm run expectancy` counts. */
function perSignal(rows: { signal_ref: string; net: number; margin: number }[]): number[] {
  const by = new Map<string, number[]>();
  for (const r of rows) by.set(r.signal_ref, [...(by.get(r.signal_ref) ?? []), r.net / r.margin]);
  return [...by.values()].map(mean);
}

/** How many times a stop at `frac` fires on one trade when every stop is followed by a
 *  re-entry at the stop level — the pre-`tasks/42` behaviour.
 *
 *  Each re-entry resets the reference, so the levels are `P(1−f)^k` for a long and
 *  `P(1+f)^k` for a short, and the count is how many of them the path's worst price got
 *  through. Closed form rather than a loop, and `Math.floor` is what makes it a **lower
 *  bound**: the path is assumed to descend to its worst price once. A path that zig-zags
 *  — down, back up past a re-entry, down again — fires more stops than its total
 *  excursion implies, and one 5m candle cannot tell the two apart.
 *
 *  Returns 0 when the stop never fires, and never a negative count. */
export function stopFirings(side: string, refPx: number, frac: number, maeToTargetPx: number | null): number {
  if (maeToTargetPx === null || !(refPx > 0) || !(maeToTargetPx > 0) || !(frac > 0) || frac >= 1) return 0;
  // The executor's own levels: `computeExitPrices` puts a long's stop at `ref × (1 − f)`
  // and a short's at `ref × (1 + f)`, so re-entering at each one compounds in the same
  // direction. A short is **not** the long formula inverted — `1/(1 − f)` is 1.0101 at
  // f = 1%, and the venue would be holding a stop at 1.0100.
  const step = side === "long" ? 1 - frac : 1 + frac;
  const k = Math.log(maeToTargetPx / refPx) / Math.log(step);
  // `stopWouldFire` treats a level the path touched exactly as fired, and so must this:
  // at ref 100, f = 1%, mae 99.00 the division is 1 in exact arithmetic and can land a
  // few ulps under it in binary. The epsilon is far below any price ratio that matters.
  return Number.isFinite(k) ? Math.max(0, Math.floor(k + 1e-9)) : 0;
}

/** The extra cost of one avoidable round trip: a taker exit and a taker entry on the
 *  position's own notional. `margin × leverage` is the notional, because sizing is
 *  notional-first from the mandate. HIP-3 markets pay 0.2× the native schedule, measured
 *  from real fills (`notes/2026-09-02-fill-truth-findings.md`). */
function roundTripCost(coin: string, marginUsd: number, leverage: number): number {
  return 2 * takerRate(coin.includes(":") ? coin.split(":")[0]! : "") * marginUsd * leverage;
}

async function main(): Promise<void> {
  // No network line: this reads the ledger and nothing else now.
  console.log(`ledger: ${LEDGER}`);
  console.log(syntheticNote());

  // `--levels` rather than a bare positional: once `--since sigma0.5` exists, a
  // positional finder that takes the first argument not starting with "-" swallows the
  // flag's *value* and sweeps a stop of NaN. The old bare form still works for a single
  // number, which is what anyone has typed until now.
  const argv = process.argv.slice(2);
  const flag = (k: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const flagValues = new Set(["--levels", "--since", "--until"].map(flag).filter((v): v is string => v !== undefined));
  const bare = argv.find((a) => !a.startsWith("-") && !flagValues.has(a));
  const levels = (flag("--levels") ?? bare ?? SWEEP.join(",")).split(",").map(Number);
  if (levels.some((l) => !Number.isFinite(l) || l <= 0 || l > 20)) {
    console.log("  A stop percentage is a number of percent, e.g. 1.5.");
    process.exitCode = 1;
    return;
  }

  // `tasks/31` §3.5: a fixed-percentage stop is effectively tighter when the feed's own
  // sigma is higher, so a sweep pooled across regimes answers about a market that does
  // not exist. Both bounds take a regime name, because the windows worth isolating are
  // exactly the boundaries `FEED_REGIMES` already argues and a name cannot be mistyped
  // into a window off by a day. `--until` is **exclusive** and names the regime that
  // *ends* the window, matching the inclusive-left convention `regimeAt` uses.
  let sinceMs = -Infinity, untilMs = Infinity;
  try {
    const since = flag("--since"), until = flag("--until");
    if (since !== undefined) sinceMs = resolveSince(since);
    if (until !== undefined) untilMs = resolveSince(until);
  } catch (e) {
    console.log(`  ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }
  if (sinceMs >= untilMs) {
    console.log("  --since is at or after --until: that window holds no trades.");
    process.exitCode = 1;
    return;
  }

  const store = new Store(LEDGER, { readOnly: true });

  const all = store.db.prepare(
    "SELECT i.intent_id, i.signal_ref, i.coin, i.side, i.leverage, i.ref_px, i.target_px, i.stop_px, " +
    "       i.margin_usd, i.filled_sz, i.net_pnl, i.close_reason, i.created_at, x.exit_px, " +
    "       i.cf_at, i.cf_interval, i.cf_mae_px, i.cf_mae_to_target_px " +
    "FROM intents i " +
    "LEFT JOIN (SELECT intent_id, SUM(px * sz) / SUM(sz) AS exit_px FROM fills " +
    "      WHERE intent_id IS NOT NULL AND (dir LIKE 'Close%' OR dir LIKE 'Liquidat%') " +
    "      GROUP BY intent_id) x ON x.intent_id = i.intent_id " +
    `WHERE i.status = 'closed' AND i.net_pnl IS NOT NULL AND x.exit_px IS NOT NULL ` +
    `  AND ${excludeSyntheticSql("i.intent_id")} ` +
    "ORDER BY i.intent_id",
  ).all() as unknown as Row[];

  // A trade with no stored path is dropped from the whole report, control row included,
  // so every number below rests on the same set. Counting it as "no stop fired" would
  // be the silent version of this and would flatter every level.
  const inWindow = all.filter((r) => {
    const t = Date.parse(r.created_at);
    return t >= sinceMs && t < untilMs;
  });
  const rows = inWindow.filter((r) => r.cf_mae_to_target_px !== null);
  const unsummarised = inWindow.filter((r) => r.cf_at === null).length;
  const blank = inWindow.length - rows.length - unsummarised;

  const windowLabel = sinceMs === -Infinity && untilMs === Infinity
    ? "the whole ledger"
    : `${sinceMs === -Infinity ? "the start" : new Date(sinceMs).toISOString()} → ${untilMs === Infinity ? "now" : new Date(untilMs).toISOString()}`;
  console.log(`window: ${windowLabel}`);
  console.log(`\n${rows.length} closed trades with a settled P&L, a venue exit price and a stored path.`);
  if (unsummarised > 0) {
    console.log(`  ${unsummarised} more have no stored path yet — run \`npm run counterfactuals\` and re-read this.`);
  }
  if (blank > 0) {
    console.log(`  ${blank} were summarised after their candles had aged out and can never be replayed.`);
  }
  const coarse = rows.filter((r) => r.cf_interval !== "1m").length;
  if (coarse > 0) {
    console.log(`  ${coarse} rest on 5m candles: exact about how far a trade went against us, coarser about when.`);
  }
  console.log("");

  // `tasks/46` §2.5. The bullets this replaces sat in the header comment, where the
  // reader of a table never sees them — and one of them was wrong for two days
  // ("no stop has ever fired") while the file beside it had been corrected.
  console.log(modelledTable("stop-sweep"));
  console.log("");

  const base = rows.map((r) => ({ signal_ref: r.signal_ref, net: r.net_pnl as number, margin: r.margin_usd }));
  const baseDollars = base.reduce((t, x) => t + x.net, 0);
  const baseEvents = perSignal(base);

  console.log("    stop    of margin*  stopped   dollars    per signal   worst signal   stops to halt**");
  console.log("    " + "─".repeat(86));

  type Detail = { level: number; changed: { r: Row; from: number; to: number }[] };
  const details: Detail[] = [];
  // `--reentry chain` rows, computed in the same pass so the two tables rest on one set.
  const chain: { level: number; dollars: number; events: number[]; firings: number; worst: number }[] = [];

  for (const level of levels) {
    const frac = level / 100;
    const changed: { r: Row; from: number; to: number }[] = [];
    let firings = 0;
    const chainOut: { signal_ref: string; net: number; margin: number }[] = [];
    const out = rows.map((r) => {
      const signed = r.side === "long" ? r.filled_sz : -r.filled_sz;
      const tighter = r.side === "long" ? r.ref_px * (1 - frac) : r.ref_px * (1 + frac);
      // The chain world: every stop is followed by a re-entry at the stop level, so the
      // price legs telescope to the unstopped P&L and only the extra round trips cost
      // anything. `k` is a lower bound on the firings — see `stopFirings`.
      const k = stopFirings(r.side, r.ref_px, frac, r.cf_mae_to_target_px);
      firings += k;
      chainOut.push({
        signal_ref: r.signal_ref,
        net: (r.net_pnl as number) - k * roundTripCost(r.coin, r.margin_usd, r.leverage),
        margin: r.margin_usd,
      });
      // Only a stop that fired first changes the trade. A target that fired first, or
      // a path that touched neither, ends exactly where it really ended.
      if (stopWouldFire(r.side, tighter, r.cf_mae_to_target_px) !== true) {
        return { signal_ref: r.signal_ref, net: r.net_pnl as number, margin: r.margin_usd };
      }
      const net = (r.net_pnl as number) + (tighter - (r.exit_px as number)) * signed;
      changed.push({ r, from: r.net_pnl as number, to: net });
      return { signal_ref: r.signal_ref, net, margin: r.margin_usd };
    });
    details.push({ level, changed });
    const chainEvents = perSignal(chainOut);
    chain.push({
      level, dollars: chainOut.reduce((t, x) => t + x.net, 0), events: chainEvents,
      firings, worst: Math.min(...chainEvents),
    });

    const events = perSignal(out);
    const dollars = out.reduce((t, x) => t + x.net, 0);
    // **What this stop costs as margin, at the leverage each row actually ran.** It was
    // `frac × 10` — a literal 10x over a population that is 5x, 10x and 20x — until
    // 2026-09-12 (`tasks/46` §1.2). The mean is over trips, so it is a description of
    // the sample and not a claim about any account.
    const ofMargin = mean(rows.map((r) => frac * r.leverage));
    // How many stopped signals it takes to reach the daily-loss halt, **at the default
    // settings** — the accounts on the box do not all run them, and one runs
    // `perSignalPct: 0.2`, which is why it trips the config warning today. A tighter
    // stop loses less per signal, so the halt sits further away: the same knob moving
    // a second protection, in the direction nobody looks at.
    //
    // `stopsToHalt` rather than the multiplication, since 2026-09-12: this recomputed it
    // without `(1 − reserveFrac)` and without `stopOutOfMargin`'s `min(1, …)` cap, so it
    // printed 5.0 where the connect screen printed 5.05 and 160% where the desk says
    // 100%. One function, so the two cannot drift apart again.
    const toHalt = stopsToHalt({ ...DEFAULT_USER_SETTINGS, stopPct: frac });
    const isDefault = Math.abs(frac - DEFAULT_USER_SETTINGS.stopPct) < 1e-9;
    console.log(
      `    ${level.toFixed(1)}%   ${pct(ofMargin).padStart(8)}   ${String(changed.length).padStart(4)}/${rows.length}` +
      `   ${(dollars >= 0 ? "+" : "") + dollars.toFixed(2).padStart(6)}` +
      `   ${pct(mean(events)).padStart(9)}` +
      `   ${pct(Math.min(...events)).padStart(10)}` +
      `   ${toHalt.toFixed(1).padStart(10)}${isDefault ? "   ← today" : ""}`,
    );
  }

  const levs = [...new Set(rows.map((r) => r.leverage))].sort((a, b) => a - b);
  console.log(
    `\n    control: today's ledger is ${(baseDollars >= 0 ? "+" : "") + baseDollars.toFixed(2)}, ` +
    `${pct(mean(baseEvents))} per signal over ${baseEvents.length} distinct signals.\n` +
    `    *  the stop as margin at each row's OWN leverage, meaned over ${rows.length} trips ` +
    `(${levs.map((l) => `${l}x`).join(", ")}).\n` +
    `       The MAE table below prints the price and margin pair per trade, which is the\n` +
    `       unmeaned version of the same thing.\n` +
    `    ** stopped signals to reach the ${pct(RISK_PARAMS.dailyLossPct)} daily-loss halt, from stopsToHalt at the\n` +
    `       default ${DEFAULT_USER_SETTINGS.leverage}x / ${pct(DEFAULT_USER_SETTINGS.perSignalPct)} per signal ` +
    `— the same function the connect screen shows.\n` +
    `    "← today" marks ${pct(DEFAULT_USER_SETTINGS.stopPct)}, DEFAULT_USER_SETTINGS.stopPct, which the sweep always includes.`,
  );

  // ── the same levels, with re-entry (`tasks/42`) ──────────────────────────────
  //
  // The table above ends a trade at its stop. That is the desk **with**
  // `RISK_PARAMS.blockReentryAfterStop`, and until 2026-09-11 the desk did not have it.
  // This is the other world: each stop is followed by a re-entry at the stop level, the
  // price legs telescope to the unstopped P&L, and the only cost left is the round trips.
  console.log("\n\n    the same levels with re-entry — every stop followed by a re-entry at the stop\n");
  console.log("    stop    firings   dollars    per signal   worst signal   vs. no re-entry");
  console.log("    " + "─".repeat(76));
  for (let i = 0; i < levels.length; i++) {
    const c = chain[i]!;
    const noReentry = details[i]!;
    // What the row above this one printed, recomputed rather than remembered.
    const nr = rows.map((r) => {
      const hit = noReentry.changed.find((x) => x.r.intent_id === r.intent_id);
      return { signal_ref: r.signal_ref, net: hit ? hit.to : (r.net_pnl as number), margin: r.margin_usd };
    });
    const gap = mean(c.events) - mean(perSignal(nr));
    console.log(
      `    ${c.level.toFixed(1)}%   ${String(c.firings).padStart(5)}   ` +
      `${(c.dollars >= 0 ? "+" : "") + c.dollars.toFixed(2).padStart(6)}` +
      `   ${pct(mean(c.events)).padStart(9)}` +
      `   ${pct(c.worst).padStart(10)}` +
      `   ${(gap >= 0 ? "+" : "") + pct(gap).padStart(8)}`,
    );
  }
  console.log(
    "\n    ⚠ Read the last column, not the dollars. It is how much of the tighter stop's\n" +
    "    apparent benefit survives once the desk gets back in — and under the telescoping\n" +
    "    identity it survives as fees alone, so a large figure there means the column above\n" +
    "    was crediting a loss that was taken anyway on the next tick.\n" +
    "    ⚠ `firings` is a LOWER bound: a path that zig-zags fires more stops than its total\n" +
    "    excursion implies, and the ledger agrees — real post-stop re-entries returned\n" +
    "    −6.31% of margin over 50 trips, far past what these fees explain. The two tables\n" +
    `    bracket the truth; neither is it. \`blockReentryAfterStop\` is ${RISK_PARAMS.blockReentryAfterStop}, so the\n` +
    `    ${RISK_PARAMS.blockReentryAfterStop ? "first" : "second"} table is the desk you are running.`,
  );

  // Which trades each level actually touches — the whole answer is in the names, not
  // the average, when the sample is this small.
  for (const d of details) {
    if (d.changed.length === 0) { console.log(`\n    ${d.level.toFixed(1)}% — no trade was stopped.`); continue; }
    console.log(`\n    ${d.level.toFixed(1)}% stops ${d.changed.length} trade(s):`);
    for (const c of d.changed.sort((a, b) => (a.to - a.from) - (b.to - b.from))) {
      const delta = c.to - c.from;
      console.log(
        `      ${c.r.intent_id.slice(0, 8)}  ${c.r.coin.padEnd(13)} ${c.r.side.padEnd(5)} ` +
        `really closed on ${String(c.r.close_reason).padEnd(9)} ` +
        `${c.from.toFixed(2).padStart(6)} → ${c.to.toFixed(2).padStart(6)}   ` +
        `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`,
      );
    }
  }

  // ── maximum adverse excursion ───────────────────────────────────────────────
  //
  // The sweep answers "what would 1.5% have done" on the trades we happen to have.
  // This answers the more durable question: **how close did each trade come to being
  // stopped out before it worked?** A stop level is safe for a trade if it sits
  // outside that trade's worst drawdown, and the whole table is readable at a glance
  // without re-running anything when a new level is proposed.
  console.log("\n\n    worst drawdown from entry, before the trade ended  (a stop inside this fires)\n");
  console.log("    trade      coin          side   closed on   MAE price   MAE margin   net");
  const mae = rows.map((r) => {
    // Read, not computed: `cf_mae_px` is the worst price the position saw against it over
    // the window it was held, summarised when it closed.
    const worst = r.cf_mae_px;
    const excursion = worst === null ? null
      : (r.side === "long" ? (r.ref_px - worst) / r.ref_px : (worst - r.ref_px) / r.ref_px);
    return { r, excursion };
  });
  for (const m of mae.sort((a, b) => (b.excursion ?? -1) - (a.excursion ?? -1))) {
    const e = m.excursion;
    console.log(
      `    ${m.r.intent_id.slice(0, 8)}  ${m.r.coin.padEnd(13)} ${m.r.side.padEnd(5)}  ` +
      `${String(m.r.close_reason).padEnd(10)}  ${e === null ? "     —" : pct(e).padStart(6)}      ` +
      `${e === null ? "     —" : pct(e * m.r.leverage).padStart(6)}   ` +
      `${(m.r.net_pnl as number).toFixed(2).padStart(6)}`,
    );
  }
  // ── the dip distribution ────────────────────────────────────────────────────
  //
  // The per-trade table above is the evidence; this is the thing a stop level is chosen
  // against. Split by outcome, because the two distributions answer different halves of
  // the question: a stop must sit **outside** the winners' dips or it converts them into
  // losses, and it only pays where it sits **inside** the losers'. Where those two
  // overlap is where a stop level is a genuine trade-off rather than a free lunch.
  const q = (xs: number[], p: number) =>
    xs.length === 0 ? NaN : xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))]!;
  const dips = (sel: (m: { r: Row; excursion: number | null }) => boolean) =>
    mae.filter((m) => m.excursion !== null && sel(m)).map((m) => m.excursion as number);
  const won = dips((m) => (m.r.net_pnl as number) > 0);
  const lost = dips((m) => (m.r.net_pnl as number) <= 0);
  console.log("\n\n    how far trades dipped against us, by how they ended\n");
  console.log(`    ${"".padEnd(9)}${"n".padStart(4)}   ${"median".padStart(7)}${"p75".padStart(8)}${"p90".padStart(8)}${"worst".padStart(8)}`);
  for (const [label, xs] of [["winners", won], ["losers", lost]] as [string, number[]][]) {
    if (xs.length === 0) continue;
    console.log(
      `    ${label.padEnd(9)}${String(xs.length).padStart(4)}   ${pct(q(xs, 0.5)).padStart(7)}` +
      `${pct(q(xs, 0.75)).padStart(8)}${pct(q(xs, 0.9)).padStart(8)}${pct(Math.max(...xs)).padStart(8)}`,
    );
  }
  console.log("\n    what each level would catch, and what it would cost\n");
  console.log(`    ${"stop".padEnd(8)}${"losers caught".padStart(14)}${"winners killed".padStart(16)}`);
  for (const level of levels) {
    const frac = level / 100;
    const caught = lost.filter((x) => x >= frac).length;
    const killed = won.filter((x) => x >= frac).length;
    console.log(
      `    ${`${level.toFixed(2)}%`.padEnd(8)}${`${caught}/${lost.length}`.padStart(14)}${`${killed}/${won.length}`.padStart(16)}` +
      (killed === 0 ? "   ← free of winners on this sample" : ""),
    );
  }
  console.log(
    "\n    A dip is measured from `ref_px`, the price the plan was made at, so it is\n" +
    "    directly comparable to a stop percentage. `winners killed` is the count a level\n" +
    "    would have converted into losses; it is the cost side the sweep's mean hides.",
  );

  const winners = mae.filter((m) => (m.r.net_pnl as number) > 0 && m.excursion !== null);
  const worstWinner = winners.length === 0 ? null
    : winners.reduce((a, b) => (a.excursion as number) > (b.excursion as number) ? a : b);
  if (worstWinner) {
    console.log(
      `\n    The winning trade that came closest to being stopped went ` +
      `${pct(worstWinner.excursion as number)} against us ` +
      `(${pct((worstWinner.excursion as number) * worstWinner.r.leverage)} of margin) — ` +
      `${worstWinner.r.coin}, and it still closed +$${(worstWinner.r.net_pnl as number).toFixed(2)}.\n` +
      `    Any stop inside that would have turned it into a loss. That number, not the\n` +
      `    sweep above, is what a stop level has to clear.`,
    );
  }

  console.log(
    "\n    Every stop is modelled as filling at its trigger, so each line above is an\n" +
    "    upper bound — and a tighter stop is hit more often, so the flattery grows with\n" +
    "    tightness. Read the direction, not the magnitude.",
  );
  store.close();
}

if (import.meta.main) await main();
