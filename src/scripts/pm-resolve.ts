import { readFileSync, writeFileSync } from "node:fs";
import { readPmArchive } from "../signals/archive.ts";
import { stablePmKey } from "../mapping/quotient-pm.ts";
import type { PmSignal } from "../signals/types.ts";

// What the markets that have actually resolved say about the signals that called them.
//
//   npm run pm-resolve                # offline, from the committed capture
//   npm run pm-resolve -- --fetch     # refresh the capture from Polymarket's CLOB
//
// This is `tasks/52` §2.1 and §3a.1 — the resolution capture and the calibration read —
// and the front half of §3, *test the risk flags first of all*. It is **not**
// `pm-backtest`: it sweeps nothing, it models no book, and it has no price path, so the
// early-exit counterfactual and the volume/horizon/size sweeps are still owed.
//
// It exists on its own because the two questions it answers do not need any of that
// machinery and were blocking the design:
//
//   - are Quotient's probabilities calibrated? Every EV column in `pm-census` is their
//     own forecast scoring their own signal, so if the answer is no, every ranker in
//     that table is ranking noise (`notes/2026-09-14-hold-to-resolution-and-the-book-
//     that-never-empties.md` §4.3);
//   - do `conviction_tier` and the two risk flags predict anything?
//
// ⚠⚠ **The null is the price, never 50%.** A book bought at a mean 68c *should* win ~68%
// of the time if the market is right and Quotient adds nothing. Reading a 65% win rate as
// a good one is the single easiest mistake here, and it is the one this script is shaped
// to prevent: every group is scored against the wins the market's own prices imply.

const ROOT = process.env.DATA_ROOT ?? "data";
const CAPTURE = "fixtures/pm-resolutions-2026-09-15.json";
const DAY = 864e5;

/** Ours, one leg — redemption is not a trade (`tasks/06` §6, the owner's 2026-09-14
 *  decision to charge 10 bps maker and taker from the first order). */
const BUILDER_BPS = 10;
/** Polymarket's taker fee is `feeRate × p × (1 − p)` per share, so `feeRate × (1 − p)` of
 *  stake; makers pay nothing. 0.05 is the modal rate across the categories this feed
 *  carries, and `feeSensitivity()` prints the whole range rather than trusting it. */
const FEE_RATE = 0.05;

type Capture = {
  captured_at: string;
  source: string;
  markets: Record<string, {
    closed: boolean; end_date_iso: string; market_slug: string; neg_risk: boolean;
    minimum_order_size: number; minimum_tick_size: number;
    tokens: { token_id: string; outcome: string; price: number; winner: boolean }[];
  }>;
};

type Row = {
  key: string; s: PmSignal; firstAt: number; end: number; days: number;
  /** Side-relative, live frame: what a buy of `s.side` would have paid at first sight. */
  p: number;
  /** Side-relative: Quotient's own probability for the same side. */
  q: number;
  win: boolean; gross: number; net: number;
  flagged: boolean; gated: boolean; resolvedEarly: boolean; stem: string;
};

// ---------------------------------------------------------------------------- capture

async function fetchCapture(cids: string[]): Promise<void> {
  const markets: Capture["markets"] = {};
  const queue = [...cids];
  let done = 0;
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const cid = queue.shift();
      if (!cid) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`https://clob.polymarket.com/markets/${cid}`, { signal: AbortSignal.timeout(25_000) });
          if (r.status === 429) {
            await new Promise((z) => setTimeout(z, 2000 * (attempt + 1)));
            continue;
          }
          if (!r.ok) break;
          const m = (await r.json()) as Record<string, unknown>;
          markets[cid] = {
            closed: m.closed as boolean, end_date_iso: m.end_date_iso as string,
            market_slug: m.market_slug as string, neg_risk: m.neg_risk as boolean,
            minimum_order_size: m.minimum_order_size as number,
            minimum_tick_size: m.minimum_tick_size as number,
            tokens: (m.tokens as Capture["markets"][string]["tokens"]) ?? [],
          };
          break;
        } catch {
          await new Promise((z) => setTimeout(z, 1500 * (attempt + 1)));
        }
      }
      if (++done % 25 === 0) process.stderr.write(`  ${done}/${cids.length}\n`);
    }
  };
  // Four at a time. The perps side learned this the expensive way: parallel runs draw
  // 429s that silently drop a whole market rather than erroring.
  await Promise.all(Array.from({ length: 4 }, worker));
  writeFileSync(CAPTURE, JSON.stringify({
    captured_at: new Date().toISOString(), source: "https://clob.polymarket.com/markets/<condition_id>", markets,
  }, null, 1));
  console.log(`captured ${Object.keys(markets).length} of ${cids.length} markets → ${CAPTURE}`);
}

// ------------------------------------------------------------------------------ scoring

/** The entry gate `pm-census` implements, at the loosest floors, plus the one this script
 *  had to add.
 *
 *  ⚠⚠ **`unmappable-outcome` is new and it is a hard rule, not a filter.** One market in
 *  the archive — *US Open WTA: Aryna Sabalenka vs Elena Rybakina* — carries tokens named
 *  for the two players and no YES/NO token at all, while Quotient sends it with
 *  `side: "YES"`. There is no defensible way to turn that side into a token, and guessing
 *  is the substring match that cost OutcomeMaker $192 (`CLAUDE.md`, *unknown asset mapping
 *  → reject the signal*). The mapper `tasks/06` §8 Step 2 builds must make the same
 *  refusal, which is why it is written here first. */
function refusal(s: PmSignal, tokens: { outcome: string }[]): string | null {
  if (s.forecast_status.state === "converged") return "converged";
  if (s.entry_pm > 92) return "above-max-entry";
  if (s.side !== (s.entry_q > s.entry_pm ? "YES" : "NO")) return "side-mismatch";
  const outs = tokens.map((t) => (t.outcome ?? "").toUpperCase());
  if (!(outs.includes("YES") && outs.includes("NO"))) return "unmappable-outcome";
  return null;
}

function build(capture: Capture): { rows: Row[]; pool: PmSignal[]; markets: number; t0: number; t1: number; closed: number } {
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
    const m = s.market.condition_id ? capture.markets[s.market.condition_id] : undefined;
    if (!m?.closed) continue;
    const winner = m.tokens.find((t) => t.winner);
    if (!winner) continue;
    const p = s.current_cost_cents / 100;
    if (!(p > 0 && p <= 1)) continue;
    const end = Date.parse(s.market.end_date);
    const gross = (winner.outcome.toUpperCase() === s.side ? 1 / p : 0) - 1;
    rows.push({
      key, s, firstAt: at, end, days: Math.max(0.25, (end - at) / DAY), p,
      q: s.q_value_cents / 100,
      win: winner.outcome.toUpperCase() === s.side,
      gross, net: gross - FEE_RATE * (1 - p) - BUILDER_BPS / 1e4,
      flagged: s.drawdown_risk_elevated || s.crash_risk_elevated,
      gated: refusal(s, m.tokens) === null,
      resolvedEarly: end > t1,
      stem: (s.market.slug ?? "").replace(/-\d[\d-]*$/, "").split("-").slice(0, 5).join("-"),
    });
  }
  return {
    rows, pool: [...first.values()].map((f) => f.s),
    markets: new Set([...first.values()].map((f) => f.s.market.condition_id)).size,
    t0, t1,
    closed: Object.values(capture.markets).filter((m) => m.closed).length,
  };
}

// --------------------------------------------------------------------------- statistics

const mean = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const sd = (a: number[]): number => {
  const m = mean(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1));
};
function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [NaN, NaN];
  const z = 1.96;
  const ph = k / n;
  const d = 1 + (z * z) / n;
  const c = (ph + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((ph * (1 - ph)) / n + (z * z) / (4 * n * n))) / d;
  return [c - h, c + h];
}
function ciStr(a: number[]): string {
  if (a.length < 2) return "—";
  const se = sd(a) / Math.sqrt(a.length);
  return `${(100 * (mean(a) - 1.96 * se)).toFixed(0)}% … ${(100 * (mean(a) + 1.96 * se)).toFixed(0)}%`;
}

/** The z the whole script is built around: observed wins against the wins the **market's
 *  own prices** imply, under the Poisson-binomial whose mean is Σp and whose variance is
 *  Σp(1−p). Positive means the group beat the price it paid. */
function vsMarket(r: Row[]): { obs: number; exp: number; z: number; claimed: number } {
  const obs = r.filter((x) => x.win).length;
  const exp = r.reduce((a, x) => a + x.p, 0);
  const v = r.reduce((a, x) => a + x.p * (1 - x.p), 0);
  return { obs, exp, z: v > 0 ? (obs - exp) / Math.sqrt(v) : NaN, claimed: r.reduce((a, x) => a + x.q, 0) };
}

function group(label: string, r: Row[]): void {
  if (r.length === 0) return console.log(`  ${label.padEnd(24)} (none)`);
  const { obs, exp, z } = vsMarket(r);
  const [lo, hi] = wilson(obs, r.length);
  console.log(
    `  ${label.padEnd(24)} n=${String(r.length).padStart(3)}  won ${String(obs).padStart(2)} = ${(100 * obs / r.length).toFixed(0).padStart(3)}% [${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}]` +
      `  price implied ${exp.toFixed(1).padStart(4)}  z ${z.toFixed(2).padStart(5)}` +
      `  net ${(100 * mean(r.map((x) => x.net))).toFixed(0).padStart(5)}%  CI ${ciStr(r.map((x) => x.net)).padStart(16)}`,
  );
}

// ------------------------------------------------------------------------------ report

function main(): void {
  const capture = JSON.parse(readFileSync(CAPTURE, "utf8")) as Capture;
  const { rows, pool, markets, t0, t1, closed } = build(capture);
  if (pool.length === 0) {
    console.log(`No Polymarket signals under ${ROOT}/quotient/signals — the archive is on the VPS.`);
    return;
  }

  console.log(`\n=== what the resolved markets say — ${CAPTURE.split("/")[1]} ===\n`);
  console.log(`  what this is and is not:`);
  console.log(`    entry      first sight of each stablePmKey, at current_cost_cents (side-relative, live frame)   yes`);
  console.log(`    exit       the market's own resolution; redemption pays $1 and is not a trade                   yes`);
  console.log(`    costs      taker fee = feeRate x (1-p) of stake at ${FEE_RATE}, plus ${BUILDER_BPS} bps builder, one leg      yes`);
  console.log(`    spread     none. current_cost_cents reads quote_method "midpoint" on 127/127 — we would pay`);
  console.log(`               worse than this, and by how much is unmeasured until a live fill               ⚠ NO`);
  console.log(`    slippage / partial fills / the slot cap / any sweep                                       ⚠ NO`);
  console.log(`    replication against our own ledger — there is no Polymarket ledger yet                    ⚠ NO\n`);

  console.log(`  archive ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} · ${pool.length} keys over ${markets} markets · capture ${capture.captured_at.slice(0, 10)}`);
  console.log(`  markets Polymarket reports closed with a winner: ${closed} of ${Object.keys(capture.markets).length}`);
  const G = rows.filter((r) => r.gated);
  console.log(`  scoreable rows ${rows.length}, of which gated ${G.length}`);
  const reasons = new Map<string, number>();
  for (const r of rows.filter((x) => !x.gated)) {
    const m = capture.markets[r.s.market.condition_id ?? ""];
    const why = refusal(r.s, m?.tokens ?? []) ?? "?";
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
  console.log(`  refused: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);
  const dates = new Set(G.map((r) => new Date(r.end).toISOString().slice(0, 10)));
  const stems = new Map<string, Row[]>();
  for (const r of G) stems.set(r.stem, [...(stems.get(r.stem) ?? []), r]);
  console.log(`  ⚠ those ${G.length} rows span ${dates.size} resolution dates and ${stems.size} slug-stem event groups — the marginal information is well below the marginal n`);
  const early = G.filter((r) => r.resolvedEarly).length;
  console.log(`  ⚠⚠ ${early} of ${G.length} resolved BEFORE their stated end_date. The archive is ${((t1 - t0) / DAY).toFixed(0)} days and the mean hold is ~21,`);
  console.log(`     so a long-dated market can only be in this sample by resolving early — which usually means the`);
  console.log(`     outcome became obvious. Every horizon comparison below inherits that selection.\n`);

  console.log(`--- the whole book, and the null that matters ---`);
  const all = vsMarket(G);
  group("gated", G);
  group("refused by the gate", rows.filter((r) => !r.gated));
  console.log(
    `\n  ⚠⚠ Read that z, not the win rate. ${all.obs} of ${G.length} won; the prices paid implied ${all.exp.toFixed(1)};` +
      `\n     Quotient's own probabilities claimed ${all.claimed.toFixed(1)}. So they claimed ${(all.claimed - all.exp).toFixed(1)} wins more than the market` +
      `\n     and delivered ${(all.obs - all.exp).toFixed(1)}. A ${(100 * all.obs / G.length).toFixed(0)}% win rate on a book bought at a mean ${(100 * mean(G.map((r) => r.p))).toFixed(0)}c is not an edge — it is the price.\n`,
  );

  console.log(`--- conviction_tier ---`);
  for (const t of [...new Set(G.map((r) => r.s.conviction_tier))].sort()) group(`tier ${t} (${G.find((r) => r.s.conviction_tier === t)?.s.conviction})`, G.filter((r) => r.s.conviction_tier === t));

  console.log(`\n--- the risk flags ---`);
  const dd = pool.filter((s) => s.drawdown_risk_elevated).length;
  const cr = pool.filter((s) => s.crash_risk_elevated).length;
  const one = pool.filter((s) => s.drawdown_risk_elevated !== s.crash_risk_elevated).length;
  console.log(`  ⚠⚠ over all ${pool.length} keys: drawdown_risk_elevated ${dd} · crash_risk_elevated ${cr} · exactly one of them ${one}`);
  console.log(`     They are the same field. ${one === 0 ? "Nothing in this archive distinguishes them, so ranking on both is ranking on one." : "They differ, so this line is stale — re-read it."}`);
  group("neither flag", G.filter((r) => !r.flagged));
  group("flagged", G.filter((r) => r.flagged));

  console.log(`\n--- forecast_status.state ---`);
  for (const st of [...new Set(G.map((r) => r.s.forecast_status.state))].sort()) group(st, G.filter((r) => r.s.forecast_status.state === st));

  console.log(`\n--- days to resolution at entry  ⚠ selection-biased, see above ---`);
  for (const [lo, hi] of [[0, 3], [3, 7], [7, 14], [14, 9999]] as const) {
    const b = G.filter((r) => r.days >= lo && r.days < hi);
    group(`${lo}–${hi === 9999 ? "∞" : hi}d (early ${b.filter((r) => r.resolvedEarly).length})`, b);
  }

  console.log(`\n--- claimed edge, q − p ---`);
  for (const [lo, hi] of [[-100, 5], [5, 15], [15, 30], [30, 200]] as const)
    group(`${lo}–${hi}pp`, G.filter((r) => 100 * (r.q - r.p) >= lo && 100 * (r.q - r.p) < hi));

  console.log(`\n=== calibration — is the vendor a better forecaster than the price? ===\n`);
  const brier = (f: (x: Row) => number): number => mean(G.map((x) => (f(x) - (x.win ? 1 : 0)) ** 2));
  console.log(`  n=${G.length}   (lower Brier is better)`);
  console.log(`    Quotient  q_value_cents   ${brier((x) => x.q).toFixed(4)}`);
  console.log(`    the market current_cost   ${brier((x) => x.p).toFixed(4)}`);
  console.log(`    a coin    always 0.50     ${brier(() => 0.5).toFixed(4)}`);
  console.log(`\n  their probability against what happened:`);
  console.log(`    bucket       n   claimed   realised`);
  for (const [lo, hi] of [[0, 0.5], [0.5, 0.7], [0.7, 0.85], [0.85, 1.01]] as const) {
    const b = G.filter((x) => x.q >= lo && x.q < hi);
    if (!b.length) continue;
    console.log(`    ${`${(100 * lo).toFixed(0)}–${(100 * hi).toFixed(0)}%`.padEnd(11)}${String(b.length).padStart(3)}   ${(100 * mean(b.map((x) => x.q))).toFixed(0).padStart(6)}%   ${(100 * mean(b.map((x) => (x.win ? 1 : 0)))).toFixed(0).padStart(7)}%`);
  }

  console.log(`\n=== one vote per event ===\n`);
  const multi = [...stems].filter(([, v]) => v.length > 1).sort((a, b) => b[1].length - a[1].length);
  for (const [stem, v] of multi.slice(0, 5)) console.log(`  ${String(v.length).padStart(2)} rows · ${v.filter((x) => x.win).length} won · ${stem}`);
  const perEvent = [...stems.values()].map((v) => mean(v.map((x) => x.net)));
  console.log(`\n  ${G.length} rows are ${stems.size} events. Averaging inside each event first:`);
  console.log(`    mean net ${(100 * mean(perEvent)).toFixed(0)}%  CI ${ciStr(perEvent)}  (n=${perEvent.length})`);
  const biggest = multi[0];
  if (biggest) {
    const without = G.filter((r) => r.stem !== biggest[0]);
    const w = vsMarket(without);
    console.log(`    drop the largest group (${biggest[1].length} rows, ${biggest[1].filter((x) => x.win).length} won): n=${without.length} won ${w.obs} against ${w.exp.toFixed(1)} implied, z ${w.z.toFixed(2)}, mean net ${(100 * mean(without.map((r) => r.net))).toFixed(0)}%`);
  }

  console.log(`\n=== does the sign turn on the fee? ===\n`);
  for (const f of [0, 0.04, 0.05, 0.07]) {
    const n = G.map((r) => r.gross - f * (1 - r.p) - BUILDER_BPS / 1e4);
    console.log(`  taker, feeRate ${f.toFixed(2)}   mean ${(100 * mean(n)).toFixed(1).padStart(6)}%   CI ${ciStr(n)}`);
  }
  const mk = G.map((r) => r.gross - BUILDER_BPS / 1e4);
  console.log(`  maker, no platform fee  mean ${(100 * mean(mk)).toFixed(1).padStart(6)}%   CI ${ciStr(mk)}`);
  console.log(`\n  ⚠ The fee moves the mean by ~${(100 * (mean(G.map((r) => r.gross - BUILDER_BPS / 1e4)) - mean(G.map((r) => r.net)))).toFixed(1)}pp and the interval is ±${(100 * 1.96 * sd(G.map((r) => r.net)) / Math.sqrt(G.length)).toFixed(0)}pp wide.`);
  console.log(`    So the fee is not what decides this book either way, and \`tasks/52\` §0's refusal — *an edge that`);
  console.log(`    does not survive the exact fee curve* — is not the reading available here. What is available is`);
  console.log(`    the z above: this book did not beat the prices it paid, and the fee is a rounding error beside that.\n`);
}

const args = process.argv.slice(2);
if (args.includes("--fetch")) {
  const polls = readPmArchive(ROOT);
  const cids = [...new Set(polls.flatMap((p) => p.signals).filter((s) => s.market.venue === "polymarket").map((s) => s.market.condition_id).filter((c): c is string => !!c))];
  console.log(`fetching ${cids.length} markets from Polymarket's CLOB (unauthenticated)…`);
  void fetchCapture(cids).then(main);
} else {
  main();
}
