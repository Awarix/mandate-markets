import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readPmArchive } from "../signals/archive.ts";
import { stablePmKey } from "../mapping/quotient-pm.ts";
import type { PmSignal } from "../signals/types.ts";

// What the live Polymarket books look like on the markets our feed actually calls.
//
//   npm run probe:pm-book              # offline, from the captured books
//   npm run probe:pm-book -- --fetch   # recapture from the CLOB (unauthenticated)
//
// Three questions, none of which history can answer and all of which the design now
// turns on (`notes/2026-09-15-the-book-we-would-actually-pay.md`):
//
//   1. **The spread.** `tasks/52` §4 has to *model* the entry price because we have price
//      paths and not historical books — the exact failure `tasks/50` §1.1 found on perps,
//      where a 30 bps assumption stood in for 0.28. The rule that came out of it is sweep
//      the assumption and report whether the sign survives; this is what calibrates the
//      range that gets swept. Every signal's `quote_method` reads `midpoint` on 127/127,
//      so the census's entry price is the middle of whatever this measures.
//   2. **⚠⚠ The complementary book.** A YES share and a NO share on one condition are
//      worth $1 together, so a resting NO **bid** at 48c is an offer to sell YES at 52c —
//      and Polymarket's engine matches the two by minting the pair. So the price we would
//      pay for YES is `min(best YES ask, 1 − best NO bid)`, and reading one book alone can
//      be badly wrong about the real cost. The owner asked this on 2026-09-15; it is
//      measured in §2 rather than assumed either way.
//   3. **Depth, which on this venue constrains the ENTRY ONLY.** Held to resolution there
//      is no exit leg — redemption pays $1 a share whatever the book does — so unlike
//      `src/risk/capacity.ts` on the perps side, nothing here has to reserve room to get
//      back out. That makes depth a straight cap on how much an account can deploy, and
//      §3 turns it into the number the owner asked for: the balance above which a
//      per-signal slice stops fitting in the book it is aimed at.
//
// It is the book half of `tasks/06` §8 Step 2's `npm run probe:pm` and **not** that step:
// there is no `src/pm/clob.ts`, no `src/pm/data.ts`, no mapper and no rationale here.

const ROOT = process.env.DATA_ROOT ?? "data";
const RESOLUTIONS = "fixtures/pm-resolutions-2026-09-15.json";
const CAPTURE = "fixtures/pm-books-2026-09-15.json";

type Level = { price: string; size: string };
type Book = { bids: Level[]; asks: Level[] };
type BookCapture = { captured_at: string; source: string; books: Record<string, Book> };
type Resolutions = {
  markets: Record<string, {
    closed: boolean; market_slug: string; minimum_tick_size: number; minimum_order_size: number;
    tokens: { token_id: string; outcome: string }[];
  }>;
};

/** Best bid is the highest, best ask the lowest — the API returns each side in its own
 *  order and it is not the one you would guess, so both are sorted here rather than
 *  indexed. An empty side is a real state on this venue and reads as null, never as 0. */
function best(levels: Level[], side: "bid" | "ask"): number | null {
  const prices = levels.map((l) => Number(l.price)).filter(Number.isFinite);
  if (prices.length === 0) return null;
  return side === "bid" ? Math.max(...prices) : Math.min(...prices);
}

/** Dollars of *our* side purchasable at or under `limit`, walking the ask side.
 *  `size` is in shares, so the cost of a level is price × size. */
function depthUsd(asks: Level[], limit: number): number {
  return asks
    .map((l) => ({ p: Number(l.price), s: Number(l.size) }))
    .filter((l) => Number.isFinite(l.p) && Number.isFinite(l.s) && l.p <= limit + 1e-9)
    .reduce((a, l) => a + l.p * l.s, 0);
}

/** The synthetic ask the complementary token implies: someone bidding `b` for the other
 *  outcome is offering ours at `1 − b`, and the exchange mints the pair to match them. */
function impliedAsk(otherBid: number | null): number | null {
  return otherBid === null ? null : 1 - otherBid;
}

async function fetchBooks(tokenIds: string[]): Promise<void> {
  const books: Record<string, Book> = {};
  const queue = [...tokenIds];
  let done = 0;
  const worker = async (): Promise<void> => {
    while (queue.length) {
      const id = queue.shift();
      if (!id) return;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(`https://clob.polymarket.com/book?token_id=${id}`, { signal: AbortSignal.timeout(25_000) });
          if (r.status === 429) {
            await new Promise((z) => setTimeout(z, 2000 * (attempt + 1)));
            continue;
          }
          if (!r.ok) break;
          const b = (await r.json()) as Book;
          books[id] = { bids: b.bids ?? [], asks: b.asks ?? [] };
          break;
        } catch {
          await new Promise((z) => setTimeout(z, 1500 * (attempt + 1)));
        }
      }
      if (++done % 25 === 0) process.stderr.write(`  ${done}/${tokenIds.length}\n`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  writeFileSync(CAPTURE, JSON.stringify({
    captured_at: new Date().toISOString(), source: "https://clob.polymarket.com/book?token_id=<id>", books,
  }, null, 1));
  console.log(`captured ${Object.keys(books).length} of ${tokenIds.length} books → ${CAPTURE}`);
}

type Quote = {
  key: string; s: PmSignal; slug: string; tick: number;
  ourBid: number | null; ourAsk: number | null; otherBid: number | null;
  effAsk: number | null; mid: number | null;
  spreadC: number | null; gapC: number | null;
  hop: number | null; hopSaveC: number | null;
  d1: number; d2: number; d5: number; deep: number;
};

function quotes(): { rows: Quote[]; capturedAt: string } {
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const cap = JSON.parse(readFileSync(CAPTURE, "utf8")) as BookCapture;
  const polls = readPmArchive(ROOT);
  const last = new Map<string, PmSignal>();
  for (const poll of polls) {
    for (const s of poll.signals) {
      if (s.market.venue === "polymarket") last.set(stablePmKey(s), s);
    }
  }
  const rows: Quote[] = [];
  for (const [key, s] of last) {
    const m = res.markets[s.market.condition_id ?? ""];
    if (!m || m.closed) continue;
    const ours = m.tokens.find((t) => t.outcome.toUpperCase() === s.side);
    const other = m.tokens.find((t) => t.outcome.toUpperCase() !== s.side);
    if (!ours || !other) continue;
    const ob = cap.books[ours.token_id];
    const xb = cap.books[other.token_id];
    if (!ob || !xb) continue;

    const ourBid = best(ob.bids, "bid");
    const ourAsk = best(ob.asks, "ask");
    const otherBid = best(xb.bids, "bid");
    const implied = impliedAsk(otherBid);
    const effAsk = ourAsk === null ? implied : implied === null ? ourAsk : Math.min(ourAsk, implied);
    const tick = m.minimum_tick_size || 0.01;
    // One tick above the resting bid: the cheapest price that is still the best bid, and
    // the owner's "last order + 0.01" written in the venue's own tick.
    const hop = ourBid === null ? null : Math.min(ourBid + tick, effAsk ?? 1);
    rows.push({
      key, s, slug: m.market_slug, tick,
      ourBid, ourAsk, otherBid, effAsk,
      mid: ourBid !== null && effAsk !== null ? (ourBid + effAsk) / 2 : null,
      spreadC: ourBid !== null && effAsk !== null ? 100 * (effAsk - ourBid) : null,
      // How much worse the visible ask is than the complementary one implies.
      gapC: ourAsk !== null && implied !== null ? 100 * (ourAsk - implied) : null,
      hopSaveC: hop !== null && effAsk !== null ? 100 * (effAsk - hop) : null,
      hop,
      d1: effAsk === null ? 0 : depthUsd(ob.asks, effAsk + 0.01),
      d2: effAsk === null ? 0 : depthUsd(ob.asks, effAsk + 0.02),
      d5: effAsk === null ? 0 : depthUsd(ob.asks, effAsk + 0.05),
      deep: depthUsd(ob.asks, 1),
    });
  }
  return { rows, capturedAt: cap.captured_at };
}

const q = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] ?? NaN;
};
const money = (x: number): string => (x >= 1000 ? `$${Math.round(x / 1000)}k` : `$${x.toFixed(0)}`);

function main(): void {
  const { rows, capturedAt } = quotes();
  if (rows.length === 0) {
    console.log(`No live books. Run \`npm run probe:pm-book -- --fetch\` (needs the archive under ${ROOT}).`);
    return;
  }
  console.log(`\n=== the book we would actually pay — ${rows.length} live signals, captured ${capturedAt.slice(0, 16)}Z ===\n`);
  console.log(`  every signal's own quote_method reads "midpoint" on 127/127, so the census's entry price is`);
  console.log(`  the middle of what follows. This is the first time any of it has been measured.\n`);

  // ---- 0. books that are not books
  //
  // ⚠ Several markets Polymarket still reports open have already been decided in practice:
  // the losing token's ask sits at 0-1c and the winning one at 99-100c, and the "spread" on
  // such a book is the width of an empty market, not a cost we would pay. They are counted
  // and then excluded, because averaging them into a spread census is how a statistic ends
  // up describing markets nobody would trade.
  const degenerate = rows.filter((r) => r.effAsk === null || r.effAsk <= 0.02 || r.effAsk >= 0.98);
  const live = rows.filter((r) => !degenerate.includes(r));
  console.log(`  ⚠ ${degenerate.length} of ${rows.length} are already decided in practice — our side's effective ask is at or past`);
  console.log(`  2c/98c — and are excluded below. A book on a settled question is not a spread we would pay.\n`);

  // ---- 1. the spread
  const withSpread = live.filter((r) => r.spreadC !== null);
  const sp = withSpread.map((r) => r.spreadC as number);
  console.log(`--- 1. the spread, best bid to effective best ask ---\n`);
  console.log(`  n=${sp.length}   min ${q(sp, 0).toFixed(1)}c · p25 ${q(sp, 0.25).toFixed(1)}c · median ${q(sp, 0.5).toFixed(1)}c · p75 ${q(sp, 0.75).toFixed(1)}c · p90 ${q(sp, 0.9).toFixed(1)}c · max ${q(sp, 1).toFixed(1)}c`);
  const half = sp.map((x) => x / 2);
  console.log(`  crossing costs half of it against the midpoint the census quotes: median ${q(half, 0.5).toFixed(2)}c, p90 ${q(half, 0.9).toFixed(2)}c`);
  const meanPrice = live.filter((r) => r.mid !== null).map((r) => r.mid as number);
  const asPct = withSpread.map((r) => (r.spreadC as number) / 2 / 100 / (r.mid as number));
  console.log(`  as a share of the price paid: median ${(100 * q(asPct, 0.5)).toFixed(1)}% · p90 ${(100 * q(asPct, 0.9)).toFixed(1)}%   (mean mid ${(100 * q(meanPrice, 0.5)).toFixed(0)}c)`);
  console.log(`  ⚠ compare the platform taker fee, feeRate x (1-p) — 2.2% of stake at a 56c entry and 0.05:`);
  console.log(`    ${asPct.filter((x) => x > 0.022).length} of ${asPct.length} books have a half-spread wider than that fee, ${asPct.filter((x) => x <= 0.022).length} narrower.`);
  console.log(`    So on most of this feed **the fee is the larger half of the cost of crossing**, and the`);
  console.log(`    maker posture is worth more than the spread it also saves.\n`);

  // ---- 2. the complementary book
  console.log(`--- 2. ⚠⚠ is the other side's book cheaper? ---\n`);
  const gaps = live.filter((r) => r.gapC !== null).map((r) => r.gapC as number);
  const cheaper = gaps.filter((g) => g > 0.05).length;
  const same = gaps.filter((g) => Math.abs(g) <= 0.05).length;
  const worse = gaps.filter((g) => g < -0.05).length;
  console.log(`  visible ask on our token vs 1 − (best bid on the other token), n=${gaps.length}:`);
  console.log(`    the complementary book is CHEAPER on ${cheaper}   ·   identical on ${same}   ·   our own book cheaper on ${worse}`);
  if (cheaper > 0) {
    const g = gaps.filter((x) => x > 0.05);
    console.log(`    where it is cheaper, by median ${q(g, 0.5).toFixed(1)}c and up to ${q(g, 1).toFixed(1)}c`);
  }
  const onlyOne = live.filter((r) => r.ourAsk === null || r.otherBid === null).length;
  console.log(`    ⚠ ${onlyOne} signals have one of the two sides empty, where reading a single book gives no price at all`);
  console.log(`  **So the price to beat is min(our ask, 1 − their bid)**, and every number below uses it.\n`);

  // ---- 3. resting inside the spread
  console.log(`--- 3. "last order + one tick" — what resting inside the spread is worth ---\n`);
  const hops = live.filter((r) => r.hopSaveC !== null && r.spreadC !== null && (r.spreadC as number) > 0);
  const saves = hops.map((r) => r.hopSaveC as number);
  console.log(`  n=${hops.length} with a non-zero spread · tick sizes present: ${[...new Set(live.map((r) => r.tick))].sort().map((t) => `${t}`).join(", ")}`);
  console.log(`  posting at best bid + one tick instead of crossing saves:`);
  console.log(`    median ${q(saves, 0.5).toFixed(1)}c · p75 ${q(saves, 0.75).toFixed(1)}c · p90 ${q(saves, 0.9).toFixed(1)}c · max ${q(saves, 1).toFixed(1)}c of a $1 contract`);
  const savePct = hops.map((r) => (r.hopSaveC as number) / 100 / (r.mid as number));
  console.log(`    = median ${(100 * q(savePct, 0.5)).toFixed(1)}% of stake, p90 ${(100 * q(savePct, 0.9)).toFixed(1)}%  — on top of the ~2.2% taker fee a maker never pays`);
  const roomToImprove = hops.filter((r) => (r.hopSaveC as number) >= 100 * r.tick).length;
  console.log(`  ⚠ ${roomToImprove} of ${hops.length} books are wide enough to *improve* the bid and still be inside the ask.`);
  console.log(`    On the rest, "best bid + a tick" IS the ask — the order crosses and pays the taker fee anyway.`);
  console.log(`  ⚠⚠ None of this says the order FILLS. That is the question no book snapshot answers.\n`);

  // ---- 4. depth, and the balance it caps
  console.log(`--- 4. depth on our side, and the account size it stops fitting ---\n`);
  const d1 = live.map((r) => r.d1);
  const d2 = live.map((r) => r.d2);
  const d5 = live.map((r) => r.d5);
  console.log(`  dollars buyable without moving the price more than…`);
  console.log(`    +1c   median ${money(q(d1, 0.5))} · p25 ${money(q(d1, 0.25))} · p10 ${money(q(d1, 0.1))} · min ${money(q(d1, 0))}`);
  console.log(`    +2c   median ${money(q(d2, 0.5))} · p25 ${money(q(d2, 0.25))} · p10 ${money(q(d2, 0.1))} · min ${money(q(d2, 0))}`);
  console.log(`    +5c   median ${money(q(d5, 0.5))} · p25 ${money(q(d5, 0.25))} · p10 ${money(q(d5, 0.1))} · min ${money(q(d5, 0))}`);
  console.log(`\n  an account of B spread over N concurrent signals puts B/N into each. The binding`);
  console.log(`  constraint is the THINNEST book it must enter, not the median one:\n`);
  console.log(`    slots N   ticket at B=$1k   $10k     $100k     ⟵ B where 1 book in 10 cannot take it (+2c)`);
  for (const N of [20, 70, 168]) {
    const p10 = q(d2, 0.1);
    const cap = p10 * N;
    console.log(
      `    ${String(N).padStart(7)}   ${money(1000 / N).padStart(14)}   ${money(10_000 / N).padStart(6)}   ${money(100_000 / N).padStart(7)}     ${money(cap).padStart(10)}`,
    );
  }
  console.log(`\n  and what that costs a large account, summed over the live book rather than at a quantile —`);
  console.log(`  deployable = Σ min(B/N, depth at +2c), which is what a per-market depth cap would actually place:\n`);
  console.log(`    balance     N=20 slots        N=70            N=168`);
  for (const B of [1_000, 10_000, 100_000, 1_000_000]) {
    const cells = [20, 70, 168].map((N) => {
      const ticket = B / N;
      // Only the N deepest books get used when N is below the live count: a cap that has to
      // choose would choose those, so this is the friendliest honest reading.
      const books = [...live].sort((a, b) => b.d2 - a.d2).slice(0, Math.min(N, live.length)).map((r) => r.d2);
      const placed = books.reduce((a, d) => a + Math.min(ticket, d), 0);
      const want = ticket * books.length;
      return `${money(placed).padStart(6)} of ${money(want).padEnd(6)} ${`${((100 * placed) / want).toFixed(0)}%`.padStart(5)}`;
    });
    console.log(`    ${money(B).padStart(7)}     ${cells.join("   ")}`);
  }
  console.log(`\n  ⚠ Below ${live.length} live signals the N=70 and N=168 columns are capped by how many markets exist,`);
  console.log(`  not by depth — they place the same ticket into fewer books. Read the percentage, not the dollars.`);

  console.log(`\n  ⚠ The right-hand column above is where depth STARTS TO BIND — the balance at which one`);
  console.log(`  book in ten cannot take the ticket — and not a ceiling. The table underneath is the cost:`);
  console.log(`  a six-figure account still places most of its money, and the constraint only becomes`);
  console.log(`  expensive around seven figures. Held to resolution there is no exit leg to reserve room`);
  console.log(`  for — redemption pays $1 whatever the book does — so depth caps the ENTRY alone, which is`);
  console.log(`  the opposite of src/risk/capacity.ts's job on perps, where the exit is what has to fit.\n`);

  // ---- 5. the thin tail, named
  const thin = [...live].sort((a, b) => a.d2 - b.d2).slice(0, 8);
  console.log(`--- 5. the thinnest books we would be entering ---\n`);
  console.log(`    $ at +2c   spread   eff ask   slug`);
  for (const r of thin) {
    console.log(
      `    ${money(r.d2).padStart(8)}   ${(r.spreadC === null ? "—" : `${r.spreadC.toFixed(0)}c`).padStart(6)}   ${(r.effAsk === null ? "—" : `${(100 * r.effAsk).toFixed(0)}c`).padStart(7)}   ${r.slug.slice(0, 58)}`,
    );
  }
  console.log();
}

if (process.argv.slice(2).includes("--fetch")) {
  const res = JSON.parse(readFileSync(RESOLUTIONS, "utf8")) as Resolutions;
  const ids = [...new Set(Object.values(res.markets).filter((m) => !m.closed).flatMap((m) => m.tokens.map((t) => t.token_id)))];
  console.log(`fetching ${ids.length} books (both sides of ${ids.length / 2} open markets), unauthenticated…`);
  void fetchBooks(ids).then(main);
} else if (!existsSync(CAPTURE)) {
  console.log(`No book capture at ${CAPTURE}. Run \`npm run probe:pm-book -- --fetch\` first.`);
} else {
  main();
}
