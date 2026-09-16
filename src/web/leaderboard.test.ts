import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { SYNTHETIC_INTENTS } from "../store/synthetic.ts";
import type { ExecHeartbeat } from "./heartbeat.ts";
import { buildLeaderboard, leaderboardSettings } from "./leaderboard.ts";

const A = "0xacc00005c25f2582a26ecc6ea9926902f442f18c";
const B = "0xacc00007a56ff82f586f84ab2e6cafd2ccea08e3";

function trade(store: Store, account: string, o: { id: string; net: number | null }): void {
  store.db.prepare(
    `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
      coin, side, leverage, margin_usd, size_abs, ref_px, horizon_at, rationale,
      status, entry_px, filled_sz, closed_at, close_reason, realized_pnl, net_pnl)
     VALUES (?, ?, '2026-09-01T09:02:55.000Z', 'quotient', ?, 1, 'BTC', 'long', 10, 10, 0.01,
      64000, '2026-09-02T00:00:00Z', 'Quotient put BTC above spot', 'closed', 64000, 0.01,
      '2026-09-01T14:36:03.000Z', 'target', 0.5, ?)`,
  ).run(o.id, account.toLowerCase(), `po:${o.id}`, o.net);
}

/** The executor's roster. Being in it is what "we are trading this account" means, so
 *  every fixture has to say who is on it. */
function beat(accounts: Record<string, unknown>[]): ExecHeartbeat {
  return { ageSeconds: 12, writtenAtMs: Date.parse("2026-09-05T15:49:09Z"), accounts: accounts as never };
}

test("ranks on return against the mandate, not on the dollars", () => {
  const store = new Store(":memory:", { log: () => {} });
  // B makes less money on a much smaller mandate, and so is the better account.
  store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live");
  store.connectAccount(B, 10, DEFAULT_USER_SETTINGS, "live");
  trade(store, A, { id: "a1", net: 5 });
  trade(store, B, { id: "b1", net: 2 });

  const lb = buildLeaderboard(store, beat([{ account: A }, { account: B }]));
  assert.deepEqual(lb.rows.map((r) => [r.rank, r.account]), [[1, B.toLowerCase()], [2, A.toLowerCase()]]);
  assert.equal(lb.rows[0]!.returnFrac, 0.2);
  assert.equal(lb.rows[1]!.returnFrac, 0.05);
  store.close();
});

// `src/store/synthetic.ts`: they were placed on a real account with real money against
// a fabricated horizon, so they are our test and not the feed's result. A public
// leaderboard is exactly the measurement that must not count them.
test("operator-test intents are left out, and the count is published", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live");
  trade(store, A, { id: "real", net: 1 });
  trade(store, A, { id: SYNTHETIC_INTENTS[0]!.intentId, net: -50 });

  const lb = buildLeaderboard(store, beat([{ account: A }]));
  assert.equal(lb.rows[0]!.trades, 1);
  assert.equal(lb.rows[0]!.netPnlUsd, 1);
  assert.equal(lb.excludedIntents, SYNTHETIC_INTENTS.length);
  store.close();
});

// A paper P&L is a correctness signal, not a return — `src/exec/paper.ts` models no
// fees, no funding and no partial fills. Ranking one beside real money in public would
// be a false claim about both.
test("a paper account is not on a table of returns", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 1000, DEFAULT_USER_SETTINGS, "paper");
  trade(store, A, { id: "p1", net: 900 });

  const lb = buildLeaderboard(store, beat([{ account: A }]));
  assert.deepEqual(lb.rows, []);
  assert.equal(lb.awaitingFirstTrade, 0, "a paper account is excluded, not counted as untraded");
  store.close();
});

// The live ledger holds an `xyz:COPPER` short closed on `disconnect` with no venue
// fills attributed to it. It is neither a win nor a loss, and dividing by it would
// quietly report it as a loss.
test("a trade the fills could not settle is not counted as a loss", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live");
  trade(store, A, { id: "won", net: 3 });
  trade(store, A, { id: "unsettled", net: null });

  const r = buildLeaderboard(store, beat([{ account: A }])).rows[0]!;
  assert.equal(r.trades, 1, "the scoreable one");
  assert.equal(r.wins, 1);
  assert.equal(r.winRate, 1, "wins / trades, exactly — the three columns must agree");
  assert.equal(r.unsettled, 1, "counted, so the footnote can say what was left out");
  assert.equal(r.netPnlUsd, 3, "its P&L still sums, because there is none to add");
  store.close();
});

// A halt is a pause, not a release: the account keeps its slot and we are still
// trading it. It stays on the table and says so, rather than vanishing from a list its
// owner is reading.
test("a halted account we still manage stays on the table, marked", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 73.38, DEFAULT_USER_SETTINGS, "live");
  store.setHalt(A, true, "1 fill(s) on this account were not placed by us");
  trade(store, A, { id: "a1", net: 0.17 });

  const r = buildLeaderboard(store, beat([{ account: A }])).rows[0]!;
  assert.equal(r.halted, true, "read from the ledger, where a halt persists");
  assert.equal(r.netPnlUsd, 0.17);
  store.close();
});

// The roster rule. The account that halted on a foreign fill was later emptied to $0,
// so it fails the collateral check and the executor stopped managing it — it is no
// longer an account we trade, and this table is the accounts we trade.
test("an account the executor no longer manages is off the table", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 73.38, DEFAULT_USER_SETTINGS, "live");
  store.setHalt(A, true, "1 fill(s) on this account were not placed by us");
  trade(store, A, { id: "a1", net: 0.17 });

  const lb = buildLeaderboard(store, beat([]));
  assert.deepEqual(lb.rows, [], "live in the ledger, but not on the roster");
  assert.equal(lb.awaitingFirstTrade, 0, "not listed and not counted as untraded either");
  store.close();
});

// With no heartbeat at all we cannot know who holds a slot. An empty table plus "the
// desk is not reporting" is the honest answer; silently ranking everyone who was ever
// live would be a claim we cannot support.
test("no heartbeat means no roster, and the page is told why", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live");
  trade(store, A, { id: "a1", net: 1 });

  const lb = buildLeaderboard(store, null);
  assert.deepEqual(lb.rows, []);
  assert.equal(lb.heartbeatAgeSeconds, null);
  store.close();
});

test("a connected account that has not traded is counted, not ranked", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live");
  store.connectAccount(B, 50, DEFAULT_USER_SETTINGS, "live");
  trade(store, A, { id: "a1", net: 1 });

  const lb = buildLeaderboard(store, beat([{ account: A }, { account: B }]));
  assert.equal(lb.rows.length, 1);
  assert.equal(lb.awaitingFirstTrade, 1);
  store.close();
});

// Nothing on this table may be a position, a trade row or our own supplier balance —
// see the header of `src/web/leaderboard.ts` for why each is out. This asserts the
// shape rather than the reasoning, so adding a field has to come here first.
//
// **`settings` was on that list until 2026-09-10 and is now deliberately in it**, which
// this test caught rather than allowed — the guard working. What is still out is the
// thing that made the old rule matter: **no position and no entry price**, so a reader
// can see the shape of somebody's risk and not where a live stop is resting.
test("the payload carries results and settings, and nothing else about an account", () => {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live");
  trade(store, A, { id: "a1", net: 1 });

  const r = buildLeaderboard(store, beat([{ account: A }])).rows[0]!;
  assert.deepEqual(Object.keys(r).sort(), [
    "account", "firstTradeAt", "halted", "lastCloseAt", "mandateUsd", "netPnlUsd",
    "rank", "returnFrac", "settings", "trades", "unsettled", "winRate", "wins",
  ]);
  // The four an owner chooses, and nothing that would locate a stop.
  assert.deepEqual(Object.keys(r.settings ?? {}).sort(),
    ["holdToTarget", "leverage", "perSignalPct", "stopPct"]);
  store.close();
});

// ── The settings badges (the owner's ask, 2026-09-10) ───────────────────────
//
// This row is written by the executor, but it is a `TEXT` column: a bad one must not put
// "NaN×" on a page other people read.

test("the four are read in the units the connect screen shows them", () => {
  assert.deepEqual(
    leaderboardSettings('{"leverage":20,"stopLoss":true,"stopPct":0.015,"perSignalPct":0.1,"holdToTarget":false}'),
    { leverage: 20, perSignalPct: 0.1, stopPct: 0.015, holdToTarget: false },
  );
});

test("a stop that is off is null, which is not a stop of zero", () => {
  const s = leaderboardSettings('{"leverage":10,"stopLoss":false,"stopPct":0.03,"perSignalPct":0.1}');
  assert.equal(s?.stopPct, null);
  // And a stop that is genuinely there survives, so the two cannot be confused.
  assert.equal(leaderboardSettings('{"leverage":10,"stopLoss":true,"stopPct":0.03,"perSignalPct":0.1}')?.stopPct, 0.03);
});

test("a row written before holdToTarget existed reads as what it did then", () => {
  // Absent means the signal-change exit, which is what every trade in the ledger before
  // 2026-09-09 was actually run under.
  assert.equal(leaderboardSettings('{"leverage":10,"stopLoss":true,"stopPct":0.03,"perSignalPct":0.2}')?.holdToTarget, false);
});

test("settings that cannot be read are null, never a guess", () => {
  // "null" and "[]" both parse without throwing and then read as objects whose every
  // field is undefined — the first threw on the way through, which on this route would
  // have been a 500 for every reader over one bad row.
  for (const bad of ["", "not json", "{}", "null", "[]", "[1,2]", "42", '"a"',
    '{"leverage":"20","perSignalPct":0.1}', '{"leverage":null,"perSignalPct":0.1}',
    '{"leverage":20,"perSignalPct":"x"}', '{"perSignalPct":0.1}', '{"leverage":20}']) {
    assert.equal(leaderboardSettings(bad), null, bad);
  }
  assert.equal(leaderboardSettings(null), null);
});
