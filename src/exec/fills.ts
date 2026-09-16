import type { InfoClient } from "@nktkas/hyperliquid";
import { parseCloid } from "../hl/cloid.ts";
import { RISK_PARAMS } from "../risk/params.ts";
import type { Universe } from "../hl/universe.ts";
import type { FillRow, FundingRow, IntentRow, Store } from "../store/db.ts";
import type { CloseReason } from "../types.ts";

// What a trade actually cost.
//
// `intents.realized_pnl` is an estimate and says so: `(exit price − entry price) ×
// size`, with the exit's **armed** price standing in for the price it filled at, no
// fees and no funding. `src/exec/loop.ts` logs it as `P&L ≈`. This module replaces it
// with the venue's own rows — and keeps the estimate alongside, because the gap
// between them is a number `tasks/07` wants and nobody could recover once it was gone.
//
// The gap is not what `tasks/08` predicted, and the measurement is worth stating
// before the code that produced it. Across 18 closed live intents on 2026-09-02 the
// estimate read −$1.80 and the truth was **+$1.55**: wrong by $3.35 and wrong in the
// *optimistic-for-nobody* direction, understating the return rather than flattering
// it. The task expected the opposite — "ours will be the higher one, because every
// term we omit is a cost" — and the reason it is backwards is that the omitted costs
// are not the dominant error. A forced close is an IOC priced a slippage band from
// the mark, so the estimate books 30bps of notional that was never paid, against a
// fee of 0.864bps on an `xyz:` market. The wrong term is 35× the missing one.
//
// So this is not a cost correction bolted onto a good number. It is the number.

/** Where an ingested fill came from.
 *
 *  - `cloid` — our tag, which is the third job `src/hl/cloid.ts` exists for. Present
 *    on **every** fill of ours in the live capture (24/24 tagged orders).
 *  - `oid` — the fallback, matched against `orders.oid`. Not needed so far.
 *  - `liquidation` — Hyperliquid's own liquidation engine closing a position. It
 *    carries no cloid, so it read as `foreign` until 2026-09-13 and the account halted
 *    saying it had a second actor. There is no second actor and our accounting is
 *    fine: we know exactly which position closed and why. It still halts — an account
 *    that has just been liquidated should stop — but under its own name.
 *  - `foreign` — a fill on a market we manage carrying none of our tags **and no
 *    liquidation object**. A second actor on the account, and the halt condition.
 *  - `out-of-scope` — a market outside `RISK_PARAMS.tradedDexes`: spot, or another
 *    HIP-3 dex. `userFillsByTime` returns those too, and they are recorded and never
 *    halted on, because we never claimed to watch them. Halting a live account
 *    because its owner converted some spot dust would be a fault of ours, not
 *    detection working. */
export type Attribution = "cloid" | "oid" | "liquidation" | "foreign" | "out-of-scope";

/** The shape we consume, which is `UserFill & { cloid?: … }` from the SDK narrowed to
 *  what we store. Declared here rather than imported so the ingester's pure half can
 *  be driven from a fixture. */
export type VenueFill = {
  coin: string; px: string; sz: string; side: string; time: number; dir: string;
  closedPnl: string; hash: string; oid: number; crossed: boolean; fee: string;
  tid: number; feeToken: string; cloid?: string;
  /** Present only on a fill Hyperliquid's own liquidation engine produced. The live
   *  row that cost us three wrong answers, verbatim:
   *  `{"liquidatedUser":"0xacc00006…","markPx":"6.6372","method":"market"}`. */
  liquidation?: { liquidatedUser?: string; markPx?: string; method?: string } | null;
};

export type VenueFunding = {
  time: number;
  delta: { coin: string; usdc: string; szi: string; fundingRate: string };
};

export type AttributionMaps = {
  inScope: (coin: string) => boolean;
  /** Which intent held this market at this instant, for a fill the venue generated
   *  itself and therefore did not tag. `Store.intentHoldingAt`; a dependency rather
   *  than a call so the attribution half stays drivable from a fixture. */
  heldAt: (coin: string, timeMs: number) => string | null;
  /** `orders.cloid` → intent. The exact link, and the usual one. */
  cloidToIntent: Map<string, string>;
  /** The cloid's embedded 8-byte intent prefix → intent, built from `intents` alone.
   *  Catches a fill whose order row was never written — the process dying between
   *  `broker.place()` and `recordOrder()` is a real window, and the tag on the venue
   *  is what closes it. */
  prefixToIntent: Map<string, string>;
  /** `orders.oid` → intent, for a fill that carries no cloid at all. */
  oidToIntent: Map<number, string>;
};

/** Which intent a fill belongs to. Pure.
 *
 *  **cloid first**, because the tag is on the venue and therefore survives losing our
 *  database entirely; `oid` is a fallback that only works while `orders` is intact.
 *  A fill that matches neither, on a market we manage, is not a row to drop. */
export function attributeFill(f: VenueFill, ctx: AttributionMaps): { intentId: string | null; attribution: Attribution } {
  // **Before the cloid**, deliberately. A liquidation never carries one today, so the
  // order does not matter for what the venue actually sends — but if it ever did, the
  // fact that the venue liquidated the position is the one that must survive, and
  // reading it second would let our own tag paint over it.
  if (isLiquidation(f)) {
    return { intentId: ctx.heldAt(f.coin, f.time), attribution: "liquidation" };
  }
  const tagged = parseCloid(f.cloid);
  if (tagged) {
    // Ours beyond doubt: the magic byte and version matched. Which intent is a second
    // question, and a fill we cannot place is still not a foreign one — the account
    // does not get halted because our own bookkeeping has a hole in it.
    const id = (f.cloid ? ctx.cloidToIntent.get(f.cloid.toLowerCase()) : undefined)
      ?? ctx.prefixToIntent.get(tagged.intentPrefix)
      ?? null;
    return { intentId: id, attribution: "cloid" };
  }
  const byOid = ctx.oidToIntent.get(f.oid);
  if (byOid) return { intentId: byOid, attribution: "oid" };
  return { intentId: null, attribution: ctx.inScope(f.coin) ? "foreign" : "out-of-scope" };
}

/** Whether the venue says it liquidated this position.
 *
 *  Presence of the object, not a string match on `method` — the field exists only on a
 *  liquidation, and `method` is the venue's own enum (`"market"` on the one we have
 *  seen) which we have no business asserting the values of. `CLAUDE.md` forbids
 *  fuzzy-matching a symbol; guessing at an enum we were never given the range of is the
 *  same mistake in a different field. */
export function isLiquidation(f: Pick<VenueFill, "liquidation">): boolean {
  return f.liquidation !== undefined && f.liquidation !== null;
}

export type Settlement = {
  grossUsd: number | null;
  feeUsd: number | null;
  fundingUsd: number | null;
  netUsd: number | null;
  /** Why the numbers above are null, or a caveat on them when they are not. Null when
   *  the settlement is clean. */
  note: string | null;
};

/** What one intent's trip actually returned. Pure, and the arithmetic that touches
 *  money, so it is unit-tested rather than trusted.
 *
 *  `net = Σ closedPnl − Σ fee + Σ funding`, and each term's sign was verified against
 *  live rows rather than read out of the SDK's types:
 *
 *  - `closedPnl` is **gross** and sits on the closing leg only; an opening fill
 *    reports `0.0`. It nets neither fees nor funding.
 *  - `fee` is positive when charged. The type documents a negative as a rebate; no
 *    live fill has produced one, maker fills included (0.3bps on an `xyz:` maker fill
 *    is still a charge), so it is subtracted unconditionally and a rebate would add
 *    back on its own.
 *  - funding's `usdc` is signed from the account's side — positive received, negative
 *    paid — so it is **added**, not subtracted. A short in a positive funding regime
 *    receives, and the sign in the row says so. */
export function settleIntent(fills: FillRow[], funding: FundingRow[]): Settlement {
  if (fills.length === 0) {
    return { grossUsd: null, feeUsd: null, fundingUsd: null, netUsd: null, note: "no venue fills attributed to this intent" };
  }
  const foreignToken = [...new Set(fills.map((f) => f.fee_token).filter((t) => t !== "USDC"))];
  const gross = round(fills.reduce((t, f) => t + f.closed_pnl, 0));
  const fee = round(fills.reduce((t, f) => t + f.fee, 0));
  const fund = round(funding.reduce((t, f) => t + f.usdc, 0));
  const closed = fills.some(isClosingFill);
  const notes: string[] = [];
  if (!closed) notes.push("no closing fill on the venue — the position was never closed by us");
  if (foreignToken.length > 0) notes.push(`fees charged in ${foreignToken.join(", ")}, not USDC — not subtracted as dollars`);
  return {
    grossUsd: gross,
    feeUsd: fee,
    fundingUsd: fund,
    // A trip with no closing fill has no realised return to report, whatever the
    // opening fill cost. Reporting `−fee` there would read as a small loss on a
    // position that is still running.
    netUsd: closed ? round(gross - fee + fund) : null,
    note: notes.length === 0 ? null : notes.join("; "),
  };
}

/** Why a position closed, read from the venue's own fills rather than from our plan.
 *
 *  This exists because the plan is not evidence about the venue, and for a while the
 *  ledger said it was: **6 of 22 closed live trades hit their take-profit and were
 *  recorded — and shown to the account's owner — as "the forecast was withdrawn"**
 *  (`notes/2026-09-02-close-reason-misattributed.md`). All of the profit was in those
 *  six, so grouping by the recorded reason made retirement look like the profitable
 *  exit when it was the losing one.
 *
 *  The fix could not live in `settleLedger` alone, which is where it looks like it
 *  belongs. That code asks `orders` whether a `tp` filled, and **`orders` can never
 *  say yes**: a status of `filled` is written once, at placement, from the IOC's own
 *  response (`src/exec/loop.ts`), and a resting trigger places with `filledSz: 0`.
 *  When it later fills on the venue nothing updates the row. Across the whole live
 *  ledger, `tp` and `sl` orders are 13 `placed` and 15 `gone` and **zero `filled`**.
 *  So the answer has to come from the fills, which carry our `cloid`, whose third
 *  byte is the role — the same tag that makes foreign-actor detection survive losing
 *  the database.
 *
 *  **Only an unambiguous exit is reported.** A `close`-role order is placed for a
 *  horizon, a retirement and a halt alike, so its role cannot tell those apart and the
 *  plan's decision has to. A `tp` or `sl` trigger fires for exactly one reason, but
 *  only when it is the *whole* story: if a take-profit filled part of a position and a
 *  retirement closed the rest, both are true, and this returns null so the plan's
 *  decision stands. That is deliberately conservative — it can under-report a target
 *  and never invent one. No live intent has yet closed on a mixed exit. */
export function exitFromFills(fills: FillRow[]): CloseReason | null {
  // **A liquidation wins outright, and it is the one exit that is not required to be
  // unambiguous.** Everything else here under-reports rather than invents: a target
  // that closed half a position beside a retirement that closed the rest reports
  // neither, because both are true. A liquidation is different in kind — there is no
  // reading under which a position that was partly liquidated was not liquidated — and
  // it is the worst outcome this system can produce, which had been recording as
  // `retired` and counting in `npm run expectancy` as an ordinary exit.
  if (fills.some((f) => isClosingFill(f) && f.liquidation !== null)) return "liquidated";
  const roles = new Set<string>();
  for (const f of fills) {
    if (!isClosingFill(f)) continue;
    const tag = parseCloid(f.cloid);
    // An untagged closing fill is not ours to interpret — a second actor, or a
    // liquidation the venue did not label. Either way the exit is no longer unambiguous.
    roles.add(tag ? tag.role : "untagged");
  }
  if (roles.size !== 1) return null;
  const only = [...roles][0];
  return only === "tp" ? "target" : only === "sl" ? "stop" : null;
}

/** A fill that reduced or closed a position. `dir` is the venue's own wording, and the
 *  liquidation we have is spelled `Close Long` like any other — so the flag is checked
 *  as well, rather than trusting a prefix to carry a fact we now store directly. */
function isClosingFill(f: Pick<FillRow, "dir" | "liquidation">): boolean {
  return f.dir.startsWith("Close") || f.dir.startsWith("Liquidat") || f.liquidation !== null;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/** Whether to read this account's fills now, given what the tick just did.
 *
 *  The slow cycle is what the ingest is *for* — it answers what a trade cost, and
 *  nothing in the decision path reads that. **A close is the exception, because one
 *  thing in the decision path does read a column only this ingest can write.**
 *
 *  `settleLedger` cannot tell a venue-side stop from a retirement. Our own `orders`
 *  row is stamped `placed` once, at placement, and never again, so a resting trigger
 *  never reads as `filled`; and Hyperliquid cancels the sibling trigger the instant
 *  the position goes, so "which of our exits stopped resting" does not discriminate
 *  either — over 1,300 live orders there is not one `orphaned` row. Every trigger exit
 *  therefore lands in the ledger as `retired`, and `exitFromFills` relabels it `stop`
 *  only when this ingest reads the venue's own rows.
 *
 *  `blockReentryAfterStop` keys on `close_reason = 'stop'`. At `fillIngestSec` alone
 *  the guard is blind for up to five minutes after every stop while the loop comes
 *  round every sixty seconds, and the desk walks back into the market that just
 *  stopped it out. That is not a hypothetical: of 22 post-stop re-entries since the
 *  guard shipped on 2026-09-11, **every one landed 73–193s after its own stop**, and
 *  all 19 refusals came at 202s or more — the guard only ever won when the ingest
 *  happened to land first (`tasks/51`, `notes/2026-09-14-the-guard-that-lost-the-race.md`).
 *
 *  So: ingest on any close, not only on a stop. We cannot tell which it was — that is
 *  precisely the defect — and two `info` calls on the few ticks a day that close
 *  something is not a cost worth reasoning about.
 *
 *  ⚠ **Turning `fillIngestSec` down is not the fix and cannot be.** It is one of the
 *  43 `configHash` leaves, so moving it is a money-constant change: it writes a
 *  `config` event, costs the accumulating block its reading, and — since the speed
 *  limit armed on 2026-09-14 — is refused at boot without `CONFIG_OVERRIDE`. This
 *  predicate moves no constant. */
export function shouldIngestFills(mode: string, closedThisTick: boolean, sinceLastMs: number): boolean {
  // A paper account has no venue fills, so ingesting one would flag every simulated
  // trip as an unattributable mystery.
  if (mode !== "live") return false;
  return closedThisTick || sinceLastMs >= RISK_PARAMS.fillIngestSec * 1000;
}

// ── The ingester ────────────────────────────────────────────────────────────

export type IngestDeps = {
  info: InfoClient;
  store: Store;
  universe: Universe;
  master: string;
  log: (msg: string) => void;
  notify: (msg: string) => Promise<unknown>;
  now?: Date;
};

export type IngestReport = {
  fills: number;
  funding: number;
  /** Fills on a market we manage carrying none of our tags, seen for the first time
   *  **after** this account's watermark existed. A backfill reports zero here however
   *  many it finds, which is the whole reason the watermark is checked. */
  newForeign: number;
  /** Positions Hyperliquid liquidated, counted on the same watermark rule and for the
   *  same reason. Separate from `newForeign` because they are different events with
   *  different sentences, and pooling them is what made an account read as having a
   *  second actor that did not exist. */
  newLiquidations: number;
  settled: number;
  /** True when this was the account's first pass and nothing was halted on. */
  backfill: boolean;
  /** True on the one pass that re-read the whole fill history to pick up
   *  `fills.liquidation` on rows ingested before the column existed. */
  rescanned: boolean;
};

/** HL pages `userFillsByTime`. The documented cap is 2000; ask for the next page
 *  whenever a response comes back at or above it rather than trusting the number. */
const PAGE = 2000;

/** One ingestion pass for one account. Live accounts only — a paper account has no
 *  venue fills at all, and treating its intents as unattributable would flag every
 *  simulated trip as a foreign-fill mystery. (The live ledger already holds one such
 *  intent: a paper account opened 747 units of `xyz:COPPER` at 20x, and Hyperliquid
 *  has never seen a fill on that address.) */
export async function ingestAccount(d: IngestDeps): Promise<IngestReport> {
  const now = d.now ?? new Date();
  const user = d.master as `0x${string}`;
  const inScope = (coin: string) => d.universe.resolve(coin) !== null;

  const fillMark = d.store.watermark(d.master, "fills");
  const backfill = fillMark === null;
  // **One pass that ignores the watermark, once per account ever.** Every fill ingested
  // before `fills.liquidation` existed was stored with the field dropped, and a
  // liquidation is months behind the watermark by the time the column ships — so
  // resuming normally would repair nothing and the 2026-09-10 `xyz:COPPER` trip would
  // keep reading its own estimate forever. `insertFill` repairs a liquidation on an
  // ignored insert and leaves every other row exactly as it was, so re-reading the
  // history is idempotent and the only cost is one extra page walk, one time.
  //
  // Its own watermark stream, not a flag on the account: the ledger already records how
  // far each stream has been ingested, and a rescan that "has run" is the same kind of
  // fact. The value stored is the instant it ran, which nothing reads — the presence of
  // the row is the whole state.
  const rescanned = d.store.watermark(d.master, "fills-liquidation-rescan") === null;
  // Resume **at** the watermark, not past it. Several fills can share a millisecond —
  // the live ledger has an ETH close split into two at the same `time` — and `tid`
  // makes re-reading the boundary free, where skipping it would silently lose one leg
  // of a partial fill.
  const earliest = earliestInterest(d.store, d.master);
  const from = rescanned ? earliest : (fillMark ?? earliest);

  const maps = d.store.attributionMaps();
  const ctx: AttributionMaps = {
    inScope,
    heldAt: (coin, timeMs) => d.store.intentHoldingAt(d.master, coin, timeMs),
    ...maps,
  };
  let inserted = 0;
  let newForeign = 0;
  let newLiquidations = 0;
  let cursor = from;
  let latest = fillMark ?? from;

  for (;;) {
    const page = await d.info.userFillsByTime({ user, startTime: cursor }) as unknown as VenueFill[];
    for (const f of page) {
      const { intentId, attribution } = attributeFill(f, ctx);
      const isNew = d.store.insertFill({
        account: d.master, tid: f.tid, time: f.time, coin: f.coin, side: f.side, dir: f.dir,
        px: Number(f.px), sz: Number(f.sz), closed_pnl: Number(f.closedPnl), fee: Number(f.fee),
        fee_token: f.feeToken, crossed: f.crossed ? 1 : 0, oid: f.oid ?? null,
        cloid: f.cloid ?? null, hash: f.hash ?? null, intent_id: intentId, attribution,
        liquidation: f.liquidation ? JSON.stringify(f.liquidation) : null,
      });
      if (isNew) inserted++;
      // A foreign fill is news only if we were already watching. The first pass over
      // an account is a backfill of trades that predate us, and halting on those would
      // re-halt accounts whose owners hand-traded once, weeks ago, and whose halts an
      // operator has already cleared.
      if (isNew && attribution === "foreign" && !backfill) newForeign++;
      // The same rule for a liquidation, and the rescan is covered by it for free:
      // every row it re-reads is already stored, so `isNew` is false and a repair can
      // never re-halt an account for a liquidation somebody has already dealt with.
      if (isNew && attribution === "liquidation" && !backfill) newLiquidations++;
      if (f.time > latest) latest = f.time;
    }
    if (page.length < PAGE) break;
    const maxTime = Math.max(...page.map((f) => f.time));
    if (maxTime < cursor) break;          // no progress; refuse to spin
    cursor = maxTime + 1;
  }
  if (latest > (fillMark ?? -1)) d.store.setWatermark(d.master, "fills", latest, now);
  // Only after the walk completed. A pass that threw halfway leaves no row, so the next
  // one rescans — the whole repair is idempotent, and a half-repaired history is the
  // one state worth never recording as done.
  if (rescanned) d.store.setWatermark(d.master, "fills-liquidation-rescan", now.getTime(), now);

  // Funding, on its own watermark: it arrives hourly whether or not anything traded,
  // so its high-water mark moves independently of the fill stream's.
  const fundMark = d.store.watermark(d.master, "funding");
  const fundFrom = fundMark ?? from;
  const fundingRows = await d.info.userFunding({ user, startTime: fundFrom }) as unknown as VenueFunding[];
  let fundInserted = 0;
  let fundLatest = fundMark ?? fundFrom;
  for (const r of fundingRows) {
    if (d.store.insertFunding({
      account: d.master, time: r.time, coin: r.delta.coin, usdc: Number(r.delta.usdc),
      szi: Number(r.delta.szi), funding_rate: Number(r.delta.fundingRate), intent_id: null,
    })) fundInserted++;
    if (r.time > fundLatest) fundLatest = r.time;
  }
  if (fundLatest > (fundMark ?? -1)) d.store.setWatermark(d.master, "funding", fundLatest, now);

  attributeFunding(d.store, d.master, now);
  const settled = settleClosed(d.store, d.master);

  // **Two halts, two sentences, and the order matters.** A liquidation used to produce
  // the foreign-actor halt above, which sent an operator looking for a person who did
  // not exist — and it is also the reason a *real* second actor was indistinguishable
  // from the venue's own engine. The liquidation is checked first because when both are
  // true the liquidation is the thing that happened; the foreign count no longer
  // includes it, so the two cannot both fire on one fill.
  if (newLiquidations > 0) {
    const reason =
      `Hyperliquid liquidated ${newLiquidations} position(s) on this account — this is the venue's ` +
      "own close, not a second actor, and the stop we placed did not fill before it";
    d.store.setHalt(d.master, true, reason, "liquidation");
    d.store.recordEvent(d.master, "halt", reason, now);
    d.log(`HALT: ${reason}`);
    await d.notify(
      `🔴 SignalDesk HALT · ${d.master}\n${reason}\n` +
      "No new positions. Existing venue-side stops stay live.",
    );
  } else if (newForeign > 0) {
    const reason =
      `${newForeign} fill(s) on this account were not placed by us — the account has a second ` +
      "actor and our position accounting can no longer be trusted";
    // `foreign-position`, not a fifth kind. A foreign *fill* and a foreign *position*
    // are the same fact seen at two moments — the fill check catches a second actor who
    // opened and closed inside one tick, which the position check cannot see at all —
    // and the sentence the desk shows for both is the same one.
    d.store.setHalt(d.master, true, reason, "foreign-position");
    d.store.recordEvent(d.master, "halt", reason, now);
    d.log(`HALT: ${reason}`);
    await d.notify(
      `🔴 SignalDesk HALT · ${d.master}\n${reason}\n` +
      "No new positions. Existing venue-side stops stay live.",
    );
  }

  return { fills: inserted, funding: fundInserted, newForeign, newLiquidations, settled, backfill, rescanned };
}

/** How far back a first pass reaches: the account's connect time, or the first intent
 *  if the ledger holds one from before a reconnect. A minute of slack because the
 *  entry IOC is placed within seconds of the connect and clock skew is free to be
 *  wrong in the direction that loses the very first fill. */
function earliestInterest(store: Store, account: string): number {
  const row = store.account(account);
  const first = store.db.prepare("SELECT MIN(created_at) AS t FROM intents WHERE account = ?")
    .get(account.toLowerCase()) as { t: string | null };
  const times = [row?.connected_at, first.t]
    .filter((t): t is string => typeof t === "string")
    .map((t) => Date.parse(t))
    .filter((n) => Number.isFinite(n));
  return times.length === 0 ? Date.now() - 86_400_000 : Math.min(...times) - 60_000;
}

/** Funding is charged per coin per hour against whatever position is open, so it
 *  belongs to no fill and has to be matched to the *window* an intent held the coin.
 *
 *  The window is its first fill to its last. A live intent has no last fill yet, so
 *  its window is open-ended and closes on its own when the position does — which is
 *  why this re-runs every pass over rows still carrying no intent, rather than
 *  attributing once at insert and never again.
 *
 *  Windows on one account cannot overlap for one coin: `hasLiveIntentOn` refuses a
 *  second live intent on a coin we already hold, so at most one intent is ever open
 *  on a given market. */
export function attributeFunding(store: Store, account: string, now = new Date()): number {
  const intents = store.db.prepare(
    "SELECT * FROM intents WHERE account = ? ORDER BY created_at",
  ).all(account.toLowerCase()) as unknown as IntentRow[];
  let matched = 0;
  for (const i of intents) {
    const w = store.fillWindow(account, i.intent_id);
    if (!w) continue;
    const open = i.status !== "closed" && i.status !== "failed";
    const until = open ? now.getTime() : w.last;
    const r = store.db.prepare(
      "UPDATE funding SET intent_id = ? WHERE account = ? AND coin = ? AND intent_id IS NULL " +
      "AND time >= ? AND time <= ?",
    ).run(i.intent_id, account.toLowerCase(), i.coin, w.first, until);
    matched += Number(r.changes);
  }
  return matched;
}

/** Write `net_pnl` for every closed intent that does not have one yet, or whose
 *  attributed rows have changed since it was written.
 *
 *  Re-settling an intent that is already settled is free and idempotent, so the guard
 *  is deliberately loose: an intent is re-settled whenever its stored figures differ
 *  from what the rows now say. That is what makes a late-arriving partial fill or a
 *  funding row attributed on a later pass actually reach the number. */
/** What a non-live intent settles to: nothing, with the reason. Deliberately not a
 *  zero — a paper trip has no cost to attribute, and writing 0 would put it in the
 *  same column as a live trip that genuinely cost nothing. */
function paperSettlement(store: Store, intentId: string): Settlement {
  const fills = store.fillsFor(intentId);
  if (fills.length > 0) return settleIntent(fills, store.fundingFor(intentId));
  return {
    grossUsd: null, feeUsd: null, fundingUsd: null, netUsd: null,
    note: "not a live account — the simulated book models no fees, funding, queue position " +
      "or partial fills, so there is no cost to attribute",
  };
}

export function settleClosed(store: Store, account: string): number {
  // A paper account has no venue fills and never will, so "no fills attributed" would
  // read as a mystery rather than as the design. `src/exec/paper.ts` models no fees,
  // no funding, no queue position and no partial fills — its P&L is a correctness
  // signal about our state machine and nothing at all about returns, and the note has
  // to say so wherever the number is read.
  const live = store.account(account)?.mode === "live";
  let settled = 0;
  for (const i of store.closedIntents(account)) {
    const fills = store.fillsFor(i.intent_id);
    const s = live ? settleIntent(fills, store.fundingFor(i.intent_id)) : paperSettlement(store, i.intent_id);

    // Why it closed is settled here for the same reason what it cost is: both are
    // facts about the venue that our process could not know at close time. Correcting
    // it sits *outside* the `unchanged` guard below, because an intent whose money
    // already settled is exactly the one whose reason has been wrong the longest.
    const venueExit = exitFromFills(fills);
    let touched = false;
    if (venueExit !== null && venueExit !== i.close_reason) {
      store.setCloseReason(i.intent_id, venueExit);
      touched = true;
    }

    const unchanged = i.net_pnl === s.netUsd && i.fee_usd === s.feeUsd
      && i.funding_usd === s.fundingUsd && i.pnl_note === s.note;
    if (!unchanged) {
      store.settlePnl(i.intent_id, {
        feeUsd: s.feeUsd, fundingUsd: s.fundingUsd, netPnl: s.netUsd, note: s.note,
      });
      touched = true;
    }
    if (touched) settled++;
  }
  return settled;
}
