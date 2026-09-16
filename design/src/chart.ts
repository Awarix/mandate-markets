// One line on an axis, drawn into an SVG that is already on the page.
//
// Lifted from the hero graphic in `home.ts`, which had the same area-plus-line-plus-
// gradient shape hardcoded against invented numbers. This one takes a series and knows
// nothing about what it means — the desk hands it profit-and-loss, and the colour it
// picks is the only opinion it has: green when the window ends up, red when it ends
// down, because a chart of somebody's money should not be green while the figure under
// it is negative.
//
// No dependency and no canvas. The SVG element is in the markup, so the CSP has nothing
// to say about this and a `prefers-reduced-motion` reader gets the same picture without
// the draw-in.

import { REDUCE } from "./dom.ts";

export type ChartPoint = { t: number; v: number };

/** Room for the line's own stroke, so a series whose high or low is at the very edge is
 *  not clipped in half by the viewBox. The plot has no axis labels — the figures are
 *  stated beside it in full — so this is the only padding there is. */
const PAD = 6;

export type Chart = {
  /** Draw, or redraw at the element's current size. Safe to call on every resize. */
  draw: (points: readonly ChartPoint[]) => void;
};

export function makeChart(svg: SVGSVGElement): Chart {
  // Built once here rather than written into the markup: four elements that only mean
  // anything together, and a gradient id that has to be unique on a page that could
  // one day carry two of these.
  const uid = "cg" + Math.random().toString(36).slice(2, 8);
  svg.innerHTML =
    `<defs><linearGradient id="${uid}" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0%" stop-opacity=".22"/><stop offset="100%" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<path class="carea" fill="url(#${uid})" stroke="none"></path>` +
    `<polyline class="cline" fill="none" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></polyline>`;
  const area = svg.querySelector<SVGPathElement>(".carea")!;
  const line = svg.querySelector<SVGPolylineElement>(".cline")!;
  const stops = svg.querySelectorAll<SVGStopElement>("stop");

  let last: readonly ChartPoint[] = [];

  function draw(points: readonly ChartPoint[] = last): void {
    last = points;
    const W = svg.clientWidth || 640, H = svg.clientHeight || 190;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);

    // One point is not a line, and two identical ones are not a range. Both happen: a
    // brand-new account's series is flat at zero, and the 24H window is thirteen points
    // that can all be the same on a quiet day.
    if (points.length < 2) { line.setAttribute("points", ""); area.setAttribute("d", ""); return; }

    let lo = Infinity, hi = -Infinity;
    for (const p of points) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
    // A flat series would divide by zero and, worse, would look like a line pinned to
    // the top of the box. Give it a band and it sits in the middle, which is the truth.
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }

    const X = (i: number) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
    const Y = (v: number) => PAD + (1 - (v - lo) / (hi - lo)) * (H - PAD * 2);

    const xy: string[] = [];
    for (let i = 0; i < points.length; i++) xy.push(`${X(i).toFixed(1)},${Y(points[i]!.v).toFixed(1)}`);
    line.setAttribute("points", xy.join(" "));
    area.setAttribute("d", `M${xy.join(" L").replace(/,/g, " ")} L${W} ${H} L0 ${H} Z`);

    // The window's direction, not the last point's sign. A window that opened at −$40
    // and closed at −$10 is a good week, and drawing it red would say the opposite.
    const up = points[points.length - 1]!.v >= points[0]!.v;
    const colour = up ? "var(--up)" : "var(--down)";
    line.setAttribute("stroke", colour);
    for (const s of stops) s.setAttribute("stop-color", colour);
  }

  /* The element's own size, not the window's.
   *
   *  A `resize` listener covers the phone turning over and misses the case that
   *  actually bit: `.cplot` is `flex:1` inside a card whose height is set by the *other*
   *  card in the row, so the balance landing a second after the history changes this
   *  element's box with no window resize at all — and the line stays drawn to the box
   *  it had. Font loading does the same thing. A `ResizeObserver` catches every one of
   *  them and the window resize too.
   *
   *  It cannot feed back: the SVG is sized entirely by CSS (`width:100%`, `height:100%`)
   *  and `draw` only writes attributes on its children, so nothing in here can change
   *  the box being observed. */
  new ResizeObserver(() => draw()).observe(svg);

  if (!REDUCE) svg.classList.add("cdraw");
  return { draw };
}
