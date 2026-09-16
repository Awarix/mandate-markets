import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import satori from "satori";
import { CARD_COLORS as C, CARD_H, CARD_W, type CardModel } from "./cards.ts";

// The pixels (`tasks/16` §4). Everything a card *decides* is in `cards.ts`; this file
// only draws, and nothing here is unit-tested — asserting on a PNG is asserting on a
// rasteriser's version. When the designer's card design lands (`tasks/20`,
// `tasks/16` §6.4) it replaces `tree()` below and nothing else.
//
// Two dependencies where the web tier had three on purpose, and the cost is named:
// `satori` lays a JSX-shaped tree out with Yoga and emits SVG, `@resvg/resvg-js`
// rasterises it. The alternatives were a browser on the trading box or drawing by hand
// into a PNG encoder.
//
// ── Three rules inherited from Eater, each of which cost a deploy there ─────
//
//   1. **No 8-digit hex.** Write `rgba()`. `#RRGGBBAA` is not read, and it fails by
//      drawing an opaque colour rather than by erroring.
//   2. **`inset: 0` does not resolve.** Write all four sides.
//   3. **Whitespace between sibling spans collapses.** A row of items is a flex row
//      with a `gap`, never two spans with a space between them.
//
// ── And one found here ─────────────────────────────────────────────────────
//
//   4. **No `σ` and no `→`.** Measured 2026-09-05: neither General Sans nor Tabular
//      has a glyph for either, and satori has no system fallback — it draws .notdef
//      and nothing fails. `cards.ts` spells the displacement "sigma" for that reason.

/** The faces `design/build.py` fetches into `design/fonts/`, and the weights this
 *  renderer registers. The build asserts the same list, so a face going missing stops
 *  the build rather than shipping a card in a fallback the licence does not cover. */
export const CARD_FONTS = [
  { family: "General Sans", slug: "general-sans", weight: 400 },
  { family: "General Sans", slug: "general-sans", weight: 500 },
  { family: "General Sans", slug: "general-sans", weight: 600 },
  { family: "Tabular", slug: "tabular", weight: 400 },
  { family: "Tabular", slug: "tabular", weight: 500 },
  { family: "Tabular", slug: "tabular", weight: 700 },
] as const;

export type LoadedFont = { name: string; data: Buffer; weight: 400 | 500 | 600 | 700; style: "normal" };

/** Load the TTFs. **Not committed**, for the same reason the woff2 is not: Fontshare's
 *  ITF licence permits self-hosting and embedding for our own use and forbids
 *  redistribution, and a private repo can become public. `design/build.py` fetches
 *  them byte-for-byte beside the page's woff2 — satori cannot read woff2, and the same
 *  licence forbids converting one.
 *
 *  Throws with the command to run. The caller turns that into a boot warning and a
 *  503 on the image routes rather than a dead process: a missing card is a link that
 *  renders the way it did before `tasks/16`, and that is not worth refusing to serve
 *  the desk over. */
export function loadCardFonts(dir = "design/fonts"): LoadedFont[] {
  return CARD_FONTS.map((f) => {
    const path = `${dir}/${f.slug}-${f.weight}.ttf`;
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      throw new Error(
        `share cards need ${path}, which is fetched rather than committed. Run \`npm run build:web\`.`,
      );
    }
    return { name: f.family, data, weight: f.weight as LoadedFont["weight"], style: "normal" as const };
  });
}

// ── The mark ───────────────────────────────────────────────────────────────

/** The designer's mark as a data URI, ready for an `<img>` (`tasks/20` §2.3).
 *
 *  Read from the designer's own file rather than restated here, so the card and the page
 *  draw the same 2 kB of path data and `design/tools/mark.py` stays the one place it
 *  lives. Two things have to change on the way in:
 *
 *  - **`currentColor` is baked to the card's ink.** An `<img>` is its own document and
 *    inherits no colour from the tree around it; resvg resolves `currentColor` against a
 *    `color` nothing sets and draws black on a black ground.
 *  - **It rides as a data URI, not a path.** satori fetches a remote `src` over the
 *    network, and a card must not depend on our own web tier being up to draw our own
 *    logo.
 *
 *  Null if the file is missing, and then the head draws the wordmark alone — the same
 *  posture as the fonts and the secret: a card that is missing something renders without
 *  it rather than refusing to render. */
function loadMark(height: number): { src: string; width: number; height: number } | null {
  try {
    const svg = readFileSync("design/static/logo#2.svg", "utf8").replace(/currentColor/g, C.ink);
    // The width comes off the file's own viewBox rather than a constant: satori lays an
    // `<img>` out from the attributes and not from the image, so a pair that disagrees
    // with the drawing stretches it silently. A redrawn mark changes its own aspect.
    const box = /viewBox="([-\d. ]+)"/.exec(svg)?.[1]?.trim().split(/\s+/).map(Number);
    if (!box || box.length !== 4 || !box[2] || !box[3]) return null;
    return {
      src: "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"),
      width: Math.round((height * box[2]) / box[3]),
      height,
    };
  } catch {
    return null;
  }
}

/** A little taller than the 24px wordmark beside it, for the reason `design/css/base.css`
 *  gives at more length: the glyph is airy where the type is solid, so parity reads as
 *  smaller. The page runs the same ratio at 1.35em. */
const MARK = loadMark(32);

// ── The tree ───────────────────────────────────────────────────────────────

type El = { type: string; props: { style?: Record<string, unknown>; children?: unknown } };

const div = (style: Record<string, unknown>, children?: unknown): El =>
  ({ type: "div", props: { style: { display: "flex", ...style }, children } });

const text = (style: Record<string, unknown>, s: string): El =>
  ({ type: "div", props: { style: { display: "flex", ...style }, children: s } });

const TONE = { up: C.up, down: C.down, flat: C.ink } as const;

/** One label-and-figure pair, sized to its own content.
 *
 *  It was a fixed 248px column until a timestamp needed 290 and wrapped, which pushed
 *  the footer off the bottom of the card — a rasteriser does not clip, it just draws
 *  past the edge and nothing complains. Natural widths with a wide gap fit every set
 *  we draw (four short ones on the product card, three on a position) and cannot wrap
 *  a value that fits at all. `flexShrink: 0` is what keeps that true. */
function fact(f: { label: string; value: string }): El {
  return div({ flexDirection: "column", gap: 4, flexShrink: 0 }, [
    text({ fontSize: 19, color: C.dim, letterSpacing: "0.03em" }, f.label),
    text({ fontSize: 28, color: C.ink, fontFamily: "Tabular", fontWeight: 500 }, f.value),
  ]);
}

/** The card, redrawn 2026-09-05 against Quotient's own after the owner found ours
 *  crowded — "too overwhelmed, especially when dollar P/L is on".
 *
 *  What changed and why, because it is all reversible and the reasons are not obvious
 *  from the tree:
 *
 *  - **A rectangular frame, not horizontal dividers.** Two rules across the card cut it
 *    into three unrelated bands; one border makes it a single object, which is what a
 *    picture in a feed has to be.
 *  - **The accent rail is drawn into the image.** It was CSS on the dialog's preview
 *    only, so the thing being previewed never had it — the card travels without the
 *    page, and anything the page adds is a thing the card does not have.
 *  - **The market is the title, in the accent colour.** It is the one word a reader
 *    recognises at a glance and it was set as small grey furniture.
 *  - **The percentage leads and the dollars sit under it in parentheses.** Comparable
 *    figure first; and the dollars are the half that can be switched off, so the layout
 *    must not depend on them being there.
 */
function tree(m: CardModel): El {
  // The lockup, top right: the mark beside the wordmark, which is the page's own header
  // (`tasks/20` §2.3). The card used to sign itself in type alone, and a picture in a
  // feed is the one surface where a reader recognises a shape before they read a word.
  // The mark is a little taller than the wordmark's em box for the reason `base.css`
  // gives: it is airy where the type is solid, so parity reads as smaller.
  const lockup = div({ alignItems: "center", gap: 11 }, [
    ...(MARK ? [{ type: "img", props: { ...MARK } } as El] : []),
    text({ fontSize: 24, color: C.ink, fontWeight: 600, letterSpacing: "-0.01em" }, "Mandate"),
  ]);
  const head = div({ justifyContent: "space-between", alignItems: "center" }, [
    text({ fontSize: 24, color: C.ink2, fontWeight: 500 }, m.eyebrow),
    lockup,
  ]);

  // The Quotient citation. Its own line, in the one colour that is neither a result nor
  // furniture, because `tasks/12` makes it an obligation and a card in a feed is the
  // most public surface we have. It sits **with the content** rather than above the
  // footer: pushed to the bottom by `space-between` it read as small print beside the
  // domain, which is the opposite of what an obligation to name someone should look
  // like.
  const credit = text({ fontSize: 22, lineHeight: 1.35, color: C.accent, maxWidth: 980, paddingTop: 4 }, m.credit);

  // The product card has no result, so its sentence takes the space the numbers would.
  const body = m.figure === ""
    ? div({ flexDirection: "column", gap: 32 }, [
      text({ fontSize: 44, lineHeight: 1.22, color: C.ink, fontWeight: 600, maxWidth: 980 }, m.headline),
      div({ columnGap: 52, rowGap: 22, flexWrap: "wrap" }, m.facts.map(fact)),
      credit,
    ])
    : div({ flexDirection: "column", gap: 18 }, [
      text({ fontSize: 34, lineHeight: 1.1, color: C.accent, fontWeight: 600, letterSpacing: "-0.01em" }, m.title),
      div({ flexDirection: "column", gap: 2 }, [
        text({ fontSize: 104, lineHeight: 1.05, color: TONE[m.tone], fontFamily: "Tabular", fontWeight: 700 }, m.figure),
        ...(m.subfigure
          ? [text({ fontSize: 38, lineHeight: 1.2, color: TONE[m.tone], fontFamily: "Tabular", fontWeight: 500 }, m.subfigure)]
          : []),
      ]),
      div({ flexDirection: "column", gap: 6, paddingTop: 6 },
        m.detail.map((d) => text({ fontSize: 24, lineHeight: 1.3, color: C.ink2, maxWidth: 980 }, d))),
      credit,
    ]);

  // The domain bottom-left is the mark: a card travels without its URL, so the one
  // place a reader can find us has to be drawn into the picture. The logo lockup
  // replaces this the day `tasks/20` lands.
  const foot = div({ justifyContent: "space-between", alignItems: "flex-end" }, [
    text({ fontSize: 22, color: C.ink2, fontWeight: 500 }, "mandate.markets"),
    text({ fontSize: 18, color: C.dim }, m.disclaimer),
  ]);

  const frame = div({
    flexDirection: "column", justifyContent: "space-between", flexGrow: 1,
    border: `1px solid ${C.rule}`, borderRadius: 8, padding: "34px 40px 32px",
  }, [head, body, foot]);

  return div({
    width: CARD_W, height: CARD_H, backgroundColor: C.ground, color: C.ink,
    fontFamily: "General Sans",
  }, [
    // The rail, drawn rather than styled onto the preview. `inset` is not resolved by
    // satori, so this is a sized element in the row rather than an absolute one.
    div({ width: 10, height: CARD_H, backgroundColor: C.accent, flexShrink: 0 }, []),
    div({ flexGrow: 1, flexDirection: "column", padding: "26px 30px" }, [frame]),
  ]);
}

// ── Rendering, and the cache in front of it ────────────────────────────────

export class CardRenderer {
  private readonly fonts: LoadedFont[];
  /** Keyed by the request path plus its canonical query. A card is one image fetched
   *  once by a scraper that keeps it for days, so this is a small map with a hard cap
   *  rather than anything cleverer; the oldest entry goes when it is full. Insertion
   *  order is `Map`'s own guarantee, so no bookkeeping is needed for that. */
  private readonly cache = new Map<string, Buffer>();
  private readonly cap: number;

  constructor(fonts: LoadedFont[], cap = 256) {
    this.fonts = fonts;
    this.cap = cap;
  }

  async png(key: string, m: CardModel): Promise<Buffer> {
    const hit = this.cache.get(key);
    if (hit) return hit;
    const svg = await satori(tree(m) as never, { width: CARD_W, height: CARD_H, fonts: this.fonts });
    const png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: CARD_W } }).render().asPng());
    if (this.cache.size >= this.cap) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, png);
    return png;
  }
}
