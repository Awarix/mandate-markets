import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentNameWithExpiry, assertBareName, buildRenewal, exchangeUrl, fromSignatureChainId,
  MAX_VALID_DAYS, readExchangeResponse, splitSignature, toSignatureChainId, typedDataFor,
  ZERO_ADDRESS,
} from "./approve-agent.ts";

const AGENT = "0xba440c973635bf27923e5e2cd17305d5c88f8fe7";
const ARBITRUM = "0xa4b1";
/** 2026-09-02T13:54:54.139Z — the server time behind the real renewal in the note. */
const SERVER_TIME = 1_756_821_294_139;

function plan(over: Partial<Parameters<typeof buildRenewal>[0]> = {}) {
  return buildRenewal({
    agentAddress: AGENT,
    bareName: "mandate-web",
    serverTimeMs: SERVER_TIME,
    signatureChainId: ARBITRUM,
    chain: "Mainnet",
    removeNonce: 1,
    approveNonce: 2,
    ...over,
  });
}

// The whole renewal rests on this shape: Hyperliquid refuses to re-approve an address
// it still holds ("Extra agent already used."), so the entry is dropped first and the
// *same* address goes back on. Getting the order or the sentinel wrong leaves an
// account lapsed while the UI reports success.
test("a renewal is remove-then-approve, on one address and one name", () => {
  const p = plan();
  assert.equal(p.remove.agentAddress, ZERO_ADDRESS, "removal is the zero-address sentinel");
  assert.equal(p.remove.agentName, "mandate-web", "removal carries the bare name, with no expiry suffix");
  assert.equal(p.approve.agentAddress, AGENT, "the same agent address comes back — no key is rotated");
  assert.equal(p.approve.agentName, `mandate-web valid_until ${SERVER_TIME + MAX_VALID_DAYS * 86_400_000}`);
  assert.notEqual(p.remove.nonce, p.approve.nonce);
});

test("validity defaults to Hyperliquid's maximum, because the default is what burned us", () => {
  // The account this task exists for held a ~2-day approval nobody chose: HL's own
  // "Days Valid" box is blank by default. Building the action ourselves means the
  // maximum is not a setting anyone can forget.
  const p = plan();
  assert.equal(p.expiresAtMs - SERVER_TIME, MAX_VALID_DAYS * 86_400_000);
  assert.equal(MAX_VALID_DAYS, 180);
});

test("validity is bounded, in both directions", () => {
  assert.throws(() => plan({ days: 181 }), /1\.\.180/, "181 is untested against the venue; do not send it");
  assert.throws(() => plan({ days: 0 }), /1\.\.180/);
  assert.throws(() => plan({ days: -1 }), /1\.\.180/);
  assert.equal(plan({ days: 1 }).expiresAtMs - SERVER_TIME, 86_400_000);
});

test("the zero address is never approved as an agent", () => {
  // It is the removal sentinel. Approving it would silently delete the entry it was
  // meant to renew, and the caller would read "ok".
  assert.throws(() => plan({ agentAddress: ZERO_ADDRESS }), /removal sentinel/);
  assert.throws(() => plan({ agentAddress: "0x1234" }), /is not an address/);
});

test("both actions need fresh, distinct nonces", () => {
  assert.throws(() => plan({ removeNonce: 7, approveNonce: 7 }), /distinct nonces/);
});

// The SDK strips ` valid_until <ms>` before measuring the 16-character limit, so the
// suffix is free and the name is not. "mandate-web" is 11 — room, and no more.
test("the bare name is capped at 16 characters, and the suffix does not count", () => {
  assert.doesNotThrow(() => assertBareName("sixteen-chars-16"));
  assert.throws(() => assertBareName("seventeen-chars17"), /17 characters/);
  assert.throws(() => assertBareName(""), /unnamed/, "an empty name is a different slot, not a default");
  assert.throws(() => assertBareName("mandate valid_until 123"), /already carries an expiry/);
  assert.equal(agentNameWithExpiry("mandate-web", 1234), "mandate-web valid_until 1234");
});

test("the expiry is floored to whole milliseconds", () => {
  assert.equal(agentNameWithExpiry("x", 1234.9), "x valid_until 1234");
});

test("chain ids round-trip the way Hyperliquid writes them", () => {
  assert.equal(toSignatureChainId(42161), "0xa4b1", "Arbitrum One, as HL's own client emits it");
  assert.equal(fromSignatureChainId("0xa4b1"), 42161);
  assert.equal(fromSignatureChainId("0x66eee"), 421614, "the SDK example's Arbitrum Sepolia");
  assert.throws(() => fromSignatureChainId("42161"), /0x-prefixed hex/);
  assert.throws(() => toSignatureChainId(0), /positive integer/);
});

// Only the four declared fields are hashed. `type` and `signatureChainId` ride along in
// the action; putting them in the message would change the struct hash and every
// signature would be rejected.
test("the typed data hashes exactly the four signed fields", () => {
  const td = typedDataFor(plan().approve);
  assert.deepEqual(Object.keys(td.message), ["hyperliquidChain", "agentAddress", "agentName", "nonce"]);
  assert.equal(td.primaryType, "HyperliquidTransaction:ApproveAgent");
  assert.equal(td.domain.name, "HyperliquidSignTransaction");
  assert.equal(td.domain.version, "1");
  assert.equal(td.domain.chainId, 42161, "derived from signatureChainId, not a constant");
  assert.equal(td.domain.verifyingContract, ZERO_ADDRESS);
  assert.ok(td.types.EIP712Domain, "eth_signTypedData_v4 needs the domain type declared");
});

test("a signature splits into r, s and a 27/28 recovery byte", () => {
  const r = "11".repeat(32), s = "22".repeat(32);
  assert.deepEqual(splitSignature(`0x${r}${s}1b`), { r: `0x${r}`, s: `0x${s}`, v: 27 });
  assert.deepEqual(splitSignature(`0x${r}${s}1c`), { r: `0x${r}`, s: `0x${s}`, v: 28 });
  // Some wallets return 0/1 for the same recovery id. That is a legal encoding and
  // Hyperliquid accepts only 27/28, so normalise instead of refusing a working wallet.
  assert.equal(splitSignature(`0x${r}${s}00`).v, 27);
  assert.equal(splitSignature(`0x${r}${s}01`).v, 28);
  assert.throws(() => splitSignature(`0x${r}${s}05`), /neither 0\/1 nor 27\/28/);
  assert.throws(() => splitSignature("0xdeadbeef"), /65-byte/);
});

// The failure that would have shipped silently: Hyperliquid answered "Extra agent
// already used." with HTTP 200. A relay that trusts the status code tells the account's
// owner their approval was renewed while it stays lapsed.
test("a refusal arrives as HTTP 200 and must still read as a failure", () => {
  assert.deepEqual(
    readExchangeResponse(200, { status: "err", response: "Extra agent already used." }, ""),
    { ok: false, error: "Extra agent already used." },
  );
  assert.deepEqual(readExchangeResponse(200, { status: "ok", response: {} }, ""), { ok: true });
  assert.equal(readExchangeResponse(500, null, "gateway down").ok, false);
  assert.equal(readExchangeResponse(200, null, "").ok, false, "an unreadable 200 is not a success");
});

test("mainnet and testnet do not share an endpoint", () => {
  assert.equal(exchangeUrl(false), "https://api.hyperliquid.xyz/exchange");
  assert.match(exchangeUrl(true), /testnet/);
});
