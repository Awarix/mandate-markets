import assert from "node:assert/strict";
import { test } from "node:test";
import { DESK_WATCH } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { cohortTripwire, haltBurst, haltsInWindow } from "./desk-watch.ts";
import { deskBook, type AccountHeartbeat } from "./heartbeat.ts";

// `tasks/47` Rule 5's watcher list. All three of these **report**; the owner's decisions
// of 2026-09-12 and 09-13 were no concentration cap and no self-revert, so what is pinned
// here is that each says the right thing and changes nothing.

const A = (account: string, book?: { coin: string; side: "long" | "short" }[]): AccountHeartbeat => ({
  account, mode: "live", halted: false, haltReason: null,
  equityUsd: 100, freeUsd: 50, baseCapital: 100, deployedUsd: 50, dayStartEquity: 100,
  openIntents: book?.length ?? 0, positions: book?.length ?? 0, restingOrders: 0,
  foreignOrders: 0, foreignPositions: 0, agentDaysLeft: 30, fee: { state: "off" },
  error: null, consecutiveErrors: 0, book,
});

// ── the book, and the one number that describes 2026-09-10 ─────────────────────

test("four accounts holding the identical book is six pairs, and no count of positions says it", () => {
  // 17:25Z on 2026-09-10: SILVER long, AAPL short, NATGAS short, COPPER long, on all four.
  const same = [
    { coin: "xyz:SILVER", side: "long" as const }, { coin: "xyz:AAPL", side: "short" as const },
    { coin: "xyz:NATGAS", side: "short" as const }, { coin: "xyz:COPPER", side: "long" as const },
  ];
  const b = deskBook(["a", "b", "c", "d"].map((x) => A(x, same)));
  assert.equal(b.positions, 16);
  assert.equal(b.distinct, 4, "sixteen positions, four distinct — the count alone reads as diversified");
  assert.equal(b.identicalPairs, 6, "4 choose 2: the number that actually describes it");
  assert.match(b.line, /6 pair\(s\)/);
});

test("the same position count spread across different books is zero pairs", () => {
  const b = deskBook([
    A("a", [{ coin: "xyz:CL", side: "long" }, { coin: "BTC", side: "long" }]),
    A("b", [{ coin: "xyz:NG", side: "short" }, { coin: "ETH", side: "short" }]),
  ]);
  assert.equal(b.positions, 4);
  assert.equal(b.identicalPairs, 0);
});

test("flat accounts are not running the same book, they are running none", () => {
  const b = deskBook([A("a", []), A("b", []), A("c", [{ coin: "BTC", side: "long" }])]);
  assert.equal(b.identicalPairs, 0, "two empty books are not a pair");
  assert.equal(b.positions, 1);
});

test("an account whose beat predates the field is unknown, never flat", () => {
  // The watchdog deploys separately from the executor. "We did not look" and "nothing is
  // open" are different claims, and reading the first as the second is what made
  // `stop-sweep` treat an unsummarised trade as an unstopped one.
  const b = deskBook([A("a"), A("b", [{ coin: "BTC", side: "long" }])]);
  assert.equal(b.accounts, 2);
  assert.equal(b.known, 1, "only the account that reported a book is in the denominator");
  assert.equal(b.positions, 1);
});

test("the most-held position and its share are reported, and bound nothing", () => {
  const b = deskBook([
    A("a", [{ coin: "xyz:CL", side: "long" }]),
    A("b", [{ coin: "xyz:CL", side: "long" }]),
    A("c", [{ coin: "xyz:CL", side: "long" }, { coin: "BTC", side: "short" }]),
  ]);
  assert.deepEqual(b.top, { key: "xyz:CL long", accounts: 3 });
  assert.equal(b.topShare, 3 / 4);
  assert.ok(b.topShare >= DESK_WATCH.concentrationWarn);
});

// ── the burst ──────────────────────────────────────────────────────────────────

test("the burst alarm fires at the 2026-09-10 shape and not on one bad account", () => {
  const at = (halts: number) => haltBurst({ halts, windowMin: DESK_WATCH.haltWindowMin, accounts: 15 });
  assert.equal(at(1).firing, false, "one halt already has its own alert, and has since Phase 1");
  assert.equal(at(DESK_WATCH.haltCount - 1).firing, false);
  assert.equal(at(DESK_WATCH.haltCount).firing, true, "three in half an hour is the mechanism");
  assert.match(at(DESK_WATCH.haltCount).message, /2026-09-10/);
  assert.match(at(DESK_WATCH.haltCount).message, /Nothing is capped/);
});

test("halts are counted by distinct account and fail to zero on a ledger it cannot read", () => {
  const store = new Store(":memory:", { log: () => {} });
  const now = Date.parse("2026-09-10T17:30:00Z");
  assert.equal(haltsInWindow(store, 30, now), 0, "an empty ledger has halted nothing");

  store.recordEvent("0xaaa", "halt", "daily loss", new Date(now - 60_000));
  store.recordEvent("0xaaa", "halt", "daily loss again", new Date(now - 30_000));
  store.recordEvent("0xbbb", "halt", "daily loss", new Date(now - 120_000));
  store.recordEvent("0xccc", "halt", "old", new Date(now - 90 * 60_000));
  assert.equal(haltsInWindow(store, 30, now), 2,
    "two distinct accounts inside the window — one account halting twice is a different story");
  assert.equal(haltsInWindow(store, 120, now), 3, "a wider window reaches the third");
  store.close();
});

// ── the cohort tripwire: item 29b, alert only ──────────────────────────────────

test("a small block REFUSES to score, because that is not the same as finding no difference", () => {
  const v = cohortTripwire({
    changed: { n: 4, priceRet: -0.05 }, control: { n: 3, priceRet: 0.05 },
    thresholdPP: 1, what: "stopPct 2%", since: "2026-09-12",
  });
  assert.notEqual(v.refusal, null);
  assert.equal(v.firing, false, "a refusal never fires");
  assert.equal(v.gapPP, null, "and it publishes no number to be quoted");
  assert.match(v.message, /NOT SCORED/);
});

test("past the floor it scores, and fires only when the changed cohort is BEHIND", () => {
  const n = DESK_WATCH.cohortFloor;
  const behind = cohortTripwire({
    changed: { n, priceRet: -0.02 }, control: { n, priceRet: 0.01 },
    thresholdPP: 1, what: "stopPct 1%", since: "2026-09-10",
  });
  assert.equal(behind.refusal, null);
  assert.ok(Math.abs(behind.gapPP! - -3) < 1e-9);
  assert.equal(behind.firing, true);

  const ahead = cohortTripwire({
    changed: { n, priceRet: 0.04 }, control: { n, priceRet: 0.01 },
    thresholdPP: 1, what: "stopPct 1%", since: "2026-09-10",
  });
  assert.equal(ahead.firing, false, "a default doing BETTER is not a tripwire");
});

test("nothing it says sounds like it acted — item 29b is alert only", () => {
  const n = DESK_WATCH.cohortFloor;
  const v = cohortTripwire({
    changed: { n, priceRet: -0.02 }, control: { n, priceRet: 0.01 },
    thresholdPP: 1, what: "stopPct 1%", since: "2026-09-10",
  });
  assert.match(v.message, /NOTHING HAS CHANGED/);
  assert.match(v.message, /nothing here writes a constant/);
  assert.match(v.message, /NEW CONNECTS only/,
    "the one property that makes a default revert cheap: no open position moves with it");
  assert.doesNotMatch(v.message, /reverted|rolled back/i, "it proposes; it does not report having acted");
});
