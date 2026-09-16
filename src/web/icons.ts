// The icon family, by the path it is served at (`tasks/20` §2.1).
//
// Three SVG cuts and three rasters, all generated from the designer's one file by
// `design/tools/mark.py` and `npm run icons`, all committed in `design/static/`. The
// SVG is what the head points at and what a modern browser uses; the ICO is what Safari
// and the older scrapers read, and `apple-touch-icon.png` is the iOS home screen.
// `icon-512.png` is the square the structured data names — a `summary` card and an
// avatar both want one.
//
// It is a table rather than six routes because the two halves drift silently otherwise:
// a `<link>` in the head naming a path the server does not serve looks exactly like a
// working favicon from here, and is a blank tab out there. `discovery.test.ts` holds the
// head to this list and this list to the files on disk.

/** Served path → content type. `src/web/server.ts` loads each at boot from
 *  `design/static` and serves it with an etag and a week's cache; a missing file stops
 *  the boot, which is right for six committed files — serving the whole page as a
 *  favicon is the failure these routes exist to have ended. */
export const ICONS: Readonly<Record<string, string>> = {
  "/favicon.svg": "image/svg+xml",
  "/favicon-light.svg": "image/svg+xml",
  "/favicon-dark.svg": "image/svg+xml",
  "/favicon.ico": "image/x-icon",
  "/apple-touch-icon.png": "image/png",
  "/icon-512.png": "image/png",
};

/** The square the structured data and the social avatars point at, absolute
 *  (`tasks/20` §2.4). */
export const ICON_512 = "/icon-512.png";
