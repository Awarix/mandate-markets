import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURES, hlSymbol } from "../signals/captures.ts";
import type { CloseReason } from "../types.ts";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, minFundedForLiveUsd, RISK_PARAMS } from "../risk/params.ts";
import {
  accountCard, type AccountParams, CANONICAL_ORIGIN, CARD_H, CARD_MARKETS, CARD_W,
  cardDescription, cardTitle, CLOSE_REASONS, DISCLAIMER, DOLLARS_DEFAULT, DOLLARS_NOTE,
  figure, homeCard, HOME_CARD_PATH, HOME_DESCRIPTION, HOME_TITLE, marketCode, parseAccount,
  parsePosition, parseTrade, positionCard, type PositionParams, query, reasonCode,
  signedFigure, type SignedKind, socialTags, SOCIAL_CLOSE, SOCIAL_OPEN, shareText, tradeCard,
  type CardModel, type TradeParams,
} from "./cards.ts";
import { designPage } from "./page.ts";

// `tasks/16`. What is tested here is every decision a card makes before it is drawn —
// which figures it carries, which words, which colour, and whether its numbers are
// ours. **The pixels are not tested**: asserting on a PNG is asserting on a
// rasteriser's version, and the tree in `render.ts` is the part the designer replaces.

const PAGE = designPage();
const SECRET = "test-secret-not-the-live-one";

/** The dollar-bearing spelling of each card, `d = 1`. `y` is the same result in basis
 *  points of the card's own denominator, and it is what survives when the dollars are
 *  switched off. */
const TRADE: TradeParams = { d: 1, y: 412, p: 494, g: 12_000, m: 11, s: 1, l: 10, r: 0, a: 2_188_600, b: 2_301_000, h: 384, x: 183, t: 1_788_000_000 };
const POSITION: PositionParams = { d: 1, y: 412, p: 494, g: 12_000, m: 11, s: 1, l: 10, a: 2_188_600, b: 2_201_000, h: 384, x: 183, t: 1_788_000_000 };
const ACCOUNT: AccountParams = { d: 1, y: 310, p: 1842, n: 12, w: 7, o: 3, e: 2, l: 10, q: 300, z: 1000, t: 1_788_000_000 };

/** The same card with the dollars off: the amount and the margin are **removed**, not
 *  zeroed, because a zero is still an amount in the URL. */
const noDollars = <T extends { d: number; p?: number; g?: number }>(p: T): Record<string, number> => {
  const { p: _p, g: _g, ...rest } = p;
  return { ...rest, d: 0 };
};

const params = (q: string) => new URLSearchParams(q);
const signed = (kind: SignedKind, p: Record<string, number>) => params(query(SECRET, kind, p));

// ── The parser, before the signature ───────────────────────────────────────
//
// Eater's rule and Eater's reason: `parseInt('12abc')` is 12 and `Number('')` is 0, so
// neither is a validator. This is the guard that holds even if the secret leaks.

test("figure takes digits and nothing else", () => {
  assert.equal(figure("42", 100), 42);
  assert.equal(figure("0", 100), 0);
  assert.equal(figure("12abc", 100), null, "parseInt would say 12");
  assert.equal(figure("", 100), null, "Number would say 0");
  assert.equal(figure(null, 100), null);
  assert.equal(figure(" 42", 100), null);
  assert.equal(figure("4.2", 100), null);
  assert.equal(figure("-42", 100), null, "unsigned fields must not take a sign");
  assert.equal(figure("101", 100), null, "bounded");
  assert.equal(figure("9".repeat(13), 1e99), null, "and length-bounded before Number sees it");
});

test("signedFigure takes one leading minus and still nothing else", () => {
  assert.equal(signedFigure("-42", 100), -42);
  assert.equal(signedFigure("42", 100), 42);
  assert.equal(signedFigure("--42", 100), null);
  assert.equal(signedFigure("-", 100), null);
  assert.equal(signedFigure("-101", 100), null, "the bound is on the magnitude");
});

// ── The signature ──────────────────────────────────────────────────────────

test("a card's own query verifies, and one changed digit does not", () => {
  assert.deepEqual(parseTrade(signed("trade", TRADE), SECRET), TRADE);

  const tampered = signed("trade", TRADE);
  tampered.set("p", "99999");
  assert.equal(parseTrade(tampered, SECRET), null, "a forged result must not draw");

  const short = signed("trade", TRADE);
  short.delete("h");
  assert.equal(parseTrade(short, SECRET), null, "a missing parameter is not a default");

  const nosig = signed("trade", TRADE);
  nosig.delete("k");
  assert.equal(parseTrade(nosig, SECRET), null);
});

test("a signature is bound to its kind, so a trade card cannot be replayed as an account", () => {
  assert.equal(parseAccount(signed("trade", TRADE), SECRET), null);
  // And the same figures signed as one kind do not verify as the other.
  const both = { d: 1, y: 1, p: 100, n: 1, w: 1, o: 0, e: 0, l: 10, q: 300, z: 1000, t: 1 };
  assert.notEqual(query(SECRET, "trade", both), query(SECRET, "account", both));
});

// A closed trade and an open one carry nearly the same numbers, and they say very
// different things — one has a close reason and the other says "still open". Signing
// them under one kind would let a card of one be re-served as the other.
test("an open position and a closed trade are different kinds, and neither replays as the other", () => {
  assert.deepEqual(parsePosition(signed("position", POSITION), SECRET), POSITION);
  assert.equal(parseTrade(signed("position", POSITION), SECRET), null);
  assert.equal(parsePosition(signed("trade", TRADE), SECRET), null);
});

test("the signature covers the values, not the way they were spelled or ordered", () => {
  const q = signed("trade", TRADE);
  const shuffled = new URLSearchParams();
  for (const k of [...q.keys()].reverse()) shuffled.set(k, q.get(k)!);
  assert.deepEqual(parseTrade(shuffled, SECRET), TRADE, "parameter order is not signed");

  const padded = signed("trade", TRADE);
  padded.set("l", "010");
  assert.deepEqual(parseTrade(padded, SECRET), TRADE, "and `010` is the same ten, so it is the same card");
});

test("another secret's card does not verify, and no secret verifies nothing", () => {
  assert.equal(parseTrade(signed("trade", TRADE), "a-different-secret"), null);
  assert.equal(parseTrade(signed("trade", TRADE), null), null);
  assert.equal(parseAccount(signed("account", ACCOUNT), null), null);
});

// ── The dollars switch ─────────────────────────────────────────────────────
//
// The dialog's checkbox promises that the dollars are *not in the link*. These are the
// assertions that make that a property rather than a claim.

test("the dollars-off spelling carries no amount anywhere in its query", () => {
  for (const [kind, p] of [["trade", TRADE], ["position", POSITION], ["account", ACCOUNT]] as const) {
    const q = signed(kind as SignedKind, noDollars(p));
    assert.equal(q.get("p"), null, `${kind}: the cents must be absent, not zero`);
    assert.equal(q.get("g"), null, `${kind}: and so must the margin`);
    assert.equal(q.get("d"), "0");
    // The percentage survives, because it divides into nothing on its own.
    assert.equal(q.get("y"), String(p.y));
  }
});

// **The test that was missing on 2026-09-05.** Every kind, both spellings, issued the
// way the share routes issue it and parsed the way the image route parses it. The gap
// before was that only the trade card was round-tripped; the account card's model
// function was called directly, so nobody noticed that `parseAccount` demanded a `g`
// the account card must never carry — and every account card with the dollars on drew
// the product card instead of itself.
test("every kind round-trips through its own parser, with the dollars on and off", () => {
  const parse = { trade: parseTrade, position: parsePosition, account: parseAccount } as const;
  for (const [kind, on] of [["trade", TRADE], ["position", POSITION], ["account", ACCOUNT]] as const) {
    const back = parse[kind](signed(kind, on), SECRET);
    assert.notEqual(back, null, `${kind} with the dollars ON did not verify its own link`);
    assert.deepEqual(back, on, kind);

    const off = noDollars(on);
    const backOff = parse[kind](signed(kind, off), SECRET);
    assert.notEqual(backOff, null, `${kind} with the dollars OFF did not verify its own link`);
    assert.deepEqual(backOff, off, kind);
  }
});

// The account card's denominator is the mandate. A `g` on it would be that mandate in
// the URL, which is the one thing this card exists not to do.
test("the account card has no margin key at all, on either spelling", () => {
  for (const p of [ACCOUNT, noDollars(ACCOUNT)]) {
    assert.equal(signed("account", p).get("g"), null);
  }
});

test("a dollars-off card that has had an amount appended is refused, not ignored", () => {
  const q = signed("trade", noDollars(TRADE));
  q.set("p", "494");
  assert.equal(parseTrade(q, SECRET), null, "otherwise the amount rides in a URL that promised not to carry it");

  const g = signed("account", noDollars(ACCOUNT));
  g.set("g", "0");
  assert.equal(parseAccount(g, SECRET), null);
});

test("flipping the flag on a link somebody was handed does not verify", () => {
  const off = signed("trade", noDollars(TRADE));
  off.set("d", "1");
  assert.equal(parseTrade(off, SECRET), null);

  const on = signed("trade", TRADE);
  on.set("d", "0");
  assert.equal(parseTrade(on, SECRET), null, "and the amounts are still in this one, which is why");
});

test("with the dollars off the card draws the percentage alone", () => {
  const m = tradeCard(parseTrade(signed("trade", noDollars(TRADE)), SECRET)!);
  assert.equal(m.figure, "+4.12%");
  assert.equal(m.subfigure, "", "nothing under it — there is no second unit to show");
  // The **prices** are still there: they are public market data, and it is the size
  // behind a price the switch is about, never the price. So this checks for an *amount*.
  assert.ok(!m.subfigure.includes("$"));
  assert.ok(!strings(m).some((s) => /\(\+?−?\$/.test(s)), "no parenthesised amount survived");
});

test("with the dollars on the percentage still leads and the amount sits under it", () => {
  const m = tradeCard(TRADE);
  // The percentage leads: it is the comparable figure, and it says nothing about how
  // much money is behind it (owner, 2026-09-05, after seeing the dollars lead).
  assert.equal(m.figure, "+4.12%");
  assert.equal(m.subfigure, "(+$4.94)");
  // "of margin", the close reason and the margin all came off the same day — the card
  // was carrying more sentences than a picture in a feed can be read for.
  for (const s of strings(m)) assert.ok(!/of margin|Margin posted/i.test(s), s);
});

// It came off the picture rather than being dropped: a description is read at the
// reader's own pace, so it can carry the sentence the card could not.
test("the settlement claim moved from the card face to the description", () => {
  assert.ok(!strings(tradeCard(TRADE)).some((s) => /net of fees/i.test(s)));
  assert.match(cardDescription(tradeCard(TRADE)), /Net of fees and funding/);
  assert.match(cardDescription(positionCard(POSITION)), /Unrealised, before fees and funding/);
});

test("the checkbox starts on for one position and off for the account", () => {
  assert.equal(DOLLARS_DEFAULT.trade, true);
  assert.equal(DOLLARS_DEFAULT.position, true);
  // The account card's percentage is of the mandate, so dollars beside it give the
  // mandate exactly — a bigger thing to hand a stranger than one position's margin.
  assert.equal(DOLLARS_DEFAULT.account, false);
  assert.match(DOLLARS_NOTE.account, /what the account holds/);
  assert.match(DOLLARS_NOTE.trade, /position/);
});

test("a market we have no code for is refused even with a good signature", () => {
  const q = signed("trade", { ...TRADE, m: 998 });
  assert.equal(parseTrade(q, SECRET), null, "the table is the only source of a symbol");
});

// ── The two tables ─────────────────────────────────────────────────────────

test("every Hyperliquid symbol Quotient references has a card code", () => {
  // Both captures, because the point is coverage of the feed and not of one poll: a
  // market Quotient starts referencing is a card that would otherwise draw the product
  // card instead of the trade. 16 distinct symbols on 08-30, 16 on 09-10 (`tasks/46`
  // §3.1) — the same set, which is itself worth knowing and is in `fixtures/README.md`.
  for (const c of CAPTURES) {
    const symbols = new Set<string>();
    for (const s of c.payload.series) {
      const sym = hlSymbol(s);
      if (sym !== null) symbols.add(sym);
    }
    assert.ok(symbols.size > 0, `${c.name} names no Hyperliquid symbol at all`);
    for (const sym of symbols) assert.notEqual(marketCode(sym), null, `${c.name}: ${sym} has no code in CARD_MARKETS`);
  }
});

// An old card's URL is a permanent link into this table. Two markets sharing a code
// would make one of them un-nameable; a code moving would rename a card shared last
// month, which is the failure a positional index would have made easy.
test("market codes are unique and stable", () => {
  const codes = Object.keys(CARD_MARKETS).map(Number);
  assert.equal(new Set(codes).size, codes.length);
  assert.equal(new Set(Object.values(CARD_MARKETS)).size, codes.length);
  assert.equal(CARD_MARKETS[1], "BTC");
  assert.equal(CARD_MARKETS[2], "ETH");
  for (const c of codes) assert.ok(Number.isInteger(c) && c > 0, `${c} is not a positive integer code`);
});

test("the close-reason table is the ledger's own reasons, in an append-only order", () => {
  assert.deepEqual(
    CLOSE_REASONS.map((r) => r.reason),
    ["target", "stop", "horizon", "retired", "halt", "disconnect", "flipped", "liquidated"],
  );
  assert.equal(reasonCode("stop"), 1);
  assert.equal(reasonCode("nonsense"), null);
  assert.equal(reasonCode(null), null);
  // ⚠ The first seven codes are inside the HMAC of every share card already issued, so
  // they are frozen: a reason inserted rather than appended re-points live cards at a
  // different sentence. `flipped` (tasks/44) is 6, `liquidated` is 7, and every code
  // before each is unmoved.
  assert.deepEqual(
    ["target", "stop", "horizon", "retired", "halt", "disconnect", "flipped", "liquidated"].map(reasonCode),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
});

// The ledger's `CloseReason` and the card's table are the same list, and the card is
// what the world reads. A reason that can be written and cannot be drawn refuses the
// card with "we cannot say why that trade closed", which is the one sentence that must
// never be true of a trade we recorded a reason for.
test("every CloseReason the ledger can write has a card sentence", () => {
  const written: CloseReason[] = [
    "target", "stop", "horizon", "retired", "halt", "disconnect", "flipped", "liquidated",
  ];
  for (const r of written) assert.notEqual(reasonCode(r), null, r);
  assert.equal(written.length, CLOSE_REASONS.length);
});

// ── What a card says ───────────────────────────────────────────────────────

const ALL: CardModel[] = [homeCard(), positionCard(POSITION), tradeCard(TRADE), accountCard(ACCOUNT)];

const strings = (m: CardModel): string[] => [
  m.eyebrow, m.title, m.figure, m.subfigure, m.headline, m.credit, m.disclaimer,
  ...m.detail, ...m.facts.flatMap((f) => [f.label, f.value]),
];

// `tasks/12`: the citation is an obligation on every surface that presents Quotient's
// analysis, and a card in a feed is the most public surface we have. There is no
// second place to put it — the picture travels without the page.
test("every card names Quotient, and so does every share sentence", () => {
  for (const m of ALL) {
    assert.match(m.credit, /Quotient/, `${m.kind} card`);
    assert.match(shareText(m), /Quotient/, `${m.kind} share text`);
    assert.match(shareText(m, "x"), /Quotient/, `${m.kind} share text, tagged`);
    assert.match(cardDescription(m), /Quotient/, `${m.kind} og:description`);
  }
});

// The handles are for X and for nowhere else. Telegram resolves an `@name` against its
// own directory, so a handle in the plain sentence sends a Telegram reader to whoever
// holds that name there — and the clipboard and the OS sheet mention nobody at all.
test("the tagged sentence is X's, and the plain one carries no handle", () => {
  for (const m of ALL) {
    const x = shareText(m, "x");
    assert.match(x, /@MandateMarkets/, `${m.kind} tags us`);
    assert.match(x, /@QuotientHQ/, `${m.kind} tags Quotient`);
    // X shows a post that *begins* with a mention only to people who follow both
    // accounts, so every one of these puts a word in front of the handle.
    assert.ok(!x.startsWith("@"), `${m.kind} opens with a mention, which is a reply: ${x}`);
    assert.ok(!shareText(m).includes("@"), `${m.kind} plain sentence carries a handle`);
  }
});

// Measured 2026-09-05: neither General Sans nor Tabular has a glyph for `σ` or `→`,
// and satori has no system fallback — it draws .notdef and nothing errors. The desk
// gets away with `1.83σ` because a browser falls through to another family; a card
// cannot. This is the assertion that stops it coming back in a copy edit.
test("no card draws a glyph the two faces do not carry", () => {
  for (const m of ALL) {
    for (const s of strings(m)) {
      assert.ok(!/[σ→←↑↓≈]/.test(s), `${m.kind} card draws a glyph the fonts lack: ${JSON.stringify(s)}`);
    }
  }
  // And the sigma is still reported, in words.
  assert.match(tradeCard(TRADE).credit, /1\.83 sigma/);
});

test("a trade with no signal row says nothing about sigma rather than 0.00", () => {
  const m = tradeCard({ ...TRADE, x: 0 });
  assert.ok(!m.credit.includes("sigma"), m.credit);
  assert.ok(!m.credit.includes("0.00"), m.credit);
});

// The product card is what every bare mandate.markets link gets, so it is the
// most-seen picture we own — and Phase 3 reads "too small to say".
test("the product card promises nothing and states no result", () => {
  const m = homeCard();
  assert.equal(m.figure, "", "no result to lead with, so it leads with the sentence");
  assert.equal(m.disclaimer, "", "and nothing to disclaim");
  const text = strings(m).join(" ").toLowerCase();
  for (const word of ["return", "profit", "expectancy", "guarantee", "apy", "win"]) {
    assert.ok(!text.includes(word), `"${word}" must not appear on the product card`);
  }
});

// The same rule `llms.txt` follows: the bounds a reader quotes are the bounds the
// executor enforces. This card was specified when they were "50% deployed, 5
// positions"; `tasks/21` made that 100% and a derived count, and a typed figure would
// still be saying 50%.
test("the product card's bounds are the parameters, not literals", () => {
  const values = homeCard().facts.map((f) => f.value);
  assert.ok(values.includes(`${Math.round(RISK_PARAMS.maxDeployedPct * 100)}%`), values.join(" | "));
  assert.ok(values.includes(String(maxConcurrentSignals(DEFAULT_USER_SETTINGS))), values.join(" | "));
  assert.ok(values.includes(`${Math.round(RISK_PARAMS.dailyLossPct * 100)}%`), values.join(" | "));
  assert.ok(values.includes(`$${minFundedForLiveUsd(DEFAULT_USER_SETTINGS).toFixed(2)}`), values.join(" | "));
});

test("a trade card names its market, its side and why it closed, and never the account", () => {
  const win = tradeCard(TRADE);
  assert.equal(win.tone, "up");
  assert.equal(win.title, "xyz:NVDA", "the market is the title, in the accent colour");
  assert.match(win.detail.join(" "), /Market: LONG 10×/);
  assert.match(win.detail.join(" "), /\$218\.86 » \$230\.1/, "entry to exit, with a glyph both faces have");
  assert.match(win.detail.join(" "), /held 6\.4h/);
  assert.equal(win.disclaimer, DISCLAIMER);

  const loss = tradeCard({ ...TRADE, y: -3062, p: -1837, g: 6000, r: 1, s: 0, l: 20, m: 1 });
  assert.equal(loss.tone, "down", "a stopped trade is as shareable as a target hit");
  assert.equal(loss.figure, "−30.62%");
  assert.equal(loss.subfigure, "(−$18.37)");
  assert.equal(loss.title, "BTC");
  assert.match(loss.detail.join(" "), /Market: SHORT 20×/);
});

// §5 of the task refused this card, and the refusal's reason was that it would be a
// claim about a number that has not happened. These three lines are what makes it a
// snapshot instead.
test("an open position's card says it is open, unrealised, and when it was taken", () => {
  const m = positionCard(POSITION);
  assert.equal(m.kind, "position");
  const said = m.detail.join(" ");
  assert.match(said, /Still open/);
  assert.match(said, /unrealised, before fees and funding/);
  assert.match(said, /29 Aug, 10:40 UTC/, "the instant it was taken, on the card");
  assert.match(said, /open 6\.4h/, "not 'held' — it is still being held");
  assert.match(said, /mark/, "the second price is a mark, not an exit");
  // It must never claim an outcome. Every close reason's own words, checked.
  for (const r of CLOSE_REASONS) {
    assert.ok(!strings(m).join(" ").includes(r.short), `an open card must not say "${r.short}"`);
  }
  assert.ok(!/\bclosed\b/.test(strings(m).join(" ")), "and must not say closed");
  assert.match(shareText(m), /is running it/, "the sentence is present tense too");
});

// The owner decided on 2026-09-05 that the account card does not show the balance: it
// is the one number that makes a stranger's screenshot a target. The percentage is of
// the mandate, so the dollars beside it give the mandate in one division — which is why
// the checkbox defaults off here and why the note beside it says so.
test("the account card never names the balance, whichever way the switch is set", () => {
  for (const m of [accountCard(ACCOUNT), accountCard(parseAccount(signed("account", noDollars(ACCOUNT)), SECRET)!)]) {
    for (const s of strings(m)) {
      // The percentages that remain are the *settings* — 10% per position, a 3% stop —
      // which say nothing about how much the account holds.
      assert.ok(!/of (the )?(mandate|balance|account|equity)/i.test(s), `${s} would give the balance away`);
    }
  }
  assert.equal(accountCard(ACCOUNT).figure, "+3.10%");
  assert.equal(accountCard(ACCOUNT).subfigure, "(+$18.42)");
});

// People share wins, so a feed of these is greener than the ledger by construction
// (`tasks/16` §6.3). The counted refusals beside the hits are the honest half of that.
test("the account card counts the stopped trades beside the hits", () => {
  const said = accountCard(ACCOUNT).detail.join(" ");
  assert.match(said, /12 trades/);
  assert.match(said, /7 hit target/);
  assert.match(said, /3 stopped/);
  assert.match(said, /2 closed otherwise/);
  assert.match(accountCard({ ...ACCOUNT, n: 1 }).detail.join(" "), /^1 trade\b/);
});

test("a stop that was turned off says so rather than reading as 0%", () => {
  assert.match(accountCard({ ...ACCOUNT, q: 0 }).detail.join(" "), /no stop/);
  assert.match(accountCard(ACCOUNT).detail.join(" "), /3% stop/);
});

// ── The head a scraper reads ───────────────────────────────────────────────

test("one function emits every social tag, and the image URL is the same in all of them", () => {
  const tags = socialTags({
    origin: CANONICAL_ORIGIN, imagePath: "/share/trade.png?k=abc", landingPath: "/s/trade?k=abc",
    title: "t", description: "d",
  });
  const images = [...tags.matchAll(/content="(https:[^"]*share[^"]*)"/g)].map((m) => m[1]);
  assert.equal(images.length, 2, "og:image and twitter:image, and no third copy");
  assert.equal(new Set(images).size, 1, "which must be the same URL");
  assert.match(tags, new RegExp(`content="${CARD_W}"`));
  assert.match(tags, new RegExp(`content="${CARD_H}"`));
  assert.match(tags, /twitter:card" content="summary_large_image"/);
});

// The default block in the page and the generated one for a share landing are the same
// tags from the same function, or the two fork and nobody notices for a month.
test("the page's own social block is byte-for-byte what socialTags emits for the product card", () => {
  const open = PAGE.indexOf(SOCIAL_OPEN);
  const close = PAGE.indexOf(SOCIAL_CLOSE);
  assert.ok(open !== -1 && close > open, "design/mandate.html has lost its social markers");
  const block = PAGE.slice(open + SOCIAL_OPEN.length, close).trim();
  assert.equal(block, socialTags({
    origin: CANONICAL_ORIGIN, imagePath: HOME_CARD_PATH, landingPath: "/",
    title: HOME_TITLE, description: HOME_DESCRIPTION,
  }));
});

test("the page's description tag is the one the product card's tags quote", () => {
  assert.ok(PAGE.includes(`<meta name="description" content="${HOME_DESCRIPTION}">`));
});

test("a card's description is composed from its own numbers", () => {
  const d = cardDescription(tradeCard(TRADE));
  assert.match(d, /\+4\.12%/);
  assert.match(d, /\(\+\$4\.94\)/);
  assert.match(d, /\$218\.86 » \$230\.1/);
  assert.equal(cardTitle(tradeCard(TRADE)), "xyz:NVDA +4.12% — executed by Mandate");
  assert.equal(cardTitle(homeCard()), HOME_TITLE);
});

// The sentence is composed on the server so the citation cannot be edited out of the
// default, and it carries no trailing colon: X and Telegram take the link in a field
// of their own, and the sheet folds it in with one.
test("the share sentence is ours and ends without a colon", () => {
  for (const m of ALL) {
    const t = shareText(m);
    assert.ok(!t.endsWith(":"), t);
    assert.ok(!t.includes("http"), "the link is a separate field");
  }
  assert.match(shareText(tradeCard(TRADE)), /^Quotient called it\. Mandate executed it/);
});
