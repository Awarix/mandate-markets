// The page as `design/build.py` assembles it, for the tests that read markup.
//
// `design/mandate.html` used to be the whole document. Since the views were split it is
// the table of contents — the head, the two chrome headers, the dialogs, and a list of
// `@INCLUDE@` lines naming `design/css/*.css` and `design/views/*.html`. Three tests
// assert things about markup that now lives in a partial, and reading the index file
// alone would silently stop checking them: `discovery.test.ts` would find no slider and
// no quotable paragraph, and `ids.test.ts` would report every id on the desk as missing.
//
// This expands the includes the way the build does. It deliberately does *not* do the
// build's other two substitutions — the fonts are 330KB of base64 fetched over the
// network and the bundle needs esbuild, and no test asks about either.
//
// It is not a second source of truth for which partials ship: the list comes out of
// `mandate.html`, so a file the page stopped including disappears from here too. The
// build refuses a partial on disk that nothing includes, which is the other half.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DESIGN = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "design");

/** Both comment syntaxes, matching `INCLUDE` in design/build.py. */
const INCLUDE = /^[ \t]*(?:\/\*@INCLUDE ([\w./-]+)@\*\/|<!--@INCLUDE ([\w./-]+)@-->)[ \t]*\n/gm;

let cached: string | null = null;

/** `design/mandate.html` with every partial inlined, in the order it declares them. */
export function designPage(): string {
  if (cached !== null) return cached;
  const index = readFileSync(join(DESIGN, "mandate.html"), "utf8");
  let count = 0;
  const out = index.replace(INCLUDE, (_m, css?: string, html?: string) => {
    count++;
    return readFileSync(join(DESIGN, (css ?? html)!), "utf8");
  });
  // A guard on the guard. If the marker syntax ever changes and this matched nothing,
  // every assertion below it would go on passing against the index file alone.
  if (count === 0) throw new Error("design/mandate.html has no @INCLUDE@ lines");
  cached = out;
  return out;
}
