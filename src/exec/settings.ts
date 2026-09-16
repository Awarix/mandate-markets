import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "../risk/params.ts";

// Per-account settings live in a versioned file, never in a systemd unit.
//
// OutcomeMaker put its live tuning in `.service` files on the server, so the repo
// never recorded what was actually running and no result could be attributed to the
// parameters that produced it. `accounts/<address>.json` is committed; the effective
// settings are also written into the account row at connect, and into each position
// at open — the intent row carries its own leverage, margin, stop and target — so no
// later edit, to the file or from the desk, can re-price a position that is already
// open. Between positions they can change (`src/exec/change-queue.ts`, `tasks/18`);
// a file here still outranks the desk, both at connect and for a change.

/** The operator's pin for one account. When the file exists it wins over the web's
 *  row at connect (`loadSettings`) and refuses a change from the desk. */
export function settingsFilePath(master: string, dir = "accounts"): string {
  return join(dir, `${master.toLowerCase()}.json`);
}

export function isPinned(master: string, dir = "accounts"): boolean {
  return existsSync(settingsFilePath(master, dir));
}

/** Every address the operator pins with a file. **The desk's own accounts**, in the
 *  only sense the box can check: a file in `accounts/` is something someone put there.
 *  Used by `npm run settings` to size the day's budget below. */
export function ourAccounts(dir = "accounts"): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^0x[0-9a-fA-F]{40}\.json$/.test(f))
    .map((f) => f.replace(/\.json$/, "").toLowerCase())
    .sort();
}

/** The words `npm run settings` puts on the `events` row it writes, and the exact
 *  string the scope guard counts. One constant, written and read in the same place, so
 *  the budget is not a substring match on prose that could be reworded out from under
 *  it — `CLAUDE.md` forbids fuzzy-matching a symbol and this is the same rule applied
 *  to our own log line. `--everyone` appends to it rather than replacing it, so an
 *  overridden day is still counted and is still legible as one. */
export const OPERATOR_CHANGE = "by an operator on the box (npm run settings)";
export const OPERATOR_CHANGE_EVERYONE = `${OPERATOR_CHANGE} --everyone`;

export type ScopeVerdict = { ok: true; why: string } | { ok: false; reason: string };

/** `tasks/47` Rule 4, second part: **existing accounts move ours first.**
 *
 *  On 2026-09-10 a stop default moved and ten of fourteen accounts were rewritten to it
 *  the same night — **seven of them other people's**. The change was not obviously
 *  wrong; what it destroyed was the ability to find out. 157 of the next day's 176 trips
 *  ran the new value, so the control arm was nineteen trips across five settings, and
 *  the reading that followed could not separate the change from the day.
 *
 *  So the day's budget is the number of accounts we pin with a file — three today — and
 *  past it the tool refuses without `--everyone`. Three is not a safety threshold, it is
 *  *ours*: the accounts whose owner is the person running the command. Re-editing an
 *  account already moved today costs nothing further, because that is one decision being
 *  corrected rather than a second cohort being moved.
 *
 *  Floored at one. A box with no `accounts/` files has nothing of its own to move first,
 *  and refusing every single change there would make the guard a lock rather than a
 *  speed limit.
 *
 *  ⚠ It bounds **this tool** and nothing else. An owner changing their own limits from
 *  the desk is not in this count and must never be: they are their limits. */
export function settingsScope(i: {
  master: string;
  everyone: boolean;
  ourAccounts: string[];
  /** Distinct accounts this tool has already moved today, UTC. */
  changedToday: string[];
}): ScopeVerdict {
  if (i.everyone) return { ok: true, why: OPERATOR_CHANGE_EVERYONE };
  const already = i.changedToday.map((a) => a.toLowerCase());
  if (already.includes(i.master.toLowerCase())) return { ok: true, why: OPERATOR_CHANGE };
  const budget = Math.max(1, i.ourAccounts.length);
  if (already.length < budget) return { ok: true, why: OPERATOR_CHANGE };
  return {
    ok: false,
    reason:
      `${already.length} account(s) have already been changed from the box today — ` +
      `${already.join(", ")} — which is the whole of today's budget of ${budget}, the number of ` +
      "accounts we pin with a file in accounts/. Moving more than our own in one day leaves no " +
      "control arm: on 2026-09-10 ten accounts moved to a 1% stop in one night and 157 of the " +
      "next day's 176 trips ran it, so nothing could say whether the stop or the day caused the " +
      "loss. Pass --everyone to do it anyway; it is recorded on every event row with that word " +
      "in it. Nothing was changed.",
  };
}

export function loadSettings(
  master: string,
  dir = "accounts",
  /** What the user chose when they connected through the web, if they did. A file
   *  still wins: an operator editing `accounts/<addr>.json` is a deliberate act and
   *  should not be silently overridden by a row a user wrote months ago. */
  fromConnection: Partial<UserSettings> | null = null,
): { settings: UserSettings; source: string } {
  const path = settingsFilePath(master, dir);
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<UserSettings>;
    return { settings: validate({ ...DEFAULT_USER_SETTINGS, ...raw }), source: path };
  }
  if (fromConnection !== null) {
    return { settings: validate({ ...DEFAULT_USER_SETTINGS, ...fromConnection }), source: "connections row (chosen at connect)" };
  }
  return { settings: DEFAULT_USER_SETTINGS, source: "defaults (no accounts/ file)" };
}

/** The four knobs the user gets, and nothing else. An out-of-range value is a
 *  refusal, not a silent clamp — a settings file that does not mean what it says is
 *  exactly the class of problem this file exists to prevent. */
export function validate(s: {
  leverage: number; stopLoss: boolean; stopPct: number; perSignalPct: number;
  holdToTarget: boolean;
  mode?: unknown;
}): UserSettings {
  // Types before ranges. `"0.03" > 0 && "0.03" < 0.5` is true — JavaScript coerces the
  // string — so a range check alone lets a string into a field that is multiplied by
  // leverage and by baseCapital. It happens to work by further coercion, which is
  // exactly the kind of luck that stops holding somewhere unrelated.
  for (const k of ["stopPct", "perSignalPct"] as const) {
    if (typeof s[k] !== "number" || !Number.isFinite(s[k])) {
      throw new Error(`${k} must be a number, got ${JSON.stringify(s[k])}`);
    }
  }
  // **18× is offered because of the stop, not because of the leverage** (item 25,
  // `notes/2026-09-12-how-a-20x-account-arms-a-2-percent-stop.md`). `clampStopPct` caps
  // the stop at `liqBufferFrac × (1/L − 1/2Lmax)`, so on a 20×-max asset 20× can only
  // arm **1.75%** — and the site sells stops up to 8% and a 2% default beside it. 18× is
  // the highest leverage that arms a full 2% there, with *more* headroom to liquidation
  // than 20× has today (0.76pp against 0.45pp), and it needs no risk constant to move.
  //
  // The list lives here rather than in `SITE_OFFERS` because `validate` is the gate every
  // path goes through — the web's `parseSettings` delegates to it, and so does an
  // operator's `accounts/<address>.json`. `SITE_OFFERS.leverage` is what the *sliders*
  // offer and `discovery.test.ts` pins the two together.
  if (![5, 10, 18, 20].includes(s.leverage)) throw new Error(`leverage must be 5, 10, 18 or 20, got ${s.leverage}`);
  if (!(s.stopPct > 0 && s.stopPct < 0.5)) throw new Error(`stopPct out of range: ${s.stopPct}`);
  if (!(s.perSignalPct > 0 && s.perSignalPct <= 1)) throw new Error(`perSignalPct out of range: ${s.perSignalPct}`);
  if (typeof s.stopLoss !== "boolean") throw new Error("stopLoss must be a boolean");
  // Same reasoning as `stopLoss`, and it matters more here: a truthy string would turn
  // the withdrawal exit off on a live account, and that exit is what saved 31 points
  // on `xyz:PLATINUM`. A wrong type is refused, never coerced.
  if (typeof s.holdToTarget !== "boolean") throw new Error("holdToTarget must be a boolean");
  if (s.mode !== undefined && s.mode !== "live" && s.mode !== "paper") {
    throw new Error(`mode must be "live" or "paper", got ${JSON.stringify(s.mode)}`);
  }
  // Narrowed by the checks above: `leverage` is one of the three the type allows.
  return s as UserSettings;
}
