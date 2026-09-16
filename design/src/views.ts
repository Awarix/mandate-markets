// View switching, and the registry that keeps it from depending on the views.
//
// `show()` used to call `loadDesk()` and `refreshConnect()` directly, which is fine in
// one file and a dependency cycle across modules — desk and connect both need `show()`
// back. So views owns the switching and nothing else, and each view registers what it
// wants done when it is entered or left.

import { $ } from "./dom.ts";

export type View = "home" | "connect" | "desk" | "settings" | "leaderboard";

const VIEWS: View[] = ["home", "connect", "desk", "settings", "leaderboard"];
const entering = new Map<View, () => void>();
const leaving = new Map<View, () => void>();

export function onEnter(v: View, fn: () => void): void { entering.set(v, fn); }
export function onLeave(v: View, fn: () => void): void { leaving.set(v, fn); }

export function show(v: View): void {
  for (const n of VIEWS) {
    const e = $(`v-${n}`);
    if (e) e.hidden = n !== v;
  }
  // Settings is behind the login and wears the same chrome as the desk it was lifted
  // out of — the terminal header, with the address that leads back into it.
  document.body.classList.toggle("term", v === "desk" || v === "settings");
  window.scrollTo({ top: 0, behavior: "instant" });
  for (const n of VIEWS) if (n !== v) leaving.get(n)?.();
  entering.get(v)?.();
}

export function isShowing(v: View): boolean {
  return !$(`v-${v}`).hidden;
}
