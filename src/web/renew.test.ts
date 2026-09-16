import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { ZERO_ADDRESS } from "../hl/approve-agent.ts";
import { _resetPending, PLAN_TTL_MS, prepareRenewal, relayStep, type AgentEntry, type RenewDeps } from "./renew.ts";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const AGENT = "0xba440c973635bf27923e5e2cd17305d5c88f8fe7";
const ARBITRUM = 42161;

const REGISTERED: AgentEntry[] = [{ name: "mandate-web", address: AGENT, validUntil: 1 }];

type Sent = { action: Record<string, unknown>; nonce: number; signature: unknown };

function deps(over: { agents?: AgentEntry[]; now?: () => number; reply?: unknown; sent?: Sent[] } = {}): RenewDeps {
  const sent = over.sent ?? [];
  return {
    info: { extraAgents: async () => over.agents ?? REGISTERED },
    testnet: false,
    now: over.now ?? (() => 1_756_821_294_139),
    fetchImpl: (async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body) as Sent);
      return new Response(JSON.stringify(over.reply ?? { status: "ok", response: { type: "default" } }));
    }) as unknown as typeof fetch,
  };
}

async function sign(account: typeof OWNER, td: { domain: unknown; types: Record<string, unknown>; message: unknown }) {
  const { EIP712Domain: _drop, ...types } = td.types;
  return await account.signTypedData({
    domain: td.domain,
    types,
    primaryType: "HyperliquidTransaction:ApproveAgent",
    message: td.message,
  } as never);
}

test("an account with a registered agent renews in two steps, remove first", async (t) => {
  t.after(_resetPending);
  const out = await prepareRenewal(deps(), OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  assert.deepEqual(out.prepared.steps.map((s) => s.step), ["remove", "approve"]);
  assert.equal(out.prepared.replacingExisting, true);
  assert.equal(out.prepared.agentName, "mandate-web", "the registered name, because removal is keyed by it");
  assert.equal(out.prepared.steps[0]!.typedData.message.agentAddress, ZERO_ADDRESS);
  assert.equal(out.prepared.steps[1]!.typedData.message.agentAddress, AGENT);
  assert.equal(out.prepared.steps[0]!.typedData.domain.chainId, ARBITRUM, "the wallet's own chain");
});

// After Hyperliquid finally prunes a lapsed entry there is nothing to remove, and
// asking for a signature that deletes nothing would be one wallet popup of pure noise.
test("with nothing registered it is a single approval", async (t) => {
  t.after(_resetPending);
  const out = await prepareRenewal(deps({ agents: [] }), OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  assert.deepEqual(out.prepared.steps.map((s) => s.step), ["approve"]);
  assert.equal(out.prepared.replacingExisting, false);
  assert.equal(out.prepared.agentName, "mandate-web", "our own name, since none is registered to reuse");
});

// The whole reason the page sends a step name and not an action: we relay bytes we
// issued, from our own memory, so there is no submitted action to be talked into.
test("what is relayed is the action we issued, not anything the caller sent", async (t) => {
  t.after(_resetPending);
  const sent: Sent[] = [];
  const d = deps({ sent });
  const out = await prepareRenewal(d, OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);

  const removeSig = await sign(OWNER, out.prepared.steps[0]!.typedData);
  assert.deepEqual(await relayStep(d, OWNER.address, "remove", removeSig), { ok: true, done: false });

  const approveSig = await sign(OWNER, out.prepared.steps[1]!.typedData);
  assert.deepEqual(await relayStep(d, OWNER.address, "approve", approveSig), { ok: true, done: true });

  assert.equal(sent.length, 2);
  assert.equal(sent[0]!.action.agentAddress, ZERO_ADDRESS);
  assert.equal(sent[0]!.action.agentName, "mandate-web");
  assert.equal(sent[1]!.action.agentAddress, AGENT);
  assert.match(String(sent[1]!.action.agentName), /^mandate-web valid_until \d+$/);
  assert.equal(sent[1]!.nonce, sent[1]!.action.nonce, "the envelope nonce mirrors the action's");
});

// Without this we are a free relay for anybody's signed approveAgent.
test("a signature from another wallet is refused", async (t) => {
  t.after(_resetPending);
  const d = deps();
  const out = await prepareRenewal(d, OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  const sig = await sign(STRANGER, out.prepared.steps[0]!.typedData);
  const r = await relayStep(d, OWNER.address, "remove", sig);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 403);
});

test("a signature over different data than we issued is refused", async (t) => {
  t.after(_resetPending);
  const d = deps();
  const out = await prepareRenewal(d, OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  const td = out.prepared.steps[0]!.typedData;
  const tampered = { ...td, message: { ...td.message, agentAddress: STRANGER.address } };
  const r = await relayStep(d, OWNER.address, "remove", await sign(OWNER, tampered));
  assert.equal(r.ok, false, "recovery lands on some other address, so it cannot be the session's");
});

// Approving before the removal is exactly what Hyperliquid refuses. Catching it here
// means the account's owner is not asked for a signature that was always going to fail.
test("the steps must be signed in order", async (t) => {
  t.after(_resetPending);
  const d = deps();
  const out = await prepareRenewal(d, OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  const r = await relayStep(d, OWNER.address, "approve", await sign(OWNER, out.prepared.steps[1]!.typedData));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, "Sign the remove step first.");
});

// "Extra agent already used." arrived as HTTP 200. If that reads as success the step is
// marked done, the second signature never happens, and the account stays lapsed while
// the screen says it was renewed.
test("a refusal that arrives as HTTP 200 does not mark the step done", async (t) => {
  t.after(_resetPending);
  const d = deps({ reply: { status: "err", response: "Extra agent already used." } });
  const out = await prepareRenewal(d, OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  const sig = await sign(OWNER, out.prepared.steps[0]!.typedData);
  const r = await relayStep(d, OWNER.address, "remove", sig);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, "Extra agent already used.");
  // Still the outstanding step, so retrying resumes rather than skipping it.
  const again = await relayStep(d, OWNER.address, "approve", sig);
  assert.equal(again.ok === false && again.error, "Sign the remove step first.");
});

test("a plan expires, because its nonces do", async (t) => {
  t.after(_resetPending);
  let clock = 1_756_821_294_139;
  const d = deps({ now: () => clock });
  const out = await prepareRenewal(d, OWNER.address, AGENT, ARBITRUM);
  assert.ok(out.ok);
  clock += PLAN_TTL_MS + 1;
  const r = await relayStep(d, OWNER.address, "remove", await sign(OWNER, out.prepared.steps[0]!.typedData));
  assert.equal(r.ok, false);
  assert.match(r.ok === false ? r.error : "", /expired/);
});

test("an account with no agent key has nothing to renew", async (t) => {
  t.after(_resetPending);
  const out = await prepareRenewal(deps(), OWNER.address, null, ARBITRUM);
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.status, 409);
});

test("a wallet that reports no chain is refused before anything is built", async (t) => {
  t.after(_resetPending);
  const out = await prepareRenewal(deps(), OWNER.address, AGENT, 0);
  assert.equal(out.ok, false);
  assert.equal(out.ok === false && out.status, 400);
});

test("relaying without a prepared plan is refused", async (t) => {
  t.after(_resetPending);
  const r = await relayStep(deps(), OWNER.address, "remove", `0x${"11".repeat(65)}`);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.status, 409);
});
