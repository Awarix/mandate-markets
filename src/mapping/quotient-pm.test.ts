import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PmResponse, PmSignal } from "../signals/types.ts";
import { stablePmKey } from "./quotient-pm.ts";

// The identity a prediction-market position is keyed on, against the committed capture.
//
// ⚠ `tasks/06` §8 Step 2's done-condition also requires this file to assert that the
// mapper's rationale **names Quotient**, the way `src/mapping/intent.test.ts` does for
// perps (`tasks/12`). There is no mapper yet, so there is no such test yet — and Step 2
// stays open until both exist. Do not read the presence of this file as Step 2 landing.

const SIGNALS: PmSignal[] = (
  JSON.parse(readFileSync("fixtures/signals-2026-09-02.json", "utf8")) as PmResponse
).signals;

const PM = SIGNALS.filter((s) => s.market.venue === "polymarket");

test("the key is venue, market and side — and never the revision id", () => {
  const s = PM[0];
  assert.ok(s);
  assert.equal(stablePmKey(s), `polymarket:${s.market.nativeMarketId}:${s.side}`);
  assert.ok(!stablePmKey(s).includes(s.id));
});

// The bug this exists to prevent: market 601819 sat in all 39 polls of 2026-08-30 →
// 09-01 with an unchanged `side: YES` under seven different ids
// (`notes/2026-09-01-research-polymarket.md` §1), and one key in the 16-day archive
// carries 21. Every one of those revisions has to collapse onto one position.
test("seven revisions of one market and side collapse to one key", () => {
  const base = PM[0];
  assert.ok(base);
  const revisions: PmSignal[] = ["a", "b", "c", "d", "e", "f", "g"].map((suffix, i) => ({
    ...base,
    id: `${base.id}-${suffix}`,
    // The fields that move with a revision, and must not reach the key.
    created_at: `2026-08-3${i}T00:00:00Z`,
    published_at: `2026-08-3${i}T00:00:00Z`,
    entry_pm: base.entry_pm + i,
    current_cost_cents: base.current_cost_cents + i,
  }));
  assert.equal(new Set(revisions.map((r) => r.id)).size, 7);
  assert.equal(new Set(revisions.map(stablePmKey)).size, 1);
});

// The other half: one market called both ways over its life is two positions, not one
// position changing its mind. Rare — 127 keys over 123 markets in the archive — but the
// two are opposite sides of a binary market and netting them would be the
// `unmapped-symbol` failure with our own key as the cause.
test("the same market on the other side is a different key", () => {
  const base = PM[0];
  assert.ok(base);
  const other: PmSignal = { ...base, side: base.side === "YES" ? "NO" : "YES" };
  assert.notEqual(stablePmKey(base), stablePmKey(other));
});

test("every Polymarket row in the capture produces a well-formed key", () => {
  assert.equal(PM.length, 47);
  for (const s of PM) {
    const key = stablePmKey(s);
    const parts = key.split(":");
    assert.equal(parts.length, 3);
    assert.equal(parts[0], "polymarket");
    assert.match(parts[1] ?? "", /^\d+$/); // nativeMarketId is a numeric string
    assert.ok(parts[2] === "YES" || parts[2] === "NO");
  }
});
