import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { WebStore } from "../web/sessions.ts";
import { isNewer, readSettingsRequests, serviceChangeRequests, type ChangeableAccount } from "./change-queue.ts";

// Changing the limits and the mandate on a connected account (tasks/18). What these
// check: a request applies exactly once and never re-applies; every refusal leaves the
// account untouched and says why where the desk reads it; the mandate waits for the
// book to be flat and then moves the day's baseline without forgetting the day.

const A = "0x1111111111111111111111111111111111111111";
const T0 = new Date("2026-09-04T10:00:00Z");
const at = (s: number) => new Date(T0.getTime() + s * 1000);

function rig(mode: "live" | "paper" = "live", base = 100) {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-change-"));
  const store = new Store(join(dir, "ledger.sqlite"), { log: () => {} });
  const web = new WebStore(join(dir, "web.sqlite"));
  const accountsDir = join(dir, "accounts");
  mkdirSync(accountsDir);
  store.connectAccount(A, base, DEFAULT_USER_SETTINGS, mode, T0);
  store.upsertConnection({ account: A, status: "active", agentAddress: null, settings: DEFAULT_USER_SETTINGS, at: T0 });
  if (mode === "paper") store.db.prepare("INSERT INTO paper_cash (account, equity) VALUES (?, ?)").run(A, base);
  const managed: ChangeableAccount = { master: A as `0x${string}`, mode, settings: { ...DEFAULT_USER_SETTINGS, mode }, baseCapital: base };
  const logs: string[] = [];
  let usable = { ok: true, usableUsd: base, message: "" };
  let equity: number | null = null;
  const run = (now: Date) => serviceChangeRequests({
    store, requestsDb: join(dir, "web.sqlite"), accounts: [managed], accountsDir,
    readCollateral: async () => usable, equityUsd: () => equity,
    log: (m) => logs.push(m), now: () => now,
  });
  return {
    dir, store, web, accountsDir, managed, logs, run,
    setUsable: (u: typeof usable) => { usable = u; },
    setEquity: (e: number | null) => { equity = e; },
    done: () => { store.close(); web.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function openIntent(store: Store, id = "open1"): void {
  store.db.prepare(`INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision, coin, side,
    leverage, margin_usd, size_abs, ref_px, horizon_at, rationale, status, entry_px, filled_sz)
    VALUES (?, ?, ?, 'quotient', ?, 1, 'BTC', 'long', 10, 10, 0.001, 78000, ?, '', 'open', 78000, 0.001)`)
    .run(id, A, T0.toISOString(), `po:${id}`, at(3600).toISOString());
}

// ── Limits ─────────────────────────────────────────────────────────────────

test("a limits change applies once, replaces the managed settings, and is then spent", async () => {
  const r = rig();
  try {
    const wanted: UserSettings = { ...DEFAULT_USER_SETTINGS, leverage: 20, stopPct: 0.04 };
    r.web.requestSettings(A, wanted, at(10).getTime());
    const first = await r.run(at(20));
    assert.equal(first.settingsApplied, 1);
    assert.equal(r.managed.settings.leverage, 20, "the object the runner reads was replaced");
    const row = r.store.account(A)!;
    assert.equal(JSON.parse(row.settings).stopPct, 0.04);
    assert.equal(row.settings_at, at(20).toISOString());
    assert.equal(JSON.parse(r.store.connection(A)!.settings).leverage, 20, "a later reconnect starts from this");
    const events = r.store.db.prepare("SELECT kind, detail FROM events WHERE account = ?").all(A) as { kind: string; detail: string }[];
    assert.ok(events.some((e) => e.kind === "settings" && /keep the terms they opened with/.test(e.detail)));

    // The executor cannot delete the request. The timestamp is what spends it.
    const second = await r.run(at(80));
    assert.equal(second.settingsApplied, 0);
    assert.equal(r.store.account(A)!.settings_at, at(20).toISOString(), "not re-stamped");
  } finally { r.done(); }
});

test("a change never moves an account between paper and live, whatever the request says", async () => {
  const r = rig("live");
  try {
    // `validate` accepts mode; the web refuses it, but a row can carry it. It is
    // ignored: the mode in force stays.
    r.web.db.prepare("INSERT INTO settings_requests (address, requested_at, settings) VALUES (?,?,?)")
      .run(A, at(10).getTime(), JSON.stringify({ ...DEFAULT_USER_SETTINGS, leverage: 5, mode: "paper" }));
    assert.equal(readSettingsRequests(join(r.dir, "web.sqlite")).length, 1);
    await r.run(at(20));
    assert.equal(r.managed.settings.leverage, 5);
    assert.equal(r.managed.settings.mode, "live");
    assert.equal(JSON.parse(r.store.account(A)!.settings).mode, "live");
  } finally { r.done(); }
});

test("an operator's pin refuses the change and says so where the desk reads it", async () => {
  const r = rig();
  try {
    writeFileSync(join(r.accountsDir, `${A}.json`), JSON.stringify(DEFAULT_USER_SETTINGS));
    r.web.requestSettings(A, { ...DEFAULT_USER_SETTINGS, leverage: 20 }, at(10).getTime());
    const rep = await r.run(at(20));
    assert.equal(rep.settingsApplied, 0);
    assert.equal(rep.refused, 1);
    assert.equal(r.managed.settings.leverage, 10, "untouched");
    assert.match(r.store.connection(A)!.last_error!, /pinned by an operator/);
    // Re-decided every loop, written and logged once.
    await r.run(at(80));
    assert.equal(r.logs.filter((l) => /refused/.test(l)).length, 1);
  } finally { r.done(); }
});

// Below the floor every signal is skipped and the account trades nothing while looking
// connected — the failure the floor exists to name, producible from the desk by
// dragging two sliders down on a small mandate.
test("limits that put the mandate under the floor are refused, and the old ones stay", async () => {
  const r = rig("live", 20);
  try {
    // 5% at 5x needs $40.41 — $40 of notional floor plus the 1% reserve, rounded up to
    // the cent. The mandate is $20.
    r.web.requestSettings(A, { ...DEFAULT_USER_SETTINGS, perSignalPct: 0.05, leverage: 5 }, at(10).getTime());
    const rep = await r.run(at(20));
    assert.equal(rep.settingsApplied, 0);
    assert.match(r.store.connection(A)!.last_error!, /at least \$40\.41/);
    assert.equal(r.managed.settings.perSignalPct, 0.10);
    // A later request that fits clears the refusal.
    r.web.requestSettings(A, { ...DEFAULT_USER_SETTINGS, leverage: 20 }, at(30).getTime());
    await r.run(at(40));
    assert.equal(r.managed.settings.leverage, 20);
    assert.equal(r.store.connection(A)!.last_error, null);
  } finally { r.done(); }
});

test("a request older than the stamp is spent — the rule that makes the queue idempotent", () => {
  assert.equal(isNewer(at(10).getTime(), at(20).toISOString(), T0.toISOString()), false);
  assert.equal(isNewer(at(30).getTime(), at(20).toISOString(), T0.toISOString()), true);
  assert.equal(isNewer(at(1).getTime(), null, T0.toISOString()), true, "a row that predates the column falls back to the connect");
  assert.equal(isNewer(T0.getTime() - 1, null, T0.toISOString()), false);
});

// ── The mandate ────────────────────────────────────────────────────────────

test("a mandate re-read waits while anything is open, then applies once and re-bases the day", async () => {
  const r = rig("paper", 100);
  try {
    openIntent(r.store);
    r.web.requestMandate(A, at(10).getTime());
    for (const s of [20, 80]) {
      const rep = await r.run(at(s));
      assert.equal(rep.mandatesApplied, 0, "pending while the position is open");
      assert.equal(r.store.account(A)!.base_capital, 100);
    }
    // The position closes at a $6 gain, today; then the owner's deposit shows up in the
    // simulated cash, which for a paper account *is* what it holds.
    r.store.db.prepare("UPDATE intents SET status = 'closed', closed_at = ?, close_reason = 'target', realized_pnl = 6 WHERE intent_id = 'open1'")
      .run(at(100).toISOString());
    r.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(306, A);

    const rep = await r.run(at(120));
    assert.equal(rep.mandatesApplied, 1);
    const row = r.store.account(A)!;
    assert.equal(row.base_capital, 306, "re-read, never typed");
    assert.equal(row.mandate_at, at(120).toISOString());
    assert.equal(row.day_start_equity, 300, "equity less today's realised $6: the gain stays counted, the deposit does not");
    assert.equal(row.day, "2026-09-04");
    assert.equal(r.managed.baseCapital, 306, "the object the runner reads was replaced");
    assert.equal(r.store.paperEquity(A), 306);
    const events = r.store.db.prepare("SELECT detail FROM events WHERE account = ? AND kind = 'mandate'").all(A) as { detail: string }[];
    assert.equal(events.length, 1);
    assert.match(events[0]!.detail, /\$100\.00 → \$306\.00/);

    assert.equal((await r.run(at(200))).mandatesApplied, 0, "spent");
  } finally { r.done(); }
});

// The 2026-08-31 incident in the other direction: a loss earlier in the day must still
// count after a rebase, or depositing a dollar would forgive the morning.
test("a rebase after a losing morning keeps the loss in the day's baseline", async () => {
  const r = rig("live", 100);
  try {
    r.store.db.prepare(`INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision, coin, side,
      leverage, margin_usd, size_abs, ref_px, horizon_at, rationale, status, closed_at, close_reason, realized_pnl, net_pnl)
      VALUES ('lost', ?, ?, 'quotient', 'po:lost', 1, 'BTC', 'long', 10, 10, 0.001, 78000, ?, '', 'closed', ?, 'stop', -2.8, -3.05)`)
      .run(A, T0.toISOString(), at(3600).toISOString(), at(50).toISOString());
    r.setUsable({ ok: true, usableUsd: 397, message: "" });   // $100 − $3.05, plus a $300 deposit
    r.web.requestMandate(A, at(60).getTime());
    await r.run(at(70));
    const row = r.store.account(A)!;
    assert.equal(row.base_capital, 397);
    assert.ok(Math.abs(row.day_start_equity! - 400.05) < 1e-9, "settled net where the fills are in, not the estimate");
  } finally { r.done(); }
});

test("a rebase under the floor is refused and the mandate stays", async () => {
  const r = rig("live", 100);
  try {
    r.setUsable({ ok: false, usableUsd: 4, message: "This account holds $4.00 of usable collateral; the minimum is $10.00." });
    r.web.requestMandate(A, at(10).getTime());
    const rep = await r.run(at(20));
    assert.equal(rep.mandatesApplied, 0);
    assert.equal(rep.refused, 1);
    assert.equal(r.store.account(A)!.base_capital, 100);
    assert.equal(r.managed.baseCapital, 100);
    assert.match(r.store.connection(A)!.last_error!, /was not updated.*\$4\.00/);
  } finally { r.done(); }
});

test("an account this process is not managing is left for the loop that is", async () => {
  const r = rig();
  try {
    const other = "0x2222222222222222222222222222222222222222";
    r.store.connectAccount(other, 50, DEFAULT_USER_SETTINGS, "live", T0);
    r.web.requestSettings(other, { ...DEFAULT_USER_SETTINGS, leverage: 20 }, at(10).getTime());
    r.web.requestMandate(other, at(10).getTime());
    const rep = await r.run(at(20));
    assert.equal(rep.settingsApplied + rep.mandatesApplied + rep.refused, 0);
    assert.equal(JSON.parse(r.store.account(other)!.settings).leverage, 10);
  } finally { r.done(); }
});

// ── Clearing a halt at the owner's request (`tasks/30` §1) ──────────────────

/** Halt the account the way `tick()` does, with a `halt` event so `haltedAt` answers. */
function haltIt(r: ReturnType<typeof rig>, kind: "daily-loss" | "foreign-position", when: Date, dayStart = 100): void {
  r.store.setHalt(A, true, `halted for a test (${kind})`, kind);
  r.store.recordEvent(A, "halt", `halted for a test (${kind})`, when);
  r.store.db.prepare("UPDATE accounts SET day = ?, day_start_equity = ? WHERE account = ?")
    .run(when.toISOString().slice(0, 10), dayStart, A);
}

const NEXT_DAY = new Date("2026-09-05T09:00:00Z");
const rolled = (r: ReturnType<typeof rig>) =>
  r.store.db.prepare("UPDATE accounts SET day = '2026-09-05' WHERE account = ?").run(A);

test("a clear applies once, and never touches the day's baseline", async () => {
  const r = rig();
  try {
    haltIt(r, "daily-loss", T0);
    rolled(r);
    r.setEquity(95);
    const before = r.store.account(A)!;
    r.web.requestUnhalt(A, NEXT_DAY.getTime());

    const first = await r.run(NEXT_DAY);
    assert.equal(first.haltsCleared, 1);
    const after = r.store.account(A)!;
    assert.equal(after.halted, 0);
    assert.equal(after.halt_kind, null);
    assert.equal(after.day, before.day, "the day is untouched");
    assert.equal(after.day_start_equity, before.day_start_equity, "and so is the baseline");

    // Spent: the same row must not clear a halt that fires later the same day.
    haltIt(r, "daily-loss", NEXT_DAY);
    rolled(r);
    assert.equal((await r.run(new Date(NEXT_DAY.getTime() + 60_000))).haltsCleared, 0);
    assert.equal(r.store.account(A)!.halted, 1);
  } finally { r.done(); }
});

// ⚠ **The refusal is what spends the row.** A press at 23:00Z that the executor refuses
// must not sit in the queue and apply itself when the UTC day rolls: releasing on the
// day roll is `tasks/30` §4, a risk decision nobody has taken, and arriving at it by
// leaving a request live would be taking it by accident.
test("a refused clear is recorded, spends the request, and does not apply itself later", async () => {
  const r = rig();
  try {
    haltIt(r, "daily-loss", T0);
    r.setEquity(85);
    r.web.requestUnhalt(A, at(10).getTime());

    const first = await r.run(at(20));
    assert.equal(first.haltsCleared, 0);
    assert.equal(first.refused, 1);
    assert.equal(r.store.account(A)!.halted, 1);
    const refusal = r.store.db.prepare("SELECT detail FROM events WHERE account = ? AND kind = 'unhalt-refused'")
      .all(A) as unknown as { detail: string }[];
    assert.equal(refusal.length, 1);
    assert.match(refusal[0]!.detail, /fired today/);
    // And the desk is told, in the executor's own words.
    assert.match(r.store.connection(A)?.last_error ?? "", /fired today/);

    // The day rolls and the account recovers. The old press must not now succeed.
    rolled(r);
    r.setEquity(95);
    assert.equal((await r.run(NEXT_DAY)).haltsCleared, 0, "the owner presses again, or nothing happens");
    assert.equal(r.store.account(A)!.halted, 1);

    // Pressing again does clear it.
    r.web.requestUnhalt(A, NEXT_DAY.getTime());
    assert.equal((await r.run(new Date(NEXT_DAY.getTime() + 1000))).haltsCleared, 1);
  } finally { r.done(); }
});

// The owner cannot clear a foreign-actor halt from the desk, and the executor is where
// that is enforced rather than in the markup: a POST does not read a disabled attribute.
test("a foreign-actor halt is refused whatever the request says", async () => {
  const r = rig();
  try {
    haltIt(r, "foreign-position", T0);
    rolled(r);
    r.setEquity(100);
    r.web.requestUnhalt(A, NEXT_DAY.getTime());
    const rep = await r.run(NEXT_DAY);
    assert.equal(rep.haltsCleared, 0);
    assert.equal(r.store.account(A)!.halted, 1);
    assert.match(r.store.connection(A)?.last_error ?? "", /someone else traded on this account/i);
  } finally { r.done(); }
});

test("a clear asked for on an account that is not halted does nothing at all", async () => {
  const r = rig();
  try {
    r.web.requestUnhalt(A, at(10).getTime());
    const rep = await r.run(at(20));
    assert.equal(rep.haltsCleared, 0);
    assert.equal(rep.refused, 0, "nothing to refuse either — there is no halt");
    assert.equal(r.store.lastHaltDecisionAt(A), null);
  } finally { r.done(); }
});
