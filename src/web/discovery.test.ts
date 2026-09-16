import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { validate } from "../exec/settings.ts";
import { DEFAULT_USER_SETTINGS, LIVE_MANDATE, maxConcurrentSignals, minFundedForLiveUsd, RISK_PARAMS } from "../risk/params.ts";
import {
  DISALLOWED, llmsTxt, NAMED_AGENTS, robotsTxt,
  SITE_OFFERS, sitemapXml,
} from "./discovery.ts";
import { ICON_512, ICONS } from "./icons.ts";
import { designPage } from "./page.ts";

const ORIGIN = "https://mandate.markets";
const PAGE = designPage();

// The property this file exists for: the bounds a model quotes are the bounds the
// executor enforces. Every number in the rendered text must be one of the parameters
// it was assembled from — no stray figure, and no parameter missing.
test("every number in llms.txt is a parameter, and every parameter is in llms.txt", () => {
  const text = llmsTxt(ORIGIN);
  const r = RISK_PARAMS;
  const d = DEFAULT_USER_SETTINGS;
  const expected = new Set<number>([
    ...SITE_OFFERS.leverage,
    SITE_OFFERS.stopPct.min * 100, SITE_OFFERS.stopPct.max * 100,
    SITE_OFFERS.perSignalPct.min * 100, SITE_OFFERS.perSignalPct.max * 100,
    d.leverage, d.stopPct * 100, d.perSignalPct * 100,
    r.liqBufferFrac * 100, r.maxDeployedPct * 100, r.reserveFrac * 100, r.dailyLossPct * 100,
    // The position count is no longer one number for everybody (`tasks/21` §8), so the
    // text quotes it at the two ends of the slider and at the default, and all three
    // have to be derived here rather than written down.
    maxConcurrentSignals({ perSignalPct: SITE_OFFERS.perSignalPct.min }),
    maxConcurrentSignals(d),
    maxConcurrentSignals({ perSignalPct: SITE_OFFERS.perSignalPct.max }),
    r.maxHoldHours, r.capacity.minVolume24hUsd, r.minOrderNotionalUsd,
    minFundedForLiveUsd(d),
    minFundedForLiveUsd({ perSignalPct: SITE_OFFERS.perSignalPct.min, leverage: 5 }),
    LIVE_MANDATE.maxLiveAccounts,
  ].map((n) => Math.round(n * 1000) / 1000));

  // Strip the canonical URL first: it carries no digits today, and a port or a path
  // in a staging origin must not be read as a parameter.
  //
  // ISO dates go the same way and for the same reason. A date is not a bound the
  // executor enforces, so admitting 2026 and 09 to `expected` would leave the set
  // holding three numbers that mean nothing — and would wave through any stray figure
  // that happened to match one of them. Stripped here, asserted on its own below.
  const body = text.replace(/https?:\/\/\S+/g, "").replace(/\d{4}-\d{2}-\d{2}/g, "");
  const found = [...body.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0]!.replace(/,/g, "")));
  assert.ok(found.length >= expected.size, `expected at least ${expected.size} figures, found ${found.length}`);
  for (const n of found) assert.ok(expected.has(n), `${n} appears in llms.txt but is not a parameter`);
  for (const n of expected) assert.ok(found.includes(n), `parameter ${n} is missing from llms.txt`);

  // The one date the text carries, asserted rather than stripped and forgotten. A model
  // reading this while the setting is locked has to be able to say when it opens, or it
  // will describe an option the site refuses as though it were available today.
  assert.ok(
    text.includes(SITE_OFFERS.holdToTargetOpensAt),
    "llms.txt must name the date the exit-policy choice opens",
  );
});

// The ranges in the text are the sliders' own. `validate()` accepts more — an
// operator's file may say so — and the site deliberately offers less.
test("the offered ranges are the connect screen's slider attributes, and validate accepts them", () => {
  const attr = (id: string, name: string) => {
    const m = PAGE.match(new RegExp(`<input[^>]*id="${id}"[^>]*\\b${name}="([^"]+)"`));
    assert.ok(m, `#${id} has no ${name}`);
    return Number(m![1]);
  };
  assert.equal(attr("sp", "min"), SITE_OFFERS.stopPct.min * 100);
  assert.equal(attr("sp", "max"), SITE_OFFERS.stopPct.max * 100);
  assert.equal(attr("ps", "min"), SITE_OFFERS.perSignalPct.min * 100);
  assert.equal(attr("ps", "max"), SITE_OFFERS.perSignalPct.max * 100);
  const levs = [...PAGE.matchAll(/<button data-l="(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(levs, [...SITE_OFFERS.leverage]);
  for (const leverage of SITE_OFFERS.leverage) {
    validate({ leverage, stopLoss: true, stopPct: SITE_OFFERS.stopPct.max, perSignalPct: SITE_OFFERS.perSignalPct.max, holdToTarget: false });
    validate({ leverage, stopLoss: true, stopPct: SITE_OFFERS.stopPct.min, perSignalPct: SITE_OFFERS.perSignalPct.min, holdToTarget: false });
  }
});

// Phase 3 reads "too small to say", and this is the file a model quotes.
test("llms.txt promises nothing", () => {
  const text = llmsTxt(ORIGIN).toLowerCase();
  for (const word of ["return", "expectancy", "profit", "guarantee", "apy", "win rate", "accounts trade", "users"]) {
    assert.ok(!text.includes(word), `"${word}" must not appear`);
  }
  assert.match(text, /non-custodial/);
  assert.match(text, /quotient/);
  assert.match(text, /hyperliquid/);
  assert.match(text, /pauses the account/, "pause, not stop — the halt leaves every exit resting");
});

// A robot obeys exactly one group and ignores `*`. A named group holding only
// `Allow: /` would silently exempt that bot from `/api/`, so every group restates what
// applies to it — and `/api/` applies to all of them.
test("every named group in robots.txt restates the disallows that apply to it", () => {
  const text = robotsTxt(ORIGIN);
  const groups = text.split("\n\n").filter((g) => g.startsWith("User-agent:"));
  assert.equal(groups.length, 1 + NAMED_AGENTS.length);
  for (const g of groups) {
    assert.ok(g.includes("Allow: /"), `${g.split("\n")[0]} lacks Allow: /`);
    for (const p of DISALLOWED) {
      assert.ok(g.includes(`Disallow: ${p}`), `${g.split("\n")[0]} lacks ${p}`);
    }
  }
  for (const a of NAMED_AGENTS) assert.ok(text.includes(`User-agent: ${a}\n`), a);
});

// **The disallow that switched the whole feature off, and the allowlist that tried to
// patch around it.** `og:image` points into `/share/`, and a scraper that may not fetch
// it renders a title and a blank rectangle — which is what a pasted Mandate link looked
// like on X. Naming the eight crawlers we could think of left every other one blank, so
// nothing is disallowed there now for anybody. `/api/` still is, for everybody.
test("nothing is kept off /share/, because that is where every card lives", () => {
  const text = robotsTxt(ORIGIN);
  assert.ok(!text.includes("Disallow: /share/"), "a card nobody may fetch is not a card");
  assert.equal(text.match(/Disallow: /g)?.length, 1 + NAMED_AGENTS.length, "one each, /api/");
  for (const a of ["*", ...NAMED_AGENTS]) {
    const g = text.split("\n\n").find((x) => x.startsWith(`User-agent: ${a}\n`))!;
    assert.ok(g.includes("Disallow: /api/"), `${a} should still be kept off /api/`);
  }
});

test("robots.txt names the sitemap absolutely, from the origin it was given", () => {
  assert.match(robotsTxt("https://mandate.markets"), /^Sitemap: https:\/\/mandate\.markets\/sitemap\.xml$/m);
  assert.match(robotsTxt("http://localhost:8788"), /^Sitemap: http:\/\/localhost:8788\/sitemap\.xml$/m);
});

test("the sitemap is the root and only the root", () => {
  const xml = sitemapXml(ORIGIN);
  assert.deepEqual([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]), ["https://mandate.markets/"]);
  assert.ok(!/lastmod|priority|changefreq/.test(xml));
});

// The last line of `tasks/15` §4: if the string is not in the HTML, it does not exist
// as far as any reader in that task is concerned.
// `tasks/20` §2.1 and §5. The measurement that opened that task was three paths in the
// head answering with 258 KB of HTML, which is invisible from the page and from the code:
// a `<link>` naming a path nothing serves renders as a blank tab and nothing errors. So
// the head is held to the table the server routes from, and the table to the files on
// disk — the three ways this can rot are a link with no route, a route with no file, and
// a file the generators stopped writing.
test("every icon the head links is one the server serves, and one that exists", () => {
  const linked = [...PAGE.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  assert.ok(linked.length >= 3, "the head links the SVG, the ICO and the touch icon");
  for (const href of linked) assert.ok(href in ICONS, `${href} is in the head but not served`);
  for (const path of Object.keys(ICONS)) {
    assert.ok(existsSync(`design/static${path}`), `${path} is served but not on disk — run design/tools/mark.py && npm run icons`);
  }
  // The one the structured data points at, absolute, because a scraper does not resolve
  // a relative URL against a page it fetched by another name.
  const ld = JSON.parse(PAGE.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!) as Record<string, unknown>;
  assert.equal(ld.image, `https://mandate.markets${ICON_512}`);
});

test("the page itself says the words a researcher types", () => {
  for (const word of ["non-custodial", "Quotient", "Hyperliquid", "Mandate"]) {
    assert.ok(PAGE.includes(word), `"${word}" is not in design/mandate.html`);
  }
  const description = PAGE.match(/<meta name="description" content="([^"]+)">/)?.[1];
  assert.ok(description && description.length > 60, "a description tag, with a sentence in it");
  assert.ok(PAGE.includes(`<meta property="og:description" content="${description}">`), "og:description is the same sentence");
  assert.ok(PAGE.includes('<link rel="canonical" href="https://mandate.markets/">'));
  // `summary` until `tasks/16` had an image to point at; `summary_large_image` now
  // that `/share/home.png` exists. `cards.test.ts` owns the whole social block and
  // asserts it byte-for-byte against `socialTags()`.
  assert.ok(PAGE.includes('<meta name="twitter:card" content="summary_large_image">'));
  assert.ok(PAGE.includes('<meta property="og:image" content="https://mandate.markets/share/home.png">'));
  const ld = PAGE.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(ld, "structured data, inline, once");
  const parsed = JSON.parse(ld!) as Record<string, unknown>;
  assert.equal(parsed["@type"], "SoftwareApplication");
  assert.equal(parsed.description, description, "the same sentence again — one claim, not three");
  for (const k of ["offers", "aggregateRating", "datePublished"]) assert.ok(!(k in parsed), `${k} would be a claim`);
  const daily = `${Math.round(RISK_PARAMS.dailyLossPct * 100)}%`;
  const fact = PAGE.match(/<p class="sub fact">([\s\S]*?)<\/p>/)?.[1] ?? "";
  assert.ok(fact.includes(daily), `the quotable paragraph names the ${daily} halt the executor enforces`);
});
