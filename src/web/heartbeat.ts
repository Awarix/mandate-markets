import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeeStatus } from "../hl/approve-builder-fee.ts";

// What the web tier can learn from `data/exec-heartbeat.json`.
//
// The two processes talk through two SQLite files and this one JSON file. The ledger
// carries what happened; the heartbeat carries what the executor *is* — how long ago
// it looped, and the per-account facts it reads from the venue and nobody else has.
// The agent's remaining validity is one of those: it comes from `extraAgents`, which
// the public process has no business calling once per page load.
//
// Read fresh on each request rather than cached. It is a small file on local disk,
// rewritten once a loop, and a stale copy of "your approval lapsed" is precisely the
// wrong thing to serve.

/** One account's entry, as `src/ops/heartbeat.ts` writes it. Deliberately partial:
 *  this is a **reader** of a file another process owns, so every field it does not
 *  need is left undeclared and every field it does need is checked. */
export type HeartbeatAccount = {
  account: string;
  mode?: string;
  halted?: boolean;
  agentDaysLeft?: number | null;
  /** What the executor resolved this account is charged. Optional because this file is
   *  written by another process that deploys separately and may lag — an older beat
   *  simply has no fee to report, which the desk renders as nothing rather than as
   *  "off" (a claim it would not be entitled to make). */
  fee?: FeeStatus;
};

export type ExecHeartbeat = {
  /** Seconds since the executor last completed a loop. */
  ageSeconds: number;
  /** When the file was written, ms since epoch. Kept because the per-account figures
   *  are *relative* to it — `agentDaysLeft` was a countdown measured at that instant,
   *  so turning it back into a date needs the instant it was measured from, not now. */
  writtenAtMs: number;
  accounts: HeartbeatAccount[];
};

/** The whole file, or null when there is none / it is unreadable.
 *
 *  Null is not an error here. The executor may never have run, and every screen that
 *  uses this already has to say "the desk is not running" — which is a much better
 *  message than a blank where a number should be. */
export function readExecHeartbeat(dataRoot: string, now = Date.now()): ExecHeartbeat | null {
  const path = join(dataRoot, "exec-heartbeat.json");
  if (!existsSync(path)) return null;
  try {
    const beat = JSON.parse(readFileSync(path, "utf8")) as { t?: string; accounts?: unknown };
    if (typeof beat.t !== "string") return null;
    const t = Date.parse(beat.t);
    if (!Number.isFinite(t)) return null;
    const accounts = Array.isArray(beat.accounts)
      ? (beat.accounts as HeartbeatAccount[]).filter((a) => a !== null && typeof a?.account === "string")
      : [];
    return { ageSeconds: Math.max(0, Math.round((now - t) / 1000)), writtenAtMs: t, accounts };
  } catch {
    return null;
  }
}

/** One account's entry, matched case-insensitively — the heartbeat is written from
 *  the executor's own spelling of the key and the caller has the session's. */
export function heartbeatFor(beat: ExecHeartbeat | null, address: string): HeartbeatAccount | null {
  if (!beat) return null;
  const want = address.toLowerCase();
  return beat.accounts.find((a) => a.account.toLowerCase() === want) ?? null;
}

// ── What the signal feed costs ──────────────────────────────────────────────
//
// Two more files written by processes this one does not control: `credit-meter.json`
// (the recorder *and* the executor both bill into it) and `heartbeat.json` (the
// recorder's own). Same discipline as above — partial types, every field checked, and
// null wherever the answer is not actually known.

/** As `src/signals/meter.ts` writes it. */
type MeterFile = { month?: unknown; calls?: unknown; usd?: unknown };
/** As the recorder writes it. It also carries `credits` — Quotient's own unit, 1000 = $1
 *  — and this file deliberately does not read it: see `readFeedCost`. */
type RecorderBeat = { t?: unknown };

export type FeedCost = {
  month: string | null;
  monthCalls: number | null;
  monthUsd: number | null;
  lastPollAt: string | null;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readJsonFile<T>(dataRoot: string, name: string): T | null {
  const path = join(dataRoot, name);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Month-to-date spend, and when the feed was last polled.
 *
 *  ⚠ **Our prepaid balance is deliberately not here** (`tasks/22`). `heartbeat.json`
 *  carries `credits` and this function reads past it: the field was on `DeskPayload`,
 *  which means every stranger who connects a wallet could read our supplier balance off
 *  `GET /api/desk`. The cadence and the month-to-date spend answer what a person trusting
 *  us with their money is entitled to ask — *how fresh is this* and *what does it cost* —
 *  and a running countdown on somebody else's screen answers a question nobody asked.
 *  **The operator still gets it**: the file keeps the field and `src/ops/watchdog.ts`
 *  alerts on it, which is where a balance belongs.
 *
 *  Both halves degrade independently: a missing meter leaves the spend null while the
 *  poll time still shows, and vice versa. Neither is worth failing a page over. */
export function readFeedCost(dataRoot: string): FeedCost {
  const meter = readJsonFile<MeterFile>(dataRoot, "credit-meter.json");
  const beat = readJsonFile<RecorderBeat>(dataRoot, "heartbeat.json");

  return {
    month: typeof meter?.month === "string" ? meter.month : null,
    monthCalls: num(meter?.calls),
    monthUsd: num(meter?.usd),
    lastPollAt: typeof beat?.t === "string" ? beat.t : null,
  };
}
