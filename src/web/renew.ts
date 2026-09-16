// Renewing the agent approval without leaving mandate.markets.
//
// `tasks/13` stage B. The page never talks to Hyperliquid: the CSP is
// `connect-src 'self'` and widening it so a public page can post to an exchange is the
// wrong trade. So the shape is — **we build the action, the wallet signs it, we relay
// it** — and the browser is handed a signature to produce, never an action to send.
//
// The rule that makes that safe: **the page returns only a step name and a signature.**
// It cannot hand us an action, so there is no action of somebody else's choosing for us
// to relay. We check the signature recovers to the session's own address and then relay
// the bytes *we* issued, from our own memory. That is stronger than comparing a
// submitted action against an issued one, and it is stronger because it deletes the
// comparison rather than getting it right.
//
// The evidence behind every constant is in
// `notes/2026-09-02-agent-approval-verification.md`, from a real approval on
// 2026-09-02 — not from documentation, which was wrong about this three times.

import { recoverTypedDataAddress } from "viem";
import {
  buildRenewal, DEFAULT_AGENT_NAME, fromSignatureChainId, relayApproveAgent, splitSignature,
  toSignatureChainId, typedDataFor, ZERO_ADDRESS, type ApproveAgentAction, type TypedData,
} from "../hl/approve-agent.ts";

/** How long an issued plan stays signable. Long enough to read what is on screen and
 *  find the wallet window; short enough that a nonce minted here is still fresh when it
 *  reaches Hyperliquid. */
export const PLAN_TTL_MS = 10 * 60_000;

export type RenewStep = "remove" | "approve";

export type PreparedStep = { step: RenewStep; typedData: TypedData };

export type PreparedRenewal = {
  /** In the order they must be signed. One entry when nothing is registered yet. */
  steps: PreparedStep[];
  /** Everything the screen shows before anybody signs. A person approving trading
   *  rights on our domain instead of Hyperliquid's gets, at minimum, the whole of what
   *  they are agreeing to in plain words. */
  agentAddress: string;
  agentName: string;
  expiresAt: string;
  /** True when an entry is already registered, so the first signature is a removal.
   *  The screen says why there are two: Hyperliquid refuses to re-approve an address it
   *  still holds, and nobody would guess that. */
  replacingExisting: boolean;
};

type Pending = {
  address: string;
  issuedAt: number;
  actions: Map<RenewStep, ApproveAgentAction>;
  done: Set<RenewStep>;
  order: RenewStep[];
};

/** Keyed by the signed-in address. One renewal in flight per account: pressing the
 *  button again simply reissues, which is also how a stale plan is discarded. */
const pending = new Map<string, Pending>();

/** As `extraAgents` returns it. `validUntil` is nullable on the wire — an agent with
 *  no expiry — and nothing here reads it, so it stays nullable rather than being
 *  narrowed by an assertion that would be false. */
export type AgentEntry = { name: string; address: string; validUntil: number | null };

export type RenewDeps = {
  /** Only `extraAgents` is used; typed loosely so the web tier's `Ctx` fits. */
  info: { extraAgents(args: { user: string }): Promise<ReadonlyArray<AgentEntry>> };
  testnet: boolean;
  now: () => number;
  fetchImpl?: typeof fetch;
};

export type PrepareOutcome =
  | { ok: true; prepared: PreparedRenewal }
  | { ok: false; status: number; error: string };

/** Build the actions for this account and remember them.
 *
 *  `chainId` is the chain the wallet is connected to, and it becomes the action's
 *  `signatureChainId` — which is what the domain's `chainId` is derived from.
 *  Hyperliquid's own client does exactly this, so a wallet is never asked to sign typed
 *  data for a chain it is not on, and the "will this wallet refuse a foreign chain id"
 *  question never arises. */
export async function prepareRenewal(
  deps: RenewDeps,
  address: string,
  agentAddress: string | null,
  chainId: number,
): Promise<PrepareOutcome> {
  if (!agentAddress) {
    return {
      ok: false, status: 409,
      error: "This account has no agent key yet, so there is nothing to renew. " +
        "Connect it first and we will create one.",
    };
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { ok: false, status: 400, error: "Your wallet did not report which chain it is on." };
  }

  let agents: ReadonlyArray<AgentEntry>;
  try {
    agents = await deps.info.extraAgents({ user: address });
  } catch {
    return { ok: false, status: 502, error: "We could not read your approvals from Hyperliquid just now." };
  }

  // Matched on the **address**, never the name: the address is what our executor signs
  // with, and a name is a label the account's owner can reuse for anything.
  const existing = agents.find((a) => a.address.toLowerCase() === agentAddress.toLowerCase()) ?? null;

  // The name has to be the registered one, because the removal is keyed by name. When
  // nothing is registered — a first approval, or one Hyperliquid has finally pruned —
  // there is nothing to remove and we choose the name ourselves.
  const bareName = existing ? existing.name : DEFAULT_AGENT_NAME;

  const now = deps.now();
  let plan;
  try {
    plan = buildRenewal({
      agentAddress,
      bareName,
      // Hyperliquid computes this from its own server clock. Ours is the closest thing
      // we have that is not a browser's: this process runs on an NTP-synced box, and a
      // 180-day deadline does not turn on seconds. The clock we are deliberately *not*
      // trusting is the visitor's.
      serverTimeMs: now,
      signatureChainId: toSignatureChainId(chainId),
      chain: deps.testnet ? "Testnet" : "Mainnet",
      removeNonce: now,
      approveNonce: now + 1,
    });
  } catch (e) {
    // A name we cannot build an action for is ours to fix, not the visitor's to solve.
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  const order: RenewStep[] = existing ? ["remove", "approve"] : ["approve"];
  const actions = new Map<RenewStep, ApproveAgentAction>();
  if (existing) actions.set("remove", plan.remove);
  actions.set("approve", plan.approve);

  pending.set(address.toLowerCase(), { address, issuedAt: now, actions, done: new Set(), order });

  return {
    ok: true,
    prepared: {
      steps: order.map((step) => ({ step, typedData: typedDataFor(actions.get(step)!) })),
      agentAddress,
      agentName: bareName,
      expiresAt: new Date(plan.expiresAtMs).toISOString(),
      replacingExisting: existing !== null,
    },
  };
}

export type RelayOutcome =
  | { ok: true; done: boolean }
  | { ok: false; status: number; error: string };

/** Verify one signature and relay the action it signed. */
export async function relayStep(
  deps: RenewDeps,
  address: string,
  step: RenewStep,
  signature: string,
): Promise<RelayOutcome> {
  const key = address.toLowerCase();
  const p = pending.get(key);
  if (!p) return { ok: false, status: 409, error: "That renewal has expired. Start it again." };
  if (deps.now() - p.issuedAt > PLAN_TTL_MS) {
    pending.delete(key);
    return { ok: false, status: 409, error: "That renewal took too long and has expired. Start it again." };
  }

  const action = p.actions.get(step);
  if (!action) return { ok: false, status: 400, error: "That is not a step of this renewal." };
  if (p.done.has(step)) return { ok: false, status: 409, error: "That step is already done." };

  // Order is enforced, not assumed. Approving before the removal is the exact sequence
  // Hyperliquid refuses with "Extra agent already used." — and it would refuse it
  // *after* a signature the account's owner had already given.
  const next = p.order.find((s) => !p.done.has(s));
  if (next !== step) {
    return { ok: false, status: 409, error: `Sign the ${next} step first.` };
  }

  let parts;
  try {
    parts = splitSignature(signature);
  } catch (e) {
    return { ok: false, status: 400, error: e instanceof Error ? e.message : "unreadable signature" };
  }

  let signer: string;
  try {
    signer = await recoverTypedDataAddress({
      domain: {
        name: "HyperliquidSignTransaction",
        version: "1",
        chainId: fromSignatureChainId(action.signatureChainId),
        verifyingContract: ZERO_ADDRESS as `0x${string}`,
      },
      // viem derives `EIP712Domain` from the domain itself, so only the action's own
      // struct is declared here. The four fields and their order must match
      // `APPROVE_AGENT_TYPES` exactly or every signature recovers to a stranger.
      types: {
        "HyperliquidTransaction:ApproveAgent": [
          { name: "hyperliquidChain", type: "string" },
          { name: "agentAddress", type: "address" },
          { name: "agentName", type: "string" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "HyperliquidTransaction:ApproveAgent",
      message: {
        hyperliquidChain: action.hyperliquidChain,
        agentAddress: action.agentAddress as `0x${string}`,
        agentName: action.agentName,
        nonce: BigInt(action.nonce),
      },
      signature: signature as `0x${string}`,
    });
  } catch {
    return { ok: false, status: 400, error: "That signature does not match what we asked you to sign." };
  }

  // The one check that matters: the signature is this session's own account's. Without
  // it we would be a free relay for anybody's signed approveAgent.
  if (signer.toLowerCase() !== key) {
    return {
      ok: false, status: 403,
      error: "That signature came from a different wallet than the one signed in here.",
    };
  }

  const res = await relayApproveAgent(action, parts, { testnet: deps.testnet, fetchImpl: deps.fetchImpl });
  if (!res.ok) return { ok: false, status: 502, error: res.error };

  p.done.add(step);
  const done = p.order.every((s) => p.done.has(s));
  if (done) pending.delete(key);
  return { ok: true, done };
}

/** Test seam. The map is module state because the plan must outlive one request. */
export function _resetPending(): void { pending.clear(); }
