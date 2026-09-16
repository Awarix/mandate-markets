import { readFileSync, writeFileSync } from "node:fs";
import { readPmArchive } from "../signals/archive.ts";
import { stablePmKey } from "../mapping/quotient-pm.ts";
import type { PmSignal } from "../signals/types.ts";

// The price path behind every signal we could score, and the depth of the endpoint that
// serves it.
//
//   npm run pm-prices              # offline, from the committed capture: what it covers
//   npm run pm-prices -- --probe   # measure the endpoint's own limits, live
//   npm run pm-prices -- --fetch   # re-capture the paths
//
// This is `tasks/52` §2.2 and the done-condition beside it — ⚠ **the reachable depth of
// `prices-history` is measured and written down**. The perps side lost 19 of 23 events to
// an unmeasured cap and returned a confident `n=4`
// (`notes/2026-09-07-backtest-sigma-and-exit-policy.md` §3), so the rule here is: find the
// cap with requests, not with documentation, before anything replays a range.
//
// ⚠⚠ **The answer is the opposite of Hyperliquid's, and that is the headline.** There is no
// row cap — a single response returned 20,154 points — and no retention wall inside our
// archive: the limit is a **15-day window**, and chunking around it works. On perps,
// chunking does not help and a window stops being replayable as it ages (`tasks/31` §3.4).
// Here a signal from three weeks ago is still scoreable at minute resolution, and stays so.

const ROOT = process.env.DATA_ROOT ?? "data";
const RESOLUTIONS = "fixtures/pm-resolutions-2026-09-15.json";
const CAPTURE = "fixtures/pm-prices-2026-09-15.json";
const HOST = "https://clob.polymarket.com";

/** Measured 2026-09-15, not read in a doc (`--probe` re-checks all four):
 *
 *  - **`endTs − startTs` must be ≤ 1,296,000s = exactly 15 days.** 1,296,000 returns;
 *    1,296,001 is `invalid filters: 'startTs' and 'endTs' interval is too long`. So a
 *    longer path is chunked, and chunking **works** — unlike `candleSnapshot`.
 *  - **No row cap.** 14 days at `fidelity=1` came back as 20,154 points in one response.
 *  - **`fidelity` is in minutes and floors at 10 for `interval=max`** (`interval=1m` says
 *    so outright: *minimum 'fidelity' for '1m' range is 10*), but an **explicit window
 *    accepts `fidelity=1`** and returns 60-second spacing. The two paths through the same
 *    endpoint do not have the same floor.
 *  - **`interval=max` is a windowing default, not the data's extent.** At `fidelity ≤ 60`
 *    it reached 17.4 days on a market whose 12-hour series reached 25.5; explicit windows
 *    then returned minute data for the older part it had just refused to show. Anything
 *    reading `interval=max` as *everything there is* is reading a default.
 *
 *  ⚠⚠ **And the trap that would have been silent.** A response for a **live** market
 *  appends the **current** price as one extra final point, outside the window asked for: a
 *  2026-06-01 → 06-11 request came back ending `2026-09-15T11:01 @ 0.895` after `06-10
 *  23:59 @ 0.255`. Anything taking `history[history.length - 1]` as *the price at the end
 *  of my window* reads today's price instead — 64 cents wrong on that market, in a shape
 *  no error reports. Every point past the requested `endTs` is dropped on capture. */
const MAX_WINDOW_S = 1_296_000;
const FIDELITY_MIN = 10;

type Resolutions = {
  captured_at: string;
  markets: Record<string, {
    closed: boolean; end_date_iso: string; market_slug: string;
    minimum_order_size: number; minimum_tick_size: number;
    tokens: { token_id: string; outcome: string; price: number; winner: boolean }[];
  }>;
};

/** `[unix seconds, price]`, with consecutive equal prices dropped — the series is a step
 *  function, so a repeated price carries no information and costs 74% of the bytes. */
export type Path = [number, number][];

export type PriceCapture = {
  captured_at: string;
  source: string;
  fidelity_minutes: number;
  window_seconds: number;
  note: string;
  paths: Record<string, Path>;
};

// ---------------------------------------------------------------------------- the probe

async function ask(params: Record<string, string | number>): Promise<{ n: number; first?: number; last?: number; gap?: number; error?: string }> {
  const q = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
  try {
    const r = await fetch(`${HOST}/prices-history?${q}`, { signal: AbortSignal.timeout(40_000) });
    const body = (await r.json()) as { history?: { t: number; p: number }[]; error?: string };
    if (body.error) return { n: 0, error: body.error };
    const h = body.history ?? [];
    if (h.length === 0) return { n: 0 };
    const ts = h.map((x) => x.t);
    const gaps = ts.slice(1).map((t, i) => t - (ts[i] ?? t)).sort((a, b) => a - b);
    return { n: h.length, first: Math.min(...ts), last: Math.max(...ts), gap: gaps[Math.floor(gaps.length / 2)] };
  } catch (e) {
    return { n: 0, error: String(e) };
  }
}

const iso = (t?: number): string => (t === undefined ? "—" : new Date(t * 1000).toISOString().slice(0, 16).replace("T", " "));

/** Re-measure every constant this file asserts, against a token that has resolved — so the
 *  numbers in the comment above are checkable rather than remembered. */
async function probe(): Promise<void> {
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const m = Object.values(res.markets).find((x) => x.closed && x.tokens.some((t) => t.winner));
  const token = m?.tokens[0]?.token_id;
  if (!token) return console.log("no resolved market in the capture to probe against");
  const anchor = Math.floor(Date.parse(m?.end_date_iso ?? "") / 1000) - 30 * 86400;

  console.log(`\n=== what prices-history will actually give us — measured, ${new Date().toISOString().slice(0, 10)} ===\n`);
  console.log(`  token ${token.slice(0, 18)}…  (${m?.market_slug})\n`);

  const row = async (label: string, params: Record<string, string | number>): Promise<void> => {
    const r = await ask({ market: token, ...params });
    console.log(
      `  ${label.padEnd(38)} ${r.error ? `⚠ ${r.error.slice(0, 52)}` : `n=${String(r.n).padStart(6)}  ${iso(r.first)} → ${iso(r.last)}  gap ${String(r.gap ?? 0).padStart(6)}s`}`,
    );
  };

  console.log(`  --- interval=max is a default, and fidelity moves how far back it reaches`);
  for (const fidelity of [1, 10, 60, 720, 1440]) await row(`interval=max fidelity=${fidelity}`, { interval: "max", fidelity });

  console.log(`\n  --- an explicit window accepts fidelity=1, and there is no row cap`);
  for (const [days, fidelity] of [[7, 1], [14, 1], [14, 60]] as const)
    await row(`${days}d window, fidelity=${fidelity}`, { startTs: anchor, endTs: anchor + days * 86400, fidelity });

  console.log(`\n  --- the window cap, to the second`);
  for (const s of [MAX_WINDOW_S - 1, MAX_WINDOW_S, MAX_WINDOW_S + 1])
    await row(`window ${s}s (${(s / 86400).toFixed(4)}d)`, { startTs: anchor, endTs: anchor + s, fidelity: 60 });

  console.log(
    `\n  So: **chunk at ${MAX_WINDOW_S}s and the whole life of any market is reachable at 60-second\n` +
      `  resolution**, which is the opposite of the perps side, where 5m reaches 17.4 days and\n` +
      `  chunking does not help. The population here only grows.\n`,
  );
}

// -------------------------------------------------------------------------- the capture

async function fetchPath(token: string, from: number, to: number, fidelity: number): Promise<Path> {
  const out: Path = [];
  for (let start = from; start < to; start += MAX_WINDOW_S) {
    const end = Math.min(to, start + MAX_WINDOW_S);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(`${HOST}/prices-history?market=${token}&startTs=${start}&endTs=${end}&fidelity=${fidelity}`, { signal: AbortSignal.timeout(40_000) });
        if (r.status === 429) {
          await new Promise((z) => setTimeout(z, 2000 * (attempt + 1)));
          continue;
        }
        const body = (await r.json()) as { history?: { t: number; p: number }[]; error?: string };
        if (body.error) break;
        for (const pt of body.history ?? []) {
          // ⚠ The appended current-price point, which is outside the window we asked for.
          if (pt.t > end) continue;
          const prev = out[out.length - 1];
          if (prev && prev[1] === pt.p) continue;
          if (prev && prev[0] === pt.t) continue;
          out.push([pt.t, pt.p]);
        }
        break;
      } catch {
        await new Promise((z) => setTimeout(z, 1500 * (attempt + 1)));
      }
    }
  }
  return out;
}

async function capture(fidelity: number): Promise<void> {
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const polls = readPmArchive(ROOT);
  const firstSeen = new Map<string, number>();
  for (const poll of polls) {
    for (const s of poll.signals) {
      if (s.market.venue !== "polymarket" || !s.market.condition_id) continue;
      const cid = s.market.condition_id;
      if (!firstSeen.has(cid)) firstSeen.set(cid, poll.t.getTime());
    }
  }
  // Every token of every market that has actually settled — both sides, so the YES/NO
  // identity is checkable on the path the way it was on the book, and so a key called
  // either way finds its own side without a second capture.
  const jobs: { token: string; from: number; to: number }[] = [];
  for (const [cid, m] of Object.entries(res.markets)) {
    if (!m.closed || !m.tokens.some((t) => t.winner)) continue;
    const seen = firstSeen.get(cid);
    if (seen === undefined) continue;
    const from = Math.floor(seen / 1000) - 3600;
    const to = Math.floor(Date.now() / 1000);
    for (const t of m.tokens) jobs.push({ token: t.token_id, from, to });
  }

  const paths: Record<string, Path> = {};
  const queue = [...jobs];
  let done = 0;
  // Four at a time, as `pm-resolve` settled on: parallel runs draw 429s that silently
  // drop a market rather than erroring, which is how the perps backtest lost a whole
  // symbol without saying so.
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const job = queue.shift();
      if (!job) return;
      paths[job.token] = await fetchPath(job.token, job.from, job.to, fidelity);
      if (++done % 10 === 0) process.stderr.write(`  ${done}/${jobs.length}\n`);
    }
  }));

  writeFileSync(CAPTURE, JSON.stringify({
    captured_at: new Date().toISOString(),
    source: `${HOST}/prices-history?market=<token_id>&startTs=&endTs=&fidelity=${fidelity}`,
    fidelity_minutes: fidelity,
    window_seconds: MAX_WINDOW_S,
    note: "consecutive equal prices dropped (the series is a step function); points past the requested endTs dropped (the endpoint appends the current price)",
    paths,
  }));
  const pts = Object.values(paths).reduce((a, p) => a + p.length, 0);
  console.log(`captured ${Object.keys(paths).length} token paths, ${pts.toLocaleString("en-US")} points → ${CAPTURE}`);
}

// ------------------------------------------------------------------------ what it covers

/** The price of `token` at `t`, as a step function: the last point at or before `t`.
 *  `null` before the series starts, which is a refusal and never a guess. */
export function priceAt(path: Path, t: number): number | null {
  if (path.length === 0 || (path[0]?.[0] ?? Infinity) > t) return null;
  let lo = 0;
  let hi = path.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if ((path[mid]?.[0] ?? 0) <= t) lo = mid;
    else hi = mid - 1;
  }
  return path[lo]?.[1] ?? null;
}

/** When the market actually settled, from the winner's own path rather than from
 *  `market.end_date` — which `tasks/52` §2 forbids scoring against and
 *  `notes/2026-09-15-what-the-resolved-markets-say.md` §6 measured as wrong on 14 of 33.
 *
 *  The winning token walks to $1 and stays there, so settlement is the **first point at or
 *  above 0.99 with nothing below it afterwards**. A market that never gets there returns
 *  its last point, which is the honest answer for one that stopped being quoted. */
export function settledAt(path: Path): number | null {
  if (path.length === 0) return null;
  let at: number | null = null;
  for (let i = path.length - 1; i >= 0; i--) {
    const pt = path[i];
    if (!pt) continue;
    if (pt[1] >= 0.99) at = pt[0];
    else break;
  }
  return at ?? path[path.length - 1]?.[0] ?? null;
}

function quantile(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? NaN;
}

function report(): void {
  let cap: PriceCapture;
  try {
    cap = JSON.parse(readFileSync(CAPTURE, "utf8")) as PriceCapture;
  } catch {
    console.log(`No capture at ${CAPTURE}. Run \`npm run pm-prices -- --fetch\` (unauthenticated, no credential).`);
    return;
  }
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const polls = readPmArchive(ROOT);
  if (polls.length === 0) {
    console.log(`No Polymarket signals under ${ROOT}/quotient/signals — the archive is on the VPS.`);
    return;
  }

  const first = new Map<string, { s: PmSignal; at: number }>();
  for (const poll of polls) {
    for (const s of poll.signals) {
      if (s.market.venue !== "polymarket") continue;
      const k = stablePmKey(s);
      if (!first.has(k)) first.set(k, { s, at: poll.t.getTime() });
    }
  }

  console.log(`\n=== the price paths behind the resolved population — ${CAPTURE.split("/")[1]} ===\n`);
  const pts = Object.values(cap.paths).reduce((a, p) => a + p.length, 0);
  console.log(`  ${Object.keys(cap.paths).length} token paths · ${pts.toLocaleString("en-US")} points · fidelity ${cap.fidelity_minutes}m · captured ${cap.captured_at.slice(0, 16).replace("T", " ")}`);
  console.log(`  chunked at ${cap.window_seconds}s (the measured cap); consecutive equal prices dropped\n`);

  // Coverage, settlement, and the two identities worth checking on a path.
  const early: number[] = [];
  const holds: number[] = [];
  const entryGap: number[] = [];
  const pairGap: number[] = [];
  let covered = 0;
  let uncovered = 0;
  let settledEarly = 0;
  const rows: { key: string; slug: string; days: number; endDays: number }[] = [];

  for (const [key, { s, at }] of first) {
    const cid = s.market.condition_id;
    const m = cid ? res.markets[cid] : undefined;
    if (!m?.closed || !m.tokens.some((t) => t.winner)) continue;
    const mine = m.tokens.find((t) => (t.outcome ?? "").toUpperCase() === s.side);
    const other = m.tokens.find((t) => t !== mine);
    const path = mine ? cap.paths[mine.token_id] : undefined;
    if (!path || path.length === 0) {
      uncovered++;
      continue;
    }
    covered++;
    const entryT = Math.floor(at / 1000);
    const winner = m.tokens.find((t) => t.winner);
    const wPath = winner ? cap.paths[winner.token_id] ?? [] : [];
    const settled = settledAt(wPath);
    const endTs = Math.floor(Date.parse(m.end_date_iso) / 1000);
    if (settled !== null) {
      holds.push((settled - entryT) / 86400);
      if (settled < endTs - 3600) {
        settledEarly++;
        early.push((endTs - settled) / 86400);
      }
      rows.push({ key, slug: m.market_slug, days: (settled - entryT) / 86400, endDays: (endTs - entryT) / 86400 });
    }
    // ⚠ The census's entry price is Quotient's `quote_method: "midpoint"` on 127/127. This
    // is the first time it can be checked against the venue's own series.
    const onPath = priceAt(path, entryT);
    if (onPath !== null) entryGap.push(100 * (onPath - s.current_cost_cents / 100));
    // Does YES + NO = 1 on the path, as it did on the book (77 of 77)?
    const oPath = other ? cap.paths[other.token_id] ?? [] : [];
    const o = priceAt(oPath, entryT);
    if (onPath !== null && o !== null) pairGap.push(100 * (onPath + o - 1));
  }

  console.log(`  coverage: ${covered} scoreable keys have a path, ${uncovered} do not`);
  if (holds.length) {
    console.log(
      `\n  --- settlement, from the winner's own path rather than from end_date ---\n` +
        `  ⚠⚠ ${settledEarly} of ${rows.length} settled BEFORE their stated end_date, by a median of ${quantile(early, 0.5).toFixed(1)}d (max ${Math.max(0, ...early).toFixed(1)}d).\n` +
        `     true hold from first sight: median ${quantile(holds, 0.5).toFixed(1)}d · p90 ${quantile(holds, 0.9).toFixed(1)}d · max ${Math.max(...holds).toFixed(1)}d\n` +
        `     against end_date's own median of ${quantile(rows.map((r) => r.endDays), 0.5).toFixed(1)}d — which is what every concurrency figure so far has used.`,
    );
    const worst = [...rows].sort((a, b) => (b.endDays - b.days) - (a.endDays - a.days)).slice(0, 5);
    for (const r of worst) console.log(`       ${r.days.toFixed(1).padStart(5)}d held vs ${r.endDays.toFixed(1).padStart(5)}d stated   ${r.slug.slice(0, 54)}`);
  }
  if (entryGap.length) {
    console.log(
      `\n  --- the entry price the census assumes, against the venue's own series ---\n` +
        `  n=${entryGap.length}  median ${quantile(entryGap, 0.5).toFixed(1)}c · p10 ${quantile(entryGap, 0.1).toFixed(1)}c · p90 ${quantile(entryGap, 0.9).toFixed(1)}c` +
        `  (path − current_cost_cents, so positive means we were quoted low)`,
    );
  }
  if (pairGap.length) {
    console.log(
      `  --- YES + NO on the path: median ${quantile(pairGap, 0.5).toFixed(1)}c · p90 ${quantile(pairGap, 0.9).toFixed(1)}c off $1 (n=${pairGap.length})`,
    );
  }
  console.log(
    `\n  What this unlocks, and it is `.trimEnd() + ` the reason it was captured:\n` +
      `    - the true hold, so the concurrency column is not built on a date the market ignored;\n` +
      `    - the early-exit counterfactual (\`tasks/52\` §2.2), which needs a price between entry and settlement;\n` +
      `    - whether a resting bid would have been hit, which is the owner's limit-order question\n` +
      `      and the one thing a book snapshot could not answer.\n` +
      `  \`npm run pm-backtest\` is what reads it.\n`,
  );
}

// ⚠ `pm-backtest.ts` imports `priceAt` and `settledAt` from this file, so the dispatch has
// to be guarded: an unguarded bottom-of-file `main()` printed this whole report above the
// backtest's own banner the first time the two were wired together.
if ((process.argv[1] ?? "").endsWith("pm-prices.ts")) {
  const args = process.argv.slice(2);
  const fidelityArg = Number(args[args.indexOf("--fidelity") + 1]);
  const fidelity = Number.isFinite(fidelityArg) && fidelityArg > 0 ? fidelityArg : FIDELITY_MIN;
  if (args.includes("--probe")) void probe();
  else if (args.includes("--fetch")) void capture(fidelity).then(report);
  else report();
}
