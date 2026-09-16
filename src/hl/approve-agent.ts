// The agent approval, as a payload someone's own wallet signs in our page.
//
// `approveAgent` is a **user-signed** EIP-712 action: the master wallet signs it and
// anyone may relay the result. There is nothing privileged about app.hyperliquid.xyz
// doing it, which is what lets the "open Hyperliquid, paste this address, approve it"
// detour disappear (`tasks/13` stage B).
//
// Everything here was verified against a real approval on 2026-09-02 and against
// Hyperliquid's own frontend bundle, not against documentation —
// `notes/2026-09-02-agent-approval-verification.md` carries the evidence. Three of
// those findings are load-bearing enough to restate:
//
//  1. **Renewal is two actions, not one.** Re-approving an address that is still
//     registered is refused with `Extra agent already used.` — so the entry is removed
//     first, and the *same* address is then approved again. No key is rotated, which
//     matters because the web tier holds no keystore passphrase and could not mint one.
//  2. **`valid_until` in the name is the mechanism**, and Hyperliquid computes the
//     deadline from its **own server time**. We do the same: a browser clock minutes
//     fast would otherwise request an expiry the venue reads differently.
//  3. **`signatureChainId` is a field we choose**, and the domain's `chainId` is
//     derived from it. Hyperliquid's own client sets it to whatever chain the wallet is
//     connected to, so we do too — a wallet is then never asked to sign a foreign
//     chain id, and the "which wallets refuse that" question never arises.

/** Hyperliquid's own sentinel for "this agent is not an address any more". Its frontend
 *  uses it for the unnamed agent's delete path; a named removal is the same action
 *  carrying the entry's name. **This is the one hypothesis here that no capture
 *  confirms** — see the note's "what is still unproven". */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** The bare name's limit. The SDK's validator strips ` valid_until <ms>` before
 *  measuring, so the suffix is free — but the name itself is not. */
export const AGENT_NAME_MAX = 16;

/** What Hyperliquid's own authorize modal fills in when you click MAX. */
export const MAX_VALID_DAYS = 180;

/** The name we put on our own agent when no entry exists yet to take one from. Eleven
 *  characters, against a limit of sixteen. */
export const DEFAULT_AGENT_NAME = "mandate-web";

const DAY_MS = 86_400_000;

export type HyperliquidChain = "Mainnet" | "Testnet";

export type ApproveAgentAction = {
  type: "approveAgent";
  hyperliquidChain: HyperliquidChain;
  signatureChainId: string;
  agentAddress: string;
  agentName: string;
  nonce: number;
};

/** The four signed fields. Order is the EIP-712 encoding order and is not cosmetic. */
export const APPROVE_AGENT_TYPES = {
  "HyperliquidTransaction:ApproveAgent": [
    { name: "hyperliquidChain", type: "string" },
    { name: "agentAddress", type: "address" },
    { name: "agentName", type: "string" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** `eth_signTypedData_v4` requires the domain type to be declared alongside the others;
 *  omitting it is a silent failure in some wallets and a hard one in others. */
export const EIP712_DOMAIN_TYPE = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
] as const;

export type TypedData = {
  domain: { name: string; version: string; chainId: number; verifyingContract: string };
  types: Record<string, ReadonlyArray<{ name: string; type: string }>>;
  primaryType: string;
  message: Record<string, unknown>;
};

/** A chain id as Hyperliquid writes it: lower-case hex, `0x`-prefixed, no padding. */
export function toSignatureChainId(chainId: number): string {
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`chain id must be a positive integer, got ${chainId}`);
  }
  return `0x${chainId.toString(16)}`;
}

/** The inverse. `parseInt` with radix 16 accepts the `0x` prefix, which is what the
 *  vendor SDK relies on (`chainId: parseInt(action.signatureChainId)`). */
export function fromSignatureChainId(signatureChainId: string): number {
  if (!/^0x[0-9a-fA-F]+$/.test(signatureChainId)) {
    throw new Error(`signatureChainId must be 0x-prefixed hex, got ${JSON.stringify(signatureChainId)}`);
  }
  const n = parseInt(signatureChainId, 16);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`unusable signatureChainId ${signatureChainId}`);
  return n;
}

/** The name Hyperliquid stores, with the expiry it consumes.
 *
 *  Hyperliquid strips the suffix: `extraAgents` returns the bare name, which is why an
 *  entry approved this way is still found by its plain name afterwards. */
export function agentNameWithExpiry(bareName: string, expiresAtMs: number): string {
  assertBareName(bareName);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    throw new Error(`expiry must be a positive epoch-ms timestamp, got ${expiresAtMs}`);
  }
  return `${bareName} valid_until ${Math.floor(expiresAtMs)}`;
}

export function assertBareName(bareName: string): void {
  if (bareName.length === 0) {
    throw new Error("an empty agent name means the *unnamed* agent, which is a different slot");
  }
  // Checked before the length, so a caller that passed the *composed* name gets told
  // what is actually wrong rather than being told it is too long.
  if (/ valid_until \d+$/.test(bareName)) {
    throw new Error(`agent name ${JSON.stringify(bareName)} already carries an expiry suffix`);
  }
  if (bareName.length > AGENT_NAME_MAX) {
    throw new Error(
      `agent name ${JSON.stringify(bareName)} is ${bareName.length} characters; ` +
      `Hyperliquid allows ${AGENT_NAME_MAX} before the valid_until suffix`,
    );
  }
}

export function typedDataFor(action: ApproveAgentAction): TypedData {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: fromSignatureChainId(action.signatureChainId),
      verifyingContract: ZERO_ADDRESS,
    },
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...APPROVE_AGENT_TYPES },
    primaryType: "HyperliquidTransaction:ApproveAgent",
    // Only the four declared fields are hashed; `type` and `signatureChainId` ride
    // along in the action and are not part of the struct.
    message: {
      hyperliquidChain: action.hyperliquidChain,
      agentAddress: action.agentAddress,
      agentName: action.agentName,
      nonce: action.nonce,
    },
  };
}

export type RenewalPlan = {
  /** Signed first: drops the existing entry so the address stops being "already used". */
  remove: ApproveAgentAction;
  /** Signed second: the same address again, for the full validity. */
  approve: ApproveAgentAction;
  expiresAtMs: number;
};

/** The two actions a renewal needs, in the order they must be signed.
 *
 *  `serverTimeMs` is Hyperliquid's clock, not ours and not the browser's. The nonces
 *  are separate and must both be fresh; they are passed in rather than taken from a
 *  clock here so this stays a pure function that a test can pin. */
export function buildRenewal(opts: {
  agentAddress: string;
  bareName: string;
  serverTimeMs: number;
  signatureChainId: string;
  chain: HyperliquidChain;
  removeNonce: number;
  approveNonce: number;
  days?: number;
}): RenewalPlan {
  const days = opts.days ?? MAX_VALID_DAYS;
  if (!Number.isFinite(days) || days <= 0 || days > MAX_VALID_DAYS) {
    throw new Error(`validity must be 1..${MAX_VALID_DAYS} days, got ${days}`);
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.agentAddress)) {
    throw new Error(`agent address ${JSON.stringify(opts.agentAddress)} is not an address`);
  }
  if (opts.agentAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("refusing to approve the zero address as an agent — that is the removal sentinel");
  }
  if (opts.removeNonce === opts.approveNonce) {
    throw new Error("the two actions need distinct nonces; Hyperliquid replays otherwise");
  }
  assertBareName(opts.bareName);

  const expiresAtMs = opts.serverTimeMs + days * DAY_MS;
  const common = {
    type: "approveAgent",
    hyperliquidChain: opts.chain,
    signatureChainId: opts.signatureChainId,
  } as const;

  return {
    remove: { ...common, agentAddress: ZERO_ADDRESS, agentName: opts.bareName, nonce: opts.removeNonce },
    approve: {
      ...common,
      agentAddress: opts.agentAddress,
      agentName: agentNameWithExpiry(opts.bareName, expiresAtMs),
      nonce: opts.approveNonce,
    },
    expiresAtMs,
  };
}

export type Signature = { r: string; s: string; v: 27 | 28 };

/** A wallet returns 65 bytes; Hyperliquid wants them split.
 *
 *  Some wallets return `v` as 0/1 rather than 27/28. Both are legal encodings of the
 *  same recovery id and Hyperliquid accepts only the latter, so normalise rather than
 *  reject — a wallet that does this is not malfunctioning. */
export function splitSignature(sig: string): Signature {
  if (!/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error(`expected a 65-byte 0x signature, got ${sig.length} characters`);
  }
  const r = `0x${sig.slice(2, 66)}`;
  const s = `0x${sig.slice(66, 130)}`;
  const raw = parseInt(sig.slice(130, 132), 16);
  const v = raw === 0 || raw === 27 ? 27 : raw === 1 || raw === 28 ? 28 : null;
  if (v === null) throw new Error(`signature recovery byte ${raw} is neither 0/1 nor 27/28`);
  return { r, s, v };
}

export function exchangeUrl(testnet: boolean): string {
  return testnet ? "https://api.hyperliquid-testnet.xyz/exchange" : "https://api.hyperliquid.xyz/exchange";
}

export type RelayResult = { ok: true } | { ok: false; error: string };

/** Relay one signed action to Hyperliquid. `approveAgent` is one; `approveBuilderFee`
 *  (`src/hl/approve-builder-fee.ts`) is the other, and the envelope is identical for
 *  every user-signed action — action, split signature, the action's own nonce again.
 *  It is typed on `{ nonce }` alone so a second action needs no second transport.
 *
 *  **A refusal arrives as HTTP 200.** `Extra agent already used.` came back with a 200
 *  and the error in the body, so a relay that trusts the status code reports success
 *  and the account silently stays lapsed. The body is what decides. */
export async function relaySignedAction(
  action: { nonce: number },
  signature: Signature,
  opts: { testnet: boolean; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<RelayResult> {
  const f = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    action,
    signature,
    nonce: action.nonce,
    vaultAddress: null,
    expiresAfter: null,
  });

  let res: Response;
  try {
    res = await f(exchangeUrl(opts.testnet), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    return { ok: false, error: `could not reach Hyperliquid: ${e instanceof Error ? e.message : String(e)}` };
  }

  const text = await res.text().catch(() => "");
  let parsed: unknown = null;
  try { parsed = JSON.parse(text); } catch { /* fall through to the raw text */ }
  return readExchangeResponse(res.status, parsed, text);
}

/** The agent approval, by its own name. Kept so call sites read as what they do. */
export function relayApproveAgent(
  action: ApproveAgentAction,
  signature: Signature,
  opts: { testnet: boolean; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<RelayResult> {
  return relaySignedAction(action, signature, opts);
}

/** Separated from the transport so the 200-with-an-error case is unit-testable. */
export function readExchangeResponse(status: number, parsed: unknown, raw: string): RelayResult {
  if (parsed && typeof parsed === "object") {
    const o = parsed as { status?: unknown; response?: unknown };
    if (o.status === "ok") return { ok: true };
    if (o.status === "err") {
      const msg = typeof o.response === "string" ? o.response : raw;
      return { ok: false, error: msg || "Hyperliquid refused the action without saying why" };
    }
  }
  if (status < 200 || status >= 300) return { ok: false, error: `Hyperliquid returned HTTP ${status}` };
  return { ok: false, error: raw || "Hyperliquid returned a response we could not read" };
}
