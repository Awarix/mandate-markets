import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_USER_SETTINGS } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { canChangeMandate, canChangeSettings, changeStatus } from "./changes.ts";
import { WebStore } from "./sessions.ts";

const A = "0x1111111111111111111111111111111111111111";

// The three refusals a limits change meets before it is even recorded.
test("a limits change needs a connected account, no unlink pending, and no operator pin", () => {
  assert.equal(canChangeSettings({ hasAccountRow: true, unlinkPending: false, pinned: false }).ok, true);
  const noRow = canChangeSettings({ hasAccountRow: false, unlinkPending: false, pinned: false });
  assert.ok(!noRow.ok && /connect screen/.test(noRow.error));
  const unlinking = canChangeSettings({ hasAccountRow: true, unlinkPending: true, pinned: false });
  assert.ok(!unlinking.ok && /stop managing/.test(unlinking.error));
  const pinned = canChangeSettings({ hasAccountRow: true, unlinkPending: false, pinned: true });
  assert.ok(!pinned.ok && /operator/.test(pinned.error));
});

// The pin carries settings, not capital: our own account is pinned by its file for
// limits and must still be able to re-read its mandate.
test("a mandate re-read is refused only without an account or with an unlink pending", () => {
  assert.equal(canChangeMandate({ hasAccountRow: true, unlinkPending: false }).ok, true);
  assert.equal(canChangeMandate({ hasAccountRow: false, unlinkPending: false }).ok, false);
  assert.equal(canChangeMandate({ hasAccountRow: true, unlinkPending: true }).ok, false);
});

// Status is computed, not stored: a request is pending exactly while it is newer than
// the ledger's last apply, and "since <date>" is that apply.
test("a request is pending until the ledger's stamp passes it, and the refusal rides only while it is", () => {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-changes-"));
  const store = new Store(join(dir, "ledger.sqlite"), { log: () => {} });
  const web = new WebStore(join(dir, "web.sqlite"));
  const accountsDir = join(dir, "accounts");
  mkdirSync(accountsDir);
  try {
    assert.equal(changeStatus(store, web, A, accountsDir), null, "no row, no status");

    const connectedAt = new Date("2026-09-04T10:00:00Z");
    store.connectAccount(A, 100, DEFAULT_USER_SETTINGS, "live", connectedAt);
    store.upsertConnection({ account: A, status: "active", agentAddress: null, settings: DEFAULT_USER_SETTINGS });
    const fresh = changeStatus(store, web, A, accountsDir)!;
    assert.equal(fresh.pendingSettings, null);
    assert.equal(fresh.pendingMandate, null);
    assert.equal(fresh.settingsAt, connectedAt.toISOString(), "until anything changes, the stamp is the connect");
    assert.equal(fresh.pinned, false);

    web.requestSettings(A, { ...DEFAULT_USER_SETTINGS, leverage: 20 }, connectedAt.getTime() + 60_000);
    web.requestMandate(A, connectedAt.getTime() + 61_000);
    store.setConnectionError(A, "Those limits need a mandate of at least $40.41");
    const pending = changeStatus(store, web, A, accountsDir)!;
    assert.equal(pending.pendingSettings?.settings.leverage, 20);
    assert.ok(pending.pendingMandate);
    assert.match(pending.refused!, /at least/, "the executor's own words, while the request stands");

    // The executor applies both; the same rows are now spent.
    const applied = new Date(connectedAt.getTime() + 120_000);
    store.applySettings(A, { ...DEFAULT_USER_SETTINGS, leverage: 20 }, applied);
    store.applyMandate(A, 300, 300, applied);
    store.setConnectionError(A, null);
    const done = changeStatus(store, web, A, accountsDir)!;
    assert.equal(done.pendingSettings, null);
    assert.equal(done.pendingMandate, null);
    assert.equal(done.settingsAt, applied.toISOString());
    assert.equal(done.mandateAt, applied.toISOString());
    assert.equal(done.refused, null);

    // A connect failure in last_error is not a refusal of anything asked for here.
    store.setConnectionError(A, "agent not approved yet");
    assert.equal(changeStatus(store, web, A, accountsDir)!.refused, null);

    writeFileSync(join(accountsDir, `${A}.json`), "{}");
    assert.equal(changeStatus(store, web, A, accountsDir)!.pinned, true);
  } finally {
    store.close(); web.close(); rmSync(dir, { recursive: true, force: true });
  }
});
