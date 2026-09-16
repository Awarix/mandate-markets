// Types for the Quotient API.
//
// Written from a REAL captured payload (data/probe/perps-live.json, 2026-08-30),
// not from the published reference — which omits `side`, `strength`, the percentile
// band, the sigma fields, and the Hyperliquid `resolution_reference` entirely.
// See notes/2026-08-30-perps-payload-findings.md.
//
// The recorder does not depend on these: it stores raw bodies, so a drift here
// cannot lose data.

/** Where Quotient anchors this outlook for settlement — and, usefully, the exact
 *  Hyperliquid instrument it references. */
export type ResolutionReference = {
  provider: "hyperliquid" | "kalshi-settlement" | string;
  /** HL market symbol, e.g. "BTC", "xyz:NVDA". Validate against HL `meta` before use. */
  symbol: string | null;
  instrument_id: string | null;
  /** Last observed price on that instrument. */
  value: number | null;
  value_kind: string | null;
  observed_at: string | null;
  freshness: string | null;
  /** Only "verified" is safe to trade. "unresolved" appears on ~40% of basis groups. */
  mapping_status: "verified" | "unresolved" | string;
  collection_transport: string | null;
};

export type OutlookState = "long" | "short" | "neutral" | "unavailable";

export type Outlook = {
  outlook_id: string;
  anchor_date: string;
  anchor_at: string;
  /** Time to the anchor, in days. Ranges ~0.02 (30 min) to ~5.5. */
  horizon_days: number;
  status: "active" | "unavailable" | string;
  state: OutlookState;
  /** Direction, when there is one. Null on the ~80% of series that are neutral. */
  side: "long" | "short" | null;
  strength: "low" | "medium" | "high" | null;
  revision: number;
  revisions: number;

  /** Target price — the take-profit. */
  median_price: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;

  spot_at_obs: number;
  ref_median: number;
  reference_basis: string;
  spot_gap_pct: number;
  spot_gap_sigma: number;

  /** Fractional vol over the horizon — the native input for a σ-based stop.
   *
   *  ⚠ **`sigma_diffusive` is the denominator of `displacement_sigma`, and `sigma_total`
   *  is not always the same number.** They are equal on 4,026 of the archive's 4,121
   *  directional series-polls and differ on the other 95, where `sigma_total` is the
   *  larger. `liveDisplacementSigma` divides by `sigma_total`, so on those the live
   *  re-gate reads a smaller sigma count than the vendor's — conservative, and measured
   *  to have reached the shipped gate 12 times in 1,215 passes, all of them
   *  `company:orcl:price-outlook:next-day`, refusing each one anyway
   *  (`src/mapping/quotient.test.ts`, `fixtures/README.md`). */
  sigma_diffusive: number;
  sigma_total: number;
  implied_mean: number;
  implied_sigma: number;
  /** Target's distance from reference in sigmas: `ln(median_price / ref_median) /
   *  sigma_diffusive`, exactly, on every directional series-poll in the archive. Better
   *  entry gate than `edge_pct`, which cannot tell a 1.5% move over 30 minutes from the
   *  same 1.5% over a week. */
  displacement_sigma: number;
  /** (median_price − ref_median) / ref_median. */
  edge_pct: number;

  tilt: unknown;
  freshness_state: string;
  freshness_reason: string | null;
  observed_at: string;
  published_at: string;

  // ── Published since the 2026-08-30 capture, gathered and NOT read ───────────────
  //
  // **The decision, 2026-09-12 (owner): keep reading `side`, record these, revisit at
  // a retest.** The gate's notion of "is there a direction here" is `outlook.side`
  // and stays that way. Nothing below reaches `evaluateSeries`, and nothing below may
  // reach it until Quotient says what these mean — trading a field whose meaning we
  // guessed is the OutcomeMaker failure, and it cost $192.
  //
  // They are typed rather than left to `unknown` so the analysis layer can reach them
  // without a cast. The recorder already stored them from the day they appeared:
  // `Journal.write` archives the whole body verbatim, so there is no gap to backfill —
  // what was missing was a declaration that they exist.
  //
  // Today's baseline, for the retest to compare against:
  // `notes/2026-09-12-the-fields-we-gather-and-do-not-read.md`, `PREREGISTERED.md` row 9.

  /** Quotient's own directional read, on **every** series including the neutral ones.
   *
   *  ⚠ This is the one that carries information we do not have. On 2026-09-12's last
   *  poll, `side` was non-null on **2 of 55** series while `directional_take.side` was
   *  non-neutral on **31** — 29 of them invisible to the gate, 11 at `moderate` or
   *  `strong`. Its `score_sigma` is a *second* sigma that disagrees with
   *  `displacement_sigma` in magnitude and sometimes in sign, including on series where
   *  ours is exactly 0.000. And `is_price_signal` was **false on all 3,682 series-polls
   *  across 09-11 and 09-12** — including the two the executor traded — so the field
   *  does not mean what its name suggests, or means something we would want to know. */
  directional_take?: DirectionalTake | null;
  /** The side this outlook would carry if it had one, with `lean_sigma` beside it.
   *
   *  **Measured to be a restatement, not new information:** `lean_sigma` equals
   *  `displacement_sigma` to 1e-12 on all 315 series-polls where it is set (09-11 and
   *  09-12). So it re-signs a number we already read — but on series whose `side` is
   *  null, which is how `commodity:platinum:price-outlook:monthly` sat at 0.61 sigma,
   *  past our 0.5 gate, and was never seen. */
  lean_side?: "long" | "short" | null;
  lean_sigma?: number | null;
  /** The quantile curve as five named points. Nothing reads it; `p10`…`p90` above are
   *  the same distribution and are what `median_price` and the target come from. */
  scenarios?: OutlookScenarios | null;
  /** Provenance of the forecast — how many rungs were market-backed, how stale the
   *  oldest source was. Never read; a candidate input for a freshness gate. */
  audit?: Record<string, unknown> | null;
};

/** `outlook.directional_take` — see the warning on the field. Typed from the
 *  2026-09-12T08:16Z capture; `version` was `directional-take/2` throughout. */
export type DirectionalTake = {
  side: "bullish" | "bearish" | "neutral" | string;
  /** ⚠ A different vocabulary from `Outlook.strength` (`low`/`medium`/`high`), which
   *  is what `RISK_PARAMS.allowedStrengths` reads. On the two series the gate could
   *  see on 09-12, `Outlook.strength` said `low` and this said `strong`. */
  strength: "neutral" | "lean" | "moderate" | "strong" | string;
  label: string;
  /** ⚠ Not `displacement_sigma`. See the warning on the field. */
  score_sigma: number;
  payoff_balance: number;
  probability_above_spot: number;
  expected_price: number;
  expected_return_pct: number;
  expected_log_return: number;
  expected_upside_log: number;
  expected_downside_log: number;
  range_status: string;
  truncated_percentiles: number[];
  method: string;
  version: string;
  /** ⚠ Never once `true` in the archive. Meaning unknown; ask before reading it. */
  is_price_signal: boolean;
};

export type ScenarioPoint = { percentile: number; price: number; return_pct: number };

export type OutlookScenarios = {
  downside_tail: ScenarioPoint;
  bear_case: ScenarioPoint;
  base_case: ScenarioPoint;
  bull_case: ScenarioPoint;
  upside_tail: ScenarioPoint;
};

export type BasisGroup = {
  source: string;
  basis_id: string;
  resolution_reference: ResolutionReference | null;
  reference_quote: unknown;
};

export type PerpsSeries = {
  series_id: string;
  /** e.g. "crypto:btc", "company:nvda", "commodity:gold". */
  asset_key: string;
  asset_class: "crypto" | "equity" | "commodity" | string;
  /** `two-day` left the feed after 2026-09-04 and `extra-<date>` appeared (one series
   *  on the 09-12 capture, `extra-2026-11-03`). Both spellings stay in the union as
   *  documentation — the archive still holds `two-day` rows — and the trailing
   *  `| string` is what makes an unannounced anchor compile rather than crash. */
  anchor_type: "daily" | "next-day" | "two-day" | "weekly" | "monthly" | `extra-${string}` | string;
  display_name: string;
  /** Forecast source venue (kalshi / polymarket / null) — NOT where we trade. */
  venue: string | null;
  contributing_venues: string[];
  venue_series: string | null;
  observable: string;
  /** signal | projection | coverage. Distinction is undocumented — ask Quotient.
   *  "coverage" is universe-filling and always neutral. */
  mode: "signal" | "projection" | "coverage" | string;
  mode_reason: string | null;
  headline: string;
  /** All series are "experimental" as of 2026-08-30. */
  maturity: string;
  outlook: Outlook;
  spot_at_obs: number;
  basis_groups: BasisGroup[];
  /** Empty on every series as of 2026-08-30. */
  price_signals: unknown[];
  /** Added since the 08-30 capture. One of the four copper horizons on 09-12 was
   *  `true`; gathered, not read, under the same decision as the outlook fields above. */
  is_primary_horizon?: boolean;
};

export type PerpsResponse = {
  as_of: string;
  contract: string;
  filters: Record<string, string | null>;
  series_count: number;
  series: PerpsSeries[];
};

// ── GET /signals — the prediction-market feed (Phase 5) ─────────────────────
//
// **Rewritten 2026-09-02 from four days of real captures** (225 signals across
// `data/quotient/signals/*.jsonl.gz`), replacing a shape written from the published
// docs that got most of the top level wrong. `notes/2026-09-02-pm-signals-payload.md`
// has the census and what it contradicted; the short version is that the docs' 13
// fields are 43, `status` does not exist, `capacity_usd_at_2c` has never once been
// populated, and **the feed is not Polymarket-only** — 77% Polymarket, 23% Kalshi.
//
// Nothing consumes these yet. The recorder stores raw bodies, so a drift here cannot
// lose data, and `tasks/06` is the plan they are for.

/** Where the signal's market lives. **Both appear in the same response**, and roughly
 *  one in four is Kalshi — which `tasks/06` has to decide about rather than discover:
 *  a Polymarket-only pipeline silently drops 23% of the feed. */
export type PmVenue = "polymarket" | "kalshi" | string;

/** The last venue price Quotient saw.
 *
 *  **`yes_bid`, `yes_ask`, `yes_last` and `venue_timestamp` are null on every
 *  Polymarket row and populated on every Kalshi row** — a clean 47/14 split in the
 *  2026-09-02 capture and the same shape on the three days before it. So on the venue
 *  we intend to trade, this carries no spread: `selected_probability` is all there is,
 *  and any depth or spread reasoning has to come from Polymarket's own CLOB. */
export type PmVenueQuote = {
  schema_version: string;
  venue: PmVenue;
  /** The venue's own id — Kalshi's ticker, Polymarket's numeric market id. */
  market_id: string;
  yes_bid: number | null;
  yes_ask: number | null;
  yes_last: number | null;
  /** 0–1. The only price present on a Polymarket row. */
  selected_probability: number | null;
  quote_method: string;
  venue_timestamp: string | null;
  observed_at: string;
  freshness: string;
};

/** The market, and the **only** place an executable identifier appears.
 *
 *  `resolution_reference` and `execution_reference` — the fields that name the
 *  tradeable instrument on `/signals/perps` — are **null on all 225 captured
 *  signals**. So unlike the perps feed, this one hands us no venue mapping and
 *  `condition_id` is what a Polymarket order would be built from.
 *
 *  Note the casing: `nativeMarketId` and `marketKey` are camelCase while
 *  `condition_id`, `end_date`, `market_odds` and `volume_24h` are snake_case, **in the
 *  same object**. Reading one in the other's style returns `undefined` silently. */
export type PmMarket = {
  venue: PmVenue;
  /** Polymarket: a numeric string ("3275539"), which is **not** the condition id and
   *  not a token id. Kalshi: the market ticker. */
  nativeMarketId: string;
  nativeEventId: string | null;
  seriesTicker: string | null;
  marketKey: string;
  quotientMarketId: string;
  /** Polymarket only; null on every Kalshi row. */
  slug: string | null;
  marketUrl: string | null;
  sourceUrl: string | null;
  question: string;
  /** **The CLOB's market identifier, and the field Polymarket execution needs.**
   *  Non-null on all 47 Polymarket rows, null on all 14 Kalshi ones. */
  condition_id: string | null;
  /** ISO-8601, and **not in one format**: some rows end `+00:00` and some end `Z`.
   *  Both parse; a string comparison between them does not. */
  end_date: string;
  /** The venue's implied probability, 0–1. */
  market_odds: number | null;
  /** **Polymarket only, and it arrives free.** Non-null on all 47 Polymarket rows,
   *  null on all 14 Kalshi ones. Worth knowing before building a volume floor:
   *  measured on 2026-09-02, the 47 rows ran $9.03 to $1,111,121 with a median of
   *  $11,588, and **23 of 47 were under $10,000** — Cassie's own floor, which would
   *  refuse half this feed. */
  volume_24h: number | null;
  quotientUrl: string | null;
  polymarketUrl: string | null;

  /** ⚠ **Vendor drift, arriving 2026-09-02 between 21:52:39Z and 23:52:46Z** — after
   *  `fixtures/signals-2026-09-02.json` was captured, which is why `pm-types.test.ts`
   *  cannot see them: it asserts a frozen capture, so a field added an hour later is
   *  invisible to it for ever. Found by `npm run pm-census` walking the live archive
   *  (`notes/2026-09-14-hold-to-resolution-and-the-book-that-never-empties.md` §3.1).
   *
   *  Optional because the archive holds rows from both sides of that instant. Quotient
   *  distributing Polymarket markets through brokers is interesting and **nothing reads
   *  them**: a new vendor field is typed and baselined before it reaches a gate. */
  broker_channels?: unknown[];
  robinhood_category?: string | null;
  robinhood_url?: string | null;
  /** Graph edges to assets, markets and sibling signals. Not modelled: nothing needs
   *  them yet and they are large. */
  relationships?: unknown;
};

/** How the forecast has moved since it was published. */
export type PmForecastStatus = {
  /** Six values seen: converging, diverging, converged, sideways, caution, warning. */
  state: string;
  /** Distance still to travel, in cents. */
  cents: number;
  adverse_move_pct: number;
  basis: string;
  price_source: string;
};

/** One prediction-market signal, as `/signals` actually returns it.
 *
 *  43 fields, stable across four days of captures. **There is no `status`** — the
 *  docs-derived type had one, and liveness is spread across `is_active`, `is_fresh`,
 *  `is_new_today`, `retired_reason`, `suppression_reason` and `forecast_status.state`
 *  instead. */
export type PmSignal = {
  id: string;
  created_at: string;
  published_at: string;
  forecast_updated_at: string;
  is_new_today: boolean;
  is_fresh: boolean;
  is_active: boolean;

  /** The side Quotient recommends **buying**. */
  side: "YES" | "NO";
  /** The side its own forecast is stated for, which is **not always `side`**: they
   *  disagree on 11 of the 61 signals in the 2026-09-02 capture. Two fields, and a
   *  mapper that reads one for the other buys the wrong side of a binary market on
   *  roughly one signal in six. */
  q_side: "YES" | "NO";

  /** Quotient's probability and the market's, in whole percent, at **this revision's**
   *  publication — and **not** frozen at the call, nor what we could buy at now.
   *
   *  ⚠⚠ **The payload carries two frames and mixing them is the `side`/`q_side` trap in a
   *  new costume.** Verified over 127 first-sight keys, 2026-09-14:
   *
   *      per-revision:  entry_q · entry_pm · entry_spread_pp · entry_cost_cents
   *      per-poll:      latest_q · market.market_odds · q_value_cents ·
   *                     current_cost_cents · max_roi_pct · converge_upside_pct ·
   *                     distance_to_convergence_cents · venue_quote.selected_probability
   *
   *  ⚠⚠ **"Entry" is re-baselined every time the revision id rotates.** Over the 126 keys
   *  seen in more than one poll, `entry_pm` moves within the key on **66** and `entry_q` on
   *  **70**, p90 range 18c and max 30c (`thesis` moves on 108). So **nothing here records
   *  what a position would have cost when the thesis first appeared** — only our own
   *  archive does, which is why a historical export from the vendor can supply the outcome
   *  and the path but never the first-sight entry.
   *
   *  `q_value_cents` is the **live** probability, and it differs from the entry figure on
   *  30 of 127 keys — by a median of 0c, a p90 of **7c** and a maximum of 36c — so an EV
   *  computed across the two frames is wrong by up to 36 cents on a dollar contract and
   *  errors in neither direction reliably.
   *
   *  **An entry decision belongs in the LIVE frame**, because that is the price the order
   *  would pay. The ENTRY pair is history: what the call was when Quotient made it.
   *
   *  ⚠⚠ **And there is a THIRD axis, which this comment got wrong until 2026-09-15**
   *  (`notes/2026-09-15-what-the-resolved-markets-say.md` §1). It said `q_value_cents`
   *  matches `round(latest_q × 100)` on **127 of 127**; it matches on **79** — every YES
   *  call — and is **100 minus** it on the 48 NO calls. The two frames are not entry and
   *  live but *side-relative* and *YES*:
   *
   *      side-relative:  q_value_cents · entry_cost_cents · current_cost_cents
   *      YES-frame:      entry_q · entry_pm · latest_q · market.market_odds ·
   *                      venue_quote.selected_probability
   *
   *  So `current_cost_cents` already is what a buy of `side` pays, while `entry_pm` is the
   *  YES price whichever side is recommended — and mixing *those* two does not stale a
   *  number, it inverts it on the 48 NO rows. `q_side` flips nothing: on all 8 rows where
   *  it disagrees with `side`, `latest_q` is still YES and `q_value_cents` still
   *  side-relative. Frozen in `pm-types.test.ts`. */
  entry_q: number;
  entry_pm: number;
  entry_spread_pp: number;
  /** How long the thesis is meant to run, in days. 3 to 60, median 21 — an order of
   *  magnitude longer than the perps feed's 1–2 days. */
  window_days: number;
  /** **False on 46 of 61**: most markets do not resolve inside the signal's own
   *  window, so an exit cannot assume settlement. */
  resolves_in_window: boolean;

  forecast_status: PmForecastStatus;
  retired_reason: string | null;
  /** 1 or 2 in every capture. The docs said 1 | 2 | 3; a third tier has not appeared. */
  conviction_tier: number;
  /** The same thing as a word: "low" with tier 1, "medium" with tier 2. */
  conviction: string;
  has_band: boolean;
  /** Quotient's current probability, 0–1 — full precision, unlike `entry_q`. */
  latest_q: number;
  /** One sentence of reasoning, for the screen. */
  thesis: string;

  /** All in whole cents of a $1 contract. Measured 2026-09-02:
   *  entry 36–86 (median 72), current 26–97 (median 76), q_value 50–97 (median 82). */
  q_value_cents: number;
  entry_cost_cents: number;
  current_cost_cents: number;
  distance_to_convergence_cents: number;
  converge_upside_pct: number;
  max_roi_pct: number;

  live_priced: boolean;
  priced_at: string;

  /** **Null on all 225 signals captured over four days.** The docs-derived type
   *  declared this a `number` and `tasks/06` planned to size against it. It has never
   *  been populated, so capacity has to come from `market.volume_24h` or from
   *  Polymarket's own book. */
  capacity_usd_at_2c: number | null;
  capacity_available: boolean | null;
  capacity_basis: string | null;
  capacity_as_of: string | null;

  drawdown_risk_elevated: boolean;
  crash_risk_elevated: boolean;

  venue_quote: PmVenueQuote;
  /** Null on every captured signal — see `PmMarket`. */
  resolution_reference: unknown | null;
  /** Null on every captured signal — see `PmMarket`. */
  execution_reference: unknown | null;
  basis_status: string;
  grounding_status: string;
  suppression_reason: string | null;
  relationships?: unknown;
  market: PmMarket;
};

/** The whole response. One key, unlike `/signals/perps`, which carries `as_of`,
 *  `contract`, `filters` and `series_count` alongside its array. */
export type PmResponse = { signals: PmSignal[] };
