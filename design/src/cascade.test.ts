import assert from "node:assert/strict";
import { test } from "node:test";
import { designPage } from "../../src/web/page.ts";

// No responsive rule may be dead on arrival.
//
// `design/css/*.css` is one stylesheet, concatenated in the order `mandate.html`
// declares. **A media query adds no specificity**, so a rule inside
// `@media (max-width:860px)` beats an equally specific plain rule only if it comes
// *later* in that concatenation. Put the narrowing in a file that is included before
// the file it narrows and it silently does nothing — no error, no warning, and `curl`
// cannot see it either.
//
// That is not hypothetical. Splitting the stylesheet on 2026-09-08 moved the two
// responsive blocks into `base.css`, which is the second file included, and **fifteen
// rules died at once**: the home page's three beats stayed a five-column grid on a
// 390px phone, the hero kept its desktop padding, the position card's price labels
// collided, and the trade history's Net figure right-aligned in a full-width row. The
// page still built, all 591 tests still passed, and it shipped.
// `notes/2026-09-08-responsive-rules-were-dead.md` has the measurement.
//
// This is the cheapest thing that would have caught it: no browser, no screenshots,
// just the cascade read the way the browser reads it.

/** The page's one inline stylesheet, comments stripped. */
function stylesheet(): string {
  const html = designPage();
  const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

type Rule = { order: number; maxWidth: number | null; selector: string; props: Set<string> };

/** Every style rule in source order, each tagged with the narrowest `max-width` it
 *  sits inside. `@keyframes` and `@font-face` are skipped — they declare no cascade. */
function flatten(css: string): Rule[] {
  const rules: Rule[] = [];
  let order = 0;

  const walk = (src: string, maxWidth: number | null): void => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1, k = open + 1;
      while (k < src.length && depth > 0) {
        if (src[k] === "{") depth++;
        else if (src[k] === "}") depth--;
        k++;
      }
      const body = src.slice(open + 1, k - 1);
      if (head.startsWith("@media")) {
        const m = /max-width:\s*(\d+)px/.exec(head);
        walk(body, m ? Number(m[1]) : maxWidth);
      } else if (!head.startsWith("@")) {
        const props = new Set(
          body.split(";")
            .filter((d) => d.includes(":") && !d.includes("{"))
            .map((d) => d.slice(0, d.indexOf(":")).trim()),
        );
        for (const selector of head.split(",")) rules.push({ order: order++, maxWidth, selector: selector.trim(), props });
      }
      i = k;
    }
  };

  walk(css, null);
  return rules;
}

/** Specificity, near enough. Only *equal* specificity matters here: where it differs
 *  the more specific rule wins wherever it sits, which is the case this test has
 *  nothing to say about. Comparing the two selectors' own text is exact for the pairs
 *  that reach the comparison, because they are the same selector string. */
function equallySpecific(a: string, b: string): boolean {
  return a === b;
}

test("no rule inside a max-width block is beaten by a later one", () => {
  const rules = flatten(stylesheet());
  const dead: string[] = [];

  for (const a of rules) {
    if (a.maxWidth === null) continue;
    for (const b of rules) {
      if (b.order <= a.order || b.selector !== a.selector) continue;
      if (!equallySpecific(a.selector, b.selector)) continue;
      // A *narrower* block later is the intended shape — 860 then 720 then 560, each
      // refining the last. Anything else that reaches this point wins wherever both
      // apply, which makes `a` unreachable.
      if (b.maxWidth !== null && b.maxWidth < a.maxWidth) continue;
      const shared = [...a.props].filter((p) => b.props.has(p));
      if (shared.length === 0) continue;
      dead.push(
        `${a.selector} in @media (max-width:${a.maxWidth}px) never applies: a later ` +
        `${b.maxWidth === null ? "top-level" : `@media (max-width:${b.maxWidth}px)`} rule ` +
        `sets ${shared.join(", ")}. Move it into the file that defines ${a.selector}.`,
      );
      break;
    }
  }

  assert.deepEqual(dead, [], "dead responsive rules:\n  " + dead.join("\n  "));
});

test("the scan is actually reading rules", () => {
  // A guard on the guard: a stylesheet this failed to parse would pass forever.
  const rules = flatten(stylesheet());
  assert.ok(rules.length > 300, `expected the whole stylesheet, parsed ${rules.length} rules`);
  assert.ok(rules.some((r) => r.maxWidth !== null), "expected some rules inside a max-width block");
});
