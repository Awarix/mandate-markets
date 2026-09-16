import { createHmac, timingSafeEqual } from "node:crypto";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, minFundedForLiveUsd, RISK_PARAMS } from "../risk/params.ts";

// Share cards (`tasks/16`): what a pasted mandate.markets link renders as.
//
// Three cards — the product, one closed trade, one account's week — at 1200 × 630,
// PNG and never SVG (most scrapers refuse `image/svg+xml`). This file is the whole of
// what a card *says*: the parameters it takes, the signature over them, and a pure
// function turning them into the figures and labels the renderer draws.
// `src/web/render.ts` turns that into pixels and is the only impure half.
//
// ── Why the numbers are signed, when Eater's are not ────────────────────────
//
// Eater's run cards carry unsigned figures on purpose: a forged `?m=999999` is a
// boast, its public leaderboard is the authority, and a picture was never evidence.
// Here there is no public authority. The desk is private, so a card is the *only*
// place a stranger will ever see one of our trades, and a forged "+$500 on BTC,
// executed by Mandate" is a claim about our execution and about other people's money,
// in our voice, on a product that is one legal read away from being a regulated
// activity (`tasks/04`). A picture is still not evidence, but it is a publication.
//
// So every card that carries a result carries an HMAC over its numbers, issued by the
// server from the ledger row when the owner presses share. The image route redraws
// exactly what verifies; anything else — a tampered figure, a hand-typed URL, a
// missing tag — draws the **product card** rather than an error, because the only
// reader is a scraper that wanted a picture.
//
// ── And why the parser is still digits-only ─────────────────────────────────
//
// The signature is the second guard, not a replacement for the first. **Nothing a card
// draws is a string that came from the URL**: every parameter is a bounded number, the
// market comes out of the table below by code, the close reason out of its own table,
// and the drawing code has no branch that prints text a caller supplied. That holds
// even if the secret leaks or a verification path is wrong one day. `figure()` is
// Eater's, for the reason Eater gives — `parseInt('12abc')` is 12 and `Number('')` is 0,
// so neither is a validator.

export const CARD_W = 1200;
export const CARD_H = 630;

/** The page's dark palette, restated in hex because a rasteriser runs no cascade.
 *  Kept in sync by eye with `:root[data-theme="dark"]` in `design/mandate.html` —
 *  there is no build step that could import CSS variables into Node, and a card in a
 *  feed is never seen beside the page anyway. `rgba()` and never an 8-digit hex:
 *  resvg does not read `#RRGGBBAA`, and it fails by drawing black. */
export const CARD_COLORS = {
  ground: "#0C0B0A",
  panel: "#15130F",
  rule: "#272219",
  ink: "#EDEAE2",
  ink2: "#ABA495",
  dim: "#867E6E",
  up: "#5FB98C",
  down: "#D4705C",
  accent: "#A7B8D6",
} as const;

// ── The two lookup tables ───────────────────────────────────────────────────

/** Market code → the symbol drawn on the card.
 *
 *  **Append only, and the code is written down rather than positional.** An old card's
 *  URL is a permanent link into this table: reorder it and a card shared last month
 *  starts naming a different market. Explicit codes make a re-sort harmless and cost
 *  nothing.
 *
 *  Seeded with every Hyperliquid symbol Quotient references in
 *  `fixtures/perps-2026-08-30.json`, which `cards.test.ts` pins. A market that is not
 *  here cannot be shared — `POST /api/share/trade` refuses it with a sentence naming
 *  the market, and the desk shows that sentence rather than a dead button. Adding one
 *  is a line here plus the next number. That is deliberately a human step: the
 *  alternative is printing a symbol out of the URL, which is exactly what this table
 *  exists to avoid. */
export const CARD_MARKETS: Readonly<Record<number, string>> = {
  1: "BTC",
  2: "ETH",
  3: "xyz:AAPL",
  4: "xyz:CL",
  5: "xyz:COPPER",
  6: "xyz:GOLD",
  7: "xyz:HOOD",
  8: "xyz:INTC",
  9: "xyz:META",
  10: "xyz:NATGAS",
  11: "xyz:NVDA",
  12: "xyz:ORCL",
  13: "xyz:PLATINUM",
  14: "xyz:PLTR",
  15: "xyz:SILVER",
  16: "xyz:TSLA",
};

const MARKET_CODES = new Map(Object.entries(CARD_MARKETS).map(([code, coin]) => [coin, Number(code)]));

export function marketCode(coin: string): number | null {
  return MARKET_CODES.get(coin) ?? null;
}

/** Close reason → the sentence the card leads with. Same reasons the ledger writes
 *  (`CloseReason` in `src/types.ts`), in the desk's own words — a card and the history
 *  row it came from must not describe the same trade differently.
 *
 *  ⚠ **Order is load-bearing and this list is append-only.** `reasonCode` is the index
 *  into it, and that index is one of the fields inside the HMAC of every share card
 *  already in the world. Insert a reason in the middle and every live card starts
 *  drawing a different sentence over the same signed numbers. `flipped` is last for
 *  that reason and not because it matters least. */
export const CLOSE_REASONS: readonly { reason: string; headline: string; short: string }[] = [
  { reason: "target", headline: "It hit its target.", short: "hit its target" },
  { reason: "stop", headline: "It stopped out.", short: "stopped out" },
  { reason: "horizon", headline: "It reached the forecast's deadline.", short: "reached its deadline" },
  { reason: "retired", headline: "The forecast was withdrawn, so we closed it.", short: "the forecast was withdrawn" },
  { reason: "halt", headline: "The account paused, so we closed it.", short: "the account paused" },
  { reason: "disconnect", headline: "We stopped managing the account.", short: "we stopped managing it" },
  { reason: "flipped", headline: "The forecast reversed, so we closed it.", short: "the forecast reversed" },
  // Appended, like `flipped` before it, because the index is inside the HMAC of every
  // card already shared. The wording does not say "we closed it": we did not.
  { reason: "liquidated", headline: "Hyperliquid closed it out.", short: "the exchange closed it out" },
];

export function reasonCode(reason: string | null): number | null {
  const i = CLOSE_REASONS.findIndex((r) => r.reason === reason);
  return i === -1 ? null : i;
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** A bounded non-negative integer, or null. Digits only, before `Number` sees it. */
export function figure(raw: string | null, max: number): number | null {
  if (raw === null || !/^\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return n > max ? null : n;
}

/** The same, admitting one leading minus. Split out rather than folded in, so a field
 *  that has no business being negative — a count, a margin, a hold time — cannot
 *  quietly accept one. */
export function signedFigure(raw: string | null, max: number): number | null {
  if (raw === null || !/^-?\d{1,12}$/.test(raw)) return null;
  const n = Number(raw);
  return Math.abs(n) > max ? null : n;
}

// ── The signature ──────────────────────────────────────────────────────────

/** Canonical form: the kind, then every parameter as `key=value` in sorted key order,
 *  newline-separated. Built from the **parsed numbers** and never from the raw query,
 *  so `?p=0004` and `?p=4` cannot be two different signatures over one card, and the
 *  order the parameters happen to appear in the URL is not part of what is signed.
 *
 *  The separator was a literal NUL for a day, which worked and made this file
 *  **binary to git** — no diff, no review, on the file that decides what a public card
 *  may say. Keys are fixed identifiers and values are digits, so no value can contain a
 *  newline and none can be run together to forge another's canonical form. */
function canonical(kind: string, params: Record<string, number>): string {
  const parts = Object.keys(params).sort().map((k) => `${k}=${params[k]}`);
  return [kind, ...parts].join("\n");
}

/** 16 hex characters — 64 bits. Forging one costs 2^64 work and the prize is a
 *  picture; the URL is read by scrapers and pasted by people, and a 64-character tag
 *  would be most of the link. */
export const SIG_LEN = 16;

export function sign(secret: string, kind: string, params: Record<string, number>): string {
  return createHmac("sha256", secret).update(canonical(kind, params)).digest("hex").slice(0, SIG_LEN);
}

export function verify(secret: string, kind: string, params: Record<string, number>, given: string): boolean {
  if (!/^[0-9a-f]{16}$/.test(given)) return false;
  const want = Buffer.from(sign(secret, kind, params), "utf8");
  const got = Buffer.from(given, "utf8");
  return want.length === got.length && timingSafeEqual(want, got);
}

// ── The parameters each card takes ─────────────────────────────────────────

/** `d` is on every signed card: **1 carries the dollars, 0 carries only a percentage.**
 *
 *  It is not a rendering hint. With `d = 0` the amount is **absent from the URL**, not
 *  merely undrawn — no cents, no margin, nothing a reader of the link can divide. That
 *  is the whole property the switch sells, and hiding a parameter that is still in the
 *  query would have been a lie told in the dialog.
 *
 *  So the two spellings are two parameter sets, and each is signed on its own. The
 *  server issues both when the owner presses share, the dialog swaps between them
 *  locally, and nobody handed one of them can produce the other.
 *
 *  Every card carries `y` — **the result in basis points of its own denominator**, the
 *  margin for a position and the mandate for an account. That is what makes `d = 0`
 *  possible on the account card without the mandate ever appearing: a percentage on
 *  its own divides into nothing. */
type Result = {
  /** 1 carries the dollars, 0 the percentage alone. */ d: number;
  /** the result in basis points of this card's own denominator, signed. */ y: number;
  /** cents, signed. **Present only when `d` is 1.** */ p?: number;
};

export type TradeParams = Result & {
  /** `CARD_MARKETS` code. */ m: number;
  /** 1 long, 0 short. */ s: number;
  /** leverage. */ l: number;
  /** `CLOSE_REASONS` index. */ r: number;
  /** margin posted, in cents. **Present only when `d` is 1.** */ g?: number;
  /** entry price × 10⁴. Public market data, so it rides on the card either way — it is
   *  the size behind a price that the dollars switch is about, never the price. */
  a: number;
  /** exit price × 10⁴, size-weighted across the closing fills. */ b: number;
  /** minutes held. */ h: number;
  /** |displacement sigma| × 100. 0 means "we no longer hold that". */ x: number;
  /** close time, unix seconds. */ t: number;
};

/** An **open** position. `tasks/16` §5 ruled this out — "a card about a position that
 *  has not closed is a claim about a number that has not happened" — and the owner
 *  asked for it on 2026-09-05 anyway, Quotient's own desk having one.
 *
 *  The objection is answered by what the card says rather than by refusing to draw it:
 *  the figure is labelled **unrealised and before costs**, the eyebrow says *Open*, and
 *  the instant the snapshot was taken is a fact on the card rather than something a
 *  reader has to assume. A snapshot that says it is a snapshot is not the claim §5 was
 *  worried about. Everything else — the signature, the bounded numbers, the tables — is
 *  the trade card's. */
export type PositionParams = Result & {
  m: number; s: number; l: number;
  g?: number;
  /** entry price × 10⁴. */ a: number;
  /** the **mark** it is being valued at × 10⁴ — not an exit, because there has not
   *  been one. The detail line says so. */ b: number;
  /** minutes open so far. */ h: number;
  x: number;
  /** when the snapshot was taken, unix seconds. */ t: number;
};

export type AccountParams = Result & {
  /** trades closed. */ n: number;
  /** hit their target. */ w: number;
  /** stopped out. */ o: number;
  /** closed for any other reason — deadline, withdrawal, a pause. */ e: number;
  /** leverage. */ l: number;
  /** stop distance in basis points. 0 means the owner turned the stop off. */ q: number;
  /** size per position in basis points of the mandate. */ z: number;
  /** window end, unix seconds. */ t: number;
};

type Bound = { max: number; signed?: true };

/** On every signed card, either way. `y` is a ratio and can run past 100% at leverage —
 *  a 20× position stopped out is −60% of its margin, and a good week on a small mandate
 *  can be more than all of it — so the bound is generous rather than 10,000. */
const COMMON: Record<string, Bound> = { d: { max: 1 }, y: { max: 1e7, signed: true } };

const CENTS: Bound = { max: 1e11, signed: true };
/** Prices × 10⁴, so the bound admits anything under $10,000,000 to four decimals. */
const PRICE: Bound = { max: 1e11 };

/** **The dollar keys are per kind**, and the account card's set is deliberately shorter.
 *
 *  A trade or a position carries the result *and* the margin behind it; the account
 *  card carries the result alone, because its denominator is the mandate and putting
 *  that in the URL is the one thing this card must never do.
 *
 *  Getting this wrong is not a display bug. It shipped on 2026-09-05 as a single
 *  `DOLLARS` set applied to all three: `parseAccount` then demanded a `g` that
 *  `shareAccount` had correctly never issued, so **every account card with the dollars
 *  switched on failed its own signature check and drew the product card instead** —
 *  the server issuing a link it could not itself verify. The unit tests missed it
 *  because they round-tripped the trade card through `query` → `parseTrade` and only
 *  called the account card's model function directly. There is now a test that
 *  round-trips all three, both ways. */
const DOLLAR_KEYS: Record<SignedKind, Record<string, Bound>> = {
  trade: { p: CENTS, g: { max: 1e11 } },
  position: { p: CENTS, g: { max: 1e11 } },
  account: { p: CENTS },
};

/** Every key that only ever appears on a `d = 1` card, whichever kind. Used to refuse
 *  one that has been appended to a `d = 0` link. */
const ALL_DOLLAR_KEYS = ["p", "g"] as const;

const TRADE_BOUNDS: Record<string, Bound> = {
  ...COMMON,
  m: { max: 999 }, s: { max: 1 }, l: { max: 100 }, r: { max: CLOSE_REASONS.length - 1 },
  a: PRICE, b: PRICE, h: { max: 1e7 }, x: { max: 1e5 }, t: { max: 1e11 },
};

const POSITION_BOUNDS: Record<string, Bound> = {
  ...COMMON,
  m: { max: 999 }, s: { max: 1 }, l: { max: 100 },
  a: PRICE, b: PRICE, h: { max: 1e7 }, x: { max: 1e5 }, t: { max: 1e11 },
};

const ACCOUNT_BOUNDS: Record<string, Bound> = {
  ...COMMON,
  n: { max: 1e6 }, w: { max: 1e6 }, o: { max: 1e6 }, e: { max: 1e6 },
  l: { max: 100 }, q: { max: 5000 }, z: { max: 10000 }, t: { max: 1e11 },
};

/** The exact key set a card of this kind and this `d` must carry — **exact**, not "at
 *  least": an unexpected key is a refusal, so nobody can append a parameter that this
 *  build ignores and a later one draws. */
function parseBounded<T>(q: URLSearchParams, kind: SignedKind, base: Record<string, Bound>): T | null {
  const d = figure(q.get("d"), 1);
  if (d === null) return null;
  const bounds = d === 1 ? { ...base, ...DOLLAR_KEYS[kind] } : base;
  const out: Record<string, number> = {};
  for (const [key, b] of Object.entries(bounds)) {
    const v = b.signed ? signedFigure(q.get(key), b.max) : figure(q.get(key), b.max);
    if (v === null) return null;
    out[key] = v;
  }
  // A card that carries a dollar key this kind and this `d` do not have is not a card
  // we issued, and drawing it would put an amount in the URL of a link whose whole
  // promise is that it is not there. Refused rather than ignored.
  for (const key of ALL_DOLLAR_KEYS) {
    if (!(key in bounds) && q.get(key) !== null) return null;
  }
  return out as T;
}

/** A trade card's parameters, or null — a missing field, an out-of-range one, a bad
 *  signature and a market we do not have a code for are the same answer, because the
 *  caller does the same thing with all four: draw the product card. */
export function parseTrade(q: URLSearchParams, secret: string | null): TradeParams | null {
  const p = parseBounded<TradeParams>(q, "trade", TRADE_BOUNDS);
  if (!p || !secret || !(p.m in CARD_MARKETS)) return null;
  return verify(secret, "trade", p, q.get("k") ?? "") ? p : null;
}

export function parsePosition(q: URLSearchParams, secret: string | null): PositionParams | null {
  const p = parseBounded<PositionParams>(q, "position", POSITION_BOUNDS);
  if (!p || !secret || !(p.m in CARD_MARKETS)) return null;
  return verify(secret, "position", p, q.get("k") ?? "") ? p : null;
}

export function parseAccount(q: URLSearchParams, secret: string | null): AccountParams | null {
  const p = parseBounded<AccountParams>(q, "account", ACCOUNT_BOUNDS);
  if (!p || !secret) return null;
  return verify(secret, "account", p, q.get("k") ?? "") ? p : null;
}

/** Every card kind that takes parameters and a signature. The product card takes
 *  neither and is what everything else falls back to. */
export type SignedKind = "position" | "trade" | "account";

/** The query string a signed card is fetched at, signature included. One function so
 *  the image URL, the landing URL and the share text cannot drift apart. */
export function query(secret: string, kind: SignedKind, params: Record<string, number>): string {
  const q = new URLSearchParams();
  for (const k of Object.keys(params).sort()) q.set(k, String(params[k]));
  q.set("k", sign(secret, kind, params));
  return q.toString();
}

// ── Formatting, in the page's own words ────────────────────────────────────
//
// **No `σ` and no `→` anywhere on a card.** Measured 2026-09-05: neither General Sans
// nor Tabular carries a glyph for either, and satori has no system fallback the way a
// browser does — it draws the .notdef box and nothing fails. The desk gets away with
// `1.83σ` because the browser falls through to `ui-monospace`; a card cannot. So the
// forecast's displacement is spelled "sigma", in a sentence, which is better for a
// stranger in a feed regardless. `−` (U+2212), `×`, `·`, `—` and `’` all render in
// both faces and are checked in the same probe.

const minus = (n: number) => (n < 0 ? "−" : "+");
const usd = (cents: number) =>
  "$" + (Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function signedUsd(cents: number): string {
  return minus(cents) + usd(cents);
}

export function signedPct(n: number, digits = 2): string {
  return minus(n) + Math.abs(n).toFixed(digits) + "%";
}

export function heldFor(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = minutes / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)} days`;
}

// ── The model ──────────────────────────────────────────────────────────────
//
// What a card says, decided here and drawn in `render.ts`. The split is `tasks/16`
// §6.4: when the designer's card design lands it replaces the tree inside the
// renderer and nothing else, because **what a card may say, which numbers it carries,
// the signature and the tags around it are rules, not design.** So every decision a
// card makes is in this function, where a unit test can reach it, and no decision is
// in the pixels — asserting on a PNG is asserting on a rasteriser's version.

export type CardTone = "up" | "down" | "flat";

export type CardModel = {
  kind: "home" | "position" | "trade" | "account";
  /** Top-left inside the frame. The same tagline on every card, which is also where
   *  the Quotient citation appears first. */
  eyebrow: string;
  /** **The market, in the accent colour** — the one word a reader recognises, and the
   *  thing a card is *about*. "" on the product card. */
  title: string;
  /** The lead number: **the percentage**. It leads rather than the dollars because a
   *  percentage is the comparable figure and it says nothing about how much money is
   *  behind it (owner, 2026-09-05, after seeing dollars lead). */
  figure: string;
  /** Under it and smaller, in parentheses: the dollars, or "" when they are switched
   *  off — in which case nothing takes their place. */
  subfigure: string;
  tone: CardTone;
  /** One or two quiet lines under the numbers: what was traded, between which prices,
   *  for how long. Replaced "net of fees and funding", the close reason and the margin
   *  on 2026-09-05 — the card was carrying more sentences than a picture in a feed can
   *  be read for. The settlement claim moved to `og:description`, which is text a
   *  reader can take their time over, rather than being dropped. */
  detail: string[];
  /** The product card's sentence. Empty on a result card, which leads with a number. */
  headline: string;
  /** The product card's bounds. Empty on a result card. */
  facts: { label: string; value: string }[];
  /** Names Quotient. On **every** card, because `tasks/12` makes the citation an
   *  obligation on every surface that shows their analysis, and a card in a feed is
   *  the most public surface we have. */
  credit: string;
  /** Bottom-right, on every card that shows a result. Empty on the product card,
   *  which shows none. Owner's words, 2026-09-05. */
  disclaimer: string;
};

export const DISCLAIMER = "Past results. Not a forecast, not advice.";

const tone = (cents: number): CardTone => (cents > 0 ? "up" : cents < 0 ? "down" : "flat");

/** Dollars big with the percentage under them, or the percentage alone.
 *
 *  Stacked rather than side by side because that is how the desk sets every result,
 *  and a card is the desk's number leaving the building — the two should not disagree
 *  about which figure is the headline. The **denominator is not named**: "of margin"
 *  came off on 2026-09-05, and what is left under the pair is the claim a reader
 *  cannot infer — whether the figure is settled.
 *
 *  With `d = 0` the dollars are simply absent, and so is the percentage's denominator,
 *  so there is nothing to divide. */
function stacked(p: Result): Pick<CardModel, "figure" | "subfigure"> {
  return {
    figure: signedPct(p.y / 100),
    subfigure: p.d === 1 && p.p !== undefined ? `(${signedUsd(p.p)})` : "",
  };
}

/** A signed instant, drawn as a fact rather than left implicit. Only the open-position
 *  card needs it: its figure moves with the mark, so a card without a timestamp is a
 *  number pretending to be current forever. */
function asOf(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    timeZone: "UTC", hour12: false,
  }) + " UTC";
}

/** The product card. No parameters, and **nothing about returns** — this is the card
 *  every bare mandate.markets link gets, so it is the most-seen picture we own and it
 *  has to stay true whatever Phase 3 says.
 *
 *  Every figure is read from the parameters, for the reason `llms.txt` is: the bounds
 *  a reader quotes have to be the bounds the executor enforces. `tasks/16` was written
 *  when they were "at most 50% deployed, 5 positions"; `tasks/21` made that 100% and a
 *  count derived from the size, and this card would still be saying 50% if the numbers
 *  had been typed here. */
export function homeCard(): CardModel {
  const d = DEFAULT_USER_SETTINGS;
  const pct = (f: number) => `${Math.round(f * 100)}%`;
  return {
    kind: "home",
    eyebrow: TAGLINE,
    title: "",
    figure: "",
    subfigure: "",
    detail: [],
    tone: "flat",
    headline: "Your own Hyperliquid account, traded on Quotient’s outlooks by a key that cannot withdraw.",
    // Labels carry the prose and values carry the figure, so every value stays short
    // enough for four to sit in one row at a size a phone can read in a feed.
    facts: [
      { label: "Deployed at most", value: pct(RISK_PARAMS.maxDeployedPct) },
      { label: `Positions at ${pct(d.perSignalPct)} each`, value: String(maxConcurrentSignals(d)) },
      { label: "Pauses on a day down", value: pct(RISK_PARAMS.dailyLossPct) },
      { label: "Smallest deposit", value: `$${minFundedForLiveUsd(d).toFixed(2)}` },
    ],
    credit: "Every forecast is Quotient’s. Mandate publishes none of its own — it is execution and risk control.",
    disclaimer: "",
  };
}

/** The line every card carries top-left. It names Quotient before anything else does,
 *  which is `tasks/12` satisfied twice over on a result card. */
export const TAGLINE = "Quotient researches · Mandate executes";

/** A price back from its ×10⁴ integer, at the precision the desk prints.
 *
 *  `toPrecision(6)` and not a fixed number of decimals: the same card kind draws BTC at
 *  78,971 and SILVER at 65.53, and two decimals on one is noise while two on the other
 *  is a lie. It matches `px()` on the desk, so a price reads identically in both. */
function price(scaled: number): string {
  const n = scaled / 10_000;
  // Two decimals down to a dollar — $2,417.50 rather than $2,417.5, which reads as a
  // typo next to $65.53. Below a dollar, significant figures instead: two decimals on a
  // $0.0004 market is $0.00.
  const opts = n >= 1
    ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
    : { maximumSignificantDigits: 4 };
  return "$" + n.toLocaleString("en-US", opts);
}

/** `»` and not `→`: neither face has an arrow glyph and satori draws .notdef silently
 *  (§1 of the notes). The guillemet is directional, which a dash would not be — this is
 *  "it went from here to there", not a range. */
const WENT_TO = "»";

/** The market and side, for the detail line. */
const market = (p: { s: number; l: number }) => `${p.s === 1 ? "LONG" : "SHORT"} ${p.l}×`;

/** What Quotient contributed, named. The sigma is spelled out because neither face
 *  carries `σ` — see the formatting note above. Two lines at most on the card, so the
 *  second clause is the whole of what Mandate did and is not padded. */
const called = (x: number, did: string) =>
  x === 0
    ? `Quotient called it. Mandate ${did}.`
    : `Quotient called a ${(x / 100).toFixed(2)} sigma move. Mandate ${did}.`;

/** One closed trade.
 *
 *  Never the address, never the balance, never the position size in units. Whether the
 *  **dollars** appear is the owner's, in the share dialog: with them, the percentage
 *  under them gives a reader the margin behind this one position by division. That is
 *  one position rather than the account, and it is the pair the desk's own row already
 *  shows — but it is the reader's to work out, so it is the owner's to allow. */
export function tradeCard(p: TradeParams): CardModel {
  return {
    kind: "trade",
    eyebrow: TAGLINE,
    title: CARD_MARKETS[p.m]!,
    ...stacked(p),
    tone: tone(p.y),
    headline: "",
    facts: [],
    detail: [`Market: ${market(p)}  ${price(p.a)} ${WENT_TO} ${price(p.b)}  ·  held ${heldFor(p.h)}`],
    credit: called(p.x, "sized it, rested the stop on the exchange, and closed it"),
    disclaimer: DISCLAIMER,
  };
}

/** One **open** position — a snapshot, and it says so three times.
 *
 *  `tasks/16` §5 refused this card. The refusal's reason was that a card about a
 *  position that has not closed is a claim about a number that has not happened, and
 *  the answer is not to hide the number but to stop it reading as a result: the eyebrow
 *  ends in *Open*, the note under the figure says **unrealised, before costs**, and the
 *  instant the snapshot was taken is a fact on the card rather than something a reader
 *  has to assume. What it must never say is why it closed, because it has not. */
export function positionCard(p: PositionParams): CardModel {
  return {
    kind: "position",
    eyebrow: TAGLINE,
    title: CARD_MARKETS[p.m]!,
    ...stacked(p),
    tone: tone(p.y),
    headline: "",
    facts: [],
    // **Open**, **unrealised** and the instant it was taken, all on the line a reader
    // reaches before the number has stopped being surprising. That is what answers
    // `tasks/16` §5's refusal, so it is not optional decoration.
    detail: [
      `Market: ${market(p)}  ${price(p.a)} ${WENT_TO} ${price(p.b)} mark  ·  open ${heldFor(p.h)}`,
      `Still open · unrealised, before fees and funding · at ${asOf(p.t)}`,
    ],
    credit: called(p.x, "sized it and rested both exits on the exchange"),
    disclaimer: DISCLAIMER,
  };
}

/** One account's week.
 *
 *  **The balance is never on this card**, and with `d = 1` it is one division away: the
 *  percentage is of the mandate, so dollars beside it give the mandate exactly. That is
 *  why the switch defaults **off** here and on for a single position — the mandate is a
 *  bigger thing to hand a stranger than one position's margin — and why the dialog's
 *  note beside the checkbox says what this particular card gives away rather than
 *  repeating one sentence for all three.
 *
 *  The stopped count sits beside the hits on purpose. People share wins, so a feed of
 *  these will be greener than the ledger by construction — `tasks/16` §6.3 states that
 *  rather than pretending to solve it, and the honest mitigations are that every
 *  figure is net of costs and that the refusals are counted in the same row. */
export function accountCard(p: AccountParams): CardModel {
  const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
  return {
    kind: "account",
    eyebrow: TAGLINE,
    // **"P/L", not just the window.** The percentage is realised P&L over the mandate,
    // which is what the account grew by in a week — and the point of sharing it is that
    // a stranger multiplies it out in their head. A bare "Seven days" left them to guess
    // what the number was *of*.
    title: "Seven-day P/L",
    ...stacked(p),
    tone: tone(p.y),
    headline: "",
    facts: [],
    // The counts stay, and the stopped one stays beside the hits: people share wins, so
    // a feed of these is greener than the ledger by construction (`tasks/16` §6.3) and
    // the refusals counted in the same breath are the honest half of that. The bounds
    // stay too — they are what says this was not reckless.
    detail: [
      `${p.n === 1 ? "1 trade" : `${p.n} trades`}  ·  ${p.w} hit target  ·  ${p.o} stopped  ·  ${p.e} closed otherwise`,
      `${pct(p.z)} per position at ${p.l}×  ·  ${p.q === 0 ? "no stop" : `${pct(p.q)} stop`}`,
    ],
    credit: "Every forecast is Quotient’s. Mandate executes them on the owner’s own account.",
    disclaimer: DISCLAIMER,
  };
}

/** What the dialog says beside the dollars checkbox. Per card, because what the dollars
 *  give away is different on each: one position's margin, or the whole mandate. */
export const DOLLARS_NOTE: Record<CardModel["kind"], string> = {
  home: "",
  position: "dollars reveal this position’s size",
  trade: "dollars reveal this position’s size",
  account: "dollars reveal what the account holds",
};

/** Whether the checkbox starts ticked. On for one position, off for the account — see
 *  `accountCard`. */
export const DOLLARS_DEFAULT: Record<CardModel["kind"], boolean> = {
  home: false, position: true, trade: true, account: false,
};

// ── The head a scraper reads, and the sentence a person posts ──────────────

/** The markers `design/mandate.html` carries around its social block, and the only
 *  part of the page the server rewrites per share URL. Everything else — including
 *  both hashed inline blocks — is served byte-for-byte, so the CSP holds. */
export const SOCIAL_OPEN = "<!--@SOCIAL@-->";
export const SOCIAL_CLOSE = "<!--@/SOCIAL@-->";

/** The canonical origin, hardcoded for the reason `tasks/15` hardcodes it in the page:
 *  there is one site, and a tag advertising a staging host helps nobody. */
export const CANONICAL_ORIGIN = "https://mandate.markets";
export const HOME_TITLE = "Mandate — your money works. You don't.";
export const HOME_DESCRIPTION =
  "Quotient's researchers read the markets all day and publish what they expect. Mandate turns " +
  "that into positions on your own exchange account — sized, stopped and closed without you ever " +
  "opening one.";
export const HOME_CARD_PATH = "/share/home.png";

/** Every social tag from one argument, so the image URL cannot drift between
 *  `og:image` and `twitter:image` — Eater's rule, and the one that costs a deploy to
 *  learn. The declared width and height must be the true size: a scraper lays the tile
 *  out before it fetches a byte. */
export function socialTags(o: { origin: string; imagePath: string; landingPath: string; title: string; description: string }): string {
  const abs = (p: string) => new URL(p, o.origin).href;
  // Attributes are double-quoted, so `'` needs no escape and gets none — the page's
  // own copy is full of them and escaping would make the static block and this
  // function disagree over bytes that render identically.
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="Mandate">`,
    `<meta property="og:title" content="${esc(o.title)}">`,
    `<meta property="og:description" content="${esc(o.description)}">`,
    `<meta property="og:url" content="${esc(abs(o.landingPath))}">`,
    `<meta property="og:image" content="${esc(abs(o.imagePath))}">`,
    `<meta property="og:image:width" content="${CARD_W}">`,
    `<meta property="og:image:height" content="${CARD_H}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${esc(o.title)}">`,
    `<meta name="twitter:description" content="${esc(o.description)}">`,
    `<meta name="twitter:image" content="${esc(abs(o.imagePath))}">`,
  ].join("\n");
}

/** The description a scraper shows under the tile, composed from the numbers by us —
 *  never Quotient's prose, and never a string a caller supplied. */
/** What a scraper prints under the tile — and where the settlement claim went when it
 *  came off the card face on 2026-09-05. A description is read at a reader's own pace,
 *  so it can carry the sentence a picture in a feed could not. */
export function cardDescription(m: CardModel): string {
  const settled = m.kind === "position"
    ? "Unrealised, before fees and funding."
    : m.kind === "home" ? "" : "Net of fees and funding.";
  const parts = [
    m.title && `${m.title}:`,
    [m.figure, m.subfigure].filter(Boolean).join(" "),
    settled,
    m.headline,
    ...m.detail,
    m.facts.map((f) => `${f.label}: ${f.value}`).join(" · "),
    m.credit,
  ].filter(Boolean);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

export function cardTitle(m: CardModel): string {
  switch (m.kind) {
    case "trade": return `${m.title} ${m.figure} — executed by Mandate`;
    case "position": return `${m.title} ${m.figure} unrealised — running on Mandate`;
    case "account": return `A week on Mandate — ${m.figure} realised`;
    default: return HOME_TITLE;
  }
}

/** **The two accounts, in one place**, because the post text is not the only thing that
 *  will want them (`src/web/queue.ts` composes the queue's draft post from these too).
 *  `@QuotientHQ` is read off Quotient's own docs and signal site, not guessed. */
export const X_HANDLES = { us: "@MandateMarkets", them: "@QuotientHQ" } as const;

/** Where the sentence is going. **The handles are for X and for nothing else.**
 *
 *  Telegram resolves an `@name` against *its* directory, so `@MandateMarkets` in a
 *  Telegram message is a link to whoever holds that Telegram name — which is not us —
 *  and the same string in the clipboard or an OS share sheet is a mention of nobody.
 *  So the destination picks the vocabulary, and only `xIntent` asks for `"x"`. */
export type ShareVoice = "plain" | "x";

/** **The sentence is ours and it names Quotient**, composed here rather than in the
 *  page, so the citation cannot be edited out of the default by anything short of a
 *  change to this file. The person can still edit it in X's composer once it is
 *  theirs; that is theirs.
 *
 *  **The X sentences are written out rather than substituted into the plain ones**, and
 *  the reason is not style: X treats a post that *begins* with a mention as a reply and
 *  shows it only to people who follow both accounts. "Quotient called it" with the name
 *  swapped would open every trade post with `@QuotientHQ` and quietly halve its reach,
 *  so each one is re-phrased to put a word in front of the handle. `cards.test.ts`
 *  holds both halves of that: every X sentence names both accounts by handle, and none
 *  of them starts with one.
 *
 *  Returned without its trailing colon. X and Telegram take the link in a field they
 *  document and would print the colon before it; the OS share sheet and the clipboard
 *  get `text + ": " + url`, because iOS and macOS drop the separate `url` field. */
export function shareText(m: CardModel, voice: ShareVoice = "plain"): string {
  const result = [m.figure, m.subfigure].filter(Boolean).join(" ");
  const { us, them } = X_HANDLES;
  if (m.kind === "trade") {
    return voice === "x"
      ? `Called by ${them}, executed by ${us} — sized, stopped, closed. ` +
        `${m.title} ${result}, net of fees and funding`
      : `Quotient called it. Mandate executed it — sized, stopped, closed. ` +
        `${m.title} ${result}, net of fees and funding`;
  }
  // Never "made" and never a past tense: the position is open and the sentence has to
  // read as one even after somebody deletes half of it in X's composer.
  if (m.kind === "position") {
    return voice === "x"
      ? `Called by ${them}. ${us} is running it on my own Hyperliquid account — ` +
        `${m.title} ${result} unrealised`
      : `Quotient called it. Mandate is running it on my own Hyperliquid account — ` +
        `${m.title} ${result} unrealised`;
  }
  if (m.kind === "account") {
    return voice === "x"
      ? `A week of ${them}'s outlooks, executed by ${us} on my own Hyperliquid ` +
        `account: ${result} realised, net of costs`
      : `A week of Quotient's outlooks, executed by Mandate on my own Hyperliquid ` +
        `account: ${result} realised, net of costs`;
  }
  return voice === "x"
    ? `Outlooks from ${them}, executed by ${us} on your own Hyperliquid account, with a key that cannot withdraw`
    : "Quotient researches. Mandate executes, on your own Hyperliquid account, with a key that cannot withdraw";
}
