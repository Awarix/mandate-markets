import { DEFAULT_USER_SETTINGS, LIVE_MANDATE, maxConcurrentSignals, minFundedForLiveUsd, RISK_PARAMS } from "../risk/params.ts";

// What a crawler, an answer engine and a link scraper get (`tasks/15`).
//
// Three small documents, each generated rather than committed, for one reason each:
// `robots.txt` must name the sitemap **absolutely**, so it is built from the runtime
// origin; `sitemap.xml` has exactly one URL and the same origin problem; and
// `llms.txt` quotes the bounds the executor enforces, so it is assembled from
// `RISK_PARAMS` and friends and a test asserts every number in it equals the
// parameter it came from. A hand-written copy of $40 that drifts would be quoted by a
// model long after the code stopped saying it.
//
// Every one of these is read by something that will repeat a checkable number and
// drop an adjective. So: present tense, no return, no expectancy, no account count,
// no promise — and nothing that the page does not also say somewhere a person can
// look (`notes/2026-09-03-marketing-findings.md`).

/** The ranges the connect screen offers. **Narrower than `validate()` accepts** —
 *  `validate` admits any stop under 50% and any size up to 100%, because an operator's
 *  `accounts/<address>.json` may legitimately say so; the sliders stop where
 *  `notes/2026-09-02-settings-range.md` argues they should. `discovery.test.ts` pins
 *  these to the slider attributes in `design/mandate.html`, so the file a model reads
 *  and the controls a person drags cannot disagree. */
export const SITE_OFFERS = {
  /** ⚠ **18× is here for the stop ceiling, not for the leverage** — item 25. On a
   *  20×-max asset `clampStopPct` lets 20× arm only **1.75%**, while this file offers
   *  stops to 8% and `DEFAULT_USER_SETTINGS` is 2%: the site was selling a stop its own
   *  top leverage could not arm. 18× arms a full 2% there and leaves *more* room to
   *  liquidation than 20× does (0.76pp against 0.45pp), without moving `liqBufferFrac`
   *  — which would have loosened every other account's ceiling to fix one tier.
   *  `notes/2026-09-12-how-a-20x-account-arms-a-2-percent-stop.md`. */
  leverage: [5, 10, 18, 20] as const,
  stopPct: { min: 0.01, max: 0.08 },
  perSignalPct: { min: 0.05, max: 0.25 },
  /** The exit-policy choice ships **visible and locked** until this date, UTC.
   *
   *  Not a soft launch and not a staged rollout — it is one specific measurement
   *  finishing. `minDisplacementSigma` moved 1.0 → 0.5 on 2026-09-07 09:46Z, and
   *  `notes/2026-09-07-backtest-sigma-and-exit-policy.md` §7 wrote down what that gate
   *  should deliver — +1.45% per signal, 70% hit rate — **before** the block that
   *  judges it, which is the only thing that makes it a test rather than a fit. That
   *  prediction assumes positions close when Quotient drops its direction. Letting the
   *  other policy loose on the same block would leave nobody able to say which of the
   *  two changes moved the number, and the sample is small enough that it would not
   *  separate later either.
   *
   *  Two days, not two weeks: the first three hours of the block produced 2 distinct
   *  events against σ1.0's ~2.6 a day, so the block reads on its own by then.
   *
   *  **The lock is enforced in `parseSettings`, not in the markup.** A disabled control
   *  is a hint to a person, and this repository has already had a hand-written body
   *  turn `mode: "turbo"` into a live account. An operator's `accounts/<address>.json`
   *  is deliberately *not* gated — that path needs someone on the box, which is the
   *  same line every other override in this codebase draws. */
  holdToTargetOpensAt: "2026-09-09",
} as const;

/** True once the exit-policy choice is open to the web. Date-only in UTC, so it turns
 *  over at midnight rather than at the hour this was written. */
export function holdToTargetOpen(now = new Date()): boolean {
  return now.toISOString().slice(0, 10) >= SITE_OFFERS.holdToTargetOpensAt;
}

const pct = (f: number) => `${Math.round(f * 100)}%`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
/** The funding floor carries cents since the reserve came off the base, and rounding
 *  them away would quote a floor below the real one. */
const usdCents = (n: number) =>
  `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One group per named agent, **each restating the disallows**. A robot obeys exactly
 *  one group — the most specific one naming it — and ignores `*` entirely, so a named
 *  group holding only `Allow: /` would silently exempt that bot from `/api/`.
 *
 *  **`/api/` is the only disallow, and it is cost rather than secrecy:** the routes
 *  authenticate themselves. Nothing else is disallowed — the desk is behind a session
 *  and renders as the home view to a stranger, and a page that must not be listed gets
 *  `noindex` and stays crawlable rather than a `Disallow` that makes the tag unreadable
 *  forever.
 *
 *  **`/share/` was disallowed here until 2026-09-06 and that is the whole of why cards
 *  had to be allowlisted per crawler.** The chain is: a `Disallow` on the image path is
 *  a `Disallow` on the feature, because `og:image` points into `/share/` and a scraper
 *  that may not fetch it renders a title and a blank rectangle. `tasks/16` shipped that
 *  on 2026-09-05, then carved out eight named card crawlers — which is an allowlist of
 *  every link-preview fetcher on earth, a list nobody can hold: iMessage, Signal,
 *  Bluesky, Mastodon, Threads, Notion and whatever X renames its bot to next are each a
 *  blank tile in somebody else's feed that nothing here renders.
 *
 *  **The cost it was written for does not exist in the code as built.** `shareCard()`
 *  keys the render cache on the *parsed* parameters and hands every unverifiable URL the
 *  same `home` model, so a crawler walking a space of signatures gets one cache entry
 *  and zero further rasterisations; and a signed URL cannot be walked to — it is
 *  unguessable and appears only in the `og:image` of a page somebody chose to paste. So
 *  the disallow bought nothing and cost the feature. `notes/2026-09-06-card-image-on-x.md`. */
export const NAMED_AGENTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "PerplexityBot",
  "Google-Extended", "CCBot",
] as const;

export const DISALLOWED = ["/api/"] as const;

export function robotsTxt(origin: string): string {
  const group = (agent: string, disallow: readonly string[]) =>
    [`User-agent: ${agent}`, "Allow: /", ...disallow.map((p) => `Disallow: ${p}`)].join("\n");
  return [
    group("*", DISALLOWED),
    ...NAMED_AGENTS.map((a) => group(a, DISALLOWED)),
    `Sitemap: ${new URL("/sitemap.xml", origin).href}`,
  ].join("\n\n") + "\n";
}

/** The root, and only the root. The connect and desk views are client-side views of
 *  the same document, and the desk needs a session. No `lastmod` (there is no
 *  per-page date to claim), no `priority`, no `changefreq`. */
export function sitemapXml(origin: string): string {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    `  <url><loc>${new URL("/", origin).href}</loc></url>\n` +
    "</urlset>\n";
}

/** Markdown, served as `text/plain` so it opens in a tab at a guessable path.
 *
 *  Order: what Mandate is in one sentence; the three settings and their ranges; the
 *  bounds we impose and the halt; the floor; what it is not; the canonical origin.
 *  Every figure is read from the parameters at request time. */
export function llmsTxt(origin: string): string {
  const d = DEFAULT_USER_SETTINGS;
  const r = RISK_PARAMS;
  const floorDefault = minFundedForLiveUsd(d);
  const floorWeakest = minFundedForLiveUsd({
    perSignalPct: SITE_OFFERS.perSignalPct.min, leverage: Math.min(...SITE_OFFERS.leverage) as 5 | 10 | 20,
  });
  const canonical = new URL("/", origin).href;

  return `# Mandate

> Mandate turns Quotient's published market outlooks into positions on your own Hyperliquid account. It is non-custodial: the key you approve can place orders and cannot withdraw.

Canonical: ${canonical}

## What it is

- Quotient (quotient.social) researches and publishes price outlooks on perpetual futures — crypto, equities and commodities. Mandate publishes no forecasts of its own.
- Mandate executes those outlooks on the reader's own Hyperliquid account: it maps the outlook to a market, checks the limits, sizes the position, places the entry, rests the stop and the target on the exchange as reduce-only trigger orders, and closes the position at the outlook's own deadline.
- The account stays its owner's. Sign-in is a wallet signature. The agent key that places orders is generated and sealed on Mandate's server, never travels, and cannot move funds out. Revoking it on Hyperliquid stops Mandate that second; resting stops stay on the exchange and keep working without it.

## The settings you choose

- Leverage: ${SITE_OFFERS.leverage.map((l) => `${l}×`).join(", ")}. Default ${d.leverage}×.
- Stop distance from entry: ${pct(SITE_OFFERS.stopPct.min)} to ${pct(SITE_OFFERS.stopPct.max)}. Default ${pct(d.stopPct)}. Clamped per market so the stop fires at most ${pct(r.liqBufferFrac)} of the way to liquidation. The stop can be switched off.
- Size per position: ${pct(SITE_OFFERS.perSignalPct.min)} to ${pct(SITE_OFFERS.perSignalPct.max)} of the mandate, posted as margin. Default ${pct(d.perSignalPct)}.
- Exit behaviour, marked experimental in the interface and today offering one option. **Signal change** (in force): when Quotient's status moves from a direction to neutral, the position is closed at market on the next poll. **Target hit** (opens ${SITE_OFFERS.holdToTargetOpensAt}): the position is held until its target or its stop-loss is hit, and a move from a direction to neutral does nothing. Until that date the second is refused, because Mandate is measuring the first and changing two things at once would make neither readable.

## The bounds Mandate imposes

- Isolated margin on every position, so one position cannot reach the rest of the account.
- Every stop and target rests on Hyperliquid itself, never only inside Mandate's process.
- At most ${pct(r.maxDeployedPct)} of the mandate is deployed as margin at once, less a ${pct(r.reserveFrac)} reserve that is never posted.
- How many positions are open at once follows the size you choose: ${pct(SITE_OFFERS.perSignalPct.min)} per position allows ${maxConcurrentSignals({ perSignalPct: SITE_OFFERS.perSignalPct.min })}, ${pct(d.perSignalPct)} allows ${maxConcurrentSignals({ perSignalPct: d.perSignalPct })}, ${pct(SITE_OFFERS.perSignalPct.max)} allows ${maxConcurrentSignals({ perSignalPct: SITE_OFFERS.perSignalPct.max })}. The two bounds bind at the same point, so a larger size always means more capital at work and never less.
- That allowance is a ceiling, not a forecast: the signal feed has so far never offered more than five tradeable outlooks at once.
- A day that loses ${pct(r.dailyLossPct)} of its opening equity pauses the account: nothing new opens and every resting exit stays. Only an operator clears the pause.
- An outlook whose deadline is more than ${r.maxHoldHours} hours away is not entered at all. That is a filter on what Mandate enters, not a timer on what it holds: every position is closed at its own outlook's deadline, whatever the result, and those deadlines are nearer.
- An outlook whose market Mandate cannot map exactly is refused. A market with under ${usd(r.capacity.minVolume24hUsd)} of daily volume, or a book too thin to exit through, is refused.

## The mandate

- The mandate is what the account holds when it connects, in full. There is no ceiling: the deposit is the size.
- The floor is the smallest deposit that can produce a legal ${usd(r.minOrderNotionalUsd)} order at the chosen settings: ${usdCents(floorDefault)} at the defaults, ${usdCents(floorWeakest)} at the weakest settings the site offers. Below it every signal is skipped.
- Mandate manages at most ${LIVE_MANDATE.maxLiveAccounts} accounts at once, its own included, and it is at that number. So access is by queue: a wallet signature takes a place, and the front of the queue is let in when an account leaves. Nothing is asked of the account — no deposit, no approval, no key — until then.

## What it is not

- Not custody. Mandate never holds funds and cannot withdraw them.
- Not a forecaster. Every outlook is Quotient's; Mandate is execution and risk control.
- Not a prediction-market product yet. Perpetual futures on Hyperliquid only.

Every statement here is in the present tense and describes what the code does today. Nothing here says what an account has made or will make.
`;
}
