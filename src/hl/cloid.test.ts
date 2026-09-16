import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { intentPrefix, isOurs, makeCloid, parseCloid } from "./cloid.ts";

test("a cloid round-trips its role and its intent", () => {
  const id = randomUUID();
  for (const role of ["entry", "tp", "sl", "close"] as const) {
    const c = makeCloid(id, role);
    assert.match(c, /^0x[0-9a-f]{32}$/, "HL requires 0x + 32 hex");
    assert.deepEqual(parseCloid(c), { role, intentPrefix: intentPrefix(id) });
  }
});

test("two orders for the same intent and role are still distinct ids", () => {
  const id = randomUUID();
  assert.notEqual(makeCloid(id, "sl"), makeCloid(id, "sl"), "a re-placed stop must not collide with the cancelled one");
});

// This is the foreign-actor detector. If it ever returns a false positive we halt a
// healthy account; if it returns a false negative we trade on a wrong picture.
test("anything we did not tag is not ours", () => {
  assert.equal(isOurs(null), false);
  assert.equal(isOurs(undefined), false);
  assert.equal(isOurs("0x" + "00".repeat(16)), false, "an all-zero cloid from the HL UI");
  assert.equal(isOurs("0x" + "ff".repeat(16)), false);
  assert.equal(isOurs("0xdeadbeef"), false, "wrong length");
  assert.equal(isOurs("0x5d01" + "00".repeat(14)), false, "our magic but role 0 is not a role we issue");
  assert.equal(isOurs("0x5d02" + "01" + "00".repeat(13)), false, "a future version is not ours to manage");
  assert.equal(isOurs("0xzz01" + "00".repeat(14)), false, "non-hex");
});

test("our own orders are always recognised", () => {
  for (let i = 0; i < 200; i++) {
    assert.equal(isOurs(makeCloid(randomUUID(), "entry")), true);
  }
});

test("an intent id too short to tag is refused rather than silently truncated", () => {
  assert.throws(() => makeCloid("abc", "entry"), /too short/);
});

test("case is not significant — HL may echo a cloid back uppercased", () => {
  const c = makeCloid(randomUUID(), "tp");
  assert.deepEqual(parseCloid(c.toUpperCase()), parseCloid(c));
});
