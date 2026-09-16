import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { configHash, configValues } from "../ops/config-event.ts";
import { type PriceCapture, priceAt, settledAt } from "./pm-prices.ts";

// The price-path capture, and the one thing every Polymarket file has to prove.
//
// `tasks/52` §7's done-list asks for both: that the capture holds what it claims, and that
// nothing in this half of the repository can move the Hyperliquid desk's fingerprint.

const CAP = JSON.parse(readFileSync("fixtures/pm-prices-2026-09-15.json", "utf8")) as PriceCapture;
const PATHS = Object.values(CAP.paths);

test("no Polymarket analysis moves the Hyperliquid config fingerprint", () => {
  // ⚠⚠ The whole isolation rule in one assertion (`tasks/06` §11.1.3,
  // `notes/2026-09-14-polymarket-the-profile-the-rates-and-the-rollout.md` §7). A Polymarket
  // constant reaching any of the five fingerprinted objects would change this hash at the
  // next Hyperliquid boot, write a `config` event, arm the global halt, and cost
  // `docs/STATUS.md` item 1 the reading it has been accumulating a block for since 09-13.
  // Importing `pm-prices.ts` above is the part that makes this test worth having: it proves
  // the import graph of the Polymarket scripts does not reach a money constant either.
  assert.equal(configHash(configValues()), "f85b3fc0e794");
});

test("the capture says what it was captured with", () => {
  // The two measured limits, frozen. `npm run pm-prices -- --probe` re-measures them
  // live; this asserts the fixture was taken under them.
  assert.equal(CAP.window_seconds, 1_296_000, "the measured 15-day window cap");
  assert.equal(CAP.fidelity_minutes, 10);
  assert.ok(CAP.source.includes("prices-history"));
  assert.ok(PATHS.length >= 70, `${PATHS.length} token paths`);
});

test("every path is ordered in time and carries no repeated price", () => {
  // Both are invariants of how it is written, not of what Polymarket sent: the capture
  // drops consecutive equal prices because the series is a step function, and `priceAt`
  // binary-searches, which silently returns the wrong point on an unsorted array.
  for (const [token, path] of Object.entries(CAP.paths)) {
    for (let i = 1; i < path.length; i++) {
      const prev = path[i - 1];
      const cur = path[i];
      if (!prev || !cur) continue;
      assert.ok(cur[0] > prev[0], `${token.slice(0, 12)}… point ${i} goes backwards in time`);
      assert.notEqual(cur[1], prev[1], `${token.slice(0, 12)}… point ${i} repeats a price`);
    }
  }
});

test("no path carries a point from the future, which is the appended-current-price trap", () => {
  // ⚠⚠ The endpoint appends the **current** price as one extra final point, outside the
  // window asked for — a 2026-06-01 → 06-11 request came back ending at today's price, 64
  // cents away from where the window left off. The capture drops points past its own
  // `endTs`; this checks none survived, using the capture time as the bound.
  const capturedAt = Math.floor(Date.parse(CAP.captured_at) / 1000);
  for (const [token, path] of Object.entries(CAP.paths)) {
    const last = path[path.length - 1];
    if (!last) continue;
    assert.ok(last[0] <= capturedAt + 60, `${token.slice(0, 12)}… ends after the capture`);
  }
});

test("priceAt is a step function and refuses to guess before the series starts", () => {
  const path: [number, number][] = [[100, 0.4], [200, 0.55], [300, 0.9]];
  assert.equal(priceAt(path, 99), null, "before the first point is a refusal, not an extrapolation");
  assert.equal(priceAt(path, 100), 0.4);
  assert.equal(priceAt(path, 199), 0.4, "the price holds until the next point");
  assert.equal(priceAt(path, 200), 0.55);
  assert.equal(priceAt(path, 10_000), 0.9, "after the last point it holds, which is what settlement does");
  assert.equal(priceAt([], 1), null);
});

test("settledAt finds where the winner reached $1 and stayed, not merely touched it", () => {
  // A market that spikes to 0.99 mid-life and comes back has not settled there. Taking the
  // first touch would date a settlement days early and shorten every hold that reads it.
  assert.equal(settledAt([[100, 0.5], [200, 0.995], [300, 0.7], [400, 1]]), 400);
  assert.equal(settledAt([[100, 0.5], [200, 0.99], [300, 1]]), 200, "the run begins at the first point of the tail");
  assert.equal(settledAt([[100, 0.2], [200, 0.3]]), 200, "a market that never gets there settles at its last point");
  assert.equal(settledAt([]), null);
});
