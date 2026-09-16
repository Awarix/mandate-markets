import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { EMPTY_KEYSTORE, getKey, hasKey, loadKeystore } from "../keys/keystore.ts";
import { DEFAULT_USER_SETTINGS } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { WebStore } from "../web/sessions.ts";
import { readConnectRequests, readUnlinkRequests, serviceConnectRequests } from "./connect-queue.ts";

// The agent key is generated here and nowhere else, so these check the properties
// that matter if this file is ever wrong: the key is sealed and never written in the
// clear, the address the user approves is really derived from the key we hold, and a
// second run cannot mint a second key for an account that already has one.

const ALICE = "0x1111111111111111111111111111111111111111";
const PASS = "correct horse battery staple";

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-connect-"));
  const store = new Store(join(dir, "ledger.sqlite"), { log: () => {} });
  const web = new WebStore(join(dir, "web.sqlite"));
  return {
    dir, store, web,
    keystoreFile: join(dir, "keystore.json"),
    requestsDb: join(dir, "web.sqlite"),
    /** Admitted, then asking — the order the site enforces since `tasks/17`. The web
     *  tier refuses to record a request from an address the queue has not let in, so a
     *  `connection_requests` row without an admission is a state production cannot
     *  reach; the one test below that builds it deliberately checks the door. */
    request: (address: string, settings: unknown = DEFAULT_USER_SETTINGS, now = Date.now()) => {
      // The admission is dated in real time deliberately: `now` here is a synthetic
      // ordering between a connect and an unlink, and an admission stamped 1970 would
      // be lapsed before the code under test ever looked at it.
      store.admit(address, "queue", new Date(Date.now() + 72 * 3600_000));
      web.requestConnection(address, settings, now);
    },
    done: () => { store.close(); web.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const run = (r: ReturnType<typeof rig>, keystore = EMPTY_KEYSTORE, passphrase: string | null = PASS) =>
  serviceConnectRequests({
    store: r.store, keystore, passphrase,
    keystoreFile: r.keystoreFile, requestsDb: r.requestsDb, log: () => {},
  });

test("a request mints a sealed agent key and publishes only its address", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);

    const conn = r.store.connection(ALICE);
    assert.ok(conn, "a connections row must exist");
    assert.equal(conn!.status, "awaiting_approval");
    assert.match(conn!.agent_address!, /^0x[0-9a-fA-F]{40}$/);

    // The address the user is told to approve must be the one our key actually signs
    // with. If these ever diverge, the user approves a key we do not hold.
    const priv = getKey(ks, ALICE, PASS);
    assert.ok(priv, "the key must be retrievable with the passphrase");
    assert.equal(privateKeyToAccount(priv as `0x${string}`).address, conn!.agent_address);
  } finally { r.done(); }
});

test("the private key is never written in the clear", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);
    const priv = getKey(ks, ALICE, PASS)!;

    const onDisk = readFileSync(r.keystoreFile, "utf8");
    assert.ok(!onDisk.includes(priv), "the keystore file must not contain the plaintext key");
    assert.ok(!onDisk.includes(priv.slice(2)), "nor the key without its 0x prefix");

    // Nor may it leak into the side of the handshake the web tier can read.
    const ledger = readFileSync(join(r.dir, "ledger.sqlite"));
    assert.ok(!ledger.includes(Buffer.from(priv.slice(2), "hex")), "the ledger must not hold key bytes");
    assert.ok(!ledger.toString("latin1").includes(priv), "nor the key as text");
  } finally { r.done(); }
});

test("servicing twice does not mint a second key for the same account", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const first = run(r);
    const keyAfterFirst = getKey(first, ALICE, PASS);
    const agentAfterFirst = r.store.connection(ALICE)!.agent_address;

    // Hyperliquid tracks nonces per signer, and the old key would still be approved.
    const second = run(r, first);
    assert.equal(getKey(second, ALICE, PASS), keyAfterFirst, "the key must not be replaced");
    assert.equal(r.store.connection(ALICE)!.agent_address, agentAfterFirst);
  } finally { r.done(); }
});

test("without a passphrase nothing is minted, and the user is told plainly", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r, EMPTY_KEYSTORE, null);

    assert.equal(hasKey(ks, ALICE), false, "no key may be sealed without a passphrase");
    const conn = r.store.connection(ALICE)!;
    assert.equal(conn.agent_address, null);
    assert.match(conn.last_error!, /our problem, not/);
  } finally { r.done(); }
});

test("an account already connected is left alone", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);
    r.store.setConnectionStatus(ALICE, "active", null);

    // The user re-submits different numbers after connecting. baseCapital and the
    // settings are frozen by then, so this must not quietly rewrite the row.
    r.request(ALICE, { ...DEFAULT_USER_SETTINGS, leverage: 20 });
    run(r, ks);

    const conn = r.store.connection(ALICE)!;
    assert.equal(conn.status, "active");
    assert.equal((JSON.parse(conn.settings) as { leverage: number }).leverage, DEFAULT_USER_SETTINGS.leverage);
  } finally { r.done(); }
});

test("a request with unreadable settings is skipped, not fatal", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const bob = "0x2222222222222222222222222222222222222222";
    r.web.db.prepare("INSERT INTO connection_requests (address, requested_at, settings) VALUES (?,?,?)")
      .run(bob, Date.now(), "{not json");

    assert.equal(readConnectRequests(r.requestsDb).length, 1, "only the readable one survives");
    const ks = run(r);
    assert.equal(hasKey(ks, ALICE), true, "the good request is still serviced");
    assert.equal(r.store.connection(bob), null);
  } finally { r.done(); }
});

test("settings outside the allowed range never reach the ledger", () => {
  const r = rig();
  try {
    // 40x is not one of the three the product offers. `validate` refuses rather than
    // clamping, so the request is dropped instead of silently becoming something else.
    r.web.db.prepare("INSERT INTO connection_requests (address, requested_at, settings) VALUES (?,?,?)")
      .run(ALICE, Date.now(), JSON.stringify({ ...DEFAULT_USER_SETTINGS, leverage: 40 }));

    assert.equal(readConnectRequests(r.requestsDb).length, 0);
    run(r);
    assert.equal(r.store.connection(ALICE), null);
  } finally { r.done(); }
});

test("no requests database yet is not an error", () => {
  assert.deepEqual(readConnectRequests(join(tmpdir(), "definitely-not-here.sqlite")), []);
});

test("the sealed keystore round-trips from disk", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);
    const reopened = loadKeystore(r.keystoreFile);
    assert.equal(getKey(reopened, ALICE, PASS), getKey(ks, ALICE, PASS));
    // A wrong passphrase throws rather than returning null: an AES-GCM tag mismatch
    // cannot distinguish "wrong key" from "tampered ciphertext", and silently
    // returning nothing would let a caller treat tampering as a missing entry.
    assert.throws(() => getKey(reopened, ALICE, "wrong passphrase"), /wrong passphrase/);
  } finally { r.done(); }
});

// ── Coming back after an unlink ─────────────────────────────────────────────
//
// Unlink was a one-way door for the hour it existed on 2026-08-31. `disconnectAccount`
// sets the connections row to "disconnected", which `connectableAccounts()` deliberately
// excludes so the runner stops picking the account up — and this function then
// short-circuited on the already-recorded agent address, so the row was never returned
// to "awaiting_approval". Nothing put it back. The user pressed Connect, the web wrote a
// request, and no part of the executor ever looked at the address again.
//
// It was invisible from the screen: `connectStatus` reports a disconnected account as
// "choose", so the flow looked exactly like a fresh, working start.

test("an unlinked account can connect again, and keeps its already-approved agent", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);
    const agent = r.store.connection(ALICE)!.agent_address;
    assert.ok(agent);

    // Connect, then unlink — the state 0xdaa2 was left in.
    r.store.connectAccount(ALICE, 100, DEFAULT_USER_SETTINGS, "live");
    r.store.setConnectionStatus(ALICE, "active", null);
    r.store.disconnectAccount(ALICE);
    assert.equal(r.store.connection(ALICE)!.status, "disconnected");
    assert.deepEqual(r.store.connectableAccounts(), [], "the runner has correctly let go");

    // They come back and press Connect.
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    run(r, ks);

    assert.equal(r.store.connection(ALICE)!.status, "awaiting_approval",
      "the row must be re-armed, or connectableAccounts() never returns this address again");
    assert.ok(r.store.connectableAccounts().includes(ALICE.toLowerCase()),
      "and the runner must actually pick it up");
    assert.equal(r.store.connection(ALICE)!.agent_address, agent,
      "the agent must NOT be re-minted — HL tracks nonces per signer and this one is approved");
    assert.ok(hasKey(ks, ALICE), "the sealed key is still the same one");
  } finally {
    r.done();
  }
});

// Found only because the bug above was. The comment on `serviceConnectRequests` says
// settings may change while the user is still deciding — and this branch skipped the
// write entirely, so changing your limits before approving the agent silently kept the
// old ones. They are what the executor freezes at connect, so it mattered.
test("changing your limits before approving actually changes them", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);
    assert.equal(JSON.parse(r.store.connection(ALICE)!.settings).leverage, DEFAULT_USER_SETTINGS.leverage);

    // ⚠ Both fields must differ from the default, or "it was stored" and "it fell back"
    // are the same observation. `stopPct` here was `0.02`, which **became the default on
    // 2026-09-12** — so from that day only the leverage half of this test proved anything
    // (`tasks/46` §3.3). The inequality is asserted first, where a future default move
    // fails it with the reason rather than leaving it quietly hollow.
    const changed = { ...DEFAULT_USER_SETTINGS, leverage: 5 as const, stopPct: 0.04 };
    assert.notEqual(changed.leverage, DEFAULT_USER_SETTINGS.leverage);
    assert.notEqual(changed.stopPct, DEFAULT_USER_SETTINGS.stopPct);

    r.request(ALICE, changed);
    run(r, ks);

    const stored = JSON.parse(r.store.connection(ALICE)!.settings);
    assert.equal(stored.leverage, changed.leverage, "the second request's limits must win");
    assert.equal(stored.stopPct, changed.stopPct);
  } finally {
    r.done();
  }
});

test("an active account is never disturbed by a stale request", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS);
    const ks = run(r);
    r.store.connectAccount(ALICE, 100, DEFAULT_USER_SETTINGS, "live");
    r.store.setConnectionStatus(ALICE, "active", null);

    // A request row outlives the connection; servicing it must not re-arm a live account.
    r.request(ALICE, { ...DEFAULT_USER_SETTINGS, leverage: 20 as const });
    run(r, ks);

    assert.equal(r.store.connection(ALICE)!.status, "active", "a connected account stays connected");
    assert.equal(JSON.parse(r.store.connection(ALICE)!.settings).leverage, DEFAULT_USER_SETTINGS.leverage,
      "and its frozen limits are not rewritten underneath it");
  } finally {
    r.done();
  }
});

// ── When both requests exist ────────────────────────────────────────────────
//
// Neither request row expires, and the executor opens web.sqlite read-only, so nothing
// on this side can retire either. An address that has ever connected AND ever unlinked
// therefore satisfies both queries forever — and the two loops fought over it once a
// minute on the live VPS on 2026-08-31: three release/re-arm pairs in three minutes,
// each writing a transaction and an event, for an account whose owner asked exactly once
// to be let go. Whichever request is newer now wins.

test("the newer request wins, so connect and unlink cannot fight", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS, 1000);
    assert.deepEqual(readConnectRequests(r.requestsDb).map((q) => q.address), [ALICE.toLowerCase()]);
    assert.deepEqual(readUnlinkRequests(r.requestsDb), []);

    // They unlink. The connection request row is still there, and must stop counting.
    r.web.requestUnlink(ALICE, 2000);
    assert.deepEqual(readConnectRequests(r.requestsDb), [],
      "a connect request older than the unlink must not re-arm the account");
    assert.deepEqual(readUnlinkRequests(r.requestsDb), [ALICE.toLowerCase()]);

    // They come back. Now the connect wins, and the stale unlink must not release them.
    r.request(ALICE, DEFAULT_USER_SETTINGS, 3000);
    assert.deepEqual(readConnectRequests(r.requestsDb).map((q) => q.address), [ALICE.toLowerCase()]);
    assert.deepEqual(readUnlinkRequests(r.requestsDb), [],
      "a stale unlink must not release an account that has since asked to connect");
  } finally {
    r.done();
  }
});

// The live symptom, driven directly: run the servicing twice with both rows present and
// the connections row must not oscillate.
test("servicing twice with both requests present does not oscillate", () => {
  const r = rig();
  try {
    r.request(ALICE, DEFAULT_USER_SETTINGS, 1000);
    const ks = run(r);
    r.store.connectAccount(ALICE, 100, DEFAULT_USER_SETTINGS, "live");
    r.store.setConnectionStatus(ALICE, "active", null);

    // Unlink, exactly as the runner does it.
    r.web.requestUnlink(ALICE, 2000);
    r.store.disconnectAccount(ALICE);
    assert.equal(r.store.connection(ALICE)!.status, "disconnected");

    // Two more loops. Neither may re-arm the account.
    for (const loop of [1, 2]) {
      run(r, ks);
      assert.equal(r.store.connection(ALICE)!.status, "disconnected",
        `loop ${loop} re-armed an account whose owner asked to be let go`);
      assert.deepEqual(r.store.connectableAccounts(), [],
        `loop ${loop} handed the account back to the runner`);
    }
  } finally {
    r.done();
  }
});

// An account stuck mid-fight when this shipped must leave it without a repair step —
// which is why precedence is a comparison and not a deletion.
test("an account already caught in the fight settles on the next loop", () => {
  const r = rig();
  try {
    // The exact state 0xdaa2 was in: both rows, unlink newer, row flipped to re-armed.
    r.request(ALICE, DEFAULT_USER_SETTINGS, 1000);
    const ks = run(r);
    r.web.requestUnlink(ALICE, 2000);
    r.store.setConnectionStatus(ALICE, "awaiting_approval", null);   // mid-flip-flop

    run(r, ks);
    assert.equal(r.store.connection(ALICE)!.status, "awaiting_approval",
      "servicing must not touch it further; releaseUnlinked settles it");
    assert.deepEqual(readUnlinkRequests(r.requestsDb), [ALICE.toLowerCase()],
      "and the unlink is still the current request, so the runner will release it");
  } finally {
    r.done();
  }
});

// ── The queue's door, on the granting side (`tasks/17`) ─────────────────────
//
// The web tier refuses to write a request for an unadmitted address, and this is the
// same check in the process that actually mints the key. Two gates because they fail
// differently: that one is a sentence somebody reads, and this one is what makes a
// written row — from an older web tier, or a hand-edited database — insufficient.

test("a request from an address the queue has not admitted mints nothing", () => {
  const r = rig();
  try {
    r.web.requestConnection(ALICE, DEFAULT_USER_SETTINGS);   // deliberately not admitted
    const ks = run(r);
    assert.equal(r.store.connection(ALICE), null, "no connections row");
    assert.equal(hasKey(ks, ALICE), false, "and no key was minted");
  } finally { r.done(); }
});

test("an admission that has lapsed does not open the door either", () => {
  const r = rig();
  try {
    r.web.requestConnection(ALICE, DEFAULT_USER_SETTINGS);
    r.store.admit(ALICE, "queue", new Date(Date.now() - 1000));
    const ks = run(r);
    assert.equal(r.store.connection(ALICE), null);
    assert.equal(hasKey(ks, ALICE), false);
  } finally { r.done(); }
});

// The allowlist is an operator's decision on the box and outranks the queue, which is
// the same precedence `resolveMode` gives it.
test("an address named in HL_LIVE_ACCOUNT needs no admission", () => {
  const r = rig();
  try {
    r.web.requestConnection(ALICE, DEFAULT_USER_SETTINGS);
    const ks = serviceConnectRequests({
      store: r.store, keystore: EMPTY_KEYSTORE, passphrase: PASS,
      keystoreFile: r.keystoreFile, requestsDb: r.requestsDb, log: () => {},
      env: { HL_LIVE_ACCOUNT: ALICE.toUpperCase() },
    });
    assert.equal(r.store.connection(ALICE)?.status, "awaiting_approval");
    assert.equal(hasKey(ks, ALICE), true);
  } finally { r.done(); }
});
