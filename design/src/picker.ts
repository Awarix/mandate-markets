// The wallet chooser, and the screen for having no wallet at all.
//
// One overlay serves both: they are the same question — "which wallet do we talk to?" —
// and the answer is either a list or an explanation of why the list is empty.

import { $, esc } from "./dom.ts";
import type { Wallet } from "./wallet.ts";

function close(): void {
  $("wpick").hidden = true;
  $("wpicklist").innerHTML = "";
}

/** Resolves with the chosen wallet, or null if the person backed out. */
export function chooseWallet(wallets: Wallet[]): Promise<Wallet | null> {
  return new Promise((resolve) => {
    const list = $("wpicklist");
    $("wpickh").textContent = "Which wallet?";
    $("wpickwhy").innerHTML = "More than one wallet is installed. Pick the one holding the "
      + "Hyperliquid account you want managed — we sign in as whatever address it returns, "
      + "and that is the account we would manage.";
    list.innerHTML = wallets.map((w, i) => {
      // A wallet's announced icon is a data: URI by the spec — and Phantom's arrives
      // with a leading newline (measured 2026-09-02, four wallets installed), so an
      // untrimmed `startsWith` drops its icon for a placeholder. Trim before testing
      // and before using: vendor-supplied strings are data, not promises.
      const icon = w.info.icon.trim();
      return '<button class="wopt" data-i="' + i + '">'
      // An announced name is a string the wallet chose, so it is escaped like any
      // other untrusted text.
      + (icon.startsWith("data:") ? '<img src="' + esc(icon) + '" alt="">' : '<span class="wdot"></span>')
      + '<span><span class="wname">' + esc(w.info.name) + '</span>'
      + (w.info.rdns ? '<span class="rdns">' + esc(w.info.rdns) + '</span>' : '')
      + '</span></button>';
    }).join("");

    const done = (w: Wallet | null) => { cleanup(); close(); resolve(w); };
    const onPick = (e: Event) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>(".wopt");
      if (!b) return;
      done(wallets[Number(b.dataset.i)] ?? null);
    };
    const onCancel = () => done(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") done(null); };
    function cleanup(): void {
      list.removeEventListener("click", onPick);
      $("wpickno").removeEventListener("click", onCancel);
      document.removeEventListener("keydown", onKey);
    }
    list.addEventListener("click", onPick);
    $("wpickno").addEventListener("click", onCancel);
    document.addEventListener("keydown", onKey);

    $("wpick").hidden = false;
    $<HTMLButtonElement>("wpickno").focus();
  });
}

/** No wallet announced itself and there is no legacy injection either.
 *
 *  On a desktop browser that means "install one". On a phone it usually means the
 *  browser has no way to inject at all, which is not the visitor doing anything wrong
 *  and should not read like it — so the wallet's own browser is named as the way in
 *  rather than left to be guessed. */
export function showNoWallet(): void {
  $("wpickh").textContent = "No wallet found in this browser";
  $("wpickwhy").innerHTML = "Sign-in needs a wallet that can sign a message. "
    + "<strong>On a desktop browser</strong>, install one — MetaMask, Rabby and Coinbase "
    + "Wallet all work — then sign in again. "
    + "<strong>On a phone</strong>, Safari and Chrome cannot reach your wallet: open "
    + "mandate.markets inside your wallet app's own browser instead.";
  $("wpicklist").innerHTML = "";
  const onCancel = () => { $("wpickno").removeEventListener("click", onCancel); close(); };
  $("wpickno").addEventListener("click", onCancel);
  $("wpick").hidden = false;
  $<HTMLButtonElement>("wpickno").focus();
}
