import "dotenv/config";
import { excludeSyntheticSql, syntheticNote } from "../store/synthetic.ts";
import { join } from "node:path";
import { isTestnet, makeInfoClient } from "../hl/clients.ts";
import { Universe } from "../hl/universe.ts";
import { GATE } from "../exec/loop.ts";
import { evaluateSeries, stableOutlookId } from "../mapping/quotient.ts";
import type { PerpsSeries } from "../signals/types.ts";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { regimeAt, FEED_REGIMES } from "../risk/regimes.ts";
import { Store } from "../store/db.ts";
import { readArchive } from "../signals/archive.ts";

// `tasks/02` — expectancy, read from the live ledger and the recorded archive.
//
//   npm run expectancy              # the count, then the live read
//   npm run expectancy -- --archive-only
//
// **This is deliberately not the simulator.** `tasks/02` says its next reading "starts
// by re-running that count, not by writing a simulator", and the count is the thing
// that decides whether a simulator would mean anything. Writing one before the sample
// exists is how a gate becomes theatre — the exact failure the task was moved to
// avoid. Everything printed below is measured; nothing is modelled.
//
// The entry gate is **imported**, never reimplemented: `evaluateSeries` and `GATE` are
// the same functions and the same constants the executor runs. A backtest with its own
// copy of the gate measures a strategy we do not run.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

/** `tasks/02`: under this many distinct tradeable events, no statistical claim is
 *  available and the honest output is "keep recording". */
const SAMPLE_FLOOR = 30;

// `readArchive` moved to `src/signals/archive.ts` on 2026-09-13, beside the writer, so
// the watchdog could read the archive without importing the executor through here. It is
// re-exported because every reading and every note cites it from this file.
export { readArchive, type Poll } from "../signals/archive.ts";
import { contractSpan } from "../signals/contract.ts";

function pct(n: number): string {
  return `${(n * 100).toFixed(2)}%`;
}

/** Mean and a 95% confidence interval on it.
 *
 *  Normal, not t, and it does not matter: at n=9 neither is a defensible interval and
 *  the point of printing one is to show how wide it is. `tasks/02` asks for a CI
 *  rather than a point estimate precisely so that a short winning streak cannot be
 *  read as edge. */
function meanCi(xs: number[]): { n: number; mean: number; sd: number; lo: number; hi: number } {
  const n = xs.length;
  if (n === 0) return { n, mean: 0, sd: 0, lo: 0, hi: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n < 2 ? 0 : Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const half = 1.96 * sd / Math.sqrt(n);
  return { n, mean, sd, lo: mean - half, hi: mean + half };
}

// ── the collapse, and the two things it must never average ────────────────────────
//
// One **signal** is one event, however many accounts traded it. Each account's trip is
// the same trade at a different size, so they are combined as a return on the margin
// posted rather than summed as dollars — summing would count one forecast three times
// and would weight it by whoever happened to be funded that day.
//
// **That rests on the accounts differing only in size**, and there are two ways for it
// to stop being true. Both used to fail silently — the collapse kept returning a number
// and the number stopped meaning what the label said (`tasks/32`):
//
//   1. **`hold_to_target`.** One account leaves when the call goes neutral, the other on
//      a level or the horizon. That is the same entry with genuinely different outcomes,
//      so the trips split into two arms and are never averaged into one.
//   2. **The feed regime.** What was offered changed under us four times, twice by our
//      own hand (`src/risk/regimes.ts`). Three regimes are three populations, not one
//      sample of 42, so reaching a projected n by adding events from a fourth feed
//      answers a question nobody asked (`tasks/31` §1).
//
// A **block** is one regime and one exit policy, and a block is the only thing here that
// may be read as an estimate of anything.

export type TripRow = {
  signalRef: string;
  /** Which account ran this leg. The statistic below that does not move when a new
   *  account is funded is built by summing an account's legs first and averaging
   *  over accounts second, so the account has to be on the row. */
  account: string;
  netPnl: number;
  marginUsd: number;
  /** What this leg was actually traded at. Neither is averaged into a return — they
   *  are counted, so a per-signal figure can say how many different desks it is the
   *  mean of. `armedStopPct` is `stop_px` against `ref_px`, i.e. what `clampStopPct`
   *  left of what the owner asked for; null when the position carried no stop. */
  leverage: number;
  armedStopPct: number | null;
  /** This leg's **price** return, signed by side: `exit/entry − 1` for a long, negated
   *  for a short. Null when the venue never gave the trip an exit price.
   *
   *  The one unit here that does not depend on who was funded. Return on margin is
   *  `leverage × this`, so the same price move is 10% of margin at 5x and 40% at 20x,
   *  and a mean of margin returns across accounts describes whichever mix happened to
   *  be funded that day (`notes/2026-09-12-the-analysis-layer-audited.md` §3). */
  priceRet: number | null;
  coin: string;
  mode: string;
  assetClass: string;
  anchorType: string;
  openedAt: Date;
  closedAt: Date;
  holdToTarget: boolean;
};

export type Event = {
  ref: string;
  /** **Mean of trips, % of margin posted.** What every reading since 2026-09-02 has
   *  called "per signal". Kept, labelled, and no longer the number the decision quotes:
   *  it averages across leverages, across stops and across re-entry legs, so for
   *  `xyz:NATGAS` it read +4.2% where an account that followed the call made +22%. */
  ret: number;
  /** **Mean over accounts of the sum of that account's legs, % of margin posted.**
   *  What one account following this call made, averaged over the accounts that
   *  followed it. Re-entries are summed rather than averaged, which is the difference
   *  from `ret`. Still carries the leverage mix. */
  retAccounts: number;
  /** **The same sum, in price** — leverage-invariant, and the figure the decision line
   *  quotes. Null when no account had a venue exit price on every one of its legs;
   *  `priceAccounts` is how many accounts it rests on. */
  priceRet: number | null;
  /** The price return averaged over **trips** rather than over accounts' leg-sums —
   *  the same relation to `priceRet` that `ret` has to `retAccounts`, printed so the
   *  re-entry effect is visible rather than argued. */
  priceRetTrips: number | null;
  /** `priceRet` with each leg multiplied by the leverage it actually ran at: the desk's
   *  own leverage applied to the price path. It sits between `priceRet × L` for a
   *  reference leverage and `retAccounts`, which is what lets the gap between the
   *  reference account and the desk be split into population and exits. */
  leveredPriceRet: number | null;
  trips: number;
  /** Distinct accounts, the widest leg count any one of them ran, and how many
   *  distinct leverages and armed stops are inside the means above. */
  accounts: number;
  maxLegs: number;
  leverages: number;
  stops: number;
  priceAccounts: number;
  hours: number;
  coin: string;
  mode: string;
  assetClass: string;
  anchorType: string;
  holdToTarget: boolean;
  regime: string;
  openedAt: Date;
  /** The **first** trip's close, which is what `hours` is measured to. A re-entering
   *  account's later legs run past it; this is the moment the call was first resolved. */
  closedAt: Date;
};

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Every settled account-trip in a ledger, as the rows the collapse takes.
 *
 *  **Exported because `backtest`'s replication row has to compare against the number
 *  this script prints, not against its own idea of the same number.** `tasks/47` Rule 3
 *  asks a simulator to model the desk as run and print its per-signal price return
 *  against the ledger's; two queries that differ in what they call a closing fill, or in
 *  whether they exclude the synthetic rows, would make that comparison a measurement of
 *  the SQL rather than of the simulator — and it would fail in the flattering direction,
 *  because the gap would be attributed to the model and fixed there.
 *
 *  Read-only by construction: the caller owns the `Store` and this never writes. */
export function loadTrips(store: Store): {
  rows: Record<string, unknown>[]; settled: Record<string, unknown>[]; trips: TripRow[];
} {
  // Joined on the **outlook**, not on the exact revision. `asset_class`, `mode` and
  // `anchor_type` are properties of the outlook and do not change across a revision,
  // and the live ledger already holds one intent recorded at revision 215 whose stored
  // signal row is 216 — an exact join drops that trade's metadata and reports it as
  // `?/?/?` for no reason a reader could act on. Done here rather than in SQL because
  // SQLite will not correlate an outer column into a subquery's ORDER BY.
  const meta = new Map<string, { mode: string; raw: string }>();
  for (const r of store.db.prepare("SELECT signal_ref, mode, raw FROM signals ORDER BY revision")
    .all() as unknown as { signal_ref: string; mode: string; raw: string }[]) {
    meta.set(r.signal_ref, { mode: r.mode, raw: r.raw });
  }
  // The venue's own exit price, volume-weighted across the closing fills, is what makes
  // the price return readable — `intents` stores the entry and not the exit. Same join
  // `stop-sweep`, `exit-policy` and the share card use, and it includes `Liquidat%`
  // for the same reason they do: a liquidation is an exit at a price.
  const rows = (store.db.prepare(
    `SELECT i.*, x.exit_px FROM intents i
     LEFT JOIN (SELECT intent_id, SUM(px * sz) / SUM(sz) AS exit_px FROM fills
                WHERE intent_id IS NOT NULL AND (dir LIKE 'Close%' OR dir LIKE 'Liquidat%')
                GROUP BY intent_id) x ON x.intent_id = i.intent_id
     WHERE i.status = 'closed' AND ${excludeSyntheticSql("i.intent_id")} ORDER BY i.closed_at`)
    .all() as unknown as Record<string, unknown>[])
    .map((r): Record<string, unknown> =>
      ({ ...r, sig_mode: meta.get(String(r.signal_ref))?.mode, sig_raw: meta.get(String(r.signal_ref))?.raw }));

  const settled = rows.filter((r) => r.net_pnl !== null);

  const trips = settled.map((r): TripRow => {
    const raw = typeof r.sig_raw === "string" ? JSON.parse(r.sig_raw) as PerpsSeries : null;
    const entry = r.entry_px === null ? null : Number(r.entry_px);
    const exit = r.exit_px === null || r.exit_px === undefined ? null : Number(r.exit_px);
    const refPx = Number(r.ref_px);
    const stopPx = r.stop_px === null ? null : Number(r.stop_px);
    return {
      signalRef: String(r.signal_ref),
      account: String(r.account),
      netPnl: Number(r.net_pnl), marginUsd: Number(r.margin_usd), coin: String(r.coin),
      leverage: Number(r.leverage),
      armedStopPct: stopPx === null || !(refPx > 0) ? null : Math.abs(refPx - stopPx) / refPx,
      priceRet: entry === null || exit === null || !(entry > 0) ? null
        : (String(r.side) === "long" ? 1 : -1) * (exit / entry - 1),
      mode: String(r.sig_mode ?? "?"),
      assetClass: raw?.asset_class ?? "?",
      anchorType: raw?.anchor_type ?? "?",
      openedAt: new Date(String(r.created_at)),
      closedAt: new Date(String(r.closed_at)),
      holdToTarget: Number(r.hold_to_target) === 1,
    };
  });
  return { rows, settled, trips };
}

/** Account-trips to events, splitting rather than averaging where the assumption
 *  behind the collapse does not hold.
 *
 *  The regime comes from the **earliest** trip's `created_at`: accounts are ticked in
 *  one loop seconds apart, so a signal straddling a boundary is one event that opened
 *  before it, not two. The exit policy is not treated that way, because it is a
 *  property of the trip and not of the moment.
 *
 *  **Three statistics come out, not one, and they differ for reasons the label used to
 *  hide** (`tasks/46` §1.1). `ret` averages every account-trip: two accounts at 10x and
 *  20x on the same call contribute 20% and 40% of margin for the same price move, and
 *  an account that re-entered four times contributes four draws. `retAccounts` sums
 *  each account's legs first, so a re-entering account is one follower of one call, and
 *  averages over accounts second, so the count of followers weights nothing. `priceRet`
 *  does the same in price, where the leverage cancels — the only one of the three that
 *  cannot move because somebody new was funded. */
export function collapse(rows: TripRow[]): Event[] {
  const groups = new Map<string, TripRow[]>();
  for (const r of rows) {
    // The refusal, and it is one line: the key carries the exit policy, so two accounts
    // holding one signal under different policies can never land in the same average.
    const key = `${r.signalRef}\u0000${r.holdToTarget ? "1" : "0"}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((trips) => {
    const first = trips.reduce((a, b) => (b.openedAt < a.openedAt ? b : a));

    const byAccount = new Map<string, TripRow[]>();
    for (const t of trips) byAccount.set(t.account, [...(byAccount.get(t.account) ?? []), t]);
    const legs = [...byAccount.values()];

    // An account contributes to the price statistics only if **every** one of its legs
    // has a venue exit price. A partial sum is not a smaller sample of the same thing:
    // it is one account's return with a leg silently deleted, which is the flattering
    // direction whenever the missing leg is the one that lost.
    const priced = legs.filter((ls) => ls.every((t) => t.priceRet !== null));
    const priceRet = priced.length === 0 ? null
      : mean(priced.map((ls) => ls.reduce((a, t) => a + (t.priceRet as number), 0)));
    const leveredPriceRet = priced.length === 0 ? null
      : mean(priced.map((ls) => ls.reduce((a, t) => a + (t.priceRet as number) * t.leverage, 0)));
    const pricedTrips = trips.filter((t) => t.priceRet !== null);

    return {
      ref: first.signalRef,
      ret: mean(trips.map((t) => t.netPnl / t.marginUsd)),
      retAccounts: mean(legs.map((ls) => ls.reduce((a, t) => a + t.netPnl / t.marginUsd, 0))),
      priceRet,
      priceRetTrips: pricedTrips.length === 0 ? null : mean(pricedTrips.map((t) => t.priceRet as number)),
      leveredPriceRet,
      trips: trips.length,
      accounts: legs.length,
      maxLegs: Math.max(...legs.map((ls) => ls.length)),
      leverages: new Set(trips.map((t) => t.leverage)).size,
      // Rounded to a basis point before counting: the armed stop is `stop_px / ref_px`
      // off two venue-rounded prices, so two legs of the same 2% ask differ in the
      // twelfth decimal and would count as two settings.
      stops: new Set(trips.map((t) => t.armedStopPct === null ? "off" : (t.armedStopPct * 10_000).toFixed(0))).size,
      priceAccounts: priced.length,
      hours: (first.closedAt.getTime() - first.openedAt.getTime()) / 3600_000,
      coin: first.coin, mode: first.mode, assetClass: first.assetClass, anchorType: first.anchorType,
      holdToTarget: first.holdToTarget,
      regime: regimeAt(first.openedAt).name,
      openedAt: first.openedAt,
      closedAt: first.closedAt,
    };
  });
}

export type Block = { regime: string; holdToTarget: boolean; events: Event[] };

// ── the reference account, and the gap between it and the desk ─────────────────────
//
// `tasks/47` Rule 2. The headline has to be invariant to who is funded, and the way the
// desk's own figure fails that is not subtle: between 2026-09-10 14:06Z and 18:08Z seven
// accounts connected at the defaults beside four running 5x/8%, 10x/3%, 20x/2% and
// 10x/3.5%, and the number moved for a reason that was not the strategy.
//
// So one fixed account follows every signal the desk traded — the shipped default, one
// leg-set per account, scored on the **price** return — and the desk's own return on
// margin is printed beside it. Whatever separates them is then split two ways and each
// half is named, because "the desk did worse than the reference" is three different
// findings until you know which:
//
//   **population** — the desk ran leverages the reference does not. Pure arithmetic on
//   the same price path; it says nothing about the signals or the exits.
//   **exits and costs** — what is left once the desk's own leverage is applied to that
//   price path: stops that fired where the reference held, holds that ran where the
//   reference stopped, fees, funding, and the slippage band on every entry and exit.
//
// On 09-11 this would have read reference −8.5% of mandate against a desk at −4.7% on
// margin, and the split says the signals, not the cohort (`tasks/47` §0).

/** The reference account's settings. `item 29d` in `docs/STATUS.md` is whether a second
 *  reference at 5x / 5% — the weakest combination the site offers — earns its column;
 *  until that is answered this is the shipped default, which is what the whole live
 *  ledger before 2026-09-10 was traded under. */
export const REFERENCE_SETTINGS = {
  leverage: DEFAULT_USER_SETTINGS.leverage,
  perSignalPct: DEFAULT_USER_SETTINGS.perSignalPct,
} as const;

export type Reference = {
  /** Signals with a usable price return, which is the denominator of every figure
   *  here and is **not** `events.length` when a trip is missing its venue exit. */
  n: number;
  /** Mean over signals of the price return one follower earned. */
  priceRet: number;
  /** That times the reference leverage — directly comparable to `desk`. */
  onMargin: number;
  /** Rolled to a mandate and summed over the window: what a reference account would
   *  have shown on its own statement. `Σ priceRet × leverage × perSignalPct ×
   *  (1 − reserveFrac)`, the reserve factor being the same one `stopOutOfMandate` and
   *  `backtest`'s mandate column apply. Compounds nothing. */
  ofMandate: number;
  /** The desk's own figure on the same signals: mean over signals of the mean over
   *  accounts of each account's summed legs, on margin. */
  desk: number;
  /** `desk − onMargin`, split. The two sum to the gap exactly. */
  population: number;
  exits: number;
};

/** The reference account over a set of events, or null when none of them has a price
 *  return. Every figure is over the same subset, so the decomposition is exact. */
export function reference(events: Event[]): Reference | null {
  const usable = events.filter((e) => e.priceRet !== null && e.leveredPriceRet !== null);
  if (usable.length === 0) return null;
  const priceRet = mean(usable.map((e) => e.priceRet as number));
  const onMargin = priceRet * REFERENCE_SETTINGS.leverage;
  const desk = mean(usable.map((e) => e.retAccounts));
  const levered = mean(usable.map((e) => e.leveredPriceRet as number));
  return {
    n: usable.length,
    priceRet,
    onMargin,
    ofMandate: usable.reduce((a, e) => a + (e.priceRet as number), 0)
      * REFERENCE_SETTINGS.leverage * REFERENCE_SETTINGS.perSignalPct * (1 - RISK_PARAMS.reserveFrac),
    desk,
    population: levered - onMargin,
    exits: desk - levered,
  };
}

// ── what changed inside the block, and when that makes it unscoreable ──────────────
//
// `tasks/47` Rule 1. Between 09-10 08:18Z and 09-11 10:45Z the desk moved σ twice, the
// stop default once and the re-entry rule once, admitted seven accounts, and read a
// per-signal figure off the result. No block after 09-08 has one change in it, so no
// reading in that window could attribute anything — and nothing said so.
//
// The refusal is on `config` events, which the executor writes at boot when a money
// constant's hash moves (`tasks/47` step 1, **deployed 2026-09-13** — the reader landed
// first, deliberately, so the writer had somewhere to land). ⚠ A **first boot** writes
// one too, and it counts: since `tasks/50` §2.2 the first boot is a change on both sides
// of Rule 1, so the block it opens holds one event and the next change is inside it.
// `settings` events are counted beside them: they are the operator's own moves, and the
// 09-10 mass rewrite of ten accounts is visible today as thirteen of them.

export type Change = { at: Date; kind: string; account: string; detail: string };

/** The changes that landed inside a block's own window — its first open to its last
 *  close. A change after the last trade closed belongs to the next block, and a change
 *  before the first trade opened is what defined this one. */
export function changesIn(block: Block, changes: Change[]): Change[] {
  const from = Math.min(...block.events.map((e) => e.openedAt.getTime()));
  const to = Math.max(...block.events.map((e) => e.closedAt.getTime()));
  return changes.filter((c) => c.at.getTime() >= from && c.at.getTime() <= to);
}

/** A block holding more than one `config` event mixes two desks, and no mean over its
 *  events is an estimate of either. Settings events do not trigger the refusal — they
 *  reach one account each and the cohort columns are what read them — but they are
 *  printed, because ten of them in a night is the other half of what happened. */
export function scoreable(changes: Change[]): boolean {
  return changes.filter((c) => c.kind === "config").length <= 1;
}

/** Events to homogeneous blocks, **newest first** — newest by the most recent event in
 *  the block, so the head is the block the desk is trading in today. `tasks/31` §1: a
 *  homogeneous block with 30 events beats a pooled 124. */
export function blocks(events: Event[]): Block[] {
  const groups = new Map<string, Event[]>();
  for (const e of events) {
    const key = `${e.regime}\u0000${e.holdToTarget ? "1" : "0"}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const latest = (es: Event[]) => Math.max(...es.map((e) => e.openedAt.getTime()));
  return [...groups.values()]
    .sort((a, b) => latest(b) - latest(a))
    .map((es) => ({ regime: es[0]!.regime, holdToTarget: es[0]!.holdToTarget, events: es }));
}

async function main(): Promise<void> {
  console.log(`network: ${isTestnet() ? "TESTNET" : "MAINNET"}   ledger: ${LEDGER}`);
  console.log(`${syntheticNote()}\n`);

  // ── 1. The count. This is what decides whether anything else here means anything ──

  /** Tradeable events per day, per feed regime — what the decision line's date rests on. */
  const archiveRate = new Map<string, { events: number; days: number }>();
  const polls = readArchive(DATA_ROOT);
  if (polls.length === 0) {
    console.log(`no archive under ${join(DATA_ROOT, "quotient", "perps")} — pull it from the VPS first`);
  } else {
    const first = polls[0]!.t, last = polls.at(-1)!.t;
    const hours = (last.getTime() - first.getTime()) / 3600_000;
    console.log(`═══ archive: ${polls.length} polls over ${hours.toFixed(1)}h ═══`);
    console.log(`    ${first.toISOString()} → ${last.toISOString()}`);

    // Gaps in the poll timeline. Absence is not a neutral sample: if the recorder was
    // down, those signals are simply missing, and `tasks/02` names this as a trap.
    const gaps: string[] = [];
    for (let i = 1; i < polls.length; i++) {
      const dt = (polls[i]!.t.getTime() - polls[i - 1]!.t.getTime()) / 60_000;
      if (dt > 45) gaps.push(`${polls[i - 1]!.t.toISOString()} +${dt.toFixed(0)}min`);
    }
    console.log(`    gaps over 45 min: ${gaps.length === 0 ? "none" : gaps.join(", ")}`);

    const universe = await Universe.load(makeInfoClient());
    const passed = new Set<string>();
    // When each tradeable outlook was **first** seen, not merely that it was: the rate
    // the decision line quotes has to be the rate of the feed we are on now, and an
    // outlook that first appeared under the old feed is not evidence about this one.
    const mapped = new Map<string, Date>();
    const seen = new Set<string>();
    const byReason = new Map<string, Set<string>>();
    for (const poll of polls) {
      for (const s of poll.series) {
        const id = stableOutlookId(s.outlook.outlook_id);
        seen.add(id);
        const ev = evaluateSeries(s, poll.t, GATE);
        if (ev.ok) {
          passed.add(id);
          if (universe.resolve(ev.call.coin) && !mapped.has(id)) mapped.set(id, poll.t);
        } else {
          const set = byReason.get(ev.reason) ?? new Set<string>();
          // A signal counts once per reason, not once per poll — the whole point of
          // `tasks/10`, and the same arithmetic error here would inflate this table
          // by the number of polls.
          set.add(id);
          byReason.set(ev.reason, set);
        }
      }
    }
    console.log(`    distinct outlooks seen:            ${seen.size}`);
    console.log(`    passed the executor's gate:        ${passed.size}`);
    console.log(`    …and resolve to an HL market:      ${mapped.size}   ← distinct tradeable events`);
    console.log("    refused, by reason (distinct outlooks, not poll-repeats):");
    for (const [reason, set] of [...byReason].sort((a, b) => b[1].size - a[1].size)) {
      console.log(`      ${reason.padEnd(28)} ${String(set.size).padStart(4)}`);
    }

    // The same events again, per feed regime, with each regime's own share of the
    // archive under it. One number per regime rather than one over the lot: on the
    // reverted feed σ1.0 alone yields 13 events a day against 3.8 before 09-04 and
    // 0.0–0.5 during the famine (`tasks/31` §2), so an average across all three
    // describes no feed that has ever existed — and it was the input that made
    // reverting look like it cost a month.
    console.log("    tradeable events per day, by feed regime (`src/risk/regimes.ts`):");
    for (const r of FEED_REGIMES) {
      const from = Date.parse(r.from);
      const next = FEED_REGIMES[FEED_REGIMES.indexOf(r) + 1];
      const to = next ? Date.parse(next.from) : Infinity;
      const inR = polls.filter((p) => p.t.getTime() >= from && p.t.getTime() < to);
      if (inR.length === 0) continue;
      const n = [...mapped.values()].filter((t) => t.getTime() >= from && t.getTime() < to).length;
      const days = (inR.at(-1)!.t.getTime() - inR[0]!.t.getTime()) / 86_400_000;
      archiveRate.set(r.name, { events: n, days });
      console.log(
        `      ${r.name.padEnd(15)} ${String(n).padStart(4)} events over ${days.toFixed(1)}d` +
        `   = ${(days > 0 ? n / days : 0).toFixed(1)}/day`,
      );
    }
  }

  if (process.argv.includes("--archive-only")) return;

  // ── 2. The live read, which `tasks/08` made possible ────────────────────────

  const store = new Store(LEDGER, { readOnly: true });
  const { rows, settled, trips } = loadTrips(store);
  console.log(`\n═══ live ledger: ${rows.length} closed intents, ${settled.length} settled net of costs ═══`);
  const events = collapse(trips);

  const unpriced = trips.filter((t) => t.priceRet === null).length;
  console.log(`    distinct signals traded: ${events.length}   (from ${settled.length} account-trips)`);
  if (unpriced > 0) {
    console.log(`    ${unpriced} trip(s) have no venue exit price and are outside every price-return figure below.`);
  }

  // When each account came in, for the cohort split. `connections.created_at` is the
  // connect flow's own row; the operator's accounts never went through it and fall back
  // to `accounts.connected_at`. An account in neither is its own cohort rather than a
  // silent member of the oldest one.
  const cohortOf = new Map<string, string>();
  for (const t of ["SELECT account, connected_at AS at FROM accounts",
                   "SELECT account, created_at AS at FROM connections"]) {
    for (const r of store.db.prepare(t).all() as unknown as { account: string; at: string }[]) {
      cohortOf.set(r.account.toLowerCase(), r.at.slice(0, 10));
    }
  }

  // `tasks/47` Rule 1's read half. `config` is written by the executor at boot when a
  // money constant moves — the writer shipped 2026-09-13, a fortnight after this reader,
  // and the box's first boot wrote one row. The refusal below can fire from the second.
  const changes = (store.db.prepare(
    "SELECT at, account, kind, detail FROM events WHERE kind IN ('config','settings','mandate') ORDER BY at")
    .all() as unknown as { at: string; account: string; kind: string; detail: string }[])
    .map((r): Change => ({ at: new Date(r.at), account: r.account, kind: r.kind, detail: r.detail }));

  // ── 2a. Blocks. The only unit that may be read as an estimate of anything ───

  const bs = blocks(events);
  const head = bs[0];
  if (!head) {
    console.log("\n\u2550\u2550\u2550 decision \u2550\u2550\u2550\n    no settled trades. Keep recording.");
    store.close();
    return;
  }
  // **Three columns where there was one, and the third is the one to read.** The first
  // is what every reading since 09-02 has quoted; the second stops a re-entering
  // account counting four times; the third drops the leverage mix as well, so it cannot
  // move because a 20x account was funded (`tasks/46` §1.1).
  console.log(`\n═══ blocks — one feed regime, one exit policy ═══`);
  console.log(`    ${"regime".padEnd(15)}${"exit".padEnd(9)}${"n".padStart(4)}   ` +
    `${"mean of trips".padStart(13)}   ${"acct leg-sums".padStart(13)}   ${"price return".padStart(12)}   ` +
    `${"95% CI (price)".padStart(21)}   hit`);
  for (const b of bs) {
    const changed = changesIn(b, changes);
    const c = meanCi(b.events.map((e) => e.ret));
    const ca = meanCi(b.events.map((e) => e.retAccounts));
    const priced = b.events.filter((e) => e.priceRet !== null).map((e) => e.priceRet as number);
    const cp = meanCi(priced);
    // Counted on the price return, like the interval beside it, so the column and the
    // CI are about the same set of signals rather than two that nearly coincide.
    const w = priced.filter((x) => x > 0).length;
    const head4 = `    ${b.regime.padEnd(15)}${(b.holdToTarget ? "hold" : "retire").padEnd(9)}${String(c.n).padStart(4)}   `;
    if (!scoreable(changed)) {
      // The refusal. It prints the sample and the events and no mean, because a mean
      // over two desks is not an estimate of either of them (`tasks/47` Rule 1).
      console.log(head4 + `${changed.filter((x) => x.kind === "config").length} config events inside this block: NOT SCOREABLE`
        + (b === head ? "   ← newest" : ""));
      continue;
    }
    console.log(
      head4 +
      `${pct(c.mean).padStart(13)}   ${pct(ca.mean).padStart(13)}   ` +
      `${(priced.length === 0 ? "—" : pct(cp.mean)).padStart(12)}   ` +
      `${(priced.length === 0 ? "—" : `${pct(cp.lo)} … ${pct(cp.hi)}`).padStart(21)}   ${w}/${cp.n}` +
      (b === head ? "   ← newest" : ""),
    );
  }
  console.log(
    `    mean of trips = every account-trip averaged, % of margin posted — mixed leverage, mixed\n` +
    `    stops, one draw per re-entry leg. acct leg-sums = each account's legs summed first, then\n` +
    `    averaged over accounts, still % of margin. price return = the same leg-sums in price, which\n` +
    `    is what a follower's leverage multiplies. The CI is on the price return.`,
  );
  for (const b of bs) {
    const changed = changesIn(b, changes);
    if (changed.length === 0) continue;
    const cfg = changed.filter((x) => x.kind === "config").length;
    const set = changed.filter((x) => x.kind === "settings").length;
    const man = changed.filter((x) => x.kind === "mandate").length;
    console.log(`    inside ${b.regime}/${b.holdToTarget ? "hold" : "retire"}: ` +
      `${cfg} config, ${set} settings, ${man} mandate` +
      (scoreable(changed) ? "" : "   ← not scoreable"));
    for (const c of changed.filter((x) => x.kind === "config")) {
      console.log(`      ${c.at.toISOString()}  config  ${c.detail}`);
    }
  }

  // ── 2b. Every event, tagged with the block it belongs to ────────────────────
  //
  // The leverage and stop counts are here rather than in a note because they are what
  // decides whether the row's mean is one number or several averaged: `xyz:NATGAS 21
  // trips, 3 leverages, 4 stops, 6 legs` is a different object from `BTC 1 trip`.

  console.log("");
  for (const e of [...events].sort((a, b) => (b.priceRet ?? b.ret) - (a.priceRet ?? a.ret))) {
    console.log(
      `    ${(e.priceRet === null ? "—" : pct(e.priceRet)).padStart(8)} price   ` +
      `${pct(e.retAccounts).padStart(8)} margin   ${pct(e.ret).padStart(8)} /trip   ` +
      `${e.coin.padEnd(13)} ${String(e.accounts)} acct ${String(e.trips).padStart(2)} trips ` +
      `${e.leverages} lev ${e.stops} stops ${e.maxLegs} legs max  ` +
      `${e.hours.toFixed(1)}h  ${e.assetClass}/${e.mode}/${e.anchorType}` +
      `  [${e.regime}${e.holdToTarget ? "/hold" : ""}]`,
    );
  }

  // ── 2b'. The reference account, and the gap between it and the desk ─────────

  const ref = reference(head.events);
  console.log(`\n═══ the reference account — ${REFERENCE_SETTINGS.leverage}x / ` +
    `${pct(REFERENCE_SETTINGS.perSignalPct)} per signal, on the newest block ═══`);
  if (!ref) {
    console.log("    no signal in this block has a venue exit price on a whole account's legs.");
  } else {
    console.log(
      `    reference, per signal   ${pct(ref.priceRet).padStart(9)} price = ${pct(ref.onMargin).padStart(9)} on margin   (n=${ref.n})\n` +
      `    the desk, per signal    ${" ".repeat(9)}         ${pct(ref.desk).padStart(9)} on margin\n` +
      `      of the gap: population ${pct(ref.population).padStart(9)}   — the leverages the desk ran, on the same price path\n` +
      `                  exits+cost ${pct(ref.exits).padStart(9)}   — stops, holds, fees, funding, the slippage band\n` +
      `    reference over the window   ${pct(ref.ofMandate)} of mandate, summed over ${ref.n} signals, compounding nothing`,
    );
  }

  // The same, by UTC day, which is the shape `tasks/47` §0 reconstructed 09-08 → 09-11
  // in and the shape a day-roll watcher would read. Pooled across regimes on purpose:
  // it is a diary, not an estimate, and the blocks table above is where estimates live.
  console.log(`\n    by UTC day of the FIRST open (pooled across regimes — a diary, not an estimate):`);
  console.log(`    ${"day".padEnd(12)}${"signals".padStart(8)}${"price/signal".padStart(14)}${"reference".padStart(12)}${"desk".padStart(11)}`);
  const days = new Map<string, Event[]>();
  for (const e of events) {
    const d = e.openedAt.toISOString().slice(0, 10);
    days.set(d, [...(days.get(d) ?? []), e]);
  }
  for (const [d, es] of [...days].sort()) {
    const r = reference(es);
    console.log(`    ${d.padEnd(12)}${String(es.length).padStart(8)}` +
      `${(r ? pct(r.priceRet) : "—").padStart(14)}${(r ? pct(r.ofMandate) : "—").padStart(12)}${(r ? pct(r.desk) : "—").padStart(11)}`);
  }
  console.log(
    "    reference is % of mandate over that day; desk is % of margin per signal.\n" +
    "    Dated by the FIRST trip's open, not by the close: a signal belongs to the feed and the\n" +
    "    settings in force when it was taken, which is the same rule `blocks` and `regimeAt` use.\n" +
    "    `tasks/47` §0's reconstruction is by day of CLOSE and its rows differ — on 09-11 this\n" +
    "    block's signals read -0.27% by open and -0.64% by close. Neither is wrong; they answer\n" +
    "    \"what did the desk take that day\" and \"what did the desk bank that day\".",
  );

  // ── 2b''. The cohorts, so "the new accounts did it" is answerable ───────────
  //
  // `tasks/47` Rule 2. Keyed on the day the account entered the connect flow, which is
  // the band that actually happened: seven accounts arrived inside four hours on 09-10.
  // Return on margin, since a cohort is a set of real accounts and the mandate roll-up
  // belongs to the reference account, which has no cohort.

  console.log(`\n═══ cohorts — by the day the account connected ═══`);
  console.log(`    ${"cohort".padEnd(14)}${"accts".padStart(6)}${"trips".padStart(7)}${"on margin".padStart(12)}` +
    `${"leverage".padStart(11)}   armed stops`);
  const byCohort = new Map<string, TripRow[]>();
  for (const t of trips) {
    const k = cohortOf.get(t.account.toLowerCase()) ?? "unknown";
    byCohort.set(k, [...(byCohort.get(k) ?? []), t]);
  }
  for (const [k, ts] of [...byCohort].sort()) {
    const accts = new Set(ts.map((t) => t.account)).size;
    const onMargin = mean(ts.map((t) => t.netPnl / t.marginUsd));
    const levs = [...new Set(ts.map((t) => t.leverage))].sort((a, b) => a - b);
    const stops = [...new Set(ts.map((t) => t.armedStopPct === null ? null : Math.round(t.armedStopPct * 1000) / 10))]
      .sort((a, b) => (a ?? -1) - (b ?? -1));
    console.log(`    ${k.padEnd(14)}${String(accts).padStart(6)}${String(ts.length).padStart(7)}` +
      `${pct(onMargin).padStart(12)}${levs.map((l) => `${l}x`).join("/").padStart(11)}   ` +
      stops.map((x) => x === null ? "off" : `${x}%`).join(" "));
  }
  console.log(
    "    This is a mean of trips within the cohort, so it carries that cohort's own re-entry\n" +
    "    and leverage mix. The reference account above is the figure no cohort can move.",
  );

  // ── 2c. The headline, then the pooled figure with its label attached ────────

  // **Scored on the price return**, which is the unit `tasks/46` §5.4 picks and the one
  // that does not move when a differently-levered account is funded. The hit rate and
  // the worst signal are the same events either way — a sign does not depend on
  // leverage — so only the magnitudes change unit.
  const stats = (name: string, es: Event[], dollars: number | null) => {
    const xs = es.filter((e) => e.priceRet !== null).map((e) => e.priceRet as number);
    const wins = xs.filter((r) => r > 0);
    const losses = xs.filter((r) => r <= 0);
    const c = meanCi(xs);
    const onMargin = meanCi(es.map((e) => e.retAccounts));
    console.log(
      `\n═══ ${name} ═══\n` +
      `    hit rate            ${wins.length}/${xs.length} = ${pct(xs.length ? wins.length / xs.length : 0)}\n` +
      `    average win         ${pct(wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0)} in price\n` +
      `    average loss        ${pct(losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0)} in price\n` +
      `    worst single signal ${pct(Math.min(...xs, 0))} in price\n` +
      `    expectancy          ${pct(c.mean)} in price per signal — x leverage for margin\n` +
      `    95% CI              ${pct(c.lo)} … ${pct(c.hi)}   (sd ${pct(c.sd)}, n=${c.n})\n` +
      `    the desk's own      ${pct(onMargin.mean)} of margin per signal, over ${onMargin.n} signals at its actual leverages` +
      (dollars === null ? "" : `\n    net dollars, all accounts  $${dollars.toFixed(4)}`),
    );
  };

  if (head) {
    const r = FEED_REGIMES.find((x) => x.name === head.regime);
    const changedHead = changesIn(head, changes);
    if (!scoreable(changedHead)) {
      console.log(`\n═══ the newest block: ${head.regime} / ${head.holdToTarget ? "hold to target" : "retire on neutral"} ═══`);
      console.log(`    ${changedHead.filter((x) => x.kind === "config").length} config events and ` +
        `${changedHead.filter((x) => x.kind === "settings").length} settings events inside this block: not scoreable.`);
    } else {
      stats(`the newest block: ${head.regime} / ${head.holdToTarget ? "hold to target" : "retire on neutral"}`,
        head.events, null);
    }
    console.log(`    the feed from ${r?.from ?? "?"} — ${r?.what ?? ""}`);
  }

  const dollars = settled.reduce((t, r) => t + Number(r.net_pnl), 0);
  const regimes = new Set(events.map((e) => e.regime)).size;
  const policies = new Set(events.map((e) => e.holdToTarget)).size;
  const plural = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  stats(`pooled: ${plural(regimes, "feed regime", "feed regimes")}, ${plural(policies, "exit policy", "exit policies")}`,
    events, dollars);
  if (regimes > 1 || policies > 1) {
    console.log(
      "    ⚠ POOLED, and therefore not an estimate of anything. It mixes populations that\n" +
      "    differ in what was offered or in when a position leaves. It is printed because the\n" +
      "    dollars are real and the count is the archive's, not because the mean is readable.",
    );
  }

  // Descriptive only, and pooled for the same reason the table above is: at a block's
  // size these cells are n=1. `tasks/32` §3 refuses to split on the user's other three
  // settings, and this is the same argument one level down.
  const split = (name: string, key: (e: Event) => string) => {
    const groups = new Map<string, number[]>();
    for (const e of events) {
      if (e.priceRet === null) continue;
      groups.set(key(e), [...(groups.get(key(e)) ?? []), e.priceRet]);
    }
    const parts = [...groups].sort().map(([k, v]) => `${k} ${pct(meanCi(v).mean)} (n=${v.length})`);
    console.log(`    by ${name.padEnd(12)} ${parts.join("  ·  ")}`);
  };
  console.log("\n    pooled and descriptive only, in price:");
  split("asset class", (e) => e.assetClass);
  split("mode", (e) => e.mode);
  split("anchor type", (e) => e.anchorType);

  // ── 3. The decision, on the block it is deciding about ──────────────────────
  //
  // Not on the pooled count. Reading "42 distinct events — at or past the floor" off a
  // sample drawn from three feeds is the exact figure `tasks/31` §1 argues nobody
  // should act on, and this line printed it.

  // `tasks/47` Rule 6: **the contract of the feed the block was traded on.** Computed
  // from the archive rather than read from an `events` row, which is what lets it answer
  // for blocks that predate the code (`src/signals/contract.ts` says why at length).
  const headSpan = head === undefined ? null : contractSpan(
    polls,
    Math.min(...head.events.map((e) => e.openedAt.getTime())),
    Math.max(...head.events.map((e) => e.closedAt.getTime())),
  );
  if (head && headSpan) {
    if (headSpan.contracts.length === 0) {
      console.log(`\n    feed contract: no poll in this block's window — the archive here does not reach it.`);
    } else {
      console.log(
        `\n    feed contract: ${headSpan.contracts.join(" → ")}` +
        (headSpan.changes.length === 0 ? "   (one contract, which is the unit Rule 6 asks for)" : ""),
      );
      for (const c of headSpan.changes) {
        console.log(`      ${c.at.toISOString()}  ${c.kind === "breaking" ? "⚠ BREAKING" : "additive"}  ${c.lines.join("; ")}`);
      }
      if (headSpan.breaking.length === 0 && headSpan.changes.length > 0) {
        console.log(
          "      Additive only — keys arriving. A field nothing reads cannot move a gate that\n" +
          "      does not read it, so the block is still one population and this is a note.",
        );
      }
    }
  }

  console.log(`\n═══ decision ═══`);
  if (!head) {
    console.log("    no settled trades. Keep recording.");
  } else if (headSpan !== null && headSpan.breaking.length > 0) {
    // Rule 6's refusal. A key leaving, a contract vocabulary moving, or `outlook_id`
    // changing shape can each change what `evaluateSeries` sees or what `stableOutlookId`
    // returns — so the events either side of it are two feeds, not one sample.
    console.log(
      `    NOT SCOREABLE. The feed's contract changed inside this block, breakingly:\n` +
      headSpan.breaking.map((c) => `      ${c.at.toISOString()}  ${c.lines.join("; ")}`).join("\n") + "\n" +
      `    Its ${head.events.length} events were traded on two different feeds. Split the window at that\n` +
      "    instant and read the halves, or add a FEED_REGIMES row and re-run. Nothing moves on it.",
    );
  } else if (!scoreable(changesIn(head, changes))) {
    // `tasks/47` Rule 1. Two changes inside one block is not a small sample: it is two
    // samples, and there is nothing to widen the interval on.
    const ch = changesIn(head, changes);
    console.log(
      `    NOT SCOREABLE. ${ch.filter((x) => x.kind === "config").length} config events and ` +
      `${ch.filter((x) => x.kind === "settings").length} settings events landed inside the newest\n` +
      `    block, so its ${head.events.length} events are two desks pooled and no mean over them is an\n` +
      "    estimate of either. The sample and the events are printed above. Nothing moves on it.",
    );
  } else {
    const n = head.events.length;
    // The decision quotes the **price return** (`tasks/46` §5.4): it is the statistic
    // that does not depend on who was funded, and every constant this reading could
    // move — the stop, the gate, the hold cap — is a decision about the signals and
    // not about the account mix that happened to be trading them.
    const c = meanCi(head.events.filter((e) => e.priceRet !== null).map((e) => e.priceRet as number));
    const label = `${head.regime} / ${head.holdToTarget ? "hold to target" : "retire on neutral"}`;
    if (n < SAMPLE_FLOOR) {
      // "Keep recording" is only useful with a date attached, and the rate that gives it
      // one has to be this regime's own — see the per-regime table above.
      const rate = archiveRate.get(head.regime);
      const perDay = rate && rate.days > 0 ? rate.events / rate.days : 0;
      // No rate is not a rate of zero. The archive on this machine may simply not reach
      // the regime the desk is trading in — pull it from the VPS rather than read a date
      // off a feed nobody measured.
      const when = perDay > 0
        ? `This regime yields ${perDay.toFixed(1)} tradeable events/day, so the floor arrives\n` +
          `    around ${new Date(Date.now() + ((SAMPLE_FLOOR - n) / perDay) * 86_400_000).toISOString().slice(0, 10)}` +
          " if the feed keeps its current shape."
        : "The archive here holds no tradeable events in this regime, so no date is available\n" +
          "    — pull the archive from the VPS before quoting one.";
      console.log(
        `    TOO SMALL TO SAY. ${n} distinct tradeable events in the newest block (${label})\n` +
        `    against the ~${SAMPLE_FLOOR} this task requires. No cap moves. Keep recording.\n` +
        `    Its 95% interval spans ${pct(c.hi - c.lo)} in price, which is the honest statement\n` +
        `    of how little ${n} trades constrain anything.\n` +
        `    ${when}\n` +
        `    The pooled ${events.length} is NOT the number to wait on: it spans ${plural(regimes, "feed regime", "feed regimes")},\n` +
        "    and adding events from another feed answers a question nobody asked.",
      );
    } else {
      console.log(
        `    ${n} distinct events in the newest block (${label}) — at or past the floor.\n` +
        `    ${pct(c.mean)} in price per signal, 95% CI ${pct(c.lo)} … ${pct(c.hi)} over n=${c.n}.\n` +
        "    Read the interval, not the mean, and move ONE risk fraction by a bounded step,\n" +
        "    with this report's path in the diff.",
      );
    }
  }
  store.close();
}

// Guarded so `readArchive` can be imported — by `backtest.ts`, which must read the
// archive exactly as this file does — without the import itself opening the ledger,
// calling Hyperliquid and printing a reading. `exit-policy.ts` is guarded the same way
// and for the same reason.
if (import.meta.main) {
  main().catch((e) => {
    console.error("[expectancy] failed:", e);
    process.exit(1);
  });
}
