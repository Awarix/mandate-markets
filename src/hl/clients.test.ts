import assert from "node:assert/strict";
import { test } from "node:test";
import { agentAddress, assertPrivateKey } from "./clients.ts";

// A throwaway key, committed on purpose: it controls nothing and never will. Needed
// because the only way to test "derives to the right address" is with a real one.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const ITS_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const AN_ADDRESS = "0xa8b00c8efbc52abd56dd7c8fb21e18e5e58e51e0"; // 42 chars

test("a well-formed key passes through and derives its address", () => {
  assert.equal(assertPrivateKey(KEY), KEY);
  assert.equal(agentAddress(KEY).toLowerCase(), ITS_ADDRESS.toLowerCase());
});

// The mistake this exists for: an address and a private key are both 0x-hex, and the
// address is the value you are staring at while configuring. viem's own error for it
// ("invalid private key, expected hex or 32 bytes") does not suggest the fix.
test("pasting an address where a key belongs says so, in those words", () => {
  assert.throws(() => assertPrivateKey(AN_ADDRESS), (e: Error) => {
    assert.match(e.message, /ADDRESS, not a private key/);
    assert.match(e.message, /42 characters/);
    assert.match(e.message, /66 characters/, "must state what a key looks like");
    return true;
  });
});

test("other malformed values are rejected with their actual length", () => {
  for (const bad of ["", "0x", "not-a-key", KEY.slice(0, 40)]) {
    assert.throws(() => assertPrivateKey(bad), /well-formed private key|ADDRESS/, `bad=${bad}`);
  }
});

test("a missing 0x prefix is called out specifically", () => {
  assert.throws(() => assertPrivateKey(KEY.slice(2)), /no 0x prefix/);
});

test("surrounding whitespace is tolerated — .env edits leave it constantly", () => {
  assert.equal(assertPrivateKey(`  ${KEY}\n`), KEY);
});

test("the variable name in the message is configurable, so the error names the fix", () => {
  assert.throws(() => assertPrivateKey(AN_ADDRESS, "HL_BUCKET_AGENT_PRIVATE_KEY"),
    /HL_BUCKET_AGENT_PRIVATE_KEY/);
});
