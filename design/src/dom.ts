// DOM and formatting helpers. Everything here is used by more than one module and
// none of it knows anything about this product.

/** `getElementById`, typed. The id is always present — this page ships its own
 *  markup — so this asserts rather than returning null and making every call site
 *  handle a case that cannot happen. Pass the element type when you need one:
 *  `$<HTMLInputElement>("sp").value`.
 *
 *  Constrained to `Element` rather than `HTMLElement` so the desk's chart can ask for
 *  its `SVGSVGElement`, which is not one. The *default* is still `HTMLElement`, so
 *  every other call site is unchanged and still gets `.hidden` and `.textContent`
 *  without a cast — and the id stays inside `ids.test.ts`'s scan, which is the reason
 *  to reach for this helper rather than `getElementById` with a cast. */
export function $<T extends Element = HTMLElement>(id: string): T {
  return document.getElementById(id) as unknown as T;
}

export function $$<T extends HTMLElement = HTMLElement>(sel: string): T[] {
  return Array.from(document.querySelectorAll<T>(sel));
}

/** Honoured by the hero graphic and the beats, which are the only animated things.
 *
 *  Guarded so that importing this file outside a browser does not throw at module load.
 *  It is not defensiveness about the page — `matchMedia` is everywhere a browser is —
 *  it is what lets a module that formats a string be unit-tested without a DOM, which
 *  is the difference between `deskLimits.test.ts` existing and not. */
export const REDUCE = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Every string that reaches `innerHTML` goes through this. The page's CSP is
 *  hash-locked, so an injected `<script>` would not run — but an injected attribute
 *  or an injected `<img onerror>` is a different question, and the cheap habit is to
 *  escape everything rather than to reason per call site. */
export function esc(s: unknown): string {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

export function money(n: number): string {
  return "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** A minus sign, not a hyphen. The desk is set in a tabular face and the two do not
 *  line up in a column of numbers. */
export function signed(n: number): string {
  return (n < 0 ? "−" : "+") + money(n);
}

/** A dash is not zero. Every venue-sourced figure can come back null — Hyperliquid
 *  unreachable — and saying "$0.00" about somebody's account when we do not know is
 *  the wrong claim to make. */
export function fmtUsd(n: number | null): string {
  return n == null ? "—" : money(n);
}

export function fmtSigned(n: number | null): string {
  return n == null ? "—" : signed(n);
}

export function fmtPx(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) < 10 ? 4 : 2 });
}

export function pctOf(n: number | null): string {
  return (n == null ? 0 : n * 100).toFixed(1).replace(/\.0$/, "") + "%";
}

/** One label-and-value row. Markup, not product — three cards use it. */
export function kv(k: string, v: string | number): string {
  return '<div class="kv"><span class="k">' + esc(k) + '</span><span>' + esc(v) + '</span></div>';
}

/** An ISO instant in the reader's own **timezone** and in en-US, or "" when there is
 *  none. Every date the desk shows a person goes through this.
 *
 *  The locale is pinned and the timezone is not, deliberately (`tasks/26` §6.6, owner's
 *  decision 2026-09-08). It used to follow the reader for both, which put
 *  `2 мар. 2027 г., 18:41` on a Russian browser directly beside `$117.25` from
 *  `money()`, which has always pinned en-US — one screen, two locales, and the long
 *  form broke the column of a page set in a tabular face. The timezone still follows
 *  the reader because *when* a stop fired is a fact about their day, and rendering it
 *  in ours would be wrong rather than merely inconsistent. */
export const DATE_LOCALE = "en-US";

export function dayOf(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString(DATE_LOCALE, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

export function shortAddr(a: string | null): string {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
}
