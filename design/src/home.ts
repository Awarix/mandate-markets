// The logged-out home page: the hero equity graphic, the scroll reveals, and the
// three-beat sequence. All of it is illustration — none of these numbers comes from
// the server, and none of it runs behind the login.

import { $, $$, REDUCE, money, signed } from "./dom.ts";

// ── The hero graphic ────────────────────────────────────────────────────────
//
// An equity curve inside the one guarantee the product actually makes: a daily loss
// cap that resets upward every day you finish ahead. Losses are drawn at the same
// depth every time, because a fixed stop is what makes them the same depth. The curve
// is allowed to go down — a line that only climbs reads as a lie to anyone who has
// traded.

const equity = (() => {
  const N = 110, START = 1000, CAP = 10, STOP = 3, DAY = 24;
  function mulberry32(a: number): () => number {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  const rnd = mulberry32(3117);
  const plot = $("plot"), svg = $("eq"), mk = $("mk");
  const elLine = $("eqLine"), elGlow = $("eqGlow"), elArea = $("eqArea"),
    elFloor = $("eqFloor"), elTicks = $("eqTicks");
  const pts: number[] = [], floors: number[] = [], marks: (string | null)[] = [];
  let eq = START, dayStart = START, dayLeft = DAY, dayLosses = 0;
  let posLeft = 0, posLen = 0, posEntry = START, posOut = 0;
  let wins = 0, losses = 0, won = 0;
  let W = 0, H = 0;
  const PAD_T = 18, PAD_B = 34;

  function open(): void {
    posLen = 5 + Math.floor(rnd() * 4);
    posEntry = eq;
    // Three losses in a day is the cap doing its job; after that the day is over.
    posOut = (dayLosses < 3 && rnd() < 0.34) ? -STOP : (2 + rnd() * 5);
    posLeft = posLen;
  }

  function step(): string | null {
    if (dayLeft <= 0) { dayStart = eq; dayLeft = DAY; dayLosses = 0; }
    dayLeft--;
    let v = eq;
    let mark: string | null = null;
    if (dayLosses >= 3) {                       // halted for the day — a flat line
      v = eq + (rnd() - .5) * 0.12;
    } else {
      if (posLeft <= 0) open();
      posLeft--;
      const frac = 1 - posLeft / posLen;
      v = posEntry + posOut * frac + (rnd() - .5) * 0.85;
      if (posLeft === 0) {
        v = posEntry + posOut;
        if (posOut < 0) { mark = "l"; losses++; dayLosses++; } else { mark = "w"; wins++; won += posOut; }
      }
    }
    eq = v;
    pts.push(v); floors.push(dayStart - CAP); marks.push(mark);
    if (pts.length > N) { pts.shift(); floors.shift(); marks.shift(); }
    return mark;
  }

  function relayout(): void {
    W = plot.clientWidth || 960; H = plot.clientHeight || 250;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", String(W)); svg.setAttribute("height", String(H));
    draw();
  }

  function draw(): void {
    if (!pts.length) return;
    const lo = Math.min(...floors) - 2;
    let hi = Math.max(...pts) + 2;
    if (hi - lo < 8) hi = lo + 8;
    const X = (i: number) => i / (N - 1) * W;
    const Y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * (H - PAD_T - PAD_B);

    const line: string[] = [], floor: string[] = [];
    let ticks = "";
    for (let i = 0; i < pts.length; i++) {
      const px = X(i).toFixed(1), py = Y(pts[i]!).toFixed(1);
      line.push(`${px},${py}`);
      // a stepped floor: it holds flat all day, then jumps to the new day's cap
      if (i > 0 && floors[i] !== floors[i - 1]) floor.push(`${px},${Y(floors[i - 1]!).toFixed(1)}`);
      floor.push(`${px},${Y(floors[i]!).toFixed(1)}`);
      if (marks[i]) ticks += `<circle cx="${px}" cy="${py}" r="3.2" fill="var(--ground)" ` +
        `stroke="var(${marks[i] === "w" ? "--up" : "--down"})" stroke-width="2"/>`;
    }
    const lp = line.join(" ");
    elLine.setAttribute("points", lp);
    elGlow.setAttribute("points", lp);
    elFloor.setAttribute("points", floor.join(" "));
    elArea.setAttribute("d", "M" + line.join(" L").replace(/,/g, " ") + ` L${X(pts.length - 1)} ${H} L0 ${H} Z`);
    elTicks.innerHTML = ticks;

    mk.style.left = `${X(pts.length - 1)}px`;
    mk.style.top = `${Y(pts[pts.length - 1]!)}px`;
    $("lgw").textContent = String(wins); $("lgl").textContent = String(losses);
    $("lgwa").textContent = "+" + money(wins ? won / wins : 0);
  }

  function paintTotal(): void {
    const d = eq - START;
    $("bal").textContent = money(eq);
    $("delta").textContent = signed(d);
    $("delta").style.color = d < 0 ? "var(--down)" : "var(--up)";
  }

  for (let p = 0; p < N; p++) step();          // fill the window before anything is shown
  relayout();
  addEventListener("resize", relayout, { passive: true });

  if (REDUCE) { mk.classList.add("on"); paintTotal(); }
  else {
    // Count the balance up while the curve draws itself in, then run live.
    $("bal").textContent = money(START);
    let t0: number | null = null;
    const from = START, to = eq, DUR = 1200;
    requestAnimationFrame(function frame(t) {
      if (t0 === null) t0 = t;
      const k = Math.min(1, (t - t0) / DUR), e = 1 - Math.pow(1 - k, 3);
      const v = from + (to - from) * e;
      $("bal").textContent = money(v);
      $("delta").textContent = signed(v - START);
      if (k < 1) requestAnimationFrame(frame);
      else { mk.classList.add("on"); paintTotal(); }
    });
    setInterval(() => {
      const mark = step(); draw(); paintTotal();
      if (mark) { mk.classList.remove("flash"); void mk.offsetWidth; mk.classList.add("flash"); }
    }, 900);
  }
  return { relayout };
})();

export function relayoutHero(): void { equity.relayout(); }

// ── Scroll reveals ──────────────────────────────────────────────────────────

export function wireReveals(): void {
  if (!REDUCE && "IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -12% 0px" });
    $$(".rv").forEach((e) => io.observe(e));
  }
  requestAnimationFrame(() => requestAnimationFrame(() => { $("hero").classList.add("go"); }));
}

// ── The three beats, driven by one clock ────────────────────────────────────
//
// The point of the sequence is that it is a machine: the feed hands off to the middle,
// the middle works, and only then does the balance move. Two of its outcomes cost
// nothing and one costs $3 — which is the honest ratio, and it makes the payoff mean
// something when it lands.

export function wireBeats(): void {
  const stages = $$("#stages .stage");
  const words = stages.map((s) => s.lastChild!.textContent);
  const feed = $$("#feed div");
  const mid = $("mid"), c1 = $("c1"), c2 = $("c2"), payoff = $("payoff"),
    amt = $("beatamt"), fly = $("fly");
  let total = 0, gen = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];

  const at = (ms: number, fn: () => void) => { timers.push(setTimeout(fn, ms)); };
  const clear = () => { timers.forEach(clearTimeout); timers = []; };
  const fire = (el: HTMLElement) => { el.classList.remove("fire"); void el.offsetWidth; el.classList.add("fire"); };
  const reset = () => {
    stages.forEach((s, i) => { s.className = "stage"; s.lastChild!.textContent = words[i]!; });
    mid.classList.remove("busy");
  };

  function run(): void {
    const self = ++gen; clear(); reset();
    // 38% skipped before it costs anything, 20% stopped out, the rest pay.
    const r = Math.random();
    const outcome = r < 0.38 ? "skip" : (r < 0.58 ? "stop" : "win");
    const stopAt = outcome === "skip" ? 1 : (outcome === "stop" ? 4 : -1);

    const hot = feed[Math.floor(Math.random() * feed.length)]!;
    feed.forEach((f) => f.classList.remove("hot"));
    hot.classList.add("hot");
    feed.forEach((f) => {
      f.querySelector(".g")!.textContent = "σ " + (f === hot ? (1.6 + Math.random() * 1.4) : (Math.random() * 1.1)).toFixed(2);
    });

    at(260, () => { if (self !== gen) return; fire(c1); });
    at(680, () => { if (self !== gen) return; mid.classList.add("busy"); });

    // Stop scheduling at the rejection: a skipped signal must not keep working.
    const last = stopAt >= 0 ? stopAt : stages.length - 1;
    stages.slice(0, last + 1).forEach((s, i) => {
      at(700 + i * 520, () => {
        if (self !== gen) return;
        if (i > 0) stages[i - 1]!.className = "stage ok";
        if (i === stopAt) {
          s.className = "stage no";
          s.lastChild!.textContent = outcome === "skip"
            ? "no — the move is too small to cover fees"
            : "stopped out — the stop did its job";
        } else s.className = "stage run";
      });
    });

    const end = stopAt >= 0 ? 700 + stopAt * 520 + 560 : 700 + stages.length * 520;
    at(end, () => {
      if (self !== gen) return;
      mid.classList.remove("busy");
      if (outcome === "skip") { at(1500, run); return; }
      if (stopAt < 0) stages[stages.length - 1]!.className = "stage ok";
      fire(c2);
      at(760, () => {
        if (self !== gen) return;
        const d = outcome === "stop" ? -3 : 2 + Math.random() * 5;
        total += d;
        amt.textContent = signed(total);
        amt.style.color = total < 0 ? "var(--down)" : "var(--up)";
        fly.textContent = signed(d);
        fly.style.color = d < 0 ? "var(--down)" : "var(--up)";
        fly.classList.remove("go"); void fly.offsetWidth; fly.classList.add("go");
        payoff.classList.add("hit");
        at(340, () => payoff.classList.remove("hit"));
        at(1900, run);
      });
    });
  }

  if (REDUCE) {
    stages.forEach((s) => { s.className = "stage ok"; });
    amt.textContent = "+$47.20";
    feed.forEach((f, i) => { f.querySelector(".g")!.textContent = "σ " + [2.41, 1.83, 0.42][i]!.toFixed(2); });
    feed[0]!.classList.add("hot");
  } else if ("IntersectionObserver" in window) {
    const bio = new IntersectionObserver((es) => {
      es.forEach((e) => { if (e.isIntersecting) run(); else { gen++; clear(); } });
    }, { threshold: .35 });
    bio.observe(document.querySelector(".beats")!);
  } else run();
}
