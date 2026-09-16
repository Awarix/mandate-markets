import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import type { Skip } from "../types.ts";
import { buildDesk, buildSignalHistory, buildTradeHistory, labelSkip, parseCursor } from "./desk.ts";

const ACCOUNT = "0xacc00005c25f2582a26ecc6ea9926902f442f18c";

function withHeartbeat(
  accounts: Record<string, unknown>[],
  writtenAt: Date,
  fn: (dataRoot: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-desk-"));
  writeFileSync(join(dir, "exec-heartbeat.json"), JSON.stringify({ t: writtenAt.toISOString(), accounts }));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

function ledger(mode: "live" | "paper"): Store {
  const store = new Store(":memory:", { log: () => {} });
  store.connectAccount(ACCOUNT, 73.38, DEFAULT_USER_SETTINGS, mode);
  return store;
}

// The whole point of `tasks/13` stage A: the account that prompted it read
// "Connected, trading real money" for the entire life of a one-day approval.
test("a lapsing approval reaches the desk, with the date and the reassurance", async () => {
  const now = new Date("2026-09-02T10:00:00Z");
  const store = ledger("live");
  await withHeartbeat(
    [{ account: ACCOUNT, mode: "live", agentDaysLeft: 0.158 }],
    now,
    async (dataRoot) => {
      const d = await buildDesk(store, ACCOUNT, null, now, dataRoot);
      assert.equal(d.agent?.state, "warning");
      assert.equal(d.agent?.expiresAt, "2026-09-02T13:47:31.200Z");
      assert.match(d.agent!.message, /expires in 0\.2 days/);
      assert.match(d.agent!.message, /approving it again/);
    },
  );
  store.close();
});

test("a lapsed approval says what is still protecting the position, first", async () => {
  const now = new Date("2026-09-02T10:00:00Z");
  const store = ledger("live");
  await withHeartbeat(
    [{ account: ACCOUNT, mode: "live", agentDaysLeft: -2 }],
    now,
    async (dataRoot) => {
      const d = await buildDesk(store, ACCOUNT, null, now, dataRoot);
      assert.equal(d.agent?.state, "lapsed");
      assert.ok(d.agent!.message.startsWith("Your stops and targets are still on Hyperliquid"));
    },
  );
  store.close();
});

// `agentDaysLeft` was measured when the heartbeat was written. Read as though it were
// current, a stale file reports an approval as healthier than it is — in exactly the
// situation where nobody is renewing anything either.
test("the countdown is anchored to when the heartbeat was written, not to now", async () => {
  const written = new Date("2026-09-02T10:00:00Z");
  const now = new Date("2026-09-02T22:00:00Z");           // twelve hours later
  const store = ledger("live");
  await withHeartbeat(
    [{ account: ACCOUNT, mode: "live", agentDaysLeft: 0.4 }],  // ~9.6h left, when written
    written,
    async (dataRoot) => {
      const d = await buildDesk(store, ACCOUNT, null, now, dataRoot);
      assert.equal(d.agent?.state, "lapsed", "it ran out while the heartbeat sat there");
      assert.ok((d.agent?.daysLeft ?? 0) < 0);
    },
  );
  store.close();
});

// "We cannot see your approval" is not information the owner of a paper desk can use,
// and a paper account has no agent at all.
test("a paper account is told nothing about agents", async () => {
  const now = new Date("2026-09-02T10:00:00Z");
  const store = ledger("paper");
  await withHeartbeat(
    [{ account: ACCOUNT, mode: "paper", agentDaysLeft: null }],
    now,
    async (dataRoot) => {
      assert.equal((await buildDesk(store, ACCOUNT, null, now, dataRoot)).agent, null);
    },
  );
  store.close();
});

test("no heartbeat at all is silence, not a scary claim", async () => {
  const now = new Date("2026-09-02T10:00:00Z");
  const store = ledger("live");
  const d = await buildDesk(store, ACCOUNT, null, now, join(tmpdir(), "signaldesk-no-such-root"));
  assert.equal(d.agent, null);
  store.close();
});

// ── How far the day can go (tasks/19) ──────────────────────────────────────

// The three lines come from the ledger row and RISK_PARAMS, not the venue, so they
// render when Hyperliquid is unreachable — with the halt level null until the first
// tick has seeded the day's baseline, never zero.
test("the halt and the stop-out cost are on the payload, from the ledger alone", async () => {
  const now = new Date("2026-09-04T10:00:00Z");
  const store = ledger("live");
  const before = await buildDesk(store, ACCOUNT, null, now, join(tmpdir(), "signaldesk-no-such-root"));
  assert.equal(before.dailyLossPct, RISK_PARAMS.dailyLossPct);
  assert.equal(before.dayStartEquityUsd, null);
  assert.equal(before.haltAtUsd, null, "no baseline yet is no level, not $0");
  assert.ok(before.stopOut);
  // Derived from the defaults rather than typed, so moving the stop moves the expected
  // figure with it instead of failing here as if the payload were wrong.
  const d = DEFAULT_USER_SETTINGS;
  const ofMandate = d.stopPct * d.leverage * d.perSignalPct * (1 - RISK_PARAMS.reserveFrac);
  assert.ok(Math.abs(before.stopOut!.usd - 73.38 * ofMandate) < 1e-9,
    "one stop-out of the $73.38 mandate, less the reserve the mandate is sized off (`tasks/21` §6)");
  assert.ok(Math.abs(before.stopOut!.ofMargin - d.stopPct * d.leverage) < 1e-9);
  assert.ok(Math.abs(before.stopOut!.stopsToHalt - RISK_PARAMS.dailyLossPct / ofMandate) < 1e-9,
    `about 5.1 stops at the 2% default, 10.1 at the 1% one and 3.4 at the 3%: ${before.stopOut!.stopsToHalt}`);

  store.rollDay(ACCOUNT, 80, now);
  const after = await buildDesk(store, ACCOUNT, null, now, join(tmpdir(), "signaldesk-no-such-root"));
  assert.equal(after.dayStartEquityUsd, 80);
  assert.ok(Math.abs(after.haltAtUsd! - 8) < 1e-9, "10% of the day's opening equity, not of the mandate");
  store.close();
});

// It fell through `labelSkip`'s auto-tidy as "Agent expires before horizon", which is
// our jargon rather than something the account's owner can act on.
test("the expiry skip has words of its own", () => {
  assert.equal(labelSkip("agent-expires-before-horizon"), "Your approval of us ends before the forecast does");
});

// ── What we saw, and what we did about it (tasks/10) ───────────────────────

const skipOf = (over: Partial<Skip> = {}): Skip => ({
  at: "2026-09-02T10:00:00.000Z", signalRef: "po:crypto:btc:daily:abc", revision: 12,
  coin: "BTC", reason: "displacement-below-gate", detail: "0.42σ against the live mark", ...over,
});

// The write was once per signal per 60s loop with nothing deduping it. On the live
// ledger that was 13,584 rows over 74 signals, and the desk reported the row count.
test("re-seeing the same refusal is one row and a rising count, not a new row", () => {
  const store = ledger("live");
  for (let i = 0; i < 5; i++) {
    store.recordSkip(ACCOUNT, skipOf({ at: `2026-09-02T10:0${i}:00.000Z`, revision: 12 + i }));
  }
  const rows = store.signalHistory(ACCOUNT, "2000-01-01");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.seen_count, 5);
  assert.equal(rows[0]!.first_at, "2026-09-02T10:00:00.000Z");
  assert.equal(rows[0]!.last_at, "2026-09-02T10:04:00.000Z");
  assert.equal(rows[0]!.first_revision, 12);
  assert.equal(rows[0]!.last_revision, 16, "the revision range is kept even though it is not the key");
  store.close();
});

// The case the revision range exists for: the same signal refused for a *different*
// reason later is a different decision and gets its own row.
test("a reason that changes across revisions is a second decision", () => {
  const store = ledger("live");
  store.recordSkip(ACCOUNT, skipOf({ reason: "displacement-below-gate" }));
  store.recordSkip(ACCOUNT, skipOf({ reason: "horizon-passed", at: "2026-09-02T11:00:00.000Z" }));
  const rows = store.signalHistory(ACCOUNT, "2000-01-01");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.reason), ["horizon-passed", "displacement-below-gate"], "newest first");
  store.close();
});

// The detail quotes a live sigma or a free-collateral figure, so it is only worth
// anything as of the last time we looked.
test("the detail kept is the latest one", () => {
  const store = ledger("live");
  store.recordSkip(ACCOUNT, skipOf({ detail: "first" }));
  store.recordSkip(ACCOUNT, skipOf({ detail: "latest", at: "2026-09-02T12:00:00.000Z" }));
  assert.equal(store.signalHistory(ACCOUNT, "2000-01-01")[0]!.detail, "latest");
  store.close();
});

// The interesting comparison is between them: a screen that only shows refusals
// cannot answer "and what did you take instead".
test("taken and skipped come back in one list, newest first", () => {
  const store = ledger("live");
  store.db.prepare(
    `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
      coin, side, leverage, margin_usd, size_abs, ref_px, horizon_at, rationale, status, closed_at,
      close_reason, realized_pnl, net_pnl)
     VALUES ('i1', ?, '2026-09-01T00:00:00Z', 'quotient', 'po:taken', 3, 'xyz:SILVER', 'long',
      10, 10, 1, 1, '2026-09-02T00:00:00Z', 'because Quotient said so', 'closed',
      '2026-09-02T11:00:00.000Z', 'target', -2.06, 0.5049)`,
  ).run(ACCOUNT.toLowerCase());
  store.recordSkip(ACCOUNT, skipOf());

  const h = buildSignalHistory(store, ACCOUNT, "2000-01-01");
  assert.deepEqual(h.rows.map((r) => r.outcome), ["taken", "skipped"]);
  assert.equal(h.rows[0]!.netPnlUsd, 0.5049);
  assert.equal(h.rows[0]!.closeReason, "target");
  assert.equal(h.rows[1]!.label, "Move too small to cover fees", "slugs arrive as sentences");
  assert.equal(h.mode, "live");
  store.close();
});

// `docs/USER-JOURNEY.md` §13: the user never has to trust our reporting, because
// Hyperliquid is the source of truth. The estimate disagrees with it — measured, by
// $3.35 over 18 trips — so it is never sent to a screen.
test("the estimate is never in the payload, only the settled figure", () => {
  const store = ledger("live");
  store.db.prepare(
    `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
      coin, side, leverage, margin_usd, size_abs, ref_px, horizon_at, rationale, status, closed_at, realized_pnl)
     VALUES ('i2', ?, '2026-09-01T00:00:00Z', 'quotient', 'po:x', 1, 'BTC', 'long', 10, 10, 1, 1,
      '2026-09-02T00:00:00Z', '', 'closed', '2026-09-02T00:00:00Z', -2.06)`,
  ).run(ACCOUNT.toLowerCase());
  const row = buildSignalHistory(store, ACCOUNT, "2000-01-01").rows[0]!;
  assert.equal(row.netPnlUsd, null, "unsettled reads as unknown, never as the estimate");
  assert.ok(!JSON.stringify(row).includes("-2.06"));
  store.close();
});

// There was no retention anywhere in src/ before 2026-09-02. Keyed on `last_at`, so a
// decision still being re-made every loop is never pruned from under a live signal.
test("pruning drops stale decisions and keeps live ones", () => {
  const store = ledger("live");
  store.recordSkip(ACCOUNT, skipOf({ signalRef: "old", at: "2026-01-01T00:00:00.000Z" }));
  store.recordSkip(ACCOUNT, skipOf({ signalRef: "current", at: "2026-09-02T10:00:00.000Z" }));
  assert.equal(store.pruneSkips("2026-06-01T00:00:00.000Z"), 1);
  assert.deepEqual(store.signalHistory(ACCOUNT, "2000-01-01").map((r) => r.signal_ref), ["current"]);
  store.close();
});

// ── Trade history (tasks/09) ───────────────────────────────────────────────

function closedTrade(store: Store, over: Partial<{ id: string; coin: string; closedAt: string; net: number | null; reason: string }> = {}): void {
  const o = { id: "t1", coin: "xyz:SILVER", closedAt: "2026-09-01T14:36:03.000Z", net: 0.6856, reason: "target", ...over };
  store.db.prepare(
    `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
      coin, side, leverage, margin_usd, size_abs, ref_px, target_px, stop_px, horizon_at, rationale,
      status, entry_px, filled_sz, closed_at, close_reason, realized_pnl, fee_usd, funding_usd, net_pnl)
     VALUES (?, ?, '2026-09-01T09:02:55.000Z', 'quotient', ?, 1, ?, 'long', 10, 10, 1.54, 64.59,
      66.1, 62.6, '2026-09-02T00:00:00Z', 'Quotient put silver 6.2σ above spot', 'closed',
      64.592, 1.54, ?, ?, 0.43, 0.017249, -0.003112, ?)`,
  ).run(o.id, ACCOUNT.toLowerCase(), `po:${o.id}`, o.coin, o.closedAt, o.reason, o.net);
}

// Every field of the sentence `docs/USER-JOURNEY.md` asks for already exists in the
// ledger — which is the whole reason the intent store was built before anything else.
test("a closed trade comes back with its reason and its settled cost", () => {
  const store = ledger("live");
  closedTrade(store);
  const h = buildTradeHistory(store, ACCOUNT, null);
  const r = h.rows[0]!;
  assert.equal(r.closeReason, "target");
  assert.equal(r.netPnlUsd, 0.6856);
  assert.equal(r.feeUsd, 0.017249);
  assert.equal(r.fundingUsd, -0.003112);
  assert.equal(r.rationale, "Quotient put silver 6.2σ above spot");
  assert.equal(r.paper, false);
  assert.equal(h.nextBefore, null, "one page, no cursor");
  store.close();
});

// `src/exec/paper.ts` models no fees, no funding, no queue position and no partial
// fills — and an account can come up paper for reasons its owner did not choose.
test("every row of a paper history says so, not just the payload", () => {
  const store = ledger("paper");
  closedTrade(store);
  closedTrade(store, { id: "t2", closedAt: "2026-09-01T15:00:00.000Z" });
  const h = buildTradeHistory(store, ACCOUNT, null);
  assert.equal(h.mode, "paper");
  assert.ok(h.rows.every((r) => r.paper), "on the row, where the renderer cannot forget it");
  store.close();
});

// The live ledger closes three accounts' trades on one signal within four seconds, and
// two intents at the same second. A `closed_at < cursor` page would silently drop a
// row whenever a tie straddled a boundary.
test("paging survives two trades closing in the same millisecond", () => {
  const store = ledger("live");
  const same = "2026-09-01T15:39:13.000Z";
  for (const id of ["a1", "a2", "a3", "a4"]) closedTrade(store, { id, closedAt: same });

  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const h: ReturnType<typeof buildTradeHistory> = buildTradeHistory(store, ACCOUNT, cursor, 2);
    seen.push(...h.rows.map((r) => r.intentId));
    cursor = h.nextBefore;
    if (!cursor) break;
  }
  assert.deepEqual(seen.sort(), ["a1", "a2", "a3", "a4"], "every trade appears exactly once");
  store.close();
});

test("paging walks the whole history newest first and then stops", () => {
  const store = ledger("live");
  for (let i = 0; i < 5; i++) {
    closedTrade(store, { id: `p${i}`, closedAt: `2026-09-0${i + 1}T10:00:00.000Z` });
  }
  const first = buildTradeHistory(store, ACCOUNT, null, 2);
  assert.deepEqual(first.rows.map((r) => r.intentId), ["p4", "p3"]);
  assert.ok(first.nextBefore);
  const second = buildTradeHistory(store, ACCOUNT, first.nextBefore, 2);
  assert.deepEqual(second.rows.map((r) => r.intentId), ["p2", "p1"]);
  const third = buildTradeHistory(store, ACCOUNT, second.nextBefore, 2);
  assert.deepEqual(third.rows.map((r) => r.intentId), ["p0"]);
  assert.equal(third.nextBefore, null);
  store.close();
});

// A bad cursor is a client bug, and the useful response to it on a screen someone is
// trying to read is the first page rather than an error.
test("a malformed cursor starts from the top instead of failing", () => {
  const store = ledger("live");
  closedTrade(store);
  assert.equal(parseCursor("nonsense"), null);
  assert.equal(buildTradeHistory(store, ACCOUNT, "nonsense").rows.length, 1);
  store.close();
});

// Empty is a state, not an error state — and it is the state every account is in
// until Phase 3 produces something.
test("no closed trades is an empty list, not a failure", () => {
  const store = ledger("live");
  const h = buildTradeHistory(store, ACCOUNT, null);
  assert.deepEqual(h.rows, []);
  assert.equal(h.nextBefore, null);
  store.close();
});

// The estimate is $3.35 away from the truth over 18 live trips, and it disagrees with
// what Hyperliquid shows the account's owner.
test("an unsettled trade reports unknown, never the estimate", () => {
  const store = ledger("live");
  closedTrade(store, { net: null });
  const r = buildTradeHistory(store, ACCOUNT, null).rows[0]!;
  assert.equal(r.netPnlUsd, null);
  assert.ok(!JSON.stringify(r).includes("0.43"), "realized_pnl never leaves the server");
  store.close();
});

// ── The seven-day realised figure (found live, 2026-09-04) ─────────────────
//
// The desk told the owner of a live account +$3.75 over seven days while the account
// had grown from its $115.50 mandate to $123.68. Both numbers were on the same screen.
// The sum was over `realized_pnl`, the estimate, whose four values were 0.54, 0.38,
// 1.34 and 1.49 against settled nets of 2.1718, 1.6709, 1.2581 and 3.0841.
test("the week's realised P&L is the settled figure, not the estimate", async () => {
  const store = ledger("live");
  const now = new Date("2026-09-04T09:38:00.000Z");
  closedTrade(store, { id: "w1", closedAt: "2026-09-03T20:00:27.436Z", net: 2.1718 });
  closedTrade(store, { id: "w2", closedAt: "2026-09-04T08:09:11.124Z", net: 3.0841 });
  const d = await buildDesk(store, ACCOUNT, null, now);
  assert.equal(Number(d.realisedWeekUsd.toFixed(4)), 5.2559, "0.43 + 0.43 would be the estimate");
  store.close();
});

// The venue's rows arrive after the event, so a trade closed a minute ago has no
// `net_pnl` yet. Dropping it would make the week's total fall as trades close, which
// is worse than carrying the estimate for the few minutes it stands alone — and it is
// the rule `Store.realisedToday` already follows for the rebase baseline.
test("a trade the venue has not settled yet still counts, at its estimate", async () => {
  const store = ledger("live");
  const now = new Date("2026-09-04T09:38:00.000Z");
  closedTrade(store, { id: "w3", closedAt: "2026-09-04T09:37:00.000Z", net: null });
  const d = await buildDesk(store, ACCOUNT, null, now);
  assert.equal(d.realisedWeekUsd, 0.43, "the estimate, which is what closedTrade writes");
  store.close();
});
