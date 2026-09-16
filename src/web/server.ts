import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import "dotenv/config";
import { makeInfoClient, isTestnet } from "../hl/clients.ts";
import { Universe } from "../hl/universe.ts";
import { SKIP_RETENTION_DAYS, Store } from "../store/db.ts";
import { isPinned } from "../exec/settings.ts";
import { liveAllowlist } from "../exec/mode.ts";
import { admissionState } from "../exec/queue.ts";
import {
  accountCard, cardDescription, cardTitle, homeCard, parseAccount, parsePosition, parseTrade,
  positionCard, SOCIAL_CLOSE, SOCIAL_OPEN, socialTags, tradeCard, type CardModel,
} from "./cards.ts";
import { canChangeMandate, canChangeSettings, changeStatus } from "./changes.ts";
import {
  canUnlink, connectStatus, parseReferralCode, parseSettings, readConnectBalance, seedForNewConnect,
} from "./connect.ts";
import { defaultBlockComplete } from "../ops/config-event.ts";
import {
  canAttemptXLink, canSpendXCall, parsePostUrl, postIsBy, postLinksTo, queueStatus,
} from "./queue.ts";
import {
  authorizeUrl, clearPkceCookie, linkXAccount, newPkce, pkceCookie, readPkceCookie,
  readPost, stateMatches, xBearer, xConfig,
} from "./xoauth.ts";
import { dayKey } from "../risk/ledger.ts";
import { readPortfolio } from "../hl/portfolio.ts";
import { buildDesk, buildSignalHistory, buildTradeHistory, labelSkip } from "./desk.ts";
import { llmsTxt, robotsTxt, sitemapXml } from "./discovery.ts";
import { ICONS } from "./icons.ts";
import { canClearHalt } from "../risk/halt.ts";
import { heartbeatFor, readExecHeartbeat } from "./heartbeat.ts";
import { buildLeaderboard } from "./leaderboard.ts";
import { CardRenderer, loadCardFonts } from "./render.ts";
import { builderRail } from "../hl/approve-builder-fee.ts";
import { REFERRAL_CODE, REFERRAL_DISCOUNT_PCT, REFERRAL_LINK, REFERRAL_SHARE_PCT, referralState } from "../hl/referral.ts";
import { currentFee, feeRequiredFor, prepareApproval, relayApproval } from "./builder-fee.ts";
import { prepareRenewal, relayStep, type RenewStep } from "./renew.ts";
import { shareAccount, sharePosition, shareTrade } from "./share.ts";
import {
  clearCookie, isAddress, issueChallenge, login,
  sessionCookie, sessionIdFromCookie,
} from "./auth.ts";
import { SESSION_TTL_MS, WebStore, webStorePath } from "./sessions.ts";

// The public web tier. Stage 0 of docs/MULTI-TENANT.md: sign in with a wallet, read
// your own desk. Nothing here writes to the trading ledger — it is opened read-only
// and SQLite enforces that, not a convention.
//
// `node:http` with a hand-rolled router rather than a framework. The whole surface is
// a dozen routes; a dependency would be more code to audit than the router it replaces.
// The dependency list was three entries long for that reason and is now five: `tasks/16`
// added `satori` and `@resvg/resvg-js`, which is the smallest PNG renderer that exists
// — the alternatives were a browser on the trading box or drawing by hand into an
// encoder. Both are reached only from `src/web/render.ts`, and only by the two routes
// that draw a picture.

const PORT = Number(process.env.WEB_PORT ?? 8788);
const HOST = process.env.WEB_HOST ?? "127.0.0.1";
const DOMAIN = process.env.WEB_DOMAIN ?? "mandate.markets";
const ORIGIN_URI = process.env.WEB_ORIGIN ?? `https://${DOMAIN}`;
/** Behind Caddy in production, so the cookie must be Secure even though this process
 *  speaks plain HTTP on loopback. Off only for local development. */
const SECURE_COOKIES = process.env.WEB_INSECURE_COOKIES !== "true";
const PAGE = process.env.WEB_PAGE ?? "design/dist/mandate.html";
/** Files served beside the page. Today one interim favicon (`tasks/20` §3); the
 *  designer's mark lands as files here too, served rather than embedded, because a
 *  PNG as a data URI in the head is a download on every page view for something the
 *  browser caches once. */
const STATIC_DIR = process.env.WEB_STATIC ?? "design/static";
/** The key the share-card signatures are cut from (`tasks/16` §1). Unset, the product
 *  card still renders and every signed card is refused — the share button reports that
 *  rather than composing a link nothing will verify. It lives in `.env` beside the
 *  other secrets and not in the unit file, and it is not a trading credential: the
 *  worst a leak buys is a card with figures we did not settle. */
const SHARE_SECRET = process.env.SHARE_SECRET || null;
const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? `${DATA_ROOT}/signaldesk.sqlite`;
const MAX_BODY = 8 * 1024;
/** How far back `/api/signals` will look, whatever the caller asks for. Matches the
 *  executor's own `SKIP_RETENTION_DAYS`, so the cap and the data run out together. */
const SIGNAL_WINDOW_MAX_MS = SKIP_RETENTION_DAYS * 86_400_000;

// ── The page, and a Content-Security-Policy derived from it ─────────────────
//
// The design ships as one self-contained file with an inline <style> and an inline
// <script>, which normally forces 'unsafe-inline' and guts the policy. Hashing the
// blocks at startup keeps a real CSP: the exact two blocks we shipped may run, and
// nothing else — including anything injected later.
//
// **A hash covers `<style>` elements and not `style` attributes**, and getting that
// wrong is silent. CSP3 routes attributes through `style-src-attr`, which falls back
// to `style-src` when absent — and a hash there matches no attribute, so every one is
// dropped with no console error and no visual clue that the page is not the page we
// designed. It shipped that way: all 59 inline styles in `design/mandate.html` were
// being discarded on mandate.markets, measured in the browser 2026-08-31
// (`max-width:640px` computing to `none`, `margin-top:10px` to `0px`).
// `notes/2026-08-31-csp-style-attributes.md` has the capture.
//
// So `style-src-attr 'unsafe-inline'` is stated explicitly. It is a real concession —
// an injected `style` attribute is no longer refused — and it is a small one: anyone
// able to inject an attribute into this DOM can already inject markup, `script-src`
// stays hash-locked, and `default-src 'none'` leaves CSS with nowhere to fetch from.
// Naming it as its own directive rather than adding 'unsafe-inline' to `style-src` is
// the point: `<style>` elements stay hash-locked, and only attributes are relaxed.

type Page = {
  html: string; csp: string; etag: string;
  /** The page either side of its social block (`tasks/16` §3). A share landing path
   *  serves `before + its own tags + after`: the `<script>` and `<style>` blocks the
   *  CSP hashes are in neither half's way, so one policy covers every variant and the
   *  etag is recomputed per variant rather than shared. Null when the markers are
   *  absent, which means share landings fall back to the plain page — a link that
   *  renders the way it did before this task, rather than a 500. */
  split: { before: string; after: string } | null;
};
type Static = { body: string; etag: string };
/** A file served as bytes: the icons, and nothing else so far. */
type Asset = { body: Buffer; type: string; etag: string };

const etagOf = (s: string | Buffer) => `"${createHash("sha256").update(s).digest("hex").slice(0, 32)}"`;

function loadIcon(path: string, type: string): Asset {
  const body = readFileSync(path);
  return { body, type, etag: etagOf(body) };
}

function loadPage(path: string): Page {
  const html = readFileSync(path, "utf8");
  const sha = (s: string) => `'sha256-${createHash("sha256").update(s, "utf8").digest("base64")}'`;
  // A `<script type="application/ld+json">` is a data block the browser never runs,
  // and CSP does not govern it — so it is left out of the hash list rather than
  // widening `script-src` with a hash nothing will ever match. The page's structured
  // data (`tasks/15`) is the one such block.
  const blocks = (tag: "script" | "style") =>
    [...html.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g"))]
      .filter((m) => !/application\/ld\+json/.test(m[1] ?? ""))
      .map((m) => sha(m[2]!));

  const csp = [
    "default-src 'none'",
    `script-src ${blocks("script").join(" ") || "'none'"}`,
    `style-src ${blocks("style").join(" ") || "'none'"}`,
    // Not covered by the hash above, and silently dropped without this. See the note.
    "style-src-attr 'unsafe-inline'",
    "font-src data:",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

  const open = html.indexOf(SOCIAL_OPEN);
  const close = html.indexOf(SOCIAL_CLOSE);
  const split = open === -1 || close < open
    ? null
    : { before: html.slice(0, open + SOCIAL_OPEN.length), after: html.slice(close) };

  return { html, csp, etag: etagOf(html), split };
}

/** The page with one card's tags in its head, and everything else identical.
 *
 *  Cached by landing URL and capped, for the same reason the PNG cache is: a scraper
 *  fetches each of these once, and an unbounded map keyed by a URL a stranger chooses
 *  is a way to ask this process to hold every signature it is handed. A miss costs one
 *  string concatenation. */
const variantCache = new Map<string, Static>();
const VARIANT_CAP = 256;

function pageVariant(page: Page, key: string, tags: string): Static {
  const hit = variantCache.get(key);
  if (hit) return hit;
  const html = page.split === null ? page.html : page.split.before + "\n" + tags + "\n" + page.split.after;
  const out = { body: html, etag: etagOf(html) };
  if (variantCache.size >= VARIANT_CAP) {
    const oldest = variantCache.keys().next();
    if (!oldest.done) variantCache.delete(oldest.value);
  }
  variantCache.set(key, out);
  return out;
}

// ── Venue reads, cached for display only ────────────────────────────────────
//
// Hyperliquid is authoritative and must never be cached across a *decision*. This
// cache serves a *screen*: a browser polling every few seconds must not become a
// matching number of venue reads. It is deliberately not exported and deliberately
// short — nothing in the execution path can reach it.

const VENUE_TTL_MS = 3_000;
const deskCache = new Map<string, { at: number; payload: unknown }>();
/** One entry, not a map: the leaderboard is the same answer for every reader allowed
 *  to have it. */
const LEADERBOARD_TTL_MS = 15_000;
let leaderboardCache: { at: number; payload: unknown } | null = null;
/** Same rule, separate map: the connect screen polls while someone is funding an
 *  account, and that must not become one Hyperliquid read per poll per person. */
const balanceCache = new Map<string, { at: number; payload: unknown }>();
/** The equity curve, which moves on Hyperliquid's own ~2-hourly grid — measured
 *  2026-09-08, `notes/2026-09-08-balance-chart-feasibility.md`. Three seconds would be
 *  a fresh 18.8 KB round trip for a series that is byte-identical for two hours, so
 *  this one is minutes. It is still short of the grid: the desk should pick up a new
 *  point within a few minutes of it existing, not two hours later. */
const HISTORY_TTL_MS = 120_000;
const historyCache = new Map<string, { at: number; payload: unknown }>();

type Ctx = {
  store: Store;
  web: WebStore;
  venue: { info: ReturnType<typeof makeInfoClient>; universe: Universe } | null;
  page: Page;
  icons: Map<string, Asset>;
  /** Null when the fonts are not on disk. The desk and every API still work; the image
   *  routes answer 503 and a pasted link renders the way it did before `tasks/16`. */
  cards: CardRenderer | null;
};

// ── Small HTTP helpers ──────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: string | Buffer, headers: Record<string, string>): void {
  res.writeHead(status, {
    "content-length": Buffer.byteLength(body),
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(body), { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function str(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  return typeof v === "string" ? v : "";
}

/** What `src/web/renew.ts` needs, assembled from the request context. `ctx.venue` is
 *  checked by the caller — a renewal cannot be built without reading the venue. */
function renewDeps(ctx: Ctx) {
  return { info: ctx.venue!.info, testnet: isTestnet(), now: () => Date.now() };
}

/** What `src/web/builder-fee.ts` needs. `prepare` needs no venue — the action is built
 *  from our own constants — so only the routes that read an approval check `ctx.venue`,
 *  and `info` is reached through the same non-null assertion those routes guard. */
function feeDeps(ctx: Ctx) {
  return { info: ctx.venue!.info, testnet: isTestnet(), now: () => Date.now() };
}

/** Which card a `/share/*.png` path means, and whether its numbers verified.
 *
 *  The cache key is built from the **parsed** parameters and not from the query as it
 *  arrived, so `?p=0004` and `?p=4` — one signature, two spellings — are one entry
 *  rather than two renders of the same picture. */
function shareCard(path: string, q: URLSearchParams): { key: string; model: CardModel; signed: boolean } | null {
  const fallback = { key: "home", model: homeCard(), signed: false };
  if (path === "/share/home.png") return fallback;
  const key = (kind: string, p: Record<string, number>) =>
    `${kind}:${Object.keys(p).sort().map((k) => `${k}=${p[k]}`).join("&")}`;
  if (path === "/share/trade.png") {
    const p = parseTrade(q, SHARE_SECRET);
    return p ? { key: key("trade", p), model: tradeCard(p), signed: true } : fallback;
  }
  if (path === "/share/position.png") {
    const p = parsePosition(q, SHARE_SECRET);
    return p ? { key: key("position", p), model: positionCard(p), signed: true } : fallback;
  }
  if (path === "/share/account.png") {
    const p = parseAccount(q, SHARE_SECRET);
    return p ? { key: key("account", p), model: accountCard(p), signed: true } : fallback;
  }
  return null;
}

/** What the account holds, cached for the length of a poll.
 *
 *  Shared by the connect screen and the queue: the connect screen polls it while
 *  somebody is depositing, and the queue reads it to decide whether an account is
 *  funded — which is what makes somebody else's referral of it count. One read, one
 *  cache, one answer, so the two screens cannot disagree about the same balance.
 *
 *  The settings this account has chosen decide the floor. Before it has chosen any,
 *  the defaults do — and the page recomputes the number live as the sliders move. */
async function cachedBalance(ctx: Ctx, address: string): Promise<unknown> {
  const hit = balanceCache.get(address);
  if (hit && Date.now() - hit.at < VENUE_TTL_MS) return hit.payload;
  const chosen = connectStatus(ctx.store, ctx.web, address, DATA_ROOT).settings;
  const payload = await readConnectBalance(ctx.venue!.info, address, chosen ?? undefined);
  balanceCache.set(address, { at: Date.now(), payload });
  return payload;
}

/** Whether this address may enter the connect flow at all (`tasks/17`).
 *
 *  The same pure decision the executor makes before it mints a key, from the same
 *  function — this side is the sentence a person reads, and that side is what makes a
 *  written row insufficient. */
function admission(ctx: Ctx, address: string) {
  return admissionState({
    pinned: liveAllowlist().includes(address.toLowerCase()),
    hasAccountRow: ctx.store.account(address) !== null,
    connectionStatus: ctx.store.connection(address)?.status ?? null,
    admissionExpiresAt: ctx.store.admission(address)?.expires_at ?? null,
    now: Date.now(),
  });
}

/** The queue payload, assembled the same way wherever it is returned. */
function queuePayload(ctx: Ctx, address: string) {
  return queueStatus({
    store: ctx.store, web: ctx.web, address,
    xConfigured: xConfig(ORIGIN_URI) !== null,
    postCheckable: xBearer() !== null,
    domain: DOMAIN,
  });
}

function currentAddress(ctx: Ctx, req: IncomingMessage): string | null {
  const id = sessionIdFromCookie(req.headers.cookie);
  if (!id) return null;
  return ctx.web.session(id)?.address ?? null;
}

// ── Routes ──────────────────────────────────────────────────────────────────

async function route(ctx: Ctx, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? DOMAIN}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (!path.startsWith("/api/")) {
    if (method !== "GET" && method !== "HEAD") return json(res, 405, { error: "method not allowed" });

    // What a robot gets (`tasks/15`). Each is generated from the runtime origin and
    // the risk parameters rather than committed — `src/web/discovery.ts` says why —
    // and each answers with its own content type instead of the 258 KB page every
    // path used to serve.
    const text = (body: string, type: string) =>
      send(res, 200, body, { "content-type": type, "cache-control": "public, max-age=3600" });
    if (path === "/robots.txt") return text(robotsTxt(ORIGIN_URI), "text/plain; charset=utf-8");
    if (path === "/sitemap.xml") return text(sitemapXml(ORIGIN_URI), "application/xml; charset=utf-8");
    if (path === "/llms.txt") return text(llmsTxt(ORIGIN_URI), "text/plain; charset=utf-8");

    // The icons. Every browser requests `/favicon.ico` on a first visit, and each of
    // those requests used to download the whole page and paint a blank tab; the two
    // raster paths answered 204 until the designer's mark existed (`tasks/20` §3), and
    // now they answer with it. A week's cache and an etag on all six, because the one
    // thing they never do is change between deploys.
    const icon = ctx.icons.get(path);
    if (icon) {
      if (req.headers["if-none-match"] === icon.etag) {
        res.writeHead(304, { etag: icon.etag });
        return void res.end();
      }
      return send(res, 200, icon.body, {
        "content-type": icon.type, "cache-control": "public, max-age=604800", etag: icon.etag,
      });
    }

    // ── The cards, and the pages that point at them (tasks/16) ──────────────
    //
    // **A card that does not verify draws the product card, never an error.** The only
    // reader here is a scraper that wanted a picture: a 404 is a broken tile on
    // somebody's post, and a 400 explaining the signature is worse. So a tampered
    // figure, a hand-typed URL and a missing parameter all land on the same picture as
    // a bare mandate.markets link, which is true whatever else happened.
    //
    // Nothing on this path reads the ledger. The numbers arrive signed and are redrawn
    // as given, which is what lets a signed card be cached for a year: its URL is a
    // pure function of figures that have already settled.
    if (path.startsWith("/share/")) {
      const card = shareCard(path, url.searchParams);
      if (!card) return json(res, 404, { error: "no such card" });
      if (!ctx.cards) {
        return send(res, 503, "share cards are not available on this server", {
          "content-type": "text/plain; charset=utf-8", "cache-control": "no-store",
        });
      }
      const png = await ctx.cards.png(card.key, card.model);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": png.length,
        "x-content-type-options": "nosniff",
        // A signed card is settled and will never change; the product card's copy will.
        "cache-control": card.signed ? "public, max-age=31536000, immutable" : "public, max-age=3600",
      });
      return void res.end(req.method === "HEAD" ? undefined : png);
    }

    // The link a person actually pastes. Same page, same script, same style — only the
    // social block in the head is different, so the CSP hashes still match and someone
    // who follows the link lands on the ordinary home view.
    if (path === "/s/trade" || path === "/s/position" || path === "/s/account") {
      const kind = path.slice(3);
      const card = shareCard(`/share/${kind}.png`, url.searchParams);
      const model = card?.model ?? homeCard();
      const imagePath = card?.signed ? `/share/${kind}.png?${url.searchParams.toString()}` : "/share/home.png";
      const landingPath = card?.signed ? `${path}?${url.searchParams.toString()}` : "/";
      const tags = socialTags({
        origin: ORIGIN_URI, imagePath, landingPath,
        title: cardTitle(model), description: cardDescription(model),
      });
      const variant = pageVariant(ctx.page, landingPath, tags);
      if (req.headers["if-none-match"] === variant.etag) {
        res.writeHead(304, { etag: variant.etag });
        return void res.end();
      }
      return send(res, 200, variant.body, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": ctx.page.csp,
        "cache-control": "no-cache",
        etag: variant.etag,
      });
    }

    if (req.headers["if-none-match"] === ctx.page.etag) {
      res.writeHead(304, { etag: ctx.page.etag });
      return void res.end();
    }
    return send(res, 200, ctx.page.html, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": ctx.page.csp,
      "cache-control": "no-cache",
      etag: ctx.page.etag,
    });
  }

  if (path === "/api/health") {
    return json(res, 200, { ok: true, network: isTestnet() ? "testnet" : "mainnet", venue: ctx.venue !== null });
  }

  if (path === "/api/auth/nonce" && method === "GET") {
    const address = url.searchParams.get("address") ?? "";
    if (!isAddress(address)) return json(res, 400, { error: "a wallet address is required" });
    const c = issueChallenge(ctx.web, address, { domain: DOMAIN, uri: ORIGIN_URI });
    return json(res, 200, { nonce: c.nonce, message: c.message });
  }

  if (path === "/api/auth/verify" && method === "POST") {
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const result = await login(ctx.web, {
      address: str(body, "address"),
      nonce: str(body, "nonce"),
      signature: str(body, "signature"),
    });
    if (!result.ok) {
      console.warn(`[web] login refused: ${result.reason}`);
      // A contract wallet is not a failed sign-in to retry, it is an account this
      // venue cannot trade at all — and saying so *before* anyone deposits is the
      // whole of the fix. `classifySignature` carries the argument.
      return json(res, 401, {
        error: result.kind === "contract-wallet"
          ? "This looks like a smart-contract wallet — a Safe, Coinbase Smart Wallet or " +
            "Argent. Hyperliquid only accepts an ordinary ECDSA signature, so an account " +
            "held by one of those can receive a deposit and can never be traded. Sign in " +
            "with a regular wallet instead, and do not deposit from the contract one."
          : "that signature could not be verified. Try signing in again.",
      });
    }
    return json(res, 200, { address: result.session.address }, {
      "set-cookie": sessionCookie(result.session.id, Math.floor(SESSION_TTL_MS / 1000), SECURE_COOKIES),
    });
  }

  if (path === "/api/auth/logout" && method === "POST") {
    const id = sessionIdFromCookie(req.headers.cookie);
    if (id) ctx.web.destroySession(id);
    return json(res, 200, { ok: true }, { "set-cookie": clearCookie(SECURE_COOKIES) });
  }

  if (path === "/api/me") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const row = ctx.store.account(address);
    return json(res, 200, { address, connected: row !== null, mode: row?.mode ?? null });
  }

  if (path === "/api/connect/status") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    return json(res, 200, connectStatus(ctx.store, ctx.web, address, DATA_ROOT));
  }

  // What the account holds, and what that means. Deliberately **not** folded into
  // /api/connect/status: that route is pure SQLite and must keep rendering the screen
  // when Hyperliquid is unreachable — which is exactly when someone staring at an
  // unconnected account most needs to see the four steps and where they are in them.
  // Here an outage costs one line of the page instead of the page.
  if (path === "/api/connect/balance") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (!ctx.venue) return json(res, 503, { error: "cannot reach Hyperliquid just now." });
    try {
      return json(res, 200, await cachedBalance(ctx, address));
    } catch (e) {
      console.error("[web] balance read failed:", e);
      return json(res, 502, { error: "could not read that account from Hyperliquid just now." });
    }
  }

  // ── The access queue (tasks/17) ────────────────────────────────────────────
  //
  // The desk trades at most `LIVE_MANDATE.maxLiveAccounts` accounts, ours included, and
  // it is at that number today. So the queue is the front door rather than the
  // exception it was written as: a position and two ways to move, instead of a
  // refusal that arrives after somebody has funded a fresh Hyperliquid account.
  //
  // A position is private to its owner (`tasks/17` §6.4). There is no route here that
  // lists the queue — it would be a list of wallets that intend to be funded, in
  // arrival order — and the operator's own listing runs on the box.

  if (path === "/api/queue") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    // Funding is what makes a referral count, so it is re-read while somebody is
    // waiting rather than only at the moment they joined: people join first and fund
    // afterwards, which is the order the screen actually asks for.
    if (ctx.venue && ctx.web.queueEntry(address) !== null) {
      try {
        const bal = await cachedBalance(ctx, address) as { enough?: boolean };
        if (bal.enough) ctx.web.markQueueFunded(address);
      } catch { /* a venue we cannot read is not a reason to hide somebody's place */ }
    }
    return json(res, 200, queuePayload(ctx, address));
  }

  if (path === "/api/queue/join" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });

    // A referral code that means nothing is not an error: the link may be old, or the
    // referrer may have left the queue. Joining is the thing being asked for, and it
    // happens either way. Self-referral is dropped for the same reason it is dropped
    // in the ordering — it is a loop, not an attack worth a sentence.
    const code = str(body, "ref").trim();
    const referrer = code === "" ? null : ctx.web.queueEntryByRefCode(code);
    const referredBy = referrer && referrer.address.toLowerCase() !== address ? referrer.address : null;
    ctx.web.joinQueue(address, referredBy);

    if (ctx.venue) {
      try {
        const bal = await cachedBalance(ctx, address) as { enough?: boolean };
        if (bal.enough) ctx.web.markQueueFunded(address);
      } catch { /* as above */ }
    }
    return json(res, 200, queuePayload(ctx, address));
  }

  // ── Linking an X account, and the post that moves you up ───────────────────
  //
  // Absent rather than broken when there is no app configured: every route here
  // answers 503 and the page does not render the control. `tasks/17` §3 is explicit
  // about why that is the safe direction — a client id set before credits are bought
  // means somebody clears X's consent screen and lands on a dead callback.

  if (path === "/api/x/start" && method === "GET") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const cfg = xConfig(ORIGIN_URI);
    if (!cfg) return json(res, 503, { error: "X linking is not available." });
    // Linking is a boost on a place in the queue, so there has to be a place first.
    const entry = ctx.web.queueEntry(address);
    if (entry === null) {
      return json(res, 409, { error: "Take your place in the queue first." });
    }
    // Refused here because it is free to refuse here. The check that actually bounds
    // the spending is the identical one in the callback — this one only saves somebody
    // a pointless trip through X's consent screen.
    const may = canAttemptXLink({
      handle: entry.x_handle,
      attemptsToday: ctx.web.xAttemptsToday(address, dayKey()),
    });
    if (!may.ok) return json(res, 429, { error: may.error });
    const pkce = newPkce();
    res.writeHead(302, {
      location: authorizeUrl(cfg, pkce),
      "set-cookie": pkceCookie(pkce, SECURE_COOKIES),
      "cache-control": "no-store",
    });
    return void res.end();
  }

  if (path === "/api/x/callback" && method === "GET") {
    // Somebody arriving from a consent screen is in a browser, so every outcome is a
    // redirect back to the page with a word the page can read — never a JSON body,
    // which would strand them on a blank tab.
    const back = (status: string) => {
      res.writeHead(302, {
        location: `/?x=${status}`,
        "set-cookie": clearPkceCookie(SECURE_COOKIES),
        "cache-control": "no-store",
      });
      res.end();
    };
    const address = currentAddress(ctx, req);
    if (!address) return back("signin");
    const cfg = xConfig(ORIGIN_URI);
    if (!cfg) return back("unconfigured");
    if (url.searchParams.get("error")) return back("declined");
    const cookie = readPkceCookie(req.headers.cookie);
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (!cookie || code === "" || !stateMatches(cookie.state, state)) return back("expired");

    // **The spending limit, and the only place it binds.** Everything above this line
    // is free; the call below is a paid `/2/users/me` on our own X account. One cookie
    // is good for ten minutes and the authorize URL it points at can be replayed, so a
    // check at `/api/x/start` alone bounds nothing at all.
    //
    // Counted **before** the call, so an attempt that fails at the vendor still spends
    // a place in the day's budget — a loop that always errors must not be free to run.
    const entry = ctx.web.queueEntry(address);
    const day = dayKey();
    const may = canAttemptXLink({
      handle: entry?.x_handle ?? null,
      attemptsToday: ctx.web.xAttemptsToday(address, day),
    });
    if (!may.ok) return back(may.reason);
    // Spent whatever X answers next. A refusal above costs nothing, because nothing
    // was bought; from here on the call is going out and the budget has to know.
    ctx.web.bumpXAttempt(address, day);

    try {
      const user = await linkXAccount(cfg, code, cookie.verifier);
      // One wallet per X account. Refused rather than moved: an X account that could
      // be re-pointed at a second wallet is a second boost for one handle, which is
      // the whole thing this link exists to prevent.
      const owner = ctx.web.walletForXUser(user.id);
      if (owner !== null && owner.toLowerCase() !== address) return back("taken");
      ctx.web.joinQueue(address, null);
      ctx.web.linkX(address, user.id, user.handle);
      return back("linked");
    } catch (e) {
      // The vendor's own message, in our log and not on their screen: it is the
      // sentence that says what is actually wrong with the app configuration, and it
      // is ours to read rather than theirs.
      console.error("[web] X link failed:", e);
      return back("failed");
    }
  }

  if (path === "/api/x/post" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const bearer = xBearer();
    if (!xConfig(ORIGIN_URI) || bearer === null) {
      return json(res, 503, { error: "Checking posts is not available." });
    }
    const entry = ctx.web.queueEntry(address);
    if (!entry?.x_user_id || !entry.x_handle) {
      return json(res, 409, { error: "Link your X account first." });
    }
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const link = str(body, "url").trim();
    const parsed = parsePostUrl(link);
    if (parsed === null) {
      return json(res, 400, { error: "That is not a link to a post. It looks like https://x.com/you/status/1234567890." });
    }
    // Free pre-checks first, so an obvious mistake costs nothing. The handle in the URL
    // is only a claim — X serves a post by id whatever handle is in the path — so this
    // catches a typo, and the author is established for real below.
    if (!postIsBy(link, entry.x_handle)) {
      return json(res, 400, {
        error: `That link says @${parsePostUrl(link)?.handle}. It has to be your own post, ` +
          `from @${entry.x_handle}.`,
      });
    }
    const day = dayKey();
    const budget = canSpendXCall({ attemptsToday: ctx.web.xAttemptsToday(address, day) });
    if (!budget.ok) return json(res, 429, { error: budget.error });
    // Paid from here: one `GET /2/tweets/:id`. Counted before the call, like the link.
    ctx.web.bumpXAttempt(address, day);

    let post: { authorId: string; urls: string[] };
    try {
      post = await readPost(bearer, parsed.id);
    } catch (e) {
      console.error("[web] X post lookup failed:", e);
      return json(res, 502, {
        error: "We could not read that post on X just now. If it is deleted or from a " +
          "protected account we cannot check it; otherwise try again in a minute.",
      });
    }
    // The real author, from X rather than from the path somebody typed.
    if (post.authorId !== entry.x_user_id) {
      return json(res, 400, {
        error: `That post was written by somebody else. It has to be yours, from ` +
          `@${entry.x_handle}.`,
      });
    }
    if (!postLinksTo(post.urls, DOMAIN)) {
      return json(res, 400, {
        error: `That post does not link to ${DOMAIN}. Say whatever you like in it — the ` +
          "link is the part we check.",
      });
    }
    ctx.web.recordPost(address, link);
    return json(res, 200, queuePayload(ctx, address));
  }

  if (path === "/api/connect/start" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });

    // Settings are written into the account row when the executor connects it, so a
    // second attempt before that is free and simply replaces the numbers. After it,
    // the account row wins and this request no longer decides anything: a change to
    // a connected account goes through /api/settings instead.
    if (ctx.store.account(address) !== null) {
      return json(res, 409, {
        error: "This account is already connected. Change its limits from the desk — they " +
          "apply to positions opened from then on — and update the mandate there once " +
          "nothing is open.",
      });
    }

    // The queue (`tasks/17`). Nothing is recorded for an address that has not been
    // admitted — which is the point of gating here rather than only in the executor:
    // a connection request is what makes the desk mint an agent key and start showing
    // somebody an approval screen, and neither should exist for an account that cannot
    // connect. The executor checks the same thing again on its own side.
    const gate = admission(ctx, address);
    if (!gate.admitted) {
      ctx.web.joinQueue(address, null);
      return json(res, 403, {
        error: gate.why === "lapsed"
          ? "The place we were holding for you has gone back to the queue. You are still in " +
            "line, at the back of it from when the hold ran out — a post or a referral moves " +
            "you up again."
          : "The desk is full, so access is by queue. You have a place in line; it moves when " +
            "an account leaves, and a post or a referral moves you up it.",
        queued: true,
      });
    }

    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    // `tasks/47` Rule 4: a new cohort does not meet a default that moved inside the
    // current block. This is the **only** call site that passes a seed — a change from an
    // existing account is that owner's and keeps the shipped default.
    const parsed = parseSettings(body, new Date(), seedForNewConnect({
      blockComplete: defaultBlockComplete(ctx.store),
    }));
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    // The referral code rides with the connect request rather than in the settings: it
    // is not frozen into a position and cannot be changed afterwards, because the slot
    // is spent once, ever (`tasks/37` §7.5). Absent means the user skipped, which is a
    // choice and not a failure.
    const referral = parseReferralCode(body);
    if (!referral.ok) return json(res, 400, { error: referral.error });

    ctx.web.clearUnlinkRequest(address);
    ctx.web.requestConnection(address, parsed.settings, Date.now(), referral.code);
    return json(res, 200, connectStatus(ctx.store, ctx.web, address, DATA_ROOT));
  }

  // ── Changing the limits and the mandate on a connected account (tasks/18) ──
  //
  // The same handshake as connect and unlink: this process records the request in
  // its own database, and the executor applies it on its next loop against the
  // ledger it alone writes. Neither request row is ever deleted here — the executor
  // compares timestamps, so each applies exactly once and a stale one is spent.
  //
  // A limits change never touches an open position: every intent froze its own terms
  // at open. The mandate is re-read from what the account holds, never typed — the
  // deposit is the size — and only once nothing is open.

  if (path === "/api/settings" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const verdict = canChangeSettings({
      hasAccountRow: ctx.store.account(address) !== null,
      unlinkPending: ctx.web.unlinkRequest(address) !== null && ctx.store.connection(address)?.status !== "disconnected",
      pinned: isPinned(address),
    });
    if (!verdict.ok) return json(res, 409, { error: verdict.error });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const parsed = parseSettings(body);
    if (!parsed.ok) return json(res, 400, { error: parsed.error });
    ctx.web.requestSettings(address, parsed.settings);
    deskCache.delete(address);
    return json(res, 200, changeStatus(ctx.store, ctx.web, address));
  }

  if (path === "/api/mandate" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const verdict = canChangeMandate({
      hasAccountRow: ctx.store.account(address) !== null,
      unlinkPending: ctx.web.unlinkRequest(address) !== null && ctx.store.connection(address)?.status !== "disconnected",
    });
    if (!verdict.ok) return json(res, 409, { error: verdict.error });
    ctx.web.requestMandate(address);
    deskCache.delete(address);
    return json(res, 200, changeStatus(ctx.store, ctx.web, address));
  }

  // Clearing a daily-loss halt, at the owner's request (`tasks/30` §1).
  //
  // The same handshake again, and here the reason it is a handshake rather than a write
  // is sharpest: this process opens the ledger **read-only**, so it could not clear a
  // halt if it wanted to. What it can do is ask, and the executor re-checks with the
  // same `canClearHalt` before it acts.
  //
  // The check runs here too, so a press that cannot succeed is answered now rather than
  // queued and refused a minute later — and, more to the point, so a `POST` from outside
  // the page is held to the same rule as the button. A disabled control is a hint to a
  // person; this is the rule.
  if (path === "/api/halt/clear" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const row = ctx.store.account(address);
    if (!row) return json(res, 409, { error: "This account is not connected." });
    if (row.halted !== 1) return json(res, 409, { error: "This account is not paused." });
    const beat = heartbeatFor(readExecHeartbeat(DATA_ROOT), address) as { equityUsd?: number } | null;
    const verdict = canClearHalt({
      actor: "owner",
      kind: row.halt_kind ?? null,
      haltedAt: ctx.store.haltedAt(address),
      day: row.day,
      dayStartEquity: row.day_start_equity,
      equityUsd: typeof beat?.equityUsd === "number" ? beat.equityUsd : null,
      now: new Date(),
    });
    if (!verdict.ok) return json(res, 409, { error: verdict.reason });
    ctx.web.requestUnhalt(address);
    deskCache.delete(address);
    return json(res, 200, { ok: true });
  }

  // Ask to be let go. The web tier cannot do it: stopping means cancelling orders on
  // Hyperliquid, and this process holds no key and opens the ledger read-only. So it
  // records the request exactly as it records a connection request, and the executor —
  // the one that can — acts on its next loop.
  //
  // **Nothing is closed.** Open positions stay open with their reduce-only stops
  // resting on the venue; we stop managing them. That is the deliberate choice: the
  // alternative, force-closing at market, realises somebody's P&L on a button press.
  // The screen says so, in those words, before this is called.
  if (path === "/api/connect/unlink" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    // Includes a connect that never completed — see `canUnlink`. A pinned account is
    // refused with its own sentence: the executor would re-admit it from the file on
    // the same loop, and a request it cannot honour must not be recorded.
    const pinned = isPinned(address);
    const stoppable = canUnlink({
      hasAccountRow: ctx.store.account(address) !== null,
      connectionStatus: ctx.store.connection(address)?.status ?? null,
      unlinkAlreadyRequested: ctx.web.unlinkRequest(address) !== null,
      pinned,
    });
    if (!stoppable) {
      return json(res, 409, {
        error: pinned
          ? "This account is managed from the desk by an operator's file, so it cannot be " +
            "unlinked from here. Removing the file is what stops it."
          : "This account is not connected, so there is nothing to unlink.",
      });
    }
    ctx.web.requestUnlink(address);
    return json(res, 200, connectStatus(ctx.store, ctx.web, address, DATA_ROOT));
  }

  // ── Renewing the agent approval, in this page ──────────────────────────────
  //
  // `tasks/13` stage B. Two routes, and the split is the security property: `prepare`
  // builds the actions and keeps them here, `relay` accepts only a step name and a
  // signature. The page is never able to hand us an action, so we are never able to
  // relay one that is not ours. `src/web/renew.ts` carries the rest of the argument.
  //
  // A renewal is **two** signatures whenever an entry is already registered, because
  // Hyperliquid refuses to re-approve an address it still holds ("Extra agent already
  // used.", captured 2026-09-02). The screen says so before anybody starts.

  if (path === "/api/agent/renew/prepare" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (!ctx.venue) return json(res, 503, { error: "cannot reach Hyperliquid just now." });

    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const chainId = typeof body.chainId === "number" ? body.chainId : 0;

    // The address our executor signs with. It lives in the connection row because the
    // web tier holds no keystore passphrase and could not derive it from a key.
    const agentAddress = ctx.store.connection(address)?.agent_address ?? null;
    const out = await prepareRenewal(renewDeps(ctx), address, agentAddress, chainId);
    return out.ok ? json(res, 200, out.prepared) : json(res, out.status, { error: out.error });
  }

  if (path === "/api/agent/renew/relay" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (!ctx.venue) return json(res, 503, { error: "cannot reach Hyperliquid just now." });

    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const step = str(body, "step");
    if (step !== "remove" && step !== "approve") return json(res, 400, { error: "unknown step" });

    const out = await relayStep(renewDeps(ctx), address, step as RenewStep, str(body, "signature"));
    return out.ok ? json(res, 200, { done: out.done }) : json(res, out.status, { error: out.error });
  }

  // ── The builder fee: what we charge, and the signature that permits it ─────
  //
  // `tasks/14`. Same split as the renewal above and the same reason for it: `prepare`
  // builds the action and keeps it in this process, `relay` accepts only a signature.
  //
  // What is different is **who this is a gate for** (`tasks/33`). It was nobody: an
  // account that never signed kept trading with no builder code on its orders. Since
  // the owner's decision of 2026-09-10 it is a gate for accounts that connect from
  // `BUILDER_FEE.requiredForConnectionsFrom`, and still nobody before that. `required`
  // rides on `/api/fee` so the connect screen can ask for the signature at the right
  // moment — but the **refusal is the executor's** (`connectAccount`), because a screen
  // that merely declines to offer a button is not a requirement.
  //
  // Every failure here is still reported rather than blocking, and `/api/fee` still
  // answers `off` rather than erroring when there is no rail.

  if (path === "/api/fee") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (!ctx.venue) return json(res, 503, { error: "cannot reach Hyperliquid just now." });
    const fee = await currentFee(feeDeps(ctx), address);
    // The cohort is the connection's own age, read from the ledger rather than inferred
    // from anything on screen.
    //
    // ⚠ **No row yet is the first-timer, and answering "not required" for them was a
    // trap.** It is the honest reading of the ledger — there is no connection, so there
    // is no cohort — but it meant the connect flow never asked, the key was minted, the
    // agent was approved, and only then did the executor refuse to arm an account whose
    // row was by that point squarely in the new cohort. `tasks/33` §2's whole argument
    // for gating on a wallet prompt is that "declining stops here, and nothing has
    // happened"; a refusal that arrives after the key does not have that property.
    //
    // So an address with no row is asked the question its row *would* answer: would a
    // connection created right now be required? Nothing else reads this branch — the
    // settings screen only renders for an account that has one.
    const required = feeRequiredFor(builderRail(), ctx.store.connection(address)?.created_at);
    return json(res, 200, { ...fee, required });
  }

  // Hyperliquid's own referral code (`tasks/37`). One info call decides which of three
  // states an address is in, and the screen says something in exactly one of them: an
  // account can be referred once ever, both major wallets claim the slot at their own
  // connect step, and nagging somebody about a code they cannot change is worse than
  // silence.
  //
  // **This became action on 2026-09-10** (`tasks/37` §7.5): the state it reports drives
  // a step with a box and two buttons, and the code the user chooses there rides on the
  // connect request for the executor's agent to sign. This route still only *reads* —
  // nothing here signs anything, and the web tier holds no key that could.
  //
  // Unreadable reads as "say nothing", never as "offer it": the failure that matters is
  // telling somebody they can take a discount they cannot.
  if (path === "/api/referral") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (!ctx.venue) return json(res, 503, { error: "cannot reach Hyperliquid just now." });
    try {
      const r = await ctx.venue.info.referral({ user: address as `0x${string}` });
      return json(res, 200, {
        ...referralState(r.referredBy),
        // Ours, so the page has no second copy of it to drift. `code` is this account's
        // own — and is null in exactly the state the step renders in.
        ourCode: REFERRAL_CODE,
        link: REFERRAL_LINK, discountPct: REFERRAL_DISCOUNT_PCT, sharePct: REFERRAL_SHARE_PCT,
      });
    } catch {
      return json(res, 200, {
        state: "theirs", code: "", ourCode: REFERRAL_CODE,
        link: REFERRAL_LINK, discountPct: REFERRAL_DISCOUNT_PCT, sharePct: REFERRAL_SHARE_PCT,
      });
    }
  }

  if (path === "/api/fee/prepare" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });

    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const chainId = typeof body.chainId === "number" ? body.chainId : 0;

    const out = prepareApproval(feeDeps(ctx), address, chainId);
    return out.ok ? json(res, 200, out.prepared) : json(res, out.status, { error: out.error });
  }

  if (path === "/api/fee/relay" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });

    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });

    const out = await relayApproval(feeDeps(ctx), address, str(body, "signature"));
    return out.ok ? json(res, 200, { ok: true }) : json(res, out.status, { error: out.error });
  }

  if (path === "/api/desk") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });

    const hit = deskCache.get(address);
    if (hit && Date.now() - hit.at < VENUE_TTL_MS) return json(res, 200, hit.payload);

    try {
      const payload = await buildDesk(ctx.store, address, ctx.venue, new Date(), DATA_ROOT, ctx.web);
      const withLabels = {
        ...payload,
        skipReasons: payload.skipReasons.map((s) => ({ ...s, label: labelSkip(s.reason) })),
      };
      deskCache.set(address, { at: Date.now(), payload: withLabels });
      return json(res, 200, withLabels);
    } catch (e) {
      console.error("[web] desk build failed:", e);
      return json(res, 502, { error: "could not read your account from Hyperliquid just now." });
    }
  }

  // The account's equity curve, from Hyperliquid's own `portfolio` endpoint.
  //
  // A separate route from `/api/desk` on purpose, and fetched after it: it is 18.8 KB
  // against a screen that already renders without it, and the desk's first paint is
  // what somebody is waiting for. A failure here leaves the chart absent and the rest
  // of the desk untouched, which is the right trade for an illustration of history
  // sitting beside a live balance.
  //
  // Live accounts only. There is no venue history for a paper account — its book is
  // ours, in `paper_positions` — and drawing Hyperliquid's curve beside a simulated
  // balance would put two unrelated numbers on one card.
  if (path === "/api/desk/history") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (!ctx.venue) return json(res, 503, { error: "cannot reach Hyperliquid just now." });
    /* Two ways there is nothing to draw, and they are different facts about the
       account rather than one shrug. The desk prints whichever sentence comes back
       verbatim, so the words live here — the same rule `connections.last_error`
       follows for the connect screen. */
    const mode = ctx.store.account(address)?.mode ?? null;
    if (mode !== "live") {
      return json(res, 404, {
        error: mode === null
          ? "This account is not connected yet, so there is no history to draw."
          : "This account trades a simulated book, so Hyperliquid has no history of it. "
            + "Every trade it has made is under History.",
      });
    }

    const hit = historyCache.get(address);
    if (hit && Date.now() - hit.at < HISTORY_TTL_MS) return json(res, 200, hit.payload);
    try {
      const payload = await readPortfolio(ctx.venue.info, address as `0x${string}`);
      historyCache.set(address, { at: Date.now(), payload });
      return json(res, 200, payload);
    } catch (e) {
      console.error("[web] portfolio read failed:", e);
      return json(res, 502, { error: "could not read your account's history just now." });
    }
  }

  // Every account we trade, ranked — the only route that reads across accounts.
  //
  // **Two gates, and they bound the same set of people.** A session is required, and
  // that session's own account must be one we trade live. So everybody who can read
  // this table is on it: the figures are shared among the owners taking the same risk,
  // not published. `src/web/leaderboard.ts` argues what the payload may carry, and the
  // roster rule that decides who is listed.
  //
  // The 403 is deliberately not a 404. "You need a live account to see this" is a
  // true and actionable sentence; pretending the route does not exist would leave
  // someone who just connected wondering whether the page was broken.
  if (path === "/api/leaderboard") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    if (ctx.store.account(address)?.mode !== "live") {
      return json(res, 403, {
        error: "The leaderboard is for accounts we trade live. Connect and fund an account to see it.",
      });
    }

    // One cache for everybody, because it is one answer for everybody — the gate above
    // decides who may read it, not what it says. The figures move once an executor
    // loop, so a shorter window would only cost queries.
    const hit = leaderboardCache;
    if (hit && Date.now() - hit.at < LEADERBOARD_TTL_MS) return json(res, 200, hit.payload);
    try {
      const payload = buildLeaderboard(ctx.store, readExecHeartbeat(DATA_ROOT));
      leaderboardCache = { at: Date.now(), payload };
      return json(res, 200, payload);
    } catch (e) {
      console.error("[web] leaderboard build failed:", e);
      return json(res, 500, { error: "could not read the leaderboard just now" });
    }
  }

  // What we saw and what we did about it. Pure ledger — no venue read — so this is
  // the one part of the screen that renders when Hyperliquid is unreachable.
  if (path === "/api/signals") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });

    // `since` is clamped rather than trusted: an unbounded cursor on a table the
    // executor writes every loop is a way to ask this process to serialise the lot.
    const asked = Date.parse(url.searchParams.get("since") ?? "");
    const floor = Date.now() - SIGNAL_WINDOW_MAX_MS;
    const since = new Date(Number.isFinite(asked) ? Math.max(asked, floor) : Date.now() - 7 * 86_400_000);
    try {
      return json(res, 200, buildSignalHistory(ctx.store, address, since.toISOString()));
    } catch (e) {
      console.error("[web] signal history failed:", e);
      return json(res, 500, { error: "could not read your signal history just now" });
    }
  }

  // ── Composing a share link (tasks/16 §5) ──────────────────────────────────
  //
  // The signature is issued here, from the ledger row, for the account the session has
  // proved it owns — which is the whole of why a card's figures mean anything. The
  // image route never sees this code and never reads a database.
  //
  // Not offered on an open position: a card about a position that has not closed is a
  // claim about a number that has not happened. `shareTrade` refuses one with that
  // sentence rather than the button being absent, because "why can't I share this?"
  // deserves an answer.

  if (path === "/api/share/trade" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    const out = shareTrade(ctx.store, address, str(body, "intentId"), SHARE_SECRET, ORIGIN_URI);
    return out.ok ? json(res, 200, out.offer) : json(res, out.status, { error: out.error });
  }

  // An open position, marked against the venue now. The one share route that reads
  // Hyperliquid: the P&L on it is the venue's fact and not our plan.
  if (path === "/api/share/position" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const body = await readJson(req);
    if (!body) return json(res, 400, { error: "malformed request" });
    try {
      const out = await sharePosition(ctx.store, address, str(body, "intentId"), SHARE_SECRET, ORIGIN_URI, ctx.venue);
      return out.ok ? json(res, 200, out.offer) : json(res, out.status, { error: out.error });
    } catch (e) {
      console.error("[web] position share failed:", e);
      return json(res, 502, { error: "could not read that position from Hyperliquid just now." });
    }
  }

  if (path === "/api/share/account" && method === "POST") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const out = shareAccount(ctx.store, address, SHARE_SECRET, ORIGIN_URI, new Date());
    return out.ok ? json(res, 200, out.offer) : json(res, out.status, { error: out.error });
  }

  // Closed trades, newest first, cursor-paged. Pure ledger, same as /api/signals —
  // both render when the venue is unreachable, which is when someone most wants to
  // read what already happened.
  if (path === "/api/history") {
    const address = currentAddress(ctx, req);
    if (!address) return json(res, 401, { error: "not signed in" });
    const asked = Number(url.searchParams.get("limit") ?? 50);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), 200) : 50;
    try {
      return json(res, 200, buildTradeHistory(ctx.store, address, url.searchParams.get("before"), limit));
    } catch (e) {
      console.error("[web] trade history failed:", e);
      return json(res, 500, { error: "could not read your trade history just now" });
    }
  }

  return json(res, 404, { error: "no such endpoint" });
}

// ── Boot ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const network = isTestnet() ? "testnet" : "mainnet";
  // Printed first, and loudly, because a testnet query against a mainnet-funded
  // account returns $0.00 and reads exactly like "not funded yet".
  console.log(`[web] network: ${network.toUpperCase()}`);

  // Read-only. SQLite refuses a write on this handle, so the public process cannot
  // corrupt the ledger even if a route is wrong.
  let store: Store;
  try {
    store = new Store(LEDGER, { readOnly: true });
  } catch (e) {
    throw new Error(
      `cannot open the ledger at ${LEDGER}: ${(e as Error).message}\n` +
      "The web tier never creates it — the executor does. Point SIGNALDESK_DB at a " +
      "ledger the executor has opened, or run `npm run exec` once to create one.",
    );
  }

  // Opening is not the same as being usable, and the gap was silent. A read-only open
  // never applies the schema (`Store`'s constructor says why), so a ledger written by
  // older code opens perfectly, logs its path, starts listening — and then throws on
  // every request that touches a table it does not have, which the router turns into
  // "something went wrong on our side". Checked here so the failure names itself once
  // at boot instead of once per request forever.
  const missing = [...store.missingTables(), ...store.missingColumns()];
  if (missing.length > 0) {
    throw new Error(
      `the ledger at ${LEDGER} predates this code: no ${missing.join(", ")}.\n` +
      "It would serve every API request as a 500. Every statement in the schema is " +
      "CREATE TABLE IF NOT EXISTS, so one read-write open migrates it in place and " +
      "changes nothing else:\n" +
      `  npx tsx -e 'import {Store} from "./src/store/db.ts"; new Store("${LEDGER}").close()'\n` +
      "Or point SIGNALDESK_DB at a ledger the executor is already writing.",
    );
  }
  console.log(`[web] ledger: ${LEDGER} (read-only)`);

  const web = new WebStore(webStorePath());
  console.log(`[web] sessions: ${webStorePath()}`);

  let venue: Ctx["venue"] = null;
  try {
    const info = makeInfoClient();
    venue = { info, universe: await Universe.load(info) };
    console.log(`[web] venue: ${venue.universe.size} markets across ${venue.universe.dexes.length} dexes`);
  } catch (e) {
    // The ledger half of every screen still renders. Venue numbers come back null,
    // which the client shows as "unavailable" rather than as zero.
    console.warn("[web] venue unreachable at boot, serving ledger-only:", (e as Error).message);
  }

  const page = loadPage(PAGE);
  console.log(`[web] page: ${PAGE} (${(page.html.length / 1024).toFixed(0)} KB, CSP hashed)`);
  if (page.split === null) {
    console.warn("[web] page has no <!--@SOCIAL@--> block: share landings will serve the default tags");
  }
  const icons = new Map(Object.entries(ICONS).map(([path, type]) =>
    [path, loadIcon(`${STATIC_DIR}${path}`, type)] as const));

  // Share cards. Both halves can be absent independently and each says so once, here,
  // rather than once per request: the fonts are fetched by `design/build.py` and are
  // not in the repository, and the secret is an `.env` line. Without either, a pasted
  // link renders exactly as it did before `tasks/16` — which is not worth refusing to
  // serve the desk over.
  let cards: CardRenderer | null = null;
  try {
    cards = new CardRenderer(loadCardFonts());
    console.log(`[web] share cards: ready${SHARE_SECRET ? "" : " (product card only — SHARE_SECRET is unset)"}`);
  } catch (e) {
    console.warn("[web] share cards disabled:", (e as Error).message);
  }

  const ctx: Ctx = { store, web, venue, page, icons, cards };

  const server = createServer((req, res) => {
    route(ctx, req, res).catch((e) => {
      console.error("[web] unhandled:", e);
      if (!res.headersSent) json(res, 500, { error: "something went wrong on our side" });
      else res.end();
    });
  });

  const sweeper = setInterval(() => web.sweep(), 15 * 60_000);
  sweeper.unref();

  const shutdown = (sig: string) => {
    console.log(`[web] ${sig} — closing`);
    server.close(() => {
      web.close();
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  server.listen(PORT, HOST, () => console.log(`[web] listening on http://${HOST}:${PORT}`));
}

main().catch((e) => {
  console.error("[web] failed to start:", e);
  process.exit(1);
});
