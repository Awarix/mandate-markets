import "dotenv/config";
import { excludeSyntheticSql, syntheticNote } from "../store/synthetic.ts";
import { join } from "node:path";
import { isTestnet, makeInfoClient } from "../hl/clients.ts";
import { Store } from "../store/db.ts";
import { modelledTable } from "./modelled.ts";

// What the exit policy cost, or saved — measured against the plan it abandoned.
//
//   npm run exit-policy
//
// We exit an open position when the forecast behind it stops being published, without
// waiting for the take-profit or the stop. That is a real policy and nobody has ever
// priced it. It has two visible faces in the live ledger and they point opposite ways:
//
//   · `xyz:COPPER` long, 2026-09-01. Retired at −17.8% of margin. The stop sat at
//     −30.0%, and the market kept falling. **The retirement saved 12 points.**
//   · Six `xyz:NATGAS` trades reached their target anyway, so the policy cost nothing
//     there — but if a retirement had fired first, it would have cut a winner short.
//
// The question this answers: **over every closed trade, does leaving on a retirement
// beat holding to the target or the stop?** Nothing here is a claim about whether the
// signals make money — that is `tasks/02` and `npm run expectancy`, which measures the
// policy we actually run. This measures the counterfactual we did not.
//
// ── What is modelled, and what is not ───────────────────────────────────────────
//
// Only the **exit price** changes. Entry, size, leverage and the settled fees on the
// trip stay exactly as they were, so the difference between the two columns is the
// price we left at and nothing else.
//
//   · **A target fills at `target_px`.** Evidence rather than assumption: the six
//     take-profits that really fired came in 0.03–0.06% *better* than their trigger
//     (2.875 armed → 2.8741 filled; 2.9426 → 2.9409), because the trigger releases a
//     marketable limit into a book that had to trade through the level to get there.
//   · **A stop fills at `stop_px`, which is optimistic and biases this whole report
//     toward holding.** A stop is a trigger; it fires in the move that is already going
//     against us and fills behind the level. ⚠ **Until 2026-09-13 this bullet said "no
//     stop has ever fired on this account (zero `sl` fills in the entire ledger)".** 107
//     had — 87 on 2026-09-11 alone — and `stop-sweep.ts` was corrected on 09-12 while
//     this file was not, which is the argument for `modelled()` being a function the
//     three scripts share rather than a paragraph each of them keeps. The measurement:
//     those 107 filled a mean of **3.3bps past their trigger, worst 30.1** — so the
//     flattery is small *where the stop fills*. The larger bias is that our stop is a
//     stop-**limit** with a 30bps band and can **miss entirely** (the 09-10 COPPER
//     liquidation), which appears in none of these numbers. Read every "holding was
//     better" line as an upper bound.
//   · **Funding on the extra holding time is not modelled.** Bounded by measurement:
//     funding across all 22 closed intents totals $0.0126, against $0.4579 of fees.
//     At this hold length it is not a term that moves an answer.
//   · **One-minute candles**, the finest HL serves. When a single candle touches both
//     the target and the stop, the order inside it is unknowable; this resolves it to
//     the **stop** — conservative for the policy under test — and counts how often it
//     had to.
//
// A trade whose horizon has not yet passed is still running and is reported
// separately, never averaged in. Half a counterfactual is not a result.
//
// Nor is a trade that already reached its horizon. The counterfactual asks what a
// *longer* hold would have done, and for those there is no time left to hold: the
// window runs from `closed_at` to `horizon_at` and is empty or negative. Every
// `horizon` close is in that state by construction, because the force-close lands on
// the tick *after* the horizon passes, and so is a target that fires late. Until
// 2026-09-05 they were handed to the venue as a candle request with `startTime >
// endTime`, which answers 500 and took the whole script down with it — found while
// running `tasks/02`'s reading. They are reported in their own bucket now.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

export type Candle = { t: number; T: number; o: string; h: string; l: string; c: string };

/** Which of the three states a closed trade is in for the purposes of this replay.
 *  Pure, so the boundary that produced a venue 500 is decided in a unit test rather
 *  than in a loop that talks to Hyperliquid. */
export type ReplayWindow =
  | { kind: "running" }
  | { kind: "at-horizon" }
  | { kind: "ok"; startTime: number; endTime: number };

export function replayWindow(closedAt: string, horizonAt: string, nowMs: number): ReplayWindow {
  const from = Date.parse(closedAt);
  const until = Date.parse(horizonAt);
  if (until > nowMs) return { kind: "running" };
  // `<=`, not `<`: a zero-length window has no candles either, and asking for one is
  // a request the venue is entitled to refuse.
  if (until <= from) return { kind: "at-horizon" };
  return { kind: "ok", startTime: from, endTime: until };
}

type Row = {
  intent_id: string; signal_ref: string; coin: string; side: string;
  entry_px: number | null; target_px: number | null; stop_px: number | null;
  horizon_at: string; closed_at: string; close_reason: string | null;
  margin_usd: number; filled_sz: number; net_pnl: number | null; exit_px: number | null;
};

type Outcome = {
  row: Row;
  /** What holding would have exited on, and at what price. */
  cfReason: "target" | "stop" | "horizon";
  cfExit: number;
  cfNet: number;
  /** cfNet − actual net, in dollars. */
  delta: number;
  /** A candle straddled both levels and the tie went to the stop. */
  ambiguous: boolean;
};

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/** Mean and a 95% interval on it. Normal, not t, and at these sample sizes neither is
 *  defensible — the interval is printed to show how wide it is, which is the finding. */
function meanCi(xs: number[]): { n: number; mean: number; lo: number; hi: number } {
  const n = xs.length;
  if (n === 0) return { n, mean: 0, lo: 0, hi: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { n, mean, lo: mean, hi: mean };
  const sd = Math.sqrt(xs.reduce((t, x) => t + (x - mean) ** 2, 0) / (n - 1));
  const se = sd / Math.sqrt(n);
  return { n, mean, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
}

/** Walk the price path the trade would have lived through, and return the first exit
 *  the plan would have taken. Pure, given the candles.
 *
 *  **`at` is the close time of the candle the exit happened in**, added 2026-09-12. It
 *  is not decoration: without it a caller can only date an exit by the *end of the
 *  window it was given*, and `backtest.ts` did exactly that — a trade that took its
 *  target in the first hour of a ten-hour window was recorded as a ten-hour hold, which
 *  inflated Table 1's median hold and Table 1c's occupancy for every exit that was not a
 *  retirement. A 5m bar puts `at` up to five minutes late, in the direction of holding
 *  slightly too long. */
export function replay(
  side: string, target: number | null, stop: number | null, candles: Candle[],
): { reason: "target" | "stop" | "horizon"; px: number; at: number; ambiguous: boolean } | null {
  if (candles.length === 0) return null;
  const long = side === "long";
  for (const k of candles) {
    const hi = Number(k.h);
    const lo = Number(k.l);
    // A long takes its target above and its stop below; a short, the reverse.
    const hitTarget = target !== null && (long ? hi >= target : lo <= target);
    const hitStop = stop !== null && (long ? lo <= stop : hi >= stop);
    if (hitTarget && hitStop) return { reason: "stop", px: stop as number, at: k.T, ambiguous: true };
    if (hitTarget) return { reason: "target", px: target as number, at: k.T, ambiguous: false };
    if (hitStop) return { reason: "stop", px: stop as number, at: k.T, ambiguous: false };
  }
  const last = candles[candles.length - 1]!;
  return { reason: "horizon", px: Number(last.c), at: last.T, ambiguous: false };
}

async function main(): Promise<void> {
  console.log(`network: ${isTestnet() ? "TESTNET" : "MAINNET"}   ledger: ${LEDGER}`);
  console.log(syntheticNote());
  if (isTestnet()) {
    console.log("\n  Refusing to read a mainnet ledger against testnet candles — the universe is");
    console.log("  different and the prices are fiction. Re-run with HYPERLIQUID_TESTNET=false.\n");
    process.exitCode = 1;
    return;
  }

  const store = new Store(LEDGER, { log: () => {} });
  const info = makeInfoClient(false);
  const now = Date.now();

  // The exit price is the size-weighted average of the fills that actually closed it —
  // the venue's own rows, not the armed trigger price. `realized_pnl` uses the armed
  // price and is the estimate this deliberately does not repeat.
  const rows = store.db.prepare(
    "SELECT i.intent_id, i.signal_ref, i.coin, i.side, i.entry_px, i.target_px, i.stop_px, " +
    "       i.horizon_at, i.closed_at, i.close_reason, i.margin_usd, i.filled_sz, i.net_pnl, x.exit_px " +
    "FROM intents i LEFT JOIN (SELECT intent_id, SUM(px * sz) / SUM(sz) AS exit_px FROM fills " +
    "  WHERE intent_id IS NOT NULL AND (dir LIKE 'Close%' OR dir LIKE 'Liquidat%') GROUP BY intent_id) x " +
    "  ON x.intent_id = i.intent_id " +
    `WHERE i.status = 'closed' AND i.closed_at IS NOT NULL AND ${excludeSyntheticSql("i.intent_id")} ` +
    "ORDER BY i.closed_at",
  ).all() as unknown as Row[];

  const usable = rows.filter((r) =>
    r.net_pnl !== null && r.exit_px !== null && r.entry_px !== null && r.filled_sz > 0);
  const dropped = rows.length - usable.length;

  const done: Outcome[] = [];
  const running: Row[] = [];
  const noPath: Row[] = [];
  const atHorizon: Row[] = [];

  for (const r of usable) {
    const w = replayWindow(r.closed_at, r.horizon_at, now);
    if (w.kind === "running") { running.push(r); continue; }
    if (w.kind === "at-horizon") { atHorizon.push(r); continue; }

    const candles = await info.candleSnapshot({
      coin: r.coin, interval: "1m", startTime: w.startTime, endTime: w.endTime,
    }) as unknown as Candle[];
    const hit = replay(r.side, r.target_px, r.stop_px, candles);
    if (!hit) { noPath.push(r); continue; }

    // Only the exit moves. `net_pnl` already carries the real fees and funding of the
    // trip, so shifting the price it left at is the whole counterfactual.
    const signed = r.side === "long" ? r.filled_sz : -r.filled_sz;
    const delta = (hit.px - (r.exit_px as number)) * signed;
    done.push({
      row: r, cfReason: hit.reason, cfExit: hit.px,
      cfNet: (r.net_pnl as number) + delta, delta, ambiguous: hit.ambiguous,
    });
  }

  // `tasks/46` §2.5 — one table, in the output, instead of four bullets in a header
  // comment. ⚠ One of those bullets said *"no stop has ever fired on this account (zero
  // `sl` fills in the entire ledger)"* as late as 2026-09-13. 107 had fired, a mean of
  // 3.3bps past their trigger, and one had missed entirely and taken an account to
  // liquidation on 09-10. That is the failure mode a prose caveat has and a tested
  // function does not.
  console.log(`\n${modelledTable("exit-policy")}`);

  // ── per trade ───────────────────────────────────────────────────────────────
  console.log(`\n═══ ${done.length} closed trades replayed to their horizon ═══\n`);
  console.log("    trade      coin          side   left on     actual      held to     Δ$      Δ on margin");
  for (const o of done.sort((a, b) => a.delta - b.delta)) {
    const r = o.row;
    console.log(
      `    ${r.intent_id.slice(0, 8)}  ${r.coin.padEnd(13)} ${r.side.padEnd(5)}  ` +
      `${String(r.close_reason).padEnd(10)}  ${(r.net_pnl as number).toFixed(2).padStart(7)}  ` +
      `${o.cfNet.toFixed(2).padStart(7)} ${o.cfReason.padEnd(8)} ${o.delta >= 0 ? "+" : ""}${o.delta.toFixed(2).padStart(6)}  ` +
      `${pct(o.delta / r.margin_usd).padStart(8)}${o.ambiguous ? "   ← tie, given to the stop" : ""}`,
    );
  }

  // ── per distinct signal ─────────────────────────────────────────────────────
  //
  // One **signal** is one event, however many accounts traded it — the same convention
  // `npm run expectancy` uses, and for the same reason: three accounts trading one
  // Quotient outlook is one forecast being right once, at three sizes. Summing dollars
  // would count it three times and weight it by whoever happened to be funded.
  const bySignal = new Map<string, Outcome[]>();
  for (const o of done) bySignal.set(o.row.signal_ref, [...(bySignal.get(o.row.signal_ref) ?? []), o]);

  const events = [...bySignal.entries()].map(([ref, os]) => ({
    ref,
    coin: os[0]!.row.coin,
    actual: os.reduce((t, o) => t + (o.row.net_pnl as number) / o.row.margin_usd, 0) / os.length,
    held: os.reduce((t, o) => t + o.cfNet / o.row.margin_usd, 0) / os.length,
    accounts: os.length,
    cfReason: os[0]!.cfReason,
  }));

  console.log(`\n═══ ${events.length} distinct signals ═══\n`);
  console.log("    coin           acct  exit on retirement   hold to tp/sl        difference");
  for (const e of events.sort((a, b) => (a.held - a.actual) - (b.held - b.actual))) {
    const d = e.held - e.actual;
    console.log(
      `    ${e.coin.padEnd(13)}  ${String(e.accounts).padStart(2)}   ${pct(e.actual).padStart(9)} of margin  ` +
      `${pct(e.held).padStart(9)} (${e.cfReason})  ${d >= 0 ? "+" : ""}${pct(d).padStart(8)}`,
    );
  }

  const actualRets = events.map((e) => e.actual);
  const heldRets = events.map((e) => e.held);
  const a = meanCi(actualRets);
  const h = meanCi(heldRets);
  const deltas = events.map((e) => e.held - e.actual);
  const dCi = meanCi(deltas);
  const dollarsActual = done.reduce((t, o) => t + (o.row.net_pnl as number), 0);
  const dollarsHeld = done.reduce((t, o) => t + o.cfNet, 0);
  const ambiguous = done.filter((o) => o.ambiguous).length;
  const wouldStop = done.filter((o) => o.cfReason === "stop").length;
  const wouldTarget = done.filter((o) => o.cfReason === "target").length;
  const wouldHorizon = done.filter((o) => o.cfReason === "horizon").length;

  console.log(
    `\n    exit on retirement   ${pct(a.mean).padStart(8)} per signal   95% CI ${pct(a.lo)} … ${pct(a.hi)}\n` +
    `    hold to tp/sl        ${pct(h.mean).padStart(8)} per signal   95% CI ${pct(h.lo)} … ${pct(h.hi)}\n` +
    `    difference           ${pct(dCi.mean).padStart(8)} per signal   95% CI ${pct(dCi.lo)} … ${pct(dCi.hi)}   (n=${dCi.n})\n` +
    `\n    net dollars, all accounts   retirement $${dollarsActual.toFixed(2)}   ·   holding $${dollarsHeld.toFixed(2)}\n` +
    `    holding would have exited on: ${wouldTarget} target, ${wouldStop} stop, ${wouldHorizon} horizon` +
    `${ambiguous > 0 ? `   (${ambiguous} decided by a tie given to the stop)` : ""}`,
  );

  if (running.length > 0) {
    console.log(`\n    ${running.length} closed trade(s) whose horizon has not passed — excluded, not half-counted:`);
    for (const r of running) console.log(`      ${r.intent_id.slice(0, 8)}  ${r.coin}  horizon ${r.horizon_at}`);
  }
  if (atHorizon.length > 0) {
    console.log(`\n    ${atHorizon.length} closed at or after their own horizon — no counterfactual exists,`);
    console.log("    because holding to a target or a stop means holding longer and there is no");
    console.log("    time left to hold. Every horizon close is here by construction:");
    for (const r of atHorizon) {
      console.log(`      ${r.intent_id.slice(0, 8)}  ${r.coin.padEnd(12)} ${(r.close_reason ?? "?").padEnd(9)} ` +
        `closed ${r.closed_at} · horizon ${r.horizon_at}`);
    }
  }
  if (noPath.length > 0) console.log(`\n    ${noPath.length} with no candles in the window — excluded.`);
  if (dropped > 0) console.log(`    ${dropped} closed intent(s) with no settled P&L or no venue fill — excluded.`);

  console.log(
    "\n    Read the stop column as an upper bound: a stop is modelled as filling at its\n" +
    "    trigger, and a real one fires into the move that is already going against it.",
  );
  store.close();
}

// Guarded so the pure half above can be imported by `exit-policy.test.ts` without the
// import itself reaching out to Hyperliquid.
if (import.meta.main) await main();
