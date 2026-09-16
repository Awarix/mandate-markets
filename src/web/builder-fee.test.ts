import assert from "node:assert/strict";
import { test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { BUILDER_FEE } from "../risk/params.ts";
import {
  _resetPending, currentFee, feeRequiredFor, PLAN_TTL_MS, prepareApproval, relayApproval,
  type FeeDeps,
} from "./builder-fee.ts";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");
const BUILDER = "0xdd03fe71e3131d85c295d1fddf108a04de07932f";
const ARBITRUM = 42161;

const ON = { HL_BUILDER_ADDRESS: BUILDER } as NodeJS.ProcessEnv;
const OFF = {} as NodeJS.ProcessEnv;

type Sent = { action: Record<string, unknown>; nonce: number; signature: unknown };

function deps(over: {
  env?: NodeJS.ProcessEnv; approved?: number; now?: () => number; reply?: unknown;
  sent?: Sent[]; readThrows?: boolean;
} = {}): FeeDeps {
  const sent = over.sent ?? [];
  return {
    env: over.env ?? ON,
    info: {
      maxBuilderFee: async () => {
        if (over.readThrows) throw new Error("venue unreachable");
        return over.approved ?? 0;
      },
    },
    testnet: false,
    now: over.now ?? (() => 1_757_400_000_000),
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
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    message: td.message,
  } as never);
}

// ── What the screen is told ─────────────────────────────────────────────────

test("with the rail off nobody is asked for anything", async () => {
  assert.deepEqual(await currentFee(deps({ env: OFF }), OWNER.address), { state: "off" });
  // Even for an account that approved a ceiling on some other builder's code.
  assert.deepEqual(await currentFee(deps({ env: OFF, approved: 100 }), OWNER.address), { state: "off" });
});

test("an account that has approved nothing is reported unapproved, not charging", async () => {
  assert.deepEqual(await currentFee(deps({ approved: 0 }), OWNER.address), {
    state: "unapproved", tenthsBp: BUILDER_FEE.tenthsBp, percent: "0.006%",
  });
});

test("an unreadable venue reads as unapproved, never as charging", async () => {
  // Telling somebody they are not being charged when they are is the one direction
  // this must never be wrong in.
  const fee = await currentFee(deps({ readThrows: true }), OWNER.address);
  assert.equal(fee.state, "unapproved");
});

test("an approved account is reported charging, at our rate", async () => {
  assert.deepEqual(await currentFee(deps({ approved: BUILDER_FEE.tenthsBp }), OWNER.address), {
    state: "charging", tenthsBp: BUILDER_FEE.tenthsBp, percent: "0.006%",
    approvedMaxTenthsBp: BUILDER_FEE.tenthsBp,
  });
});

// ── Preparing the signature ─────────────────────────────────────────────────

test("the prepared action decodes to exactly what the screen shows", async (t) => {
  t.after(_resetPending);
  const out = prepareApproval(deps(), OWNER.address, ARBITRUM);
  assert.ok(out.ok);
  assert.equal(out.prepared.builder, BUILDER);
  assert.equal(out.prepared.percent, "0.006%");
  assert.equal(out.prepared.tenthsBp, 6);
  // The decode on screen and the bytes in the wallet have to be the same values, or
  // the whole argument for signing here rather than on Hyperliquid's domain collapses.
  assert.equal(out.prepared.typedData.message.maxFeeRate, out.prepared.percent);
  assert.equal(out.prepared.typedData.message.builder, out.prepared.builder);
  assert.equal(out.prepared.typedData.domain.chainId, ARBITRUM, "the wallet's own chain");
});

test("with no rail there is nothing to agree to, and that is not an error the user made", (t) => {
  t.after(_resetPending);
  const out = prepareApproval(deps({ env: OFF }), OWNER.address, ARBITRUM);
  assert.ok(!out.ok);
  assert.equal(out.status, 409);
  assert.match(out.error, /charges nothing/);
});

test("a wallet that reports no chain is refused before anything is built", (t) => {
  t.after(_resetPending);
  const out = prepareApproval(deps(), OWNER.address, 0);
  assert.ok(!out.ok);
  assert.equal(out.status, 400);
});

// ── Relaying it ─────────────────────────────────────────────────────────────

test("the owner's own signature is relayed, and it carries our rate", async (t) => {
  t.after(_resetPending);
  const sent: Sent[] = [];
  const d = deps({ sent });
  const prep = prepareApproval(d, OWNER.address, ARBITRUM);
  assert.ok(prep.ok);

  const out = await relayApproval(d, OWNER.address, await sign(OWNER, prep.prepared.typedData));
  assert.ok(out.ok);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.action.type, "approveBuilderFee");
  assert.equal(sent[0]!.action.maxFeeRate, "0.006%");
  assert.equal(sent[0]!.action.builder, BUILDER);
  // The envelope repeats the action's own nonce, as every user-signed action does.
  assert.equal(sent[0]!.nonce, sent[0]!.action.nonce);
});

test("a stranger's signature is refused — this one authorises a payment", async (t) => {
  t.after(_resetPending);
  const sent: Sent[] = [];
  const d = deps({ sent });
  const prep = prepareApproval(d, OWNER.address, ARBITRUM);
  assert.ok(prep.ok);

  const out = await relayApproval(d, OWNER.address, await sign(STRANGER, prep.prepared.typedData));
  assert.ok(!out.ok);
  assert.equal(out.status, 403);
  assert.equal(sent.length, 0, "nothing reaches the venue");
});

test("relaying without a prepared plan is refused", async (t) => {
  t.after(_resetPending);
  const out = await relayApproval(deps(), OWNER.address, "0x" + "11".repeat(65));
  assert.ok(!out.ok);
  assert.equal(out.status, 409);
});

test("a plan expires, because its nonce does", async (t) => {
  t.after(_resetPending);
  let clock = 1_757_400_000_000;
  const d = deps({ now: () => clock });
  const prep = prepareApproval(d, OWNER.address, ARBITRUM);
  assert.ok(prep.ok);
  const signature = await sign(OWNER, prep.prepared.typedData);

  clock += PLAN_TTL_MS + 1;
  const out = await relayApproval(d, OWNER.address, signature);
  assert.ok(!out.ok);
  assert.equal(out.status, 409);
});

test("a refusal that arrives as HTTP 200 is not reported as approved", async (t) => {
  t.after(_resetPending);
  // The failure `notes/2026-09-02-agent-approval-verification.md` caught on the agent
  // approval: Hyperliquid answers a refusal with a 200 and the error in the body. Here
  // it would tell somebody they had agreed to a fee the venue never recorded.
  const d = deps({ reply: { status: "err", response: "Builder fee too low" } });
  const prep = prepareApproval(d, OWNER.address, ARBITRUM);
  assert.ok(prep.ok);

  const out = await relayApproval(d, OWNER.address, await sign(OWNER, prep.prepared.typedData));
  assert.ok(!out.ok);
  assert.equal(out.status, 502);
  assert.match(out.error, /Builder fee too low/);
});

test("a mangled signature is refused before it reaches the venue", async (t) => {
  t.after(_resetPending);
  const sent: Sent[] = [];
  const d = deps({ sent });
  assert.ok(prepareApproval(d, OWNER.address, ARBITRUM).ok);

  const out = await relayApproval(d, OWNER.address, "0xdeadbeef");
  assert.ok(!out.ok);
  assert.equal(out.status, 400);
  assert.equal(sent.length, 0);
});

// ── Who is asked, and when ──────────────────────────────────────────────────
//
// The case that matters is the one the ledger cannot answer: an address that has never
// connected. Reading it literally — no row, no cohort, not required — is what let the
// connect flow mint a key and approve an agent for an account the executor then refused
// over a fee nobody had been asked for.

test("an address with no connection row is asked what its row would say", () => {
  const rail = { b: "0xd74220ce7a2b4d1a722f81fd670733ecd44a4ff5", f: 6 } as const;
  const cutoffPassed = new Date(Date.parse(BUILDER_FEE.requiredForConnectionsFrom) + 1000);
  const before = new Date(Date.parse(BUILDER_FEE.requiredForConnectionsFrom) - 1000);

  assert.equal(feeRequiredFor(rail, null, cutoffPassed), true,
    "a first-timer connecting now is in the new cohort and must be asked before the key");
  assert.equal(feeRequiredFor(rail, undefined, before), false,
    "and before the cutoff they are not, which is what grandfathering means");
});

test("an address that has a row is answered by the row, never by the clock", () => {
  const rail = { b: "0xd74220ce7a2b4d1a722f81fd670733ecd44a4ff5", f: 6 } as const;
  const later = new Date("2027-01-01T00:00:00.000Z");
  // The two accounts that connected on 2026-09-10 before the cutoff moved. However long
  // ago that was, they stay grandfathered.
  assert.equal(feeRequiredFor(rail, "2026-09-10T08:23:46.337Z", later), false);
  assert.equal(feeRequiredFor(rail, "2026-09-10T10:46:22.615Z", later), false);
  assert.equal(feeRequiredFor(rail, "2026-09-11T00:00:00.000Z", later), true);
});

test("with no rail nobody is asked, whatever the clock says", () => {
  assert.equal(feeRequiredFor(undefined, null, new Date("2030-01-01T00:00:00.000Z")), false);
});
