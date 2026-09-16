import { strict as assert } from "node:assert";
import { test } from "node:test";

import { keyWaitVerdict, type ChainStatus } from "./connectChain.ts";

function st(over: Partial<ChainStatus>): ChainStatus {
  return { step: "minting", agentAddress: null, lastError: null, awaitingUser: false, ...over };
}

/** The live run, 2026-09-10 14:08:44–14:11:18Z. The key was minted and the executor was
 *  republishing its ordinary "not approved yet" on every 60-second loop; the chain read
 *  that as fatal and stopped, leaving "Creating your agent key…" on screen under a button
 *  that had become "Approve in your wallet". This is the exact payload it saw. */
test("the executor waiting on the user is not a refusal, and the chain carries on", () => {
  assert.equal(keyWaitVerdict(st({
    step: "approve",
    agentAddress: "0x64a397848cab4c9787b55ae5cee0f2402768ce2b",
    lastError: "agent 0x64a3… is not approved on 0xaf38… yet — approve it on Hyperliquid. "
      + "Approved right now: (none)",
    awaitingUser: true,
  })), "ready");
});

test("a refusal that is not the desk waiting on somebody still stops the chain", () => {
  assert.equal(keyWaitVerdict(st({
    step: "approve",
    agentAddress: null,
    lastError: "the key for 0xaf38… holds the MASTER wallet, not an agent key",
    awaitingUser: false,
  })), "stop");
});

test("an account already connected is not ours to drive", () => {
  assert.equal(keyWaitVerdict(st({ step: "active", agentAddress: "0xabc" })), "stop");
  // Even mid-refusal: connected wins, because the screen is already showing the outcome.
  assert.equal(keyWaitVerdict(st({ step: "active", lastError: "anything" })), "stop");
});

test("minting with nothing decided yet keeps waiting", () => {
  assert.equal(keyWaitVerdict(st({ step: "minting" })), "wait");
  // `awaiting_approval` is set the moment the key is requested, so a pending error with
  // no agent address yet is still just "not there yet".
  assert.equal(keyWaitVerdict(st({
    step: "minting", lastError: "not funded yet", awaitingUser: true,
  })), "wait");
});

test("approve without an agent address is not ready — there is nothing to sign", () => {
  assert.equal(keyWaitVerdict(st({ step: "approve", agentAddress: null })), "wait");
});
