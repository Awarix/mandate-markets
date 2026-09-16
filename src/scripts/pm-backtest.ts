import { readFileSync } from "node:fs";
import { readPmArchive } from "../signals/archive.ts";
import { stablePmKey } from "../mapping/quotient-pm.ts";
import { type Path, type PriceCapture, settledAt } from "./pm-prices.ts";
import type { PmSignal } from "../signals/types.ts";

// What a Polymarket book held to the market's own resolution would have returned.
//
//   npm run pm-backtest
//   npm run pm-backtest -- --spread 0.6 --fee 0.05     # the two cost assumptions, by hand
//
// `tasks/52`. Offline, from three committed captures and the local `/signals` archive: no
// credential, no venue call, nothing written, and a test asserts it cannot move
// `configHash()` off the Hyperliquid desk's fingerprint.
//
// ⚠⚠ **Read the banner before the tables, and read the interval before the mean.** The
// scoreable population is ~33 rows over ~20 events. `tasks/52` §0 says the reading this has
// to support is the **refusal** — an edge that does not survive the fee curve — and
// `notes/2026-09-15-what-the-resolved-markets-say.md` established that is not the reading
// available, because there is no edge here for a fee to erode: the book won 22 of 33
// against the 22.4 its own prices implied. What this script adds is everything that needed
// the price path and the slot cap: the true hold, what the cap refuses, what a resting bid
// would have filled, and whether any of the three sweeps moves the sign.
//
// ⚠ **The EV-based rankers are deliberately not here.** §9.1 of that note: Quotient's
// probabilities are overconfident by 21 points in the 85–101% bucket, which is the bucket
// an EV ranker buys from, so a ranker contest today compares statistics with one biased
// input. The sweeps below are the ones that do not divide by `q`.

const ROOT = process.env.DATA_ROOT ?? "data";
const RESOLUTIONS = "fixtures/pm-resolutions-2026-09-15.json";
const PRICES = "fixtures/pm-prices-2026-09-15.json";
const DAY = 864e5;

/** Ours, one leg — redemption is not a trade (`tasks/06` §6, 10 bps from the first order). */
const BUILDER_BPS = 10;
/** Polymarket's taker fee is `feeRate × p × (1 − p)` per share = `feeRate × (1 − p)` of
 *  stake; makers pay nothing. 0.05 is the modal category rate; `--fee` sweeps it. */
const FEE_RATE = 0.05;
/** Half the measured spread, as a share of the price paid: median **0.6%**, p90 4.8% over
 *  77 live books (`notes/2026-09-15-the-book-we-would-actually-pay.md` §2). This replaces
 *  the guess `tasks/52` §4 was written around, and it is still an assumption about a fill:
 *  the entry-price row of `modelled()` stays `no` until a live one measures it. */
const SPREAD_PCT = 0.6;

type Resolutions = {
  captured_at: string;
  markets: Record<string, {
    closed: boolean; end_date_iso: string; market_slug: string;
    minimum_order_size: number; minimum_tick_size: number;
    tokens: { token_id: string; outcome: string; price: number; winner: boolean }[];
  }>;
};

type Row = {
  key: string; s: PmSignal; firstAt: number; stem: string;
  /** Side-relative, live frame: what a buy of `s.side` was quoted at first sight. */
  p: number;
  /** Side-relative: Quotient's own probability for the same side. */
  q: number;
  volume: number;
  /** `end_date − first sight`, which is what every concurrency figure used before the
   *  paths existed, and which the paths say is wrong on two thirds of this population. */
  statedDays: number;
  /** The real one, where a path can say: settlement − first sight. */
  heldDays: number | null;
  /** Did it settle inside the archive at all — i.e. can it be scored. */
  scored: boolean;
  win: boolean;
  /** The path of the side we bought, for the fill and early-exit questions. */
  path: Path;
  settledTs: number | null;
};

// ------------------------------------------------------------------------------- the gate

/** `tasks/06` §4, §9.4 and §10 as `pm-census` and `pm-resolve` implement it, evaluated on
 *  the **first** revision of each key — the only one an entry decision ever reads. */
function refusal(s: PmSignal, volumeFloor: number, maxDays: number, firstAt: number, tokens: { outcome: string }[]): string | null {
  if (s.forecast_status.state === "converged") return "converged";
  if ((s.market.volume_24h ?? 0) < volumeFloor) return "thin-book";
  if (s.entry_pm > 92) return "above-max-entry";
  if (s.side !== (s.entry_q > s.entry_pm ? "YES" : "NO")) return "side-mismatch";
  const end = Date.parse(s.market.end_date);
  if (!Number.isFinite(end)) return "no-end-date";
  if ((end - firstAt) / DAY > maxDays) return "resolves-too-late";
  // ⚠⚠ A market whose tokens are not a YES/NO pair cannot be traded from a Quotient side —
  // one archived market carries a player per token and arrives as `side: "YES"`. Guessing
  // is the substring match that cost OutcomeMaker $192.
  if (tokens.length > 0) {
    const outs = tokens.map((t) => (t.outcome ?? "").toUpperCase());
    if (!(outs.includes("YES") && outs.includes("NO"))) return "unmappable-outcome";
  }
  return null;
}

// -------------------------------------------------------------------------- the population

function build(): { rows: Row[]; t0: number; t1: number } {
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const cap = JSON.parse(readFileSync(PRICES, "utf8")) as PriceCapture;
  const polls = readPmArchive(ROOT);
  const first = new Map<string, { s: PmSignal; at: number }>();
  for (const poll of polls) {
    for (const s of poll.signals) {
      if (s.market.venue !== "polymarket") continue;
      const k = stablePmKey(s);
      if (!first.has(k)) first.set(k, { s, at: poll.t.getTime() });
    }
  }
  const t0 = polls[0]?.t.getTime() ?? 0;
  const t1 = polls[polls.length - 1]?.t.getTime() ?? Date.now();

  const rows: Row[] = [];
  for (const [key, { s, at }] of first) {
    const cid = s.market.condition_id;
    const m = cid ? res.markets[cid] : undefined;
    const tokens = m?.tokens ?? [];
    const mine = tokens.find((t) => (t.outcome ?? "").toUpperCase() === s.side);
    const winner = tokens.find((t) => t.winner);
    const path = mine ? cap.paths[mine.token_id] ?? [] : [];
    const wPath = winner ? cap.paths[winner.token_id] ?? [] : [];
    const settledTs = m?.closed && winner && wPath.length ? settledAt(wPath) : null;
    const p = s.current_cost_cents / 100;
    if (!(p > 0 && p <= 1)) continue;
    rows.push({
      key, s, firstAt: at, p, q: s.q_value_cents / 100,
      volume: s.market.volume_24h ?? 0,
      stem: (s.market.slug ?? "").replace(/-\d[\d-]*$/, "").split("-").slice(0, 5).join("-"),
      statedDays: Math.max(0.01, (Date.parse(s.market.end_date) - at) / DAY),
      heldDays: settledTs === null ? null : Math.max(0.01, (settledTs * 1000 - at) / DAY),
      scored: Boolean(m?.closed && winner && settledTs !== null),
      win: winner ? (winner.outcome ?? "").toUpperCase() === s.side : false,
      path, settledTs,
    });
  }
  return { rows, t0, t1 };
}

// --------------------------------------------------------------------------- statistics

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
};
const ci = (a: number[]): string => {
  if (a.length < 2) return "—";
  const se = sd(a) / Math.sqrt(a.length);
  return `${(100 * (mean(a) - 1.96 * se)).toFixed(0)}% … ${(100 * (mean(a) + 1.96 * se)).toFixed(0)}%`;
};
const quantile = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? NaN;
};

/** The statistic `tasks/52` §9.6 says to pre-register: observed wins minus the wins the
 *  **entry prices themselves** imply, under the Poisson-binomial with mean Σp and variance
 *  Σp(1−p). It is the same claim as a return with the variance taken out, and its null is
 *  the price rather than a coin. */
function residual(r: Row[]): { obs: number; exp: number; z: number } {
  const obs = r.filter((x) => x.win).length;
  const exp = r.reduce((a, x) => a + x.p, 0);
  const v = r.reduce((a, x) => a + x.p * (1 - x.p), 0);
  return { obs, exp, z: v > 0 ? (obs - exp) / Math.sqrt(v) : NaN };
}

/** What one filled position returns, per dollar of stake, held to resolution.
 *
 *  `spreadPct` is the half-spread as a share of the price paid, so the effective entry is
 *  `p × (1 + spreadPct/100)` — the census quotes a midpoint and we would cross it.
 *  Redemption pays $1 a share and is **not a trade**, so the platform fee and our 10 bps
 *  are charged on the entry leg only. */
function netOf(r: Row, feeRate: number, spreadPct: number, maker: boolean): number {
  const eff = Math.min(0.999, r.p * (1 + spreadPct / 100));
  const gross = (r.win ? 1 / eff : 0) - 1;
  const fee = maker ? 0 : feeRate * (1 - eff);
  return gross - fee - BUILDER_BPS / 1e4;
}

// ------------------------------------------------------------------------ the slot cap

/** The book a real account would have held, rather than the book the gate would have
 *  admitted. Positions enter at first sight **in arrival order** and leave at settlement;
 *  an arrival that finds every slot full is refused and never revisited.
 *
 *  ⚠ Arrival order is not a choice here, it is the only ranker whose number does not
 *  assume the vendor's probabilities are calibrated — and §9.1 of the 09-15 note says they
 *  are not, in exactly the bucket an EV ranker reads. So this is the honest baseline and
 *  the alternative rankers wait for n≈100.
 *
 *  Equity is a fixed fraction of the **initial** budget per position, which is what makes
 *  the loss column readable: with no stop a loser costs the whole stake, so at 10% per
 *  signal one wrong call is 10% of the mandate. */
function simulate(rows: Row[], slots: number, pct: number, feeRate: number, spreadPct: number): {
  taken: Row[]; refused: number; scored: number; openAtEnd: number; ret: number; worstDrawdown: number; peakOpen: number;
} {
  const sorted = [...rows].sort((a, b) => a.firstAt - b.firstAt);
  const open: { until: number; row: Row }[] = [];
  const taken: Row[] = [];
  let refused = 0;
  let peakOpen = 0;
  const events: { t: number; delta: number }[] = [];
  for (const r of sorted) {
    for (let i = open.length - 1; i >= 0; i--) if ((open[i]?.until ?? 0) <= r.firstAt) open.splice(i, 1);
    if (open.length >= slots) {
      refused++;
      continue;
    }
    // A position whose market has not settled still holds its slot to the end of the window.
    const until = r.settledTs === null ? Infinity : r.settledTs * 1000;
    open.push({ until, row: r });
    peakOpen = Math.max(peakOpen, open.length);
    taken.push(r);
    if (r.scored) events.push({ t: until, delta: pct * netOf(r, feeRate, spreadPct, false) });
  }
  events.sort((a, b) => a.t - b.t);
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const e of events) {
    equity += e.delta;
    peak = Math.max(peak, equity);
    worst = Math.min(worst, equity / peak - 1);
  }
  return {
    taken, refused, scored: taken.filter((r) => r.scored).length,
    openAtEnd: taken.filter((r) => !r.scored).length,
    ret: equity - 1, worstDrawdown: worst, peakOpen,
  };
}

// ---------------------------------------------------------------------------- the report

function modelled(spreadPct: number, feeRate: number): void {
  console.log(`\n  what this simulator does and does not reproduce:\n`);
  const row = (what: string, yes: string, detail: string): void => console.log(`    ${what.padEnd(26)}${yes.padEnd(10)}${detail}`);
  row("entry", "yes", "first sight of each stablePmKey, at current_cost_cents (side-relative, live frame)");
  row("exit", "yes", "the market's own resolution, from the winning token's price path");
  row("the hold", "yes", "settlement − first sight, NOT end_date (which is wrong on 25 of 39 here)");
  row("platform fee", "yes", `feeRate x (1 - p) of stake at ${feeRate}, entry leg only — redemption is not a trade`);
  row("builder fee", "yes", `${BUILDER_BPS} bps of notional, one leg (tasks/06 §6)`);
  row("the slot cap", "yes", "arrivals refused when the book is full, in arrival order");
  row("entry spread", "⚠ partial", `${spreadPct}% of price, the measured median half-spread — an assumption about a fill, not a fill`);
  row("depth / partial fills", "⚠ NO", "a $3.48 minimum ticket clears p10 depth, but nothing here walks the book per order");
  row("whether a limit filled", "⚠ NO", "the resting-order section below measures touches, which is an upper bound on fills");
  row("redemption mechanics", "⚠ NO", "every exit is an on-chain redeem and STATUS item 4 is unanswered");
  row("replication", "⚠ NO", "there is no Polymarket ledger to replicate against, and will not be until stage 1");
  console.log(
    `\n  ⚠⚠ That last row is the whole difference between this script's authority and \`backtest.ts\`'s.\n` +
      `  The perps simulator prints a replication line against the desk's own fills and was 4x optimistic\n` +
      `  until it did. Nothing here has been checked against a fill that happened.\n`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const num = (flag: string, dflt: number): number => {
    const i = args.indexOf(flag);
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(v) ? v : dflt;
  };
  const spreadPct = num("--spread", SPREAD_PCT);
  const feeRate = num("--fee", FEE_RATE);

  const { rows, t0, t1 } = build();
  if (rows.length === 0) {
    console.log(`No Polymarket signals under ${ROOT}/quotient/signals — the archive is on the VPS.`);
    return;
  }
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const tokensOf = (r: Row): { outcome: string }[] => res.markets[r.s.market.condition_id ?? ""]?.tokens ?? [];
  const gated = rows.filter((r) => !refusal(r.s, 0, Infinity, r.firstAt, tokensOf(r)));
  const scoreable = gated.filter((r) => r.scored);

  console.log(`\n=== pm-backtest — held to resolution, ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} ===`);
  modelled(spreadPct, feeRate);

  // --- the population line, before any return.
  const dates = new Set(scoreable.map((r) => new Date((r.settledTs ?? 0) * 1000).toISOString().slice(0, 10)));
  const stems = new Map<string, Row[]>();
  for (const r of scoreable) stems.set(r.stem, [...(stems.get(r.stem) ?? []), r]);
  const spanDays = (t1 - t0) / DAY;
  console.log(
    `  population: ${rows.length} keys, ${gated.length} gated, **${scoreable.length} scoreable** over ${spanDays.toFixed(1)} days\n` +
      `  ⚠ those ${scoreable.length} rows are ${stems.size} slug-stem events and span ${dates.size} distinct settlement dates —\n` +
      `    prediction markets cluster on calendar dates, so the marginal information is well below the marginal n.\n` +
      `  arrival: ${(gated.length / spanDays).toFixed(1)} gated keys/day whole-archive, ${(gated.filter((r) => r.firstAt >= t1 - 7 * DAY).length / 7).toFixed(1)}/day on the trailing week\n` +
      `    (the first poll sees a stock, not a flow — \`notes/2026-09-15-the-book-we-would-actually-pay.md\` §5)\n`,
  );

  // --- the hold, which is the correction the paths brought.
  const withPath = gated.filter((r) => r.heldDays !== null);
  if (withPath.length) {
    const held = withPath.map((r) => r.heldDays ?? 0);
    const stated = withPath.map((r) => r.statedDays);
    const earlier = withPath.filter((r) => (r.heldDays ?? 0) < r.statedDays - 0.04).length;
    console.log(
      `--- the hold, measured rather than stated ---\n` +
        `  ⚠⚠ ${earlier} of ${withPath.length} settled before their stated end_date. Mean hold **${mean(held).toFixed(1)}d against end_date's ${mean(stated).toFixed(1)}d**;\n` +
        `     median ${quantile(held, 0.5).toFixed(1)}d against ${quantile(stated, 0.5).toFixed(1)}d.\n` +
        `  ⚠ This population is selected — a long-dated market can only be in it by settling early — so this is\n` +
        `    not the feed's hold. What it does say is that **end_date is an upper bound**, and every concurrency\n` +
        `    figure computed from end_date (the 168-position steady state, 8–17x the slots) is an upper bound too.\n`,
    );
  }

  // --- the headline, with the null that is the price.
  const nets = scoreable.map((r) => netOf(r, feeRate, spreadPct, false));
  const { obs, exp, z } = residual(scoreable);
  console.log(
    `--- the book, at ${spreadPct}% spread and feeRate ${feeRate} ---\n` +
      `  n=${scoreable.length}  mean net ${(100 * mean(nets)).toFixed(1)}%  CI ${ci(nets)}\n` +
      `  won ${obs} against the ${exp.toFixed(1)} its own entry prices imply → residual **${(obs - exp).toFixed(1)} wins, z ${z.toFixed(2)}**\n` +
      `  ⚠ The residual is the registered statistic (PREREGISTERED row 11), because the return's interval is\n` +
      `    wide enough to swallow the whole fee schedule. One vote per event: mean net ${(100 * mean([...stems.values()].map((v) => mean(v.map((r) => netOf(r, feeRate, spreadPct, false)))))).toFixed(0)}% over ${stems.size} events.\n`,
  );

  // --- sweep 1: the volume floor.
  console.log(`--- sweep 1: the volume floor (the largest cut in the feed) ---\n`);
  console.log(`  floor        gated  scoreable   mean net          CI   wins vs implied      z`);
  for (const floor of [0, 5_000, 10_000, 25_000]) {
    const g = rows.filter((r) => !refusal(r.s, floor, Infinity, r.firstAt, tokensOf(r)));
    const sc = g.filter((r) => r.scored);
    const n = sc.map((r) => netOf(r, feeRate, spreadPct, false));
    const d = residual(sc);
    console.log(
      `  ${("$" + floor.toLocaleString("en-US")).padEnd(10)} ${String(g.length).padStart(6)} ${String(sc.length).padStart(10)}   ${sc.length ? (100 * mean(n)).toFixed(1).padStart(6) + "%" : "     —"}   ${ci(n).padStart(14)}   ${sc.length ? `${d.obs} vs ${d.exp.toFixed(1)}`.padStart(13) : "            —"}  ${Number.isFinite(d.z) ? d.z.toFixed(2).padStart(5) : "    —"}`,
    );
  }

  // --- sweep 2: a bound on time to resolution.
  console.log(`\n--- sweep 2: a bound on time to resolution (what replaces maxHoldHours) ---\n`);
  console.log(`  maxDays      gated  scoreable   mean net          CI   mean held   wins vs implied`);
  for (const maxDays of [7, 14, 30, Infinity]) {
    const g = rows.filter((r) => !refusal(r.s, 0, maxDays, r.firstAt, tokensOf(r)));
    const sc = g.filter((r) => r.scored);
    const n = sc.map((r) => netOf(r, feeRate, spreadPct, false));
    const d = residual(sc);
    const held = sc.map((r) => r.heldDays ?? 0);
    console.log(
      `  ${(maxDays === Infinity ? "none" : String(maxDays)).padEnd(10)} ${String(g.length).padStart(6)} ${String(sc.length).padStart(10)}   ${sc.length ? (100 * mean(n)).toFixed(1).padStart(6) + "%" : "     —"}   ${ci(n).padStart(14)}   ${held.length ? mean(held).toFixed(1).padStart(8) + "d" : "        —"}   ${sc.length ? `${d.obs} vs ${d.exp.toFixed(1)}`.padStart(13) : "            —"}`,
    );
  }
  console.log(
    `\n  ⚠⚠ **This gradient is mostly selection and must not be read as "short horizons win".**\n` +
      `  A long-dated market can only be in a resolved population by settling early, which for a prediction\n` +
      `  market usually means the outcome stopped being in doubt — so the rows a looser bound adds are drawn\n` +
      `  from the most favourable possible sample for a policy that ties capital up for weeks, and they are\n` +
      `  still the rows that lost (\`notes/2026-09-15-what-the-resolved-markets-say.md\` §6, which measured the\n` +
      `  same shape and refused it). The four rows are **not the same experiment**. What the sweep was written\n` +
      `  to ask — are long-dated signals worth the slots they consume — is sweep 3's question, not this one.\n`,
  );

  // --- sweep 3: per-signal size, which is the slot count, which is the whole strategy.
  console.log(`--- sweep 3: perSignalPct — the slot cap, and what it refuses ---\n`);
  console.log(`  perSignal  slots   taken  refused   open@end  scored   book return   per trade   worst DD   peak open`);
  for (const pct of [0.25, 0.1, 0.05, 0.03, 0.015]) {
    const slots = Math.floor(1 / pct);
    const sim = simulate(gated, slots, pct, feeRate, spreadPct);
    const per = sim.taken.filter((r) => r.scored).map((r) => netOf(r, feeRate, spreadPct, false));
    console.log(
      `  ${(100 * pct).toFixed(1).padStart(8)}% ${String(slots).padStart(6)} ${String(sim.taken.length).padStart(7)} ${String(sim.refused).padStart(8)} ${String(sim.openAtEnd).padStart(10)} ${String(sim.scored).padStart(7)}   ${(100 * sim.ret).toFixed(1).padStart(10)}%   ${per.length ? (100 * mean(per)).toFixed(1).padStart(8) + "%" : "        —"}   ${(100 * sim.worstDrawdown).toFixed(1).padStart(7)}%   ${String(sim.peakOpen).padStart(9)}`,
    );
  }
  console.log(
    `\n  ⚠⚠ **With no stop a losing position costs the whole stake**, so "worst DD" is the column with a\n` +
      `  decision in it: at 25% per signal one wrong call is a quarter of the mandate. The perps side's\n` +
      `  10% default does not carry across, and \`tasks/06\` §5.3 is where the constant lands.\n` +
      `  ⚠⚠ **"book return" is not a return, at these counts.** It compounds \`perSignalPct × net\` over the\n` +
      `  few positions that settled inside the window, so the 4-slot row is two lucky trades at a quarter\n` +
      `  each and the tighter rows are more trades at a smaller weight. Read "per trade" for the edge and\n` +
      `  "worst DD" for the risk; the book column is there to show they move in opposite directions.\n` +
      `  ⚠ **"refused" is also an artefact of the window, in the direction that overstates it.** Every\n` +
      `  position whose market had not settled by the last poll holds its slot to the end — that is what\n` +
      `  "open@end" counts — so the book clogs with positions that would have released in a longer archive.\n` +
      `  Against that, the holds here are the **measured** ones, which are far shorter than end_date's, and\n` +
      `  that pushes the other way. Neither correction is applied; both are named.\n`,
  );

  // --- the cost surface: the posture decision, priced.
  console.log(`--- the costs, and which half of them is ours to choose ---\n`);
  console.log(`  posture                        mean net          CI`);
  for (const f of [0, 0.04, 0.05, 0.07]) {
    const n = scoreable.map((r) => netOf(r, f, spreadPct, false));
    console.log(`  taker, feeRate ${f.toFixed(2)}             ${(100 * mean(n)).toFixed(1).padStart(6)}%   ${ci(n).padStart(14)}`);
  }
  const mk = scoreable.map((r) => netOf(r, feeRate, 0, true));
  console.log(`  maker, no fee, no spread crossed ${(100 * mean(mk)).toFixed(1).padStart(4)}%   ${ci(mk).padStart(14)}`);
  console.log(`\n  spread swept 0–5% of stake (measured median 0.6%, p90 4.8%):`);
  for (const s of [0, 0.6, 1.5, 3, 5]) {
    const n = scoreable.map((r) => netOf(r, feeRate, s, false));
    console.log(`    ${String(s).padStart(4)}%  mean net ${(100 * mean(n)).toFixed(1).padStart(6)}%   CI ${ci(n)}`);
  }
  const swing = mean(scoreable.map((r) => netOf(r, feeRate, 0, true))) - mean(scoreable.map((r) => netOf(r, feeRate, 5, false)));
  console.log(
    `\n  The whole cost surface — free maker to a 5% crossed spread at the 7% fee tier — is worth ${(100 * swing).toFixed(1)}pp,\n` +
      `  against an interval ±${(100 * 1.96 * sd(nets) / Math.sqrt(scoreable.length)).toFixed(0)}pp wide. **Costs do not decide this venue at this n**, which is the same\n` +
      `  answer \`pm-resolve\` reached and the reason \`tasks/52\` §0's refusal is not the reading available.\n`,
  );

  restingOrders(scoreable, spreadPct);
  earlyExit(scoreable);
}

/** The owner's 2026-09-14 question: rest a limit rather than cross, and let *whichever
 *  fills first* select the book. A book snapshot could not answer it; a price path can
 *  answer half of it.
 *
 *  ⚠ A touch is an **upper bound on a fill** — being at the price is not being filled at
 *  it, since a resting bid needs a seller to cross to it and the queue is invisible here.
 *  What the path does settle is the half that decides whether the idea is even sound:
 *  **what a fill selects for.** A resting buy fills when the price comes *down* to it,
 *  which is when the market moves away from Quotient's call after we looked. */
function restingOrders(rows: Row[], spreadPct: number): void {
  console.log(`--- the resting order: what a limit below the quote would have selected ---\n`);
  console.log(`  limit below quote    touched   of which won   price-implied   z     mean net (touched only)`);
  for (const below of [0, 1, 2, 5]) {
    const hit: Row[] = [];
    for (const r of rows) {
      const limit = r.p - below / 100;
      if (limit <= 0.01) continue;
      const entryT = Math.floor(r.firstAt / 1000);
      // Did the path trade at or below our limit after we looked, and before it settled?
      const touched = r.path.some(([t, px]) => t >= entryT && (r.settledTs === null || t <= r.settledTs) && px <= limit + 1e-9);
      if (touched) hit.push(r);
    }
    if (hit.length === 0) {
      console.log(`  ${`${below}c`.padStart(11)}${"".padStart(12)}0`);
      continue;
    }
    const d = residual(hit);
    // Filled at the limit, so the entry is cheaper by exactly `below` — and no spread is
    // crossed, because the order rested.
    const nets = hit.map((r) => {
      const eff = Math.max(0.01, r.p - below / 100);
      return (r.win ? 1 / eff : 0) - 1 - BUILDER_BPS / 1e4;
    });
    console.log(
      `  ${`${below}c`.padStart(11)}   ${String(hit.length).padStart(9)}   ${String(hit.filter((r) => r.win).length).padStart(12)}   ${d.exp.toFixed(1).padStart(13)}  ${d.z.toFixed(2).padStart(5)}   ${(100 * mean(nets)).toFixed(1).padStart(10)}%  CI ${ci(nets)}`,
    );
  }
  console.log(
    `\n  ⚠⚠ Read the **z**, not the return. A limit 5c below the quote buys cheaper by construction, so its\n` +
      `  return rises whether or not the selection is good. The z asks the only question that matters:\n` +
      `  did the markets that came down to us win more or less than the price they came down to implied?\n` +
      `  A z that falls as the limit widens is *adverse selection wearing a limit order* — the market moved\n` +
      `  away from the thesis because it was right to. A z that holds means the dip was noise and the\n` +
      `  selector is free money. ⚠ Touch ≠ fill, and at ${spreadPct}% the crossed alternative is nearly free,\n` +
      `  so the saving here was never the argument (\`notes/2026-09-15-the-book-we-would-actually-pay.md\` §3).\n`,
  );
}

/** `tasks/52` §2.2's early-exit counterfactual, which exists to test the exit policy itself:
 *  the decision of 2026-09-14 is to hold to resolution and sell nothing, and the price path
 *  is the only thing that can price what that gives up. */
function earlyExit(rows: Row[]): void {
  console.log(`--- the exit policy: hold to resolution against selling early ---\n`);
  const held = rows.map((r) => (r.win ? 1 / r.p : 0) - 1 - BUILDER_BPS / 1e4);
  console.log(`  hold to resolution          n=${rows.length}  mean ${(100 * mean(held)).toFixed(1).padStart(6)}%   CI ${ci(held)}`);
  for (const target of [0.9, 0.95]) {
    const out = rows.map((r) => {
      const entryT = Math.floor(r.firstAt / 1000);
      const hitAt = r.path.find(([t, px]) => t > entryT && (r.settledTs === null || t <= r.settledTs) && px >= target);
      // Selling is a second taker leg, so it pays the fee and our bps again.
      if (hitAt) return target / r.p - 1 - 2 * BUILDER_BPS / 1e4 - FEE_RATE * (1 - target);
      return (r.win ? 1 / r.p : 0) - 1 - BUILDER_BPS / 1e4;
    });
    const n = rows.filter((r) => {
      const entryT = Math.floor(r.firstAt / 1000);
      return r.path.some(([t, px]) => t > entryT && (r.settledTs === null || t <= r.settledTs) && px >= target);
    }).length;
    console.log(`  sell at ${(100 * target).toFixed(0)}c when reached   ${String(n).padStart(3)} sold   mean ${(100 * mean(out)).toFixed(1).padStart(6)}%   CI ${ci(out)}`);
  }
  for (const stop of [0.3, 0.15]) {
    let cut = 0;
    let cutAndWouldHaveWon = 0;
    const out = rows.map((r) => {
      const entryT = Math.floor(r.firstAt / 1000);
      const hitAt = r.path.find(([t, px]) => t > entryT && (r.settledTs === null || t <= r.settledTs) && px <= stop * r.p);
      if (hitAt) {
        cut++;
        if (r.win) cutAndWouldHaveWon++;
        return stop - 1 - 2 * BUILDER_BPS / 1e4;
      }
      return (r.win ? 1 / r.p : 0) - 1 - BUILDER_BPS / 1e4;
    });
    console.log(
      `  cut at −${(100 * (1 - stop)).toFixed(0)}% of stake     ${String(cut).padStart(3)} cut    mean ${(100 * mean(out)).toFixed(1).padStart(6)}%   CI ${ci(out)}` +
        `   ⚠ ${cutAndWouldHaveWon} of those ${cut} went on to win`,
    );
  }
  console.log(
    `\n  ⚠ Every early exit is a **sale**, which the 2026-09-14 decision forbids — these rows price that\n` +
      `  decision, they do not reopen it. They also all pay a second taker leg, which hold-to-resolution\n` +
      `  does not: redemption is not a trade. ⚠⚠ And each one is the same ${rows.length} outcomes re-cut, so the\n` +
      `  differences between these lines are not independent of each other or of the headline.\n` +
      `\n  ⚠⚠ THE READING: n=${rows.length} over ~20 events, one of which is 8 rows. Nothing here is a decision,\n` +
      `  \`tasks/52\` §7 asks for the write-up whichever way it comes out, and the re-read is ~2026-10-05\n` +
      `  at n≈100 — where the population arrives in correlated lumps, so report the dates beside the n.\n`,
  );
}

main();
