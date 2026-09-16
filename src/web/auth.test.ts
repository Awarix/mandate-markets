import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  buildLoginMessage, classifySignature, clearCookie, isAddress, issueChallenge, login,
  sessionCookie, sessionIdFromCookie,
} from "./auth.ts";
import { CHALLENGE_TTL_MS, SESSION_TTL_MS, WebStore } from "./sessions.ts";

// Sign-in is the whole access-control story for the web tier, so these use a real
// key and a real signature rather than a stubbed verifier. A test that mocks the
// thing it is checking proves only that the mock works.

const ORIGIN = { domain: "mandate.markets", uri: "https://mandate.markets" };

function fresh(): WebStore {
  return new WebStore(":memory:");
}

async function signIn(store: WebStore, now = Date.now()) {
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = issueChallenge(store, account.address, ORIGIN, now);
  const signature = await account.signMessage({ message: challenge.message });
  return { account, challenge, signature };
}

test("a valid signature opens a session for that address", async () => {
  const store = fresh();
  const { account, challenge, signature } = await signIn(store);

  const r = await login(store, { address: account.address, nonce: challenge.nonce, signature });
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.session.address === account.address.toLowerCase());

  assert.ok(r.ok);
  assert.equal(store.session(r.session.id)?.address, account.address.toLowerCase());
  store.close();
});

test("a challenge is single-use — the same signature cannot be replayed", async () => {
  const store = fresh();
  const { account, challenge, signature } = await signIn(store);

  const first = await login(store, { address: account.address, nonce: challenge.nonce, signature });
  assert.equal(first.ok, true);

  const replay = await login(store, { address: account.address, nonce: challenge.nonce, signature });
  assert.equal(replay.ok, false);
  store.close();
});

test("an expired challenge is refused even with a correct signature", async () => {
  const store = fresh();
  const t0 = Date.now();
  const { account, challenge, signature } = await signIn(store, t0);

  const r = await login(
    store,
    { address: account.address, nonce: challenge.nonce, signature },
    t0 + CHALLENGE_TTL_MS + 1,
  );
  assert.equal(r.ok, false);
  store.close();
});

test("a signature from a different key does not open a session", async () => {
  const store = fresh();
  const victim = privateKeyToAccount(generatePrivateKey());
  const attacker = privateKeyToAccount(generatePrivateKey());

  const challenge = issueChallenge(store, victim.address, ORIGIN);
  // Correctly signed — by the wrong wallet.
  const signature = await attacker.signMessage({ message: challenge.message });

  const r = await login(store, { address: victim.address, nonce: challenge.nonce, signature });
  assert.equal(r.ok, false);
  store.close();
});

test("a challenge issued for one address cannot be used to claim another", async () => {
  const store = fresh();
  const attacker = privateKeyToAccount(generatePrivateKey());
  const victim = privateKeyToAccount(generatePrivateKey());

  // The attacker holds a valid challenge and can sign it perfectly — for themselves.
  const challenge = issueChallenge(store, attacker.address, ORIGIN);
  const signature = await attacker.signMessage({ message: challenge.message });

  // Claiming the victim's address with it must fail before any signature check.
  const r = await login(store, { address: victim.address, nonce: challenge.nonce, signature });
  assert.equal(r.ok, false);
  store.close();
});

test("signing a message we did not issue does not open a session", async () => {
  const store = fresh();
  const account = privateKeyToAccount(generatePrivateKey());
  const challenge = issueChallenge(store, account.address, ORIGIN);

  // A well-formed SIWE message for another site, signed by the right key.
  const foreign = buildLoginMessage({
    domain: "evil.example",
    address: account.address.toLowerCase(),
    uri: "https://evil.example",
    nonce: challenge.nonce,
    issuedAt: new Date().toISOString(),
  });
  const signature = await account.signMessage({ message: foreign });

  const r = await login(store, { address: account.address, nonce: challenge.nonce, signature });
  assert.equal(r.ok, false, "the signature must be checked against the message we stored");
  store.close();
});

test("the message says the signature authorises nothing", async () => {
  const store = fresh();
  const account = privateKeyToAccount(generatePrivateKey());
  const c = issueChallenge(store, account.address, ORIGIN);
  assert.match(c.message, /does not authorise a transaction and cannot move funds/);
  assert.match(c.message, /^mandate\.markets wants you to sign in/);
  assert.ok(c.message.includes(c.nonce));
  store.close();
});

test("malformed input is refused without touching the store", async () => {
  const store = fresh();
  for (const bad of [
    { address: "not-an-address", nonce: "x", signature: "0xab" },
    { address: `0x${"1".repeat(40)}`, nonce: "", signature: "0xab" },
    { address: `0x${"1".repeat(40)}`, nonce: "x", signature: "not-hex" },
  ]) {
    assert.equal((await login(store, bad)).ok, false);
  }
  store.close();
});

test("sessions expire, and an expired one is cleared on read", () => {
  const store = fresh();
  const t0 = Date.now();
  const s = store.createSession("0xabc", t0);

  assert.ok(store.session(s.id, t0 + 1000));
  assert.equal(store.session(s.id, t0 + SESSION_TTL_MS + 1), null);
  // Reading an expired session removes it rather than leaving it to the sweeper.
  assert.equal(store.sweep(t0 + SESSION_TTL_MS + 2).sessions, 0);
  store.close();
});

test("sweep clears expired challenges and sessions", () => {
  const store = fresh();
  const t0 = Date.now();
  store.putChallenge("0xabc", "msg", t0);
  store.createSession("0xabc", t0);

  const swept = store.sweep(t0 + SESSION_TTL_MS + 1);
  assert.equal(swept.challenges, 1);
  assert.equal(swept.sessions, 1);
  store.close();
});

test("cookie parsing accepts our cookie among others and rejects junk", () => {
  const id = "a".repeat(64);
  assert.equal(sessionIdFromCookie(`other=1; mandate_session=${id}; z=2`), id);
  assert.equal(sessionIdFromCookie(` mandate_session=${id} `), id);
  assert.equal(sessionIdFromCookie("mandate_session=short"), null);
  assert.equal(sessionIdFromCookie("mandate_session=" + "z".repeat(64)), null);
  assert.equal(sessionIdFromCookie("other=1"), null);
  assert.equal(sessionIdFromCookie(undefined), null);
});

test("the session cookie is HttpOnly, Lax, and Secure in production", () => {
  const c = sessionCookie("a".repeat(64), 3600, true);
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Secure/);
  assert.doesNotMatch(sessionCookie("b".repeat(64), 3600, false), /Secure/);
  assert.match(clearCookie(true), /Max-Age=0/);
});

test("isAddress accepts a 20-byte hex address and nothing else", () => {
  assert.equal(isAddress(`0x${"a".repeat(40)}`), true);
  assert.equal(isAddress(`0x${"a".repeat(39)}`), false);
  assert.equal(isAddress("a".repeat(40)), false);
  assert.equal(isAddress(`0x${"g".repeat(40)}`), false);
});

// ── Smart-contract wallets (tasks/11, failure class 2) ─────────────────────
//
// The prior question that task says must be answered first has an answer, and it is
// no: every one of the 118 exchange methods in @nktkas/hyperliquid 0.33.3 carries a
// 65-byte `{r, s, v}` signature and there is no field anywhere to carry an ERC-1271
// attestation. A Safe can fund a Hyperliquid account and can never trade it.

test("an ordinary 65-byte signature is EOA-shaped", () => {
  assert.equal(classifySignature("0x" + "ab".repeat(65)), "eoa-shaped");
});

// The one case that is positively identifiable rather than merely odd.
test("an ERC-6492 signature is recognised by its magic suffix", () => {
  const wrapped = "0x" + "cd".repeat(200) + "6492".repeat(16);
  assert.equal(classifySignature(wrapped), "contract-wallet");
});

test("anything that is not 65 bytes is not an EOA signature", () => {
  for (const sig of ["0x" + "ab".repeat(64), "0x" + "ab".repeat(66), "0xabcd"]) {
    assert.equal(classifySignature(sig), "contract-wallet", sig.slice(0, 12));
  }
});

// It refuses *before* `takeChallenge`, because a signature that cannot be an EOA's
// will not become one on a retry — and burning the challenge would make the second
// attempt fail for a second, unrelated reason.
test("a contract-wallet signature is refused without spending the challenge", async () => {
  const store = fresh();
  const account = privateKeyToAccount(generatePrivateKey());
  const c = issueChallenge(store, account.address, ORIGIN);

  const first = await login(store, {
    address: account.address, nonce: c.nonce, signature: "0x" + "cd".repeat(200) + "6492".repeat(16),
  });
  assert.equal(first.ok, false);
  assert.equal(first.ok === false && first.kind, "contract-wallet");

  // The same challenge still works for a real signature, which is the point.
  const sig = await account.signMessage({ message: c.message });
  const second = await login(store, { address: account.address, nonce: c.nonce, signature: sig });
  assert.equal(second.ok, true);
  store.close();
});
