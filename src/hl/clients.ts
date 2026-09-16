import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { privateKeyToAccount } from "viem/accounts";

// Transports and clients. Ported near-as-is from OutcomeMaker `src/sdk/clients.ts`
// (~25 lines, and correct), bumped from SDK 0.32.2 to 0.33.3.
//
// One deliberate difference: nothing here is a module-level singleton keyed off env
// vars. A client is built for an account and handed to it, because Phase 3 runs one
// agent key per account and HL tracks nonces **per signer** — a shared signer across
// accounts causes nonce collisions and dropped orders. Making the client per-account
// now costs nothing and removes the temptation later.

export function isTestnet(): boolean {
  return process.env.HYPERLIQUID_TESTNET === "true";
}

export function makeInfoClient(testnet = isTestnet()): InfoClient {
  return new InfoClient({ transport: new HttpTransport({ isTestnet: testnet, timeout: 20_000 }) });
}

// The builder rail — the address, the rate, and the per-account decision about whether
// an order carries the code at all — lives in `src/hl/approve-builder-fee.ts`, beside
// the signature that makes it legal.
//
// It was here, as `builderConfig()`, reading `HL_BUILDER_ADDRESS` and `HL_BUILDER_FEE`
// and returning the same config for **every** account. It could not do otherwise: it
// took no account parameter. That is what made setting the address an outage rather
// than a rate — Hyperliquid rejects an order carrying a builder code the master has not
// approved, and nobody has approved one until their own wallet signs. The decision has
// to be per-account, so it moved to where the account is known, and `placeOrder` is now
// handed a resolved config rather than reaching for a global.

/** The agent (API) wallet. Sign-only: it can trade the account and can never
 *  withdraw or transfer out. This is the whole basis of the product. */
export function makeExchangeClient(agentPrivateKey: string, testnet = isTestnet()): ExchangeClient {
  return new ExchangeClient({
    wallet: privateKeyToAccount(assertPrivateKey(agentPrivateKey)),
    transport: new HttpTransport({ isTestnet: testnet, timeout: 20_000 }),
  });
}

/** Fail with the actual diagnosis rather than a curve-library stack trace.
 *
 *  The predictable mistake is pasting the agent's **address** (42 chars) where its
 *  **private key** (66) belongs — they are both `0x`-prefixed hex and the address is
 *  the value everyone is looking at while configuring. viem's error for that is
 *  "invalid private key, expected hex or 32 bytes, got string", which does not
 *  suggest the fix. Cost a round trip on 2026-08-30. */
export function assertPrivateKey(key: string, varName = "HL_AGENT_PRIVATE_KEY"): `0x${string}` {
  const k = key.trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(k)) {
    throw new Error(
      `${varName} is ${k.length} characters — that is an ADDRESS, not a private key. ` +
      "A private key is 66 characters (0x + 64 hex); an address is 42 (0x + 40 hex). " +
      "You likely pasted the agent's public address. The key is the secret it was " +
      "derived from, and preflight should *derive* this address from it, not be given it.",
    );
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error(
      `${varName} is not a well-formed private key: expected 0x + 64 hex characters, ` +
      `got ${k.length} characters${k.startsWith("0x") ? "" : " with no 0x prefix"}.`,
    );
  }
  return k as `0x${string}`;
}

export function agentAddress(agentPrivateKey: string): `0x${string}` {
  return privateKeyToAccount(assertPrivateKey(agentPrivateKey)).address;
}
