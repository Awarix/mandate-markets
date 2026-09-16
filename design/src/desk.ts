// The desk: what one account's screen shows, rendered from /api/desk.

import { api, type ApiError, type Desk, type DeskAgent, type DeskFeed, type DeskPosition, type Portfolio, type PortfolioSeries, type PortfolioWindow, type SignalHistory, type SignalRow, type TradeHistory, type TradeRow } from "./api.ts";
import { makeChart, type Chart } from "./chart.ts";
import { openAgentRenewal } from "./connect.ts";
import { renderLimits } from "./deskLimits.ts";
import { renderFee } from "./builderFee.ts";
import { runApproval } from "./renew.ts";
import { $, $$, DATE_LOCALE, dayOf, esc, fmtPx, fmtSigned, fmtUsd, kv, money } from "./dom.ts";
import { getMe, sessionExpired } from "./session.ts";
import { wireShare } from "./share.ts";
import { moveAndGain, pct, share } from "./trade.ts";

/** `+12.0%` under a dollar result, or nothing when the ratio is unknown.
 *
 *  One decimal, which is the rule every percentage on the desk follows (`tasks/19` §1).
 *  The share-card renderer in `tasks/16` rounds the same way and cannot share this code —
 *  `design/src` is bundled apart from `src/` — so the rule is written down there too.
 *
 *  **The denominator is not named here, and `tasks/19` §1 said to name it.** That rule
 *  is about telling three denominators apart — the day's opening equity, the mandate,
 *  the margin — where two of them sit adjacent and a bare percentage would be read as
 *  whichever the reader last saw. It binds where that risk is real, and the hero's two
 *  figures still carry theirs for exactly that reason. It does not bind on a headline
 *  that stands alone: every result on a position card and every `Net` in the history is
 *  of margin, on every row, and repeating it turns the denominator into furniture.
 *
 *  The share card came to the same place first — "of margin" came off it on 2026-09-05
 *  (`src/web/cards.ts`) — so the desk and the number leaving the building now agree
 *  about what a result looks like, which they had stopped doing. What still names its
 *  denominator is the `Target` row in the trade detail, where a price move and a margin
 *  return sit side by side and telling them apart is the whole job. Owner, 2026-09-08. */
function ofMargin(usd: number | null, marginUsd: number | null): string {
  const s = share(usd, marginUsd);
  return s == null ? "" : " <small>" + pct(s, 1) + "</small>";
}

// The axis is normalised stop → target, so 0% is always the worst case and 100%
// always the goal, for a long and for a short alike. That makes "now is past entry"
// mean "winning" without the renderer knowing which side the position is.
function track(lo: number | null, hi: number | null, now: number | null, ent: number | null): string {
  if (lo == null || hi == null || now == null || hi === lo) return "";
  const at = (v: number) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  const nx = at(now), ex = (ent == null ? null : at(ent));
  const edge = (x: number) => x < 18 ? " lft" : x > 82 ? " rgt" : "";
  const band = ex == null ? "" : '<span class="band ' + (nx >= ex ? "up" : "down") + '" style="left:'
    + Math.min(ex, nx).toFixed(2) + '%;width:' + Math.abs(nx - ex).toFixed(2) + '%"></span>';
  return '<div class="track"><div class="axis">' + band
    + '<span class="tk end lo" style="left:0"></span><span class="tk end hi" style="left:100%"></span>'
    + (ex == null ? "" : '<span class="tk entry" style="left:' + ex.toFixed(2) + '%"></span>')
    + '<span class="tk now" style="left:' + nx.toFixed(2) + '%"></span>'
    + '<span class="nowlab' + edge(nx) + '" style="left:' + nx.toFixed(2) + '%"><span class="w">now</span>'
    + fmtPx(now) + '</span></div><div class="tlab">'
    + '<span class="e0"><span class="w">stop</span>' + fmtPx(lo) + '</span>'
    + (ex == null ? "" : '<span class="em' + edge(ex) + '" style="left:' + ex.toFixed(2) + '%">'
      + '<span class="w">entry</span>' + fmtPx(ent) + '</span>')
    + '<span class="e1"><span class="w">target</span>' + fmtPx(hi) + '</span></div></div>';
}

function posCard(p: DeskPosition): string {
  const sign = p.unrealizedPnlUsd == null ? "" : (p.unrealizedPnlUsd >= 0 ? "up" : "down");
  const dir = p.side === "long" ? "up" : "down";
  return '<article class="pcard">'
    + '<div class="phead"><span class="coin">' + esc(p.coin) + '</span>'
    + '<span class="pill ' + dir + '"><span class="dot"></span>' + (p.side === "long" ? "Long" : "Short")
    + ' ' + esc(p.leverage) + '×</span>'
    + (p.awaitingFill ? '<span class="pill quiet">Awaiting fill</span>' : '')
    /* The card's right-hand corner: Share on top, the result under it, both against the
       same edge (the owner's mockup, 2026-09-08). The two used to sit side by side in
       this row, which left the P&L's right edge to be decided by the width of the word
       beside it.

       Share itself is tasks/16, redesigned 2026-09-05. §5 of the task ruled open
       positions out — a card about a position that has not closed is a claim about a
       number that has not happened — and the owner asked for it anyway. The objection is
       answered on the card rather than by the button's absence: it says Open, says
       unrealised, and carries the instant it was taken. */
    + '<div class="pright">'
    + '<button class="sharebtn" data-share-pos="' + esc(p.intentId) + '">Share</button>'
    + '<span class="pnl num ' + sign + '">' + fmtSigned(p.unrealizedPnlUsd)
    + ofMargin(p.unrealizedPnlUsd, p.marginUsd) + '</span>'
    + '</div></div>'
    + track(p.stopPx, p.targetPx, p.markPx, p.entryPx)
    + '<div class="why">' + esc(p.rationale) + '</div></article>';
}

/* The agent approval, in three states.

   This is the only channel we have to the person whose money it is: wallet sign-in
   means no email and no push token, and an approval that lapses breaks nothing loudly
   — the account still reads live, this screen still renders, and every signal is
   quietly skipped. So the desk has to say it.

   The wording is the server's (`src/risk/expiry.ts`), which is also what the operator
   alert and the executor log say. Three audiences, one set of words, and no second
   copy here to drift from it. */
function renderAgent(a: DeskAgent | null): void {
  const el = $("dagent");
  // Healthy is a line in the status stack, not a banner. A warning that is always
  // there is a warning nobody reads.
  if (!a || a.state === "healthy" || a.state === "unknown") { el.hidden = true; return; }
  el.hidden = false;
  const head = a.state === "lapsed"
    ? "Your approval of us has expired."
    : "Your approval of us runs out " + dayOf(a.expiresAt) + ".";
  // The note lives *inside* `dagent` rather than being it, because the renewal flow
  // replaces this whole block with its own once it starts.
  el.innerHTML = '<div class="note ' + (a.state === "lapsed" ? "bad" : "warn") + '">'
    + "<strong>" + esc(head) + "</strong> " + esc(a.message)
    + '<div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center">'
    + '<button class="btn sm" id="drenew">Renew it now</button>'
    + '<button class="btn ghost sm" id="drenewhl">Do it on Hyperliquid</button>'
    + "</div></div>";
  // Renewing here signs with the wallet that is already connected. The Hyperliquid path
  // stays beside it rather than being replaced: granting trading rights on the venue's
  // own domain is a real trust anchor, and `design/src/renew.ts` carries that argument.
  $("drenew").addEventListener("click", () => { void runApproval(el, () => { void loadDesk(); }, "renew"); });
  $("drenewhl").addEventListener("click", () => openAgentRenewal());
}

/* What we saw, and what we did about it.

   Taken and skipped in one list. A screen that only shows refusals cannot answer "and
   what did you take instead", and that comparison is the whole reason this section
   exists rather than a second nav item.

   Loaded on demand rather than with the desk: it is pure ledger, nobody looks at it
   on most visits, and the desk's first paint is the thing worth protecting. */
function sigRow(r: SignalRow, paper: boolean): string {
  const when = new Date(r.lastAt);
  const stamp = isNaN(when.getTime()) ? "" : when.toLocaleString(DATE_LOCALE, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  if (r.outcome === "taken") {
    const pnl = r.netPnlUsd;
    const cls = pnl == null ? "" : (pnl >= 0 ? "up" : "down");
    const outcome = r.status === "closed"
      ? "closed on " + esc(r.closeReason ?? "an unrecorded reason")
      : esc(r.status ?? "open");
    return '<div class="trow"><span class="tc1">' + esc(r.coin ?? "—") + '</span>'
      + '<span class="tc2"><span class="pill ' + (r.side === "long" ? "up" : "down") + '">'
      + '<span class="dot"></span>' + (r.side === "long" ? "Long" : "Short") + '</span>'
      + (paper ? ' <span class="pill quiet">Paper</span>' : '') + '</span>'
      + '<span class="tc3">Taken — ' + outcome + '. ' + esc(r.rationale ?? "")
      /* Null is "we have not settled this yet", never zero and never the estimate. */
      + ' <span class="pnl num ' + cls + '">' + (pnl == null ? "—" : fmtSigned(pnl)) + '</span></span>'
      + '<span class="tc4 sn">' + esc(stamp) + '</span></div>';
  }
  const times = r.seenCount > 1 ? " · seen " + r.seenCount + "×" : "";
  return '<div class="trow"><span class="tc1">' + esc(r.coin ?? "—") + '</span>'
    + '<span class="tc2"><span class="pill quiet">Skipped</span></span>'
    + '<span class="tc3">' + esc(r.label ?? r.reason ?? "") + ". " + esc(r.detail ?? "") + '</span>'
    + '<span class="tc4 sn">' + esc(stamp) + esc(times) + '</span></div>';
}

/** The table shell. The header must live *inside* the scrolling box or `position:
 *  sticky` has nothing to stick to — it resolves against the nearest scrolling
 *  ancestor, and putting it outside fails silently. */
function table(headings: string[], rowsHtml: string, footer = ""): string {
  return '<div class="tbl"><div class="tscroll"><div class="thead">'
    + headings.map((h, i) => '<span class="tc' + (i + 1) + '">' + esc(h) + "</span>").join("")
    + "</div>" + rowsHtml + "</div>"
    // Outside `.tscroll`, so it stays put instead of scrolling away from the figures
    // it explains.
    + (footer ? '<div class="tfoot">' + footer + "</div>" : "")
    + "</div>";
}

/* What σ is, in the one place it is being read.
   Nobody arrives knowing this, and it is on every row of both tables. The second
   sentence is the part people actually want — a displacement means nothing until it is
   multiplied by the leverage behind it. */
const SIGMA_NOTE =
  "<strong>σ</strong> measures a forecast's move against how much that market normally "
  + "moves over the same horizon — 1σ is an ordinary move, 2σ is unusual. It is not a "
  + "probability, and we skip anything under 1σ because a smaller move would not clear "
  + "its own fees.";
const SIGMA_NOTE_TRADES = SIGMA_NOTE
  + " The <span class=\"mono\">→</span> figure beside each price is that move as a share "
  + "of the margin behind the position, which is where leverage shows up: at 10× a 0.85% "
  + "move is 8.5% of what you committed, and a 1% stop is 10% of it.";

/* ── The tabs (tasks/27) ──────────────────────────────────────────────────────

   `What we saw` and `Closed trades` were sections that opened and closed from their
   own headers. They are now two of the three things the desk is for, so they are tabs:
   `Open`, `History`, `Skipped`, with their counts in the tab.

   Loading is still lazy — neither list is fetched until its tab is first selected — and
   it is now *once*, not on every press. The collapsible version refetched on each
   expand, which was affordable because expanding was deliberate; a tab is pressed to
   look away and back, and `Refresh` is the control for wanting it again. A load that
   failed leaves its flag false and so does retry.

   The other change is a session guard the collapsible version did not have. A
   signed-out visitor reading the demo desk could expand a section and watch its demo
   rows be replaced by `Loading…` and then by nothing, because the fetch behind them
   401s (tasks/26 §5 is the record of the same fault before those rows existed). That
   was survivable when it needed a deliberate expand; a tab gets pressed. */
type Tab = "open" | "hist" | "skip";
const TABS: Tab[] = ["open", "hist", "skip"];
const TAB_BTN: Record<Tab, string> = { open: "tabopen", hist: "tabhist", skip: "tabskip" };
const TAB_PANE: Record<Tab, string> = { open: "paneopen", hist: "panehist", skip: "paneskip" };

let activeTab: Tab = "open";

function selectTab(t: Tab, moveFocus = false): void {
  activeTab = t;
  for (const n of TABS) {
    const on = n === t;
    const b = $<HTMLButtonElement>(TAB_BTN[n]);
    b.setAttribute("aria-selected", on ? "true" : "false");
    // Roving tabindex: the tab row is one stop, and the arrows move within it.
    b.tabIndex = on ? 0 : -1;
    $(TAB_PANE[n]).hidden = !on;
  }
  if (moveFocus) $<HTMLButtonElement>(TAB_BTN[t]).focus();
  if (!getMe()) return;                    // a visitor keeps the demo rows
  if (t === "hist" && !histLoaded) { histCursor = null; void fetchHistory(false); }
  if (t === "skip" && !sigLoaded) void loadSignals();
}

export function wireTabs(): void {
  TABS.forEach((t, i) => {
    const b = $<HTMLButtonElement>(TAB_BTN[t]);
    b.addEventListener("click", () => selectTab(t));
    // The keyboard behaviour a tablist is expected to have and gets none of for free.
    b.addEventListener("keydown", (e) => {
      const at = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1
        : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
      if (at == null) return;
      e.preventDefault();
      selectTab(TABS[(at + TABS.length) % TABS.length]!, true);
    });
  });
}

let sigLoaded = false;

export async function loadSignals(): Promise<void> {
  const box = $("dsig"), btn = $<HTMLButtonElement>("dsigrefresh");
  box.innerHTML = '<div class="card pad" style="color:var(--dim)">Loading…</div>';
  btn.disabled = true;
  try {
    const h = await api<SignalHistory>("/api/signals");
    sigLoaded = true;
    box.innerHTML = h.rows.length
      ? table(["Market", "Decision", "Why", "When"],
        h.rows.map((r) => sigRow(r, h.mode === "paper")).join(""), SIGMA_NOTE)
      /* Empty is a state, not an error: a desk that has seen nothing yet should say so
         rather than render as a broken table. */
      : '<div class="card pad" style="color:var(--dim)">Nothing yet. Every forecast we look at '
        + 'lands here — the ones we took and the ones we refused, with the reason.</div>';
  } catch (e) {
    if ((e as ApiError).status === 401) { sessionExpired(); return; }
    box.innerHTML = '<div class="note warn">Could not load that just now. ' + esc((e as Error).message) + "</div>";
  } finally {
    btn.disabled = false;
  }
}

export function wireSignals(): void {
  $("dsigrefresh").addEventListener("click", () => void loadSignals());
}

/* Closed trades.

   `docs/USER-JOURNEY.md`: the dashboard answers "why", not just "what". A row is not
   `SILVER +$0.69`. A row is why we opened it, what the plan was, why it closed, and
   what it cost — and `closeReason` is the load-bearing part, because the executor
   records it from which of its own exit orders stopped resting rather than from where
   the price ended up.

   The same `.srow` component as the signal list above, per tasks/09: build it once,
   for both. */
const CLOSE_WORDS: Record<string, string> = {
  target: "hit its target",
  stop: "stopped out",
  horizon: "reached its deadline",
  retired: "the forecast was withdrawn",
  halt: "the account halted",
  disconnect: "we stopped managing the account",
  // `tasks/44`. Deliberately not "the forecast was withdrawn": a reversal is a
  // different fact and the two must read differently here as well as in the ledger.
  flipped: "the forecast reversed",
  // The venue's own close, not ours, and the sentence says so. A row that read "the
  // forecast was withdrawn" over a liquidation is the screen telling somebody their
  // position ended for a reason it did not.
  liquidated: "Hyperliquid closed it out",
};

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString(DATE_LOCALE, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

/** Six significant figures, the same precision the executor writes into its own
 *  rationale — so a price reads identically wherever it is shown. */
function px(n: number | null): string {
  // `toPrecision` and not a Number() round-trip: the round-trip drops trailing zeros,
  // turning 6.71860 into 6.7186 — which loses the venue's own precision and unaligns
  // the column it sits in.
  return n == null ? "—" : n.toPrecision(6);
}

/** How long the position was actually held. Not the planned horizon: a trade closed
 *  early by a stop or a withdrawn forecast never reached it, and showing the plan
 *  where the outcome belongs is how a screen quietly lies. */
function heldFor(openedAt: string, closedAt: string | null): string {
  if (!closedAt) return "";
  const ms = Date.parse(closedAt) - Date.parse(openedAt);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = ms / 3_600_000;
  return h < 1 ? Math.round(ms / 60_000) + "m" : h.toFixed(1) + "h";
}

function dl(pairs: Array<[string, string]>): string {
  return '<dl class="tdl">'
    + pairs.map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + v + "</dd>").join("")
    + "</dl>";
}

function tradeRow(t: TradeRow): string {
  const pnl = t.netPnlUsd;
  const cls = pnl == null ? "" : (pnl >= 0 ? "up" : "down");
  const why = CLOSE_WORDS[t.closeReason ?? ""] ?? (t.closeReason ?? "closed");

  /* The forecast's own two numbers. Null is "we no longer hold that" — the signals row
     was pruned or predates the table — and a dash says so rather than inventing 0.00σ. */
  /* Magnitude only. The sigma's sign is the direction the forecast pointed, which the
     Long/Short pill two columns left already says — and printed next to a
     profit-signed percentage it reads as a contradiction: a short's target is
     "+1.03% → +10.3%" beside "−1.69σ". What σ adds here is size, not direction. */
  const sigma = t.sigma == null ? ""
    : "  (" + Math.abs(t.sigma).toFixed(2) + "σ" + (t.strength ? ", " + t.strength : "") + ")";


  /* Costs sit next to the number they came out of, because a net figure with the costs
     hidden is exactly the number that stops matching Hyperliquid. */
  const costs = (t.feeUsd == null && t.fundingUsd == null)
    ? "<em>" + esc(t.pnlNote ?? "Not settled against the venue yet.") + "</em>"
    : esc(money(t.feeUsd ?? 0) + " fees"
      + (t.fundingUsd == null ? "" : " · " + money(Math.abs(t.fundingUsd))
        + (t.fundingUsd < 0 ? " funding paid" : " funding received")));

  /* Every distance is measured from the price we actually got in at, not from the
     reference the signal quoted — and signed by profit, so a short's stop reads as the
     loss it is rather than as a positive number. */
  const move = (p: number | null, suffix = "") => moveAndGain(t.entryPx, p, t.side, t.leverage, { suffix });

  const held = heldFor(t.openedAt, t.closedAt);
  const rows: Array<[string, string]> = [
    ["Entry", esc(px(t.entryPx))],
    ["Target", esc(px(t.targetPx) + move(t.targetPx, " of margin") + sigma)],
    ["Stop", t.stopPx == null ? "off (you turned it off)" : esc(px(t.stopPx) + move(t.stopPx))],
  ];
  /* What it actually left at. Null until the closing fills are ingested — the same
     settlement the net figure waits for, so the two are never out of step. */
  rows.push(["Exit", t.exitPx == null ? "—" : esc(px(t.exitPx) + move(t.exitPx))]);
  rows.push(["Margin", esc(money(t.marginUsd) + " at " + t.leverage + "×")]);
  if (held) rows.push(["Held", esc(held)]);
  rows.push(["Costs", costs]);
  rows.push(["Opened", esc(when(t.openedAt))]);
  rows.push(["Closed", esc(when(t.closedAt) + " — " + why)]);

  return '<div class="trow"><span class="tc1">' + esc(t.coin) + '</span>'
    + '<span class="tc2"><span class="pill ' + (t.side === "long" ? "up" : "down") + '">'
    + '<span class="dot"></span>' + (t.side === "long" ? "Long" : "Short") + " "
    + esc(t.leverage) + '×</span>'
    + (t.paper ? ' <span class="pill quiet">Paper</span>' : '') + '</span>'
    + '<span class="tc3">' + dl(rows) + '</span>'
    /* Net of fees and funding, as a share of the margin the position posted — the figure
       the trade card in tasks/16 carries, so the desk and the card agree to the decimal. */
    + '<span class="tc4 pnl num ' + cls + '">' + (pnl == null ? "—" : fmtSigned(pnl) + ofMargin(pnl, t.marginUsd)) + '</span>'
    /* Share, per row (tasks/16 §5). On closed trades only — this whole list is closed
       trades — and never on an open position, which is a claim about a number that has
       not happened. The button is offered even where it will be refused: "this has not
       settled against Hyperliquid's own fills yet" is a better answer than a button
       that is not there. */
    + '<span class="tc5"><button class="sharebtn" data-share-trade="' + esc(t.intentId) + '">Share</button></span>'
    + '</div>';
}

/** Wire whichever share buttons are not wired yet.
 *
 *  Both lists rebuild their own markup — the position cards on every desk poll, the
 *  history by appending a page at a time — so this runs after each render and skips
 *  what it has already done. */
function wireShareButtons(): void {
  for (const b of $$<HTMLButtonElement>("[data-share-pos]:not([data-wired])")) {
    b.dataset.wired = "1";
    wireShare(b, "position", { intentId: b.dataset.sharePos ?? "" });
  }
  for (const b of $$<HTMLButtonElement>("[data-share-trade]:not([data-wired])")) {
    b.dataset.wired = "1";
    wireShare(b, "trade", { intentId: b.dataset.shareTrade ?? "" });
  }
}

let histCursor: string | null = null;
let histLoaded = false;

async function fetchHistory(append: boolean): Promise<void> {
  const box = $("dhist"), btn = $<HTMLButtonElement>(append ? "dhistnext" : "dhistrefresh");
  if (!append) box.innerHTML = '<div class="card pad" style="color:var(--dim)">Loading…</div>';
  btn.disabled = true;
  try {
    const q = append && histCursor ? "?before=" + encodeURIComponent(histCursor) : "";
    const h = await api<TradeHistory>("/api/history" + q);
    histLoaded = true;
    histCursor = h.nextBefore;
    $("dhistmorewrap").hidden = h.nextBefore === null;
    const html = h.rows.map(tradeRow).join("");
    if (append) $("dhistrows").insertAdjacentHTML("beforeend", html);
    else {
      box.innerHTML = h.rows.length
        /* The fifth heading is empty and has to exist: the header row is built from
           this list, so a column of Share buttons with no heading beside it would leave
           the header one cell short and every column below it out of line. */
        ? table(["Market", "Position", "What happened", "Net", ""],
          '<div id="dhistrows">' + html + "</div>", SIGMA_NOTE_TRADES)
        /* Empty is a state, not an error state. Nothing has closed yet for most
           accounts — that is the whole of Phase 3 — so it should read as waiting
           rather than as a broken table. */
        : '<div class="card pad" style="color:var(--dim)" id="dhistrows">Nothing has closed yet. '
          + "Every position we close lands here, with why it closed and what it cost.</div>";
    }
    wireShareButtons();
  } catch (e) {
    if ((e as ApiError).status === 401) { sessionExpired(); return; }
    box.innerHTML = '<div class="note warn">Could not load that just now. ' + esc((e as Error).message) + "</div>";
  } finally {
    btn.disabled = false;
  }
}

export function wireHistory(): void {
  $("dhistrefresh").addEventListener("click", () => { histCursor = null; void fetchHistory(false); });
  $("dhistnext").addEventListener("click", () => void fetchHistory(true));
}

/** The account card's one button, on the header rather than per row (`tasks/16` §5).
 *  Wired once at boot; `renderDesk` decides whether it is visible. The dialog it opens
 *  is wired once too, in `main.ts`. */
export function wireShareWeek(): void {
  wireShare($("dshare"), "account", {});
}

/* What the feed costs, on the section those polls produce.
   Two facts, and the first is the one people actually want: how often we look. A
   signal that appeared eleven minutes ago has not been missed, and nothing else on
   this screen can say so. The spend is there because "we are not the alpha, we sell
   execution" is easier to believe from a desk that shows what the alpha costs.

   There was a third clause — `$5.66 credit left` — and `tasks/22` removed it on
   2026-09-16, from the payload and not just from here. It is our supplier balance: it
   moves for reasons that have nothing to do with the reader's money, and a running
   countdown on somebody else's screen reads as a liquidity disclosure from a company
   that is not disclosing liquidity. `readFeedCost` no longer carries the field, so
   putting the line back is not a one-line change, deliberately. */
function renderFeed(f: DeskFeed | null): void {
  const el = $("dfeed");
  if (!f) { el.hidden = true; return; }
  const bits: string[] = [];
  if (f.pollSeconds != null) {
    const m = f.pollSeconds / 60;
    bits.push("polled every " + (m >= 1 ? Math.round(m) + " min" : f.pollSeconds + "s"));
  }
  // Month-to-date, not a projection. A rate extrapolated from two days of a month
  // would be a forecast dressed as an invoice.
  if (f.monthUsd != null) {
    bits.push(money(f.monthUsd) + " this month"
      + (f.monthCalls == null ? "" : " over " + f.monthCalls + " calls"));
  }
  el.hidden = bits.length === 0;
  el.textContent = bits.join(" · ");
}

/* How far the day can go (tasks/19 §2).

   Under the today line, from the server: the level the halt sits at, what it is a
   share of, and what is left of it after today's mark-to-market. "Pauses", not
   "stops" — the halt stops opening and leaves every exit resting, and a screen that
   said "stops trading" would be read as "closes my positions". When the account is
   halted the banner above says so and this line goes. */
function renderHalt(d: Desk): void {
  const el = $("dhaltline");
  if (d.halted) { el.hidden = true; return; }
  el.hidden = false;
  const daily = Math.round(d.dailyLossPct * 100) + "%";
  if (d.haltAtUsd == null) {
    el.textContent = "Pauses after a " + daily + " loss on the day · the level is set on the first loop";
    return;
  }
  const away = d.todayUsd == null ? null : d.haltAtUsd + d.todayUsd;
  el.textContent = "Pauses at −" + money(d.haltAtUsd) + " · −" + daily + " of today's opening equity ("
    + fmtUsd(d.dayStartEquityUsd) + ")" + (away == null ? "" : " · " + money(Math.max(0, away)) + " away");
}

/* The halt banner (tasks/30 §1–§2): why it paused, what the day looked like, and — for
   a daily-loss halt whose condition has gone — the button that clears it.

   **What it used to say was one sentence**, `haltReason`, which is the abstract fact.
   What no screen said was the day: on 2026-09-08 an account reached the cap on two
   positions at −38.1% and −35.6% of their margin against **17 winners** — a 65% hit
   rate — and the thing worth looking at there is the position size, not the signals.
   The account that halted had no way to see that.

   **The button is only ever for a daily-loss halt**, and the others say why in their
   own words rather than showing a disabled control with no explanation. A foreign-actor
   halt means *our position accounting can no longer be trusted*, and the account's
   owner is the one person who cannot confirm that for us — they are the second actor.

   The server decides `clearable`, not this file. The same `canClearHalt` runs in the
   executor before anything is written, so the button cannot be talked into a clear by
   editing the page. */
function renderHaltBanner(d: Desk, reload: () => void): void {
  const h = $("dhalt");
  const halt = d.halt;
  h.hidden = !d.halted;
  if (!d.halted) return;
  if (!halt) {
    h.innerHTML = "<strong>This account is paused.</strong> " + esc(d.haltReason || "No reason recorded.");
    return;
  }

  const since = halt.sinceIso ? " Paused " + when(halt.sinceIso) + "." : "";
  /* Opening equity and the level, because "10%" of an unnamed number is not a fact
     anybody can act on. Both come from the ledger row, so they render when Hyperliquid
     is unreachable. */
  const level = d.haltAtUsd == null ? ""
    : " The day opened at " + fmtUsd(d.dayStartEquityUsd) + ", so it pauses at −"
      + money(d.haltAtUsd) + ".";

  const day = halt.closedToday;
  const down = day.filter((t) => (t.netUsd ?? 0) < 0).length;
  let table = "";
  if (day.length > 0) {
    /* Worst first, and the share of each position's own margin beside the dollars —
       that is the number the stop and the leverage set, and it is what makes a −38%
       row read as a setting rather than as bad luck. */
    table = '<div class="haltday">'
      + day.length + " trade" + (day.length === 1 ? "" : "s") + " closed today, "
      + down + " of them down:</div><ul class=\"haltlist\">"
      + day.slice(0, 5).map((t) =>
        "<li>" + esc(t.coin) + " " + esc(t.side) + " — "
        + esc(CLOSE_WORDS[t.reason ?? ""] ?? (t.reason ?? "closed")) + ", "
        + (t.netUsd == null ? "not settled yet" : fmtSigned(t.netUsd))
        + (t.ofMargin == null ? "" : " (" + (t.ofMargin * 100).toFixed(1) + "% of its margin)")
        + "</li>").join("")
      + "</ul>";
  }

  const action = halt.pending
    ? '<p class="haltact">Asked to resume — it applies on the desk&rsquo;s next loop.</p>'
    : halt.clearable
      ? '<p class="haltact"><button class="btn ghost sm" id="dunhalt">Resume trading</button></p>'
      : '<p class="haltact">' + esc(halt.why) + "</p>";

  h.innerHTML = "<strong>This account is paused.</strong> " + esc(halt.reason) + "."
    + esc(since) + esc(level) + table + action;

  const b = $<HTMLButtonElement>("dunhalt");
  if (!b) return;
  b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Resuming…";
    try {
      await api("/api/halt/clear", { method: "POST" });
      reload();
    } catch (e) {
      b.disabled = false; b.textContent = "Try again";
      /* Into the banner it came from, not an alert: the refusal is about this halt and
         belongs next to it. The executor re-checks as well, so this is also where a
         verdict that changed between the page load and the press lands. */
      h.insertAdjacentHTML("beforeend", '<p class="haltact">' + esc((e as Error).message) + "</p>");
    }
  });
}

/* What the net figure is made of (tasks/27 §5, tasks/29), and the rule that makes it
   cheap in Phase 5.

   Two kinds of row, in the owner's order. **Venues** come first and each appears only
   when it holds something: a line reading `Polymarket —` would be an advertisement in
   the space where a number goes, on the screen a person opens to see their money. Once
   Phase 5 ships, an unconnected Polymarket gets a `Link` button on that row instead —
   the offer of a venue is a control and belongs to be read as one, which is what this
   list was already written to allow. With one venue there is no venue row at all,
   because a split of one is not a split and the figure above already is it.

   **Positions and Cash** come second and are always here. They are the venue's own
   arithmetic about the whole account — `equity − free` and `free` — and they add to the
   number above by construction rather than by two reads agreeing. They are deliberately
   *not* `atRiskUsd`, which is margin we committed, from the intent ledger: that one
   excludes a position the owner opened by hand and this one must not.

   Phase 5 pushes `["Polymarket", d.pmBalanceUsd, "link"]` onto `venues` and shows the
   note. That is the whole change. */
type VenueRow = { name: string; usd: number | null; link?: boolean };

function renderBalance(d: Desk): void {
  const el = $("dvenues");
  const venues: VenueRow[] = [{ name: "Hyperliquid", usd: d.balanceUsd }];
  const shownVenues = venues.filter((v) => v.usd != null || v.link);
  // One venue is the figure above restated. Two or more and the reader needs to know
  // which is which — and only then does "added together" describe anything.
  const rows = (shownVenues.length > 1 ? shownVenues : [])
    .concat([{ name: "Positions", usd: d.positionsUsd }, { name: "Cash", usd: d.cashUsd }]);
  const cell = (r: VenueRow) => r.usd == null && r.link
    ? '<button class="vlink" type="button">Link</button>'
    : fmtUsd(r.usd);
  el.hidden = d.positionsUsd == null && d.cashUsd == null;
  el.innerHTML = el.hidden ? ""
    : rows.map((r) => "<div><b>" + esc(r.name) + "</b><span>" + cell(r) + "</span></div>").join("");
  $("dvnote").hidden = shownVenues.length < 2;
}

/* ── The equity curve (tasks/29) ──────────────────────────────────────────────
 *
 * A second fetch, after the desk and never blocking it: `/api/desk/history` is 18.8 KB
 * of Hyperliquid's own `portfolio` series and the balance above it renders without
 * them. A failure here leaves the card without a chart and the rest of the desk
 * untouched, which is the right trade for an illustration of history beside a live
 * number — so this path has no error banner, only silence.
 *
 * **What is plotted is `pnl`, never `nav`.** `pnlHistory` is deposit-adjusted and
 * `accountValueHistory` is not: on the measured account the second climbed $0 → $115
 * while the first stayed at −$181, because the climb was money paid in. A chart of
 * account value would draw a deposit as a profit, on the screen somebody opens to
 * check exactly that. `notes/2026-09-08-balance-chart-feasibility.md`.
 *
 * The window figure under the net asset value is the change *across* the window, which
 * the server computes for the same reason: `pnl` is cumulative since the account
 * opened, so its last point under a tab reading 24H would be an all-time number.
 */
const WINDOW_LABELS: Record<PortfolioWindow, string> = {
  day: "past 24 hours", week: "past 7 days", month: "past 30 days", allTime: "since you opened this account",
};

let chart: Chart | null = null;
let history: Portfolio | null = null;
let historyFor: string | null = null;
let activeWindow: PortfolioWindow = "week";

/** Paint the selected window: the line, the figure, the label, and which tab is on. */
function paintWindow(): void {
  const s = history?.[activeWindow];
  for (const b of $$<HTMLElement>("#dwin button")) {
    b.setAttribute("aria-selected", String(b.dataset.win === activeWindow));
  }
  // Two points is the floor for a line. Below it the card keeps its figure and drops
  // the drawing, rather than showing an empty box where a chart was a moment ago.
  const drawable = (s?.points.length ?? 0) >= 2;
  $("dplotwrap").hidden = !drawable;
  if (drawable) $("dplotnone").hidden = true;
  if (drawable) {
    chart ??= makeChart($<SVGSVGElement>("dplot"));
    chart.draw(s!.points.map((p) => ({ t: p.t, v: p.pnl })));
  }
  /* Dollars and the share of what the account was worth when the window opened, in the
     shape every result on this site takes. The percentage is the server's — the same
     series the line is drawn from — rather than this page dividing two numbers it was
     handed, so the figure and the curve cannot disagree.

     A dash where the ratio is unknown: an account that opened the window below a
     dollar has a true return in the hundreds of thousands of percent, and printing it
     would be alarming rather than informative. */
  const change = s?.changeUsd ?? null, ratio = s?.changePct ?? null;
  $("dwinrow").hidden = change == null;
  // `pct` takes a percentage and `changePct` is a fraction, which is the boundary
  // convention everything else crossing this API follows (`dailyLossPct`, `reserveFrac`,
  // `correlatedStopOfMandate`) — `share()` is the helper that does the ×100 for the
  // figures computed on this side, and there is nothing to compute here.
  $("dwinpl").textContent = fmtSigned(change) + " · " + (ratio == null ? "—" : pct(ratio * 100, 1));
  $("dwinpl").className = "pv num " + (change != null && change < 0 ? "down" : "up");
  $("dwinlab").innerHTML = esc(WINDOW_LABELS[activeWindow]) + "<em>everything on the venue</em>";
}

/* The demo curve, for the desk a signed-out visitor reaches through *See the desk*.
 *
 * Every other figure on that screen is invented and the banner at the top says so, so
 * an empty chart card would be the one place the preview stopped previewing. It is
 * deterministic — a seeded walk, not `Math.random()` — because a screenshot of this
 * page should be the same page tomorrow, and because the four windows have to be
 * consistent with each other when somebody presses the tabs.
 *
 * Scaled to the demo account's $117.25 and to the product's own story: a −$3 stop is
 * the fixed loss the home page draws, and roughly one trade in three takes it.
 */
function demoPortfolio(): Portfolio {
  // Chosen, not arbitrary. The process below is right — a third of trades take the
  // −$3 stop, winners average $2, seven trades a week — but any one stretch of it is
  // as lucky as its seed, and the first one tried drew a +$9 week on a $117 account.
  // 773 is the lowest seed whose four windows all sit near what the process predicts.
  let a = 773;
  const rnd = (): number => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  // One walk, sampled at four resolutions, so `All` contains `30D` contains `7D` — the
  // windows are four views of one history and would not be believable otherwise.
  const STEP_MS = 2 * 3_600_000;                    // Hyperliquid's own ~2-hourly grid
  const N = 480;                                    // 40 days of it
  const walk: number[] = [];
  let pnl = 0;
  for (let i = 0; i < N; i++) {
    // A third of the trades take the −$3 stop the home page draws, and the winners
    // average $2. That comes to about +$2 a week on a $117 account, which is what the
    // demo desk's own `realised, 7 days` says beside it — the preview should not
    // quietly promise a 15% week.
    if (rnd() < 0.09) pnl += rnd() < 0.34 ? -3 : 1.2 + rnd() * 1.6;
    walk.push(pnl + (rnd() - 0.5) * 0.16);
  }
  const now = Date.now();
  const at = (i: number) => now - (N - 1 - i) * STEP_MS;
  const window = (points: number): PortfolioSeries => {
    const from = Math.max(0, N - points);
    const base = walk[from]!;
    const out = walk.slice(from).map((v, k) => ({ t: at(from + k), nav: 117.25 - (walk[N - 1]! - v), pnl: v }));
    const change = out.length ? out[out.length - 1]!.pnl - base : null;
    const nav = out[0]?.nav ?? 0;
    return { points: out, changeUsd: change, changePct: change !== null && nav >= 1 ? change / nav : null };
  };
  return { day: window(13), week: window(84), month: window(360), allTime: window(N) };
}

/** Registered once, at wiring time, like every other control on this screen.
 *
 *  It also paints the demo curve, which is why this runs at load rather than on the
 *  first desk view: the preview is what a signed-out visitor sees, and `deskPending`
 *  clears it the moment there is a real account to draw instead. */
export function wireChart(): void {
  history = demoPortfolio();
  historyFor = null;
  $("dwin").hidden = false;
  $("dplotnone").hidden = true;
  paintWindow();
  for (const b of $$<HTMLElement>("#dwin button")) {
    b.addEventListener("click", () => {
      const w = b.dataset.win as PortfolioWindow | undefined;
      if (!w || w === activeWindow) return;
      activeWindow = w;
      paintWindow();
    });
  }
}

/** Everything the chart draws, cleared, and the card told what it is waiting for.
 *
 *  Called where the desk itself is cleared, so a session change cannot leave one
 *  account's curve under another account's balance — and never leaves the card as a
 *  bare `Profit / loss` over an empty box while the second fetch is in the air. */
function resetChart(why = "Loading this account's history…"): void {
  history = null; historyFor = null;
  $("dwin").hidden = true; $("dplotwrap").hidden = true; $("dwinrow").hidden = true;
  $("dplotnone").hidden = false;
  $("dplotnone").textContent = why;
}

async function loadHistory(who: string): Promise<void> {
  if (historyFor === who && history) return;               // already have this account's
  try {
    const h = await api<Portfolio>("/api/desk/history");
    if (getMe()?.address !== who) return;                   // a slow reply for a session that ended
    history = h; historyFor = who;
    $("dwin").hidden = false;
    paintWindow();
  } catch (e) {
    /* Three outcomes, and the difference is worth saying out loud rather than showing
       one shrug for all of them. The route answers 404 for a paper account — its book
       is ours, in `paper_positions`, and Hyperliquid has no history of it — and that is
       a fact about the account rather than a failure. The other two are ours.

       None of them is worth the banner at the top of the screen: the balance, the
       positions and the whole history tab are on screen and correct, and the chart is
       the one thing that is not. */
    resetChart((e as ApiError).status === 404
      ? (e as Error).message                  // the route's own sentence; it knows which
      : "Could not read this account's history from Hyperliquid just now.");
  }
}

/* The account's own facts, on the settings screen (tasks/27 §7).

   The approval date is the quiet half of the agent story, and it is here rather than
   nowhere because "we never mention agents at all" is how somebody reaches the last day
   of one without having seen the word. The loud half — the note when an approval is
   close or gone — stays on the desk, where it interrupts. */
function renderAccount(d: Desk): void {
  const rows = [kv("Address", d.address)];
  if (d.connectedAt) rows.push(kv("Managing since", dayOf(d.connectedAt)));
  if (d.agent && d.agent.state === "healthy") rows.push(kv("Approval runs to", dayOf(d.agent.expiresAt)));
  $("dacct").innerHTML = rows.join("");
  // What we charge, under the rest of the account's terms, because that is what it is.
  // It renders nothing at all while the rail is off, which is every account today.
  renderFee(d.fee, $("dfee"), () => { void loadDesk(); });
}

function renderDesk(d: Desk): void {
  $("demo").hidden = true;
  renderFeed(d.feed);
  $("dbal").textContent = fmtUsd(d.balanceUsd);
  renderBalance(d);
  renderHalt(d);

  $("dmode").innerHTML = '<span class="dot"></span>' + (d.halted ? "Halted" : (d.mode === "live" ? "Live" : "Paper"));
  $("dmode").className = "pill " + (d.halted ? "down" : (d.mode === "live" ? "up" : "acc"));
  /* Two badges that used to sit here in every state, and now appear only when they are
     telling somebody something (owner, 2026-09-08: *"I still don't understand use case
     and value for user. Feels like it is overcomplicated."*).

     They were right about the display and it is worth being exact about what changed:
     **nothing about the behaviour did.** Stops still rest on Hyperliquid as reduce-only
     trigger orders and a position we did not open still halts the account — those are
     hard rules in CLAUDE.md and are not a display decision. What came off is the
     always-on label.

     `Stops resting on the exchange` was the weaker of the two: on a live desk every
     position card already draws its stop on the track and names it in the sentence
     underneath, so the badge restated what was on screen three inches below it. In
     **paper** it is not a restatement — it is the only thing on the desk that says
     these figures are simulated — so that is the one state it survives in.

     The foreign-position count is the same shape of argument. Zero is the normal case
     and silence is the honest rendering of *nothing happened*; above zero the account
     is halted and `#dhalt` says so at the top of the screen in red, so a second red
     badge beside the tabs was a duplicate of a banner nobody can miss. It stays for the
     case where the count is non-zero without a halt, which should not happen and is
     exactly why it should not be silent. */
  $("dstops").hidden = d.mode === "live";
  $("dstops").textContent = "Simulated book, priced off live marks";
  /* The testnet marker, beside the mode rather than at the bottom of a stack. A testnet
     desk reads $0.00 against a mainnet-funded account and is otherwise identical to a
     real one, which is the mistake that wastes the most time (CLAUDE.md). */
  $("dnet").hidden = d.network !== "testnet";
  const fp = d.foreignPositions;
  $("dforeign").hidden = fp === 0;
  $("dforeign").textContent = fp + (fp === 1 ? " position" : " positions") + " we did not open";

  renderHaltBanner(d, () => { void loadDesk(); });

  renderAgent(d.agent);

  /* The counts ride in the tabs (tasks/27 §2), which is where `3 open · 5 allowed`
     went: it is a fact about the Open tab and reads better as its number. */
  $("tnopen").textContent = String(d.openCount);
  $("tnhist").textContent = String(d.taken);
  $("tnskip").textContent = String(d.skipped);
  /* And what is left of that stack — what is at risk, and against what ceiling — is a
     fact about the open positions, so it sits over them. */
  $("dopenmeta").textContent = fmtUsd(d.atRiskUsd) + " at risk of " + fmtUsd(d.maxAtRiskUsd)
    + " · " + d.openCount + " of " + d.maxOpen + " positions";

  /* The week is only shareable once something has closed, and the button says so when
     pressed rather than being absent. Hidden for a signed-out visitor reading the demo
     desk, whose "week" is not an account at all. */
  $("dsharewrap").hidden = !d.connected;

  $("dpos").innerHTML = d.positions.length
    ? d.positions.map(posCard).join("")
    : '<div class="card pad" style="color:var(--dim)">Nothing open. '
    + 'Skips are the limits working — an empty list would mean something is broken.</div>';
  // The cards are rebuilt on every poll, so their share buttons are rewired here for
  // the same reason the history's are after each page.
  wireShareButtons();

  renderAccount(d);
  // The whole limits card, controls and all (`design/src/deskLimits.ts`). It rebuilds
  // its own markup and rewires it, so nothing here reaches inside it.
  renderLimits(d, () => { void loadDesk(); });
  // An operator's file pins this account: the executor would re-admit it from the file
  // on the same loop, so an unlink is a request it cannot honour — and the limits card
  // says so in words, which is what was missing when this was two hidden buttons.
  $("dleaving").hidden = d.changes?.pinned === true;
  const refused = $("drefused");
  refused.hidden = !d.changes?.refused;
  if (d.changes?.refused) refused.innerHTML = "<strong>Not applied.</strong> " + esc(d.changes.refused);

  $("dskips").innerHTML = d.skipReasons.length
    ? d.skipReasons.map((r) => kv(r.label, r.count)).join("")
    : kv("Nothing skipped yet", "0");
}

/* The desk ships with demo content, which is right for a visitor and wrong for
   everybody else. Revealing it and then awaiting /api/desk painted another balance
   for ~300ms warm and ~900ms cold — long enough to read, and long enough to feel
   like a stall. So: prefetch as soon as there is an account to fetch for, and render
   whatever we already have **synchronously**, in the same task that unhides the view.
   The browser paints at the end of a task, so the first frame the user sees is
   already theirs; a cold cache gets dashes and never the demo numbers.

   A warm render is still refreshed from the network, because desk figures go stale.

   The cache carries the address it belongs to rather than being cleared at each of
   sign-out, unlink and sign-in separately — one missed path there would show one
   account another account's balance, and a dash is cheaper than that. */
let deskCache: Desk | null = null, deskCacheFor: string | null = null;
let deskInflight: Promise<Desk> | null = null, deskInflightFor: string | null = null;

export function fetchDesk(): Promise<Desk> {
  const who = getMe()?.address ?? null;
  if (deskInflight && deskInflightFor === who) return deskInflight;
  deskInflightFor = who;
  deskInflight = api<Desk>("/api/desk").then((d) => {
    deskInflight = null;
    if (who && who === (getMe()?.address ?? null)) { deskCache = d; deskCacheFor = who; }
    return d;
  }, (e) => { deskInflight = null; throw e; });
  return deskInflight;
}

function deskPending(): void {
  $("demo").hidden = true; $("dhalt").hidden = true; $("dstops").hidden = true;
  $("dagent").hidden = true; $("dhaltline").hidden = true;
  $("dforeign").hidden = true; $("dnet").hidden = true; $("dvenues").hidden = true;
  $("dbal").textContent = "…";
  $("dmode").innerHTML = '<span class="dot"></span>Loading'; $("dmode").className = "pill quiet";
  $("dopenmeta").textContent = "";
  $("dpos").innerHTML = '<div class="card pad" style="color:var(--dim)">Loading your positions…</div>';
  for (const id of ["tnopen", "tnhist", "tnskip"]) $(id).textContent = "";
  $("dacct").innerHTML = "";
  $("dlimits").innerHTML = ""; $("dskips").innerHTML = ""; $("drefused").hidden = true;
  resetChart();
}

/* Both lists belong to one account. Emptied on a session change, so nobody is shown
   another account's refusals for the second before the next fetch lands — and the tab
   row goes back to Open, because a signed-in reader landing on somebody else's History
   is the same fault with an extra step.

   The panes are emptied rather than hidden: the tab decides what is on screen now, and
   a pane that was both hidden here and shown by `selectTab` would have two owners. */
function resetSignals(): void {
  sigLoaded = false;
  $("dsig").innerHTML = "";
  histLoaded = false;
  histCursor = null;
  $("dhist").innerHTML = "";
  $("dhistmorewrap").hidden = true;
  if (activeTab !== "open") selectTab("open");
}

export async function loadDesk(): Promise<void> {
  const who = getMe()?.address;
  if (!who) return;                       // logged out keeps the demo, banner and all
  if (deskCacheFor === who && deskCache) renderDesk(deskCache);   // instant, and before the first paint
  else deskPending();
  if (!sigLoaded && !histLoaded) resetSignals();
  // Started here and deliberately not awaited: it is a second round trip for an
  // illustration, and the balance it sits beside must not wait on it (tasks/29).
  void loadHistory(who);
  try {
    const d = await fetchDesk();
    if (getMe()?.address === who) renderDesk(d);       // a slow reply for a session that ended is dropped
  } catch (e) {
    if ((e as ApiError).status === 401) { sessionExpired(); return; }
    const h = $("dhalt"); h.hidden = false;
    h.innerHTML = "<strong>Could not load your desk.</strong> " + esc((e as Error).message);
  }
}
