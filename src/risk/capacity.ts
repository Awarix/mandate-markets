import type { Side } from "../types.ts";

// Can the book fill this, and — the question that actually matters — can it let us
// back out?
//
// We size an order and send it. Until now nothing read `l2Book` and nothing read
// `dayNtlVlm`; there was no depth term anywhere in `src/risk/`. That was survivable
// while `LIVE_MANDATE.maxBaseCapitalUsd` capped an account at $100. It was removed on
// 2026-08-31, so `baseCapital` is whatever the account holds and the size we send into
// an unmeasured book has no ceiling above it. This is the half of that change that
// did not get done at the time.
//
// **This is a veto, not a sizer.** `tasks/07` §5 works it out: Cassie shrinks an order
// to fit the book because it sizes from risk-at-stop, where shrinking stays coherent.
// We size notional-first from `perSignalPct × leverage × baseCapital` — a mandate the
// user agreed to — so silently shrinking a position would change what they agreed to
// without telling them. A skip with a visible reason does not.
//
// **The binding side is the exit, not the entry.** An entry IOC priced a slippage band
// off the mark is self-limiting: it fills what it crosses and cancels the rest. The
// venue-side stop is not. It is a trigger that becomes a marketable order into whatever
// is left below it, and an unfilled stop on a 10x isolated position is the exact
// failure venue-side stops exist to prevent. So a long is judged on the **bid** side it
// would have to sell into, and a short on the **ask** side it would have to buy back
// through. Both sides are measured; the participation cap applies to the exit side,
// and the entry side only has to be non-empty.
//
// Cassie 0.4.0's market maker reaches the same conclusion independently — depth on
// "the exit-side bids of the outcome being acquired… can I get out" — having started
// from the generic entry-side version. Two derivations agreeing is the closest thing
// to evidence available before the check has ever fired.

/** One price level, as Hyperliquid's `l2Book` returns it. */
export type Level = { px: string | number; sz: string | number };

export type Book = { bids: Level[]; asks: Level[] };

export type CapacityFloors = {
  /** 24h notional below which we do not open at all, whatever the book looks like
   *  right now. A book is a snapshot; volume is the evidence that the snapshot is
   *  repeatable. */
  minVolume24hUsd: number;
  /** The largest share of in-band **exit-side** depth one position may be. The entry
   *  side only has to be non-empty — an IOC that cannot fill takes a partial and
   *  cancels; a stop that cannot fill leaves a leveraged position unprotected. */
  maxParticipationPct: number;
};

export type CapacityInput = {
  /** The **position**, not the order. A long enters by buying and exits by selling. */
  side: Side;
  book: Book;
  /** What the position would be worth. Notional rather than size, so this can be
   *  answered before lot rounding — which is what lets the check live in
   *  `preTradeCheck` with every other veto instead of after `buildIntent`. */
  desiredNotionalUsd: number;
  /** The band the depth is measured within. `RISK_PARAMS.slippageBps`, so the check
   *  and the order it is checking agree about what "acceptable" means. */
  slippageBps: number;
  volume24hUsd: number;
  floors: CapacityFloors;
};

export type CapacityVerdict =
  | { ok: true; entryDepthUsd: number; exitDepthUsd: number; participationPct: number }
  | { ok: false; reason: "thin-book" | "below-volume-floor"; detail: string };

const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));

/** What is resting within `bps` of the touch, on one side — in base units and in
 *  dollars.
 *
 *  Anchored at the **touch**, the best executable price, and never at the mid. A mid
 *  anchor flatters a wide book by counting half the spread as depth, which is exactly
 *  the book where this check needs to be strict.
 *
 *  Notional is summed level by level at each level's own price rather than at the
 *  touch, because that is what the money would actually buy. Levels are assumed sorted
 *  as HL returns them (bids descending, asks ascending), but the band test is a price
 *  comparison, so an unsorted book gives the same answer. */
export function bandDepth(levels: Level[], sideOfBook: "bids" | "asks", bps: number): { sz: number; notionalUsd: number } {
  const empty = { sz: 0, notionalUsd: 0 };
  if (levels.length === 0) return empty;
  const touch = num(levels[0]!.px);
  if (!Number.isFinite(touch) || touch <= 0) return empty;
  const limit = sideOfBook === "asks" ? touch * (1 + bps / 10_000) : touch * (1 - bps / 10_000);
  let sz = 0;
  let notionalUsd = 0;
  for (const l of levels) {
    const px = num(l.px);
    const q = num(l.sz);
    if (!Number.isFinite(px) || !Number.isFinite(q) || q <= 0 || px <= 0) continue;
    if (sideOfBook === "asks" ? px > limit : px < limit) continue;
    sz += q;
    notionalUsd += q * px;
  }
  return { sz, notionalUsd };
}

/** The veto. Pure, and unit-tested before it was wired to anything, because it touches
 *  money by deciding whether money moves. */
export function checkCapacity(i: CapacityInput): CapacityVerdict {
  // Volume first: it is the cheaper refusal and the more fundamental one. A book can
  // look deep for one snapshot on a market nobody trades.
  if (!(i.volume24hUsd >= i.floors.minVolume24hUsd)) {
    return {
      ok: false,
      reason: "below-volume-floor",
      detail: `24h volume $${Math.round(i.volume24hUsd).toLocaleString("en-US")} is under the ` +
        `$${i.floors.minVolume24hUsd.toLocaleString("en-US")} floor`,
    };
  }

  const long = i.side === "long";
  const entryDepthUsd = bandDepth(long ? i.book.asks : i.book.bids, long ? "asks" : "bids", i.slippageBps).notionalUsd;
  const exitDepthUsd = bandDepth(long ? i.book.bids : i.book.asks, long ? "bids" : "asks", i.slippageBps).notionalUsd;
  const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

  // The entry side only has to be able to fill *something*. An entry IOC priced a band
  // off the mark takes what it crosses and cancels the rest, so being large relative to
  // the ask side costs a partial fill and a wasted concurrency slot — annoying, and not
  // the failure this check exists for. Refusing an ordinary trade because the offer
  // side happened to be thin for one snapshot would be the check misfiring.
  if (entryDepthUsd <= 0) {
    return {
      ok: false,
      reason: "thin-book",
      detail: `nothing resting within ${i.slippageBps}bps of the touch to open into`,
    };
  }

  // The exit side is where the cap applies, and this is the whole argument. The
  // venue-side stop is a trigger that becomes a marketable order into whatever is left
  // on the other side, and an unfilled stop on a 10x isolated position is precisely the
  // failure venue-side stops exist to prevent. A depth check at entry is really a check
  // on whether we will be able to leave.
  if (exitDepthUsd <= 0) {
    return {
      ok: false,
      reason: "thin-book",
      detail: `nothing resting within ${i.slippageBps}bps of the touch to close into — ` +
        "the stop would have nothing to fill against",
    };
  }

  const participationPct = i.desiredNotionalUsd / exitDepthUsd;
  if (participationPct > i.floors.maxParticipationPct) {
    return {
      ok: false,
      reason: "thin-book",
      detail: `${usd(i.desiredNotionalUsd)} would be ${(participationPct * 100).toFixed(0)}% of the ` +
        `${usd(exitDepthUsd)} resting on the exit side within ${i.slippageBps}bps (cap ` +
        `${(i.floors.maxParticipationPct * 100).toFixed(0)}%) — we could get in and not out`,
    };
  }

  return { ok: true, entryDepthUsd, exitDepthUsd, participationPct };
}
