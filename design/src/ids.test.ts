import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// The one import in design/src that reaches into src/. It is safe because this is a
// test: esbuild bundles design/src/main.ts and its import graph, and no *.test.ts is
// in it. Do not copy this line into a module the page actually ships.
import { designPage } from "../../src/web/page.ts";

// Every `$("...")` must name an element the page actually ships.
//
// `$()` in dom.ts casts rather than asserting — `document.getElementById(id) as T` — so
// a stale id is `null` at runtime and the next property write is a TypeError. That is
// not a caught error anywhere: `resetSignals()` runs *before* the fetch in `loadDesk`,
// so one dead id took the entire desk down and left a signed-in account looking at the
// demo numbers. It shipped, because nothing checks markup against code.
//
// This is the cheapest thing that would have caught it: no DOM, no browser, just the
// two files agreeing about what exists.

const HERE = dirname(fileURLToPath(import.meta.url));
// The page with its view partials inlined. Reading mandate.html alone would report
// every id on the desk, the connect flow and the leaderboard as missing, because since
// the split that file declares them rather than containing them.
const HTML = designPage();

const ID_ATTR = /\bid="([^"]+)"/g;

/** Ids that exist at runtime: the ones in the shipped markup, plus the ones the code
 *  writes into it. `#rgo`, `#rretry` and `#dhistrows` are rendered by innerHTML and are
 *  no less real for it. */
function declaredIds(sourceFiles: string[]): Set<string> {
  const ids = new Set([...HTML.matchAll(ID_ATTR)].map((m) => m[1]!));
  for (const f of sourceFiles) {
    for (const m of readFileSync(f, "utf8").matchAll(ID_ATTR)) ids.add(m[1]!);
  }
  return ids;
}

/** `$("x")` and `$<HTMLButtonElement>("x")`, literal arguments only. Ids built from a
 *  template (`$(`v-${n}`)` in views.ts) are deliberately not matched — they cannot be
 *  resolved without running the code, and the ones that exist are covered by the
 *  view-switching the whole page depends on. The lookbehind keeps `$$(".sel")` — the
 *  querySelectorAll helper, which takes CSS and not an id — out of the match. */
const CALL = /(?<!\$)\$(?:<[^>]*>)?\(\s*"([^"]+)"\s*\)/g;

function sources(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(HERE, f));
}

test("the page declares every id the code reaches for", () => {
  const files = sources();
  const declared = declaredIds(files);
  const missing: string[] = [];
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(CALL)) {
      const id = m[1]!;
      if (!declared.has(id)) missing.push(`${file.slice(HERE.length + 1)} → $("${id}")`);
    }
  }
  assert.deepEqual(missing, [], "these ids are in no partial the page includes, so $() returns null:\n  " + missing.join("\n  "));
});

test("the scan is actually finding call sites", () => {
  // A guard on the guard: a regex that silently matched nothing would make the test
  // above pass forever.
  const total = sources().reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(CALL)].length, 0);
  assert.ok(total > 50, `expected the page's id lookups to be found, saw ${total}`);
  assert.ok(declaredIds(sources()).size > 50, "expected the page to declare many ids");
});
