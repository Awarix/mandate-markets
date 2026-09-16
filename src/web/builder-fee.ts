// Approving the builder fee, in this page, with the same rule that makes the agent
// approval safe to do here: **the page returns only a signature.**
//
// `src/web/renew.ts` is the template and the security argument is identical — we build
// the action and keep it in this process, the browser is handed typed data to sign and
// nothing else, and the signature is checked to recover to the session's own address
// before we relay bytes *we* issued. There is no action of somebody else's choosing for
// us to put on the exchange, because the page has no way to give us one.
//
// What is different:
//
//  - **It was optional permanently, and since `tasks/33` it is not.** This header said
//    "An account that never signs keeps trading; nothing here is a gate" and that was
//    the property which made the screen safe to build. The owner reversed it on
//    2026-09-10: the fee is **required for accounts that connect from
//    `BUILDER_FEE.requiredForConnectionsFrom`**, and optional forever for everyone who
//    connected before it. `feeIsRequired` is the line and it is one function.
//    Two things did *not* change with it, and they are the ones that keep this
//    defensible: the mechanism still **fails closed** — an account we cannot read, or
//    that has revoked, gets an order with no builder field, which fills — and no
//    stranger's account can start paying because we deployed something, since only
//    their own signature creates the approval.
//    ⚠ For a required account the refusal is the **executor's**, not this file's: it
//    declines to arm and the connect screen reports it beside every other refusal. A
//    gate that lived only in the markup would be the exit-policy control's mistake
//    (`src/web/connect.ts`), because a POST does not read markup.
//  - **What is being agreed is a price**, so the number has to be on screen in the
//    units a person uses — a percentage and what it costs per year at this desk's
//    turnover — not in tenths of a basis point, which is the unit the venue wants and
//    nobody thinks in.
//  - **The ceiling and the rate are one number** (`BUILDER_FEE`), so this signature
//    authorises exactly today's rate and no more. Raising the rate asks everybody
//    again. That is the property being protected, and it is why nothing here takes a
//    rate as a parameter.

import { recoverTypedDataAddress } from "viem";
import { fromSignatureChainId, splitSignature, toSignatureChainId, ZERO_ADDRESS, type TypedData } from "../hl/approve-agent.ts";
import {
  APPROVE_BUILDER_FEE_TYPES, buildApproval, builderRail, feeIsRequired, feeStatus,
  relayApproveBuilderFee, typedDataFor, type ApproveBuilderFeeAction, type FeeStatus,
} from "../hl/approve-builder-fee.ts";

/** Same window as a renewal, and for the same reason: the nonce minted here has to
 *  still be fresh when it reaches Hyperliquid. */
export const PLAN_TTL_MS = 10 * 60_000;

export type PreparedApproval = {
  typedData: TypedData;
  /** Decoded for the screen — the whole mitigation for signing here rather than on
   *  Hyperliquid's own domain. These are the same values the typed data carries. */
  builder: string;
  percent: string;
  tenthsBp: number;
};

type Pending = { action: ApproveBuilderFeeAction; issuedAt: number };

/** One approval in flight per account. Pressing the button again reissues, which is
 *  also how a stale plan is discarded. */
const pending = new Map<string, Pending>();

export type FeeDeps = {
  /** Only `maxBuilderFee` is used; typed loosely so the web tier's `Ctx` fits. */
  info: { maxBuilderFee(args: { user: string; builder: string }): Promise<number> };
  testnet: boolean;
  now: () => number;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

/** What this account is charged right now, read from the venue.
 *
 *  The desk gets this from the executor's heartbeat instead — one answer, from the
 *  process that actually attaches the code. This route exists because the *signing*
 *  screen needs the answer the instant the signature lands, which is up to a loop
 *  before the heartbeat would carry it. */
export async function currentFee(deps: FeeDeps, address: string): Promise<FeeStatus> {
  const rail = builderRail(deps.env);
  if (!rail) return { state: "off" };
  try {
    return feeStatus(rail, await deps.info.maxBuilderFee({ user: address, builder: rail.b }));
  } catch {
    // Unreadable reads as unapproved, never as charging. Telling someone they are not
    // being charged when they are is the one direction this must never be wrong in.
    return feeStatus(rail, null);
  }
}

/** Is the account at this address in the cohort that must approve before it arms?
 *
 *  One line, but it is the line that decides whether somebody is asked to pay, and it
 *  has a case the ledger cannot answer: **an address with no connection row yet.** That
 *  is a first-timer, and reading it literally — no row, no cohort, not required — is
 *  what let the connect flow mint a key and approve an agent before the executor
 *  refused the account for a fee nobody had been asked for. `tasks/33` §2's argument for
 *  gating on a wallet prompt at all is that declining costs nothing because nothing has
 *  happened yet; a refusal that arrives after the key does not have that property.
 *
 *  So an address with no row is asked what its row *would* say: would a connection
 *  created right now be required? Every address that has one is unaffected, which is the
 *  whole of the grandfathering claim. */
export function feeRequiredFor(
  rail: Parameters<typeof feeIsRequired>[0],
  connectionCreatedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  return feeIsRequired(rail, connectionCreatedAt ?? now.toISOString());
}

export type PrepareOutcome =
  | { ok: true; prepared: PreparedApproval }
  | { ok: false; status: number; error: string };

export function prepareApproval(deps: FeeDeps, address: string, chainId: number): PrepareOutcome {
  const rail = builderRail(deps.env);
  if (!rail) {
    // Not an error the visitor caused or can fix. We are not charging anything, so
    // there is nothing to agree to.
    return { ok: false, status: 409, error: "There is no fee to approve — this desk charges nothing right now." };
  }
  if (!Number.isInteger(chainId) || chainId <= 0) {
    return { ok: false, status: 400, error: "Your wallet did not report which chain it is on." };
  }

  const now = deps.now();
  let action: ApproveBuilderFeeAction;
  try {
    action = buildApproval({
      builder: rail.b,
      signatureChainId: toSignatureChainId(chainId),
      chain: deps.testnet ? "Testnet" : "Mainnet",
      nonce: now,
    });
  } catch (e) {
    // A rate or an address we cannot build an action for is ours to fix.
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }

  pending.set(address.toLowerCase(), { action, issuedAt: now });
  return {
    ok: true,
    prepared: {
      typedData: typedDataFor(action),
      builder: rail.b,
      percent: action.maxFeeRate,
      tenthsBp: rail.f,
    },
  };
}

export type RelayOutcome = { ok: true } | { ok: false; status: number; error: string };

export async function relayApproval(deps: FeeDeps, address: string, signature: string): Promise<RelayOutcome> {
  const key = address.toLowerCase();
  const p = pending.get(key);
  if (!p) return { ok: false, status: 409, error: "That approval has expired. Start it again." };
  if (deps.now() - p.issuedAt > PLAN_TTL_MS) {
    pending.delete(key);
    return { ok: false, status: 409, error: "That approval took too long and has expired. Start it again." };
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
        chainId: fromSignatureChainId(p.action.signatureChainId),
        verifyingContract: ZERO_ADDRESS as `0x${string}`,
      },
      // viem derives `EIP712Domain` from the domain itself, so only the action's own
      // struct is declared. The four fields and their order must match
      // `APPROVE_BUILDER_FEE_TYPES` exactly — and that order is **not** ApproveAgent's —
      // or every signature recovers to a stranger.
      types: { "HyperliquidTransaction:ApproveBuilderFee": [...APPROVE_BUILDER_FEE_TYPES["HyperliquidTransaction:ApproveBuilderFee"]] },
      primaryType: "HyperliquidTransaction:ApproveBuilderFee",
      message: {
        hyperliquidChain: p.action.hyperliquidChain,
        maxFeeRate: p.action.maxFeeRate,
        builder: p.action.builder as `0x${string}`,
        nonce: BigInt(p.action.nonce),
      },
      signature: signature as `0x${string}`,
    });
  } catch {
    return { ok: false, status: 400, error: "That signature does not match what we asked you to sign." };
  }

  // The one check that matters: the signature is this session's own account's. Without
  // it we would be a free relay for anybody's signed approveBuilderFee — and this one
  // authorises a payment, which the agent approval does not.
  if (signer.toLowerCase() !== key) {
    return { ok: false, status: 403, error: "That signature came from a different wallet than the one signed in here." };
  }

  const res = await relayApproveBuilderFee(p.action, parts, { testnet: deps.testnet, fetchImpl: deps.fetchImpl });
  if (!res.ok) return { ok: false, status: 502, error: res.error };

  pending.delete(key);
  return { ok: true };
}

/** Test seam. The map is module state because the plan must outlive one request. */
export function _resetPending(): void { pending.clear(); }
