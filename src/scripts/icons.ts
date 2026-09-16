// The rasters derived from the brand mark (`tasks/20` §2.1, §2.4):
//
//   npm run icons
//
// `design/tools/mark.py` writes the three SVG cuts; this writes the three files a
// browser or a scraper will not take as SVG, and it runs after it. All four outputs are
// committed, like the SVGs and unlike the fonts: the mark is ours, a PNG of it is four
// kilobytes, and a file in the repository is one the deploy rsync already carries.
//
// **Every raster is a tile: the dark ground with the light ink, edge to edge.** A raster
// cannot follow a theme — that is the whole reason `favicon.svg` exists and is still what
// the head points at — so the one thing it must not do is depend on the ground it lands
// on. An iOS home screen composites a transparent icon onto black, a tab strip onto
// whatever the browser is wearing, and a transparent mark in one ink is invisible on one
// of them. Apple asks for a full square with no transparency and applies its own mask, so
// the tile is what that slot wants anyway.
//
// The ground and the ink are `CARD_COLORS`, which is the same restatement of the page's
// dark tokens the share cards draw on, for the same reason: a rasteriser runs no cascade.

import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { CARD_COLORS } from "../web/cards.ts";

const STATIC = "design/static";

/** How much of the tile the mark takes. The SVG favicon runs the mark edge to edge —
 *  correct for a bare glyph with no ground — but a mark touching the sides of its own
 *  tile reads as a crop, and the iOS mask rounds the corners off whatever is there. */
const INSET = 0.16;

/** 16 and 32 in the ICO. 16 is what a 1× tab strip draws and the mark is a smudge at
 *  that size (`tasks/20` §4.3, measured); it is in here anyway, because a browser that
 *  asks for 16 and is handed only 32 downsamples to the same smudge. */
const ICO_SIZES = [16, 32];

type Out = { path: string; size: number };

const RASTERS: Out[] = [
  { path: `${STATIC}/apple-touch-icon.png`, size: 180 },
  { path: `${STATIC}/icon-512.png`, size: 512 },
];

/** The mark as a square tile at `size` px: the ground, then the mark inset and centred.
 *
 *  The mark arrives as a nested `<svg>` with its own viewBox, which is what does the
 *  scaling and the centring — `preserveAspectRatio` defaults to `xMidYMid meet`, so a
 *  404 × 426 drawing centres itself in the square without arithmetic here. `currentColor`
 *  is replaced rather than inherited: resvg resolves it against a `color` property we
 *  would have to set on every path anyway. */
function tile(size: number): Buffer {
  const cut = readFileSync(`${STATIC}/favicon-dark.svg`, "utf8");
  const inner = cut
    .replace(/^<svg[^>]*>/, "")
    .replace(/<style>[\s\S]*?<\/style>/, "")
    .replace(/<\/svg>\s*$/, "")
    .replace(/currentColor/g, CARD_COLORS.ink);
  const viewBox = /viewBox="([^"]+)"/.exec(cut)?.[1];
  if (!viewBox) throw new Error(`no viewBox in ${STATIC}/favicon-dark.svg — run design/tools/mark.py`);

  const pad = Math.round(size * INSET);
  const inside = size - pad * 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`
    + `<rect width="${size}" height="${size}" fill="${CARD_COLORS.ground}"/>`
    + `<svg x="${pad}" y="${pad}" width="${inside}" height="${inside}" viewBox="${viewBox}">${inner}</svg>`
    + `</svg>`;
  return Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng());
}

/** An ICO carrying PNG payloads rather than BMP ones.
 *
 *  Legal since Vista and read by every browser that reads an ICO at all; the alternative
 *  is a 32-bit BMP with an AND mask, which is forty lines of bit-twiddling for a format
 *  nothing we serve to would prefer. A 6-byte header, then one 16-byte directory entry
 *  per image, then the payloads — and 0 in the size byte means 256, which is why the
 *  sizes here stay under it. */
function ico(images: Buffer[], sizes: number[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const dir = images.map((png, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(sizes[i]! % 256, 0);
    e.writeUInt8(sizes[i]! % 256, 1);
    e.writeUInt8(0, 2); // palette entries: none, it is truecolour
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...dir, ...images]);
}

function main(): void {
  for (const { path, size } of RASTERS) {
    const png = tile(size);
    writeFileSync(path, png);
    console.log(`  ${path}  ${size}x${size}  ${png.length} bytes`);
  }
  const icoPath = `${STATIC}/favicon.ico`;
  const bytes = ico(ICO_SIZES.map(tile), ICO_SIZES);
  writeFileSync(icoPath, bytes);
  console.log(`  ${icoPath}  ${ICO_SIZES.join("+")}  ${bytes.length} bytes`);
}

main();
