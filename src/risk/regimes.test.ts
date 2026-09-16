import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { FEED_REGIMES, regimeAt } from "./regimes.ts";

// The table is the whole point of `tasks/32` §2.2, so it is pinned rather than trusted:
// a boundary nobody can trace back to an argument is a number somebody typed.

test("every boundary cites a note that still exists", () => {
  for (const r of FEED_REGIMES) {
    assert.ok(existsSync(r.note), `${r.name}: ${r.note} is gone`);
    assert.ok(r.what.length > 20, `${r.name}: say what moved`);
  }
});

test("the boundaries are ordered, unique and parseable", () => {
  const ts = FEED_REGIMES.map((r) => Date.parse(r.from));
  assert.ok(ts.every(Number.isFinite), "every `from` parses");
  for (let i = 1; i < ts.length; i++) assert.ok(ts[i]! > ts[i - 1]!, `${FEED_REGIMES[i]!.name} is not after its predecessor`);
  assert.equal(new Set(FEED_REGIMES.map((r) => r.name)).size, FEED_REGIMES.length);
});

// Two of them are changes we did not make — the asymmetry `tasks/32` §2.2 is about.
// Ours are in this repository's git history; theirs exist only in a note, which is why
// the note is asserted above and why this count is asserted at all.
test("two of the boundaries are changes we did not make", () => {
  assert.equal(FEED_REGIMES.filter((r) => r.by === "quotient").length, 2);
  assert.equal(FEED_REGIMES.filter((r) => r.by === "ours").length, 4);
});

test("a trade lands in the regime in force when it opened", () => {
  assert.equal(regimeAt("2026-09-01T12:00:00Z").name, "pre-09-04");
  assert.equal(regimeAt("2026-09-05T00:00:00Z").name, "09-04 famine");
  // The σ0.5 deploy is to the second, and the first intent it produced was 09:46:07Z —
  // four seconds after the restart (`notes/2026-09-07-phase3-fourth-reading.md`). A
  // boundary rounded to the day would have put that trade in the wrong arm.
  assert.equal(regimeAt("2026-09-07T09:46:02Z").name, "09-04 famine");
  assert.equal(regimeAt("2026-09-07T09:46:07Z").name, "sigma0.5");
  assert.equal(regimeAt("2026-09-08T18:00:00Z").name, "reverted");
  // The σ1.0 revert is to the second for a reason that is already in the ledger: three
  // trips opened at 2026-09-10T00:01:4x–5xZ, under σ0.5, and a boundary rounded to that
  // day would have filed all three in the arm that is meant to be their control.
  assert.equal(regimeAt("2026-09-10T00:01:56.523Z").name, "reverted");
  assert.equal(regimeAt("2026-09-10T08:49:37.181Z").name, "sigma1.0");
  // `sigma1.0` lived 12h21m. A block that short is exactly the case a table of dated
  // boundaries exists for: it holds 7 events and must never be averaged into either
  // neighbour, however tempting the shared constant on one side and the shared feed on
  // both makes it.
  assert.equal(regimeAt("2026-09-10T20:39:17.999Z").name, "sigma1.0");
  assert.equal(regimeAt("2026-09-10T20:39:18Z").name, "sigma0.5-again");
});

// A trade cannot predate the recorder, so a timestamp that does is a clock problem
// rather than a fifth population — and must not silently become one.
test("anything before the archive belongs to the first regime", () => {
  assert.equal(regimeAt("2020-01-01T00:00:00Z").name, FEED_REGIMES[0]!.name);
});
