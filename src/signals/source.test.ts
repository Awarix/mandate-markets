import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal } from "./journal.ts";
import { RISK_PARAMS } from "../risk/params.ts";
import { ArchiveSource } from "./source.ts";
import type { PerpsResponse } from "./types.ts";

// `ArchiveSource` is how the executor sees the feed in production
// (`SIGNAL_SOURCE=archive`), and until 2026-09-07 nothing tested it. The bug that
// prompted these: `staleFeedSec` could not fire, because the runner measured the age
// of *our file read* rather than of the feed behind it.

const body = (v: number): PerpsResponse =>
  ({ as_of: "2026-09-07T00:00:00Z", series: [{ series_id: `s${v}` }] }) as unknown as PerpsResponse;

function archive(polls: { at: string; v: number }[]): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sd-source-"));
  const j = new Journal(root);
  for (const p of polls) j.write("perps", body(p.v), new Date(p.at));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// The whole point of the split. A changed poll writes a body; an unchanged one writes
// a line without one. Both are successful polls, so both move `polledAt` — and only
// the first moves `at`.
test("polledAt follows every successful poll, at follows only the content", async () => {
  const a = archive([
    { at: "2026-09-07T10:00:00Z", v: 1 },   // changed  → body
    { at: "2026-09-07T10:30:00Z", v: 1 },   // same     → no body
    { at: "2026-09-07T11:00:00Z", v: 1 },   // same     → no body
  ]);
  try {
    const s = await new ArchiveSource(a.root).fetch();
    assert.equal(s.at.toISOString(), "2026-09-07T10:00:00.000Z", "the content last moved at 10:00");
    assert.equal(s.polledAt.toISOString(), "2026-09-07T11:00:00.000Z", "but we reached Quotient at 11:00");
    assert.equal(s.series.length, 1, "and the body from 10:00 is still the payload in force");
  } finally { a.cleanup(); }
});

// Reading staleness off `at` instead would ground a perfectly healthy account: an hour
// of identical payloads is a normal thing for a vendor to publish, and it is not an
// outage. This is the false positive the two-field split exists to avoid.
test("an hour of identical payloads is not a stale feed", async () => {
  const a = archive([
    { at: "2026-09-07T08:00:00Z", v: 1 },
    { at: "2026-09-07T10:00:00Z", v: 1 },
  ]);
  try {
    const s = await new ArchiveSource(a.root).fetch();
    const ageSec = (Date.parse("2026-09-07T10:01:00Z") - s.polledAt.getTime()) / 1000;
    assert.equal(ageSec, 60, "one minute since the last poll, not two hours since the last change");
    assert.ok(ageSec < RISK_PARAMS.staleFeedSec, "so staleFeedSec must not fire");
  } finally { a.cleanup(); }
});

// And the case that was silently broken: the recorder appends nothing when a poll
// fails (`recorder.ts` — the journal write is inside the try), so a frozen archive is
// exactly what an outage looks like from here. The runner used to re-read this same
// file every 60s and call it fresh.
test("a frozen archive ages, which is what the stale-feed gate is for", async () => {
  const a = archive([{ at: "2026-09-07T11:19:34Z", v: 1 }]);
  try {
    const s = await new ArchiveSource(a.root).fetch();
    // The real outage: last good poll 11:19:34Z, still down at 17:00Z.
    const ageSec = (Date.parse("2026-09-07T17:00:00Z") - s.polledAt.getTime()) / 1000;
    assert.ok(ageSec > RISK_PARAMS.staleFeedSec,
      `a five-hour outage must exceed staleFeedSec, got ${Math.round(ageSec / 60)} min`);
  } finally { a.cleanup(); }
});
