import { api, type ApiError, type Leaderboard, type LeaderboardRow } from "./api.ts";
import { $, $$, dayOf, esc, money, pctOf } from "./dom.ts";
import { shortAddr } from "./dom.ts";
import { show, type View } from "./views.ts";

// Every account we trade, ranked, for the people whose accounts they are.
//
// The only screen here that draws a figure belonging to someone else, and the route
// behind it wants a session *and* a live account of the reader's own — so everybody
// who can open this page is on it. Both refusals are rendered as sentences rather than
// as an empty table: 401 means the session went, 403 means this reader has no live
// account yet, and those are different things to do about it.

/** A percentage with its sign kept. `pctOf` drops it, which is right for a win rate
 *  and wrong for a return — "1.8%" and "−1.8%" are the two answers that column
 *  exists to tell apart. */
function signedPct(f: number | null): string {
  return f == null ? "—" : (f < 0 ? "−" : "+") + pctOf(Math.abs(f));
}

/** A minus sign rather than a hyphen, matching `signed()` in dom.ts. */
function pnl(n: number): string {
  return (n < 0 ? "−" : "+") + money(n);
}

/* The column names, and the only place they are written: the header row maps over
 * this, and `lbl()` reads the same array by index for the phone layout. */
const HEADINGS = ["#", "Account", "Mandate", "Trades", "Wins", "Win rate", "Net P&L", "Return"];

/** How this account is traded, in four badges under its address.
 *
 *  This is the column the table existed without until 2026-09-10 and the reason it now
 *  has it: every account here trades **the same signals**, so the settings are the only
 *  difference between the rows. A ranking without them says who is ahead and withholds
 *  why.
 *
 *  Each badge carries its own label. The alternative — four bare values in a fixed order
 *  with a key in the footer — is shorter and makes the reader hold the order in their
 *  head to read a row, which is the opposite of what a comparison table is for.
 *
 *  The exit uses the connect screen's own words. "Signal change" and "target hit" are
 *  what the control is labelled, and `design/views/connect.html` is explicit that this is
 *  *not* called "withdraws the forecast": a call leaves the book when its side turns
 *  null, and the feed is ~95% no-direction, so "neutral" is the ordinary case and
 *  "withdrawn" would describe the rare one. */
function settingsBadges(r: LeaderboardRow): string {
  const s = r.settings;
  if (s === null) return "";
  const badge = (label: string, value: string) => "<span><b>" + esc(label) + "</b> " + esc(value) + "</span>";
  // Trailing zeros trimmed, because 1.5% and 3% both occur and "3.0%" beside "1.5%"
  // reads as more precision than anybody chose.
  const pct = (f: number) => +(f * 100).toFixed(2) + "%";
  return '<span class="lbset">'
    + badge("lev", s.leverage + "×")
    + badge("size", pct(s.perSignalPct))
    // "no stop" rather than an omitted badge: an account running without one is the most
    // consequential setting on this table, and a missing badge reads as missing data.
    + (s.stopPct === null ? "<span><b>stop</b> none</span>" : badge("stop", pct(s.stopPct)))
    + badge("exit", s.holdToTarget ? "target hit" : "signal change")
    + "</span>";
}

function row(r: LeaderboardRow): string {
  const cls = r.netPnlUsd < 0 ? "down" : "up";
  // Below 720px the header is gone and these cells are bare numbers with nothing
  // naming them, so each carries its own heading. `HEADINGS` is the source for both,
  // which is the point — a label written twice is a label that drifts. The cells are
  // in the same order as that array and `lbl()` reads the two together by index.
  const cells = [
    '<span class="num" style="color:var(--dim)">' + r.rank + "</span>",
    '<span><span class="mono">' + esc(shortAddr(r.account)) + "</span>"
      // On its own line rather than beside the address: inline, it fitted for some
      // widths and wrapped for others, so the row height moved with the wording.
      + (r.halted ? '<span class="lbflag"><span class="pill down">Halted</span></span>' : "")
      + settingsBadges(r)
      + "</span>",
    '<span class="num"' + lbl(2) + ">" + money(r.mandateUsd) + "</span>",
    '<span class="num"' + lbl(3) + ">" + r.trades + "</span>",
    '<span class="num"' + lbl(4) + ">" + r.wins + "</span>",
    '<span class="num"' + lbl(5) + ">" + (r.winRate == null ? "—" : pctOf(r.winRate)) + "</span>",
    '<span class="num ' + cls + '"' + lbl(6) + ">" + pnl(r.netPnlUsd) + "</span>",
    '<span class="num ' + cls + '"' + lbl(7) + ">" + signedPct(r.returnFrac) + "</span>",
  ];
  return '<div class="trow lbg">' + cells.join("") + "</div>";
}

/** The nth heading as a `data-label`, for the CSS that draws it when the header row is
 *  hidden. Rank and account are the card's own first line and are not labelled. */
function lbl(i: number): string {
  return ' data-label="' + esc(HEADINGS[i] ?? "") + '"';
}

/** What the numbers mean, under the table rather than in a tooltip.
 *
 *  Every clause is load-bearing and each was a decision in
 *  `src/web/leaderboard.ts`: the denominator is the mandate and not a lifetime
 *  starting balance, the P&L is the venue's own fills, the operator tests are out, and
 *  a trade nothing could settle is in none of the three middle columns. A table of
 *  other people's returns that does not say how it was computed is the thing this
 *  project keeps `notes/` to avoid. */
function footer(b: Leaderboard): string {
  const unsettled = b.rows.reduce((n, r) => n + r.unsettled, 0);
  const stale = b.heartbeatAgeSeconds != null && b.heartbeatAgeSeconds > 300
    ? "The desk last reported " + Math.round(b.heartbeatAgeSeconds / 60) + " minutes ago. "
    : "";
  return "<strong>Net P&amp;L</strong> is each account's own fills, fees and funding as Hyperliquid "
    + "reported them — not an estimate. <strong>Return</strong> is that figure against the mandate the "
    + "account is traded at now, which is the only starting number the ledger holds; it is not a "
    + "lifetime return. <strong>Trades</strong> counts closed trades we could settle from fills"
    + (unsettled > 0
      ? ", and " + unsettled + (unsettled === 1 ? " trade is" : " trades are")
        + " left out because no venue fills could be attributed to " + (unsettled === 1 ? "it" : "them")
        + " — neither a win nor a loss"
      : "")
    + ". "
    // Why the badges are here at all, in one sentence: without it a reader can see four
    // settings beside a return and reasonably conclude the table is claiming one caused
    // the other, on samples this small.
    + "The badges under each address are how that account is traded — <strong>every account here "
    + "takes the same signals</strong>, so those four settings are the only difference between "
    + "these rows. <strong>They are not why one is ahead:</strong> a few dozen trades cannot "
    + "separate a setting from a run of luck. "
    + (b.excludedIntents > 0 ? b.excludedIntents + " operator-test trades are excluded. " : "")
    + (b.awaitingFirstTrade > 0
      ? b.awaitingFirstTrade + " account" + (b.awaitingFirstTrade === 1 ? " has" : "s have")
        + " not closed a trade yet and " + (b.awaitingFirstTrade === 1 ? "is" : "are") + " not listed. " : "")
    + esc(stale)
    + "<strong>Past results. Not a forecast, not advice.</strong>";
}


let loaded = false;

export async function loadLeaderboard(force = false): Promise<void> {
  const box = $("lbbox"), btn = $<HTMLButtonElement>("lbrefresh");
  if (loaded && !force) return;
  box.innerHTML = '<div class="card pad" style="color:var(--dim)">Loading…</div>';
  btn.disabled = true;
  try {
    const b = await api<Leaderboard>("/api/leaderboard");
    loaded = true;
    $("lbmeta").textContent = b.rows.length
      ? b.rows.length + (b.rows.length === 1 ? " account" : " accounts") + " · as of " + dayOf(b.generatedAt)
      : "";
    box.innerHTML = b.rows.length
      ? '<div class="tbl"><div class="tscroll"><div class="thead lbg">'
        + HEADINGS.map((h) => "<span>" + esc(h) + "</span>").join("")
        + "</div>" + b.rows.map(row).join("") + "</div>"
        + '<div class="tfoot">' + footer(b) + "</div></div>"
      /* Empty is a state, not an error — but there are two ways to reach it and they
         are not the same news. No heartbeat means the desk is not reporting, which is
         about us; an empty roster with a live heartbeat means nobody has closed a
         trade yet, which is about the accounts. */
      : '<div class="card pad" style="color:var(--dim)">'
        + (b.heartbeatAgeSeconds == null
          ? "The desk is not reporting just now, so there is nothing to rank."
          : "No account we are trading has closed a trade yet.")
        + "</div>";
  } catch (e) {
    const status = (e as ApiError).status;
    box.innerHTML = status === 403 || status === 401
      ? '<div class="note">' + esc((e as Error).message) + "</div>"
      : '<div class="note warn">Could not load the leaderboard just now. '
        + esc((e as Error).message) + "</div>";
    // A 403 is a standing answer, not a hiccup: this reader has no live account, and
    // pressing Refresh will say the same thing until that changes.
    if (status === 403) loaded = true;
  } finally {
    btn.disabled = false;
  }
}

/** Where Back goes.
 *
 *  Not `data-go="home"`, which is wired in `main.ts` to sign the reader out — this
 *  screen is reachable from the desk, and a nav control that ends someone's session
 *  because they looked at a table would be a genuinely bad surprise. */
let cameFrom: View = "home";

export function wireLeaderboard(): void {
  $$("[data-lb]").forEach((b) => {
    b.addEventListener("click", () => {
      const here = (["home", "connect", "desk"] as View[]).find((v) => !$("v-" + v).hidden);
      cameFrom = here ?? "home";
      show("leaderboard");
    });
  });
  $("lbback").addEventListener("click", () => show(cameFrom));
  $("lbrefresh").addEventListener("click", () => void loadLeaderboard(true));
}

/** The button is offered only to a reader who can actually open the page.
 *
 *  Called from `paintChrome`, which is the one place that reflects the session in the
 *  chrome. A signed-out visitor is not shown a control whose only outcome is a
 *  refusal — but the refusal still exists, because a session can lapse between the
 *  paint and the click. */
export function paintLeaderboardChrome(live: boolean): void {
  $$("[data-lb]").forEach((b) => { b.hidden = !live; });
  if (!live) loaded = false;
}
