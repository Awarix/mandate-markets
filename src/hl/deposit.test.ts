import assert from "node:assert/strict";
import { test } from "node:test";
import { concatHex, encodeFunctionData, getAddress, pad, toFunctionSelector, toHex } from "viem";
import {
  addressAsBytes32, balanceOfCalldata, BATCH_DEPOSIT_SELECTOR, CCTP_DESTINATION_DEX,
  CCTP_DESTINATION_DOMAIN, CCTP_EXTENSION, CCTP_FORWARDER, CCTP_MAX_FEE_UNITS,
  CCTP_MIN_FINALITY_THRESHOLD, encodeBatchDepositForBurnWithAuth, hookDataFor, usdcToUsd,
  usdcUnits, USDC_ARBITRUM, USDC_E_ARBITRUM,
} from "./deposit.ts";

// This file is the reason a hand-rolled ABI encoder is acceptable in a page that moves
// somebody's money: everything it produces is checked, byte for byte, against viem —
// which the browser bundle cannot carry and the test process can.

const ABI = [{
  name: "batchDepositForBurnWithAuth",
  type: "function",
  stateMutability: "nonpayable",
  outputs: [],
  inputs: [
    {
      type: "tuple", name: "_receiveWithAuthorizationData",
      components: [
        { name: "amount", type: "uint256" },
        { name: "authValidAfter", type: "uint256" },
        { name: "authValidBefore", type: "uint256" },
        { name: "authNonce", type: "bytes32" },
        { name: "v", type: "uint8" },
        { name: "r", type: "bytes32" },
        { name: "s", type: "bytes32" },
      ],
    },
    {
      type: "tuple", name: "_depositForBurnData",
      components: [
        { name: "amount", type: "uint256" },
        { name: "destinationDomain", type: "uint32" },
        { name: "mintRecipient", type: "bytes32" },
        { name: "destinationCaller", type: "bytes32" },
        { name: "maxFee", type: "uint256" },
        { name: "minFinalityThreshold", type: "uint32" },
        { name: "hookData", type: "bytes" },
      ],
    },
  ],
}] as const;

// The four bytes are written down in `deposit.ts` because the browser has no keccak.
test("the selector is the one the signature actually hashes to", () => {
  assert.equal(
    BATCH_DEPOSIT_SELECTOR,
    toFunctionSelector(
      "batchDepositForBurnWithAuth((uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)," +
      "(uint256,uint32,bytes32,bytes32,uint256,uint32,bytes))",
    ),
  );
});

const USER = "0xAf383da7C44047B1dd3e1747A1182a53a5e536bb";
const NONCE = "0x9a1c4f0e2b6d8a3f5e7c1b9d0a4f6e8c2d5b7a9f1e3c5d7b9a0f2e4c6d8b1a3f";
const R = "0x1111111111111111111111111111111111111111111111111111111111111111";
const S = "0x2222222222222222222222222222222222222222222222222222222222222222";

/** HL's own `QP(address, dexIndex)`, transcribed with viem's primitives. If our version
 *  drifts from this, their forwarder credits nobody. */
function hlHookData(recipient: string, dexIndex = 0): string {
  const n = new Uint8Array(24);
  new TextEncoder().encodeInto("cctp-forward", n);
  return concatHex([
    toHex(n), toHex(0, { size: 4 }), toHex(24, { size: 4 }),
    getAddress(recipient as `0x${string}`), toHex(dexIndex, { size: 4 }),
  ]).toLowerCase();
}

test("the hook is the one Hyperliquid's forwarder reads", () => {
  assert.equal(hookDataFor(USER), hlHookData(USER));
  assert.equal((hookDataFor(USER).length - 2) / 2, 56, "24 + 4 + 4 + 20 + 4 bytes");
  // The destination dex is 0 — core, not xyz — because that is the only value the rail
  // has ever been run with. A different one must be a deliberate edit here, not a
  // default that drifted.
  assert.equal(CCTP_DESTINATION_DEX, 0);
});

test("the calldata is viem's, byte for byte", () => {
  const amount = usdcUnits("42.5");
  const auth = {
    amount, authValidAfter: 1_789_000_000n, authValidBefore: 1_789_003_600n,
    authNonce: NONCE, v: 28, r: R, s: S,
  };
  const burn = {
    amount, destinationDomain: CCTP_DESTINATION_DOMAIN,
    mintRecipient: CCTP_FORWARDER, destinationCaller: CCTP_FORWARDER,
    maxFee: CCTP_MAX_FEE_UNITS, minFinalityThreshold: CCTP_MIN_FINALITY_THRESHOLD,
    hookData: hookDataFor(USER),
  };
  const mine = encodeBatchDepositForBurnWithAuth(auth, burn);
  const theirs = encodeFunctionData({
    abi: ABI, functionName: "batchDepositForBurnWithAuth",
    args: [
      { ...auth, authNonce: NONCE as `0x${string}`, r: R as `0x${string}`, s: S as `0x${string}` },
      {
        ...burn,
        mintRecipient: pad(CCTP_FORWARDER as `0x${string}`, { size: 32 }),
        destinationCaller: pad(CCTP_FORWARDER as `0x${string}`, { size: 32 }),
        hookData: hookDataFor(USER) as `0x${string}`,
      },
    ],
  });
  assert.equal(mine.toLowerCase(), theirs.toLowerCase());
});

// A hook that is not a whole number of words is the case a fixed-shape encoder is most
// likely to get wrong, and 56 bytes is exactly that case (it pads to 64).
test("a hook shorter than its padding still encodes to viem's bytes", () => {
  const one = (hook: string) => encodeBatchDepositForBurnWithAuth(
    { amount: 1n, authValidAfter: 0n, authValidBefore: 1n, authNonce: NONCE, v: 27, r: R, s: S },
    {
      amount: 1n, destinationDomain: 19, mintRecipient: CCTP_FORWARDER,
      destinationCaller: CCTP_FORWARDER, maxFee: 0n, minFinalityThreshold: 1000, hookData: hook,
    },
  );
  for (const hook of ["0x", "0xdeadbeef", hookDataFor(USER), "0x" + "ab".repeat(64)]) {
    const theirs = encodeFunctionData({
      abi: ABI, functionName: "batchDepositForBurnWithAuth",
      args: [
        { amount: 1n, authValidAfter: 0n, authValidBefore: 1n, authNonce: NONCE as `0x${string}`, v: 27, r: R as `0x${string}`, s: S as `0x${string}` },
        {
          amount: 1n, destinationDomain: 19,
          mintRecipient: pad(CCTP_FORWARDER as `0x${string}`, { size: 32 }),
          destinationCaller: pad(CCTP_FORWARDER as `0x${string}`, { size: 32 }),
          maxFee: 0n, minFinalityThreshold: 1000, hookData: hook as `0x${string}`,
        },
      ],
    });
    assert.equal(one(hook).toLowerCase(), theirs.toLowerCase(), `hook ${hook.slice(0, 12)}`);
  }
});

test("an address becomes bytes32 left-padded, the way CCTP reads it", () => {
  assert.equal(addressAsBytes32(CCTP_FORWARDER), pad(CCTP_FORWARDER as `0x${string}`, { size: 32 }).toLowerCase());
  assert.throws(() => addressAsBytes32("0xdead"), /not an address/);
});

test("balanceOf is the standard selector and a right-aligned owner", () => {
  assert.equal(
    balanceOfCalldata(USER),
    encodeFunctionData({
      abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] }] as const,
      functionName: "balanceOf",
      args: [USER as `0x${string}`],
    }).toLowerCase(),
  );
});

// The two tokens are one hex character apart in a person's memory and a total loss
// apart in practice: USDC.e sent into this path does not come back.
test("the token addresses are the ones this rail accepts", () => {
  assert.equal(getAddress(USDC_ARBITRUM as `0x${string}`), USDC_ARBITRUM);
  assert.equal(getAddress(USDC_E_ARBITRUM as `0x${string}`), USDC_E_ARBITRUM);
  assert.equal(getAddress(CCTP_EXTENSION as `0x${string}`), CCTP_EXTENSION);
  assert.equal(getAddress(CCTP_FORWARDER as `0x${string}`), CCTP_FORWARDER);
  assert.notEqual(USDC_ARBITRUM.toLowerCase(), USDC_E_ARBITRUM.toLowerCase());
});

test("amounts are parsed, never rounded into something else", () => {
  assert.equal(usdcUnits("42.5"), 42_500_000n);
  assert.equal(usdcUnits("10"), 10_000_000n);
  assert.equal(usdcUnits("0.000001"), 1n);
  assert.equal(usdcToUsd(42_500_000n), 42.5);
  for (const bad of ["", " ", "-5", "1e6", "$10", "10.0000001", "abc", "1,000"]) {
    assert.throws(() => usdcUnits(bad), `"${bad}" must be refused`);
  }
});
