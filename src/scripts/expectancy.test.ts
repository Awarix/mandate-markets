import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import {
  blocks, changesIn, collapse, reference, scoreable,
  type Change, type TripRow,
} from "./expectancy.ts";

// `tasks/32`. The collapse is what makes `npm run expectancy` a reading rather than a
// sum, and it rests on an assumption — that the accounts differed only in size — with
// two ways to stop being true. Both failed **silently**: the collapse kept returning a
// number and the number stopped meaning what the label said. So the refusal is tested,
// not merely coded.

const trip = (o: Partial<Omit<TripRow, "openedAt" | "closedAt">> & { signalRef: string; openedAt: string }): TripRow => ({
  account: "0xa", netPnl: 1, marginUsd: 10, coin: "BTC", mode: "signal", assetClass: "crypto",
  anchorType: "daily", leverage: 10, armedStopPct: 0.02, priceRet: null,
  closedAt: new Date(Date.parse(o.openedAt) + 3_600_000), holdToTarget: false,
  ...o, openedAt: new Date(o.openedAt),
});

test("three accounts on one signal at three sizes are still one event", () => {
  const es = collapse([
    trip({ signalRef: "s1", account: "0xa", openedAt: "2026-09-08T10:00:00Z", netPnl: 1, marginUsd: 10 }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T10:00:06Z", netPnl: 3, marginUsd: 30 }),
    trip({ signalRef: "s1", account: "0xc", openedAt: "2026-09-08T10:00:12Z", netPnl: 5, marginUsd: 50 }),
  ]);
  assert.equal(es.length, 1);
  assert.equal(es[0]!.trips, 3);
  assert.equal(es[0]!.accounts, 3);
  // 10% on margin three times, not $9 — the whole reason the collapse exists.
  assert.ok(Math.abs(es[0]!.ret - 0.1) < 1e-12, String(es[0]!.ret));
  // Nobody re-entered, so summing each account's legs first changes nothing. That it
  // does nothing HERE is what makes it meaningful in the test below, where it does.
  assert.ok(Math.abs(es[0]!.retAccounts - 0.1) < 1e-12, String(es[0]!.retAccounts));
  assert.equal(es[0]!.maxLegs, 1);
});

// The acceptance test. Two accounts, one signal, different exit policies: one leaves
// when the call goes neutral, the other on a level or the horizon. Averaging them as
// "one draw repeated" averages two different trades.
test("two accounts on one signal under different exit policies are two arms, never one average", () => {
  const es = collapse([
    trip({ signalRef: "s1", openedAt: "2026-09-08T10:00:00Z", netPnl: 1, marginUsd: 10, holdToTarget: false }),
    trip({ signalRef: "s1", openedAt: "2026-09-08T10:00:06Z", netPnl: -3, marginUsd: 10, holdToTarget: true }),
  ]);
  assert.equal(es.length, 2, "collapsed two exit policies into one event");
  const retire = es.find((e) => !e.holdToTarget)!;
  const hold = es.find((e) => e.holdToTarget)!;
  assert.ok(Math.abs(retire.ret - 0.1) < 1e-12, String(retire.ret));
  assert.ok(Math.abs(hold.ret - -0.3) < 1e-12, String(hold.ret));
  // And the averaged answer — −10%, describing neither trade — is not among them.
  assert.ok(!es.some((e) => Math.abs(e.ret - -0.1) < 1e-12), "the average of the two arms was reported");
});

// Accounts are ticked in one loop seconds apart, so a signal that straddles a boundary
// is one event that opened before it — not two, and not one placed in the wrong arm.
test("a signal straddling a regime boundary takes the earliest trip's regime", () => {
  const es = collapse([
    trip({ signalRef: "s1", openedAt: "2026-09-07T09:46:02Z" }),
    trip({ signalRef: "s1", openedAt: "2026-09-07T09:46:07Z" }),
  ]);
  assert.equal(es.length, 1);
  assert.equal(es[0]!.regime, "09-04 famine");
});

test("blocks are one regime and one exit policy, newest first", () => {
  const es = collapse([
    trip({ signalRef: "a", openedAt: "2026-09-01T10:00:00Z" }),
    trip({ signalRef: "b", openedAt: "2026-09-05T10:00:00Z" }),
    trip({ signalRef: "c", openedAt: "2026-09-08T10:00:00Z" }),
    trip({ signalRef: "d", openedAt: "2026-09-09T10:00:00Z", holdToTarget: true }),
  ]);
  const bs = blocks(es);
  assert.deepEqual(bs.map((b) => [b.regime, b.holdToTarget, b.events.length]), [
    ["reverted", true, 1],
    ["reverted", false, 1],
    ["09-04 famine", false, 1],
    ["pre-09-04", false, 1],
  ]);
});

// The pooled figure is what the fifth reading quoted and what `tasks/31` §1 says nobody
// should act on. It must never be able to masquerade as a block.
test("a pooled sample of 42 is never one block", () => {
  const es = collapse([
    ...Array.from({ length: 21 }, (_, i) => trip({ signalRef: `p${i}`, openedAt: "2026-09-01T10:00:00Z" })),
    ...Array.from({ length: 21 }, (_, i) => trip({ signalRef: `r${i}`, openedAt: "2026-09-08T10:00:00Z" })),
  ]);
  assert.equal(es.length, 42);
  const bs = blocks(es);
  assert.equal(bs.length, 2);
  assert.equal(bs[0]!.events.length, 21, "the newest block is 21, not 42");
});

// ── the three statistics, and why one signal needs all three (`tasks/46` §1.1) ──────
//
// Every reading since 2026-09-02 quoted one number called "per signal, % of margin".
// It is the mean of every account-trip, so it moves when a 20x account is funded and it
// counts a re-entering account four times. These are the three numbers that come out of
// the same trips, each pinned against its own arithmetic and never against the others —
// which is the whole point, because the failure was that they were assumed equal.
//
//   A: 10x, one leg,  +1.0% in price → +10% of margin
//   B: 20x, two legs, −0.5% then +2.0% → −10% then +40% of margin
test("one signal, two accounts, one re-entry: three statistics that must not agree", () => {
  const es = collapse([
    trip({ signalRef: "s1", account: "0xa", openedAt: "2026-09-08T10:00:00Z",
           leverage: 10, marginUsd: 100, netPnl: 10, priceRet: 0.01 }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T10:00:06Z",
           leverage: 20, marginUsd: 100, netPnl: -10, priceRet: -0.005 }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T11:00:00Z",
           leverage: 20, marginUsd: 100, netPnl: 40, priceRet: 0.02 }),
  ]);
  assert.equal(es.length, 1);
  const e = es[0]!;
  assert.equal(e.trips, 3);
  assert.equal(e.accounts, 2);
  assert.equal(e.maxLegs, 2);
  assert.equal(e.leverages, 2);

  const near = (got: number | null, want: number, what: string) =>
    assert.ok(got !== null && Math.abs(got - want) < 1e-12, `${what}: ${got} !== ${want}`);

  // (0.10 + −0.10 + 0.40) / 3 — B's re-entry is two of the three draws.
  near(e.ret, 0.4 / 3, "mean of trips");
  // (0.10 + (−0.10 + 0.40)) / 2 — B is one follower who summed to +30%.
  near(e.retAccounts, 0.2, "mean over accounts of summed legs");
  // (0.01 + (−0.005 + 0.02)) / 2 — the same sum with the leverage divided out.
  near(e.priceRet, 0.0125, "price return over accounts");
  // (0.01 + −0.005 + 0.02) / 3 — and the trip-mean of THAT is a fourth number again.
  near(e.priceRetTrips, 0.025 / 3, "price return over trips");

  // None of the three is a fixed multiple of another, which is why quoting one of them
  // as "per signal" without saying which is the defect `tasks/46` §1.1 names.
  assert.notEqual(e.ret, e.retAccounts);
  assert.notEqual(e.retAccounts, e.priceRet);
  assert.ok(Math.abs(e.priceRet! * 10 - e.retAccounts) > 1e-6, "price x 10x happened to equal the desk");
});

// The gap between the reference account and the desk, split. Here every trip's net P&L
// is exactly its price move times its leverage — no fees, no slippage — so the "exits
// and costs" half must come out at zero and the whole gap must be population.
test("the reference account splits the gap into population and exits", () => {
  const es = collapse([
    trip({ signalRef: "s1", account: "0xa", openedAt: "2026-09-08T10:00:00Z",
           leverage: 10, marginUsd: 100, netPnl: 10, priceRet: 0.01 }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T10:00:06Z",
           leverage: 20, marginUsd: 100, netPnl: -10, priceRet: -0.005 }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T11:00:00Z",
           leverage: 20, marginUsd: 100, netPnl: 40, priceRet: 0.02 }),
  ]);
  const r = reference(es)!;
  assert.equal(r.n, 1);
  assert.ok(Math.abs(r.priceRet - 0.0125) < 1e-12);
  // The reference runs the shipped default, not a literal: moving the default moves
  // this line, which is the behaviour `tasks/46` §3.3 asks for everywhere.
  assert.ok(Math.abs(r.onMargin - 0.0125 * DEFAULT_USER_SETTINGS.leverage) < 1e-12, String(r.onMargin));
  assert.ok(Math.abs(r.desk - 0.2) < 1e-12, String(r.desk));
  assert.ok(Math.abs(r.population - (0.2 - 0.0125 * DEFAULT_USER_SETTINGS.leverage)) < 1e-12, String(r.population));
  assert.ok(Math.abs(r.exits) < 1e-12, `costs were zero by construction, got ${r.exits}`);
  // The two halves are a decomposition, not two estimates: they sum to the gap exactly.
  assert.ok(Math.abs((r.population + r.exits) - (r.desk - r.onMargin)) < 1e-12);
  // And the mandate roll-up is the same number times the position size and the reserve.
  const want = 0.0125 * DEFAULT_USER_SETTINGS.leverage * DEFAULT_USER_SETTINGS.perSignalPct
    * (1 - RISK_PARAMS.reserveFrac);
  assert.ok(Math.abs(r.ofMandate - want) < 1e-12, String(r.ofMandate));
});

// A partial account is the flattering failure: dropping one leg of a re-entering
// account deletes a draw, and the deleted one is disproportionately the loser (a stop
// fires, the re-entry has no fills yet). So the account leaves the price statistics
// whole, and stays in the margin ones, which rest on `net_pnl` rather than on fills.
test("an account missing one leg's exit price leaves the price statistics entirely", () => {
  const es = collapse([
    trip({ signalRef: "s1", account: "0xa", openedAt: "2026-09-08T10:00:00Z",
           leverage: 10, marginUsd: 100, netPnl: 10, priceRet: 0.01 }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T10:00:06Z",
           leverage: 10, marginUsd: 100, netPnl: -50, priceRet: null }),
    trip({ signalRef: "s1", account: "0xb", openedAt: "2026-09-08T11:00:00Z",
           leverage: 10, marginUsd: 100, netPnl: 10, priceRet: 0.01 }),
  ]);
  const e = es[0]!;
  assert.equal(e.accounts, 2);
  assert.equal(e.priceAccounts, 1, "the half-priced account was counted anyway");
  // A's +1% alone, not A's +1% averaged with B's surviving leg.
  assert.ok(Math.abs(e.priceRet! - 0.01) < 1e-12, String(e.priceRet));
  // B's −40% is still in the margin figure, where it is complete.
  assert.ok(Math.abs(e.retAccounts - (0.10 + -0.40) / 2) < 1e-12, String(e.retAccounts));
});

// ── the block refusal (`tasks/47` Rule 1) ──────────────────────────────────────────
//
// Between 09-10 08:18Z and 09-11 10:45Z the desk moved sigma twice, the stop default
// once and the re-entry rule once, and then read a per-signal figure off the result.
// One change in a block is what a block is for; two is two desks pooled.

const change = (at: string, kind: string): Change =>
  ({ at: new Date(at), kind, account: "0xa", detail: `${kind} moved` });

test("a block holding two config events is not scoreable; one is", () => {
  // Both trips after the 09-10 20:39Z boundary, so they are one block and the refusal
  // is the thing under test rather than the regime split, which already works.
  const es = collapse([
    trip({ signalRef: "a", openedAt: "2026-09-10T21:00:00Z" }),
    trip({ signalRef: "b", openedAt: "2026-09-11T08:00:00Z" }),
  ]);
  const b = blocks(es)[0]!;
  assert.equal(b.events.length, 2);

  const one = changesIn(b, [change("2026-09-10T22:00:00Z", "config")]);
  assert.equal(one.length, 1);
  assert.equal(scoreable(one), true);

  const two = changesIn(b, [
    change("2026-09-10T22:00:00Z", "config"),
    change("2026-09-11T02:00:00Z", "config"),
  ]);
  assert.equal(two.length, 2);
  assert.equal(scoreable(two), false);
});

// Settings events reach one account each and are what the cohort columns read. Ten of
// them in a night is the other half of what happened on 09-10, so they are counted and
// printed — but they do not by themselves make a block unattributable.
test("settings events are counted inside the block but do not refuse it", () => {
  const es = collapse([trip({ signalRef: "a", openedAt: "2026-09-10T08:00:00Z" })]);
  const b = blocks(es)[0]!;
  const ten = Array.from({ length: 10 }, () => change("2026-09-10T08:30:00Z", "settings"));
  assert.equal(changesIn(b, ten).length, 10);
  assert.equal(scoreable(ten), true);
});

// A change after the block's last close belongs to the next block. Getting this wrong
// would make every block unscoreable the moment a constant moved, which is the failure
// mode that gets a refusal deleted rather than honoured.
test("a change after the block's last trade closed is outside it", () => {
  const es = collapse([trip({ signalRef: "a", openedAt: "2026-09-10T08:00:00Z" })]);
  const b = blocks(es)[0]!;
  assert.equal(changesIn(b, [change("2026-09-10T08:30:00Z", "config")]).length, 1);
  assert.equal(changesIn(b, [change("2026-09-10T09:30:00Z", "config")]).length, 0);
  assert.equal(changesIn(b, [change("2026-09-10T07:30:00Z", "config")]).length, 0);
});
