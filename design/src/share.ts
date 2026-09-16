import { api, type ApiError } from "./api.ts";
import { $ } from "./dom.ts";

// The share dialog (`tasks/16` §5, redesigned 2026-09-05 against Quotient's own).
//
// One dialog, reused by every share button on the page. It shows **the real PNG a
// scraper will fetch**, so what the owner approves is exactly what gets published —
// a preview rendered a second way would eventually disagree with the card, and the
// disagreement would only ever be discovered in somebody's feed.
//
// **The dollars checkbox is not a display toggle.** The server signs two links when
// the button is pressed: one carrying the amount, and one that does not carry it at
// all — not in the drawing and not in the query. This swaps between links that already
// exist, so the switch costs no round trip and "off" is a promise about the link rather
// than about the rendering.
//
// The share ladder underneath is still Eater's, with both of its fixes kept. On a phone
// (`(pointer: coarse)`) the OS sheet opens in one tap and reaches everything installed;
// on a desktop the dialog is the destination. The gate is whether a sheet *leads
// anywhere*, not whether `navigator.share` exists — on Windows Chrome it exists and
// opens a list of store apps. The URL is folded into the text for the sheet and the
// clipboard, because iOS and macOS drop the separate `url` field; X and Telegram take
// the link in a field they document, so they get the sentence without a trailing colon.

export type ShareLink = {
  url: string;
  image: string;
  text: string;
  /** The sentence with `@MandateMarkets` and `@QuotientHQ` in it. **X only** — Telegram
   *  resolves an `@name` against its own directory, and the sheet and the clipboard
   *  mention nobody. `xIntent` is the only place this is read. */
  xText: string;
};

export type ShareOffer = {
  kind: "home" | "position" | "trade" | "account";
  title: string;
  dollarsNote: string;
  dollarsDefault: boolean;
  withDollars: ShareLink;
  withoutDollars: ShareLink;
};

function sheetLeadsSomewhere(): boolean {
  return typeof navigator.share === "function"
    && typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
}

/** What the sheet and the clipboard get: one string, because the separate `url` field
 *  is dropped on iOS and macOS. */
export function folded(link: ShareLink): string {
  return `${link.text}: ${link.url}`;
}

export function xIntent(link: ShareLink): string {
  return "https://x.com/intent/tweet?text=" + encodeURIComponent(link.xText)
    + "&url=" + encodeURIComponent(link.url);
}

export function telegramIntent(link: ShareLink): string {
  return "https://t.me/share/url?url=" + encodeURIComponent(link.url)
    + "&text=" + encodeURIComponent(link.text);
}

/** What a card carries, said before it is published. The desk is private and this is
 *  the one action that makes part of it public, so the sentence is in the dialog rather
 *  than in a help page nobody opens. */
const NOTES: Record<ShareOffer["kind"], string> = {
  home: "",
  position: "This card shows the market, the leverage, the unrealised result and the moment it "
    + "was taken. Never your address, never your balance.",
  trade: "This card shows the market, why the position closed and the result net of fees and "
    + "funding. Never your address, never your balance.",
  account: "This card shows seven days of realised result net of costs, and how many trades hit "
    + "their target, stopped or closed otherwise. Never your address, never your balance.",
};

let current: ShareOffer | null = null;
let showDollars = true;

function link(): ShareLink {
  const o = current!;
  return showDollars ? o.withDollars : o.withoutDollars;
}

function say(msg: string, bad = false): void {
  const el = $("sharemsg");
  el.hidden = msg === "";
  el.className = bad ? "sharemsg" : "sharemsg quiet";
  el.textContent = msg;
}

/** Everything except the message, shown when there is a card and hidden when there is
 *  only a reason there is not one. */
function showCard(on: boolean): void {
  for (const id of ["sharedlgprev", "sharedollarslabel", "shareurl", "sharerow"]) $(id).hidden = !on;
}

/** Paint the dialog from whichever of the two links is selected. */
function paint(): void {
  const l = link();
  $<HTMLInputElement>("shareurl").value = l.url;
  $("sharex").setAttribute("href", xIntent(l));
  $("sharetg").setAttribute("href", telegramIntent(l));
  // Dim the frame until the new PNG has decoded, so a swap does not flash the old
  // card's numbers under the new card's checkbox state.
  const prev = $("sharedlgprev");
  const img = $<HTMLImageElement>("shareimg");
  prev.classList.add("wait");
  img.onload = () => prev.classList.remove("wait");
  img.onerror = () => {
    prev.classList.remove("wait");
    say("The card image could not be rendered on the server. The link still works.", true);
  };
  img.src = l.image;
}

function close(): void {
  $("sharedlg").hidden = true;
  current = null;
  $<HTMLImageElement>("shareimg").src = "";
}

function open(offer: ShareOffer): void {
  current = offer;
  showDollars = offer.dollarsDefault;
  $("sharedlgh").textContent = offer.title;
  $("sharedollarsnote").textContent = offer.dollarsNote;
  $<HTMLInputElement>("sharedollars").checked = showDollars;
  showCard(true);
  // Not an error — the standing note about what this card carries, in the same box and
  // the neutral colour.
  say(NOTES[offer.kind]);
  paint();
  $("sharedlg").hidden = false;
  $<HTMLButtonElement>("sharecopy").focus();
}

/** No card, and why. The server's own sentence — "that position has not filled yet",
 *  "this trade has not settled against Hyperliquid's own fills yet" — is the useful
 *  thing to show, and each of them says what to do about it. */
function refuse(reason: string): void {
  current = null;
  $("sharedlgh").textContent = "Not yet";
  showCard(false);
  say(reason, true);
  $("sharedlg").hidden = false;
  $<HTMLButtonElement>("sharedlgx").focus();
}

/** Wired once at boot. Everything below acts on `current`, which the buttons set. */
export function wireShareDialog(): void {
  $("sharedlgx").addEventListener("click", close);
  // The scrim closes; the box does not. `e.target === e.currentTarget` is the whole of
  // that distinction and is why the box is not a sibling.
  $("sharedlg").addEventListener("click", (e) => { if (e.target === e.currentTarget) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("sharedlg").hidden) close();
  });

  $("sharedollars").addEventListener("change", (e) => {
    showDollars = (e.target as HTMLInputElement).checked;
    paint();
  });

  const copy = $<HTMLButtonElement>("sharecopy");
  copy.addEventListener("click", () => {
    void navigator.clipboard.writeText(folded(link())).then(
      () => { copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy card link"; }, 1600); },
      () => $<HTMLInputElement>("shareurl").select(),
    );
  });

  // Copy image, for the platforms where a picture beats a link — and because the card
  // is the thing, not the URL. Same-origin, so `connect-src 'self'` allows the fetch.
  // `ClipboardItem` is absent on older Firefox and the write is refused without a user
  // gesture on some builds; both land in the same message rather than doing nothing.
  const copyImg = $<HTMLButtonElement>("sharecopyimg");
  copyImg.addEventListener("click", async () => {
    copyImg.disabled = true;
    const was = copyImg.textContent;
    try {
      const png = await fetch(link().image, { credentials: "omit" }).then((r) => r.blob());
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      copyImg.textContent = "Copied";
      setTimeout(() => { copyImg.textContent = was; }, 1600);
    } catch {
      say("This browser would not let the page copy an image. Right-click the preview and "
        + "copy it, or use the link.");
    } finally {
      copyImg.disabled = false;
    }
  });
}

/** Wire one share button. `body` is what the API needs to find the row — an intent id,
 *  or nothing at all for the account card. */
export function wireShare(btn: HTMLElement, kind: "position" | "trade" | "account", body: Record<string, string>): void {
  btn.addEventListener("click", async () => {
    const label = btn.textContent;
    btn.textContent = "…";
    (btn as HTMLButtonElement).disabled = true;
    try {
      const offer = await api<ShareOffer>("/api/share/" + kind, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      if (sheetLeadsSomewhere()) {
        // The phone path skips the dialog: the sheet is the destination, and the
        // default spelling is the one the server says this card should start at.
        const l = offer.dollarsDefault ? offer.withDollars : offer.withoutDollars;
        await navigator.share({ text: folded(l) }).catch(() => {});
        return;
      }
      open(offer);
    } catch (e) {
      refuse((e as ApiError).message);
    } finally {
      btn.textContent = label;
      (btn as HTMLButtonElement).disabled = false;
    }
  });
}
