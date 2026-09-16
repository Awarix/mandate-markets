// The limits card on the desk: the three settings changed where they are stated.
//
// `tasks/18` §9, written from the owner's first use of the deployed change flow. The
// controls used to live on the connect screen, reached by a *Change limits* button that
// re-opened step 3 in a change mode — a second screen for a routine edit, hidden
// altogether on an account pinned by an operator's file. Which is how the owner, wanting
// the sliders on our own pinned account, reached for *Stop managing my account* instead
// and produced `notes/2026-09-04-pinned-account-unlink-loop.md`: seven release/re-admit
// cycles on a live account, from one button press.
//
// So: the controls sit in the card that states the limits, each with what it costs in
// dollars beside it, and one button. The scary button moved the other way, into its own
// section at the bottom of the desk. And a pinned account now *says* it is pinned, rather
// than merely showing two missing buttons.
//
// The arithmetic is `limitsMath` — the same pure copy the connect screen recomputes on
// every drag, which `limits.test.ts` pins to the server's `haltDistance`. So the numbers
// somebody reads while dragging a slider are the numbers the desk shows them once the
// executor has applied the change, and the ones the operator's startup warning uses.

import { api, type Desk } from "./api.ts";
import { $, dayOf, esc, fmtUsd, kv, money, pctOf } from "./dom.ts";
import { CLAMP_PCT, limitsMath, limitsNote } from "./limits.ts";
import { isShowing } from "./views.ts";

/** What the controls currently read, which is not what is in force until the executor
 *  says so. Percent units throughout, because that is what the sliders speak. */
export type Draft = { lev: number; stopPct: number; per: number; on: boolean; hold: boolean };

/* The draft survives a re-render — `renderDesk` runs twice on a warm cache — but must
   not survive a change in what the server says, or a request that has just been applied
   would be overwritten on screen by the half-dragged state that produced it. So it is
   keyed on the server's own view of the limits and re-seeded whenever that moves. */
let draft: Draft | null = null;
let draftKey: string | null = null;

/* One timer, replaced on every render. While a change is pending the card counts down to
   the next executor loop, and this is what makes that count true: the desk refetches
   itself once the loop should have happened, and the line becomes "In force since …". It
   is not a poll — it stops the moment the request is spent, and gives up after ten loops
   so a desk left open for a week is not still asking. */
let waitTimer: ReturnType<typeof setTimeout> | null = null;
let waits = 0;
let waitingFor: string | null = null;
const MAX_WAITS = 10;

function clearWait(): void {
  if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
}

/** The heartbeat's own staleness rule, as the connect screen applies it. */
function executorDown(d: Desk): boolean {
  return d.executorSeenSecondsAgo === null || d.executorSeenSecondsAgo > 300;
}

/** Seconds until the executor's next loop, floored at zero. Null when nothing is
 *  looping, where a countdown would be a promise we cannot keep. */
export function secondsToLoop(d: Desk): number | null {
  if (executorDown(d)) return null;
  return Math.max(0, Math.round(d.loopIntervalSec - (d.executorSeenSecondsAgo as number)));
}

/** What the server says the limits are, or are about to be. A pending request is what
 *  this person last asked for, so it — not the older applied row — is what the controls
 *  come back to. */
function serverDraft(d: Desk): Draft | null {
  const p = d.changes?.pendingSettings?.settings;
  if (p) {
    return {
      lev: p.leverage, stopPct: p.stopPct * 100, per: p.perSignalPct * 100, on: p.stopLoss,
      hold: p.holdToTarget === true,
    };
  }
  const L = d.limits;
  if (!L || L.leverage == null || L.stopPct == null || L.perSignalPct == null || L.stopLoss == null) return null;
  // `holdToTarget` is never null on the wire — a row written before it existed was
  // traded on the closing policy, which is what `false` says — so it does not join the
  // guard above. Missing here would mean "unreadable", and this one is readable.
  return {
    lev: L.leverage, stopPct: L.stopPct * 100, per: L.perSignalPct * 100, on: L.stopLoss,
    hold: L.holdToTarget === true,
  };
}

/** With the stop off the distance is not part of the settings in force — the executor
 *  places no stop at all — so moving that slider is not a change to ask for. */
export function same(a: Draft, b: Draft): boolean {
  return a.lev === b.lev && a.per === b.per && a.on === b.on && a.hold === b.hold
    && (!a.on || a.stopPct === b.stopPct);
}

/** The mandate and what the account holds. They are equal for exactly one day; when they
 *  differ materially the card offers the re-read (`tasks/18` §4). Exported for its test
 *  and used only here — the desk's balance block used to state the same pair beside the
 *  balance, and lost it to tasks/27 §5 along with the other nine numbers up there. */
export function holdsMore(d: Desk): boolean {
  if (d.mandateUsd == null || d.balanceUsd == null) return false;
  return Math.abs(d.balanceUsd - d.mandateUsd) >= Math.max(1, 0.01 * d.mandateUsd);
}

/* Never a field: the deposit is the size, and a typed number is either money that is not
   there or the ceiling this project removed, put back in the owner's hands. Pressed, the
   request waits for the book to be flat — and the sentence beside it says what not to do
   meanwhile, because a close placed by hand on Hyperliquid is a fill we did not place,
   which halts the account. */
function mandateRow(d: Desk): string {
  const row = kv("Mandate", fmtUsd(d.mandateUsd) + (holdsMore(d) ? " · you hold " + fmtUsd(d.balanceUsd) : ""));
  const c = d.changes;
  if (!c) return row;
  if (c.pendingMandate) {
    const n = d.openCount;
    const when = n === 0
      ? "Update requested · applies on the next loop."
      : "Update requested · applies once your " + n + " open position" + (n === 1 ? " has" : "s have")
        + " closed. " + (n === 1 ? "It keeps" : "They keep") + " the mandate " + (n === 1 ? "it" : "they")
        + " opened under. Do not close " + (n === 1 ? "it" : "them") + " on Hyperliquid yourself — a fill we "
        + "did not place halts the account.";
    return row + '<div class="kvnote">' + esc(when) + "</div>";
  }
  if (holdsMore(d) && d.balanceUsd != null) {
    return row + '<div class="kvnote"><button class="btn ghost sm" id="dmandate">Update mandate to '
      + esc(money(d.balanceUsd)) + "</button> <span>what the account holds"
      + (d.openCount > 0 ? "; applies once nothing is open" : "") + "</span></div>";
  }
  return row;
}

/* The read-only card: an account pinned by an operator's file, and any account whose
   settings could not be read. The stop-out sentence here is the **server's**
   `haltDistance` rather than the page's copy of it — there is no draft to price, and the
   one figure on this screen computed by the executor's own arithmetic is worth showing
   where nothing is in the way of it. */
function readOnly(d: Desk, why: string): string {
  const L = d.limits, s = d.stopOut;
  const off = L?.stopLoss === false;
  return mandateRow(d)
    + (L
      ? kv("Leverage", L.leverage == null ? "—" : L.leverage + "×")
      + kv("Stop", off ? "off" : pctOf(L.stopPct) + " of the price")
      + (s
        ? '<div class="kvnote">' + esc(
          (off
            ? "No stop — a position can lose its whole margin, " + money(s.usd) + " · " + pctOf(s.ofMandate)
              + " of the mandate, before its deadline. "
            : "A stop-out costs " + money(s.usd) + " · " + pctOf(s.ofMandate) + " of the mandate · "
              + pctOf(s.ofMargin) + " of the position's margin. ")
          + (s.stopsToHalt < 1
            ? "A single one pauses the account for the day."
            : "About " + s.stopsToHalt.toFixed(1) + (off ? " such losses" : " stopped positions")
              + " in one day pause the account."),
        ) + "</div>"
        : "")
      + kv("Per position", pctOf(L.perSignalPct)
        + (d.mandateUsd != null && L.perSignalPct != null ? " · " + money(d.mandateUsd * L.perSignalPct) : ""))
      // Spelled out rather than named. "Signal change" is the control's label, which is
      // vocabulary the reader has only if they have seen the control — and this branch
      // renders precisely when they cannot (pinned, halted, or nothing readable).
      + kv("Exit behaviour", L.holdToTarget ? "hold to target or stop" : "close on signal change")
      : kv("Settings", "could not be read"))
    + '<div class="note" style="margin-top:16px; font-size:14px">' + esc(why) + "</div>";
}

/* The editable card. Ids are `dl…` throughout: the connect screen owns `lev`, `sp`, `ps`
   and `stopon`, and both sets of markup are in the page at once. */
function controls(d: Desk): string {
  const n = d.openCount;
  return '<div style="margin-top:20px; display:flex; justify-content:space-between; align-items:baseline; gap:12px">'
    + '<span class="kicker" style="font-size:12px">Leverage</span>'
    + '<span class="num" id="dlexposure" style="font-size:14px; color:var(--dim)"></span></div>'
    + '<div class="seg" id="dllev" style="margin-top:10px">'
    + '<button data-l="5">5×</button><button data-l="10">10×</button><button data-l="18">18×</button><button data-l="20">20×</button></div>'

    + '<div style="margin-top:22px; display:flex; justify-content:space-between; align-items:center">'
    + '<span class="kicker" style="font-size:12px">Stop loss</span>'
    + '<label class="toggle"><input type="checkbox" id="dlstopon"><span class="sw"></span></label></div>'
    + '<div id="dlsg" style="margin-top:10px">'
    + '<div style="display:flex; justify-content:space-between; margin-bottom:7px">'
    + '<span style="color:var(--dim); font-size:14px">Distance from entry</span>'
    + '<span class="num" id="dlsv" style="font-size:16px"></span></div>'
    + '<input type="range" id="dlsp" min="1" max="8" step="0.5"></div>'
    + '<div class="kvnote" id="dlstopnote" style="margin-top:10px; padding-bottom:0"></div>'

    + '<div style="margin-top:22px; display:flex; justify-content:space-between; align-items:center">'
    + '<span class="kicker" style="font-size:12px">Per position</span>'
    + '<span class="num" id="dlpv" style="font-size:16px"></span></div>'
    + '<input type="range" id="dlps" min="5" max="25" step="1" style="margin-top:8px">'
    // The number the card never showed, and the reason the slider looked inert above
    // 10% (`tasks/21` §8). It moves with the slider like everything else here.
    + '<div class="kvnote" id="dlcount" style="margin-top:10px; padding-bottom:0"></div>'
    + '<div class="kvnote" id="dlfloor" style="margin-top:10px; padding-bottom:0"></div>'

    // The exit choice, locked until SITE_OFFERS.holdToTargetOpensAt. The server refuses
    // it too — `disabled` here is the courtesy, `parseSettings` is the rule. Rendered
    // rather than hidden because someone deciding their limits today should know what
    // is about to be theirs to decide.
    //
    // In the `.exp` block, which is not decoration: everything above it is a limit the
    // owner is expected to set, and the segmented control's normal pressed state is the
    // primary-button treatment. Left as it was, an unfinished option read like the most
    // important setting on the card. Both descriptions stay visible because the second
    // button is disabled, so a hint that swapped with the selection could never be read.
    + '<div class="exp">'
    + '<div class="exp-h"><span class="kicker" style="font-size:12px">Exit behaviour</span>'
    + '<span class="exp-tag">Experimental</span></div>'
    + '<div class="seg" id="dlexit">'
    + '<button data-h="0">Signal change</button><button data-h="1" disabled>Target hit</button></div>'
    + '<div class="exp-opt"><b>Signal change</b> — ' + esc("when Quotient's status moves from a "
      + "direction to neutral, the position is closed at market on the next poll.") + "</div>"
    + '<div class="exp-opt"><b>Target hit</b> — ' + esc("the position is held until your target "
      + "or your stop-loss is hit. If Quotient moves from a direction to neutral — long to neutral, "
      + "say — nothing happens and the position runs on. ")
    + "<b>Opens 9 September</b>" + esc(", once we have measured the current behaviour.") + "</div></div>"

    + '<div class="note" id="dlnote" style="margin-top:16px; font-size:14px"></div>'
    + '<button class="btn sm" style="margin-top:16px" id="dlapply">Apply to new positions</button>'
    + '<div class="hint">' + esc("Applies to positions opened from now on. "
      + (n === 0
        ? "Nothing is open right now."
        : "Your " + n + " open position" + (n === 1 ? " keeps" : "s keep") + " the terms "
          + (n === 1 ? "it" : "they") + " opened with.")) + "</div>"
    + '<div class="hint" id="dlstatus"></div>'
    + '<div class="hint" id="dlapplyerr" hidden style="color:var(--down)"></div>';
}

/** Everything the controls say about themselves, recomputed on every drag. Text only —
 *  the card's markup is built once per desk render, because rebuilding it under a finger
 *  on a slider would drop the drag. */
function paint(d: Desk, server: Draft): void {
  const c = draft as Draft;
  const base = d.mandateUsd as number;
  const {
    marginUsd, notionalUsd, lossUsd, stopsToHalt, floorUsd,
    positions, deployedUsd, correlatedStopUsd, correlatedStopOfMandate,
  } = limitsMath({
    baseUsd: base, perPct: c.per, leverage: c.lev, stopPct: c.stopPct, stopOn: c.on,
    clampPct: CLAMP_PCT[c.lev] ?? 0, dailyLossPct: d.dailyLossPct, minNotionalUsd: d.minOrderNotionalUsd,
    reserveFrac: d.reserveFrac,
  });

  $("dlexposure").textContent = money(notionalUsd) + " of exposure";
  $("dlsv").textContent = c.stopPct.toFixed(1) + "%";
  $("dlpv").textContent = c.per + "% · " + money(marginUsd);
  $("dlsg").style.opacity = c.on ? "1" : ".4";
  $("dlstopnote").textContent = (c.on
    ? "A stop-out costs " + money(lossUsd) + " · " + pctOf(base > 0 ? lossUsd / base : null) + " of the mandate · "
      + pctOf(marginUsd > 0 ? lossUsd / marginUsd : null) + " of the position's margin. "
    : "No stop — a position can lose its whole margin, " + money(lossUsd) + " · "
      + pctOf(base > 0 ? lossUsd / base : null) + " of the mandate, before its deadline. ")
    + (stopsToHalt < 1
      ? "A single one pauses the account for the day."
      : "About " + stopsToHalt.toFixed(1) + (c.on ? " stopped positions" : " such losses")
        + " in one day pause the account.");
  /* How many fit, what they cost together, and the two things that number is not.
     §5: the feed has never offered a sixth signal, so below 15% this is a ceiling and
     not a forecast — said here rather than left for somebody to discover after setting
     10% and expecting ten positions. §4: the correlated stop is the price of the
     allowance, and it is the number that doubled. */
  $("dlcount").textContent = positions + " positions fit at " + c.per + "%, " + money(marginUsd)
    + " each — " + money(deployedUsd) + " at work with the book full. If they all moved against you "
    + "together they would cost " + money(correlatedStopUsd) + " · " + pctOf(correlatedStopOfMandate)
    + " of the mandate"
    + (c.on ? "." : ", and with no stop there is nothing to stop it sooner.")
    + (positions > 5 ? " The signal feed has so far never offered more than five outlooks at once, so "
      + "that count is a ceiling rather than a forecast." : "");
  $("dlfloor").textContent = "These limits need a mandate of at least " + money(floorUsd) + ", or every "
    + "position would be under Hyperliquid's " + money(d.minOrderNotionalUsd) + " minimum order and every "
    + "signal would be skipped.";

  /* Under the floor comes first: it is the only state where *nothing* trades, which beats
     every warning about trading badly — and it is the one the executor refuses outright
     (`tasks/18` §3 step 3), so the button is not offered for it. */
  const nt = $("dlnote");
  const under = base < floorUsd;
  const note = limitsNote({ underFloor: under, stopsToHalt, stopOn: c.on });
  if (note === "under-floor") {
    nt.className = "note bad";
    nt.textContent = "At " + c.per + "% and " + c.lev + "× your " + money(base) + " mandate is under the "
      + money(floorUsd) + " these limits need, so every signal would be skipped. Deposit more, or raise the "
      + "size or the leverage.";
  } else if (note === "one-pauses") {
    nt.className = "note bad";
    nt.textContent = "A single " + (c.on ? "stopped" : "losing") + " position pauses the account for the day. "
      + "Lower the leverage or the size.";
  } else if (note === "two-pause") {
    nt.className = "note bad";
    nt.textContent = "Two bad days would pause you. Lower the leverage or the size.";
  } else if (note === "no-stop") {
    nt.className = "note warn";
    nt.textContent = "With no stop, nothing protects a position until its deadline.";
  } else {
    nt.className = "note";
    nt.textContent = stopsToHalt.toFixed(1).replace(".0", "") + " losing positions in one day pauses the "
      + "account until you look at it. An ordinary bad day should not be able to end you.";
  }

  const b = $<HTMLButtonElement>("dlapply");
  const unchanged = same(c, server);
  b.disabled = under || unchanged;
  b.textContent = unchanged && d.changes?.pendingSettings ? "Requested" : "Apply to new positions";
}

/* What the card says under the button: what is pending and how long it waits, or since
   when the limits in force have held. The countdown is `loopIntervalSec` less how long
   ago the executor was last seen — the owner's ask, so that "requested" is a wait with a
   length rather than a state with no end. */
export function changeLine(d: Desk): string {
  const c = d.changes;
  if (!c) return "";
  if (c.pendingSettings) {
    if (d.halted) return "Requested · applies once the halt is cleared.";
    const n = secondsToLoop(d);
    if (n === null) return "Requested · the desk is not running, so nothing is applying it yet.";
    // Zero is not "no wait": the loop is due, and the heartbeat that would say it had
    // run is itself written once a loop. "Due now" says that without promising a
    // number that has already expired.
    return n === 0 ? "Requested · applies on the next loop, due now."
      : "Requested · applies on the next loop, in about " + n + " s.";
  }
  const since = dayOf(c.settingsAt);
  return since ? "In force since " + since + "." : "";
}

/** The mandate button, which the read-only card renders too. */
function wireMandate(reload: () => void): void {
  const b = $<HTMLButtonElement>("dmandate");
  if (!b) return;
  b.addEventListener("click", async () => {
    b.disabled = true; b.textContent = "Requesting…";
    try {
      await api("/api/mandate", { method: "POST" });
      reload();
    } catch (e) {
      b.disabled = false; b.textContent = "Try again";
      const h = $("dhalt");
      h.hidden = false;
      h.innerHTML = "<strong>Could not request that.</strong> " + esc((e as Error).message);
    }
  });
}

function wireControls(d: Desk, server: Draft, reload: () => void): void {
  const c = draft as Draft;
  const seg = $("dllev");
  seg.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.l) === c.lev)));
  seg.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    c.lev = Number((b as HTMLButtonElement).dataset.l);
    seg.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    paint(d, server);
  });

  const sp = $<HTMLInputElement>("dlsp");
  sp.value = String(c.stopPct);
  sp.addEventListener("input", () => { c.stopPct = Number(sp.value); paint(d, server); });

  const ps = $<HTMLInputElement>("dlps");
  ps.value = String(c.per);
  ps.addEventListener("input", () => { c.per = Number(ps.value); paint(d, server); });

  const on = $<HTMLInputElement>("dlstopon");
  on.checked = c.on;
  on.addEventListener("change", () => { c.on = on.checked; paint(d, server); });

  // Same shape as the leverage segment, and the disabled half fires no click — so when
  // the lock lifts, removing `disabled` from the markup is the whole change.
  const ex = $("dlexit");
  ex.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.h === "1") === c.hold)));
  ex.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b || (b as HTMLButtonElement).disabled) return;
    c.hold = (b as HTMLButtonElement).dataset.h === "1";
    ex.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    paint(d, server);
  });

  $("dlapply").addEventListener("click", async function (this: HTMLButtonElement) {
    this.disabled = true; this.textContent = "Requesting…"; $("dlapplyerr").hidden = true;
    try {
      await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The stop distance travels whether or not the stop is on, exactly as the connect
        // screen sends it: `parseSettings` validates the field either way, and it is what
        // the slider comes back to if the toggle goes on again.
        body: JSON.stringify({
          leverage: c.lev, stopLoss: c.on, stopPct: c.stopPct / 100, perSignalPct: c.per / 100,
          holdToTarget: c.hold,
        }),
      });
      // The request is the server's view now, so the next render re-seeds from it rather
      // than from the draft that produced it.
      draftKey = null;
      reload();
    } catch (e) {
      this.disabled = false; this.textContent = "Try again";
      $("dlapplyerr").hidden = false;
      $("dlapplyerr").textContent = (e as Error).message || "Could not ask for that just now.";
    }
  });
}

/** Refetch the desk once the loop that should have applied a pending change has run.
 *  Cleared on every render, so a card with nothing pending schedules nothing. */
function scheduleRefresh(d: Desk, reload: () => void): void {
  clearWait();
  const pending = d.changes?.pendingSettings?.requestedAt ?? d.changes?.pendingMandate?.requestedAt ?? null;
  if (!pending) { waits = 0; waitingFor = null; return; }
  // The budget is per request, not per render: opening the desk ten times with one
  // change outstanding must not use it up.
  if (waitingFor !== pending) { waitingFor = pending; waits = 0; }
  const n = secondsToLoop(d);
  if (n === null || waits >= MAX_WAITS) return;
  waits++;
  waitTimer = setTimeout(() => {
    waitTimer = null;
    // The card lives on the settings screen now (tasks/27 §7), and a pending change
    // applies whether the reader is looking at it or at the desk it will show up on.
    if (isShowing("settings") || isShowing("desk")) reload();
  }, (n + 3) * 1000);
}

export function renderLimits(d: Desk, reload: () => void): void {
  const el = $("dlimits");
  const server = serverDraft(d);
  const c = d.changes;

  /* No ledger row, unreadable settings, or a mandate we cannot state: nothing to price a
     change against, and `canChangeSettings` would refuse one anyway. */
  if (!c || !server || d.mandateUsd == null) {
    draft = null; draftKey = null; clearWait();
    el.innerHTML = readOnly(d, !c
      ? "This account is not connected to the desk, so there are no limits to change."
      : "We could not read the limits on this account, so they cannot be changed from here. "
        + "The desk is still managing it under whatever it was connected with.");
    wireMandate(reload);
    return;
  }

  /* The pin, said out loud. Two missing buttons is what the owner met, and *"I'm not sure
     if it worked or not"* is the right reaction to a screen that never says why. */
  if (c.pinned) {
    draft = null; draftKey = null; clearWait();
    el.innerHTML = readOnly(d, "Your limits are set by an operator's file on the desk, so they cannot be "
      + "changed from here — and for the same reason this account cannot be unlinked from here. Removing "
      + "the file is what changes either. The mandate is not pinned: the file carries settings, not capital.");
    wireMandate(reload);
    return;
  }

  const key = [d.address, c.settingsAt, c.pendingSettings?.requestedAt ?? ""].join("|");
  if (draftKey !== key || !draft) { draft = { ...server }; draftKey = key; }

  el.innerHTML = mandateRow(d) + controls(d);
  wireMandate(reload);
  wireControls(d, server, reload);
  paint(d, server);
  $("dlstatus").textContent = changeLine(d);
  scheduleRefresh(d, reload);
}
