import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { canClearHalt, checkCapConsistency } from "../risk/halt.ts";
import { dayKey } from "../risk/ledger.ts";
import { DEFAULT_USER_SETTINGS, minFundedForLiveUsd, type UserSettings } from "../risk/params.ts";
import { accountKey, type Store } from "../store/db.ts";
import type { ManagedAccount } from "./accounts.ts";
import { isPinned, validate } from "./settings.ts";

// Changing the limits and the mandate on a connected account (`tasks/18`).
//
// The same handshake as connect and unlink, for the same reason: the web tier can
// ask, only the executor can act, and neither writes the other's database. Two
// tables in `web.sqlite`, read here read-only, and applied against the ledger.
//
// **A settings change never places, cancels or resizes an order.** Every intent
// freezes its own terms at open — leverage, margin, size, stop and target are columns
// on its row, and the desired order set is derived from that row and the venue,
// never from the settings (`src/exec/plan.ts`). `tick()` reads `settings` in exactly
// two places, both on the way *into* a position. So replacing the object on the
// `ManagedAccount` is the whole of the change: positions already open keep the terms
// they opened with, and the next one opens on the new ones.
//
// **The mandate is re-read, never typed, and only when nothing is open.** The rule
// `baseCapital` is frozen under was written for a base moving *under open positions*
// (`docs/ACCOUNT-MODEL.md` §2). With `openCount == 0` nothing is deployed, no margin
// is measured against the old base, and the next intent is the first thing sized off
// the new one — which is exactly what a reconnect does, without the unlink that
// releases the positions.
//
// Idempotent by the same rule as the other two queues: this process cannot delete a
// request, so a request older than `accounts.settings_at` / `mandate_at` is spent, and
// an account stuck for any reason leaves the state on the next loop with no repair.

export type SettingsRequest = { address: string; requestedAt: number; settings: UserSettings };
export type MandateRequest = { address: string; requestedAt: number };

function hasTable(db: DatabaseSync, name: string): boolean {
  return (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { n: number }).n === 1;
}

/** Read-only, for the reason `readConnectRequests` is: the web tier must not be able
 *  to invent a change on a user's behalf any more than this process can grant one. A
 *  request whose settings cannot be validated is skipped, not fatal. */
export function readSettingsRequests(path: string): SettingsRequest[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasTable(db, "settings_requests")) return [];
    const rows = db.prepare("SELECT address, requested_at, settings FROM settings_requests ORDER BY requested_at")
      .all() as { address: string; requested_at: number; settings: string }[];
    return rows.flatMap((r) => {
      try {
        const parsed = JSON.parse(r.settings) as Partial<UserSettings>;
        return [{
          address: accountKey(r.address), requestedAt: r.requested_at,
          settings: validate({ ...DEFAULT_USER_SETTINGS, ...parsed }),
        }];
      } catch {
        return [];
      }
    });
  } finally {
    db.close();
  }
}

/** A press of Clear on the desk (`tasks/30` §1). Nothing but the address and when. */
export function readUnhaltRequests(path: string): MandateRequest[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasTable(db, "unhalt_requests")) return [];
    return (db.prepare("SELECT address, requested_at FROM unhalt_requests ORDER BY requested_at")
      .all() as { address: string; requested_at: number }[])
      .map((r) => ({ address: accountKey(r.address), requestedAt: r.requested_at }));
  } finally {
    db.close();
  }
}

export function readMandateRequests(path: string): MandateRequest[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasTable(db, "mandate_requests")) return [];
    return (db.prepare("SELECT address, requested_at FROM mandate_requests ORDER BY requested_at")
      .all() as { address: string; requested_at: number }[])
      .map((r) => ({ address: accountKey(r.address), requestedAt: r.requested_at }));
  } finally {
    db.close();
  }
}

/** A request is live while it is newer than the last apply. `at` is the ledger's ISO
 *  stamp; a null one (a row that predates the column) falls back to the connect time. */
export function isNewer(requestedAtMs: number, appliedAtIso: string | null, connectedAtIso: string): boolean {
  return new Date(requestedAtMs).toISOString() > (appliedAtIso ?? connectedAtIso);
}

/** The apply stamp: never earlier than the request it spends, so a web clock a few
 *  seconds ahead of this one cannot make a request re-apply every loop until the
 *  executor's clock catches up. */
function stamp(now: Date, requestedAtMs: number): Date {
  return new Date(Math.max(now.getTime(), requestedAtMs));
}

/** What the queue needs to know about a managed account. `settings` and `baseCapital`
 *  are **replaced in place** — the runner builds each tick's deps from these fields. */
export type ChangeableAccount = Pick<ManagedAccount, "master" | "mode" | "settings" | "baseCapital">;

export type ChangeDeps = {
  store: Store;
  requestsDb: string;
  accounts: ChangeableAccount[];
  /** Where an operator's pin lives. `accounts/` in production. */
  accountsDir?: string;
  /** What the account holds now, for a live rebase — `checkCollateral` in the runner.
   *  A dependency so the loop test can drive this without a venue. */
  readCollateral: (master: `0x${string}`, minUsd: number) => Promise<{ ok: boolean; usableUsd: number; message: string }>;
  /** The equity the executor last read for one account, for the halt-clear check. A
   *  dependency rather than a venue call: `tick()` has already read it this loop, and a
   *  second read would be a second answer. Null — or absent — when nothing has reported
   *  the account, and `canClearHalt` says out loud that it could not check. */
  equityUsd?: (master: string) => number | null;
  log: (m: string) => void;
  now?: () => Date;
};

export type ChangeReport = { settingsApplied: number; mandatesApplied: number; haltsCleared: number; refused: number };

export async function serviceChangeRequests(d: ChangeDeps): Promise<ChangeReport> {
  const report: ChangeReport = { settingsApplied: 0, mandatesApplied: 0, haltsCleared: 0, refused: 0 };
  const now = d.now ?? (() => new Date());
  const dir = d.accountsDir ?? "accounts";

  // Written where the desk reads it (`connections.last_error`), only when it changes:
  // a refusal is re-decided every loop until the request is superseded, and the same
  // sentence once a minute is noise in both places.
  const refuse = (address: string, why: string) => {
    report.refused++;
    if (d.store.connection(address)?.last_error === why) return;
    d.store.setConnectionError(address, why, now());
    d.log(`${address} change refused: ${why}`);
  };

  for (const req of readSettingsRequests(d.requestsDb)) {
    const row = d.store.account(req.address);
    if (!row) continue;                                       // not connected: nothing to apply to
    if (!isNewer(req.requestedAt, row.settings_at, row.connected_at)) continue;   // spent
    const managed = d.accounts.find((a) => a.master.toLowerCase() === req.address);
    if (!managed) continue;                                   // not managed here this loop; next one

    // An operator's pin outranks the web, as it does at connect (`loadSettings`).
    if (isPinned(req.address, dir)) {
      refuse(req.address, "Your limits are pinned by an operator's file on the desk, so they cannot be " +
        "changed from here. Nothing about your account changed.");
      continue;
    }
    // Below the floor every signal is skipped as `below-min-notional` and the account
    // trades nothing while looking connected — the failure the floor exists to name,
    // and one a person can produce by dragging two sliders down on a small mandate.
    const floor = minFundedForLiveUsd(req.settings);
    if (floor > row.base_capital) {
      refuse(req.address, `Those limits need a mandate of at least $${floor.toFixed(2)} for one position to ` +
        `clear Hyperliquid's minimum order, and yours is $${row.base_capital.toFixed(2)}. Raise the size or ` +
        "the leverage, or deposit more and update the mandate. Your current limits are unchanged.");
      continue;
    }
    // The web cannot set `mode`, and a change never moves an account between paper and
    // live: the mode in force stays.
    const next: UserSettings = { ...req.settings, mode: managed.mode };
    for (const w of checkCapConsistency(next)) d.log(`${req.address} CONFIG WARNING: ${w}`);
    d.store.applySettings(req.address, next, stamp(now(), req.requestedAt));
    managed.settings = next;
    if (d.store.connection(req.address)?.last_error) d.store.setConnectionError(req.address, null, now());
    report.settingsApplied++;
    d.log(
      `${req.address} limits changed at the owner's request: ${row.settings} → ` +
      `${JSON.stringify(next)}. Applies to positions opened from now on; ${d.store.openCount(req.address)} ` +
      "open position(s) keep the terms they opened with. No order placed or cancelled.",
    );
  }

  // Clearing a daily-loss halt, at the owner's request (`tasks/30` §1).
  //
  // **This is the only path that clears a halt from outside the box**, and the whole
  // safety property is one line in `Store.clearHalt`: clear `halted`, never touch
  // `day_start_equity` or `day`. With the baseline untouched, `haltCheck` re-halts on
  // the next tick if the account is still below the cap — so the button can only work
  // when the condition has genuinely gone, by construction rather than by policy.
  //
  // `canClearHalt` is re-run here even though the web tier ran it before offering the
  // button and again before recording the request. It is not belt and braces: this
  // process has the equity the *executor* last read, the web tier has whatever its own
  // read said, and the desk's copy can be a minute old. The authoritative answer is the
  // one taken next to the ledger being written.
  for (const req of readUnhaltRequests(d.requestsDb)) {
    const row = d.store.account(req.address);
    if (!row) continue;
    // Spent against the last **decision**, cleared or refused. A press the executor
    // refuses must not sit in the queue and apply itself when the day rolls.
    if (!isNewer(req.requestedAt, d.store.lastHaltDecisionAt(req.address), row.connected_at)) continue;
    const managed = d.accounts.find((a) => a.master.toLowerCase() === req.address);
    if (!managed) continue;
    if (row.halted !== 1) continue;                           // already clear; nothing to do

    const at = stamp(now(), req.requestedAt);
    const verdict = canClearHalt({
      actor: "owner",
      kind: row.halt_kind,
      haltedAt: d.store.haltedAt(req.address),
      day: row.day,
      dayStartEquity: row.day_start_equity,
      equityUsd: d.equityUsd?.(req.address) ?? null,
      now: at,
    });
    if (!verdict.ok) {
      // Recorded on the ledger as well as on the screen, because it is the row that
      // makes the request spent — and because *somebody asked and was told no* is a
      // fact about a halt worth keeping beside the halt itself.
      d.store.recordEvent(req.address, "unhalt-refused", verdict.reason, at);
      refuse(req.address, verdict.reason);
      continue;
    }
    d.store.clearHalt(req.address, "owner", verdict.note, at);
    if (d.store.connection(req.address)?.last_error) d.store.setConnectionError(req.address, null, now());
    report.haltsCleared++;
    d.log(
      `${req.address} halt cleared at the owner's request: ${verdict.note} ` +
      "The day's baseline is untouched; the next tick re-halts if the condition is still there.",
    );
  }

  for (const req of readMandateRequests(d.requestsDb)) {
    const row = d.store.account(req.address);
    if (!row) continue;
    if (!isNewer(req.requestedAt, row.mandate_at, row.connected_at)) continue;
    const managed = d.accounts.find((a) => a.master.toLowerCase() === req.address);
    if (!managed) continue;
    // Pending, not refused: the desk computes this state from the request being newer
    // than `mandate_at` and says "applies once your positions have closed".
    if (d.store.openCount(req.address) > 0) continue;

    // Re-read, never typed. For a paper account the simulated equity *is* what it holds.
    let usable: number;
    if (managed.mode === "paper") {
      usable = d.store.paperEquity(req.address) ?? row.base_capital;
    } else {
      const c = await d.readCollateral(managed.master, minFundedForLiveUsd(managed.settings));
      if (!c.ok) {
        refuse(req.address, `The mandate was not updated: ${c.message} It stays at $${row.base_capital.toFixed(2)}.`);
        continue;
      }
      usable = c.usableUsd;
    }

    // The day's loss baseline moves with the mandate, and not by resetting (§4.4).
    // Nothing is open, so equity is cash and today's realised result is known exactly:
    // the baseline becomes equity less that result, which keeps today's losses counted
    // and leaves the deposit out — a deposit must not read as a day's profit that
    // disables the halt, and a rebase must not become a way to forgive the morning.
    const at = stamp(now(), req.requestedAt);
    const realised = d.store.realisedToday(req.address, dayKey(at));
    const dayStart = usable - realised;
    d.store.applyMandate(req.address, usable, dayStart, at);
    managed.baseCapital = usable;
    if (d.store.connection(req.address)?.last_error) d.store.setConnectionError(req.address, null, now());
    report.mandatesApplied++;
    d.log(
      `${req.address} mandate re-read at the owner's request: $${row.base_capital.toFixed(2)} → ` +
      `$${usable.toFixed(2)} (what the account holds; nothing open). Day baseline $${(row.day_start_equity ?? 0).toFixed(2)} → ` +
      `$${dayStart.toFixed(2)} = equity less today's realised $${realised.toFixed(2)}. No order placed or cancelled.`,
    );
  }

  return report;
}
