import assert from "node:assert/strict";
import { test } from "node:test";
import { bandDepth, checkCapacity, type Book, type CapacityInput } from "./capacity.ts";
import { RISK_PARAMS } from "./params.ts";

/** A book with `n` levels a tick apart on each side, `sz` at every level. */
function book(mid: number, tick: number, sz: number, n = 20): Book {
  return {
    bids: Array.from({ length: n }, (_, i) => ({ px: String(mid - tick * (i + 1)), sz: String(sz) })),
    asks: Array.from({ length: n }, (_, i) => ({ px: String(mid + tick * (i + 1)), sz: String(sz) })),
  };
}

const input = (over: Partial<CapacityInput> = {}): CapacityInput => ({
  side: "long",
  book: book(100, 0.01, 10),
  desiredNotionalUsd: 1_000,
  slippageBps: RISK_PARAMS.slippageBps,
  volume24hUsd: 50_000_000,
  floors: RISK_PARAMS.capacity,
  ...over,
});

// ── the band ───────────────────────────────────────────────────────────────

// Anchored at the touch, never the mid: a mid anchor counts half the spread as depth,
// which flatters exactly the wide book this check needs to be strict about.
test("the band is measured from the touch, not the mid", () => {
  // A wide market: mid 100.00, touch 100.10. At 5bps the band from the touch reaches
  // 100.150, so only the first level is in it.
  const asks = [{ px: "100.10", sz: "1" }, { px: "100.20", sz: "1" }, { px: "100.30", sz: "1" }];
  assert.equal(bandDepth(asks, "asks", 5).sz, 1);
  // From the mid the same 5bps would reach 100.05 and admit nothing at all, which is
  // not what an order crossing this book would find.
});

test("bids are measured downward and asks upward", () => {
  const b = book(100, 0.005, 4);           // 30bps of ~100 is 0.30, so 60 ticks: all 20 levels
  assert.equal(bandDepth(b.bids, "bids", 30).sz, 80);
  assert.equal(bandDepth(b.asks, "asks", 30).sz, 80);
  // A tight band admits only the levels inside it.
  assert.equal(bandDepth(b.asks, "asks", 1).sz, 12, "1bps of 100.005 reaches 100.015");
});

// Notional is what the money buys, so it is summed at each level's own price rather
// than at the touch — the difference is the whole point of a band.
test("notional is summed level by level, not at the touch", () => {
  const asks = [{ px: "100", sz: "1" }, { px: "200", sz: "1" }];
  const d = bandDepth(asks, "asks", 100_000);
  assert.equal(d.sz, 2);
  assert.equal(d.notionalUsd, 300, "not 2 × 100");
});

test("an empty or malformed book is zero depth, not a crash", () => {
  assert.deepEqual(bandDepth([], "bids", 30), { sz: 0, notionalUsd: 0 });
  assert.deepEqual(bandDepth([{ px: "0", sz: "5" }], "bids", 30), { sz: 0, notionalUsd: 0 });
  assert.equal(bandDepth([{ px: "100", sz: "1" }, { px: "nonsense", sz: "1" }], "asks", 30).sz, 1);
});

// ── the veto ───────────────────────────────────────────────────────────────

test("an ordinary order on a deep book passes", () => {
  const v = checkCapacity(input());
  assert.equal(v.ok, true);
  assert.ok(v.ok && v.participationPct < 0.1);
});

// 21 of the 117 xyz: markets have literally $0 of 24h volume, several of them
// commodities Quotient publishes outlooks on. This is the gate for those.
test("a market nobody trades is refused however good its book looks right now", () => {
  const v = checkCapacity(input({ volume24hUsd: 0, book: book(100, 0.01, 10_000) }));
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "below-volume-floor");
});

test("the volume floor is the one from params, not a copy", () => {
  const at = checkCapacity(input({ volume24hUsd: RISK_PARAMS.capacity.minVolume24hUsd }));
  const under = checkCapacity(input({ volume24hUsd: RISK_PARAMS.capacity.minVolume24hUsd - 1 }));
  assert.equal(at.ok, true, "the floor itself is admitted");
  assert.equal(under.ok, false);
});

// The argument the whole check rests on: an entry IOC is self-limiting, a venue-side
// stop is not. So a long is judged on the bids it would have to sell into.
test("a long is capped on the bids it would have to sell into", () => {
  const deepAsksThinBids: Book = {
    bids: [{ px: "99.99", sz: "1" }],
    asks: Array.from({ length: 20 }, (_, i) => ({ px: String(100 + 0.01 * (i + 1)), sz: "10000" })),
  };
  const v = checkCapacity(input({ side: "long", book: deepAsksThinBids, desiredNotionalUsd: 1_000 }));
  assert.equal(v.ok, false);
  assert.equal(v.ok === false && v.reason, "thin-book");
  assert.match(v.ok === false ? v.detail : "", /exit side/);
  assert.match(v.ok === false ? v.detail : "", /get in and not out/);
});

// The entry side is deliberately not capped: an IOC that is large relative to the offer
// takes a partial fill and cancels the rest, which costs a concurrency slot and a round
// trip — annoying, and not the failure this check exists for.
test("a thin entry side is not a refusal, only an empty one is", () => {
  const thinAsksDeepBids: Book = {
    bids: Array.from({ length: 20 }, (_, i) => ({ px: String(100 - 0.01 * (i + 1)), sz: "10000" })),
    asks: [{ px: "100.01", sz: "1" }],
  };
  assert.equal(checkCapacity(input({ side: "long", book: thinAsksDeepBids })).ok, true);
  const noAsks = checkCapacity(input({ side: "long", book: { bids: thinAsksDeepBids.bids, asks: [] } }));
  assert.equal(noAsks.ok, false);
  assert.match(noAsks.ok === false ? noAsks.detail : "", /to open into/);
});

// The mirror image, on the same book, so the side logic cannot be right by accident:
// thin asks are the *exit* for a short and merely the entry for a long.
test("a short is capped on the asks it would have to buy back through", () => {
  const deepBidsThinAsks: Book = {
    bids: Array.from({ length: 20 }, (_, i) => ({ px: String(100 - 0.01 * (i + 1)), sz: "10000" })),
    asks: [{ px: "100.01", sz: "1" }],
  };
  assert.equal(checkCapacity(input({ side: "short", book: deepBidsThinAsks })).ok, false);
  assert.equal(checkCapacity(input({ side: "long", book: deepBidsThinAsks })).ok, true);
});

test("an empty exit side is refused, and says the stop is what would fail", () => {
  const v = checkCapacity(input({ book: { bids: [], asks: book(100, 0.01, 10).asks } }));
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.detail : "", /the stop would have nothing to fill against/);
});

// It is a veto, not a sizer: the verdict never carries a smaller size to send. We size
// notional-first from a mandate the user agreed to, and shrinking it silently would
// change what they agreed to.
test("the refusal offers no reduced size, because it is not a sizer", () => {
  const v = checkCapacity(input({ desiredNotionalUsd: 10_000_000 }));
  assert.equal(v.ok, false);
  assert.ok(!("cappedSz" in v) && !("desiredSz" in v));
});

// Measured on the live universe 2026-09-02: xyz:COPPER's thinner side held $26,386
// within 30bps, so 10% is ~$2,600 of notional. The check has to bind there and not on
// ETH, whose thinner side held $5.17M.
test("the cap binds where the live measurement says it should", () => {
  // A long's exit is the bids: $26,386 within 30bps, so 10% is ~$2,639.
  const copper: Book = { bids: [{ px: "6.54", sz: "4034" }], asks: [{ px: "6.55", sz: "10000" }] };
  assert.equal(checkCapacity(input({ side: "long", book: copper, desiredNotionalUsd: 2_000 })).ok, true);
  assert.equal(checkCapacity(input({ side: "long", book: copper, desiredNotionalUsd: 5_000 })).ok, false);
});
