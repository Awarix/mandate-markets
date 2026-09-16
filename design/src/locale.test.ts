import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Every figure and every date on this page is formatted in en-US.
//
// `money()` and `num()` have always pinned it; the four date helpers followed the
// reader instead, which put `2 мар. 2027 г., 18:41` next to `$117.25` on the same
// screen of a Russian browser — one page, two locales, and a long localised form
// breaking a column set in a tabular face. Decided 2026-09-08 (`tasks/26` §6.6): the
// locale is ours, the timezone stays the reader's.
//
// This is the cheapest thing that keeps it that way. `toLocaleString(undefined, …)`
// is what the default looks like, and it is one character away from being written
// again by anyone adding a date.

const HERE = dirname(fileURLToPath(import.meta.url));

function sources(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(HERE, f));
}

/** `toLocaleString(` / `toLocaleDateString(` … with no locale, or an explicit
 *  `undefined` — both of which mean "whatever the browser is set to". */
const UNPINNED = /\.toLocale(?:Date|Time)?String\(\s*(?:\)|undefined\b)/;

test("no date or number is formatted in the reader's own locale", () => {
  const offenders: string[] = [];
  for (const file of sources()) {
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (UNPINNED.test(line)) offenders.push(`${file.slice(HERE.length + 1)}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "these format in the browser's locale — pass DATE_LOCALE (dom.ts) or \"en-US\":\n  " + offenders.join("\n  "),
  );
});

test("the scan is actually finding call sites", () => {
  // A guard on the guard: a regex that matched nothing would pass forever.
  const pinned = sources().reduce(
    (n, f) => n + [...readFileSync(f, "utf8").matchAll(/\.toLocale(?:Date|Time)?String\(/g)].length,
    0,
  );
  assert.ok(pinned >= 6, `expected the page's formatting calls to be found, saw ${pinned}`);
  assert.ok(UNPINNED.test('d.toLocaleString(undefined, { year: "numeric" })'), "the pattern must match the default form");
  assert.ok(UNPINNED.test("d.toLocaleString()"), "the pattern must match the bare form");
  assert.ok(!UNPINNED.test('d.toLocaleString(DATE_LOCALE, {})'), "the pattern must not match a pinned locale");
});
