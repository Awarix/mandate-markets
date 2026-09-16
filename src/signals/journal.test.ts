import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { buildLine, contentHash, Journal, journalPath } from "./journal.ts";

test("contentHash ignores key order", () => {
  assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
});

test("contentHash ignores nested key order but not values", () => {
  assert.equal(contentHash({ x: { a: 1, b: [1, 2] } }), contentHash({ x: { b: [1, 2], a: 1 } }));
  assert.notEqual(contentHash({ x: [1, 2] }), contentHash({ x: [2, 1] }));
});

test("buildLine stores the body only when content changed", () => {
  const at = new Date("2026-08-30T12:00:00Z");
  const first = buildLine("perps", { v: 1 }, undefined, at);
  assert.equal(first.changed, true);
  assert.deepEqual(first.body, { v: 1 });

  const same = buildLine("perps", { v: 1 }, first.hash, at);
  assert.equal(same.changed, false);
  assert.equal(same.body, undefined, "unchanged polls must not duplicate the payload");
  assert.equal(same.hash, first.hash, "hash present on every line so the timeline stays joinable");

  const next = buildLine("perps", { v: 2 }, first.hash, at);
  assert.equal(next.changed, true);
  assert.deepEqual(next.body, { v: 2 });
});

test("journalPath is a gzipped UTC daily file per endpoint", () => {
  assert.equal(
    journalPath("data", "perps", new Date("2026-08-30T23:59:59Z")),
    "data/quotient/perps/2026-08-30.jsonl.gz",
  );
});

test("appended gzip members read back as plain JSONL", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-journal-"));
  const j = new Journal(dir);
  j.write("perps", { v: 1 }, new Date("2026-08-30T00:00:00Z"));
  j.write("perps", { v: 1 }, new Date("2026-08-30T00:30:00Z")); // dupe -> no body
  j.write("perps", { v: 2 }, new Date("2026-08-30T01:00:00Z"));

  const path = journalPath(dir, "perps", new Date("2026-08-30T00:00:00Z"));
  const lines = gunzipSync(readFileSync(path)).toString().trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3, "every poll is on the timeline");
  assert.deepEqual(lines[0].body, { v: 1 });
  assert.equal(lines[1].changed, false);
  assert.equal(lines[1].body, undefined);
  assert.deepEqual(lines[2].body, { v: 2 });
  rmSync(dir, { recursive: true, force: true });
});
