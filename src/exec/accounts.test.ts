import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EMPTY_KEYSTORE, putKey } from "../keys/keystore.ts";
import { LiveBroker } from "../hl/broker.ts";
import { agentAddress } from "../hl/clients.ts";
import { Store } from "../store/db.ts";
import { connectAccount, isPending, listAccounts, refreshFee, resolveAgentKey, type ManagedAccount } from "./accounts.ts";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PASS = "pass";
const A = "0xacc00001c53162712f3d8d10764b5e7b17d1c08a";
const B = "0x1111111111111111111111111111111111111111";
const empty = () => ({ ...EMPTY_KEYSTORE, entries: {} });

function withAccountsDir(files: string[], fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-accts-"));
  try {
    for (const f of files) writeFileSync(join(dir, f), "{}");
    fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// The live Phase 2 deploy runs on HL_MASTER_ADDRESS. A refactor that silently widened
// a funded process from one account to several would be exactly the wrong kind of
// side effect, so the pin still wins.
test("HL_MASTER_ADDRESS pins the process to one account, whatever is on disk", () => {
  withAccountsDir([`${A}.json`, `${B}.json`], (dir) => {
    assert.deepEqual(listAccounts({ HL_MASTER_ADDRESS: B } as NodeJS.ProcessEnv, dir), [B]);
  });
});

test("with no pin, every accounts/<address>.json is managed", () => {
  withAccountsDir([`${A}.json`, `${B}.json`, "README.md", "notes.json"], (dir) => {
    assert.deepEqual(listAccounts({} as NodeJS.ProcessEnv, dir), [B, A].sort());
  });
});

test("a missing accounts dir is empty, not a crash", () => {
  assert.deepEqual(listAccounts({} as NodeJS.ProcessEnv, join(tmpdir(), "signaldesk-no-such-dir")), []);
});

test("the keystore is preferred over the .env key", () => {
  const ks = putKey(empty(), A, KEY, PASS);
  const r = resolveAgentKey(A, ks, PASS, { HL_MASTER_ADDRESS: A, HL_AGENT_PRIVATE_KEY: "0xdead" } as NodeJS.ProcessEnv);
  assert.equal(r.key, KEY);
  assert.equal(r.source, "keystore");
});

test("the .env key still works, but only for the account it names", () => {
  const env = { HL_MASTER_ADDRESS: A, HL_AGENT_PRIVATE_KEY: KEY } as NodeJS.ProcessEnv;
  assert.equal(resolveAgentKey(A, empty(), null, env).key, KEY);
  assert.throws(() => resolveAgentKey(B, empty(), null, env), /no agent key for/);
});

// One key per account is a correctness requirement, not a preference: HL tracks
// nonces per signer, so a shared key drops orders.
test("an account with no key of its own is refused, and the message says how to fix it", () => {
  assert.throws(
    () => resolveAgentKey(B, empty(), null, {} as NodeJS.ProcessEnv),
    /npm run keys -- add 0x1111/,
  );
});

test("a keystore entry with no passphrase available is a clear refusal", () => {
  const ks = putKey(empty(), A, KEY, PASS);
  assert.throws(() => resolveAgentKey(A, ks, null, {} as NodeJS.ProcessEnv), /no passphrase is available/);
});

// ── The builder fee, re-read (`tasks/14`) ───────────────────────────────────
//
// The direction that matters is **revocation**. Hyperliquid lets an owner revoke at
// any time; a code we keep attaching after they do is rejected on every order, which
// is the account not trading. Frozen at connect, nothing would ever notice.

const BUILDER = "0xdd03fe71e3131d85c295d1fddf108a04de07932f";
const RAIL_ON = { HL_BUILDER_ADDRESS: BUILDER } as NodeJS.ProcessEnv;

/** Only the fields `refreshFee` touches. The broker is a real `LiveBroker` because
 *  what is being tested is that the display and the orders move together. */
function managed(over: Partial<ManagedAccount> = {}): ManagedAccount {
  const broker = new LiveBroker(
    {} as never, {} as never, A as `0x${string}`, {} as never, { b: BUILDER, f: 6 },
  );
  return {
    master: A as `0x${string}`, mode: "live", why: "", settings: {} as never, settingsSource: "",
    baseCapital: 100, broker, keySource: "", agent: null, incumbent: false,
    fee: { state: "charging", tenthsBp: 6, percent: "0.006%", approvedMaxTenthsBp: 6 },
    ...over,
  };
}

const info = (fn: () => Promise<number>) => ({ maxBuilderFee: fn }) as never;

test("a revoked approval stops the fee, on the desk and on the orders", async () => {
  const a = managed();
  await refreshFee(a, info(async () => 0), RAIL_ON);
  assert.equal(a.fee.state, "unapproved");
  // The order path is what would otherwise be rejected by the venue on every entry.
  assert.equal((a.broker as unknown as { builder?: unknown }).builder, undefined);
});

test("an approval lowered below our rate stops it too", async () => {
  const a = managed();
  await refreshFee(a, info(async () => 5), RAIL_ON);
  assert.equal(a.fee.state, "unapproved");
  assert.equal((a.broker as unknown as { builder?: unknown }).builder, undefined);
});

test("a fresh approval starts it without waiting for a restart", async () => {
  const a = managed({ fee: { state: "unapproved", tenthsBp: 6, percent: "0.006%" } });
  (a.broker as LiveBroker).setBuilder(undefined);
  await refreshFee(a, info(async () => 6), RAIL_ON);
  assert.equal(a.fee.state, "charging");
  assert.deepEqual((a.broker as unknown as { builder?: unknown }).builder, { b: BUILDER, f: 6 });
});

test("a read that fails changes nothing, in either direction", async () => {
  // A network error is not evidence that somebody's terms changed. Being an hour late
  // is much cheaper than flipping a fee on or off on a timeout.
  const a = managed();
  await refreshFee(a, info(async () => { throw new Error("unreachable"); }), RAIL_ON);
  assert.equal(a.fee.state, "charging");
  assert.deepEqual((a.broker as unknown as { builder?: unknown }).builder, { b: BUILDER, f: 6 });
});

test("with the rail off there is no round trip at all", async () => {
  let calls = 0;
  const a = managed({ fee: { state: "off" } });
  await refreshFee(a, info(async () => { calls++; return 100; }), {} as NodeJS.ProcessEnv);
  assert.equal(calls, 0, "an unset HL_BUILDER_ADDRESS must not cost an info call per account per hour");
  assert.deepEqual(a.fee, { state: "off" });
});

test("a paper account is never charged and never asked about", async () => {
  let calls = 0;
  const a = managed({ mode: "paper", fee: { state: "off" } });
  await refreshFee(a, info(async () => { calls++; return 100; }), RAIL_ON);
  assert.equal(calls, 0);
  assert.deepEqual(a.fee, { state: "off" });
});

// ── The fee gate (`tasks/33`) ───────────────────────────────────────────────
//
// The owner made the fee required on 2026-09-10, **for new users only**. The refusal
// is here rather than in the web tier because this is the process that signs orders: a
// connect screen can ask for a signature, but only a refusal to arm requires one, and
// "a POST does not read markup".
//
// Driven through the real `connectAccount` rather than through `feeIsRequired` alone,
// because what is being tested is the composition — that a required-and-unapproved
// account comes back **pending**, and specifically not paper. Paper would tell somebody
// they are connected when they are not, freeze a `baseCapital` that is not theirs, and
// then block the live connection they wanted; it is the failure `resolveMode`'s
// `blocked` flag exists to prevent, arriving by a different route.

const BUILDER_ENV = {
  DRY_RUN: "false",
  LIVE_SELF_SERVICE: "true",
  HL_BUILDER_ADDRESS: BUILDER,
} as NodeJS.ProcessEnv;

/** Enough of `InfoClient` for one connect, with the builder approval as the variable.
 *
 *  `userAbstraction` answers `default` first and `unifiedAccount` afterwards, which is
 *  the real sequence: an account funded through any rail arrives plain, and
 *  `ensureTradeable` sets the mode and reads it back before anything is frozen. */
function connectInfo(approvedMax: number, calls: { setAbstraction: number }) {
  return {
    maxBuilderFee: async () => approvedMax,
    clearinghouseState: async () => ({ marginSummary: { accountValue: "500" }, assetPositions: [] }),
    spotClearinghouseState: async () => ({ balances: [] }),
    userAbstraction: async () => (calls.setAbstraction > 0 ? "unifiedAccount" : "default"),
    activeAssetData: async () => ({ availableToTrade: ["500", "500"], maxTradeSzs: ["1", "1"] }),
    extraAgents: async () => [{ name: "mandate-web", address: agentAddress(KEY), validUntil: Date.now() + 180 * 86_400_000 }],
    frontendOpenOrders: async () => [],
    allMids: async () => ({}),
  } as never;
}

function connectDeps(store: Store, approvedMax: number, env: NodeJS.ProcessEnv) {
  const calls = { setAbstraction: 0 };
  const info = connectInfo(approvedMax, calls);
  return {
    info,
    universe: { probes: () => [{ dex: "", coin: "BTC" }, { dex: "xyz", coin: "xyz:XYZ100" }] } as never,
    store,
    marks: () => new Map<string, number>(),
    log: () => {},
    keystore: putKey(empty(), A, KEY, PASS),
    passphrase: PASS,
    env,
    liveSlotsUsed: 0,
    exchangeFor: () => ({
      agentSetAbstraction: async () => { calls.setAbstraction++; return { status: "ok" }; },
    }) as never,
    calls,
  };
}

/** A connection row with a chosen `created_at`, which is the whole of the cohort rule. */
function seedConnection(store: Store, createdAt: string): void {
  store.upsertConnection({
    account: A, status: "awaiting_approval", agentAddress: null, settings: {}, at: new Date(createdAt),
  });
}

test("an account that connected after the cutoff does not arm without approving", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2026-09-12T10:00:00.000Z");
    await assert.rejects(
      () => connectAccount(A, connectDeps(store, 0, BUILDER_ENV)),
      (e: unknown) => {
        assert.ok(isPending(e), "pending, never a hard failure — the user is standing on this step");
        assert.match((e as Error).message, /has not approved the desk's fee/);
        return true;
      },
    );
    // Pending means **no ledger row**, so funding or approving later simply works and
    // nothing froze a baseCapital against a connection that never happened.
    assert.equal(store.account(A), null, "a refused account must not be written to the ledger");
  } finally { store.close(); }
});

// ⚠ **A 429 is not a refusal to sign, and reading it as one dropped a live account.**
// 2026-09-11: a cold start ran fifteen connect checks at once, six took `429 Too Many
// Requests`, and `0xacc00008…` logged WAS LIVE AND IS NO LONGER MANAGED with a reason
// that was false — it had approved the fee. For two loops that account had no
// daily-loss halt, no signal-change exit and no foreign-actor detection on an open book.
//
// Failing open costs one run's fee on one account. Failing closed refuses to trade an
// account whose owner did everything right, which is the trade `feeIsRequired` already
// declines to make one layer down.
test("a builder-approval read that throws does not read as a refusal to sign", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2026-09-12T10:00:00.000Z");
    const d = connectDeps(store, 6, BUILDER_ENV);
    (d.info as unknown as { maxBuilderFee: () => Promise<number> }).maxBuilderFee = async () => {
      throw new Error("429 Too Many Requests");
    };
    const m = await connectAccount(A, d);
    assert.equal(m.mode, "live", "the account this happened to had approved the fee and was live");
    assert.equal(m.fee.state, "unapproved", "we still do not know that it approved, so nothing is charged");
    assert.equal((m.broker as unknown as { builder?: unknown }).builder, undefined,
      "failing closed on the charge is unchanged — the order carries no code and fills");
  } finally { store.close(); }
});

// And the gate still binds when the venue actually answers.
test("the same account arms the moment the approval is on the venue", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2026-09-12T10:00:00.000Z");
    const m = await connectAccount(A, connectDeps(store, 6, BUILDER_ENV));
    assert.equal(m.mode, "live");
    assert.equal(m.fee.state, "charging");
    // The acceptance tasks/33 §6 asks for: in force on the **first** tick, not an hour
    // later. It is structural rather than a race — the gate only passes when the state
    // is `charging`, and that is the same condition under which the broker carries the
    // code.
    assert.deepEqual((m.broker as unknown as { builder?: unknown }).builder, { b: BUILDER, f: 6 });
  } finally { store.close(); }
});

test("an account that connected before the cutoff is grandfathered and arms unasked", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2026-08-30T12:00:00.000Z");
    const m = await connectAccount(A, connectDeps(store, 0, BUILDER_ENV));
    assert.equal(m.mode, "live", "the four accounts trading before this shipped must not stop");
    assert.equal(m.fee.state, "unapproved");
    assert.equal((m.broker as unknown as { builder?: unknown }).builder, undefined,
      "and their orders carry no code, exactly as before");
  } finally { store.close(); }
});

// The gap that cost 28 minutes and five rejected orders on 2026-09-10: a `default`
// account holds its dollars where the HIP-3 markets we trade cannot reach them, and
// every check we had said it was healthy. Connecting one must now leave it unified —
// agent-signed, before the ledger freezes anything.
test("a plain account is put into unified margin before it arms", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2026-08-30T12:00:00.000Z");
    const d = connectDeps(store, 0, BUILDER_ENV);
    const m = await connectAccount(A, d);
    assert.equal(d.calls.setAbstraction, 1, "the agent signs it once, with no user interaction");
    assert.equal(m.mode, "live");
  } finally { store.close(); }
});

// An account whose books disagree about what it can spend is the stranded-collateral
// shape, and arming it means placing orders that Hyperliquid rejects one at a time.
// Pending, not paper and not an alert: there is nothing to wake anyone for, and a paper
// row would freeze a baseCapital against an account that never traded.
test("an account whose dexes disagree about its collateral does not arm", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2026-08-30T12:00:00.000Z");
    const d = connectDeps(store, 0, BUILDER_ENV);
    let coin = "";
    d.info = {
      ...(d.info as unknown as Record<string, unknown>),
      userAbstraction: async () => "unifiedAccount",
      // Core carrying the money, xyz at zero — exactly what the rejected account read.
      activeAssetData: async (p: { coin: string }) => {
        coin = p.coin;
        return { availableToTrade: ["0", coin.startsWith("xyz") ? "0" : "500"], maxTradeSzs: ["0", "0"] };
      },
    } as never;
    await assert.rejects(
      () => connectAccount(A, d),
      (e: unknown) => {
        assert.ok(isPending(e), "the owner can fix this; nobody needs waking");
        assert.match((e as Error).message, /does not reach every market we trade/);
        return true;
      },
    );
    assert.equal(store.account(A), null, "and nothing is frozen against it");
  } finally { store.close(); }
});

test("with the rail off nobody is required, whenever they connected", async () => {
  const store = new Store(":memory:", { log: () => {} });
  try {
    seedConnection(store, "2027-06-01T00:00:00.000Z");
    const m = await connectAccount(A, connectDeps(store, 0, { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" } as NodeJS.ProcessEnv));
    assert.equal(m.mode, "live");
    assert.deepEqual(m.fee, { state: "off" });
  } finally { store.close(); }
});
