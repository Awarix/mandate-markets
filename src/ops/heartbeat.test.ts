import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateAccounts, type AccountHeartbeat } from "./heartbeat.ts";

const beat = (over: Partial<AccountHeartbeat> = {}): AccountHeartbeat => ({
  account: "0xaaa", mode: "live", halted: false, haltReason: null,
  equityUsd: 100, freeUsd: 80, baseCapital: 100, deployedUsd: 20, dayStartEquity: 101,
  openIntents: 2, positions: 2, restingOrders: 4, foreignOrders: 0, foreignPositions: 0,
  agentDaysLeft: 180, fee: { state: "off" }, error: null, consecutiveErrors: 0, ...over,
});

// The watchdog is deployed separately and may lag a release, so these field names are
// a contract. Renaming one silently disables an alert on a funded account.
test("the aggregate keeps every field the watchdog reads", () => {
  const agg = aggregateAccounts([beat()]);
  for (const k of [
    "mode", "halted", "haltReason", "equityUsd", "baseCapital", "dayStartEquity",
    "openIntents", "positions", "restingOrders", "foreignOrders", "foreignPositions",
  ]) {
    assert.ok(k in agg, `watchdog reads ${k}`);
  }
});

test("one account aggregates to itself, so single-account output is unchanged", () => {
  const agg = aggregateAccounts([beat()]);
  assert.equal(agg.mode, "live");
  assert.equal(agg.equityUsd, 100);
  assert.equal(agg.positions, 2);
  assert.equal(agg.halted, false);
});

test("money and exposure sum across accounts", () => {
  const agg = aggregateAccounts([beat(), beat({ account: "0xbbb", equityUsd: 50, positions: 1, restingOrders: 2 })]);
  assert.equal(agg.equityUsd, 150);
  assert.equal(agg.positions, 3);
  assert.equal(agg.restingOrders, 6);
  assert.equal(agg.accountCount, 2);
});

// A halt on any account has to reach a person, and the message has to name which.
test("any halted account halts the aggregate, and the reason names the account", () => {
  const agg = aggregateAccounts([
    beat(),
    beat({ account: "0xbbb", halted: true, haltReason: "a second actor is trading this account" }),
  ]);
  assert.equal(agg.halted, true);
  assert.match(String(agg.haltReason), /0xbbb/);
  assert.match(String(agg.haltReason), /second actor/);
});

test("mixed modes are labelled rather than silently reported as one", () => {
  const agg = aggregateAccounts([beat(), beat({ account: "0xbbb", mode: "paper" })]);
  assert.match(String(agg.mode), /mixed/);
});

// An account erroring is not the same as an account halting, and must not be hidden
// by the others' healthy numbers.
test("erroring accounts are counted and still carried in the detail", () => {
  const agg = aggregateAccounts([beat(), beat({ account: "0xbbb", error: "venue read timed out", consecutiveErrors: 4 })]);
  assert.equal(agg.accountsErroring, 1);
  assert.equal(agg.halted, false);
  assert.equal((agg.accounts as AccountHeartbeat[]).length, 2);
});

test("no accounts is reported honestly rather than as a healthy zero", () => {
  const agg = aggregateAccounts([]);
  assert.equal(agg.mode, "none");
  assert.equal(agg.accountCount, 0);
});

// ── `tasks/50` §2.1: a desk-wide halt has to reach the watchdog ─────────────────
//
// The speed limit arms the global halt, which `tick()` deliberately does not persist on
// any account row — so every heartbeat said `halted: false` while no account could open a
// position, and `exec-halted` never fired. A refusal that survives a restart and tells
// nobody is a desk that quietly stops trading.
test("a desk-wide halt makes the aggregate halted, and names itself", () => {
  const agg = aggregateAccounts([beat(), beat({ account: "0xbbb" })], {
    halted: true, reason: "speed limit: a money constant moved inside an unfinished block",
  });
  assert.equal(agg.halted, true, "no account row says so, and every account is halted all the same");
  assert.match(String(agg.haltReason), /every account: speed limit/);
});

test("a halted account and a halted desk are both reported, desk first", () => {
  const agg = aggregateAccounts(
    [beat(), beat({ account: "0xbbb", halted: true, haltReason: "foreign position" })],
    { halted: true, reason: "speed limit: …" },
  );
  assert.match(String(agg.haltReason), /^every account: speed limit/);
  assert.match(String(agg.haltReason), /0xbbb: foreign position/);
});

test("with no desk halt the aggregate is unchanged, so the operator's own file stays quiet", () => {
  const agg = aggregateAccounts([beat()]);
  assert.equal(agg.halted, false);
  assert.equal(agg.haltReason, null);
});
