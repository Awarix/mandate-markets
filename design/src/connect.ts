// The connect card. Four steps, and we never see a private key: the server generates
// the agent, keeps it sealed, and shows only the public address to approve. Step state
// is read from the server rather than tracked here, because the executor is the thing
// that actually decides when an account is connected.

import {
  api, type ApiError, type ConnectBalance, type ConnectStatus, type FeeState, type ReferralInfo,
} from "./api.ts";
import { renderConnectFee, runFeeApproval } from "./builderFee.ts";
import {
  depositDecoded, fmtUsdc, refuseDeposit, runDeposit, txLink, readWalletFunds,
  type WalletFunds,
} from "./deposit.ts";
import { keyWaitVerdict } from "./connectChain.ts";
import { $, $$, esc, money } from "./dom.ts";
import { CLAMP_PCT, floorFor as floorAt, limitsMath, limitsNote } from "./limits.ts";
import { chooseWallet, showNoWallet } from "./picker.ts";
import { getMe, refreshMe, sessionExpired } from "./session.ts";
import { queueState, refreshQueue } from "./queue.ts";
import { isShowing, show } from "./views.ts";
import { runApproval } from "./renew.ts";
import {
  discoverWallets, isUserRejection, requestAddress, type Eip1193Provider,
} from "./wallet.ts";

/* What an account that has not chosen yet is offered. **Read from the controls in
   `design/views/connect.html` by `wireConnect`, never typed twice** — these initialisers
   only cover the moment before that runs. The stop default moved 3% → 1% on 2026-09-10
   and this file was the copy that did not: the server, the desk and every test read
   `DEFAULT_USER_SETTINGS`, while the slider a new owner actually dragged still started at
   3% and posted it explicitly. `design/src/limits.test.ts` now pins the markup to the
   constant, which is the only place a browser and a server can be made to agree. */
let lev = 10, stopPct = 2, per = 10, on = true;
/* The exit choice. Sent explicitly rather than left off, so the body says what the
   screen showed; `parseSettings` refuses `true` until it opens, and the button that
   would set it is disabled until then (`SITE_OFFERS.holdToTargetOpensAt`). */
let holdToTarget = false;

/* Server-supplied constants. Defaults match src/risk/params.ts and are replaced the
   moment /api/connect/status lands — they exist so the page reads correctly for the
   half-second before it does, not as a second copy of the numbers. */
let MINNOTIONAL = 10, DAILY = 0.10, RESERVE = 0.01;

/* The account's real collateral, from /api/connect/balance. Null until read. */
let bal: ConnectBalance | null = null;

/* What the desk charges this account, and whether it has to agree before it arms
   (`tasks/33`). Null until read, and null reads as "nothing to ask" — the executor is
   the thing that actually refuses, so a page that failed to load this cannot be the
   reason somebody is stopped, and cannot be the reason somebody is asked either. */
let fee: FeeState | null = null;
/* Whether a signature is still owed. Kept beside the state rather than recomputed at
   the button, so the sentence on screen and the gate on the button are one decision. */
let feeOwed = false;

/* Whether this account has a Hyperliquid referral code, and therefore whether there is
   anything to say about ours (`tasks/37`). Null until read, and null says nothing. */
let ref: ReferralInfo | null = null;

/* What the signed-in wallet holds on Arbitrum, read through the wallet itself. Null
   until it has been read, which is deliberately not something a page load does: a
   silent read is attempted once signed in, and anything that would prompt waits for
   the button. */
let funds: WalletFunds | null = null;

/* The chain is running. One at a time, and the button says so rather than queueing a
   second wallet prompt behind the first. */
let busy = false;

/* The agent approval has been signed in this browser, and the desk has not yet noticed.
   Deliberately page-local and not a server field: nothing about the account has changed
   that the executor could read until it looks at the venue, and the whole point is to say
   something true in the window before it does. Cleared on `leaveConnect`, so a reload
   falls back to whatever the venue actually says. */
let approved = false;

/* The last status this page painted. Kept because the action button decides what it is
   for from the same state the steps below it are drawn from, and recomputing it in two
   places is how they end up disagreeing. */
let last: ConnectStatus | null = null;

let pollTimer: ReturnType<typeof setInterval> | null = null;

export function stopPolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/* Renewal reuses step 4 rather than copying it.
   An approval that is running out is fixed by approving the same agent address again
   — the same address, the same Hyperliquid page, the same copy button that step 4
   already renders. But the account is connected, so its status reads "active" and
   step 4 shows the "Connected" card instead. This flag is the desk asking for the
   approve panel anyway. It is deliberately not a server field: nothing about the
   account changes, only which of two panels this page is showing. */
let renewing = false;

export function openAgentRenewal(): void {
  renewing = true;
  show("connect");
  void refreshConnect();
}

/** Long enough for several executor loops, short enough that a desk which is simply
 *  down stops pretending something is about to happen. */
const KEY_WAIT_MS = 3 * 60_000;
const KEY_POLL_MS = 3000;
/** A CCTP deposit is a burn on Arbitrum and a mint on HyperCore, so it lands in tens of
 *  seconds rather than instantly. Long enough to cover a slow attestation; a timeout
 *  here is not a lost deposit and the copy says so. */
const CREDIT_WAIT_MS = 5 * 60_000;
const CREDIT_POLL_MS = 4000;

export function leaveConnect(): void {
  stopPolling();
  renewing = false;
  busy = false;
  approved = false;
}

// ── The one action ──────────────────────────────────────────────────────────
//
// Everything below decides what the single button is for, and then does it. The phases
// are the states of the same handshake the four steps describe, in the order somebody
// meets them; `advance()` walks as far down the list as it can and stops the moment
// something is refused or is not ours to hurry.

type Phase = "signin" | "fund" | "referral" | "fee" | "start" | "minting" | "approve" | "arming" | "active";

function phase(): Phase {
  if (!getMe()) return "signin";
  const st = last;
  if (!st || st.step === "active") return "active";
  // Funding first, because it is the only step whose absence stops the account from
  // trading *after* everything else has succeeded.
  // `bal === null` deliberately falls through rather than holding here. It means "not
  // read yet" **and** "we asked and Hyperliquid did not answer", and the second is why:
  // `refreshBalance`'s own failure copy promises *"Everything else on this screen still
  // works"*, and holding at `fund` on a null balance would strand every connection for
  // the length of a venue outage to save a one-second flicker. The flicker is real —
  // before the first read lands the button can read *"Approve the fee and connect"* on
  // an empty account — and it is the cheaper of the two. `tasks/38` §1.3.
  if (bal && !bal.enough) return "fund";
  // Then the referral, which sits here for two reasons. Hyperliquid refuses
  // `setReferrer` on an address that has never deposited, so it cannot come earlier;
  // and the code has to be on the account before the first order or the discount
  // applies to nothing, so it must not come later. It is asked once — `refChoice`
  // holds the answer, skip included — and never asked again.
  if (referralOffered() && refChoice === null) return "referral";
  // Then the fee, and **before the step branches, not after them**. Declining it must
  // not leave a minted key behind (`tasks/33` §2), which is the reason it comes before
  // `start` — but it also has to come before `approve` and `minting`, because an
  // account that reached those and is being refused for the fee can only get out of it
  // here. Without that, the executor's refusal and this button disagree about what is
  // owed and the screen offers no way to settle it.
  if (feeOwed) return "fee";
  // Signed, and the desk has not caught up yet. **The server cannot tell us this**:
  // `/api/connect/status` keeps saying `approve` until the executor's next pass reads the
  // approval off the venue and arms the account, up to a minute later. Only the page
  // knows a wallet just signed, so only the page can say so — and without it the screen
  // goes on offering *"Approve in your wallet"* over an approval that is already made,
  // which Hyperliquid refuses. Seen on the second wallet's run, 2026-09-10, and reported
  // by the owner as "there still was approve button".
  if (st.step === "approve" && approved) return "arming";
  if (st.step === "approve") return "approve";
  if (st.step === "minting") return "minting";
  return "start";
}

const LABEL: Record<Phase, string> = {
  signin: "Sign in with your wallet",
  fund: "Deposit and connect",
  referral: "Apply the code and carry on",
  fee: "Approve the fee and connect",
  start: "Create my key and connect",
  minting: "Creating your key…",
  approve: "Approve in your wallet",
  arming: "Connecting your account…",
  active: "Go to the desk",
};

/** What the rest of the chain costs, in one line.
 *
 *  A line, not a paragraph: the steps below the card are where the explaining happens,
 *  and repeating them here is what turned this into a wall of text. Each of these says
 *  only how many wallet prompts are left and what they cannot do.
 *
 *  ⚠ **The card says what pressing the button does; the panel says what it means.** That
 *  is the whole rule, and it is easy to break: the referral line first shipped here
 *  quoting the 4% and the $25M that its panel two inches below already quoted, and the
 *  owner read the result as the screen talking to itself. If a sentence would still be
 *  true with the button removed, it belongs in the panel. */
function subFor(p: Phase): string {
  // Four is reachable — deposit, deposit, fee, agent — and the first version of this
  // said "Three" for anything above two, which is a lie about how many times somebody is
  // about to be interrupted. Written out because a digit reads as a quantity of money on
  // a screen that is otherwise full of them.
  const WORD = ["no", "One", "Two", "Three", "Four", "Five"];
  const prompts = (n: number) => `${WORD[n] ?? n} wallet prompt${n === 1 ? "" : "s"}`;
  switch (p) {
    case "signin":
      return "One signature. It proves the address is yours and authorises nothing.";
    case "fund":
      return prompts(2 + (feeOwed ? 1 : 0) + 1) + ". None of them can move money out.";
    case "referral":
      // Mechanics only. What a code is *worth* is the panel's job, and saying it in
      // both places is what made this screen read as talking to itself.
      return "No wallet prompt. We apply it when your account connects.";
    case "fee":
      // One prompt when the agent is already approved and the fee is the only thing the
      // executor is still refusing on — which is the state somebody who connected before
      // this was asked for lands in.
      return prompts(last?.step === "choose" ? 2 : 1) + ". Neither can move money out.";
    case "start":
    case "approve":
      return "One signature, valid 180 days. It lets us place orders and cannot withdraw.";
    case "minting":
      return "Up to a minute. Your wallet opens on its own when the key is ready.";
    case "arming":
      // Nothing is left for them to do, and saying so is the point: the previous version
      // of this screen left a button here, which reads as "you have not finished".
      return "Your approval is in. The desk checks every minute and starts managing this "
        + "account as soon as it sees it — nothing else is needed from you.";
    default:
      return "";
  }
}

function goError(msg: string | null): void {
  const el = $("cgoerr");
  el.hidden = msg === null;
  if (msg !== null) el.textContent = msg;
}

function goFlow(html: string): void {
  $("cgoflow").innerHTML = html === "" ? "" : '<div class="note" style="margin-top:14px">' + html + "</div>";
}

function paintAction(): void {
  const p = phase();
  const card = $("cact");
  // The queue owns the screen when this address has not been admitted — it hides steps
  // 2 to 4 — and a button offering to fund an account that cannot connect would be the
  // same mistake in a louder place. Signed out is the exception and not an oversight:
  // the queue's own instruction is "sign in to take a place", and this is that button.
  const q = queueState();
  const barred = p !== "signin" && q !== null && !q.admitted;
  card.hidden = renewing || barred;
  $("cactfund").hidden = p !== "fund";
  $("cactref").hidden = p !== "referral";
  $("crefskip").hidden = p !== "referral";
  const btn = $<HTMLButtonElement>("cgo");
  const waiting = p === "minting" || p === "arming";
  btn.textContent = busy && !waiting ? "Working…" : LABEL[p];
  btn.disabled = busy || waiting;
  // Both waiting states are the desk's loop, not the user's turn. The spinner is what
  // says "something is happening" where a plain disabled button says "you are stuck".
  btn.classList.toggle("working", waiting);
  $("cgosub").textContent = subFor(p);
  paintReferral();
  if (p === "fund") paintDeposit();
}

/* The referral step (`tasks/37` §7.5).
 *
 * Whether the code has been chosen yet. `null` is "not answered"; a string is a code to
 * send with the connect request; `""` is a deliberate skip. The distinction matters
 * because skipping is a real answer and the step must stop asking once it is given. */
let refChoice: string | null = null;

/** Whether the referral step is on this journey at all.
 *
 *  Three conditions, and each removes a way of asking for something that cannot happen.
 *  Only for an account with **no code**: a slot is spent once, ever, so anyone else is
 *  shown nothing rather than nagged about a thing they cannot change. Only once the
 *  account **holds money**: Hyperliquid refuses `setReferrer` on an address that has
 *  never deposited. Only **before it is connected**: the discount applies to fees
 *  incurred after the code is set, so this is the last quiet moment before the first
 *  order. */
function referralOffered(): boolean {
  return ref !== null && ref.state === "none" && bal !== null && bal.enough
    && last !== null && last.step !== "active";
}

/** The step panel, and the card's one-line summary of what it decided.
 *
 *  ⚠ **What we are paid is deliberately not on this screen.** The line that used to be
 *  here — *"We are paid 10% of the fee you pay them"* — read as a charge on top, and it
 *  is not one: the user pays Hyperliquid 4% *less* than with no code at all, and our
 *  share comes out of what Hyperliquid keeps. The owner's decision on 2026-09-10 was to
 *  drop it rather than reword it, on the grounds that a referral paying its referrer is
 *  how referrals are known to work and explaining it at length reads as greed rather
 *  than candour. `tasks/37` §7.6. */
function paintReferral(): void {
  const offered = referralOffered();
  // The panel stays on the journey once the question has been answered, showing what
  // was decided — a step that vanished the moment it was done would make the count
  // change under somebody mid-flow.
  $("csref").hidden = !offered;

  const box = $<HTMLInputElement>("crefcode");
  if (offered && box.value.trim() === "" && refChoice === null && ref !== null) {
    box.value = ref.ourCode;
  }

  // The panel's own line: what this step decided, or nothing while it is still the
  // question. The card above is where the question is asked.
  const chosen = $("crefstate");
  chosen.hidden = !offered || refChoice === null;
  if (!chosen.hidden) {
    chosen.className = "note good";
    chosen.textContent = refChoice === ""
      ? "Skipped. Nothing else about your account changes, and the slot stays yours until "
        + "something uses it."
      : `${refChoice} — applied when the desk connects your account.`;
  }

  // The card's one-line summary, for somebody who has scrolled past the panel.
  const el = $("cref");
  el.hidden = !offered || refChoice === null;
  if (!el.hidden) {
    el.innerHTML = refChoice === ""
      ? "No referral code."
      : "Referral code <strong>" + esc(refChoice ?? "") + "</strong>, applied when your account connects.";
  }
}


async function refreshReferral(): Promise<void> {
  if (!getMe()) { ref = null; return; }
  try { ref = await api<ReferralInfo>("/api/referral"); } catch { ref = null; }
  paintAction();
}

function paintDeposit(): void {
  const amount = $<HTMLInputElement>("cdepamt").value;
  $("cdepdec").innerHTML = depositDecoded();
  const w = funds;
  $("cdepbal").textContent = w === null
    ? "USDC on Arbitrum"
    : fmtUsdc(w.usdc) + " USDC on Arbitrum"
      + (w.usdce > 0n ? ` · ${fmtUsdc(w.usdce)} USDC.e, which cannot be deposited` : "");
  const bad = amount.trim() === "" ? null : refuseDeposit({ amount, funds, floorUsd: floorFor(per, lev) });
  goError(bad);
}

/** Read the wallet without prompting.
 *
 *  `eth_accounts` answers from what the wallet has already granted this origin — which
 *  sign-in granted — so this prefills the deposit box for somebody who has connected,
 *  and stays silent for somebody who has not. Anything that would open a dialog waits
 *  for the button, because a page that pops a wallet on load is a page people close. */
async function readFundsQuietly(): Promise<void> {
  const me = getMe();
  if (!me || funds !== null) return;
  try {
    const found = await discoverWallets();
    for (const w of found) {
      const accounts = await w.provider.request({ method: "eth_accounts" }) as unknown;
      const has = Array.isArray(accounts) && accounts.some(
        (a) => typeof a === "string" && a.toLowerCase() === me.address.toLowerCase());
      if (!has) continue;
      funds = await readWalletFunds(w.provider, me.address);
      const box = $<HTMLInputElement>("cdepamt");
      // Their whole balance, because the deposit is the size. Still theirs to change.
      if (box.value.trim() === "" && funds.usdc > 0n) box.value = (Number(funds.usdc) / 1e6).toFixed(2);
      paintAction();
      return;
    }
  } catch { /* a wallet that will not answer quietly is not an error worth showing */ }
}

/** Choose a wallet and prove it is the account signed in here. */
async function providerForMe(): Promise<Eip1193Provider | null> {
  const me = getMe();
  if (!me) return null;
  const found = await discoverWallets();
  if (found.length === 0) { showNoWallet(); return null; }
  const chosen = found.length === 1 ? found[0]! : await chooseWallet(found);
  if (!chosen) return null;
  const address = await requestAddress(chosen.provider);
  if (address.toLowerCase() !== me.address.toLowerCase()) {
    goError("That wallet is on a different account than the one signed in here. Switch accounts in "
      + "your wallet, or sign in with that address instead.");
    return null;
  }
  return chosen.provider;
}

async function doDeposit(): Promise<boolean> {
  const amount = $<HTMLInputElement>("cdepamt").value;
  const floorUsd = floorFor(per, lev);
  const before = refuseDeposit({ amount, funds, floorUsd });
  if (before) { goError(before); return false; }

  const provider = await providerForMe();
  if (!provider) return false;
  const me = getMe()!;

  // Read the wallet again with the provider in hand: the quiet read may never have
  // happened, and this is the last moment before somebody signs.
  goFlow('<span class="mono">Checking your wallet…</span>');
  funds = await readWalletFunds(provider, me.address);
  paintDeposit();
  const after = refuseDeposit({ amount, funds, floorUsd });
  if (after) { goError(after); goFlow(""); return false; }

  const r = await runDeposit({
    provider, address: me.address, amount,
    onStep: (line) => goFlow('<span class="mono">' + esc(line) + "</span>"),
  });
  if (!r.ok) return false;

  goFlow("<strong>Sent.</strong> " + txLink(r.hash) + " — crediting, usually under a minute.");
  return await waitForCredit();
}

/** Wait for the venue to show the money. Failing here is a slow deposit, not a lost
 *  one, so it stops the chain and says what to do rather than reporting an error. */
async function waitForCredit(): Promise<boolean> {
  const until = Date.now() + CREDIT_WAIT_MS;
  for (;;) {
    if (!isShowing("connect")) return false;
    await new Promise((r) => setTimeout(r, CREDIT_POLL_MS));
    await refreshBalance();
    if (bal && bal.enough) {
      goFlow("<strong>Funded.</strong> We can see " + money(bal.usableUsd) + ".");
      return true;
    }
    if (Date.now() > until) {
      goFlow("<strong>Still waiting on Hyperliquid.</strong> The deposit was sent and this page keeps "
        + "checking. When the balance appears, press the button again to finish connecting.");
      return false;
    }
  }
}

/** The wait between "create" and "approve", which is the desk's loop and not something
 *  this page can hurry: the key is minted by the process that holds the keystore
 *  passphrase, and this one deliberately does not. */
async function waitForKey(): Promise<boolean> {
  const until = Date.now() + KEY_WAIT_MS;
  for (;;) {
    if (!isShowing("connect")) return false;
    const st = await api<ConnectStatus>("/api/connect/status");
    paintConnect(st);
    // `connectChain.ts` owns this and is tested: the ordering it encodes is the fix for
    // the stall that stopped every new account at its last step (`tasks/38` §1.1).
    const verdict = keyWaitVerdict(st);
    if (verdict === "ready") return true;
    if (verdict === "stop") return false;
    if (Date.now() > until) {
      goFlow("<strong>This is taking longer than usual.</strong> Your request is saved. When the key "
        + "appears, press the button again — nothing has to be redone.");
      return false;
    }
    await new Promise((r) => setTimeout(r, KEY_POLL_MS));
  }
}

/** Walk the chain from wherever it is to as far as it goes. */
async function advance(signIn: () => void): Promise<void> {
  if (busy) return;
  if (phase() === "signin") { signIn(); return; }
  if (phase() === "active") { show("desk"); return; }

  // Where this click started. The chain walks forward through steps that are *ours* to
  // perform; a step that is somebody's **decision** must not be walked through, and the
  // referral is the only one of those.
  const entry = phase();

  busy = true; goError(null); paintAction();
  try {
    if (phase() === "fund" && !await doDeposit()) return;
    if (phase() === "referral") {
      // Arriving here from the deposit means this person has not seen the question yet:
      // the panel and the box are painted by the same pass that is still running. Show
      // it and stop. Carrying on would read an empty box — which is what happened on the
      // second wallet's run, 2026-09-10, and surfaced as a validation error for a code
      // nobody had typed — and, worse, would have **applied our own code without anybody
      // being asked** had the box been filled a moment earlier. That is exactly the
      // silent agent-set `tasks/37` §3 refused, arrived at by accident.
      if (entry !== "referral") { paintAction(); goFlow(""); return; }
      const code = $<HTMLInputElement>("crefcode").value.trim();
      // The same shape the server accepts, checked here so a typo is caught under the
      // box rather than as a 400 two steps later. The server checks it again: this is a
      // courtesy to a person, and a POST does not read markup.
      if (!/^[A-Za-z0-9]{1,20}$/.test(code)) {
        goError("Referral codes are 1 to 20 letters and digits, with nothing else in them.");
        return;
      }
      refChoice = code;
      // Nothing is signed and nothing is sent yet — the code rides on the connect
      // request a few lines below, and the agent applies it once the account is live.
      paintReferral();
    }
    if (phase() === "fee") {
      const approved = await runFeeApproval($("cgoflow"), () => { void refreshFee(); });
      if (!approved) return;    // runFeeApproval has already said what happened
      feeOwed = false;
      // An account past `choose` already has its key and its agent approval, and the fee
      // was the only thing the executor was refusing on. Carrying on would ask a wallet
      // to approve an agent Hyperliquid already holds, which it refuses — so stop, and
      // let the desk's next loop arm it.
      if (last !== null && last.step !== "choose") {
        goFlow("<strong>Approved.</strong> The desk arms this account on its next pass, usually "
          + "within a minute. Nothing else is needed from you.");
        return;
      }
    }
    if (phase() === "start") {
      const st = await api<ConnectStatus>("/api/connect/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          leverage: lev, stopLoss: on, stopPct: stopPct / 100, perSignalPct: per / 100, holdToTarget,
          // Null unless somebody pressed *Apply*. Skipping and never being asked send
          // the same thing, which is right: both mean "do not set a code", and the
          // executor's `applyReferral` never runs.
          referralCode: refChoice === null || refChoice === "" ? null : refChoice,
        }),
      });
      paintConnect(st);
    }
    if (phase() === "minting") {
      goFlow('<span class="mono">Creating your agent key…</span>');
      if (!await waitForKey()) return;
    }
    if (phase() === "approve") {
      if (await runApproval($("cgoflow"), () => { void refreshConnect(); }, "connect")) {
        approved = true;
        paintAction();
      }
    }
  } catch (e) {
    if (isUserRejection(e)) {
      goFlow("<strong>Nothing was signed,</strong> and your account is exactly as it was.");
    } else {
      goError((e as Error).message || "That did not go through. Nothing about your account changed.");
    }
  } finally {
    busy = false;
    void refreshConnect();
  }
}

/* There is no ceiling any more, so the only base capital that means anything is what
   the account actually holds. Before we can see it — not signed in, nothing deposited,
   Hyperliquid unreachable — the card works a $100 example and says so, rather than
   quoting dollars it has no basis for. */
function baseCapital(): number {
  return (bal && bal.usableUsd > 0) ? bal.usableUsd : 100;
}
function baseIsReal(): boolean { return !!(bal && bal.usableUsd > 0); }

/* The smallest deposit that can produce a legal order at the given limits:
   minNotional = base x perSignalPct x leverage, inverted. `minFundedForLiveUsd()` in
   src/risk/params.ts is the same formula, and is the one the executor enforces. */
function floorFor(perPct: number, leverage: number): number { return floorAt(MINNOTIONAL, perPct, leverage, RESERVE); }

/* The floor for the *weakest* combination the controls below offer, read off the
   controls themselves so the two cannot drift. This is the number step 2 quotes before
   step 3 exists. */
function worstFloor(): number {
  const levs = $$<HTMLButtonElement>("#lev button").map((b) => Number(b.dataset.l));
  return floorFor(Number($<HTMLInputElement>("ps").min), Math.min(...levs));
}

function render(): void {
  const BASE = baseCapital();
  /* The arithmetic lives in limits.ts, pure, and limits.test.ts pins it to the server's
     `haltDistance` — the desk prints the same sentence from that one. */
  const {
    marginUsd: m, notionalUsd: n, lossUsd: loss, stopsToHalt: halt, floorUsd: floor,
    positions, correlatedStopUsd, correlatedStopOfMandate,
  } = limitsMath({
    baseUsd: BASE, perPct: per, leverage: lev, stopPct, stopOn: on, clampPct: CLAMP_PCT[lev]!,
    dailyLossPct: DAILY, minNotionalUsd: MINNOTIONAL, reserveFrac: RESERVE,
  });
  $("cm").textContent = "$" + m.toFixed(2);
  $("cn").textContent = "$" + n.toFixed(2);
  $("cl").textContent = "$" + loss.toFixed(2);
  $("cs").textContent = halt.toFixed(1);
  $("cfloor").textContent = "$" + floor.toFixed(2);
  /* The count is what the limits allow; the correlated figure is what allowing it costs
     (§4), and it is the number that roughly doubled when the deployed cap went to 100%.
     §5's qualifier rides on the count rather than on the cost, because the cost is a
     property of the limits and the qualifier is a fact about today's feed: it has never
     offered a sixth signal, so above five this is a ceiling and not a forecast — which
     somebody setting 10% and expecting ten positions should read here rather than
     discover. */
  $("ccount").textContent = String(positions) + (positions > 5 ? " · 5 so far" : "");
  $("ccorr").textContent = "$" + correlatedStopUsd.toFixed(2)
    + " · " + (correlatedStopOfMandate * 100).toFixed(0) + "%";
  $("sv").textContent = stopPct.toFixed(1) + "%";
  $("pv").textContent = per + "%";
  $("sg").style.opacity = on ? "1" : ".4";
  /* The mandate is the deposit. Said as an example until we have actually seen one, so
     nobody reads a worked illustration as a promise about their account. */
  $("cmandate").textContent = baseIsReal() ? "$" + BASE.toFixed(2) : "$100.00 · example";
  const nt = $("cnote");
  /* Under the floor comes first: it is the only state where *nothing* trades, which
     beats every warning about trading badly. */
  const note = limitsNote({ underFloor: baseIsReal() && BASE < floor, stopsToHalt: halt, stopOn: on });
  if (note === "under-floor") {
    nt.className = "note bad";
    nt.innerHTML = "<strong>These limits need at least $" + floor.toFixed(2) + ".</strong> At " + per +
      "% and " + lev + "x, one position would be worth less than the $" + MINNOTIONAL +
      " minimum Hyperliquid accepts, so every signal would be skipped. Deposit more, or " +
      "raise the size or the leverage.";
  } else if (note === "one-pauses") {
    nt.className = "note bad";
    nt.innerHTML = "<strong>A single " + (on ? "stopped" : "losing") + " position pauses the account for the "
      + "day.</strong> Lower the leverage or the size.";
  } else if (note === "two-pause") {
    nt.className = "note bad";
    nt.innerHTML = "<strong>Two bad days would pause you.</strong> Lower the leverage or the size.";
  } else if (note === "no-stop") {
    nt.className = "note warn";
    nt.innerHTML = "<strong>With no stop, nothing protects a position</strong> until its deadline.";
  } else {
    nt.className = "note";
    nt.textContent = halt.toFixed(1).replace(".0", "") + " losing positions in one day pauses the account " +
      "until you look at it. An ordinary bad day should not be able to end you.";
  }
}

function stepState(el: HTMLElement, state: "done" | "now" | ""): void {
  el.className = "step" + (state === "done" ? " done" : (state === "now" ? " now" : ""));
}

/** Which panel the person is standing on, as one answer.
 *
 *  It is derived from `phase()` — the same function the button is labelled from — so the
 *  card and the steps cannot disagree about where somebody is. They did: the steps were
 *  marked independently, and an unfunded account read *Fund* and *Limits* as current at
 *  the same time, because "still choosing" was true of the second whenever the first was.
 *  A column of ticks absorbed that; breadcrumbs cannot, and should not — "where am I"
 *  has one answer or it is not navigation.
 *
 *  Null once the account is connected, when every step is behind you. */
function currentStep(): string | null {
  switch (phase()) {
    case "signin": return "cs1";
    case "fund": return "cs2";
    case "referral": return "csref";
    // The fee is asked for in the limits panel's own card, and `start` is that panel's
    // button, so both stand on step 3.
    case "fee": case "start": return "cs3";
    case "minting": case "approve": case "arming": return "cs4";
    default: return null;
  }
}

/* ── The breadcrumbs and the carousel (`tasks/38` §2) ──────────────────────
 *
 * The panels *are* the four steps; nothing about them is duplicated here. This paints a
 * bar per visible step from the state `stepState` just wrote, so "where am I" is one
 * idea and not two, and scrolls the track to whichever step is current.
 *
 * On a wide screen the CSS leaves the steps as a column and these bars are a quiet
 * index. On a phone one panel shows at a time and they are the only thing saying how
 * many there are — which is what makes a carousel acceptable on a screen that asks
 * somebody to sign things. */

/** The panels in order, with the short name its bar carries. Built from the DOM rather
 *  than written twice: a step that is `hidden` — the referral one, for an account that
 *  already has a code — is not a stop on this journey. */
function crumbSteps(): { el: HTMLElement; name: string }[] {
  // Short enough to sit in a fifth of a phone's width. The panel carries the real
  // heading; this is a place marker, not a second title.
  const NAMES: Record<string, string> = {
    cs1: "Sign in", cs2: "Fund", csref: "Referral", cs3: "Limits", cs4: "Approve",
  };
  return $$<HTMLElement>("#ctrack .step")
    .filter((el) => !el.hidden)
    .map((el) => ({ el, name: NAMES[el.id] ?? el.querySelector("h3")?.textContent ?? "" }));
}

/** Bring one panel into view. A no-op on a desktop, where the track is not scrollable
 *  and every panel is already on screen. */
function goToStep(el: HTMLElement): void {
  const track = $("ctrack");
  if (track.scrollWidth <= track.clientWidth) return;
  track.scrollTo({ left: el.offsetLeft - track.offsetLeft, behavior: "smooth" });
}

function paintCrumbs(): void {
  const steps = crumbSteps();
  // The numbers, written here rather than in the markup because one step is
  // conditional: a static 1–5 reads "1 2 4 5" for the majority who already have a
  // referral code and never see that panel.
  steps.forEach((s, i) => { s.el.dataset.n = String(i + 1); });
  const nav = $("ccrumbs");
  // Signed out there is no journey yet, and the queue may own the screen entirely.
  nav.hidden = steps.length === 0 || $("ctrack").hidden;
  const list = $("ccrumblist");
  list.innerHTML = "";
  for (const s of steps) {
    const li = document.createElement("li");
    li.className = s.el.classList.contains("done") ? "done" : (s.el.classList.contains("now") ? "now" : "");
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = s.name;
    // A step you have already been through is worth re-reading — that is the whole
    // point of not hiding the process. One you have not reached is not clickable,
    // because arriving at it out of order would show a panel whose controls are not
    // live yet.
    b.disabled = li.className === "";
    b.addEventListener("click", () => goToStep(s.el));
    li.appendChild(b);
    list.appendChild(li);
  }
  const now = steps.find((s) => s.el.classList.contains("now"));
  if (now && now.el !== lastCurrent) { lastCurrent = now.el; goToStep(now.el); }
}

/* Which panel the carousel was last scrolled to, so it follows the flow forward without
   yanking the view back every time the status is repolled. */
let lastCurrent: HTMLElement | null = null;

/** How far down the page the connect view starts, published to CSS as `--shell-top`.
 *
 *  The phone layout is one screenful — the step's panel scrolling inside it and the
 *  action pinned where a thumb is — which needs a real height, and that height is the
 *  viewport minus this. It is measured rather than written into the stylesheet because
 *  it is the header plus whatever padding `.wrap` has at this width: a constant would be
 *  right today and wrong the first time either changes, silently, on the one layout
 *  nobody is looking at on a desktop.
 *
 *  Above the breakpoint the variable is set and unused — the desktop rule never reads
 *  it — so there is no branch here about which layout is in force. */
function sizeShell(): void {
  const v = document.getElementById("v-connect");
  if (!v || v.hidden) return;
  const top = Math.round(v.getBoundingClientRect().top + window.scrollY);
  document.documentElement.style.setProperty("--shell-top", `${top}px`);
}

function paintConnect(st: ConnectStatus | null): void {
  const me = getMe();
  const signedIn = !!me;
  last = st;
  // Step 1 is only a step for somebody who has not taken it. Anybody reading the rest of
  // this screen signed in to get here, so it would be a permanent tick sitting in front
  // of the three things that are actually left — and with breadcrumbs that is a quarter
  // of the journey spent on a stop nobody can be standing at. It stays for the signed-out
  // visitor the queue talks to, for whom it is genuinely next.
  //
  // Nothing else needs changing: the count in the headline and the breadcrumbs are both
  // built from the panels that are visible.
  $("cs1").hidden = signedIn;
  stepState($("cs1"), signedIn ? "done" : "now");   // replaced below once `st` is known
  if (me) $("c1d").innerHTML = 'Signed in as <span class="mono">' + esc(me.address) +
    '</span>. The signature proved you control this address; it authorised nothing.';

  if (!st) {
    stepState($("cs2"), signedIn ? "now" : ""); stepState($("cs3"), ""); stepState($("cs4"), "");
    paintAction();
    return;
  }

  // The constants the floor is derived from. Taken from the server rather than written
  // here, because a copy of $10 that drifts would advertise a deposit that cannot trade.
  MINNOTIONAL = st.minOrderNotionalUsd; DAILY = st.dailyLossPct; RESERVE = st.reserveFrac;
  $("cminnotional").textContent = money(MINNOTIONAL).replace(".00", "");
  $("cminfund").textContent = money(worstFloor());
  $("cminfund2").textContent = money(worstFloor());
  $("cdaily").textContent = (DAILY * 100).toFixed(0) + "%";
  const choosing = st.step === "choose";
  // Step 2 is done when the account holds enough, not when somebody signed in: with a
  // deposit box on the page it is a step people actually stand on.
  // One current step, and everything before it is behind you. Reading the order off the
  // DOM rather than a list here means adding or hiding a panel needs no second edit —
  // and the referral panel is hidden for most accounts.
  const order = $$<HTMLElement>("#ctrack .step").filter((el) => !el.hidden);
  const cur = currentStep();
  const at = cur === null ? order.length : order.findIndex((el) => el.id === cur);
  order.forEach((el, i) => stepState(el, i < at ? "done" : (i === at ? "now" : "")));
  // Renewal is the exception: the account is connected, so nothing is "current" — but
  // step 4 is the panel doing the work and has to say so.
  if (renewing) stepState($("cs4"), "now");

  $("cminting").hidden = st.step !== "minting";
  // Renewing shows the approve panel over an account that is already active — the
  // address to re-approve is the same one, and it is the only thing on this page that
  // fixes a lapsing approval.
  $("capprove").hidden = st.step !== "approve" && !renewing;
  $("cactive").hidden = st.step !== "active" || renewing;
  $("crenew").hidden = !renewing;
  // Arriving here from the desk's "Do it on Hyperliquid" button is somebody choosing
  // the manual route on purpose, so it is already open — making them ask twice for the
  // thing they just asked for would be its own small insult.
  if (renewing) {
    $("cmanual").hidden = false;
    $("capprovehint").hidden = true;
    $("capprovemanual").hidden = true;
  }
  // A first approval is a link in the chain the card at the top is running, so the only
  // button here is the renewal's — which is a different flow over an account that is
  // already connected, and has nowhere else to live.
  $("capprovego").hidden = !renewing;

  // Offered exactly while something is pending: before that there is nothing to cancel,
  // and after it the desk manages a real account and "unlink" on the desk is the door.
  const pending = st.step === "minting" || st.step === "approve";
  $("ccancelwrap").hidden = !pending || st.unlinking;
  $("ccancelling").hidden = !pending || !st.unlinking;

  if (st.agentAddress) $<HTMLInputElement>("cagent").value = st.agentAddress;
  $("cerr").hidden = !st.lastError;
  if (st.lastError) $("cerr").innerHTML = "<strong>Not connected yet.</strong> " + esc(st.lastError);

  // Everything past step 3 waits on the executor. "Nothing is happening" is a much
  // worse message than "the desk is not running".
  const stale = st.executorSeenSecondsAgo === null || st.executorSeenSecondsAgo > 300;
  $("cdown").hidden = choosing || !stale;

  // What the user asked for is not what they get: the account must also be permitted,
  // funded, and inside the account cap. Report the outcome, never echo the request.
  if (st.step === "active") {
    const live = st.resolvedMode === "live";
    $("cactivenote").className = "note " + (live ? "good" : "warn");
    $("cactivenote").innerHTML = live
      ? "<strong>Connected, trading real money.</strong> Your limits are frozen and the desk is "
      + "managing this account."
      : "<strong>Connected, but simulated.</strong> Every order is placed against live prices "
      + "with nothing real at risk. This account is not enabled for real money yet — that is "
      + "an operator decision, not a setting, and nothing you can change here will alter it.";
  }

  if (st.settings && !choosing) {
    lev = st.settings.leverage; stopPct = st.settings.stopPct * 100;
    per = st.settings.perSignalPct * 100; on = st.settings.stopLoss;
    holdToTarget = st.settings.holdToTarget === true;
    $<HTMLInputElement>("sp").value = String(stopPct);
    $<HTMLInputElement>("ps").value = String(per);
    $<HTMLInputElement>("stopon").checked = on;
    $$<HTMLButtonElement>("#lev button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.l) === lev)));
    // An account an operator pinned to holding still has to show it, even while the
    // web cannot choose it — the screen reports what is in force, never what we would
    // have let them ask for.
    $$<HTMLButtonElement>("#exitp button").forEach((b) => b.setAttribute("aria-pressed", String((b.dataset.h === "1") === holdToTarget)));
  }
  render();
  paintAction();
  // Last, because it reads the classes every `stepState` above just wrote and the
  // hidden-ness `paintAction` just decided for the referral panel.
  paintCrumbs();
  sizeShell();
}

/* What the account actually holds. Step 2 used to be advice with no way to check it:
   the two ways to fund wrong — into the spot wallet, or too little to clear the $10
   minimum — are both silent, and you found out on the executor's next pass, if at all.
   This is a display read; the executor does its own before it places anything. */
async function refreshBalance(): Promise<void> {
  const el = $("cbal");
  if (!getMe()) { el.hidden = true; $("cspotwarn").hidden = false; bal = null; render(); return; }
  try {
    bal = await api<ConnectBalance>("/api/connect/balance");
    const unified = bal.abstraction === "unifiedAccount";
    el.hidden = false;
    // The standing spot/perp note explains a distinction that stops mattering the
    // moment we can see the money: once `enough` is true we have already read which
    // kind of account this is and summed accordingly, and the panel below says so in
    // this account's own terms. Keep it up while it is still advice, drop it after.
    $("cspotwarn").hidden = bal.enough;
    el.className = "note " + (bal.enough ? "good" : "warn");
    el.innerHTML = (bal.enough
      ? "<strong>Funded — we can see " + money(bal.usableUsd) + ".</strong> That is what we would trade."
      : "<strong>Not enough to trade yet.</strong> " + esc(bal.message))
      + '<div class="hint" style="margin-top:8px">perp wallet ' + money(bal.perpEquityUsd)
      + ' · spot ' + money(bal.spotUsdc)
      // Explain the spot balance only when there is one. On an empty account both
      // numbers are $0.00 and a sentence about collateral explains nothing.
      //
      // Neither branch is a chore any more. Until 2026-09-10 the second one read "move
      // it to the perp wallet", which was the right instruction while we inherited
      // whatever margin mode a deposit rail left behind; we set the mode ourselves now,
      // so the money is collateral wherever it landed and this line only says where it
      // is (`src/hl/abstraction.ts`).
      + (bal.spotUsdc > 0
        ? (unified ? " (this account is unified, so spot counts as collateral)"
          : " (spot counts once we connect — the desk switches unified margin on)")
        : "") + '</div>';
  } catch (e) {
    // Hyperliquid unreachable, or no venue at boot. Say which, rather than showing a
    // balance-shaped blank that reads as $0 — the failure that wastes the most time.
    bal = null;
    $("cspotwarn").hidden = false;
    if ((e as ApiError).status === 401) { el.hidden = true; }
    else {
      el.hidden = false; el.className = "note";
      el.textContent = "We cannot read this account from Hyperliquid just now, so we " +
        "cannot tell you what it holds. Everything else on this screen still works.";
    }
  }
  render();
}

/* What the desk charges this account (`tasks/33`). Silent on every failure and on every
   account that is not being asked: this decides whether a *sentence* appears, never
   whether anybody may trade — `connectAccount` decides that, from the venue, and it
   would refuse an unapproved required account whatever this line did. So a failed read
   leaves `fee` null, the panel hidden and the button ungated, and the user meets the
   executor's own refusal a minute later with the reason on their screen. The other
   direction — a page that blocked its own button because a fetch failed — would be an
   outage we invented. */
async function refreshFee(): Promise<void> {
  if (!getMe()) { fee = null; feeOwed = false; renderConnectFee(null, $("cfee")); return; }
  try { fee = await api<FeeState>("/api/fee"); } catch { fee = null; }
  feeOwed = renderConnectFee(fee, $("cfee"));
  paintAction();
}

export async function refreshConnect(): Promise<void> {
  // Signed out still has a queue state to paint — "the desk is full, sign in to take a
  // place" — and returning here without saying so is what left a stranger looking at
  // four steps about funding an account they cannot yet connect.
  if (!getMe()) { paintConnect(null); void refreshQueue(); return; }
  try {
    const st = await api<ConnectStatus>("/api/connect/status");
    paintConnect(st);
    // The queue owns which of the four steps are on screen at all (`tasks/17`): an
    // address that has not been admitted sees its place instead of them. Deliberately
    // after `paintConnect`, which paints the steps as though they were visible — it
    // has no business knowing about the door, and this is the only line that does.
    // Repainted after it lands, because the door decides whether the action card is on
    // screen at all and `paintConnect` ran before the answer was known.
    void refreshQueue().then(paintAction);
    // After paintConnect, so the floor is computed from the constants it just applied.
    void refreshBalance();
    void refreshFee();
    void refreshReferral();
    // Prefills the deposit box without opening anything. Only ever reads a wallet that
    // has already granted this origin an account.
    void readFundsQuietly();
    stopPolling();
    // Poll only while something is genuinely pending and the page is showing it.
    // Also while they are still choosing: step 2 is where someone is depositing, and
    // the balance panel is the thing they are waiting to change.
    if ((st.step === "choose" || st.step === "minting" || st.step === "approve") && isShowing("connect")) {
      pollTimer = setInterval(() => void refreshConnect(), 15000);
    }
    if (st.step === "active") await refreshMe();
  } catch (e) {
    if ((e as ApiError).status === 401) { sessionExpired(); paintConnect(null); }
  }
}

export function wireConnect(signIn: () => void): void {
  // The screen's defaults come off the controls themselves, so the markup is the page's
  // one copy of them and this file cannot drift from what someone is looking at.
  stopPct = Number($<HTMLInputElement>("sp").value);
  per = Number($<HTMLInputElement>("ps").value);
  on = $<HTMLInputElement>("stopon").checked;
  const pressed = $$<HTMLButtonElement>("#lev button").find((b) => b.getAttribute("aria-pressed") === "true");
  if (pressed) lev = Number(pressed.dataset.l);
  $("lev").addEventListener("click", function (this: HTMLElement, e) {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    lev = Number((b as HTMLButtonElement).dataset.l);
    this.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  });
  $("sp").addEventListener("input", function (this: HTMLInputElement) { stopPct = Number(this.value); render(); });
  $("ps").addEventListener("input", function (this: HTMLInputElement) { per = Number(this.value); render(); });
  $("stopon").addEventListener("change", function (this: HTMLInputElement) { on = this.checked; render(); });
  // A disabled button fires no click, so the locked half is unreachable here without
  // the handler needing to know the date. When it opens, the `disabled` attribute in
  // the markup comes off and this already works.
  $("exitp").addEventListener("click", function (this: HTMLElement, e) {
    const b = (e.target as HTMLElement).closest("button");
    if (!b || (b as HTMLButtonElement).disabled) return;
    holdToTarget = (b as HTMLButtonElement).dataset.h === "1";
    this.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  });
  render();

  // The referral step's two buttons (`tasks/37` §7.5). Neither signs anything and
  // neither talks to a server: the choice rides on the connect request, so pressing
  // *Apply* here is a decision and the executor's agent is what acts on it — after the
  // account is funded and the agent approved, which are the two things `setReferrer`
  // needs and neither of which has happened yet.
  //
  // *Skip* is not decoration. An offer that cannot be declined is not an offer, and
  // this is the one step in the chain where declining costs its owner 4% of the venue's
  // fee and nothing else — the account trades identically either way.
  $("crefskip").addEventListener("click", () => {
    goError(null);
    refChoice = "";
    // Straight on, because a skip is an answer and the chain should not need a second
    // press to accept one.
    void advance(signIn);
  });
  $("crefcode").addEventListener("input", () => goError(null));

  // Rotating a phone changes the height this layout is built from, and an in-app
  // browser's toolbar sliding away changes it without any event but this one.
  window.addEventListener("resize", sizeShell);
  sizeShell();

  // The one button. Everything the chain needs is decided in `advance()`; this is a
  // click handler and nothing else, which is the point — there is one place where the
  // order of the steps is written down.
  $("cgo").addEventListener("click", () => { void advance(signIn); });
  // Recomputes the refusal and the decoded destination as somebody types, so the
  // sentence that would stop the transaction is on screen before it is asked for.
  $("cdepamt").addEventListener("input", () => { goError(null); paintDeposit(); });

  // Unlink. Two presses, because this ends a mandate over a real account — and the
  // confirmation states the consequence that is easy to miss: the position survives, the
  // management does not.
  $("dunlink").addEventListener("click", function (this: HTMLElement) {
    $("dunlinkerr").hidden = true;
    $("dunlinkconfirm").hidden = false;
    this.hidden = true;
  });
  $("dunlinkno").addEventListener("click", () => {
    $("dunlinkconfirm").hidden = true;
    $("dunlink").hidden = false;
  });
  $("dunlinkyes").addEventListener("click", async function (this: HTMLButtonElement) {
    const b = this; b.disabled = true; b.textContent = "Stopping…";
    try {
      await api("/api/connect/unlink", { method: "POST" });
      $("dunlinkconfirm").hidden = true;
      await refreshMe();
      await refreshConnect();
      show("connect");
    } catch (e) {
      $("dunlinkconfirm").hidden = true;
      $("dunlink").hidden = false;
      $("dunlinkerr").hidden = false;
      $("dunlinkerr").textContent = (e as Error).message || "Could not unlink. Try again.";
    } finally { b.disabled = false; b.textContent = "Yes, stop managing it"; }
  });

  // Step 4, in one button. The agent key already exists — minted and sealed on the
  // server when step 3 was submitted — so this is a signature, not a setup: nothing is
  // generated here, nothing is pasted, and the address never has to be handled.
  //
  // On success `refreshConnect` is what advances the screen, not this: the executor
  // still has to see the approval and connect the account, and reporting anything else
  // would be claiming an outcome we do not control.
  $("capprovego").addEventListener("click", () => {
    void runApproval($("capproveflow"), () => { void refreshConnect(); }, renewing ? "renew" : "connect");
  });

  // The manual route, revealed rather than removed. Approving on Hyperliquid's own
  // domain is a real trust anchor for somebody who would rather not sign on ours.
  $("capprovemanual").addEventListener("click", function (this: HTMLButtonElement) {
    $("cmanual").hidden = false;
    $("capprovehint").hidden = true;
    this.hidden = true;
  });

  $("ccopy").addEventListener("click", function (this: HTMLButtonElement) {
    const b = this, v = $<HTMLInputElement>("cagent").value;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject(new Error("no clipboard"))).then(() => {
      b.textContent = "Copied";
      setTimeout(() => { b.textContent = "Copy address"; }, 1500);
    }, () => { $<HTMLInputElement>("cagent").select(); });
  });

}
