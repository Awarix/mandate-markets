// The account menu, on both chrome headers.
//
// One popup each, because each header has its own trigger and the popup is positioned
// against it — a single shared element would have to be moved by script, which is a
// worse trade than eight lines of markup twice.
//
// What it holds is what the header used to show as four separate buttons: Settings,
// Leaderboard, Theme and Sign out. Nothing here decides *which* of those a reader may
// use — `paintChrome` and `paintLeaderboardChrome` still own that, by hiding items —
// so this file knows only how a menu opens and closes.

import { $$ } from "./dom.ts";

/** Every open menu closes when any of them opens, when the page is clicked outside
 *  one, on Escape, and when an item is chosen. */
function closeAll(except?: Element): void {
  for (const m of $$(".menu")) {
    if (m === except) continue;
    const trigger = m.querySelector<HTMLElement>("[aria-haspopup]");
    const pop = m.querySelector<HTMLElement>(".menupop");
    if (!trigger || !pop) continue;
    pop.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }
}

export function wireMenus(): void {
  for (const menu of $$(".menu")) {
    const trigger = menu.querySelector<HTMLElement>("[aria-haspopup]");
    const pop = menu.querySelector<HTMLElement>(".menupop");
    if (!trigger || !pop) continue;

    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = pop.hidden;
      closeAll(menu);
      pop.hidden = !open;
      trigger.setAttribute("aria-expanded", String(open));
      // The first item, so the menu is usable from the keyboard the moment it opens.
      // Only when it was opened *by* the keyboard: focusing on a tap makes a phone
      // scroll the popup into view, which moves the page under the finger.
      if (open && !(e as PointerEvent).pointerType) {
        pop.querySelector<HTMLElement>("button:not([hidden])")?.focus();
      }
    });

    // Every item closes the menu, Theme included — it cycles three ways, so leaving it
    // open would be the more helpful behaviour for exactly one of the four and the
    // less predictable one for the rest.
    pop.addEventListener("click", () => { closeAll(); });

    menu.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key !== "Escape" || pop.hidden) return;
      closeAll();
      trigger.focus();
    });
  }

  // Anywhere else on the page. `capture`, so a menu closes even when the thing clicked
  // stops the event on its way up.
  document.addEventListener("click", (e) => {
    if (!(e.target as Element | null)?.closest?.(".menu")) closeAll();
  }, true);
}
