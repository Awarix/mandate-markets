import { $$ } from "./dom.ts";

/** Three states, cycled: system (no attribute) → dark → light → system. */
export function cycleTheme(): void {
  const r = document.documentElement;
  const t = r.getAttribute("data-theme");
  if (!t) r.setAttribute("data-theme", "dark");
  else if (t === "dark") r.setAttribute("data-theme", "light");
  else r.removeAttribute("data-theme");
  paintTheme();
}

/** Which of the three it is on, on the two menu items that now carry it.
 *
 *  In the bar it was a button pressed repeatedly and the page answered by changing
 *  colour, which is answer enough. Inside a closed menu it is not: the reader has to
 *  open the menu to reach it, and a menu that says only `Theme` cannot tell them
 *  whether the next press goes to dark or back to the system. The `#theme` button in
 *  the editorial bar is the one case that is still just a button, and it keeps its
 *  bare label — the suffix is for the two that live behind a caret. */
function paintTheme(): void {
  const t = document.documentElement.getAttribute("data-theme");
  const label = "Theme · " + (t === "dark" ? "Dark" : t === "light" ? "Light" : "System");
  for (const b of $$("[data-theme-item]")) b.textContent = label;
  paintFavicon(t);
}

/** The tab icon follows the choice, not the OS (owner, 2026-09-16).
 *
 *  `favicon.svg` carries its own `prefers-color-scheme` and is the right default: a
 *  served SVG gets no cascade from the page, and the tab strip is the browser's
 *  furniture rather than ours, so left alone the mark matches the strip it sits in.
 *  ⚠ **On `system` it stays that file and must.** What is swapped here is only the case
 *  where a reader has said which theme they want: then the page's ink and the tab's ink
 *  agreeing is worth more than the tab agreeing with the OS — and the cost, on the one
 *  crossed pair (an OS in light with the page in dark), is a light mark on a light
 *  strip. One line to revert if that trade reads wrong; `design/tools/mark.py` writes
 *  all three cuts either way.
 *
 *  The href is set rather than the element replaced, which is what Chrome and Firefox
 *  re-read; checked in a browser, because a favicon that does not repaint looks
 *  identical to one that did and matched. */
function paintFavicon(theme: string | null): void {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]');
  if (!link) return;
  const href = theme === "dark" ? "/favicon-dark.svg" : theme === "light" ? "/favicon-light.svg" : "/favicon.svg";
  if (!link.href.endsWith(href)) link.href = href;
}

export function wireTheme(): void {
  for (const b of $$("[data-theme-cycle]")) b.addEventListener("click", cycleTheme);
  paintTheme();
}
