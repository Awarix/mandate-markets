import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_MANDATE } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import {
  canAttemptXLink, canSpendXCall, draftPost, parsePostUrl, postIsBy, postLinksTo,
  queueListing, queueStatus,
} from "./queue.ts";
import { WebStore } from "./sessions.ts";

const A = "0xaaaa000000000000000000000000000000000001";
const B = "0xbbbb000000000000000000000000000000000002";
const C = "0xcccc000000000000000000000000000000000003";
const T0 = Date.parse("2026-09-05T00:00:00.000Z");
const HOUR = 3600_000;

function fresh(): { store: Store; web: WebStore } {
  return { store: new Store(":memory:", { log: () => {} }), web: new WebStore(":memory:") };
}

const status = (s: Store, w: WebStore, address: string, env: NodeJS.ProcessEnv = {}) =>
  queueStatus({
    store: s, web: w, address, xConfigured: false, postCheckable: false,
    domain: "mandate.markets", env, now: T0,
  });

// ── The URL check, which is the whole of the post verification ──────────────
//
// `tasks/17` §3: the X API has no free tier and reading a post costs money, but the
// URL is free and names its author. So this parser is the verification, and what it
// refuses matters as much as what it accepts.

test("a post URL yields its author and id", () => {
  assert.deepEqual(parsePostUrl("https://x.com/andre/status/1234567890"), { handle: "andre", id: "1234567890" });
});

test("the noise people actually paste is accepted", () => {
  for (const u of [
    "https://x.com/andre/status/1234567890?t=abc&s=20",
    "https://www.x.com/andre/status/1234567890",
    "https://twitter.com/andre/status/1234567890",
    "https://mobile.twitter.com/andre/status/1234567890/",
    "  https://x.com/andre/status/1234567890  ",
    "https://x.com/andre/status/1234567890/photo/1",
  ]) {
    assert.equal(parsePostUrl(u)?.handle, "andre", u);
  }
});

// A host that merely ends in x.com is somebody else's domain, and this is the check
// that a `.endsWith()` would have got wrong.
test("a lookalike host is not X", () => {
  for (const u of [
    "https://notx.com/andre/status/1",
    "https://x.com.evil.tld/andre/status/1",
    "https://evil.tld/x.com/andre/status/1",
    "javascript:alert(1)//x.com/a/status/1",
    "https://x.com/i/web/status/1234567890",
    "https://x.com/andre",
    "https://x.com/andre/status/notanumber",
    "https://x.com/this-handle-is-far-too-long/status/1",
    "not a url at all",
    "",
  ]) {
    assert.equal(parsePostUrl(u), null, u);
  }
});

test("a post has to be by the handle we verified, at any casing", () => {
  const u = "https://x.com/Andre/status/1234567890";
  assert.equal(postIsBy(u, "andre"), true);
  assert.equal(postIsBy(u, "@andre"), true, "people paste the @");
  assert.equal(postIsBy(u, "someone_else"), false);
});

// ── The position ────────────────────────────────────────────────────────────

test("an address that has not asked is not in a queue", () => {
  const { store, web } = fresh();
  const s = status(store, web, A);
  assert.equal(s.admitted, false);
  assert.equal(s.why, "not-joined");
  assert.equal(s.joined, false);
  assert.equal(s.position, null);
  assert.equal(s.cap, LIVE_MANDATE.maxLiveAccounts);
});

test("joining takes a place, and joining twice does not take a second one", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 5 * HOUR);
  web.joinQueue(B, null, T0 - 4 * HOUR);
  web.joinQueue(A, null, T0);            // re-pressed the button
  assert.equal(status(store, web, A).position, 1, "and it did not cost them their place");
  assert.equal(status(store, web, B).position, 2);
});

test("an admitted account is out of the queue and holds a dated slot", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 5 * HOUR);
  web.joinQueue(B, null, T0 - 4 * HOUR);
  const expires = new Date(T0 + 72 * HOUR);
  store.admit(A, "queue", expires, new Date(T0));

  const a = status(store, web, A);
  assert.equal(a.admitted, true);
  assert.equal(a.why, "admitted");
  assert.equal(a.position, null);
  assert.equal(a.admittedUntil, expires.toISOString());
  // And the person behind them moves up, because the queue is who is still waiting.
  assert.equal(status(store, web, B).position, 1);
});

test("an admission that has lapsed puts them back in line, and says which it is", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 5 * HOUR);
  store.admit(A, "queue", new Date(T0 - HOUR), new Date(T0 - 73 * HOUR));
  const a = status(store, web, A);
  assert.equal(a.admitted, false);
  assert.equal(a.why, "lapsed");
  assert.equal(a.position, 1, "still in the queue, not deleted from it");
});

test("an operator-named address never queues", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0);
  const s = status(store, web, A, { HL_LIVE_ACCOUNT: A.toUpperCase() });
  assert.equal(s.admitted, true);
  assert.equal(s.why, "pinned");
});

test("a referral counts once the account it brought links X, and not before", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 5 * HOUR);
  const code = web.queueEntry(A)!.ref_code;
  const referrer = web.queueEntryByRefCode(code)!;
  assert.equal(referrer.address, A.toLowerCase());

  web.joinQueue(B, A, T0 - 4 * HOUR);
  assert.equal(status(store, web, A).referrals, 0, "a signature is free");
  // Funding is deliberately not it: it happens after admission, so it could never
  // arrive while the referrer was still waiting.
  web.markQueueFunded(B, T0);
  assert.equal(status(store, web, A).referrals, 0, "funding must not count");
  web.linkX(B, "9002", "someone", T0);
  assert.equal(status(store, web, A).referrals, 1, "an X account is what costs something");
});

test("the referral code is short, stable, and not the address", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0);
  const code = web.queueEntry(A)!.ref_code;
  assert.equal(code, WebStore.refCode(A.toUpperCase()), "case must not decide this");
  assert.ok(code.length <= 12 && code.length >= 8);
  assert.ok(!code.toLowerCase().includes(A.slice(2, 10).toLowerCase()), "a queue is a list of wallets");
  assert.equal(status(store, web, A).refCode, code);
});

test("one X account cannot be attached to a second wallet", () => {
  const { web } = fresh();
  web.joinQueue(A, null, T0);
  web.joinQueue(B, null, T0);
  web.linkX(A, "9001", "andre", T0);
  assert.equal(web.walletForXUser("9001"), A.toLowerCase());
  assert.throws(() => web.linkX(B, "9001", "andre", T0), /UNIQUE|constraint/i,
    "the route checks first, and the table is what makes it true");
});

test("a post counts once — a second link replaces the URL and not the place", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 5 * HOUR);
  web.recordPost(A, "https://x.com/andre/status/1", T0 - 3 * HOUR);
  const first = web.queueEntry(A)!.posted_at;
  web.recordPost(A, "https://x.com/andre/status/2", T0);
  assert.equal(web.queueEntry(A)!.posted_at, first);
  assert.equal(web.queueEntry(A)!.post_url, "https://x.com/andre/status/2");
  assert.equal(status(store, web, A).posted, true);
});

test("an operator's invite puts an address at the front, joining it if it is new", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 5 * HOUR);
  web.joinQueue(B, null, T0 - 4 * HOUR);
  web.inviteToQueue(C, T0);
  assert.equal(status(store, web, C).position, 1);
  assert.deepEqual(queueListing(store, web, {}, T0).map((r) => r.address),
    [C.toLowerCase(), A.toLowerCase(), B.toLowerCase()]);
});

// Nothing on this payload counts anybody but the reader. Both figures that did — how
// many are waiting, and how many accounts are trading — came off on 2026-09-05, and this
// is the test that keeps them off.
test("the payload carries the reader's own place and no count of anybody else", () => {
  const { store, web } = fresh();
  web.joinQueue(A, null, T0 - 2 * HOUR);
  web.joinQueue(B, null, T0 - HOUR);
  const keys = Object.keys(status(store, web, B));
  assert.ok(keys.includes("position"), "their own place is the point of the screen");
  for (const gone of ["waiting", "liveNow", "referralCap"]) {
    assert.ok(!keys.includes(gone), `${gone} must not come back onto this payload`);
  }
  assert.equal(status(store, web, B).position, 2);
});

// ── The spending limit on the X handshake ───────────────────────────────────
//
// Every completed handshake is one paid call on our own X account, and reaching it
// costs an attacker a wallet signature, which is free. X skips its consent screen once
// an account has authorised an app, so without a count the loop is scriptable.

test("a wallet that has already linked is refused, and told why", () => {
  const v = canAttemptXLink({ handle: "andre", attemptsToday: 0 });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, "already");
  assert.match(!v.ok ? v.error : "", /@andre/, "the refusal names the handle it already has");
});

test("the day's attempts run out exactly at the limit, not one short of it", () => {
  for (let n = 0; n < 5; n++) {
    assert.equal(canAttemptXLink({ handle: null, attemptsToday: n, limit: 5 }).ok, true, `attempt ${n + 1}`);
  }
  const v = canAttemptXLink({ handle: null, attemptsToday: 5, limit: 5 });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, "limited");
});

test("the counter is per address and rolls over on the UTC day", () => {
  const { web } = fresh();
  web.joinQueue(A, null, T0);
  assert.equal(web.xAttemptsToday(A, "2026-09-05"), 0);
  assert.equal(web.bumpXAttempt(A, "2026-09-05"), 1);
  assert.equal(web.bumpXAttempt(A, "2026-09-05"), 2);
  assert.equal(web.xAttemptsToday(A.toUpperCase(), "2026-09-05"), 2, "case must not decide this");
  assert.equal(web.xAttemptsToday(B, "2026-09-05"), 0, "one wallet's spending is not another's");
  // A row from yesterday reads as zero, which is what makes the limit roll over
  // without anything having to sweep the table.
  assert.equal(web.xAttemptsToday(A, "2026-09-06"), 0);
  assert.equal(web.bumpXAttempt(A, "2026-09-06"), 1, "and the new day starts from one");
});

// ── What a post has to be ───────────────────────────────────────────────────
//
// Two things, and both are read from X rather than from the pasted URL: who wrote it,
// and what it links to. The handle in the path is a claim — X serves a post by id
// whatever handle is in front of it — so it survives only as a free pre-check.

test("a link to us is found in the post's own entities, at any path", () => {
  for (const u of [
    "https://mandate.markets/",
    "https://mandate.markets/?r=abc123",
    "https://www.mandate.markets/anything",
    "https://mandate.markets",
  ]) {
    assert.equal(postLinksTo([u], "mandate.markets"), true, u);
  }
});

test("a post that links somewhere else, or nowhere, is not a post about us", () => {
  assert.equal(postLinksTo([], "mandate.markets"), false);
  assert.equal(postLinksTo(["https://x.com/someone/status/1"], "mandate.markets"), false);
  assert.equal(postLinksTo(["https://mandate.markets.evil.tld/"], "mandate.markets"), false);
  assert.equal(postLinksTo(["https://notmandate.markets/"], "mandate.markets"), false);
  assert.equal(postLinksTo(["not a url"], "mandate.markets"), false);
});

test("the draft carries the referral code and no claim about returns", () => {
  const u = new URL(draftPost("mandate.markets", "abc123"));
  assert.equal(u.origin + u.pathname, "https://x.com/intent/post");
  const text = u.searchParams.get("text") ?? "";
  assert.match(text, /https:\/\/mandate\.markets\/\?r=abc123/, "a post that brings somebody counts twice");
  assert.match(text, /@QuotientHQ/, "whose outlooks these are is the one thing worth saying");
  assert.match(text, /@MandateMarkets/, "and whose execution");
  // X shows a post that *begins* with a mention only to people who follow both
  // accounts. A tagged draft that opens with a handle would be a quieter draft.
  assert.ok(!text.startsWith("@"), "a post that opens with a mention is a reply");
  for (const word of ["profit", "return", "%", "APY", "guaranteed"]) {
    assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `"${word}" must not be put in somebody's mouth`);
  }
});

test("without a referral code the draft still links to the site", () => {
  const text = new URL(draftPost("mandate.markets", null)).searchParams.get("text") ?? "";
  assert.match(text, /https:\/\/mandate\.markets\//);
});

test("the day's budget is shared by both paid calls", () => {
  assert.equal(canSpendXCall({ attemptsToday: 4, limit: 5 }).ok, true);
  const v = canSpendXCall({ attemptsToday: 5, limit: 5 });
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, "limited");
});
