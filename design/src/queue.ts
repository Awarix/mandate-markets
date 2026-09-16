// The access queue, from the browser's side (`tasks/17`).
//
// The desk trades at most a fixed number of accounts and is at that number, so this is
// what most people meet first: a place in line and two ways to move, instead of the
// refusal that used to arrive after somebody had already funded an account.
//
// Everything here is display. Joining writes a row, a post writes a row, and neither
// decides anything: the executor admits from the front of the queue when a slot is
// free, and every check that stands between an admission and a live order is
// unchanged and elsewhere.

import { api, type ApiError, type QueueStatus } from "./api.ts";
import { $, dayOf, esc } from "./dom.ts";
import { getMe } from "./session.ts";

let q: QueueStatus | null = null;
export function queueState(): QueueStatus | null { return q; }

/** The referral code this visitor arrived with, if any.
 *
 *  Kept in `localStorage` because arriving and joining are usually not the same visit:
 *  somebody follows a link, reads the page, finds a wallet, and comes back. Wrapped
 *  because a browser with storage disabled must still be able to take a place — the
 *  code is a nicety, and the queue is not. */
const REF_KEY = "mandate.ref";
let refMemory: string | null = null;

export function captureRef(search: string): void {
  const code = new URLSearchParams(search).get("r");
  if (!code || !/^[A-Za-z0-9_-]{4,32}$/.test(code)) return;
  refMemory = code;
  try { localStorage.setItem(REF_KEY, code); } catch { /* storage off; the variable holds */ }
}

function ref(): string {
  if (refMemory !== null) return refMemory;
  try { return localStorage.getItem(REF_KEY) ?? ""; } catch { return ""; }
}

const ORD = ["", "1st", "2nd", "3rd"];
function ordinal(n: number): string {
  return ORD[n] ?? `${n}th`;
}

/** What came back from `/api/x/callback`, which is a redirect and not a fetch: the
 *  person is in a browser coming off somebody else's consent screen, so the outcome
 *  arrives as a word in the query string. */
const X_RESULT: Record<string, { good: boolean; text: string }> = {
  linked: { good: true, text: "X account linked. Paste your post below and we will check that it is yours." },
  taken: { good: false, text: "That X account is already linked to another wallet. One wallet per X account — that is what stops one handle earning the boost twice." },
  declined: { good: false, text: "You cancelled the X link. Nothing changed, and your place is unaffected." },
  expired: { good: false, text: "That link took too long and expired. Press it again." },
  signin: { good: false, text: "Sign in with your wallet first — the X account is attached to it." },
  unconfigured: { good: false, text: "X linking is not switched on here yet." },
  failed: { good: false, text: "We could not reach X just now. Your place is unaffected; try again in a minute." },
  already: { good: true, text: "This wallet is already linked. A post counts once — paste yours below if you have not already." },
  limited: { good: false, text: "That is enough X link attempts for one day. Try again tomorrow; your place is unaffected." },
};
let xMessage: { good: boolean; text: string } | null = null;

/** Read and clear the callback's outcome. Cleared from the address bar too: a
 *  reload of `/?x=taken` should not re-announce something that happened once. */
export function captureXResult(search: string): boolean {
  const v = new URLSearchParams(search).get("x");
  if (!v) return false;
  xMessage = X_RESULT[v] ?? X_RESULT.failed!;
  return true;
}

export function cleanUrl(): void {
  const u = new URL(location.href);
  if (!u.searchParams.has("r") && !u.searchParams.has("x")) return;
  u.searchParams.delete("r");
  u.searchParams.delete("x");
  history.replaceState(null, "", u.pathname + (u.search || "") + u.hash);
}

/** How many steps this screen is actually showing, in words. */
function stepCountLine(): string {
  const WORD = ["no", "One", "Two", "Three", "Four", "Five", "Six"];
  const n = document.querySelectorAll("#ctrack .step:not([hidden])").length;
  const word = WORD[n] ?? String(n);
  return `${word} step${n === 1 ? "" : "s"}, and then you are done with this screen for good.`;
}

export function paintQueue(st: QueueStatus | null): void {
  q = st;
  const card = $("cqueue");

  // **Signed out is a queue state, not an unknown one.** The call to action says Get
  // access; walking somebody through four steps about funding a Hyperliquid account and
  // only then telling them there is a queue is the bait this screen exists to remove.
  // So the card shows and the steps stay hidden until we know otherwise — the honest
  // default when the answer is "the desk is full", which it is.
  if (!getMe()) {
    card.hidden = false;
    for (const id of ["cs2", "cs3", "cs4"]) $(id).hidden = true;
    $("ch1").textContent = "Access is by queue.";
    $("csub").textContent = "The desk trades a fixed number of accounts, and it is full. " +
      "Sign in above to take a place.";
    // No place to show yet, so no place is shown: a "Your place —" heading over a dash
    // is a label for a fact we do not have.
    $("qhead").hidden = true;
    $("qnote").className = "note";
    $("qnote").innerHTML = "Signing in is a signature and nothing else. Nothing is asked of " +
      "your account until a place comes free — no deposit, no approval, no key.";
    $("qjoinwrap").hidden = true;
    $("qboosts").hidden = true;
    $("qfunded").textContent = "";
    return;
  }
  // Only a server answer we could not get at all leaves the steps as they were.
  if (st === null) {
    card.hidden = true;
    for (const id of ["cs2", "cs3", "cs4"]) $(id).hidden = false;
    return;
  }

  // "admitted" is the one admitted state that still has something to say: a slot is
  // being held, and it does not wait forever. Every other admitted state — connected,
  // mid-connect, an operator's own account — is just the four steps as they were.
  const holding = st.why === "admitted";
  card.hidden = st.admitted && !holding;
  for (const id of ["cs2", "cs3", "cs4"]) $(id).hidden = !st.admitted;

  // The headline is set **before** the early return, because the states that hide this
  // card are exactly the ones it was still describing wrongly: an operator-armed address
  // (`why: "pinned"`) and an account already mid-connect both hide the queue and both
  // kept whatever the page last said — which, for somebody arriving signed out, is
  // "Access is by queue… it is full" sitting on top of the four steps they were just let
  // through. Seen on the first pinned wallet, 2026-09-10.
  $("ch1").textContent = st.admitted ? "You're in." : (st.joined ? "You're in line." : "Access is by queue.");
  // The count is read off the steps that are actually on screen rather than written
  // here, because one of them is conditional: the referral step renders only for an
  // account with no code, so this screen is four steps for most arrivals from
  // Hyperliquid and five for an account our own funding flow created. A sentence that
  // said "four" would be wrong for exactly the people the flow is built for.

  $("csub").textContent = st.admitted
    ? stepCountLine()
    : "The desk trades a fixed number of accounts, and it is full. Here is where you are.";

  if (card.hidden) return;

  $("qhead").hidden = false;
  $("qpos").textContent = st.admitted ? "You're in" : (st.position === null ? "—" : ordinal(st.position));

  const note = $("qnote");
  if (xMessage !== null) {
    note.className = "note " + (xMessage.good ? "good" : "warn");
    note.innerHTML = esc(xMessage.text);
  } else if (st.admitted && st.admittedUntil) {
    note.className = "note good";
    note.innerHTML = "<strong>A place is being held for you.</strong> Finish the four steps below " +
      "by " + esc(dayOf(st.admittedUntil)) + " — after that it goes back to " +
      "the queue and somebody else takes it. Nothing is charged and nothing is traded until you " +
      "approve the agent yourself.";
  } else if (st.why === "lapsed") {
    note.className = "note warn";
    note.innerHTML = "<strong>The place we were holding has gone back to the queue.</strong> You " +
      "are still in line — at the back of it, from when the hold ran out. A post or a " +
      "referral moves you up again.";
  } else if (!st.joined) {
    note.className = "note";
    note.innerHTML = "Take a place and we will let you in as soon as one frees. Nothing is asked " +
      "of your account until then — no deposit, no approval, no key.";
  } else if (st.position === 1) {
    // "The only one waiting" was true and read as "nobody else wants this". The fact
    // that matters to the person is the same either way: the next place is theirs.
    note.className = "note good";
    note.innerHTML = "<strong>You are next.</strong> The next place that frees is yours.";
  } else {
    note.className = "note";
    note.innerHTML = "Both of the things below move you up the queue.";
  }

  $("qjoinwrap").hidden = st.joined;
  $("qboosts").hidden = !st.joined || st.admitted;

  // Absent rather than broken when the app is not configured (`tasks/17` §3), and the
  // two halves are gated separately: linking needs the client id, checking a post needs
  // the bearer token as well. Linking survives on its own because a linked handle is
  // what makes a referral of this account count.
  $("qxboost").hidden = !st.xConfigured;
  $("qxlink").hidden = st.xHandle !== null;
  $("qxdone").hidden = st.xHandle === null;
  if (st.xHandle !== null) {
    $("qxdone").innerHTML = "<strong>Linked to @" + esc(st.xHandle) + ".</strong> " +
      "Posts are checked against it, and it is what makes a referral of you count.";
  }
  $("qpostboost").hidden = !st.xConfigured || !st.postCheckable;
  $("qpostwrap").hidden = st.xHandle === null || st.posted;
  $("qpostneedslink").hidden = st.xHandle !== null || st.posted;
  $("qposted").hidden = !st.posted;
  if (st.draftUrl !== null) $<HTMLAnchorElement>("qdraft").href = st.draftUrl;

  $<HTMLInputElement>("qref").value = st.refCode === null ? "" : location.origin + "/?r=" + st.refCode;
  $("qrefcount").textContent = st.referrals === 0
    ? "nobody yet"
    : `${st.referrals} counted`;

  // Funding is no longer part of any boost, so this says only the true and useful half:
  // waiting costs nothing.
  $("qfunded").textContent = "You do not have to deposit anything to wait.";
}

export async function refreshQueue(): Promise<void> {
  if (!getMe()) { paintQueue(null); return; }
  try {
    paintQueue(await api<QueueStatus>("/api/queue"));
  } catch (e) {
    // A queue we cannot read must not hide the connect screen: leaving the steps
    // visible is the state this page was in before the queue existed, and the server
    // refuses an unadmitted connection anyway.
    if ((e as ApiError).status !== 401) paintQueue(null);
  }
}

export function wireQueue(): void {
  $("qjoin").addEventListener("click", async function (this: HTMLButtonElement) {
    const b = this; b.disabled = true; b.textContent = "Taking your place…";
    $("qjoinerr").hidden = true;
    try {
      paintQueue(await api<QueueStatus>("/api/queue/join", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: ref() }),
      }));
    } catch (e) {
      $("qjoinerr").hidden = false;
      $("qjoinerr").textContent = (e as Error).message || "Could not do that just now.";
    } finally { b.disabled = false; b.textContent = "Take my place in line"; }
  });

  // A full navigation, not a fetch: the server answers with a redirect to X's own
  // consent screen, which is the one page in this flow that must be theirs and not
  // ours.
  $("qxgo").addEventListener("click", () => { location.assign("/api/x/start"); });

  $("qpostgo").addEventListener("click", async function (this: HTMLButtonElement) {
    const b = this; b.disabled = true; b.textContent = "Checking…";
    $("qposterr").hidden = true;
    try {
      xMessage = null;
      paintQueue(await api<QueueStatus>("/api/x/post", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: $<HTMLInputElement>("qposturl").value }),
      }));
    } catch (e) {
      $("qposterr").hidden = false;
      $("qposterr").textContent = (e as Error).message || "Could not check that link.";
    } finally { b.disabled = false; b.textContent = "Check it"; }
  });

  $("qrefcopy").addEventListener("click", function (this: HTMLButtonElement) {
    const b = this, v = $<HTMLInputElement>("qref").value;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject(new Error("no clipboard")))
      .then(() => {
        b.textContent = "Copied";
        setTimeout(() => { b.textContent = "Copy link"; }, 1500);
      }, () => { $<HTMLInputElement>("qref").select(); });
  });
}
