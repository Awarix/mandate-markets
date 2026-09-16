import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "./db.ts";
import { DEFAULT_USER_SETTINGS } from "../risk/params.ts";

const MASTER = "0xacc00001C53162712f3d8D10764B5E7b17D1C08A";

function freshStore(): Store {
  return new Store(join(mkdtempSync(join(tmpdir(), "signaldesk-store-")), "db.sqlite"));
}

test("baseCapital is frozen at connect — reconnecting does not rebase it", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 1000, DEFAULT_USER_SETTINGS, "paper");
  const again = s.connectAccount(MASTER, 250, DEFAULT_USER_SETTINGS, "paper");
  assert.equal(again.base_capital, 1000, "a second connect must not move the frozen base");
  s.close();
});

// The hole this closes was live on the VPS on 2026-08-30: a paper run had left
// `accounts` at mode=paper, base_capital=1000, and `connectAccount` returned that row
// unchanged. Going live against the same ledger would have frozen live sizing at the
// paper $1,000 on a $101 account, recorded in a row that still said "paper" — 10x the
// $100 ceiling that then existed, and 10x the account itself now that sizing follows
// the deposit.
test("connecting live against a paper ledger is refused, not silently reused", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 1000, DEFAULT_USER_SETTINGS, "paper");
  assert.throws(
    () => s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live"),
    (e: Error) => {
      assert.match(e.message, /paper/);
      assert.match(e.message, /frozen at connect/);
      assert.match(e.message, /1000/, "the refusal must show the figure it would have used");
      return true;
    },
  );
  s.close();
});

test("the refusal is symmetric — paper against a live ledger is refused too", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.throws(() => s.connectAccount(MASTER, 1000, DEFAULT_USER_SETTINGS, "paper"), /live/);
  s.close();
});

// Live-only bug, found on the first real start (2026-08-30): seeding day_start_equity
// from baseCapital made the daily-loss cap compare a constant against live equity. A
// unifiedAccount holding its money in spot reads perp equity $0, so the very first
// tick computed (100-0)/100 = 100% loss and halted before placing anything.
test("day_start_equity is seeded from the venue on the first tick, not from baseCapital", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(s.account(MASTER)!.day_start_equity, null, "must not pre-seed from baseCapital");

  const first = s.rollDay(MASTER, 101.16);
  assert.equal(first.dayStartEquity, 101.16, "the first roll takes real equity");

  // and it stays put for the rest of the UTC day, whatever equity does
  assert.equal(s.rollDay(MASTER, 88).dayStartEquity, 101.16);
  s.close();
});

test("a new UTC day rebases the loss baseline to that day's equity", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live", new Date("2026-08-30T12:00:00Z"));
  s.rollDay(MASTER, 100, new Date("2026-08-30T12:00:00Z"));
  const next = s.rollDay(MASTER, 94, new Date("2026-08-31T00:00:01Z"));
  assert.equal(next.day, "2026-08-31");
  assert.equal(next.dayStartEquity, 94, "yesterday's loss must not carry into today's cap");
  s.close();
});

test("same mode reconnects cleanly, which is the ordinary restart path", () => {
  const s = freshStore();
  const first = s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  const second = s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(second.connected_at, first.connected_at, "a restart must not re-freeze the base");
  assert.equal(second.mode, "live");
  s.close();
});

test("an account is found whichever way its address is cased", () => {
  const s = new Store(":memory:");
  const checksummed = "0xacc00001C53162712f3d8D10764B5E7b17D1C08A";
  s.connectAccount(checksummed, 100, { leverage: 10 }, "live");

  // The executor lowercases addresses in `listAccounts`, so this is exactly the
  // lookup that used to miss and insert a duplicate.
  assert.equal(s.account(checksummed.toLowerCase())?.base_capital, 100);
  assert.equal(s.account(checksummed.toUpperCase().replace("0X", "0x"))?.base_capital, 100);
  s.close();
});

test("reconnecting with a different casing returns the row, it does not add one", () => {
  const s = new Store(":memory:");
  const checksummed = "0xacc00001C53162712f3d8D10764B5E7b17D1C08A";
  s.connectAccount(checksummed, 100, { leverage: 10 }, "live");
  // A second freeze at a different base capital is the failure this prevents.
  const again = s.connectAccount(checksummed.toLowerCase(), 999, { leverage: 10 }, "live");

  assert.equal(again.base_capital, 100, "baseCapital is frozen at the first connect");
  const n = s.db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number };
  assert.equal(n.n, 1, "one account, one row");
  s.close();
});

// The paper book was global before 2026-08-31. These build a ledger in the old shape
// and reopen it, because the migration runs against a real file on the VPS and a
// migration that has never been executed is a plan, not a migration.

const OLD_PAPER_SCHEMA = `
CREATE TABLE paper_positions (
  coin TEXT PRIMARY KEY, szi REAL NOT NULL, entry_px REAL NOT NULL,
  margin_used REAL NOT NULL, leverage INTEGER NOT NULL, opened_at TEXT NOT NULL);
CREATE TABLE paper_orders (
  cloid TEXT PRIMARY KEY, coin TEXT NOT NULL, is_buy INTEGER NOT NULL, sz REAL NOT NULL,
  px REAL NOT NULL, trigger_px REAL, fire_below INTEGER NOT NULL DEFAULT 0,
  reduce_only INTEGER NOT NULL, oid INTEGER NOT NULL, placed_at TEXT NOT NULL);
CREATE TABLE paper_leverage (coin TEXT PRIMARY KEY, leverage INTEGER NOT NULL);
CREATE TABLE paper_cash (id INTEGER PRIMARY KEY CHECK (id = 1), equity REAL NOT NULL);
`;

function oldShapeLedger(dir: string, accounts: string[], withRows: boolean): string {
  const path = join(dir, "old.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE accounts (
    account TEXT PRIMARY KEY, connected_at TEXT NOT NULL, base_capital REAL NOT NULL,
    settings TEXT NOT NULL, mode TEXT NOT NULL, halted INTEGER NOT NULL DEFAULT 0,
    halt_reason TEXT, day TEXT, day_start_equity REAL);`);
  accounts.forEach((a, i) =>
    db.prepare("INSERT INTO accounts (account, connected_at, base_capital, settings, mode) VALUES (?,?,?,?,?)")
      .run(a, `2026-08-3${i}T00:00:00.000Z`, 1000, "{}", "paper"));
  db.exec(OLD_PAPER_SCHEMA);
  if (withRows) {
    db.prepare("INSERT INTO paper_cash (id, equity) VALUES (1, ?)").run(1234.5);
    db.prepare("INSERT INTO paper_positions VALUES (?,?,?,?,?,?)")
      .run("BTC", -0.01, 78000, 78, 10, "2026-08-30T00:00:00.000Z");
    db.prepare("INSERT INTO paper_leverage VALUES (?,?)").run("BTC", 10);
  }
  db.close();
  return path;
}

test("opening an old global paper book migrates it to the single account that owns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-migrate-"));
  try {
    const path = oldShapeLedger(dir, ["0xowner"], true);
    const s = new Store(path, { log: () => {} });

    const cash = s.db.prepare("SELECT account, equity FROM paper_cash").all() as { account: string; equity: number }[];
    assert.equal(cash.length, 1);
    assert.equal(cash[0]!.account, "0xowner");
    assert.equal(cash[0]!.equity, 1234.5, "equity must survive the rebuild");

    const pos = s.db.prepare("SELECT account, coin, szi FROM paper_positions")
      .all() as { account: string; coin: string; szi: number }[];
    assert.equal(pos.length, 1);
    assert.equal(pos[0]!.account, "0xowner");
    assert.equal(pos[0]!.coin, "BTC");
    assert.equal(pos[0]!.szi, -0.01, "the position keeps its side and size");

    const lev = s.db.prepare("SELECT account, coin FROM paper_leverage")
      .all() as { account: string; coin: string }[];
    assert.equal(lev.length, 1);
    assert.equal(lev[0]!.account, "0xowner");

    // Reopening is a no-op, not a second migration.
    s.close();
    const again = new Store(path, { log: () => {} });
    assert.equal((again.db.prepare("SELECT COUNT(*) AS n FROM paper_cash").get() as { n: number }).n, 1);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an empty old paper book migrates without needing an account to attribute it to", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-migrate-empty-"));
  try {
    const s = new Store(oldShapeLedger(dir, [], false), { log: () => {} });
    const cols = (s.db.prepare("PRAGMA table_info(paper_cash)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes("account"), `expected an account column, got ${cols.join(",")}`);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a global paper book with rows and several accounts refuses rather than guessing", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-migrate-ambiguous-"));
  try {
    const path = oldShapeLedger(dir, ["0xone", "0xtwo"], true);
    assert.throws(() => new Store(path, { log: () => {} }), /no way to tell which account/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A live halt on 2026-08-31 was caused entirely by spelling: the ledger held
// checksummed account keys, `listAccounts()` had started lowercasing, and every query
// but `account()` matched exactly — so the executor found the account, found none of
// its intents, and read its own open position as a foreign one.

test("intents written under a checksummed key are found by the lowercase one", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-normalise-"));
  try {
    const path = join(dir, "db.sqlite");
    const s = new Store(path, { log: () => {} });
    s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
    // Simulate the historical rows: written before listAccounts() normalised.
    for (const t of ["accounts", "intents", "skips", "events"]) {
      s.db.exec(`UPDATE ${t} SET account = '${MASTER}'`);
    }
    s.db.prepare(
      `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision,
        coin, side, leverage, margin_usd, size_abs, ref_px, target_px, stop_px, horizon_at,
        rationale, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run("i1", MASTER, "2026-08-30T00:00:00.000Z", "quotient", "sig", 1, "xyz:COPPER", "short",
      10, 10, 14.94, 6.6888, 6.6455, 6.89, "2026-08-31T21:00:00Z", "why", "open");
    s.close();

    // Reopening normalises, and the lowercase key now finds everything.
    const again = new Store(path, { log: () => {} });
    const lower = MASTER.toLowerCase();
    assert.equal(again.account(lower)?.base_capital, 100);
    assert.equal(again.liveIntents(lower).length, 1, "the position must not read as foreign");
    assert.equal(again.openCount(lower), 1);
    assert.equal(again.deployedMargin(lower), 10);

    // And the halt actually lands on the row it names.
    again.setHalt(MASTER, true, "test");
    assert.equal(again.account(lower)?.halted, 1, "setHalt must reach the row");
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writes go in lowercase whichever spelling the caller used", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.recordEvent(MASTER, "kind", "detail");
  s.recordSkip(MASTER, { at: "2026-08-31T00:00:00.000Z", signalRef: "s", revision: 1, coin: "BTC", reason: "no-budget", detail: "d" });

  for (const t of ["accounts", "events", "skips"]) {
    const rows = s.db.prepare(`SELECT account FROM ${t}`).all() as { account: string }[];
    for (const r of rows) assert.equal(r.account, MASTER.toLowerCase(), `${t} must store lowercase`);
  }
  s.close();
});

// ── Unlinking ───────────────────────────────────────────────────────────────
//
// The unlink button shipped as a design mockup — no id, no listener, no endpoint — and
// was the only unwired control on the page. Reported 2026-08-31 as "unlink button not
// working", from the desk of a live account.
//
// What it does is the deliberately smaller of the two options: **stop managing, close
// nothing.** Force-closing every position at market would realise somebody's P&L on a
// button press. So the venue is left exactly as it was, reduce-only stops still resting,
// and what ends is our claim on it.

const INTENT = {
  intentId: "int-unlink-1",
  provider: "quotient",
  signalRef: "sig-1",
  signalRevision: 1,
  createdAt: "2026-08-31T12:00:00.000Z",
  coin: "BTC",
  side: "long" as const,
  refPx: 100,
  leverage: 10,
  marginUsd: 10,
  sizeAbs: 1,
  exit: {
    kind: "target-stop-horizon" as const,
    targetPx: 110,
    stopPx: 97,
    horizonAt: "2026-09-01T12:00:00.000Z",
    holdToTarget: false,
  },
  rationale: "test",
};

test("unlinking releases our claim and stops the runner picking the account up", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.insertIntent(MASTER, INTENT);
  assert.equal(s.liveIntents(MASTER).length, 1);

  const { released } = s.disconnectAccount(MASTER);
  assert.equal(released, 1);
  assert.equal(s.account(MASTER), null, "the account row must go, so the desk stops claiming it");
  assert.equal(s.liveIntents(MASTER).length, 0, "nothing is still live for us");
  assert.ok(!s.connectableAccounts().includes(MASTER.toLowerCase()),
    "and the runner must stop picking it up");
  s.close();
});

// The position is still open on the venue when we let go of it, so its P&L is a number
// we do not have. Writing one would be a fabrication, in the one file that must not
// contain any.
test("a released intent records disconnect, and never invents a P&L", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.insertIntent(MASTER, INTENT);
  s.disconnectAccount(MASTER);

  const row = s.intent(INTENT.intentId);
  assert.equal(row?.status, "closed");
  assert.equal(row?.close_reason, "disconnect", "the CloseReason reserved for exactly this");
  assert.equal(row?.realized_pnl, null, "we did not see it close, so we do not know");
  s.close();
});

// The ordering trap in reverse: a mandate the user *ended* must not follow them back.
// Without the account row going, reconnecting after adding money would re-use the old
// frozen baseCapital — the same class of bug as the paper row that blocked 0xdaa2.
test("reconnecting is not blocked by a mandate the user ended", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.disconnectAccount(MASTER);
  const again = s.connectAccount(MASTER, 60, DEFAULT_USER_SETTINGS, "live");
  assert.equal(again.base_capital, 60, "the new mandate is the new one");
  s.close();
});

test("unlinking an account that was never connected is harmless", () => {
  const s = freshStore();
  const { released } = s.disconnectAccount(MASTER);
  assert.equal(released, 0);
  assert.equal(s.account(MASTER), null);
  s.close();
});

// A read-only open deliberately does not apply the schema, so the public web tier is
// the one process that can be handed a ledger written by older code. Nothing told it:
// `data/signaldesk-snapshot.sqlite` opened fine, the server logged the path and
// listened, and every API request then threw `no such table: connections` and came
// back as "something went wrong on our side". `missingTables()` is what makes that
// answerable at boot instead of at request time.

test("a ledger the executor wrote is missing nothing", () => {
  const s = freshStore();
  assert.deepEqual(s.missingTables(), []);
  s.close();
});

test("a ledger written by older code names exactly what it lacks, read-only", () => {
  const path = join(mkdtempSync(join(tmpdir(), "signaldesk-store-")), "db.sqlite");
  const w = new Store(path);
  // Stand in for a file written before these tables existed.
  w.db.exec("DROP TABLE connections");
  w.db.exec("DROP TABLE paper_orders");
  w.close();

  const reader = new Store(path, { readOnly: true });
  assert.deepEqual(reader.missingTables().sort(), ["connections", "paper_orders"]);
  reader.close();

  // And the remedy the web tier prints: one read-write open migrates it in place,
  // because every statement in the schema is CREATE TABLE IF NOT EXISTS.
  new Store(path, { log: () => {} }).close();
  const after = new Store(path, { readOnly: true });
  assert.deepEqual(after.missingTables(), [], "a read-write open must repair it");
  after.close();
  rmSync(path, { force: true });
});

// The list is derived from SCHEMA so that adding a table cannot silently escape the
// check. If someone replaces it with a hardcoded array, this is what fails.
test("the check covers every table the schema defines, including new ones", () => {
  const s = freshStore();
  const defined = (s.db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all() as { name: string }[]).map((r) => r.name).sort();
  assert.ok(defined.length >= 9, `expected the full schema, saw ${defined.length}`);

  // Drop them one at a time and confirm each is individually reported.
  for (const t of defined) {
    const path = join(mkdtempSync(join(tmpdir(), "signaldesk-store-")), "db.sqlite");
    const w = new Store(path, { log: () => {} });
    w.db.exec(`DROP TABLE ${t}`);
    w.close();
    const r = new Store(path, { readOnly: true });
    assert.deepEqual(r.missingTables(), [t], `dropping ${t} must be reported`);
    r.close();
    rmSync(path, { force: true });
  }
  s.close();
});

// Unlinking is a pause in management, not a reset of risk.
//
// `disconnectAccount` deletes the account row so that reconnecting re-freezes
// `baseCapital` at a new deposit — that part is the documented flow. But the same row
// carried `halted` and the day's loss baseline, so unlink-then-reconnect cleared both:
// a self-service way to resume trading through a daily-loss halt, and to rebase the
// day's starting equity to the post-loss figure so another 10% could be lost. Nothing
// in the code clears a halt (`setHalt` is only ever called with `true`), which made
// this the *only* way to clear one. `governor.ts` calls these halts sticky, meaning
// they outlive their cause; stickiness was a column the user could delete.

test("a halt survives unlink and reconnect — an unlink does not clear it", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.setHalt(MASTER, true, "daily loss 11.2% reached the 10% cap");
  s.disconnectAccount(MASTER);

  const back = s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(back.halted, 1, "reconnecting must not resume a halted account");
  assert.match(back.halt_reason ?? "", /daily loss/);
  s.close();
});

test("the day's loss baseline survives too, so the cap cannot be rebased by reconnecting", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  // Day opens at $100; the account is down to $89 when it halts.
  s.rollDay(MASTER, 100);
  s.setHalt(MASTER, true, "daily loss 11.0% reached the 10% cap");
  s.disconnectAccount(MASTER);
  s.connectAccount(MASTER, 89, DEFAULT_USER_SETTINGS, "live");

  // Without the carry, rollDay would seed the baseline at $89 and the next 10% would
  // be measured from there — losing 10% twice in one day.
  const { dayStartEquity } = s.rollDay(MASTER, 89);
  assert.equal(dayStartEquity, 100, "the day's opening equity must not be rebased");
  s.close();
});

test("but the baseline still rolls at the UTC boundary", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.rollDay(MASTER, 100, new Date("2026-08-31T12:00:00Z"));
  s.disconnectAccount(MASTER, new Date("2026-08-31T13:00:00Z"));
  s.connectAccount(MASTER, 89, DEFAULT_USER_SETTINGS, "live", new Date("2026-09-01T09:00:00Z"));

  const rolled = s.rollDay(MASTER, 89, new Date("2026-09-01T09:00:01Z"));
  assert.equal(rolled.day, "2026-09-01");
  assert.equal(rolled.dayStartEquity, 89, "a new day starts from the equity it actually has");
  s.close();
});

// The other half: what reconnecting IS for must keep working.
test("capital and settings still re-freeze on reconnect — only risk state carries", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.setHalt(MASTER, true, "1 position(s) on this account were not opened by us");
  s.disconnectAccount(MASTER);

  const settings = { ...DEFAULT_USER_SETTINGS, leverage: 20 as const };
  const back = s.connectAccount(MASTER, 250, settings, "live");
  assert.equal(back.base_capital, 250, "a fresh deposit must re-freeze the base");
  assert.equal(JSON.parse(back.settings).leverage, 20, "new settings must take effect");
  assert.equal(back.halted, 1, "while the halt still carries");
  s.close();
});

test("an account that was never halted reconnects clean", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.disconnectAccount(MASTER);
  const back = s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(back.halted, 0);
  assert.equal(back.halt_reason, null);
  s.close();
});

test("reconnecting into a carried halt records why, so the desk can explain itself", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.setHalt(MASTER, true, "daily loss 11.2% reached the 10% cap");
  s.disconnectAccount(MASTER);
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");

  const events = s.db.prepare(
    "SELECT detail FROM events WHERE account = ? AND kind = 'halt' ORDER BY at DESC LIMIT 1",
  ).get(MASTER.toLowerCase()) as { detail: string };
  assert.match(events.detail, /does not clear a halt/);
  assert.match(events.detail, /daily loss/);
  s.close();
});

// The operator path stays the only way out, and it stays a way out: clearing the halt
// on the account row must not be undone by a later unlink/reconnect. It is not,
// because a disconnect always rewrites the carried state from the row as it stands.
test("an operator clearing a halt sticks, including across a later reconnect", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.setHalt(MASTER, true, "1 position(s) on this account were not opened by us");
  s.disconnectAccount(MASTER);
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(s.account(MASTER)!.halted, 1, "still halted after the user reconnects");

  // deploy/server-cmds.md: "only after you have looked".
  s.setHalt(MASTER, false, null);
  s.disconnectAccount(MASTER);
  const back = s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(back.halted, 0, "an operator's decision is not re-halted by the carry");
  assert.equal(back.halt_reason, null);
  s.close();
});

// ── the desk's copy of the limits in force (`syncAccountSettings`) ────────────────
//
// `connectAccount` returns an existing row untouched, which is the whole point for
// `baseCapital` and was silently wrong for the settings: an operator's
// `accounts/<address>.json` is re-read at every connect and outranks the row, so editing
// one changed what was traded and nothing that was shown. Ten accounts were moved to a 1%
// stop that way on 2026-09-10 and all ten went on advertising 3% — on a leaderboard other
// owners read specifically to compare each other's settings.

test("a stale settings column is corrected to what is in force, and the owner's own row is not", () => {
  const s = freshStore();
  const chose = { ...DEFAULT_USER_SETTINGS, stopPct: 0.03, mode: "live" };
  s.upsertConnection({ account: MASTER, status: "active", agentAddress: null, settings: chose, lastError: null });
  s.connectAccount(MASTER, 100, chose, "live");

  const inForce = { ...chose, stopPct: 0.01 };
  const synced = s.syncAccountSettings(MASTER, inForce);
  assert.ok(synced, "a differing column must be corrected");
  assert.equal(JSON.parse(synced.settings).stopPct, 0.01);
  // The connections row is what its owner last chose. Deleting the operator's file has to
  // hand that back, so this must never write over it.
  assert.equal(JSON.parse(s.connection(MASTER)!.settings).stopPct, 0.03);
  // Recorded, and saying which of the two things happened: the row caught up, the account
  // was not re-priced.
  const ev = s.db.prepare("SELECT kind, detail FROM events WHERE kind = 'settings' ORDER BY at DESC")
    .get() as { kind: string; detail: string };
  assert.match(ev.detail, /stale/);
  assert.match(ev.detail, /did not change/);

  // Idempotent: the connect path calls this every loop an account joins on.
  assert.equal(s.syncAccountSettings(MASTER, inForce), null);
  s.close();
});

test("syncing an account that has no row is a no-op, not a throw", () => {
  const s = freshStore();
  assert.equal(s.syncAccountSettings(MASTER, DEFAULT_USER_SETTINGS), null);
  s.close();
});

// ── tasks/42: a stop closes the market for the rest of the UTC day ───────────────
//
// `hasLiveIntentFor` and `hasLiveIntentOn` both ask whether an intent is still running,
// so until `stoppedOutToday` a *closed* one constrained nothing and a stopped-out
// position reopened on the next tick. Measured over the ledger to 2026-09-11: 50 such
// re-entries returned −6.31% of margin against +0.24% after a `retired` close, and none
// of the fifty reached its target.

function stopped(s: Store, id: string, coin: string, side: "long" | "short", closedAt: string): void {
  s.insertIntent(MASTER, { ...INTENT, intentId: id, signalRef: id, coin, side });
  s.markClosed(id, "stop", -1, new Date(closedAt));
}

test("a stop closes that market and side for the rest of the UTC day, and only that one", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  stopped(s, "int-stop-btc", "BTC", "long", "2026-09-11T05:35:00.000Z");

  const later = new Date("2026-09-11T23:59:59.000Z");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", later), true, "same market, same side, same day");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "short", later), false,
    "the other side is a different call — every post-stop re-entry in the ledger is same-side");
  assert.equal(s.stoppedOutToday(MASTER, "ETH", "long", later), false, "another market is untouched");
  assert.equal(s.stoppedOutToday("0xacc00004fd000000000000000000000000000000", "BTC", "long", later), false,
    "and another account is untouched — one account never constrains another");
  s.close();
});

// ── tasks/51 §5a: the stamp the tick writes, beside the reason the ingest writes ────
//
// On a live account nothing in `tick()` can write `close_reason = 'stop'` — our order
// row is stamped once at placement and HL cancels the sibling trigger the moment the
// position goes, so every venue-side exit lands as `retired` until the fill ingest
// relabels it. That is the exact state these two tests put the ledger in.

test("stopped_at blocks re-entry on its own, with close_reason still saying retired", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-live-shape", signalRef: "int-live-shape", coin: "BTC", side: "long" });
  const closedAt = new Date("2026-09-14T12:38:51.334Z");
  s.markClosed("int-live-shape", "retired", -0.85, closedAt);

  const later = new Date("2026-09-14T12:41:47.360Z");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", later), false,
    "the 2026-09-14 hole: eight accounts re-entered here, three minutes after their own stop");

  s.markStoppedOut("int-live-shape", closedAt);
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", later), true, "and this is what closes it");
  assert.equal(s.intent("int-live-shape")!.close_reason, "retired",
    "the stamp is not an attribution and must never rewrite the reason");
  s.close();
});

test("the stamp keeps the same keys as the reason: one market, one side, one account, one day", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-stamp", signalRef: "int-stamp", coin: "BTC", side: "long" });
  const closedAt = new Date("2026-09-14T12:38:51.334Z");
  s.markClosed("int-stamp", "retired", -0.85, closedAt);
  s.markStoppedOut("int-stamp", closedAt);

  const later = new Date("2026-09-14T23:59:59.000Z");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "short", later), false, "the other side is a different call");
  assert.equal(s.stoppedOutToday(MASTER, "ETH", "long", later), false, "another market is untouched");
  assert.equal(s.stoppedOutToday("0xacc00004fd000000000000000000000000000000", "BTC", "long", later), false,
    "and another account is untouched");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", new Date("2026-09-15T00:01:00.000Z")), false,
    "it releases on the same UTC boundary the reason does");
  s.close();
});

test("the block releases at the UTC boundary rollDay already uses, not 24h after the stop", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  stopped(s, "int-stop-late", "BTC", "long", "2026-09-11T23:50:00.000Z");

  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", new Date("2026-09-11T23:59:00.000Z")), true);
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", new Date("2026-09-12T00:01:00.000Z")), false,
    "ten minutes later, because the day rolled — a second clock is what this avoids");
  s.close();
});

test("only a stop blocks: a retired or target close leaves the market open", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  const at = new Date("2026-09-11T05:35:00.000Z");
  for (const [id, reason] of [["int-ret", "retired"], ["int-tgt", "target"], ["int-hz", "horizon"]] as const) {
    s.insertIntent(MASTER, { ...INTENT, intentId: id, signalRef: id, coin: "BTC", side: "long" });
    s.markClosed(id, reason, 1, at);
    assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", at), false,
      `a '${reason}' close must not block — the placebo says it is specific to the stop`);
  }
  // …and the stop, on the same market, does.
  stopped(s, "int-stp", "BTC", "long", "2026-09-11T06:00:00.000Z");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", at), true);
  s.close();
});

test("an intent still closing does not count — hasLiveIntentOn is what refuses that one", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-closing", signalRef: "int-closing", coin: "BTC" });
  s.markClosing("int-closing", "stop");
  assert.equal(s.stoppedOutToday(MASTER, "BTC", "long", new Date("2026-09-11T06:00:00.000Z")), false,
    "markClosing writes the reason before the fill lands; the intent is still live");
  assert.equal(s.hasLiveIntentOn(MASTER, "BTC"), true, "and that is the guard that refuses it");
  s.close();
});

// ── `tasks/41` — dropping the vendor's epoch tag from every stored ref ─────────────
//
// Tested against a copy of the live ledger before it ever ran against one, the same way
// `migrateSkips` was: 408 signals → 407, 4,281 skips → 3,492, 75 distinct intent refs →
// 73, `seen_count` conserved at 700,244, reopening a no-op. What is pinned here is the
// behaviour those numbers came from.

const OLD_7 = "po:commodity:wti:price-outlook:daily:2026-09-11:47f8c5a6ef3e223c";
const OLD_7B = "po:commodity:wti:price-outlook:daily:2026-09-11:ad418704103bb56d";
const OLD_8 = "po:commodity:wti:price-outlook:daily:2026-09-11:47f8c5a6ef3e223c:0e0b64d64a21e8f2";
const KEY = "po:commodity:wti:price-outlook:daily:2026-09-11";

/** A ledger holding pre-2026-09-13 refs. Written through the raw handle, because a
 *  `Store` open is what runs the migration. */
function ledgerWithOldRefs(dir: string): string {
  const path = join(dir, "db.sqlite");
  const s = new Store(path, { log: () => {} });
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "paper");
  const sig = s.db.prepare(
    "INSERT INTO signals (signal_ref, revision, first_seen_at, coin, side, mode, strength, " +
    "displacement_sigma, target_px, horizon_at, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  );
  // The same outlook and the same revision, recorded once raw and once stripped — the
  // one collision the live ledger actually holds.
  sig.run(OLD_8, 8, "2026-08-30T17:56:14.533Z", "xyz:CL", "long", "signal", "high", 1.2, 60, "2026-09-12T00:00:00Z", "{}");
  sig.run(OLD_7, 8, "2026-08-30T18:53:28.562Z", "xyz:CL", "long", "signal", "high", 1.2, 60, "2026-09-12T00:00:00Z", "{}");
  sig.run(OLD_7B, 9, "2026-09-11T06:00:00.000Z", "xyz:CL", "long", "signal", "high", 1.3, 61, "2026-09-12T00:00:00Z", "{}");
  const skip = s.db.prepare(
    "INSERT INTO skips (account, signal_ref, reason, coin, first_at, last_at, first_revision, " +
    "last_revision, seen_count, detail) VALUES (?,?,?,?,?,?,?,?,?,?)",
  );
  skip.run(MASTER.toLowerCase(), OLD_7, "no-direction", "xyz:CL", "2026-09-10T01:00:00Z", "2026-09-11T05:00:00Z", 3, 8, 40, "older detail");
  skip.run(MASTER.toLowerCase(), OLD_7B, "no-direction", "xyz:CL", "2026-09-11T06:00:00Z", "2026-09-11T09:00:00Z", 9, 11, 2, "newer detail");
  skip.run(MASTER.toLowerCase(), OLD_7B, "displacement-below-gate", "xyz:CL", "2026-09-11T06:00:00Z", "2026-09-11T07:00:00Z", 9, 10, 5, "a different reason stays its own row");
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-before", signalRef: OLD_7, coin: "xyz:CL" });
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-after", signalRef: OLD_7B, coin: "xyz:CL" });
  s.close();
  return path;
}

test("the vendor's epoch tag is dropped from every table, and both stored forms land on one key", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-tag-"));
  try {
    const path = ledgerWithOldRefs(dir);
    const s = new Store(path, { log: () => {} });

    const refs = s.db.prepare("SELECT DISTINCT signal_ref AS r FROM intents").all() as { r: string }[];
    assert.deepEqual(refs.map((x) => x.r), [KEY], "two epochs of one outlook are one outlook");
    assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM intents").get() as { n: number }).n, 2,
      "the intents themselves are untouched — only the column they key on moved");

    // `signals` is keyed (signal_ref, revision): the raw and the stripped row are the
    // same revision and collapse; revision 9 is a different row and survives.
    const sigs = s.db.prepare("SELECT signal_ref, revision, first_seen_at FROM signals ORDER BY revision")
      .all() as { signal_ref: string; revision: number; first_seen_at: string }[];
    assert.equal(sigs.length, 2);
    assert.deepEqual(sigs.map((x) => x.signal_ref), [KEY, KEY]);
    assert.equal(sigs[0]!.first_seen_at, "2026-08-30T17:56:14.533Z",
      "the survivor is the first time we saw that revision, which is what the column means");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("colliding skips collapse rather than throw, and nothing is invented", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-tag-skips-"));
  try {
    const s = new Store(ledgerWithOldRefs(dir), { log: () => {} });
    const rows = s.db.prepare(
      "SELECT signal_ref, reason, first_at, last_at, first_revision, last_revision, seen_count, detail " +
      "FROM skips ORDER BY reason",
    ).all() as {
      signal_ref: string; reason: string; first_at: string; last_at: string;
      first_revision: number; last_revision: number; seen_count: number; detail: string;
    }[];
    assert.equal(rows.length, 2, "two epochs of one reason collapse; a second reason keeps its own row");

    const nd = rows.find((r) => r.reason === "no-direction")!;
    assert.equal(nd.signal_ref, KEY);
    assert.equal(nd.seen_count, 42, "40 + 2 — the sightings add up and none is lost");
    assert.equal(nd.first_at, "2026-09-10T01:00:00Z", "the window opens at the earliest sighting");
    assert.equal(nd.last_at, "2026-09-11T09:00:00Z", "and closes at the latest");
    assert.equal(nd.first_revision, 3);
    assert.equal(nd.last_revision, 11);
    assert.equal(nd.detail, "newer detail", "a detail quoting a live figure is only interesting as of the last look");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The one way this migration can do real damage: applied twice it takes the anchor date
// with it, and every anchor of a series becomes one key. There is no migrations table to
// stop that — only the shape.
test("reopening a migrated ledger is a no-op, and the anchor date survives", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-tag-twice-"));
  try {
    const path = ledgerWithOldRefs(dir);
    for (let i = 0; i < 3; i++) {
      const s = new Store(path, { log: () => {} });
      const refs = s.db.prepare("SELECT DISTINCT signal_ref AS r FROM intents").all() as { r: string }[];
      assert.deepEqual(refs.map((x) => x.r), [KEY], `open ${i + 1} must not truncate again`);
      assert.equal((s.db.prepare("SELECT COUNT(*) AS n FROM skips").get() as { n: number }).n, 2);
      assert.equal((s.db.prepare("SELECT SUM(seen_count) AS n FROM skips").get() as { n: number }).n, 47);
      s.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a ledger with no stale refs is not rewritten at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-tag-clean-"));
  try {
    const path = join(dir, "db.sqlite");
    const s = new Store(path, { log: () => {} });
    s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "paper");
    s.insertIntent(MASTER, { ...INTENT, intentId: "int-new", signalRef: KEY, coin: "xyz:CL" });
    s.close();
    const lines: string[] = [];
    const again = new Store(path, { log: (m) => lines.push(m) });
    assert.equal(lines.filter((l) => l.includes("epoch tag")).length, 0, "nothing to migrate, nothing said");
    assert.equal((again.db.prepare("SELECT signal_ref FROM intents").get() as { signal_ref: string }).signal_ref, KEY);
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2026-09-16: how old is the forecast, measured against what we already know ──────
//
// A target close is the one exit that leaves the vendor's call bit-identical — the side
// does not turn and the revision does not move — so the desk re-enters on a snapshot
// observed before its own fill. Quotient re-bases `ref_median` to the new spot on the
// next revision (0.847σ → 0.354σ on ETH, 2026-09-15), and until it arrives the stale
// target still reads above the gate. `lastCloseAt` is what the executor compares against.
// `notes/2026-09-16-the-snapshot-that-predates-the-fill.md`.

test("lastCloseAt answers per outlook and per account, and nothing else", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  assert.equal(s.lastCloseAt(MASTER, "outlook-a"), null, "nothing closed is not a stale forecast");

  s.insertIntent(MASTER, { ...INTENT, intentId: "int-a1", signalRef: "outlook-a", coin: "BTC", side: "long" });
  assert.equal(s.lastCloseAt(MASTER, "outlook-a"), null, "an open position is not a close");

  s.markClosed("int-a1", "target", 1.2, new Date("2026-09-15T20:01:23.000Z"));
  assert.equal(s.lastCloseAt(MASTER, "outlook-a"), "2026-09-15T20:01:23.000Z");
  assert.equal(s.lastCloseAt(MASTER, "outlook-b"), null,
    "keyed on the outlook — `ref_median` is per-outlook, so another call's reference is its own");
  assert.equal(s.lastCloseAt("0xacc00004fd000000000000000000000000000000", "outlook-a"), null,
    "and per account — one account never constrains another");
  s.close();
});

test("lastCloseAt is the most recent close, whatever the reason and whatever the side", () => {
  const s = freshStore();
  s.connectAccount(MASTER, 100, DEFAULT_USER_SETTINGS, "live");
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-c1", signalRef: "outlook-c", coin: "BTC", side: "long" });
  s.markClosed("int-c1", "target", 1.2, new Date("2026-09-15T20:01:23.000Z"));
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-c2", signalRef: "outlook-c", coin: "BTC", side: "short" });
  s.markClosed("int-c2", "retired", -0.4, new Date("2026-09-15T21:30:00.000Z"));

  assert.equal(s.lastCloseAt(MASTER, "outlook-c"), "2026-09-15T21:30:00.000Z",
    "the newest close is the one a forecast has to be newer than");

  // Side is deliberately absent from the key and would be redundant in it: a side change
  // needs a new revision, and a revision carries a newer `observed_at`, so it clears the
  // guard on its own without the key having to know about it.
  s.insertIntent(MASTER, { ...INTENT, intentId: "int-c3", signalRef: "outlook-c", coin: "BTC", side: "long" });
  assert.equal(s.lastCloseAt(MASTER, "outlook-c"), "2026-09-15T21:30:00.000Z",
    "and an intent still running does not move it");
  s.close();
});
