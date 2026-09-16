import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  authorizeUrl, linkXAccount, newPkce, pkceCookie, readPkceCookie, readPost, stateMatches,
  xConfig,
} from "./xoauth.ts";

// **Both X calls have now met the live API**, which these tests could not assume when
// they were written: the token exchange and `/2/users/me` on 2026-09-05 for a cent, and
// `/2/tweets/:id` on 2026-09-06 for half of one. What they hold is the part that does not
// need a vendor on every run — the PKCE arithmetic, the URL we send somebody to, the
// cookie the verifier rides in, and how each response is read — plus, below, the real
// captured post, so the vendor's actual shape is asserted rather than remembered.
// `notes/2026-09-05-access-queue.md` §7 and §7b are the records.

const ORIGIN = "https://mandate.markets";
const CFG = { clientId: "cid", clientSecret: null, redirectUri: `${ORIGIN}/api/x/callback` };

test("with no client id there is no app, and that is the shipped state", () => {
  assert.equal(xConfig(ORIGIN, {}), null);
  assert.equal(xConfig(ORIGIN, { X_CLIENT_ID: "  " }), null);
  const cfg = xConfig(ORIGIN, { X_CLIENT_ID: "cid" });
  assert.equal(cfg?.clientSecret, null, "a public PKCE client is the default");
  assert.equal(cfg?.redirectUri, `${ORIGIN}/api/x/callback`);
});

test("the challenge is the S256 of the verifier, which is the whole point of PKCE", () => {
  const p = newPkce();
  assert.equal(p.challenge, createHash("sha256").update(p.verifier).digest("base64url"));
  assert.ok(p.verifier.length >= 43, "RFC 7636 wants at least 43 characters");
  assert.notEqual(p.state, p.verifier);
});

test("the authorize URL asks for exactly the two scopes and no refresh token", () => {
  const p = newPkce();
  const u = new URL(authorizeUrl(CFG, p));
  assert.equal(u.origin + u.pathname, "https://x.com/i/oauth2/authorize");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("client_id"), "cid");
  assert.equal(u.searchParams.get("redirect_uri"), CFG.redirectUri);
  assert.equal(u.searchParams.get("scope"), "users.read tweet.read");
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), p.challenge);
  assert.equal(u.searchParams.get("state"), p.state);
  // We identify once and keep nothing: no offline.access means no refresh token to
  // store, and nothing of theirs to leak later.
  assert.ok(!u.search.includes("offline.access"));
});

test("the verifier rides in a cookie that survives X's cross-site redirect", () => {
  const p = newPkce();
  const c = pkceCookie(p, true);
  // Strict would strip the cookie from the callback navigation, and the handshake
  // would arrive looking exactly like a forgery.
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /Path=\/api\/x/);
  assert.deepEqual(readPkceCookie(c.split(";")[0]), { state: p.state, verifier: p.verifier });
});

test("a missing or malformed cookie is null rather than half a handshake", () => {
  assert.equal(readPkceCookie(undefined), null);
  assert.equal(readPkceCookie("session=abc"), null);
  assert.equal(readPkceCookie("x_pkce="), null);
  assert.equal(readPkceCookie("x_pkce=nodothere"), null);
  assert.equal(readPkceCookie("x_pkce=.verifier"), null);
  assert.equal(readPkceCookie("x_pkce=state."), null);
});

test("state is compared by value and length, never by prefix", () => {
  assert.equal(stateMatches("abc", "abc"), true);
  assert.equal(stateMatches("abc", "abd"), false);
  assert.equal(stateMatches("abc", "abcd"), false);
  assert.equal(stateMatches("", ""), true);
});

// ── Reading the two responses ───────────────────────────────────────────────

function fakeFetch(steps: { status: number; body: string }[], seen: { url: string; init?: RequestInit }[] = []) {
  let i = 0;
  const impl = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    const s = steps[i++] ?? { status: 500, body: "no more steps" };
    return { ok: s.status >= 200 && s.status < 300, status: s.status, text: async () => s.body };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

test("a successful link yields the id and the handle and keeps nothing else", async () => {
  const { impl, seen } = fakeFetch([
    { status: 200, body: JSON.stringify({ access_token: "tok", scope: "users.read tweet.read" }) },
    { status: 200, body: JSON.stringify({ data: { id: "9001", username: "andre", name: "Andre" } }) },
  ]);
  const user = await linkXAccount(CFG, "the-code", "the-verifier", impl);
  assert.deepEqual(user, { id: "9001", handle: "andre" });

  const body = String((seen[0]!.init as { body: URLSearchParams }).body);
  assert.match(body, /code_verifier=the-verifier/);
  assert.match(body, /grant_type=authorization_code/);
  assert.match(seen[1]!.url, /\/2\/users\/me$/);
  assert.equal((seen[1]!.init!.headers as Record<string, string>).authorization, "Bearer tok");
});

test("a confidential app authenticates the token call, a public one does not", async () => {
  const pub = fakeFetch([
    { status: 200, body: JSON.stringify({ access_token: "t" }) },
    { status: 200, body: JSON.stringify({ data: { id: "1", username: "a" } }) },
  ]);
  await linkXAccount(CFG, "c", "v", pub.impl);
  assert.equal((pub.seen[0]!.init!.headers as Record<string, string>).authorization, undefined);

  const conf = fakeFetch([
    { status: 200, body: JSON.stringify({ access_token: "t" }) },
    { status: 200, body: JSON.stringify({ data: { id: "1", username: "a" } }) },
  ]);
  await linkXAccount({ ...CFG, clientSecret: "sec" }, "c", "v", conf.impl);
  assert.equal(
    (conf.seen[0]!.init!.headers as Record<string, string>).authorization,
    "Basic " + Buffer.from("cid:sec").toString("base64"),
  );
});

// This is the surface most likely to be wrong on first contact with the vendor, so the
// vendor's own status and body travel into our log rather than being flattened.
test("every failure says what X actually answered", async () => {
  const bad = fakeFetch([{ status: 400, body: '{"error":"invalid_request"}' }]);
  await assert.rejects(() => linkXAccount(CFG, "c", "v", bad.impl), /400.*invalid_request/s);

  const notJson = fakeFetch([{ status: 200, body: "<html>rate limited</html>" }]);
  await assert.rejects(() => linkXAccount(CFG, "c", "v", notJson.impl), /not JSON/);

  const noToken = fakeFetch([{ status: 200, body: "{}" }]);
  await assert.rejects(() => linkXAccount(CFG, "c", "v", noToken.impl), /no access_token/);

  const noUser = fakeFetch([
    { status: 200, body: JSON.stringify({ access_token: "t" }) },
    { status: 200, body: JSON.stringify({ data: {} }) },
  ]);
  await assert.rejects(() => linkXAccount(CFG, "c", "v", noUser.impl), /no id or username/);

  const meFailed = fakeFetch([
    { status: 200, body: JSON.stringify({ access_token: "t" }) },
    { status: 429, body: "Too Many Requests" },
  ]);
  await assert.rejects(() => linkXAccount(CFG, "c", "v", meFailed.impl), /429/);
});

// ── Reading a post, against the response X actually sent ────────────────────

// fixtures/x-post-2026-09-06.json — a real `GET /2/tweets/:id` body, captured 2026-09-06.
// Everything below is asserted against it rather than against a body we invented, because
// this endpoint's shape was a guess until that call was made.
const POST_BODY = readFileSync("fixtures/x-post-2026-09-06.json", "utf8");

test("a real post yields the author X vouches for and the links it actually carries", async () => {
  const { impl, seen } = fakeFetch([{ status: 200, body: POST_BODY }]);
  const post = await readPost("app-only", "1460323737035677698", impl);

  // The whole point of the paid call: `author_id` is X's answer, not the pasted handle.
  assert.equal(post.authorId, "2244994945");
  assert.deepEqual(post.urls, [
    "https://blog.twitter.com/developer/en_us/topics/tools/2021/build-whats-next-with-the-new-twitter-developer-platform",
    "https://x.com/TwitterDev/status/1460323737035677698/video/1",
  ]);

  // Both of these are why the request is spelled the way it is. Without the expansion
  // `author_id` is not on `data` at all, and without the field there are no entities —
  // and a post with neither reads as "wrote nothing, linked nowhere" rather than failing.
  assert.match(seen[0]!.url, /expansions=author_id/);
  assert.match(seen[0]!.url, /tweet\.fields=entities/);
  assert.equal((seen[0]!.init!.headers as Record<string, string>).authorization, "Bearer app-only");
});

// Two findings from that capture, pinned because both are places where a plausible
// change to `readPost` would still pass every invented fixture.
test("the capture's own shape: no unwound_url anywhere, and media adds a link nobody typed", () => {
  const entries = (JSON.parse(POST_BODY) as {
    data: { entities: { urls: { expanded_url?: string; unwound_url?: string }[] } };
  }).data.entities.urls;

  // `readPost` prefers `unwound_url` and falls back to `expanded_url`. On the only real
  // response we have, X sent no `unwound_url` at all — so the fallback is the branch that
  // actually runs, and nothing may be built on the preferred one being there.
  assert.equal(entries.some((u) => u.unwound_url !== undefined), false);

  // The second entry is the post's attached video, not a link its author wrote. It is
  // harmless against a host comparison against ours, and a trap for anything that counts
  // links or treats urls[0] as the one somebody meant.
  assert.equal(entries.length, 2);
  assert.match(entries[1]!.expanded_url!, /^https:\/\/x\.com\/.*\/video\/1$/);
});

test("a post that is gone comes back 200 with errors, and must not read as success", async () => {
  // The shape most likely to be mistaken for success: deleted, private and non-existent
  // posts are all a 200 with `errors` and no `data`.
  const gone = fakeFetch([{
    status: 200,
    body: JSON.stringify({ errors: [{ title: "Not Found Error", detail: "Could not find tweet with id: [1]." }] }),
  }]);
  await assert.rejects(() => readPost("t", "1", gone.impl), /no post for that link.*Could not find/s);

  const noJson = fakeFetch([{ status: 200, body: "<html>rate limited</html>" }]);
  await assert.rejects(() => readPost("t", "1", noJson.impl), /not JSON/);

  // X's own status and body travel into our log, for the same reason the link call's do.
  const refused = fakeFetch([{ status: 403, body: '{"title":"Client Forbidden"}' }]);
  await assert.rejects(() => readPost("t", "1", refused.impl), /403.*Client Forbidden/s);
});
