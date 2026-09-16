// Funding a Hyperliquid account from our own page.
//
// **This is the first thing we build that hands a wallet a transaction moving the
// user's money.** Every signature the site asks for otherwise authorises something that
// *cannot* move funds, and sentence 2 of `docs/USER-JOURNEY.md` is "We can never move
// your money." That is unchanged in substance — the destination is Hyperliquid's own
// deposit contract, we never custody anything and there is no path here that sends a
// dollar anywhere else — but it changes in **shape**, so this file follows the
// share-card rule (`src/web/cards.ts`): **every address is a constant in version
// control**, never from a URL, an API response or a page parameter, and the destination
// is shown on screen with an Arbiscan link before anybody signs.
//
// It is imported by the browser bundle as well as the server, which is why it is pure
// TypeScript with no imports at all: one definition of these addresses, not two that
// can drift. `src/hl/deposit.test.ts` pins the encoder against viem byte for byte.
//
// ── Which rail, and why ─────────────────────────────────────────────────────
//
// Two rails were measured on the same wallet an hour apart on 2026-09-10
// (`notes/2026-09-10-hl-onboarding-rails.md` §2):
//
//                     raw Bridge2 transfer        HL's own Deposit button
//     call            USDC.transfer(Bridge2)      batchDepositForBurnWithAuth
//     signatures      1                           2 (EIP-3009 auth, then the tx)
//     fee             none                        0.20 USDC
//     credited to     perp                        spot
//     HL's docs       "legacy… deprecated"        "the preferred method"
//
// **Neither sets the account's margin mode** — that was the load-bearing question and it
// is answered: HL's *frontend* sets it, agent-signed, and we now do the same
// (`src/hl/abstraction.ts`). So the choice is cost and support, not correctness, and the
// owner chose CCTP on 2026-09-10: it is the rail Hyperliquid actually maintains, and
// $0.20 once is a fair price for not sending somebody's deposit through a contract its
// own documentation calls deprecated.
//
// The call, the ABI and every constant below are read from Hyperliquid's own frontend
// bundle (`assets/config-w3uzUr54.js`, fetched 2026-09-10) rather than from a document
// about it — this is the code that produced the measured deposit.
//
// ⚠ **`hookData` carries a destination dex index and HL hardcodes `0`.** Dex 0 is core,
// not `xyz`, so the money lands in the core/spot pool either way and the abstraction
// mode is what makes it reachable. We hardcode the same 0, deliberately: a deposit that
// tried to land directly on `xyz` would be a rail nobody has ever run.

/** Arbitrum One. Hyperliquid's deposit path exists on this chain and no other. */
export const ARBITRUM_CHAIN_ID = 42161;
export const ARBITRUM_CHAIN_HEX = "0xa4b1";
export const ARBISCAN = "https://arbiscan.io";

/** Native USDC. **Bridged USDC.e (`0xFF970A61…5CC8`) is a different token** and sending
 *  it into this path loses it, so the page reads the native balance alone and names the
 *  token it needs. */
export const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
export const USDC_E_ARBITRUM = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8";
export const USDC_DECIMALS = 6;

/** Circle's `CctpExtension` — what HL's Deposit button calls, and the only contract this
 *  page ever asks a wallet to transact with. */
export const CCTP_EXTENSION = "0xA95d9c1F655341597C94393fDdc30cf3c08E4fcE";
/** HL's forwarder on HyperEVM: both the mint recipient and the destination caller. */
export const CCTP_FORWARDER = "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757";
/** Circle's CCTP domain for HyperEVM. */
export const CCTP_DESTINATION_DOMAIN = 19;
/** `maxFee`, in USDC units. A constant in HL's own bundle (`{fee: .2, feeWei: 2e5}`),
 *  not a quote fetched at deposit time. */
export const CCTP_MAX_FEE_UNITS = 200_000n;
export const CCTP_FEE_USD = 0.2;
export const CCTP_MIN_FINALITY_THRESHOLD = 1000;
/** Destination dex in `hookData`. 0 is core; see the header. */
export const CCTP_DESTINATION_DEX = 0;

/** The floor under any deposit, whatever the user's limits say.
 *
 *  Our own funding floor (`minFundedForLiveUsd`, $10.11 at the defaults) sits above it
 *  and is what the page actually enforces — this is the absolute one: below the CCTP
 *  fee plus a margin there is nothing left to trade, and Hyperliquid's own minimum on
 *  the legacy bridge is 5 USDC with the money destroyed underneath it. */
export const MIN_DEPOSIT_USD = 5;

/** `batchDepositForBurnWithAuth((uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32),
 *  (uint256,uint32,bytes32,bytes32,uint256,uint32,bytes))`.
 *
 *  Written down rather than derived because the browser has no keccak and this file is
 *  bundled into it. `deposit.test.ts` recomputes it from the signature with viem, so a
 *  wrong four bytes cannot survive `npm test`. */
export const BATCH_DEPOSIT_SELECTOR = "0x95878db1";

/** EIP-712 domain of the USDC contract, for the `ReceiveWithAuthorization` signature.
 *  `version: "2"` is USDC's, and is what HL's own bundle signs over. */
export const USDC_EIP712_DOMAIN = { name: "USD Coin", version: "2" } as const;

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

// ── Encoding ────────────────────────────────────────────────────────────────
//
// Hand-rolled, because the page is one inline script with no dependencies and its CSP
// forbids fetching one. It is 40 lines of fixed-shape ABI encoding, and it is pinned to
// viem's `encodeFunctionData` byte for byte in the test — which is the only reason
// hand-rolling it is acceptable for a call that moves money.

const strip = (hex: string): string => (hex.startsWith("0x") ? hex.slice(2) : hex);

/** A 32-byte word, right-aligned. Numbers only — addresses and byte strings have their
 *  own helpers, because padding an address on the wrong side is the classic way to send
 *  a transfer into nowhere. */
function word(n: bigint | number): string {
  const v = BigInt(n);
  if (v < 0n) throw new Error("ABI words are unsigned here");
  const hex = v.toString(16);
  if (hex.length > 64) throw new Error("value does not fit in a 32-byte word");
  return hex.padStart(64, "0");
}

/** An address as `bytes32`, left-padded — CCTP's `mintRecipient` encoding. */
export function addressAsBytes32(address: string): string {
  const a = strip(address);
  if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${address}`);
  return "0x" + a.toLowerCase().padStart(64, "0");
}

/** Already-32-byte data, verbatim. */
function bytes32(hex: string): string {
  const h = strip(hex);
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not 32 bytes: ${hex}`);
  return h.toLowerCase();
}

/** The hook Hyperliquid's forwarder reads to know whose account to credit.
 *
 *  `"cctp-forward"` in a 24-byte field, then two `uint32`s the forwarder uses to find
 *  the payload, then the recipient, then the destination dex. Copied from HL's own
 *  `QP(address, dexIndex)` rather than reasoned about: the layout is theirs and a
 *  deposit that encodes it differently is a deposit their forwarder ignores. */
export function hookDataFor(recipient: string, dexIndex: number = CCTP_DESTINATION_DEX): string {
  const a = strip(recipient);
  if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${recipient}`);
  const tag = [..."cctp-forward"].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return "0x" + tag.padEnd(48, "0")            // "cctp-forward" in 24 bytes
    + word(0).slice(56)                         // uint32(0)
    + word(24).slice(56)                        // uint32(24)
    + a.toLowerCase()                           // the account being credited
    + word(dexIndex).slice(56);                 // uint32(destination dex)
}

export type ReceiveWithAuthorizationData = {
  amount: bigint;
  authValidAfter: bigint;
  authValidBefore: bigint;
  authNonce: string;
  v: number;
  r: string;
  s: string;
};

export type DepositForBurnWithHookData = {
  amount: bigint;
  destinationDomain: number;
  mintRecipient: string;
  destinationCaller: string;
  maxFee: bigint;
  minFinalityThreshold: number;
  hookData: string;
};

/** The whole call, as calldata.
 *
 *  The first tuple is static (seven words, inline); the second carries `bytes` and is
 *  therefore dynamic, so the head holds an offset to it and the hook is length-prefixed
 *  and padded at the end. */
export function encodeBatchDepositForBurnWithAuth(
  auth: ReceiveWithAuthorizationData,
  burn: DepositForBurnWithHookData,
): string {
  const hook = strip(burn.hookData).toLowerCase();
  if (hook.length % 2 !== 0) throw new Error("hookData is not whole bytes");
  const hookBytes = hook.length / 2;
  const padded = hook.padEnd(Math.ceil(hookBytes / 32) * 64, "0");

  const head = [
    word(auth.amount), word(auth.authValidAfter), word(auth.authValidBefore),
    bytes32(auth.authNonce), word(auth.v), bytes32(auth.r), bytes32(auth.s),
    word(8 * 32),                       // offset to the second tuple
  ];
  const tail = [
    word(burn.amount), word(burn.destinationDomain),
    strip(addressAsBytes32(burn.mintRecipient)), strip(addressAsBytes32(burn.destinationCaller)),
    word(burn.maxFee), word(burn.minFinalityThreshold),
    word(7 * 32),                       // offset to hookData, from the tuple's own start
    word(hookBytes), padded,
  ];
  return BATCH_DEPOSIT_SELECTOR + head.join("") + tail.join("");
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/** A typed dollar amount, in USDC units.
 *
 *  Refuses rather than rounds, and refuses rather than clamps, for the reason every
 *  parser in this repo does: a deposit box that silently reinterprets what somebody
 *  typed is the wrong place to be helpful. More than six decimals is refused rather
 *  than truncated — the extra digits are the user's intent, and dropping them changes
 *  the number they are about to sign for. */
export function usdcUnits(amount: string): bigint {
  const t = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error("Enter an amount in dollars, digits only.");
  const [whole = "0", frac = ""] = t.split(".");
  if (frac.length > USDC_DECIMALS) throw new Error("USDC has six decimal places; that is more.");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac.padEnd(USDC_DECIMALS, "0") || "0");
}

/** USDC units back to dollars, for display. */
export function usdcToUsd(units: bigint): number {
  return Number(units) / 10 ** USDC_DECIMALS;
}

/** `balanceOf(address)` — the one read this page makes, through the wallet's own
 *  provider rather than an RPC of ours. `tasks/36` §4 assumed a server route was needed
 *  because the page's CSP is `connect-src 'self'`; it is not, because an `eth_call`
 *  goes out through the injected wallet and never through the page's network stack. */
export function balanceOfCalldata(owner: string): string {
  const a = strip(owner);
  if (!/^[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${owner}`);
  return "0x70a08231" + a.toLowerCase().padStart(64, "0");
}
