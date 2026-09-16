import { isNewer } from "../exec/change-queue.ts";
import { isPinned } from "../exec/settings.ts";
import type { UserSettings } from "../risk/params.ts";
import type { Store } from "../store/db.ts";
import type { WebStore } from "./sessions.ts";

// Changing the limits and the mandate on a connected account, from the web side
// (`tasks/18`). The web tier records the request; the executor applies it on its next
// loop (`src/exec/change-queue.ts`). Status is computed from the two databases rather
// than stored, as `connectStatus` computes it: a request is pending while it is newer
// than the ledger's last apply, and there is no third place for that to go stale.

export type Verdict = { ok: true } | { ok: false; error: string };

/** Whether a limits change can even be asked for. Pure, so the three refusals are
 *  tested without a server. */
export function canChangeSettings(i: { hasAccountRow: boolean; unlinkPending: boolean; pinned: boolean }): Verdict {
  if (!i.hasAccountRow) {
    return { ok: false, error: "This account is not connected yet. Choose your limits on the connect screen." };
  }
  if (i.unlinkPending) {
    return { ok: false, error: "You have asked us to stop managing this account, so there are no future positions to apply new limits to." };
  }
  if (i.pinned) {
    return { ok: false, error: "This account's limits are pinned by an operator's file on the desk and cannot be changed from here." };
  }
  return { ok: true };
}

/** The mandate is re-read from the venue, never typed, so there is nothing to
 *  validate — only whether there is an account to re-read for. An operator's pin does
 *  not apply: the file carries settings, not capital. */
export function canChangeMandate(i: { hasAccountRow: boolean; unlinkPending: boolean }): Verdict {
  if (!i.hasAccountRow) {
    return { ok: false, error: "This account is not connected yet, so there is no mandate to update." };
  }
  if (i.unlinkPending) {
    return { ok: false, error: "You have asked us to stop managing this account, so its mandate no longer applies to anything." };
  }
  return { ok: true };
}

export type Changes = {
  /** A limits change asked for and not yet applied — newer than `settingsAt`. */
  pendingSettings: { requestedAt: string; settings: UserSettings } | null;
  /** A mandate re-read asked for and not yet applied. The desk says "applies once your
   *  positions have closed" while `openCount` is not zero, and "on the next loop"
   *  otherwise. */
  pendingMandate: { requestedAt: string } | null;
  /** When the limits and the mandate last changed; the connect time until they do. */
  settingsAt: string | null;
  mandateAt: string | null;
  /** An operator's file pins this account's limits; the desk offers no Change. */
  pinned: boolean;
  /** The executor's own words when it could not apply the request that is pending.
   *  Null unless something is pending: `connections.last_error` also carries a connect
   *  failure, which is not a refusal of anything asked for here. */
  refused: string | null;
};

export function changeStatus(store: Store, web: WebStore, address: string, accountsDir = "accounts"): Changes | null {
  const row = store.account(address);
  if (!row) return null;
  const settingsReq = web.settingsRequest(address);
  const mandateReq = web.mandateRequest(address);
  let pendingSettings: Changes["pendingSettings"] = null;
  if (settingsReq && isNewer(settingsReq.requestedAt, row.settings_at, row.connected_at)) {
    try {
      pendingSettings = {
        requestedAt: new Date(settingsReq.requestedAt).toISOString(),
        settings: JSON.parse(settingsReq.settings) as UserSettings,
      };
    } catch {
      pendingSettings = null;
    }
  }
  const pendingMandate = mandateReq && isNewer(mandateReq.requestedAt, row.mandate_at, row.connected_at)
    ? { requestedAt: new Date(mandateReq.requestedAt).toISOString() }
    : null;
  return {
    pendingSettings,
    pendingMandate,
    settingsAt: row.settings_at ?? row.connected_at,
    mandateAt: row.mandate_at ?? row.connected_at,
    pinned: isPinned(address, accountsDir),
    refused: pendingSettings || pendingMandate ? (store.connection(address)?.last_error ?? null) : null,
  };
}
