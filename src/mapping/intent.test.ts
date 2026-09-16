import assert from "node:assert/strict";
import { test } from "node:test";
import { directionalSeries } from "../signals/captures.ts";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS } from "../risk/params.ts";
import { buildIntent, type Market } from "./intent.ts";
import { evaluateSeries, type Gate } from "./quotient.ts";

// The Quotient citation (`tasks/12`).
//
// Quotient's founder granted permission to build on their API on 2026-09-02 with
// exactly one condition: *"if you're presenting users analysis from Quotient, cite that
// it's from Quotient"*. Every user-facing surface that shows their analysis — the
// position cards, the trade history, the signal history, and the share cards in
// `tasks/16` — reads its sentence from `rationale()` in `intent.ts`, so the whole of
// that obligation rests on one word inside one template literal. Reword the sentence
// and the citation disappears everywhere at once, in a commit whose diff looks like
// copy-editing. Nothing failed when it did.
//
// So: assert the **word**, not the sentence. A test pinning the full string would fail
// on every legitimate copy edit and would be deleted within a month.
//
// The same assertion is owed to `src/mapping/quotient-pm.ts` when Phase 5 builds it —
// the sharper case, because `/signals` carries `thesis`, Quotient's own prose, where
// the perps feed only gives us numbers to paraphrase. `tasks/06` §8 step 2 carries it.

const NOW = new Date("2026-08-30T10:00:00Z");

const GATE: Gate = {
  minDisplacementSigma: RISK_PARAMS.minDisplacementSigma,
  allowedModes: RISK_PARAMS.allowedModes,
  allowedStrengths: RISK_PARAMS.allowedStrengths,
  maxHoldHours: RISK_PARAMS.maxHoldHours,
};

/** Live HL metadata, 2026-08-30: BTC is asset 0, szDecimals 5, 40x. */
const BTC: Market = { coin: "BTC", assetId: 0, dex: "", szDecimals: 5, maxLeverage: 40 };

/** A call that clears every gate — built here rather than found in a capture, so this
 *  test breaks when the mapper stops producing a call and not when the feed moves
 *  (`tasks/46` §3.1). It is still the real `evaluateSeries`, so a mapper that stopped
 *  emitting a `rationale` at all would still be caught. */
function passingCall() {
  const evaluated = evaluateSeries(directionalSeries({ sigmas: -2.57, now: NOW }), NOW, GATE);
  assert.ok(evaluated.ok, `the constructed series no longer passes: ${!evaluated.ok && evaluated.reason}`);
  return evaluated.call;
}

test("the rationale names Quotient — the one thing they asked for in exchange for the API", () => {
  const call = passingCall();
  const built = buildIntent(call, BTC, DEFAULT_USER_SETTINGS, 100, call.observedSpot, NOW);
  assert.ok(built.ok, `intent did not build: ${!built.ok && built.reason} ${!built.ok && built.detail}`);
  assert.match(built.intent.rationale, /Quotient/);
});
