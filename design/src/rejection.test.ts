import { strict as assert } from "node:assert";
import test from "node:test";
import { isUserRejection } from "./rejection.ts";

test("EIP-1193's own code, which is the only one the page used to handle", () => {
  assert.equal(isUserRejection({ code: 4001, message: "User rejected the request." }), true);
});

test("ethers' string code, which MetaMask via ethers throws", () => {
  assert.equal(isUserRejection({ code: "ACTION_REJECTED", message: "user rejected action" }), true);
});

test("a provider error buried under cause — the shape that reached the alert box", () => {
  assert.equal(isUserRejection(new Error("failed", { cause: { code: 4001 } })), true);
});

test("or under `error`, or under `data`", () => {
  assert.equal(isUserRejection({ message: "rpc failed", error: { code: 4001 } }), true);
  assert.equal(isUserRejection({ message: "rpc failed", data: { code: "ACTION_REJECTED" } }), true);
});

test("message-only, for a wallet that sends no code at all", () => {
  assert.equal(isUserRejection({ message: "MetaMask Tx Signature: User denied message signature." }), true);
});

test("a real failure is not a rejection, however it is shaped", () => {
  assert.equal(isUserRejection({ code: -32603, message: "Internal JSON-RPC error." }), false);
  assert.equal(isUserRejection(new Error("network request failed")), false);
  assert.equal(isUserRejection("user rejected"), false);   // a bare string is not an error object
  assert.equal(isUserRejection(null), false);
  assert.equal(isUserRejection(undefined), false);
});

test("a cause chain that loops terminates instead of hanging", () => {
  const a: Record<string, unknown> = { message: "a" };
  const b: Record<string, unknown> = { message: "b", cause: a };
  a.cause = b;
  assert.equal(isUserRejection(a), false);
});

test("a rejection deeper than the depth limit is treated as a failure, not swallowed", () => {
  const deep = { cause: { cause: { cause: { cause: { cause: { code: 4001 } } } } } };
  assert.equal(isUserRejection(deep), false);
});
