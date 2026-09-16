// Who is signed in, and the sign-in itself.
//
// The desk ships with invented numbers so the page works as a design and as a
// logged-out preview. Signing in replaces every one of them — nothing merges, so there
// is never a screen that is half real.

import { api, type ApiError, type Challenge, type Me } from "./api.ts";
import { $, $$, shortAddr } from "./dom.ts";
import { paintLeaderboardChrome } from "./leaderboard.ts";
import { show } from "./views.ts";
import { chooseWallet, showNoWallet } from "./picker.ts";
import { discoverWallets, isUserRejection, personalSign, requestAddress } from "./wallet.ts";

let me: Me | null = null;

export function getMe(): Me | null { return me; }
export function clearMe(): void { me = null; }

/** Called once there is an account to prefetch for. Registered by main.ts so this
 *  module does not have to know the desk exists. */
let prefetch: (() => void) | null = null;
export function onSignedIn(fn: () => void): void { prefetch = fn; }

export function paintChrome(): void {
  /* The editorial header holds two controls in either state, never four.
     Signed out: `Theme` and `Sign in`. Signed in: the address, which opens the menu
     everything else moved into, and one button that goes where the reader was headed.
     The address is no longer the button's own label — it is the trigger's, and a
     header carrying it twice would be reading the same fact back to itself. */
  const b = $("authbtn");
  if (me) { b.textContent = me.connected ? "Your desk" : "Finish connecting"; b.title = ""; }
  else { b.textContent = "Sign in"; b.title = "Sign in with your wallet"; }
  $("theme").hidden = !!me;
  $("authmenu").hidden = !me;
  // Settings is the account's own screen and there is no account until one is
  // connected; the desk header's copy is always shown, because reaching that header at
  // all means there is one.
  $$("[data-conn]").forEach((e) => { e.hidden = !me?.connected; });
  // The leaderboard is for the owners of the accounts on it, so the way in is offered
  // to them and to nobody else. The route refuses regardless — this only stops us
  // showing a stranger a button that has one outcome.
  paintLeaderboardChrome(me?.mode === "live");
  const short = me ? shortAddr(me.address) : "0x4Fe5…C08A";
  $("authmenu").textContent = short;
  $("dwho").textContent = short;
}

export async function refreshMe(): Promise<void> {
  try { me = await api<Me>("/api/me"); } catch { me = null; }
  paintChrome();
  if (me && me.connected) prefetch?.();
}

export async function signIn(): Promise<void> {
  const b = $<HTMLButtonElement>("authbtn"), was = b.textContent;
  b.disabled = true; b.textContent = "Looking for a wallet…";

  let provider;
  try {
    const found = await discoverWallets();
    if (found.length === 0) { showNoWallet(); return; }
    // One wallet is not a choice worth interrupting anybody for. Two is the case this
    // exists for: `window.ethereum` would have picked one of them arbitrarily.
    const chosen = found.length === 1 ? found[0]! : await chooseWallet(found);
    if (!chosen) return;                 // backed out of the picker
    provider = chosen.provider;
  } finally {
    if (!provider) { b.disabled = false; b.textContent = was; }
  }

  b.textContent = "Check your wallet…";
  try {
    const address = await requestAddress(provider);
    const ch = await api<Challenge>("/api/auth/nonce?address=" + encodeURIComponent(address));
    const signature = await personalSign(provider, ch.message, address);
    await api("/api/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, nonce: ch.nonce, signature }),
    });
    await refreshMe();
    // The desk is only somewhere to go once there is an account to show. Landing a
    // brand-new signer on it renders every figure as a dash and "settings could not be
    // read", which reads as broken rather than as "you have not connected yet".
    show(me && me.connected ? "desk" : "connect");
  } catch (e) {
    b.textContent = was;
    if (isUserRejection(e)) return;      // the person declined; that is not an error
    // A 401 here is the server refusing the signature, and the server now says which
    // kind of refusal it is: it classifies the signature's *shape* before verifying,
    // so a smart-contract wallet gets told what is actually wrong instead of "try
    // again", which was a lie to it. That message is worth passing through verbatim —
    // it is the one that says not to deposit. `tasks/11` §2 records why the answer is
    // a refusal rather than ERC-1271 support: Hyperliquid has no field to carry a
    // contract signature in any of its 118 exchange methods, so such an account can be
    // funded and can never be traded.
    const failed = (e as Error).message
      || ((e as ApiError).status === 401 ? "That signature could not be verified." : "Sign-in failed. Try again.");
    alert(failed);
  } finally { b.disabled = false; paintChrome(); }
}

// Reload either way: if the logout failed, the truth is that we are still signed in and
// the reloaded page will say so, rather than showing a desk we no longer trust.
export function signOut(): void {
  const reload = () => { location.reload(); };
  api("/api/auth/logout", { method: "POST" }).then(reload, reload);
}

/** Only used by the desk's error path, which must not import the whole session to say
 *  "that 401 means the session is gone". */
export function sessionExpired(): void {
  me = null;
  paintChrome();
}
