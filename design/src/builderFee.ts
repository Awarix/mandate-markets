// Agreeing to the builder fee, in this page.
//
// `design/src/renew.ts` is the template and the mechanics are the same one signature,
// so what is written down here is only what is *different* — and it is different in the
// way that matters most, because this is the one thing on the site somebody is asked to
// pay for.
//
//  - **There are two populations now, and the copy is not the same for both**
//    (`tasks/33`, owner 2026-09-10). For an account that connected before
//    `BUILDER_FEE.requiredForConnectionsFrom` nothing has changed: declining costs
//    nothing, its orders simply carry no builder code, and the invitation keeps the
//    quiet colour, no countdown and no second ask. For an account that connected after,
//    the fee is a **condition of being traded**, and "if you want to support the desk"
//    would be the screen lying about what happens next — so that branch states what the
//    desk charges and what not approving means, in the same plain register.
//    Still no warning colour in either: nothing is wrong with the account.
//    The `required` flag on `/api/fee` is the only thing that separates them, and the
//    refusal itself is the executor's — this file cannot make a fee mandatory and does
//    not pretend to.
//  - **The screen states the rate and stops there** (owner, 2026-09-09). It used to
//    annualise it — "24–72% of the account a year", which is what a fee on notional
//    comes to at this desk's turnover — and that is true, is in
//    `notes/2026-09-09-builder-fee-market-comparison.md` §5.2, and is still what
//    `npm run preflight` prints for us. It is not what goes here. Every comparable
//    frontend quotes a rate and nothing else, a builder fee is ordinary, and leading a
//    consent screen with the scariest true framing of an ordinary thing is its own kind
//    of dishonesty.
//    **What is not written here is a share of profit.** It was proposed as "±2%" and no
//    reading of the ledger supports it: the fee is ~8.7% of the measured per-signal edge
//    on the optimistic reading, and 42–83% of a 4.8% month on the reading that note says
//    to price against (§5.3). A number that wrong is worse on this screen than no number,
//    so the rate stands alone.
//  - **What is signed is a ceiling that equals today's rate.** That is worth saying on
//    screen rather than only in a comment: it is the reason this signature cannot
//    become a larger fee later without being asked for again.

import { api, type ApiError, type FeeState, type PreparedApproval } from "./api.ts";
import { $, esc } from "./dom.ts";
import { chooseWallet, showNoWallet } from "./picker.ts";
import { getMe } from "./session.ts";
import {
  chainIdOf, discoverWallets, isUserRejection, requestAddress, signTypedData,
  type Eip1193Provider,
} from "./wallet.ts";

function note(host: HTMLElement, cls: string, html: string): void {
  host.innerHTML = '<div class="note ' + cls + '">' + html + "</div>";
}

/** The decoded action — the same mitigation the agent approval uses for being signed
 *  here rather than on Hyperliquid's own domain. Rendered *with* the wallet prompt, so
 *  it is on screen for exactly as long as the wallet is asking about it. */
function decoded(p: PreparedApproval): string {
  return '<dl style="margin:14px 0 0; display:grid; grid-template-columns:auto 1fr; gap:6px 16px">'
    + '<dt class="mono">Rate</dt><dd class="mono" style="margin:0">' + esc(p.percent)
    + " of each order, both sides</dd>"
    + '<dt class="mono">Maximum</dt><dd class="mono" style="margin:0">' + esc(p.percent)
    + " — the same number, so this cannot become more without asking you again</dd>"
    + '<dt class="mono">Paid to</dt><dd class="mono" style="margin:0; word-break:break-all">'
    + esc(p.builder) + "</dd></dl>";
}

/** Run the approval: choose a wallet, build the action, sign it, relay it.
 *
 *  `host` is the element this renders into; `onDone` runs once Hyperliquid accepted it.
 *
 *  **Returns whether the venue took it.** Nothing needed that while the fee was purely
 *  optional — the settings card just redrew itself. The connect flow does
 *  (`tasks/33` §2): it must not mint an agent key for an account that then cannot arm,
 *  so it has to be able to stop. `false` covers a declined wallet prompt as much as a
 *  failure, because they land in the same place: no approval, so no key. */
export async function runFeeApproval(host: HTMLElement, onDone: () => void): Promise<boolean> {
  const me = getMe();
  if (!me) { note(host, "warn", "<strong>Sign in first.</strong>"); return false; }

  note(host, "", '<span class="mono">Looking for your wallet…</span>');

  let provider: Eip1193Provider;
  try {
    const found = await discoverWallets();
    if (found.length === 0) { host.innerHTML = ""; showNoWallet(); return false; }
    const chosen = found.length === 1 ? found[0]! : await chooseWallet(found);
    if (!chosen) { host.innerHTML = ""; return false; }  // backed out of the picker
    provider = chosen.provider;
  } catch (e) {
    return fail(host, onDone, e);
  }

  let p: PreparedApproval;
  try {
    const address = await requestAddress(provider);
    // Only the master wallet can approve a builder for its own account. Catching the
    // mismatch here means an explanation rather than a signature our own server refuses
    // a step later.
    if (address.toLowerCase() !== me.address.toLowerCase()) {
      note(host, "warn",
        "<strong>That is a different account.</strong> Only an account's own wallet can "
        + "approve a fee for it — switch accounts in your wallet and try again.");
      return false;
    }
    note(host, "", '<span class="mono">Preparing…</span>');
    const chainId = await chainIdOf(provider);
    p = await api<PreparedApproval>("/api/fee/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId }),
    });
  } catch (e) {
    return fail(host, onDone, e);
  }

  try {
    note(host, "", '<span class="mono">Check your wallet…</span>' + decoded(p));
    const signature = await signTypedData(provider, me.address, p.typedData as never);
    note(host, "", '<span class="mono">Sending…</span>' + decoded(p));
    await api("/api/fee/relay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signature }),
    });
  } catch (e) {
    return fail(host, onDone, e);
  }

  // Confirm from the venue rather than from the fact that our own POST returned. The
  // desk's copy of this comes off the executor's heartbeat, so reloading the desk here
  // would redraw "we charge nothing" over the confirmation the wallet just produced —
  // indistinguishable from the signature not having worked. `tasks/33` §3 shortened
  // that window from an hour to a loop; it did not close it, because the heartbeat is
  // still written by a different process.
  let confirmed: FeeState | null = null;
  try { confirmed = await api<FeeState>("/api/fee"); } catch { /* the relay succeeded */ }

  // "from the desk's next hourly check" was true until `tasks/33` §3 and is not any
  // more: an account reading `unapproved` is now re-read every loop, so this lands
  // within a minute. Saying "hourly" here would be describing a delay we removed
  // precisely because the connect flow made it the common case.
  note(host, "good",
    "<strong>Approved.</strong> "
    + (confirmed?.state === "charging"
      ? "Hyperliquid has it: orders from this account carry our builder code at "
        + esc(p.percent) + "."
      : "Hyperliquid took the signature. The desk picks it up on its next loop.")
    + " You can revoke it on Hyperliquid at any time.");
  onDone();
  return true;
}

function fail(host: HTMLElement, onDone: () => void, e: unknown): false {
  // Declining is a decision, not an error. For a grandfathered account it is also
  // free, and this screen has to make that obvious; for an account that has to approve
  // before it arms, saying "still trading" would be a lie — so neither sentence claims
  // an outcome, and the connect flow prints the consequence where it applies.
  const rejected = isUserRejection(e);
  const msg = rejected ? "" : ((e as ApiError)?.message ?? String(e));

  note(host, rejected ? "" : "warn",
    (rejected
      ? "<strong>Nothing was signed.</strong> Your account is exactly as it was."
      : "<strong>That did not go through.</strong> " + esc(msg)
        + " Your account is unchanged.")
    + '<div style="margin-top:12px"><button class="btn ghost sm" id="dfeeretry">Try again</button></div>');

  $("dfeeretry").addEventListener("click", () => { void runFeeApproval(host, onDone); }, { once: true });
  return false;
}

/** The line on the settings screen, in the three states `FeeStatus` has.
 *
 *  `off` renders nothing at all — not "no fee", which would raise a subject nobody
 *  asked about and imply one is coming.
 *
 *  `unapproved` renders **two different things** since `tasks/33`, and the difference is
 *  `required`. A grandfathered owner is being offered something and the copy stays an
 *  invitation in the quiet colour. An owner whose account will not arm without it is
 *  being told a condition, and dressing that as "if you want to support the desk" would
 *  be the screen lying about what happens next. */
export function renderFee(fee: FeeState | null, host: HTMLElement, onDone: () => void): void {
  if (!fee || fee.state === "off") { host.hidden = true; host.innerHTML = ""; return; }
  host.hidden = false;

  if (fee.state === "charging") {
    host.innerHTML = '<div class="kv"><span class="k">Our fee</span><span>' + esc(fee.percent)
      + " of each order</span></div>"
      + '<div class="kvnote">Charged by Hyperliquid on the orders we place for you and paid to us. '
      + "You approved this" + (fee.required
        ? ", and it is what this account is managed on. Revoking it on Hyperliquid stops us "
          + "placing new positions; anything open keeps its stop and its target."
        : " and can revoke it on Hyperliquid at any time; your account keeps trading either way.")
      + "</div>";
    return;
  }

  if (fee.required) {
    // A condition, said plainly. No warning colour and no urgency — nothing is wrong
    // with the account, it simply has not started yet — but the consequence is stated
    // rather than implied, because the executor really will not arm it.
    host.innerHTML = '<div class="kv"><span class="k">Our fee</span><span>' + esc(fee.percent)
      + " of each order</span></div>"
      + '<div class="kvnote">This is what the desk charges: <strong>' + esc(fee.percent)
      + " of each order</strong>, on both sides of every trade we place for you, collected by "
      + "Hyperliquid and paid to us. <strong>This account is not being traded until it is "
      + "approved.</strong> It is one signature from the wallet that owns the account, it moves "
      + "no money, and nothing is charged until an order fills."
      + '<div style="margin-top:10px"><button class="btn sm" id="dfeeapprove">Approve the fee</button></div>'
      + "</div>";
  } else {
    // Grandfathered. An invitation, in the quiet colour — a fee nobody has agreed to is
    // not a problem with the account and must not be dressed as one.
    host.innerHTML = '<div class="kv"><span class="k">Our fee</span><span>None</span></div>'
      + '<div class="kvnote">We charge nothing on this account. If you want to support the desk, '
      + "you can approve a builder fee of <strong>" + esc(fee.percent) + " of each order</strong>, "
      + "collected by Hyperliquid on both sides of the trades we place for you. Nothing changes "
      + "about how your account is traded, and you can revoke it at any time."
      + '<div style="margin-top:10px"><button class="btn ghost sm" id="dfeeapprove">Approve the fee</button></div>'
      + "</div>";
  }

  // The flow replaces this whole block rather than rendering under it, the way the
  // renewal replaces `#dagent`. Otherwise the invitation — and its button — would still
  // be sitting above the confirmation that it had been accepted.
  $("dfeeapprove").addEventListener("click", () => { void runFeeApproval(host, onDone); });
}

/** What step 3 of the connect flow says about the fee, above the button that will ask
 *  for the signature (`tasks/33` §2).
 *
 *  Nothing at all unless this account has to approve one: a grandfathered owner meets
 *  the invitation on the settings screen, where it has always been, and a connect flow
 *  that raised the subject anyway would be asking for money at the worst possible
 *  moment for no reason. Returns whether a signature is owed, so the caller knows
 *  whether to gate on it rather than deciding twice. */
export function renderConnectFee(fee: FeeState | null, host: HTMLElement): boolean {
  const owed = !!fee && fee.required === true && fee.state === "unapproved";
  if (!fee || fee.state === "off" || !fee.required) {
    host.hidden = true; host.innerHTML = "";
    return false;
  }
  host.hidden = false;
  host.innerHTML = fee.state === "charging"
    ? "<strong>Our fee: " + esc(fee.percent) + " of each order.</strong> Approved on this "
      + "account — Hyperliquid has it, and there is nothing more to sign."
    : "<strong>Our fee: " + esc(fee.percent) + " of each order.</strong> On both sides of every "
      + "trade we place for you, collected by Hyperliquid and paid to us. The button below asks "
      + "your wallet for this first, then for the agent — two signatures, neither of which can "
      + "move your money. What you sign is a ceiling equal to today's rate, so it cannot become "
      + "more without asking you again.";
  return owed;
}
