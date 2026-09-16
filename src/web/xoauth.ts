import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// Linking an X account, by OAuth 2.0 with PKCE (`tasks/17` §3).
//
// **What this is for, and what it is not.** It attaches an X handle to a wallet so
// that a pasted post URL can be checked against its author. It is not a sign-in: the
// wallet is the identity here and always was, and nothing about a session depends on
// X. We ask for `users.read tweet.read` and deliberately **not** `offline.access`, so
// there is no refresh token to store and the access token is used once, inside one
// request, and dropped. Nothing about the person's X account is written down beyond
// the numeric id and the handle.
//
// **Every call to X costs money and there is no free tier** (Eater's price list,
// checked 2026-09-03): `GET /2/users/me` is *User: Read* at $0.01, and at a zero
// balance requests are **blocked outright**. That is why the feature is absent rather
// than broken when unconfigured, and why the client id must not be set on the box
// until credits have actually been bought — a configured id with no credits means
// somebody clears X's consent screen and lands on a dead callback, which is the worse
// failure, further in, and reads as our bug.
//
// **None of the network shapes below have been exercised against the live API.** We
// have no X developer app yet, so this ships dark: `xConfigured()` is false, the
// button is not rendered and the routes answer 503. The vendor-documented request and
// response shapes are what is coded, and this project's rule is that a vendor's
// documentation has been wrong at least once — so the first configured run is a
// verification step with its own note, not a deploy that is assumed to work.

const AUTHORIZE = "https://x.com/i/oauth2/authorize";
const TOKEN = "https://api.x.com/2/oauth2/token";
const ME = "https://api.x.com/2/users/me";
const POST = "https://api.x.com/2/tweets";
const SCOPES = "users.read tweet.read";

/** Ten minutes: long enough to read a consent screen, short enough that an abandoned
 *  attempt does not leave a verifier lying in a browser for the afternoon. */
export const PKCE_TTL_MS = 10 * 60_000;

/** How many times one wallet may run the link handshake in a UTC day.
 *
 *  **This is a spending limit.** Each completed handshake is one paid `/2/users/me`
 *  ($0.01), and reaching it costs an attacker only a wallet signature, which is free.
 *  X skips its own consent screen once an account has authorised an app, so without a
 *  count the loop is scriptable: authorize → callback → a cent, as fast as HTTP
 *  allows. Five is far more than a person needs — the honest number is one, and the
 *  slack is for a wallet that gets it wrong, changes its mind, or loses a redirect.
 *
 *  What it does **not** bound is fresh wallets: each one is a signature and a cent.
 *  The dollar backstop for that is the Billing Cycle Cap on the X account itself,
 *  which is a number in their console and not ours. Both are needed and neither
 *  substitutes for the other. */
export const X_LINK_ATTEMPTS_PER_DAY = 5;

/** The app-only bearer token, or null. Separate from the client id and secret because
 *  it buys a different thing: the client pair identifies a *person* (`/2/users/me`,
 *  $0.01), and this reads a *post* (`GET /2/tweets/:id`, $0.005) with no user context.
 *
 *  Generated in X's console under Keys & Tokens → App-Only Authentication. Unset, the
 *  post boost is not offered at all — the same rule the client id follows, and for the
 *  same reason: a check we cannot make must not be a promise we display. Linking X
 *  still works without it, because a linked handle is also what makes a referral count. */
export function xBearer(env: NodeJS.ProcessEnv = process.env): string | null {
  return (env.X_BEARER_TOKEN ?? "").trim() || null;
}
export const PKCE_COOKIE = "x_pkce";

export type XConfig = { clientId: string; clientSecret: string | null; redirectUri: string };

/** The app's credentials, or null when there is no app. Null is the shipped state and
 *  every caller must handle it — see the module comment for why that is deliberate. */
export function xConfig(origin: string, env: NodeJS.ProcessEnv = process.env): XConfig | null {
  const clientId = (env.X_CLIENT_ID ?? "").trim();
  if (clientId === "") return null;
  return {
    clientId,
    clientSecret: (env.X_CLIENT_SECRET ?? "").trim() || null,
    // Must match the callback registered on the X app **exactly**, including the
    // scheme and any trailing slash, or the authorize step fails before the person
    // ever sees a consent screen.
    redirectUri: `${origin}/api/x/callback`,
  };
}

export type Pkce = { state: string; verifier: string; challenge: string };

/** A fresh state and PKCE pair. The verifier is 43 unreserved characters, which is the
 *  shortest RFC 7636 allows and the length X's own examples use. */
export function newPkce(): Pkce {
  const state = randomBytes(16).toString("hex");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { state, verifier, challenge };
}

export function authorizeUrl(cfg: XConfig, p: Pkce): string {
  // Built by hand rather than with `URLSearchParams`, for one character: that encodes
  // the space between the two scopes as `+`, and X's own documentation and examples
  // use `%20`. Both are legal in a query string and we cannot test which one X's
  // authorize endpoint accepts without an app, so this sends the spelling the vendor
  // publishes.
  const q = Object.entries({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: SCOPES,
    state: p.state,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
  }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  return `${AUTHORIZE}?${q}`;
}

/** The cookie the state and verifier travel in.
 *
 *  They are carried in the browser rather than in a table because they are one
 *  browser's half-finished handshake and nothing else's: a row would have to be keyed,
 *  swept and reasoned about, and a cookie expires by itself. `SameSite=Lax` is
 *  required — X's callback is a cross-site top-level navigation, which `Strict` would
 *  strip the cookie from, and the request would arrive looking like a forgery. */
export function pkceCookie(p: Pkce, secure: boolean): string {
  const bits = [
    `${PKCE_COOKIE}=${p.state}.${p.verifier}`,
    "Path=/api/x", "HttpOnly", "SameSite=Lax",
    `Max-Age=${Math.floor(PKCE_TTL_MS / 1000)}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

export function clearPkceCookie(secure: boolean): string {
  const bits = [`${PKCE_COOKIE}=`, "Path=/api/x", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

/** Pull the state and verifier back out of a Cookie header. */
export function readPkceCookie(header: string | undefined): { state: string; verifier: string } | null {
  const raw = (header ?? "").split(";").map((c) => c.trim())
    .find((c) => c.startsWith(`${PKCE_COOKIE}=`))?.slice(PKCE_COOKIE.length + 1);
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { state: raw.slice(0, dot), verifier: raw.slice(dot + 1) };
}

/** Constant-time compare of the state we issued and the state that came back. Not
 *  because the state is a secret worth timing, but because doing it the other way
 *  invites the habit. Length mismatch is answered before the compare, which
 *  `timingSafeEqual` requires. */
export function stateMatches(issued: string, returned: string): boolean {
  const a = Buffer.from(issued), b = Buffer.from(returned);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type XUser = { id: string; handle: string };

/** Exchange the code and read who authorised it, in one step because there is nothing
 *  to do between them and the token is not kept.
 *
 *  `fetchImpl` is injected so the tests can drive both halves without a network or an
 *  app. Errors carry the vendor's own status and body: this is the surface most likely
 *  to be wrong on first contact, and a generic "X sign-in failed" would hide exactly
 *  the sentence that says why. */
export async function linkXAccount(
  cfg: XConfig,
  code: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<XUser> {
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
    client_id: cfg.clientId,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  // A confidential app authenticates the token call with Basic; a public one relies on
  // PKCE alone. Which one this is depends on how the app was created on X's side, so
  // the presence of a secret decides it rather than a second setting to get wrong.
  if (cfg.clientSecret !== null) {
    headers.authorization = "Basic " +
      Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  }

  const tokenRes = await fetchImpl(TOKEN, { method: "POST", headers, body });
  const tokenText = await tokenRes.text();
  if (!tokenRes.ok) throw new Error(`X token exchange failed (${tokenRes.status}): ${tokenText.slice(0, 300)}`);
  let token: string;
  try {
    token = (JSON.parse(tokenText) as { access_token?: string }).access_token ?? "";
  } catch {
    throw new Error("X token exchange returned something that is not JSON");
  }
  if (token === "") throw new Error("X token exchange returned no access_token");

  const meRes = await fetchImpl(ME, { headers: { authorization: `Bearer ${token}` } });
  const meText = await meRes.text();
  if (!meRes.ok) throw new Error(`X /2/users/me failed (${meRes.status}): ${meText.slice(0, 300)}`);
  let me: { data?: { id?: string; username?: string } };
  try {
    me = JSON.parse(meText) as typeof me;
  } catch {
    throw new Error("X /2/users/me returned something that is not JSON");
  }
  const id = me.data?.id ?? "";
  const handle = me.data?.username ?? "";
  if (id === "" || handle === "") throw new Error("X /2/users/me returned no id or username");
  return { id, handle };
}

/** What a post is, as far as we are concerned: who really wrote it and what it links to.
 *
 *  **The author comes from here and not from the URL somebody pasted.** X serves a post
 *  by id whatever handle sits in the path — `x.com/anyone/status/<id>` resolves to the
 *  real thing — so a handle in a pasted link is a claim, not evidence, and checking it
 *  alone let anybody present somebody else's post as their own. This is the check that
 *  makes authorship a fact.
 *
 *  Links come from `entities.urls[].expanded_url`, never from the text: X rewrites every
 *  URL in a post to `t.co`, so matching on the text would match nothing. `unwound_url`
 *  is preferred when present — it is where a shortener finally lands — but on the one
 *  real response we have captured it is **absent on every entry**, so the fallback is the
 *  branch that runs (`fixtures/x-post-2026-09-06.json`,
 *  `notes/2026-09-05-access-queue.md` §7b). That capture also shows `entities.urls`
 *  carrying a link the author never typed: an attached image or video adds an `x.com`
 *  entry of its own. Harmless here, because we ask whether *any* link points at our host
 *  and never count them. */
export async function readPost(
  bearer: string,
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ authorId: string; urls: string[] }> {
  const url = `${POST}/${encodeURIComponent(id)}?tweet.fields=entities&expansions=author_id`;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${bearer}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`X post lookup failed (${res.status}): ${text.slice(0, 300)}`);
  let body: {
    data?: { author_id?: string; entities?: { urls?: { expanded_url?: string; unwound_url?: string }[] } };
    errors?: { detail?: string; title?: string }[];
  };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error("X post lookup returned something that is not JSON");
  }
  // A deleted, private or non-existent post comes back 200 with `errors` and no `data`,
  // which is the shape most likely to be mistaken for success.
  if (!body.data?.author_id) {
    const why = body.errors?.[0]?.detail ?? body.errors?.[0]?.title ?? "no data";
    throw new Error(`X returned no post for that link (${why})`);
  }
  const urls = (body.data.entities?.urls ?? [])
    .map((u) => u.unwound_url ?? u.expanded_url ?? "")
    .filter((u) => u !== "");
  return { authorId: body.data.author_id, urls };
}
