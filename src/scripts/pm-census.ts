import { type PmPoll, readPmArchive } from "../signals/archive.ts";
import { stablePmKey } from "../mapping/quotient-pm.ts";
import type { PmSignal } from "../signals/types.ts";

// What the `/signals` archive says about a book held to resolution.
//
//   npm run pm-census
//
// This is the read that `notes/2026-09-14-hold-to-resolution-and-the-book-that-never-
// empties.md` is written from, and the data half of `tasks/52`. It is **not** a
// backtest: nothing here scores a return. It answers the question that has to be settled
// before a return is worth computing — *how many positions would be open at once, for how
// long, and how many of them can be scored today* — because the exit policy the owner
// chose on 2026-09-14 (hold every position to the market's own resolution) turns the
// concurrency cap into the binding constraint and makes arrival order the strategy.
//
// It reads the local archive only. No venue call, no credential, no Quotient credit.

const ROOT = process.env.DATA_ROOT ?? "data";
const DAY = 864e5;

/** Whatever the archive's last poll was, so a re-run on a fresh box is reproducible
 *  rather than drifting with the wall clock. */
function now(polls: { t: Date }[]): number {
  return polls[polls.length - 1]?.t.getTime() ?? Date.now();
}

type Entry = { key: string; firstAt: number; first: PmSignal; ids: Set<string>; polls: number };

function collect(): { entries: Entry[]; t0: number; t1: number; pmRows: number; kalshiRows: number; polls: PmPoll[] } {
  const polls = readPmArchive(ROOT);
  const byKey = new Map<string, Entry>();
  let pmRows = 0;
  let kalshiRows = 0;
  for (const poll of polls) {
    for (const s of poll.signals) {
      if (s.market.venue === "kalshi") kalshiRows++;
      if (s.market.venue !== "polymarket") continue;
      pmRows++;
      const key = stablePmKey(s);
      const e = byKey.get(key);
      if (!e) byKey.set(key, { key, firstAt: poll.t.getTime(), first: s, ids: new Set([s.id]), polls: 1 });
      else {
        e.ids.add(s.id);
        e.polls++;
      }
    }
  }
  return {
    entries: [...byKey.values()],
    t0: polls[0]?.t.getTime() ?? 0,
    t1: now(polls),
    pmRows,
    kalshiRows,
    polls,
  };
}

function quantile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? NaN;
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return Math.abs(x) >= 1000 ? Math.round(x).toLocaleString("en-US") : String(Math.round(x * 100) / 100);
}

function spread(label: string, values: number[], unit = ""): void {
  if (values.length === 0) return console.log(`${label.padEnd(34)} (none)`);
  const q = (p: number) => fmt(quantile(values, p)) + unit;
  console.log(
    `${label.padEnd(34)} n=${String(values.length).padStart(4)}  min ${q(0).padStart(9)}  ` +
      `p25 ${q(0.25).padStart(9)}  median ${q(0.5).padStart(9)}  p75 ${q(0.75).padStart(9)}  ` +
      `p90 ${q(0.9).padStart(9)}  max ${q(1).padStart(9)}`,
  );
}

/** The entry gate as `tasks/06` §4, §9.4 and §10 decide it, evaluated on the **first**
 *  revision of a key — which is the only revision an entry decision ever sees.
 *
 *  ⚠ `converged` is mostly a *late* state, so where it sits matters: 35 of 127 keys are
 *  converged when last seen and only **9** are converged when first seen. Reading the
 *  09-02 note's "116 of 141 survive" as an entry-time figure overstates the cut by ~4×. */
function refusal(s: PmSignal, volumeFloor: number, maxDaysToResolution: number, firstAt: number): string | null {
  if (s.forecast_status.state === "converged") return "converged";
  if ((s.market.volume_24h ?? 0) < volumeFloor) return "thin-book";
  if (s.entry_pm > 92) return "above-max-entry";
  // Derive the direction and compare; never trust the field (`tasks/06` §10).
  if (s.side !== (s.entry_q > s.entry_pm ? "YES" : "NO")) return "side-mismatch";
  const end = Date.parse(s.market.end_date);
  if (!Number.isFinite(end)) return "no-end-date";
  if ((end - firstAt) / DAY > maxDaysToResolution) return "resolves-too-late";
  return null;
}

/** What a signal is worth per dollar staked, held to resolution, **under Quotient's own
 *  probability**.
 *
 *  A binary share bought at `price` pays $1 if the outcome happens, so the expected return
 *  per dollar is `P(win)/price − 1`. Both legs are already side-relative and already in
 *  cents, so no branch on `side` is needed — and this is the **live** frame, which is what
 *  an entry decision is made in: `current_cost_cents` is what the order would pay now,
 *  where `entry_cost_cents` is what it would have paid when Quotient published.
 *
 *  ⚠ **The first version of this function used the entry price against the live
 *  probability** and was wrong by up to 36 cents on a dollar contract — the two-frame trap
 *  documented on `PmSignal.entry_q`. The two disagree by more than 2pp on 46 of 118 keys.
 *
 *  ⚠⚠ **And it is circular whichever frame it uses.** It is the vendor's own forecast
 *  scoring the vendor's own signal: if their probabilities are calibrated every one of
 *  these is a good trade by construction, and if they are not this is noise with a
 *  decimal point. It is a **ranking candidate**, not a return. `tasks/52` is what scores it
 *  against the outcomes that have actually happened. Quotient publishes the same quantity
 *  as `converge_upside_pct`, which reconciles with this on 98 of 127 (the rest is cent
 *  rounding), so they agree about what they are claiming. */
function evPerDollar(s: PmSignal): number {
  return s.current_cost_cents > 0 ? s.q_value_cents / s.current_cost_cents - 1 : 0;
}

/** What could choose the book, given that the slot cap is going to choose it anyway.
 *
 *  §4's finding is that demand runs 8–17× the slots, so **something refuses 8 or 9 of
 *  every ten signals** and the only question is what. This ranks the pool by each
 *  candidate, takes the largest book that fits 20 slots, and reports what that book looks
 *  like — against **arrival order**, which is what taking signals as they come amounts to
 *  and is the honest baseline. */
function ranking(entries: Entry[], t0: number, t1: number): void {
  const spanDays = (t1 - t0) / DAY;
  const pool = entries
    .filter((e) => !refusal(e.first, 0, Infinity, e.firstAt))
    .map((e, i) => {
      const end = Date.parse(e.first.market.end_date);
      // A quarter-day floor: `end_date` can be hours away, and dividing a return by a
      // duration that approaches zero produces a rate that approaches infinity.
      const days = Math.max(0.25, (end - e.firstAt) / DAY);
      const ev = evPerDollar(e.first);
      return { days, ev, evPerDay: ev / days, s: e.first, arrival: -i, resolved: end <= t1,
               flagged: e.first.drawdown_risk_elevated || e.first.crash_risk_elevated };
    });
  if (pool.length === 0) return;

  console.log(`\n=== what could choose the book ===\n`);
  const meanHold = pool.reduce((a, p) => a + p.days, 0) / pool.length;
  const seen = pool.length / spanDays;
  console.log("  slots are the constraint, so the first number is how much must be refused:\n");
  for (const [pct, slots] of [[0.1, 10], [0.05, 20], [0.03, 33]] as const) {
    const sustainable = slots / meanHold;
    console.log(
      `  perSignalPct ${String(pct * 100).padStart(2)}% → ${String(slots).padStart(2)} slots · mean hold ${meanHold.toFixed(1)}d ` +
        `· sustains ${sustainable.toFixed(2)}/day against ${seen.toFixed(1)}/day seen → **refuse ${(100 * (1 - sustainable / seen)).toFixed(0)}%**`,
    );
  }

  type Ranker = { name: string; of: (p: (typeof pool)[number]) => number; bar: (v: number) => string };
  const rankers: Ranker[] = [
    { name: "EV per slot-day", of: (p) => p.evPerDay, bar: (v) => `${(v * 100).toFixed(2)}%/d` },
    { name: "EV per dollar", of: (p) => p.ev, bar: (v) => `${(v * 100).toFixed(1)}%` },
    { name: "risk-flag free", of: (p) => (p.s.drawdown_risk_elevated || p.s.crash_risk_elevated ? 0 : 1) + p.ev / 1000, bar: () => "unflagged" },
    { name: "entry_spread_pp", of: (p) => p.s.entry_spread_pp, bar: (v) => `${v}pp` },
    { name: "volume_24h", of: (p) => p.s.market.volume_24h ?? 0, bar: (v) => `$${Math.round(v).toLocaleString("en-US")}` },
    { name: "shortest first", of: (p) => -p.days, bar: (v) => `${(-v).toFixed(1)}d` },
    { name: "conviction tier", of: (p) => p.s.conviction_tier, bar: (v) => `tier ${v}` },
    { name: "arrival order", of: (p) => p.arrival, bar: () => "—" },
  ];

  console.log(`\n  ranker                take/day   bar          mean hold   mean EV   mean EV/day   flagged   scoreable`);
  console.log("  ──────────────────────────────────────────────────────────────────────────────────────────────────");
  for (const r of rankers) {
    const sorted = [...pool].sort((a, b) => r.of(b) - r.of(a));
    // Occupancy(k) = (k/span) × meanHold(top k) rises with k, so bisect for the largest
    // book that fits. A fixed-point iteration oscillates on any ranker that prefers short
    // holds, because taking more of them frees the very slots that admit more.
    const occupancy = (k: number): number => {
      const head = sorted.slice(0, k);
      return (k / spanDays) * (head.reduce((a, p) => a + p.days, 0) / head.length);
    };
    let lo = 1;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (occupancy(mid) <= 20) lo = mid;
      else hi = mid - 1;
    }
    const book = sorted.slice(0, lo);
    const avg = (f: (p: (typeof pool)[number]) => number) => book.reduce((a, p) => a + f(p), 0) / book.length;
    const last = book[book.length - 1];
    console.log(
      `  ${r.name.padEnd(20)} ${(lo / spanDays).toFixed(2).padStart(7)}   ${(last ? r.bar(r.of(last)) : "—").padStart(10)}   ` +
        `${avg((p) => p.days).toFixed(1).padStart(8)}d   ${(100 * avg((p) => p.ev)).toFixed(1).padStart(6)}%   ` +
        `${(100 * avg((p) => p.evPerDay)).toFixed(2).padStart(10)}%   ` +
        `${String(book.filter((p) => p.flagged).length).padStart(3)}/${String(book.length).padStart(3)}   ` +
        `${String(book.filter((p) => p.resolved).length).padStart(9)}`,
    );
  }
  // Which of these are actually different questions. A ranker that picks the same book as
  // arrival order is not a filter, it is a relabelling — and one that overlaps another
  // heavily is the same statistic wearing a different name.
  const K = Math.min(23, pool.length);
  const tops = new Map(
    rankers.map((r) => [
      r.name,
      new Set([...pool].sort((a, b) => r.of(b) - r.of(a)).slice(0, K).map((p) => stablePmKey(p.s))),
    ]),
  );
  console.log(`\n  do they pick the same signals? — overlap of each ranker's top ${K}\n`);
  process.stdout.write("  ".padEnd(22));
  for (const r of rankers) process.stdout.write(r.name.slice(0, 9).padStart(11));
  console.log();
  for (const a of rankers) {
    process.stdout.write("  " + a.name.padEnd(20));
    for (const b of rankers) {
      const overlap = [...(tops.get(a.name) ?? [])].filter((x) => tops.get(b.name)?.has(x)).length;
      process.stdout.write(String(overlap).padStart(11));
    }
    console.log();
  }

  console.log(
    `\n  ⚠⚠ Both EV columns are **Quotient's own probability scoring Quotient's own signal**.\n` +
      `  They rank; they do not predict. ${pool.filter((p) => p.resolved).length} of these have resolved and \`tasks/52\`\n` +
      `  is what turns them into a return — until it has, "arrival order" is the only row\n` +
      `  here whose number is not assuming the answer.\n`,
  );
}

/** What the archive can say that the payload cannot.
 *
 *  Three quantities Quotient does not publish and we do not need a venue call for. They
 *  exist because **the vendor re-baselines**: `entry_*` moves with the revision id and
 *  `forecast_status.adverse_move_pct` has `basis: "since_forecast"`, so every "since"
 *  figure in the payload is measured from a moving origin. Ours is measured from the first
 *  poll that showed the key, which is the only origin an entry decision ever had. */
function derived(entries: Entry[], polls: PmPoll[]): void {
  // Re-walk the polls per key; `collect` keeps only the first revision, and these need the
  // whole series.
  const series = new Map<string, { t: number; s: PmSignal }[]>();
  for (const poll of polls) {
    for (const s of poll.signals) {
      if (s.market.venue !== "polymarket") continue;
      const k = stablePmKey(s);
      const a = series.get(k);
      if (a) a.push({ t: poll.t.getTime(), s });
      else series.set(k, [{ t: poll.t.getTime(), s }]);
    }
  }
  const seen = [...series.values()].filter((r) => r.length >= 5);
  if (seen.length === 0) return;

  console.log(`\n=== what our archive knows and the payload does not ===\n`);

  const qRange: number[] = [];
  const pRange: number[] = [];
  const lives: number[] = [];
  let stickier = 0;
  for (const rows of seen) {
    const qs = rows.map((r) => r.s.q_value_cents);
    const ps = rows.map((r) => r.s.current_cost_cents);
    const dq = Math.max(...qs) - Math.min(...qs);
    const dp = Math.max(...ps) - Math.min(...ps);
    qRange.push(dq);
    pRange.push(dp);
    if (dq < dp) stickier++;
    lives.push(((rows[rows.length - 1]?.t ?? 0) - (rows[0]?.t ?? 0)) / DAY);
  }
  console.log(`  over ${seen.length} keys seen 5+ times, median observed life ${fmt(quantile(lives, 0.5))}d:`);
  console.log(`    q_value_cents range within a key   median ${fmt(quantile(qRange, 0.5))}c  p90 ${fmt(quantile(qRange, 0.9))}c  max ${Math.max(...qRange)}c`);
  console.log(`    current_cost_cents range           median ${fmt(quantile(pRange, 0.5))}c  p90 ${fmt(quantile(pRange, 0.9))}c  max ${Math.max(...pRange)}c`);
  console.log(`    **the forecast moves less than the market on ${stickier} of ${seen.length} keys** — it is the anchor, the price oscillates`);

  let narrowed = 0;
  let widened = 0;
  let flat = 0;
  const gapDelta: number[] = [];
  for (const rows of seen) {
    const a = rows[0]?.s;
    const z = rows[rows.length - 1]?.s;
    if (!a || !z) continue;
    const g0 = a.q_value_cents - a.current_cost_cents;
    const g1 = z.q_value_cents - z.current_cost_cents;
    gapDelta.push(g1 - g0);
    if (g1 < g0 - 1) narrowed++;
    else if (g1 > g0 + 1) widened++;
    else flat++;
  }
  console.log(`\n  convergence from OUR first sight (their adverse_move_pct re-bases on the revision):`);
  console.log(`    gap narrowed ${narrowed} · widened ${widened} · flat ±1c ${flat}   median change ${fmt(quantile(gapDelta, 0.5))}c (p10 ${fmt(quantile(gapDelta, 0.1))}c, p90 ${fmt(quantile(gapDelta, 0.9))}c)`);
  console.log(`    ⚠ observed life, not held to resolution, and a key that leaves the feed leaves this sample with it.`);

  // `market.nativeEventId` is null on every row, so two markets on one underlying event are
  // indistinguishable from two independent bets. The slug stem is a crude stand-in for the
  // event key Gamma's /events endpoint would give properly.
  const stems = new Map<string, Set<string>>();
  for (const e of entries) {
    const stem = (e.first.market.slug ?? "").replace(/-\d[\d-]*$/, "").split("-").slice(0, 5).join("-");
    const set = stems.get(stem) ?? new Set<string>();
    set.add(e.first.market.nativeMarketId);
    stems.set(stem, set);
  }
  const clusters = [...stems].filter(([, v]) => v.size > 1).sort((a, b) => b[1].size - a[1].size);
  const inCluster = clusters.reduce((a, [, v]) => a + v.size, 0);
  console.log(`\n  event clustering — market.nativeEventId is null on every row:`);
  console.log(`    ${inCluster} of ${entries.length} markets share a slug stem with another, in ${clusters.length} groups`);
  for (const [stem, set] of clusters.slice(0, 5)) console.log(`      ${String(set.size).padStart(2)} markets   ${stem}`);
  console.log(
    `    ⚠⚠ Two positions on one event are one bet. With ~20 slots held to resolution, the\n` +
      `    largest group here would take **${clusters[0]?.[1].size ?? 0}** of them. The perps desk learned this on\n` +
      `    2026-09-10 — 15 accounts, 1 distinct position — and nothing in this payload prevents it.\n`,
  );
}

/** ⚠⚠ **The arrival rate is not a constant, and the archive's own first day is not an
 *  arrival rate at all.**
 *
 *  Added 2026-09-15 on the owner's point that the feed can grow, which turned out to be
 *  the smaller half of it: the recorder's **first poll sees every signal already live**,
 *  so 2026-08-30 contributes 39 gated keys as a *stock* and every later day contributes a
 *  *flow*. Averaging the two gives 8.0/day where the trailing week runs **3.6**, and since
 *  steady-state occupancy is arrivals × hold, that error goes straight into the book size
 *  and into any balance recommendation derived from it.
 *
 *  It is the mirror of the ramp-from-empty correction in
 *  `notes/2026-09-14-hold-to-resolution-and-the-book-that-never-empties.md` §4.0. That one
 *  found the *observed book* understates the steady state; this one finds the *arrival
 *  rate* overstates it. Both are artefacts of an archive shorter than the hold, and they
 *  push opposite ways.
 *
 *  The table above keeps its whole-archive definition so the 09-14 note still reproduces.
 *  This is the number to quote instead. */
function arrivalRate(entries: Entry[], t0: number, t1: number): void {
  const gated = entries.filter((e) => !refusal(e.first, 0, Infinity, e.firstAt));
  if (gated.length === 0) return;
  const hold = (e: Entry): number => Math.max(0.25, (Date.parse(e.first.market.end_date) - e.firstAt) / DAY);
  const meanOf = (a: number[]): number => a.reduce((x, y) => x + y, 0) / (a.length || 1);

  console.log(`\n=== ⚠⚠ the arrival rate is not a constant, and day one is not an arrival ===\n`);
  const seedDay = new Date(t0).toISOString().slice(0, 10);
  const seed = gated.filter((e) => new Date(e.firstAt).toISOString().slice(0, 10) === seedDay);
  console.log(`  the recorder's first poll sees everything already live, so ${seedDay} contributes`);
  console.log(`  **${seed.length} of ${gated.length} gated keys as a stock, not a flow**. Windows that include it are inflated.\n`);
  console.log(`  window                     keys   per day   mean hold   steady book   cover-all capital`);
  console.log(`  ─────────────────────────────────────────────────────────────────────────────────────`);
  const windows: [string, Entry[], number][] = [
    ["whole archive (inflated)", gated, (t1 - t0) / DAY],
    ["excluding the seed day", gated.filter((e) => !seed.includes(e)), (t1 - t0) / DAY - 1],
    ["trailing 7 days", gated.filter((e) => e.firstAt >= t1 - 7 * DAY), 7],
    ["trailing 3 days", gated.filter((e) => e.firstAt >= t1 - 3 * DAY), 3],
  ];
  for (const [label, es, span] of windows) {
    if (es.length === 0 || span <= 0) continue;
    const rate = es.length / span;
    const mh = meanOf(es.map(hold));
    const steady = rate * mh;
    // Polymarket's minimum order is 5 shares, so the smallest ticket is 5 x the entry price.
    const ticket = 5 * meanOf(es.map((e) => e.first.current_cost_cents / 100));
    console.log(
      `  ${label.padEnd(24)} ${String(es.length).padStart(5)}   ${rate.toFixed(1).padStart(7)}   ${mh.toFixed(1).padStart(8)}d   ${steady.toFixed(0).padStart(11)}   ${("$" + Math.round(steady * ticket)).padStart(17)}`,
    );
  }
  console.log(
    `\n  **Cover-all capital is steady book x a 5-share minimum ticket**, and it moves with the\n` +
      `  feed — which is why it belongs in a trailing window and never in a constant. Quote the\n` +
      `  trailing-7 row, say the window beside the number, and recompute it rather than shipping it.\n`,
  );
}

function main(): void {
  const { entries, t0, t1, pmRows, kalshiRows, polls } = collect();
  if (entries.length === 0) {
    console.log(`No Polymarket signals under ${ROOT}/quotient/signals — the archive is on the VPS.`);
    return;
  }
  const spanDays = (t1 - t0) / DAY;

  console.log(`\n=== the /signals archive, ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)} (${spanDays.toFixed(1)} days) ===\n`);
  console.log(`signal-rows: polymarket ${pmRows.toLocaleString("en-US")} · kalshi ${kalshiRows.toLocaleString("en-US")} (${((100 * kalshiRows) / (pmRows + kalshiRows)).toFixed(0)}% kalshi, a skip with a reason)`);
  const markets = new Set(entries.map((e) => e.key.split(":")[1]));
  console.log(`unique stablePmKey: ${entries.length} over ${markets.size} markets`);
  const idCounts = entries.map((e) => e.ids.size);
  console.log(`revision ids per key: median ${fmt(quantile(idCounts, 0.5))}, max ${Math.max(...idCounts)} — the id is the revision, the key is the position\n`);

  const endDays = entries
    .map((e) => (Date.parse(e.first.market.end_date) - e.firstAt) / DAY)
    .filter(Number.isFinite);
  spread("days to market end_date", endDays, "d");
  spread("window_days (Quotient's own)", entries.map((e) => e.first.window_days), "d");
  spread("entry_pm (cents)", entries.map((e) => e.first.entry_pm), "c");
  spread("market.volume_24h ($)", entries.map((e) => e.first.market.volume_24h ?? 0));

  const resolvedNow = entries.filter((e) => Date.parse(e.first.market.end_date) <= t1).length;
  console.log(
    `\nend_date already passed: ${resolvedNow} of ${entries.length} (${((100 * resolvedNow) / entries.length).toFixed(0)}%)` +
      ` — the population a hold-to-resolution backtest can score today`,
  );

  // Entry-time refusals at the loosest gate, so the shape of each cut is visible before
  // the grid mixes them.
  const reasons = new Map<string, number>();
  for (const e of entries) {
    const r = refusal(e.first, 0, Infinity, e.firstAt);
    if (r) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  console.log(`refused at entry with no floors: ${[...reasons].map(([k, v]) => `${k} ${v}`).join(" · ") || "none"}`);

  console.log(`\n=== held to resolution: what is open at once ===\n`);
  console.log(`  a position is entered at first sight and never sold, so concurrency is`);
  console.log(`  arrivals × hold, and the slot cap decides which signals are taken at all.\n`);
  console.log(
    "  maxDays  volFloor │ taken  arr/day  medHold  meanHold   open: mean/peak   steady   scoreable   full@20",
  );
  console.log("  ───────────────────┼──────────────────────────────────────────────────────────────────────────────");
  for (const volumeFloor of [0, 5_000, 10_000]) {
    for (const maxDays of [7, 14, 30, Infinity]) {
      const taken: { in: number; out: number }[] = [];
      for (const e of entries) {
        if (refusal(e.first, volumeFloor, maxDays, e.firstAt)) continue;
        taken.push({ in: e.firstAt, out: Date.parse(e.first.market.end_date) });
      }
      const open: number[] = [];
      for (let t = t0; t <= t1; t += 3600e3) open.push(taken.filter((x) => x.in <= t && x.out > t).length);
      const mean = open.reduce((a, b) => a + b, 0) / (open.length || 1);
      const holds = taken.map((x) => (x.out - x.in) / DAY);
      const meanHold = holds.reduce((a, b) => a + b, 0) / (holds.length || 1);
      const scoreable = taken.filter((x) => x.out <= t1).length;
      const full = open.filter((n) => n > 20).length / (open.length || 1);
      // Little's law: a queue's steady-state occupancy is arrivals × mean time in
      // system. The observed columns are a **ramp from empty** — where the mean hold
      // exceeds the archive's own span almost nothing has closed yet, so `open` is still
      // climbing and understates the book. `steady` is what it climbs to.
      const steady = (taken.length / spanDays) * meanHold;
      const ramping = meanHold > spanDays;
      console.log(
        `  ${(maxDays === Infinity ? "none" : String(maxDays)).padStart(7)}  ${("$" + volumeFloor).padStart(8)} │ ` +
          `${String(taken.length).padStart(5)}  ${(taken.length / spanDays).toFixed(1).padStart(7)}  ` +
          `${fmt(quantile(holds, 0.5)).padStart(6)}d  ${meanHold.toFixed(1).padStart(7)}d   ` +
          `${mean.toFixed(1).padStart(6)}/${String(Math.max(0, ...open)).padStart(4)}   ` +
          `${steady.toFixed(0).padStart(6)}${ramping ? " ⚠" : "  "} ${String(scoreable).padStart(9)}   ` +
          `${(100 * full).toFixed(0).padStart(6)}%`,
      );
    }
  }
  arrivalRate(entries, t0, t1);
  ranking(entries, t0, t1);
  derived(entries, polls);

  console.log(
    `\n  "full@20" is the share of hours the book would be at its cap at 5% per signal\n` +
      `  (maxConcurrentSignals = floor(1/perSignalPct)). Where that reads 100%, every\n` +
      `  constant in PM_MANDATE is decorative and arrival order is the strategy.\n` +
      `\n  ⚠ A "steady" marked ⚠ is a row whose mean hold exceeds the ${spanDays.toFixed(1)}-day archive:\n` +
      `  almost nothing entered has closed yet, so "open" is a ramp from empty and the\n` +
      `  book is still filling at the last sample. Read "steady", not "peak", on those.\n`,
  );
}

main();
