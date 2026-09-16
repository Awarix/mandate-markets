import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PmResponse, PmSignal } from "./types.ts";

// `PmSignal` against the real thing.
//
// The type it replaced was written from the published reference and got most of the
// top level wrong — the same failure `notes/2026-08-30-perps-payload-findings.md`
// recorded for `/signals/perps`, on the same vendor, four days apart. So these assert
// against a **committed real capture**, and the counts in them are findings rather
// than arbitrary numbers: `notes/2026-09-02-pm-signals-payload.md` says what each one
// contradicted.
//
// A failure here is vendor drift, not a broken test. Read the note, re-run the census,
// and update both together.

const BODY = JSON.parse(readFileSync("fixtures/signals-2026-09-02.json", "utf8")) as PmResponse;
const SIGNALS: PmSignal[] = BODY.signals;

test("the response is one key, and the fixture is the capture it says it is", () => {
  assert.deepEqual(Object.keys(BODY), ["signals"]);
  assert.equal(SIGNALS.length, 61);
});

// The declared shape is the *whole* shape: a field the vendor adds should be noticed,
// and a field we declare that is not there is a type lying about reality.
test("every signal has exactly the 43 fields the type declares", () => {
  const declared = new Set([
    "id", "created_at", "published_at", "forecast_updated_at", "is_new_today", "is_fresh",
    "is_active", "side", "q_side", "entry_q", "entry_pm", "entry_spread_pp", "window_days",
    "resolves_in_window", "forecast_status", "retired_reason", "conviction_tier", "conviction",
    "has_band", "latest_q", "thesis", "q_value_cents", "entry_cost_cents", "current_cost_cents",
    "distance_to_convergence_cents", "converge_upside_pct", "max_roi_pct", "live_priced",
    "priced_at", "capacity_usd_at_2c", "capacity_available", "capacity_basis", "capacity_as_of",
    "drawdown_risk_elevated", "crash_risk_elevated", "venue_quote", "resolution_reference",
    "execution_reference", "basis_status", "grounding_status", "suppression_reason",
    "relationships", "market",
  ]);
  assert.equal(declared.size, 43);
  for (const s of SIGNALS) {
    const actual = new Set(Object.keys(s));
    assert.deepEqual([...actual].filter((k) => !declared.has(k)), [], `undeclared on ${s.id}`);
    assert.deepEqual([...declared].filter((k) => !actual.has(k)), [], `missing on ${s.id}`);
  }
});

// **The feed is not Polymarket-only**, which `tasks/06` has to decide about rather
// than discover: a Polymarket-only pipeline silently drops a quarter of it.
test("both venues arrive in the same response", () => {
  const byVenue = new Map<string, number>();
  for (const s of SIGNALS) byVenue.set(s.market.venue, (byVenue.get(s.market.venue) ?? 0) + 1);
  assert.deepEqual([...byVenue].sort(), [["kalshi", 14], ["polymarket", 47]]);
  for (const s of SIGNALS) assert.equal(s.venue_quote.venue, s.market.venue, "the two agree");
});

// The docs-derived type declared this a `number` and the plan sized against it.
test("capacity_usd_at_2c has never been populated", () => {
  assert.equal(SIGNALS.filter((s) => s.capacity_usd_at_2c !== null).length, 0);
  assert.equal(SIGNALS.filter((s) => s.capacity_available !== null).length, 0);
});

// `/signals/perps` names its tradeable instrument in `resolution_reference`. This feed
// does not, so `market.condition_id` is the only executable identifier it hands us.
test("no execution mapping arrives; condition_id is what is left", () => {
  for (const s of SIGNALS) {
    assert.equal(s.resolution_reference, null);
    assert.equal(s.execution_reference, null);
  }
  const pm = SIGNALS.filter((s) => s.market.venue === "polymarket");
  assert.equal(pm.filter((s) => typeof s.market.condition_id === "string").length, 47);
  assert.ok(pm.every((s) => /^0x[0-9a-f]{64}$/.test(s.market.condition_id ?? "")), "a 32-byte id");
  assert.ok(
    SIGNALS.filter((s) => s.market.venue === "kalshi").every((s) => s.market.condition_id === null),
    "and nothing on Kalshi",
  );
});

// A clean venue split, and it matters: on the venue we intend to trade, this feed
// carries no spread at all.
test("Polymarket rows carry a probability and no bid or ask", () => {
  for (const s of SIGNALS) {
    const q = s.venue_quote;
    if (s.market.venue === "polymarket") {
      assert.equal(q.yes_bid, null);
      assert.equal(q.yes_ask, null);
      assert.equal(q.venue_timestamp, null);
    } else {
      assert.equal(typeof q.yes_bid, "number");
      assert.equal(typeof q.yes_ask, "number");
    }
    assert.equal(typeof q.selected_probability, "number");
  }
});

// Free in the payload, so a volume floor needs no venue call — and half the feed is
// under the floor the reference implementation uses.
test("volume_24h is Polymarket-only, and half of it is under $10k", () => {
  const pm = SIGNALS.filter((s) => s.market.venue === "polymarket");
  assert.ok(pm.every((s) => typeof s.market.volume_24h === "number"));
  assert.ok(SIGNALS.filter((s) => s.market.venue === "kalshi").every((s) => s.market.volume_24h === null));
  assert.equal(pm.filter((s) => (s.market.volume_24h ?? 0) < 10_000).length, 23);
});

// There is no `status`. Liveness is spread across six fields, and a mapper reaching
// for the docs' single one would find `undefined` and treat everything as tradeable.
test("liveness is six fields, not one", () => {
  for (const s of SIGNALS) {
    assert.ok(!("status" in s));
    assert.equal(typeof s.is_active, "boolean");
    assert.equal(typeof s.forecast_status.state, "string");
  }
  const states = new Set(SIGNALS.map((s) => s.forecast_status.state));
  assert.deepEqual([...states].sort(), ["caution", "converged", "converging", "diverging", "sideways", "warning"]);
});

// `side` is what to buy; `q_side` is what the forecast is stated for. They are not the
// same field and they do not always agree.
test("the recommended side and the forecast side can differ", () => {
  assert.equal(SIGNALS.filter((s) => s.side !== s.q_side).length, 11);
});

// Two ISO-8601 spellings of the same instant in one response. Both parse; a string
// comparison between them does not.
test("end_date arrives in two formats", () => {
  const ends = SIGNALS.map((s) => s.market.end_date);
  assert.ok(ends.some((e) => e.endsWith("Z")), "some end Z");
  assert.ok(ends.some((e) => e.endsWith("+00:00")), "some end +00:00");
  for (const e of ends) assert.ok(Number.isFinite(Date.parse(e)), e);
});

// An order of magnitude longer than the perps feed, and most markets do not resolve
// inside the window — so an exit cannot assume settlement.
test("windows are weeks, and usually outlive the market's own deadline question", () => {
  const days = SIGNALS.map((s) => s.window_days).sort((a, b) => a - b);
  assert.equal(days[0], 3);
  assert.equal(days.at(-1), 60);
  assert.equal(SIGNALS.filter((s) => !s.resolves_in_window).length, 46);
});

// The docs said 1 | 2 | 3.
test("only two conviction tiers have ever appeared", () => {
  assert.deepEqual([...new Set(SIGNALS.map((s) => s.conviction_tier))].sort(), [1, 2]);
  for (const s of SIGNALS) {
    assert.equal(s.conviction, s.conviction_tier === 1 ? "low" : "medium");
  }
});

// ⚠⚠ **The third frame axis, found 2026-09-15 scoring the resolved markets**
// (`notes/2026-09-15-what-the-resolved-markets-say.md` §1). `PmSignal.entry_q`'s comment
// documents *entry versus live*; underneath it there is a second, independent split, and
// an EV computed across it is inverted rather than merely stale:
//
//   side-relative — the `_cents` family: q_value_cents, entry_cost_cents, current_cost_cents
//   YES-frame     — the probability family: entry_q, entry_pm, latest_q, market.market_odds,
//                   venue_quote.selected_probability
//
// So `current_cost_cents` is already what a buy of `side` pays and needs no branch, while
// `entry_pm` is the YES price whichever side is recommended. `q_side` flips nothing: on
// every row where it disagrees with `side`, `latest_q` is still the YES probability and
// `q_value_cents` is still side-relative.
test("the _cents family is side-relative and the probability family is YES-frame", () => {
  const pm = SIGNALS.filter((s) => s.market.venue === "polymarket");
  const yes = pm.filter((s) => s.side === "YES");
  const no = pm.filter((s) => s.side === "NO");
  assert.ok(yes.length > 0 && no.length > 0, "both sides present");

  // q_value_cents is latest_q for a YES call and its complement for a NO call.
  for (const s of yes) assert.equal(s.q_value_cents, Math.round(s.latest_q * 100), s.id);
  for (const s of no) assert.equal(s.q_value_cents, 100 - Math.round(s.latest_q * 100), s.id);

  // entry_cost_cents is entry_pm the same way.
  for (const s of yes) assert.equal(s.entry_cost_cents, s.entry_pm, s.id);
  for (const s of no) assert.equal(s.entry_cost_cents, 100 - s.entry_pm, s.id);

  // Which is why the gate derives direction from the YES pair and compares it to `side`:
  // both legs are in one frame, so the comparison means something.
  for (const s of pm) assert.equal(s.side, s.entry_q > s.entry_pm ? "YES" : "NO", s.id);
});

// ⚠⚠ A Polymarket market's tokens are not always named Yes and No. *US Open WTA: Aryna
// Sabalenka vs Elena Rybakina* carries one token per player, and Quotient sends it with
// `side: "YES"` regardless — a side that cannot be turned into a token by any rule we
// would defend. `CLAUDE.md`'s *unknown asset mapping → reject the signal* is the answer,
// and the mapper `tasks/06` §8 Step 2 builds must make that refusal rather than guess.
// The fixture cannot see this one (the market arrived later in the archive), so this test
// guards the shape the refusal keys on rather than the row itself.
test("a side is only tradeable against a YES/NO token pair", () => {
  const tradeable = (outcomes: string[]): boolean => {
    const o = outcomes.map((x) => x.toUpperCase());
    return o.includes("YES") && o.includes("NO");
  };
  assert.ok(tradeable(["Yes", "No"]));
  assert.ok(!tradeable(["Aryna Sabalenka", "Elena Rybakina"]));
  assert.ok(!tradeable(["Yes"]));
});
