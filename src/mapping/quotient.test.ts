import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CAPTURES, CAPTURE_0830, CAPTURE_0910, directionalSeries, hlSymbol } from "../signals/captures.ts";
import type { DirectionalTake, PerpsSeries } from "../signals/types.ts";
import { evaluateSeries, liveDisplacementSigma, stableOutlookId, stableOutlookKey, type Gate } from "./quotient.ts";
import { RISK_PARAMS } from "../risk/params.ts";

// Tested against two real captured payloads, not a fixture we invented — and, since
// `tasks/46` §3.1, tested for **properties of the mapper** rather than for what either
// payload happened to contain. `src/signals/captures.ts` says why; `fixtures/README.md`
// says what each capture holds. The rule here: a test either loops over `CAPTURES`, or
// it builds the series whose property it is asserting.

const GATE: Gate = {
  minDisplacementSigma: RISK_PARAMS.minDisplacementSigma,
  allowedModes: RISK_PARAMS.allowedModes,
  allowedStrengths: RISK_PARAMS.allowedStrengths,
  maxHoldHours: RISK_PARAMS.maxHoldHours,
};
const OPEN: Gate = { minDisplacementSigma: 0, allowedModes: ["signal", "projection", "coverage"], allowedStrengths: ["low", "medium", "high"], maxHoldHours: 1e6 };

const NOW = new Date("2026-08-30T10:00:00Z");
/** A series that clears every gate, written here rather than found in a capture.
 *  −2.57σ short, which is what the 08-30 BTC next-day outlook was; that same series is
 *  neutral at +0.00σ on the 09-10 capture, which is the whole reason this is a builder. */
const passing = () => directionalSeries({ sigmas: -2.57, now: NOW });

// ── Invariants: properties of the mapper, asserted on every capture ────────────────

test("side and state never disagree — the two axes are consistent", () => {
  for (const c of CAPTURES) {
    for (const s of c.payload.series) {
      const directional = s.outlook.state === "long" || s.outlook.state === "short";
      assert.equal(s.outlook.side !== null, directional, `${c.name} ${s.series_id}: side=${s.outlook.side} state=${s.outlook.state}`);
    }
  }
});

test("neutral series are skipped as no-direction, never mapped", () => {
  for (const c of CAPTURES) {
    const neutral = c.payload.series.filter((s) => s.outlook.side === null);
    assert.ok(neutral.length > 0, `${c.name} has no neutral series`);
    for (const s of neutral) {
      const r = evaluateSeries(s, c.at, OPEN);
      assert.ok(!r.ok && r.reason === "no-direction", `${c.name} ${s.series_id} → ${!r.ok && r.reason}`);
    }
  }
});

// `state=neutral` on its own makes every neutral row on the desk identical, and there
// are 42–64 of them per poll. The model still publishes where it thinks the price is
// going, and those numbers are what separate "nothing to say" from "a real move it
// will not commit to".
test("a neutral skip carries the model's own target and sigma", () => {
  for (const c of CAPTURES) {
    // `side === null` covers `state=unavailable` too, and an unavailable outlook can
    // carry one price without the other — so both are required, exactly as the code does.
    const neutral = c.payload.series.filter((s) =>
      s.outlook.side === null && s.outlook.median_price > 0 && s.outlook.ref_median > 0);
    assert.ok(neutral.length > 0, c.name);

    const details = neutral.map((s) => {
      const r = evaluateSeries(s, c.at, OPEN);
      assert.ok(!r.ok);
      return r.detail;
    });
    for (const d of details) {
      assert.match(d, /^state=(neutral|unavailable) · target [\d.]+ vs [\d.]+ \([+-]\d+\.\d{2}σ\)$/, `${c.name}: ${d}`);
    }
    // The whole point: they are not all the same sentence any more.
    assert.ok(new Set(details).size > 1, `${c.name}: neutral rows must be distinguishable from each other`);
  }
});

test("a neutral outlook with no usable prices says only what it knows", () => {
  const s = { ...passing(), outlook: { ...passing().outlook, side: null, state: "neutral" as const, median_price: 0, ref_median: 0 } };
  const r = evaluateSeries(s, NOW, OPEN);
  assert.ok(!r.ok);
  // No invented zero: `target 0 vs 0 (0.00σ)` would be a claim about the forecast.
  assert.equal(r.detail, "state=neutral");
});

test("`coverage` never carries a direction in a real capture", () => {
  for (const c of CAPTURES) {
    const coverage = c.payload.series.filter((s) => s.mode === "coverage");
    assert.equal(coverage.filter((s) => s.outlook.side !== null).length, 0, c.name);
  }
});

test("every directional series names a live-verifiable Hyperliquid symbol", () => {
  for (const c of CAPTURES) {
    for (const s of c.payload.series.filter((x) => x.outlook.side !== null)) {
      const r = evaluateSeries(s, c.at, OPEN);
      // With every gate open, the only rejections left are expired anchors.
      if (!r.ok) {
        assert.equal(r.reason, "horizon-passed", `${c.name} ${s.series_id} → ${r.reason}`);
        continue;
      }
      assert.match(r.call.coin, /^([A-Z0-9]+|xyz:[A-Z0-9]+)$/, `${c.name}: odd symbol ${r.call.coin}`);
    }
  }
});

// Reverse-engineered from the 08-30 capture, and the reason the live gate can exist at
// all. **The denominator is `sigma_diffusive`, and the test below this one is why that
// correction had to be made**: on the 08-30 capture the two sigmas are equal on every
// directional series, so dividing by `sigma_total` was exact there by coincidence.
test("displacement_sigma is a LOG-return z-score over sigma_diffusive, exactly", () => {
  for (const c of CAPTURES) {
    let checked = 0;
    for (const s of c.payload.series.filter((x) => x.outlook.side !== null && x.outlook.sigma_diffusive > 0)) {
      const o = s.outlook;
      assert.equal(o.ref_median, o.spot_at_obs, `${c.name} ${s.series_id}: ref_median is not spot`);
      const log = Math.log(o.median_price / o.ref_median) / o.sigma_diffusive;
      assert.ok(Math.abs(log - o.displacement_sigma) < 1e-9,
        `${c.name} ${s.series_id}: log form off by ${log - o.displacement_sigma}`);
      checked++;
    }
    assert.ok(checked > 0, `${c.name} has no directional series to check the identity on`);
  }
});

// ⚠ **The two sigmas are not always the same number, and our live re-gate divides by
// the wrong one** — deliberately, for now, because changing it changes what the desk
// trades and that is a decision rather than a test (`tasks/46` §3 moves nothing).
//
// Measured 2026-09-13 over the whole 14-day archive, 598 polls: `displacement_sigma ==
// ln(median/ref) / sigma_diffusive` on **all 4,121 directional series-polls, with no
// exceptions**, while `sigma_total` reproduces it on 4,026 of them and is larger on the
// other 95. `liveDisplacementSigma` divides by `sigmaTotal`, so on those the live count
// is *smaller* than the vendor's — conservative, and the direction that refuses rather
// than admits. It reached the shipped gate **12 times in 1,215 passes, all of them
// `company:orcl:price-outlook:next-day`, and on all twelve the live recompute at the
// vendor's own spot was already below the gate** — so nothing was ever traded on it.
test("the live recompute divides by sigma_total, which is not always the vendor's denominator", () => {
  const split = CAPTURE_0910.payload.series.find((s) =>
    s.outlook.side !== null && s.outlook.sigma_diffusive !== s.outlook.sigma_total);
  assert.ok(split, "the 09-10 capture is committed partly to hold this case (fixtures/README.md)");
  assert.ok(split.outlook.sigma_total > split.outlook.sigma_diffusive, "total is the wider one");

  const ev = evaluateSeries(split, CAPTURE_0910.at, OPEN);
  assert.ok(ev.ok);
  const live = liveDisplacementSigma(ev.call, ev.call.observedSpot);
  assert.ok(Math.abs(live) < Math.abs(ev.call.displacementSigma),
    `the live count must be the smaller one: ${live} vs ${ev.call.displacementSigma}`);
  // Changing `liveDisplacementSigma` to `sigma_diffusive` is a gate change: it would
  // admit entries the desk refuses today. Move the constant, not this assertion.
  assert.ok(Math.abs(live) < RISK_PARAMS.minDisplacementSigma,
    "and on every archive case it refuses the entry anyway");
});

test("every skip reason that fires on a real snapshot is one we can explain", () => {
  const known = ["no-direction", "not-active", "mode-excluded", "strength-excluded", "unmapped-symbol",
    "horizon-too-long", "horizon-passed", "displacement-below-gate"];
  for (const c of CAPTURES) {
    for (const s of c.payload.series) {
      const r = evaluateSeries(s, c.at, GATE);
      if (!r.ok) assert.ok(known.includes(r.reason), `${c.name} ${s.series_id}: unexpected skip reason ${r.reason}`);
    }
  }
});

// The number that shapes the product: after the mapping, the horizon cap and the sigma
// gate, a handful of a whole poll is tradeable at any instant. Idle capital is not the
// exception, it is very nearly the only state. **What is asserted is the selectivity and
// the predicates, not the count** — the count was 2 of 76 on the 08-30 capture and is 6
// of 60 on the 09-10 one, and it has been flipped by every move of `minDisplacementSigma`.
test("the shipped gate is selective, and every call it returns satisfies every clause of it", () => {
  for (const c of CAPTURES) {
    const passed = c.payload.series.map((s) => evaluateSeries(s, c.at, GATE)).filter((r) => r.ok);
    assert.ok(passed.length >= 1, `${c.name}: the gate refused an entire poll`);
    assert.ok(passed.length <= c.payload.series.length * 0.2,
      `${c.name}: ${passed.length} of ${c.payload.series.length} passed — the gate has stopped being selective`);
    for (const r of passed) {
      assert.ok(r.ok);
      const { call } = r;
      assert.ok(Math.abs(call.displacementSigma) >= GATE.minDisplacementSigma, `${call.coin} below the gate`);
      assert.ok(RISK_PARAMS.allowedModes.includes(call.mode), `${call.coin} mode ${call.mode}`);
      assert.ok(call.strength === null || RISK_PARAMS.allowedStrengths.includes(call.strength), `${call.coin} strength ${call.strength}`);
      const hours = (Date.parse(call.horizonAt) - c.at.getTime()) / 3_600_000;
      assert.ok(hours > 0 && hours <= GATE.maxHoldHours, `${call.coin} horizon ${hours}h`);
      assert.ok(call.sigmaTotal > 0 && call.targetPx > 0 && call.observedSpot > 0, `${call.coin} has an unusable number`);
      assert.equal(Math.sign(call.targetPx - call.observedSpot), call.side === "long" ? 1 : -1, `${call.coin}: target on the wrong side`);
    }
  }
});

// mapping_status is Quotient's SETTLEMENT bookkeeping, confirmed by the vendor and
// verified against the archive: `verified` ⟺ anchor in the future, `unresolved` ⟺ anchor
// passed, with no counterexamples. It says nothing about whether the market is
// tradeable, so it must not block one. ⚠ **`unresolved` has since left the feed
// entirely** — 30 of 76 on 08-30, 0 of 60 on 09-10, because no modern poll carries an
// anchor that has already passed — so only the two empty cells are asserted here. The
// *behaviour* is pinned on a constructed series two tests down, where it cannot rot.
test("no capture ever contradicts the mapping_status 2x2", () => {
  for (const c of CAPTURES) {
    const cells = { "verified|future": 0, "verified|past": 0, "unresolved|future": 0, "unresolved|past": 0 };
    for (const s of c.payload.series) {
      const rr = s.basis_groups.find((b) => b.resolution_reference?.provider === "hyperliquid")?.resolution_reference;
      if (!rr) continue;
      const past = Date.parse(s.outlook.anchor_at) <= c.at.getTime();
      const key = `${rr.mapping_status}|${past ? "past" : "future"}` as keyof typeof cells;
      if (key in cells) cells[key]++;
    }
    assert.equal(cells["verified|past"], 0, `${c.name}: a settled-and-passed anchor is never \`verified\``);
    assert.equal(cells["unresolved|future"], 0, `${c.name}: a live anchor is never \`unresolved\``);
    assert.ok(cells["verified|future"] > 0, `${c.name}: ${JSON.stringify(cells)}`);
  }
});

// The guarantee the retirement check and `hasLiveIntentFor` both rest on: within one
// payload, no two series may collapse onto the same stable id.
test("stable ids are unique across a whole capture, and every raw id keys", () => {
  for (const c of CAPTURES) {
    const raw = c.payload.series.map((x) => x.outlook.outlook_id);
    assert.equal(new Set(raw.map(stableOutlookId)).size, raw.length, `${c.name}: two series would be confused for one outlook`);
    assert.ok(raw.every((r) => stableOutlookKey(r) !== null), `${c.name}: a ref that does not key is an unknown shape`);
    assert.equal(new Set(raw.map(stableOutlookKey)).size, raw.length, c.name);
    assert.ok(
      raw.map(stableOutlookId).every((k) => stableOutlookKey(k) === null),
      `${c.name}: what we store must not key again, or a migration could run twice`,
    );
  }
});

// ── Properties, on series the test builds ─────────────────────────────────────────

test("a directional series in `coverage` mode is refused by the mode gate", () => {
  // Belt and braces, and the only way to assert it: `coverage` is always neutral on the
  // wire, so `no-direction` fires first and the mode clause is unreachable from a capture.
  const s: PerpsSeries = { ...passing(), mode: "coverage" };
  const r = evaluateSeries(s, NOW, { ...OPEN, allowedModes: RISK_PARAMS.allowedModes });
  assert.ok(!r.ok && r.reason === "mode-excluded", `→ ${r.ok ? "passed" : r.reason}`);
});

// The finding the entry gate is built on: `edge_pct` alone mis-ranks a 1.5% move over
// 30 minutes against a 1.5% move over a week. On the 08-30 capture that was TSLA
// against BTC; the property is about the two horizons, not the two tickers.
test("a small edge over a short horizon outranks a large edge over a long one", () => {
  const quick = directionalSeries({ sigmas: -5.1, sigmaTotal: 0.003, now: NOW }).outlook;  // −1.5% over hours
  const slow = directionalSeries({ sigmas: -2.57, now: NOW }).outlook;                     // −7.6% over a day
  assert.ok(Math.abs(quick.edge_pct) < Math.abs(slow.edge_pct), "the quick call's raw edge is the smaller one");
  assert.ok(Math.abs(quick.displacement_sigma) > Math.abs(slow.displacement_sigma), "but its displacement is the larger");
});

test("the linear form is wrong by enough to flip a gate decision", () => {
  // The 08-30 BTC numbers, stated here rather than looked up: −2.57σ at sigma 0.0309.
  const o = directionalSeries({ sigmas: -2.57, now: NOW }).outlook;
  const linear = (o.median_price / o.ref_median - 1) / o.sigma_diffusive;
  assert.ok(Math.abs(linear - o.displacement_sigma) > 0.09,
    `linear reads ${linear.toFixed(2)}σ where the log form says ${o.displacement_sigma}σ`);
});

test("the live recompute agrees with the vendor when the market has not moved", () => {
  const r = evaluateSeries(passing(), NOW, OPEN);
  assert.ok(r.ok);
  const live = liveDisplacementSigma(r.call, r.call.observedSpot);
  assert.ok(Math.abs(live - r.call.displacementSigma) < 1e-9, `${live} vs ${r.call.displacementSigma}`);
});

test("the live recompute collapses the edge once price walks to the target", () => {
  const r = evaluateSeries(passing(), NOW, OPEN);
  assert.ok(r.ok);
  assert.ok(Math.abs(liveDisplacementSigma(r.call, r.call.targetPx)) < 1e-9, "at the target there is no edge left");
  // Half the move already gone → roughly half the sigmas left.
  const half = (r.call.observedSpot + r.call.targetPx) / 2;
  assert.ok(Math.abs(liveDisplacementSigma(r.call, half)) < Math.abs(r.call.displacementSigma) * 0.55);
});

// ⚠ The refusal used to print *"~N% of margin in funding at 10x"* from a model measured
// to be ~28× the funding actually paid, into every `horizon-too-long` row on the owner's
// Skipped tab (`tasks/46` §4). It says what the rule is now: an entry filter on the
// outlook's remaining horizon, which is the only thing `maxHoldHours` has ever done —
// no position in 458 trips has been held past 19.2h.
test("a horizon past the cap is skipped, and the refusal names the rule it applied", () => {
  const s = directionalSeries({ sigmas: -2.57, now: NOW, hoursAhead: RISK_PARAMS.maxHoldHours + 1 });
  const r = evaluateSeries(s, NOW, { ...OPEN, maxHoldHours: RISK_PARAMS.maxHoldHours });
  assert.ok(!r.ok && r.reason === "horizon-too-long", `→ ${r.ok ? "passed" : r.reason}`);
  assert.ok(!r.ok && r.detail.includes("entry filter"), r.ok ? "" : r.detail);
  assert.ok(!r.ok && !/funding/.test(r.detail), "the funding model in this sentence was ~28× the real cost");
});

// The feed carries outlooks whose anchor has already passed — 8 of the 12 directional
// series on the 08-30 capture, none at all on 09-10, so the horizon gate is load-bearing
// on one and idle on the other. The property is that a passed anchor is never traded.
test("an expired outlook is skipped, never traded late", () => {
  const s = directionalSeries({ sigmas: -2.57, now: NOW, hoursAhead: -1 });
  assert.ok(Date.parse(s.outlook.anchor_at) < NOW.getTime());
  const r = evaluateSeries(s, NOW, OPEN);
  assert.ok(!r.ok && r.reason === "horizon-passed");
});

test("a settlement status of `unresolved` does not block a live signal", () => {
  const s = passing();
  for (const bg of s.basis_groups) if (bg.resolution_reference) bg.resolution_reference.mapping_status = "unresolved";
  const r = evaluateSeries(s, NOW, OPEN);
  assert.ok(r.ok, `refused a tradeable signal: ${!r.ok && r.reason}`);
  assert.equal(r.call.mappingStatus, "unresolved", "but it is carried through for Phase 0 to split on");
});

test("a series with no Hyperliquid basis group is refused, never guessed from asset_key", () => {
  const s = passing();
  s.basis_groups = [];
  const r = evaluateSeries(s, NOW, OPEN);
  assert.ok(!r.ok && r.reason === "unmapped-symbol");
  assert.equal(r.ok === false && r.coin, null, "no symbol may be reported when none was given");
});

test("evaluateSeries hands downstream the stable id, never the raw one", () => {
  const s = passing();
  const ev = evaluateSeries(s, NOW, GATE);
  assert.ok(ev.ok);
  assert.equal(ev.call.signalRef, stableOutlookId(s.outlook.outlook_id));
  assert.notEqual(ev.call.signalRef, s.outlook.outlook_id);
});

// ── The stable id ──────────────────────────────────────────────────────────────────
//
// `outlook_id` is not an identity — its last component is a per-revision content
// hash. Three consecutive real ids for one PLATINUM outlook, from the 2026-08-30
// archive (revisions 213, 214, 215, ~1h apart), plus its neutral form 6 revisions
// earlier. All four are the same outlook and must key the same.
const PLATINUM_IDS = [
  "po:commodity:platinum:price-outlook:monthly:2026-08-31:07a8a1be7f379196:02625d9eaaace951",
  "po:commodity:platinum:price-outlook:monthly:2026-08-31:07a8a1be7f379196:b683f308a9c6e822",
  "po:commodity:platinum:price-outlook:monthly:2026-08-31:07a8a1be7f379196:61736a1b944004aa",
  "po:commodity:platinum:price-outlook:monthly:2026-08-31:07a8a1be7f379196:e6fce450591fb700",
];

test("a rotating outlook_id collapses to one stable id", () => {
  const stable = new Set(PLATINUM_IDS.map(stableOutlookId));
  assert.equal(new Set(PLATINUM_IDS).size, 4, "the raw ids really are all different");
  assert.equal(stable.size, 1, "and they are all the same outlook");
  assert.equal([...stable][0], "po:commodity:platinum:price-outlook:monthly:2026-08-31");
});

// **The case no capture of one poll could hold**, and the one that cost $3.13: these are
// the two keys the 2026-09-11T05:49:54Z epoch rewrite actually left in the ledger for one
// WTI outlook, taken from `intents`. An epoch spans days; a poll is an instant.
test("two epochs of one outlook are one outlook", () => {
  const before = "po:commodity:wti:price-outlook:daily:2026-09-11:47f8c5a6ef3e223c:0e0b64d64a21e8f2";
  const after = "po:commodity:wti:price-outlook:daily:2026-09-11:ad418704103bb56d:474388c7b0f31805";
  assert.notEqual(before, after);
  assert.equal(stableOutlookId(before), stableOutlookId(after));
  assert.equal(stableOutlookId(after), "po:commodity:wti:price-outlook:daily:2026-09-11");
});

test("distinct outlooks stay distinct, and a component-less id survives", () => {
  const btc = stableOutlookId(passing().outlook.outlook_id);
  assert.notEqual(btc, stableOutlookId(PLATINUM_IDS[0]!));
  assert.equal(stableOutlookId("nocolons"), "nocolons");
});

// `tasks/41`. `stableOutlookKey` is the strict form of the same rule, for the migration
// and the count, where an unrecognised shape must be a refusal rather than a guess. The
// cases that matter are the last two: the ledger holds two forms, and a truncation
// applied twice takes the anchor date with it.
test("stableOutlookKey keys every revision and every epoch of one outlook the same", () => {
  const keys = PLATINUM_IDS.map(stableOutlookKey);
  assert.equal(new Set(keys).size, 1);
  assert.equal(keys[0], "po:commodity:platinum:price-outlook:monthly:2026-08-31");
  // The same outlook after a rotation: a different epoch tag, the same key.
  assert.equal(
    stableOutlookKey("po:commodity:platinum:price-outlook:monthly:2026-08-31:ad418704103bb56d"),
    keys[0],
  );
});

test("stableOutlookKey reads both forms the ledger holds, which is why it counts", () => {
  // 8 components: a raw `outlook_id`. 2 rows in `signals` and 13 in `skips` are in this
  // form, written on 2026-08-30 before `stableOutlookId` existed.
  assert.equal(PLATINUM_IDS[0]!.split(":").length, 8);
  // 7: what `stableOutlookId` wrote until 2026-09-13 — the epoch tag still on the end.
  const seven = "po:commodity:platinum:price-outlook:monthly:2026-08-31:07a8a1be7f379196";
  assert.equal(seven.split(":").length, 7);
  assert.equal(stableOutlookKey(PLATINUM_IDS[0]!), stableOutlookKey(seven));
  // Both tails are sixteen lowercase hex, so "drop the last component" cannot tell them
  // apart and would leave the older form still carrying an epoch tag.
});

test("stableOutlookKey refuses everything else, which is what makes it safe twice", () => {
  const once = stableOutlookKey(PLATINUM_IDS[0]!);
  assert.ok(once !== null);
  assert.equal(stableOutlookKey(once), null, "a second pass would eat the anchor date");
  assert.equal(stableOutlookKey("nocolons"), null);
  assert.equal(stableOutlookKey("po:commodity:platinum:price-outlook:monthly"), null, "too few");
  assert.equal(stableOutlookKey("po:x:y:price-outlook:daily:2026-09-11:07A8A1BE7F379196"), null, "hex is lower case");
  assert.equal(stableOutlookKey("po:x:y:price-outlook:daily:2026-09-11:07a8a1be7f3791"), null, "and sixteen wide");
});

// ── the fields we gather and do not read (owner's decision, 2026-09-12) ────────────
//
// Quotient began publishing `directional_take`, `lean_side`/`lean_sigma`, `scenarios`
// and `is_primary_horizon` after the 08-30 capture — on 2026-09-04T05:34:42Z, dated by
// `src/signals/contract.ts` on its first run. On the 09-10 capture `outlook.side` is
// non-null on 18 of 60 series while `directional_take.side` is non-neutral on 44, so the
// gate sees well under half the opinions on the wire — and the field that sounds like it
// settles it, `is_price_signal`, was **false on every series-poll** in the archive,
// including the ones the executor traded.
//
// **The decision is to keep reading `side` and record the rest until Quotient says
// what they mean.** These tests are that decision, written where it would be broken:
// the series is constructed rather than found, so the property is in the test and not
// in whichever series happened to be directional on a Saturday (`tasks/46` §3.1).

const withOutlook = (base: PerpsSeries, o: Partial<PerpsSeries["outlook"]>): PerpsSeries =>
  ({ ...base, outlook: { ...base.outlook, ...o } });

const STRONG_TAKE: DirectionalTake = {
  side: "bearish", strength: "strong", label: "Strongly bearish", score_sigma: -3.5,
  payoff_balance: 0.5, probability_above_spot: 0.2, expected_price: 1, expected_return_pct: -0.02,
  expected_log_return: -0.02, expected_upside_log: 0.01, expected_downside_log: 0.03,
  range_status: "clamped", truncated_percentiles: [], method: "full_quantile_curve",
  version: "directional-take/2", is_price_signal: false,
};

test("a null side is refused even when directional_take is strongly directional", () => {
  // The exact shape that is 26 of 60 series on the 09-10 capture: Quotient has a view,
  // `side` is null.
  const s = withOutlook(passing(), { side: null, state: "neutral", directional_take: { ...STRONG_TAKE } });
  const ev = evaluateSeries(s, NOW, OPEN);
  assert.equal(ev.ok, false);
  assert.equal(ev.ok === false && ev.reason, "no-direction",
    "the gate read directional_take — that is a decision nobody has taken (docs/STATUS.md item 28b)");
});

test("lean_side does not make a neutral series tradeable, at any lean_sigma", () => {
  // `lean_sigma` equals `displacement_sigma` to 1e-12 on every series-poll that carries
  // it, so it is a restatement — but it is signed, and platinum sat at 0.61 past a 0.5
  // gate with `side` null and was never seen.
  const s = withOutlook(passing(), {
    side: null, state: "neutral", lean_side: "short", lean_sigma: -3.5, displacement_sigma: -3.5,
  });
  const ev = evaluateSeries(s, NOW, OPEN);
  assert.equal(ev.ok === false && ev.reason, "no-direction");
});

test("is_price_signal false does not refuse a series the gate would otherwise take", () => {
  // The other direction, and the one that would silently empty the book: the flag has
  // never been true in the archive, so reading it as "tradeable" stops all trading.
  const s = withOutlook(passing(), { directional_take: { ...STRONG_TAKE, side: "bearish" } });
  const ev = evaluateSeries(s, NOW, OPEN);
  assert.equal(ev.ok, true, "the gate started reading is_price_signal, which is false on every series ever captured");
});

test("the gate reads none of the fields added since the 08-30 capture", () => {
  const src = readFileSync(new URL("./quotient.ts", import.meta.url), "utf8");
  for (const f of ["directional_take", "lean_side", "lean_sigma", "scenarios", "is_primary_horizon", "score_sigma", "is_price_signal"]) {
    assert.doesNotMatch(src, new RegExp(f),
      `${f} reached the mapper. It is gathered, not read (docs/STATUS.md item 28b); ` +
      "wiring it in is a decision that needs Quotient's answer first, and this test is where it is recorded.");
  }
});

// The capture-shape facts that used to be assertions and are now documentation, kept
// here as one check that the two captures really are the two different feeds
// `fixtures/README.md` describes. If this fails, a fixture was replaced — which is
// allowed, but then README.md is what needs the edit.
test("the two captures are the two feeds the README says they are", () => {
  // ⚠ **First**, that both of them are actually in `CAPTURES`. Every invariant in this
  // file and the per-capture lifecycle test in `exec/loop.test.ts` loop over that list,
  // so dropping an entry does not fail anything — it silently halves the suite, which is
  // the one failure `tasks/46` §3.1 could not otherwise catch. Removing a capture is
  // allowed; doing it without noticing is not.
  assert.deepEqual(CAPTURES.map((c) => c.name), [CAPTURE_0830.name, CAPTURE_0910.name]);
  assert.equal(CAPTURE_0830.payload.series.length, 76);
  assert.equal(CAPTURE_0910.payload.series.length, 60);
  assert.equal(CAPTURE_0830.payload.series.filter((s) => s.mode === "coverage").length, 31);
  assert.equal(CAPTURE_0910.payload.series.filter((s) => s.mode === "coverage").length, 8);
  assert.equal(CAPTURE_0830.payload.series.filter((s) => hlSymbol(s) === null).length, 0);
  assert.equal(CAPTURE_0910.payload.series.filter((s) => hlSymbol(s) === null).length, 0);
});
