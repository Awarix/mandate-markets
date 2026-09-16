# Design

`mandate.html` — the document. `views/*.html` — one screen each. `css/*.css` — one
concern each. `src/*.ts` — the behaviour. The build puts them back together as one
self-contained file: no framework, no runtime dependencies, one inline `<script>` and
one inline `<style>`.

```sh
python3 design/build.py     # → design/dist/mandate.html   (npm run build:web)
npm run typecheck           # checks src/ and design/src/ both
```

## What is in which file

`mandate.html` holds everything that is **not a screen** — the head a scraper reads,
the two chrome headers, the two dialogs any view can open — and a list of
`@INCLUDE@` lines declaring the order of everything else. Two comment syntaxes, one
mechanism: `/*@INCLUDE css/base.css@*/` inside the `<style>` block, and
`<!--@INCLUDE views/desk.html@-->` in the body.

That makes the cascade and the document order lists you can read, rather than
properties of where somebody happened to paste something. Expansion is one pass and
not recursive; a partial that included another would ship the marker as visible text.

Two things the build refuses, both of which have fired on a real mistake:

- **a partial containing a literal script or style open tag, in any form including a
  comment** — see below for why, and note the rule binds harder on a view than on a
  stylesheet, because markup is where somebody would reach for one of those on purpose;
- **a file in `css/` or `views/` that no `@INCLUDE@` line names**, so a partial cannot
  be edited for weeks while the page serves something else.

Five tests read this markup — `discovery.test.ts`, `cards.test.ts`, `ids.test.ts`,
`design/src/cascade.test.ts` and `design/src/limits.test.ts` —
and they go through `designPage()` in `src/web/page.ts`, which expands the includes the
way the build does. Reading `mandate.html` alone would now find no slider, no quotable
paragraph and no desk id at all, and would pass while checking nothing.

## Why the script is TypeScript, and still ends up inline

It was 740 lines of untyped JavaScript inside the HTML, driving connect, settings and
unlink — the least-checked code in the repository in front of the most consequential
flows. It is now modules under `src/`, typechecked with the rest of the project and
bundled by esbuild, which is already in the tree as a dependency of `tsx`.

**It must remain exactly one inline `<script>` and one inline `<style>`.**
`src/web/server.ts` hashes the page's inline blocks at startup to build the
Content-Security-Policy; an external file, or a second block of either kind, needs
that policy changed to match or it is silently refused. `build.py` inlines the bundle
at a `/*@SCRIPT@*/` placeholder for that reason, and refuses to build if the bundle
contains a literal `</script`. The one exception is the `application/ld+json` block
in the head: it is structured data the browser never runs, CSP does not govern it, and
`loadPage` leaves it out of the hash list on purpose.

**And never write a script or style open tag in the prose of `mandate.html` or of any
partial it includes — a comment counts.** The build refuses one now, which it did not
when this bit. `loadPage` finds the blocks with a regex over the raw HTML and cannot tell a
comment from markup, so one in a comment opens a match that closes on the next real
`</style>` and hashes the wrong bytes. It happened on 2026-09-05: the shipped
`style-src` hash covered 2,302 extra bytes of head, which would have made the browser
refuse the whole stylesheet. `curl` cannot see it — the header looks plausible — so
check it in a browser (`getComputedStyle(document.body).backgroundColor`) or by
recomputing the hashes from `dist/mandate.html`.
`notes/2026-09-05-share-cards.md` §2 has the measurement.

The head also carries `<!--@SOCIAL@-->` … `<!--@/SOCIAL@-->` around its OpenGraph and
Twitter tags. `src/web/server.ts` replaces **only** what is between them when it serves
a share landing path (`/s/trade`, `/s/account`), so the tile points at that card while
both hashed blocks are untouched. The default between them is byte-for-byte what
`socialTags()` in `src/web/cards.ts` emits for the product card, and `cards.test.ts`
fails if the two drift.

`static/` holds the files served *beside* the page: the designer's mark (`logo#2.svg`,
`tasks/20`) and the six files generated from it — three favicon cuts, an ICO, the
apple-touch icon and the 512 PNG. `src/web/icons.ts` is the list of paths they are served
at and `discovery.test.ts` holds the head, that list and this directory to each other.
**Edit `logo#2.svg`, then `python3 tools/mark.py && npm run icons && npm run build:web`** —
never a derivative by hand.

The API payload types in `src/api.ts` are a second declaration of shapes the server
owns (`DeskPayload`, `ConnectStatus`, `ConnectBalance`). Nothing checks the two
against each other. **If a field moves on the server, move it there too.**

## Why the fonts are fetched at build time

**The webfonts must not be committed.**
Fontshare's ITF licence permits self-hosting and embedding for our own use but
forbids redistribution, and a private repo can become public. It also forbids
subsetting and format conversion, so `build.py` embeds the official woff2
byte-for-byte. Do not replace it with a bundler's font plugin — they subset by
default, which would be a breach.

The same fetch writes the same six faces as `.ttf` into `fonts/` (gitignored, same
reasoning). That is the share-card renderer's copy: satori cannot read woff2 and the
licence forbids converting one, so the TTF comes from Fontshare's own CSS response,
which serves all three formats per face. A face with no `.ttf` stops the build, the way
a missing face does. Without `fonts/`, `src/web/render.ts` throws at boot, the web tier
logs it once and the image routes answer 503 — a pasted link then renders the way it
did before `tasks/16`, and nothing else is affected.

The direction, and the three versions rejected before it:
`notes/2026-08-30-ui-direction.md`. The name and domain:
`notes/2026-08-30-brand-and-domain.md`.

**No longer only a design.** `design/dist/mandate.html` is what mandate.markets
actually serves: `src/web/server.ts` reads it at startup, hashes its inline `<script>`
and `<style>` for the Content-Security-Policy, and the page drives a real HTTP API —
wallet sign-in, the connect handshake, the desk, and unlink. Editing this file changes
the live product, so rebuild (`python3 design/build.py`) and redeploy after any change.

Three things that have bitten. The server caches the page at startup, so a rebuild
without a restart serves the old bytes. A CSP that hashes `<style>` does **not** cover
`style="…"` attributes, which silently deleted all of them until `style-src-attr` was
added (91 then, 147 as of 2026-09-12). And on 2026-09-02 Fontshare began answering a two-family
request with only the first family, so the build quietly stopped embedding Tabular —
the face every number on the page is set in — while still succeeding; each family is
now fetched alone and the face count is asserted.
