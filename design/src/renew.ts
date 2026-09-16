// Granting — and re-granting — the agent approval without leaving the page.
//
// One flow serves both, because they are the same signature. A first approval is the
// `connect` intent and a lapsing one is `renew`; the only differences are the words and
// whether an existing entry has to be cleared first, and the server decides the latter.
//
// The trust tradeoff here is real and is not papered over. Today people grant trading
// rights on *Hyperliquid's own domain*, which is a genuine anchor for a cautious
// person; doing it here is more convenient and less verifiable. So two rules:
//
//  - **What is being signed is on screen, decoded** — the agent address, the name, the
//    date it expires — and it stays there for as long as the wallet is asking. Nobody
//    is asked to trust a dialog they cannot read, and refusing costs nothing: the
//    wallet's own cancel leaves the account exactly as it was.
//  - **"Do it on Hyperliquid instead" stays visible.** The old path is not removed.
//
// The wallet opens without a second click, because every entry point here is already a
// button that says it will approve something. That is not "prompting unasked":
// `tasks/13`'s rule is that the *expiry notice* must be a button rather than an
// automatic popup, and it still is. What changed is that the decode is rendered
// alongside the wallet prompt instead of in front of a second confirm button — the
// same information, one fewer click, and a cancel that still costs nothing.

import { api, type ApiError, type PreparedRenewal } from "./api.ts";
import { $, DATE_LOCALE, esc, shortAddr } from "./dom.ts";
import { chooseWallet, showNoWallet } from "./picker.ts";
import { getMe } from "./session.ts";
import {
  chainIdOf, discoverWallets, isUserRejection, requestAddress, signTypedData,
  type Eip1193Provider,
} from "./wallet.ts";

const HL_API = "https://app.hyperliquid.xyz/API";

export type ApprovalIntent = "connect" | "renew";

function dayOf(iso: string): string {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(DATE_LOCALE, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function note(host: HTMLElement, cls: string, html: string): void {
  host.innerHTML = '<div class="note ' + cls + '">' + html + "</div>";
}

/** The escape hatch, rendered on every failure. An approval that cannot be completed
 *  here is not a dead end — it is the old flow, which still works. */
function hlFallback(): string {
  return '<a class="btn ghost sm" href="' + HL_API
    + '" target="_blank" rel="noopener noreferrer">Do it on Hyperliquid instead</a>';
}

/** The decoded action — the whole mitigation for signing here rather than on
 *  Hyperliquid's own domain. Rendered *with* each step rather than once before them, so
 *  it is on screen for exactly as long as a wallet is asking about it. */
function decoded(p: PreparedRenewal): string {
  return '<dl style="margin:14px 0 0; display:grid; grid-template-columns:auto 1fr; gap:6px 16px">'
    + '<dt class="mono">Agent</dt><dd class="mono" style="margin:0; word-break:break-all">' + esc(p.agentAddress) + "</dd>"
    + '<dt class="mono">Name</dt><dd class="mono" style="margin:0">' + esc(p.agentName) + "</dd>"
    + '<dt class="mono">Good until</dt><dd class="mono" style="margin:0">' + esc(dayOf(p.expiresAt)) + "</dd>"
    + "</dl>";
}

function step(host: HTMLElement, line: string, p: PreparedRenewal, why: string): void {
  note(host, "", '<span class="mono">' + esc(line) + "</span>" + why + decoded(p));
}

/** Run the whole approval: choose a wallet, build the action, sign it, relay it.
 *
 *  `host` is the element this renders into; `onDone` runs once Hyperliquid has accepted
 *  every step. */
/** Resolves `true` when the wallet actually signed the approval.
 *
 *  The caller needs to know, because **the server cannot tell it**: `/api/connect/status`
 *  keeps saying `approve` until the executor's next pass reads the approval off the venue
 *  and arms the account, which is up to a minute later. Without this the screen goes on
 *  offering *"Approve in your wallet"* over an approval that is already signed —
 *  Hyperliquid refuses a second one — and the person is left pressing it. */
export async function runApproval(
  host: HTMLElement, onDone: () => void, intent: ApprovalIntent = "renew",
): Promise<boolean> {
  const me = getMe();
  if (!me) { note(host, "warn", "<strong>Sign in first.</strong> " + hlFallback()); return false; }

  note(host, "", '<span class="mono">Looking for your wallet…</span>');

  let provider: Eip1193Provider;
  try {
    const found = await discoverWallets();
    if (found.length === 0) { host.innerHTML = ""; showNoWallet(); return false; }
    const chosen = found.length === 1 ? found[0]! : await chooseWallet(found);
    if (!chosen) { host.innerHTML = ""; return false; }  // backed out of the picker
    provider = chosen.provider;
  } catch (e) {
    return fail(host, onDone, intent, e);
  }

  let p: PreparedRenewal;
  try {
    const address = await requestAddress(provider);
    // The approval can only be signed by the master wallet itself. Catching a mismatch
    // here means an explanation rather than a signature that recovers to the wrong
    // address and is refused by our own server a step later.
    if (address.toLowerCase() !== me.address.toLowerCase()) {
      note(host, "warn",
        "<strong>That is a different account.</strong> This wallet is on "
        + esc(shortAddr(address)) + ", and the account signed in here is "
        + esc(shortAddr(me.address)) + ". Only the account's own wallet can approve an "
        + "agent for it — switch accounts in your wallet and try again."
        + '<div style="margin-top:12px">' + hlFallback() + "</div>");
      return false;
    }
    note(host, "", '<span class="mono">Preparing the approval…</span>');
    const chainId = await chainIdOf(provider);
    p = await api<PreparedRenewal>("/api/agent/renew/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId }),
    });
  } catch (e) {
    return fail(host, onDone, intent, e);
  }

  for (let i = 0; i < p.steps.length; i++) {
    const s = p.steps[i]!;
    const which = p.steps.length === 1 ? "" : ` (${i + 1} of ${p.steps.length})`;
    const what = s.step === "remove" ? "Clearing the old entry" : "Approving for 180 days";

    // Two signatures needs explaining, or it reads as a bug.
    const why = p.replacingExisting && i === 0
      ? '<div style="margin-top:10px">Your wallet will ask <strong>twice</strong>. '
        + "Hyperliquid cannot extend an approval and refuses to re-approve an address it "
        + "still holds, so this clears the old entry and the next puts the same address "
        + "back. Same agent, same key — nothing new is created.</div>"
      : "";

    step(host, what + which + " — check your wallet…", p, why);
    try {
      const signature = await signTypedData(provider, me.address, s.typedData);
      step(host, what + which + " — sending…", p, "");
      await api("/api/agent/renew/relay", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step: s.step, signature }),
      });
    } catch (e) {
      // Half-done is a state worth naming: the removal can land while the approval does
      // not, which leaves the account with **no** agent rather than an expiring one.
      const clearedAlready = p.steps[0]!.step === "remove" && i > 0;
      return fail(host, onDone, intent, e, clearedAlready);
    }
  }

  note(host, "good",
    (intent === "connect"
      ? "<strong>Approved.</strong> Your approval runs to "
      : "<strong>Renewed.</strong> Your approval now runs to ") + esc(dayOf(p.expiresAt))
    + ". The desk picks this up on its next pass — nothing else is needed from you.");
  onDone();
  return true;
}

function fail(
  host: HTMLElement, onDone: () => void, intent: ApprovalIntent, e: unknown,
  clearedAlready = false,
): false {
  // Declining is a decision, not an error. Say what it cost — nothing — and offer the
  // way back rather than an apology.
  const rejected = isUserRejection(e);
  const msg = rejected ? "" : ((e as ApiError)?.message ?? String(e));

  note(host, rejected ? "" : "warn",
    (rejected
      ? "<strong>Nothing was signed,</strong> and your account is exactly as it was."
      : "<strong>That did not go through.</strong> " + esc(msg))
    + (clearedAlready
      ? " <strong>The old entry was already cleared</strong>, so this account has no agent "
        + "until an approval succeeds. Open positions keep their stops on Hyperliquid; "
        + "nothing new can be placed until you finish."
      : "")
    + '<div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap; align-items:center">'
    + '<button class="btn sm" id="rretry">Try again</button>' + hlFallback() + "</div>");

  $("rretry").addEventListener("click", () => { void runApproval(host, onDone, intent); }, { once: true });
  return false;
}
