// The Quotient captures the tests run against, and the builders that construct a
// series rather than find one.
//
// **Test-only, and deliberately not a test file.** Nothing in `src/` imports it; four
// test files do (`mapping/quotient.test.ts`, `mapping/intent.test.ts`,
// `exec/loop.test.ts`, `web/cards.test.ts`), which is why it is one module rather than
// four copies of the same `readFileSync`.
//
// **Why there are two captures** (`tasks/46` §3.1). Until 2026-09-13 the 2026-08-30
// payload was the only one a test ever saw, and sixteen assertions described *it*
// rather than the code: the series count, "12 directional", `coverage.length > 20`,
// "8 stale directional", `unresolved ⟺ anchor passed`, "2 of 76 pass the shipped gate".
// Every one of those is false on a poll taken twelve days later — `coverage` and
// `two-day` left the feed, `unresolved` left with them, no anchor in a modern poll has
// already passed — so the suite could only ever fail for the wrong reason, and a test
// that fails when the *feed* moves tells you nothing about the mapper.
//
// The rule this file exists to enforce: **an assertion is either an invariant that
// holds on both captures, or it is written against a series the test builds itself.**
// What each capture happened to contain is documentation and lives in
// `fixtures/README.md`, not in an `assert`.

import { readFileSync } from "node:fs";
import type { PerpsResponse, PerpsSeries } from "./types.ts";

export type Capture = {
  /** What to print when a loop over the captures fails on one of them. */
  name: string;
  payload: PerpsResponse;
  /** The instant the poll was taken — the only sane `now` for a gate that reads clocks. */
  at: Date;
};

function load(path: string): Capture {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // Named rather than left as a bare ENOENT, because the two ways this fails are
    // "you are running the suite from the wrong directory" and "somebody deleted a
    // committed capture", and the second one needs `fixtures/README.md` read first.
    throw new Error(
      `${path} is missing. It is a committed Quotient capture and the test suite is ` +
      `written against it — see fixtures/README.md for what it holds and why there are two. (${e})`,
    );
  }
  const payload: PerpsResponse = JSON.parse(raw);
  return { name: path, payload, at: new Date(payload.as_of) };
}

/** 2026-08-30T09:40Z, 76 series. The feed as it was when the mapper was written. */
export const CAPTURE_0830 = load("fixtures/perps-2026-08-30.json");

/** 2026-09-10T16:39Z, 60 series, a weekday afternoon. The feed as it is now. */
export const CAPTURE_0910 = load("fixtures/perps-2026-09-10.json");

/** Both, for the invariants. A test that loops over this and names neither capture is
 *  the shape `tasks/46` §3.1 asks for. */
export const CAPTURES: readonly Capture[] = [CAPTURE_0830, CAPTURE_0910];

/** The Hyperliquid symbol a series names, or null — the same lookup the mapper does,
 *  repeated here because the mapper's own copy is private and this one is only ever
 *  used to *describe* a capture. */
export function hlSymbol(s: PerpsSeries): string | null {
  for (const bg of s.basis_groups) {
    if (bg.resolution_reference?.provider === "hyperliquid") return bg.resolution_reference.symbol;
  }
  return null;
}

/** A directional series the test wrote, built on a real capture's shape.
 *
 *  **The point is that the property under test is in the test.** `PASSING` used to be
 *  `crypto:btc:price-outlook:next-day` found in the 08-30 capture, which was a −2.57σ
 *  short there and is neutral at +0.00σ today; every lifecycle test in `loop.test.ts`
 *  opened its position on that one series' one revision, so the harness depended on
 *  which series happened to be directional at 09:40Z on a Saturday.
 *
 *  The displacement is **constructed from the prices**, never stated beside them:
 *  `displacement_sigma = ln(median_price / ref_median) / sigma_diffusive` is an identity
 *  the vendor honours on every directional series-poll in the archive, and the live
 *  re-gate recomputes it against the mark. A series whose fields contradict each other
 *  would pass a gate here and be refused by `loop.ts` for a reason no test could read.
 *
 *  @param sigmas signed: negative is a short, positive a long. */
export function directionalSeries(opts: {
  base?: PerpsSeries;
  coin?: string;
  seriesId?: string;
  outlookId?: string;
  sigmas: number;
  /** Fractional vol over the horizon. The default is BTC's on the 08-30 capture,
   *  rounded — 0.0309 against 0.030862905658061077. */
  sigmaTotal?: number;
  spot?: number;
  /** Anchor this far ahead of `now`. The default sits inside `maxHoldHours`. */
  now: Date;
  hoursAhead?: number;
}): PerpsSeries {
  const base = opts.base ?? CAPTURE_0830.payload.series.find((s) => s.series_id === "crypto:btc:price-outlook:next-day")!;
  const s: PerpsSeries = structuredClone(base);
  const coin = opts.coin ?? "BTC";
  const sigmaTotal = opts.sigmaTotal ?? 0.0309;
  const spot = opts.spot ?? 78_083.5;
  const median = spot * Math.exp(opts.sigmas * sigmaTotal);

  s.series_id = opts.seriesId ?? `test:${coin.toLowerCase()}:price-outlook:next-day`;
  s.asset_key = `test:${coin.toLowerCase()}`;
  s.mode = "signal";
  // The vendor's own eight-component shape, `…:<anchor>:<anchor-date>:<epoch>:<revision>`.
  // `stableOutlookId` keys on the first six, so a shorter id would exercise a shape the
  // feed does not produce (`tasks/41`).
  s.outlook.outlook_id = opts.outlookId
    ?? `po:test:${coin.toLowerCase()}:price-outlook:next-day:2026-08-31:07a8a1be7f379196:0fad777dc6bc7895`;
  s.outlook.side = opts.sigmas < 0 ? "short" : "long";
  s.outlook.state = s.outlook.side;
  s.outlook.status = "active";
  s.outlook.strength = "medium";
  s.outlook.anchor_at = new Date(opts.now.getTime() + (opts.hoursAhead ?? 24) * 3_600_000).toISOString();
  // Observed *now*, like the anchor. Inherited from the capture these were the 08-30
  // originals, which is not a shape the feed produces: a live snapshot's `observed_at`
  // is one poll old, never seventeen days. It matters because `considerSignals` compares
  // it against our own closes, so a fixture stuck in August reads as permanently stale
  // (`notes/2026-09-16-the-snapshot-that-predates-the-fill.md`).
  s.outlook.observed_at = opts.now.toISOString();
  s.outlook.published_at = opts.now.toISOString();
  s.outlook.spot_at_obs = spot;
  s.outlook.ref_median = spot;
  s.spot_at_obs = spot;
  s.outlook.median_price = median;
  s.outlook.sigma_total = sigmaTotal;
  s.outlook.sigma_diffusive = sigmaTotal;
  s.outlook.displacement_sigma = opts.sigmas;
  s.outlook.spot_gap_sigma = opts.sigmas;
  s.outlook.edge_pct = median / spot - 1;
  s.outlook.spot_gap_pct = median / spot - 1;

  for (const bg of s.basis_groups) {
    const rr = bg.resolution_reference;
    if (rr) { rr.symbol = coin; rr.instrument_id = coin; rr.mapping_status = "verified"; }
  }
  return s;
}
