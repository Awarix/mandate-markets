#!/usr/bin/env python3
"""Bundle design/src/*.ts and inline it, with the webfonts, into design/dist/mandate.html.

The font files are deliberately NOT in this repository. Fontshare's ITF Free Font
License permits self-hosting and embedding for our own use, but forbids
redistribution — and a repo that is private today can be public tomorrow, at which
point committed font bytes would be exactly that. So the source keeps a placeholder
and this script fetches the official files on demand.

It also forbids subsetting and format conversion, so the woff2 is embedded
byte-for-byte as ITF serves it. Do not "optimise" this step.

The same fetch writes the same faces as **.ttf** into design/fonts/ (gitignored, same
licence reasoning), because the share-card renderer needs them and cannot use the
woff2 the page embeds: satori does not read woff2, and the licence forbids converting
one. Fontshare's CSS API serves .ttf beside the .woff2 for every face, so this is one
more URL out of a response we already parse rather than a conversion. A missing TTF
stops the build for the same reason a missing face does — `tasks/16` §7.

The markup is split too: design/css/*.css and design/views/*.html, pulled in at the
@INCLUDE@ lines mandate.html declares. That file is the order of both and holds only
what is not a screen — the head, the chrome, the dialogs.

The script is TypeScript under design/src/, bundled to one IIFE by esbuild and
inlined at the /*@SCRIPT@*/ placeholder. It has to end up as a single inline <script>
because src/web/server.ts hashes the page's inline blocks at startup to build the
Content-Security-Policy: an external file, or a second block, would need the policy
changed to match. Typecheck it with `npm run typecheck`.

    python3 design/build.py     # → design/dist/mandate.html
"""
import base64, pathlib, re, subprocess, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent
REPO = ROOT.parent
# One request per family, and never one combined request. Asking for both at once
# returns **only the first**: on 2026-09-02 the two-family URL this used to build
# answered with three General Sans faces and no Tabular at all, silently. Tabular is
# the face every number on the page is set in (`.num`, `.big`, `.delta`), so the next
# rebuild would have shipped a desk in ui-monospace with nothing failing. Each family
# is fetched alone and the faces we asked for are selected by name below.
#
# ⚠ **And a single-family request can still answer with a second family.** On 2026-09-13
# the VPS asked for `general-sans@400,500,600` and got five faces back: General Sans at
# 400/500/600 and **Satoshi** — an entirely different typeface — at 700 and 900. The dev
# Mac, same URL, same minute, got the three. So the response is neither what was asked
# for nor the same for every caller, and the build cannot assume either.
#
# That is why the CSS family name is written here rather than derived from the slug: the
# selection below keeps the faces whose `font-family` matches this literal and ignores
# everything else, so a leaked family is dropped instead of being embedded under our own
# name. A face we *did* ask for going missing still stops the build, which is the whole
# point of the check that was here before — what changed is that it no longer treats
# "the vendor sent something extra" and "the vendor dropped what we need" as one event.
FAMILIES = {
    "general-sans": ("General Sans", ("400", "500", "600")),
    "tabular": ("Tabular", ("400", "500", "700")),
}
CSS_API = "https://api.fontshare.com/v2/css?f%5B%5D={}@{}"
UA = {"User-Agent": "Mozilla/5.0"}
# Where the share-card renderer looks. The names are `<slug>-<weight>.ttf` and
# src/web/render.ts builds the same path from CARD_FONTS; the two lists are the same
# six faces, and this script refuses to finish if any of them is missing.
FONT_DIR = ROOT / "fonts"


def fetch(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA)).read()


# Two comment syntaxes, one mechanism. The file being included decides which is legal
# where it lands: `/*@INCLUDE css/base.css@*/` sits inside the <style> block and
# `<!--@INCLUDE views/desk.html@-->` sits in the body. Expansion is one pass and not
# recursive — a partial that includes another would ship the marker as text, which is
# visible immediately, and the flat list is the point.
INCLUDE = re.compile(
    r"^[ \t]*(?:/\*@INCLUDE ([A-Za-z0-9_./-]+)@\*/|<!--@INCLUDE ([A-Za-z0-9_./-]+)@-->)[ \t]*\n",
    re.M,
)


# Where a partial may live, and what it is called. A directory not on this list is not
# reachable from `mandate.html`, which is what keeps the orphan check below honest.
PARTIALS = (("css", "*.css"), ("views", "*.html"))


def expand_includes(html: str) -> str:
    """Replace each `@INCLUDE path@` line with that file, in the order written.

    The stylesheet is `design/css/*.css` and the screens are `design/views/*.html`, one
    file per concern, and `mandate.html` declares the order of both — so the cascade is
    a list you can read rather than a property of where somebody happened to paste a
    rule, and the document is a table of contents rather than 850 lines to scroll. It
    still ends up as exactly one inline <style> and one inline <script>, which is what
    `src/web/server.ts` hashes for the CSP.

    What stays in `mandate.html` is what is not a screen: the head a scraper reads, the
    two chrome headers, and the two dialogs any view can open.

    A partial may not contain a `<style`/`<script` open tag, in any form including a
    comment. `loadPage` finds the blocks it hashes with a regex over the raw HTML and
    cannot tell a comment from markup, so one in prose silently swallows the real block
    and ships a policy over the wrong bytes — it happened on 2026-09-05 and `curl`
    cannot see it. Nothing checked before this; now the build refuses. The rule binds
    harder on a view than it ever did on a stylesheet, because markup is where somebody
    would reach for one of those tags on purpose.
    """
    def one(m: "re.Match[str]") -> str:
        name = m.group(1) or m.group(2)
        path = ROOT / name
        if not path.is_file():
            raise SystemExit(f"mandate.html includes {name}, which does not exist")
        text = path.read_text()
        for tag in ("<style", "<script"):
            if tag in text.lower():
                raise SystemExit(f"{name} contains a literal {tag} — see expand_includes()")
        return text

    out, count = INCLUDE.subn(one, html)
    if count == 0:
        raise SystemExit("mandate.html has no @INCLUDE@ lines — the page would be empty")
    # Every partial on disk has to be reachable, or a file can be edited for weeks
    # while the page serves something else entirely.
    named = {a or b for a, b in INCLUDE.findall(html)}
    on_disk = {f"{d}/{p.name}" for d, glob in PARTIALS for p in (ROOT / d).glob(glob)}
    if orphans := on_disk - named:
        raise SystemExit(f"not included by mandate.html: {', '.join(sorted(orphans))}")
    print(f"  inlined {count} partials")
    return out


def bundle() -> str:
    """design/src/main.ts and everything it imports, as one IIFE.

    esbuild is already in the tree as a dependency of tsx, and is named in
    devDependencies so that stays true. It strips the types and bundles; it does not
    typecheck — `npm run typecheck` does that, and the build does not depend on it
    having been run."""
    out = subprocess.run(
        [str(REPO / "node_modules" / ".bin" / "esbuild"),
         str(ROOT / "src" / "main.ts"),
         "--bundle", "--format=iife", "--target=es2022", "--charset=utf8"],
        capture_output=True, check=True,
    )
    js = out.stdout.decode()
    # A literal </script> anywhere in the bundle would close the tag early. Nothing in
    # our source has one, and this is here so that stays a fact rather than a habit.
    if "</script" in js.lower():
        raise SystemExit("bundle contains </script — it cannot be inlined")
    print(f"  bundled {len(js):,} bytes of JS")
    return js


def main() -> None:
    faces = []
    FONT_DIR.mkdir(exist_ok=True)
    ttfs = []
    for slug, (family, weights) in FAMILIES.items():
        css = fetch(CSS_API.format(slug, ",".join(weights))).decode()
        blocks = re.findall(r"@font-face\s*\{(.*?)\}", css, re.S)
        # Keep the faces we asked for, by name, weight and style; ignore whatever else
        # the response carries. `font-style` is in the match because the block we emit
        # below hardcodes `normal` — without it an italic face would be embedded under a
        # roman name, which is the same class of silent wrong answer as the leaked family.
        wanted = {}
        for block in blocks:
            name = re.search(r"font-family:\s*'([^']+)'", block)
            weight = re.search(r"font-weight:\s*(\d+)", block)
            style = re.search(r"font-style:\s*(\w+)", block)
            if not (name and weight and style):
                continue
            if name.group(1) != family or style.group(1) != "normal":
                continue
            if weight.group(1) in weights:
                wanted[weight.group(1)] = block
        # A face we asked for going missing still stops the build, rather than producing
        # a page that renders in a fallback. That is the 2026-09-02 guard, unchanged in
        # meaning: it just no longer counts the faces we did not ask for.
        missing = [w for w in weights if w not in wanted]
        if missing:
            # Name what it *did* send. The whole cost of the 2026-09-13 outage was that
            # the refusal said "asked for 3, got 5" and nobody could see that two of the
            # five were a different typeface without going and running curl.
            got = []
            for b in blocks:
                n = re.search(r"font-family:\s*'([^']+)'", b)
                w = re.search(r"font-weight:\s*(\d+)", b)
                if n and w:
                    got.append(f"{n.group(1)} {w.group(1)}")
            raise SystemExit(
                f"{family}: Fontshare did not serve weight(s) {', '.join(missing)}. "
                f"It answered with: {', '.join(sorted(set(got))) or '(nothing)'}. "
                "Refusing to build a page missing a face."
            )
        for weight_str in weights:
            block = wanted[weight_str]
            weight = weight_str
            woff2 = "https:" + re.search(r"url\('(//[^']+\.woff2)'\)", block).group(1)
            b64 = base64.b64encode(fetch(woff2)).decode()
            faces.append(
                f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weight};'
                f'font-display:swap;src:url(data:font/woff2;base64,{b64}) format("woff2");}}'
            )
            # The same face as TTF, for the card renderer. The URL differs from the
            # woff2 only in its extension, and the API has served all three formats
            # for every face since this was checked (2026-09-03, re-checked 2026-09-05)
            # — but assert rather than assume, because a silent miss here ships a page
            # that is fine and a card route that 503s.
            ttf_match = re.search(r"url\('(//[^']+\.ttf)'\)", block)
            if not ttf_match:
                raise SystemExit(
                    f"{family} {weight}: Fontshare served no .ttf. The share-card renderer "
                    "cannot read the woff2 and the licence forbids converting it "
                    "(tasks/16 §4). Refusing to build."
                )
            out = FONT_DIR / f"{slug}-{weight}.ttf"
            out.write_bytes(fetch("https:" + ttf_match.group(1)))
            ttfs.append(out)
            print(f"  {family} {weight}  (+ {out.name}, {out.stat().st_size:,} bytes)")

    # Six faces in, six files out. A card drawn in a face we did not fetch would be a
    # licence question as well as an ugly picture.
    expected = sum(len(weights) for _, weights in FAMILIES.values())
    if len(ttfs) != expected:
        raise SystemExit(f"wrote {len(ttfs)} TTFs, expected {expected}. Refusing to build.")

    header = ("/* General Sans + Tabular, Indian Type Foundry, ITF Free Font License v2.0.\n"
              "   Official woff2 embedded unmodified — the licence forbids subsetting and\n"
              "   format conversion. Regenerate with design/build.py, never by hand. */\n")
    html = expand_includes((ROOT / "mandate.html").read_text())
    html = html.replace("/*@FONTFACES@*/", header + "\n".join(faces))
    html = html.replace("/*@SCRIPT@*/", bundle())
    out = ROOT / "dist" / "mandate.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
