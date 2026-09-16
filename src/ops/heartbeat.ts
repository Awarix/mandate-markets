import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FeeStatus } from "../hl/approve-builder-fee.ts";

// Liveness marker. Absence or staleness is the alert condition, and the watchdog owns
// the alerting — a dead process cannot alert about itself, which is how OutcomeMaker's
// flow-logger died unnoticed for weeks.

export function writeHeartbeat(path: string, detail: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ t: new Date().toISOString(), ...detail }, null, 2));
}

// ── Multi-account (Phase 4) ────────────────────────────────────────────────────
//
// The watchdog reads a flat shape out of `exec-heartbeat.json` and alerts on
// `exec-stale` and `exec-halted`. With several accounts that file has to stay
// readable by it, so the top level is an **aggregate** — sums, and "halted" meaning
// *any* account halted, which is the condition a person needs to hear about — and the
// per-account detail hangs off `accounts`. Adding a field is safe; renaming one of
// the aggregates is not, because the watchdog is deployed separately and may lag.

export type AccountHeartbeat = {
  account: string;
  mode: string;
  halted: boolean;
  haltReason: string | null;
  equityUsd: number;
  freeUsd: number;
  baseCapital: number;
  deployedUsd: number;
  dayStartEquity: number;
  openIntents: number;
  positions: number;
  restingOrders: number;
  foreignOrders: number;
  foreignPositions: number;
  agentDaysLeft: number | null;
  /** What this account is being charged, resolved at connect from the venue's own
   *  record of what its owner approved (`src/hl/approve-builder-fee.ts`).
   *
   *  It travels here rather than being re-read by the web tier for the same reason
   *  `agentDaysLeft` does: the executor already knows, and a second read would be a
   *  second answer. `"off"` on every account until `HL_BUILDER_ADDRESS` is set. */
  fee: FeeStatus;
  /** Last error for this account, or null. One account failing must never stop the
   *  others, so this is reported rather than thrown. */
  error: string | null;
  consecutiveErrors: number;
  /** **What this account is actually holding**, coin and side, so the desk can be asked
   *  whether it is holding one book fifteen times (`DESK_WATCH`, `tasks/47` §0).
   *
   *  Additive, and it has to be: the watchdog deploys separately and reads the aggregate
   *  by name. A beat written before this field existed simply has no book and is counted
   *  as unknown rather than as flat — *we did not look* and *nothing is open* being
   *  different claims is the whole lesson of `stop-sweep`'s unsummarised trades. */
  book?: { coin: string; side: "long" | "short" }[];
};

export type DeskBook = {
  accounts: number;
  /** Accounts whose beat carries a book at all. The denominator for everything below. */
  known: number;
  positions: number;
  /** Distinct coin-and-side across the desk. */
  distinct: number;
  /** The most-held position, and how many accounts hold it. */
  top: { key: string; accounts: number } | null;
  /** The top position's share of all open positions. */
  topShare: number;
  /** **Pairs of accounts holding exactly the same set of positions.** The sharpest form
   *  of the 09-10 mechanism: four accounts with the identical book is six such pairs, and
   *  no count of positions or of asset classes says it. Flat accounts are excluded —
   *  two accounts holding nothing are not running the same book, they are running none. */
  identicalPairs: number;
  /** One line, for the daily message and the log. */
  line: string;
};

/** The desk's book, across every account that reported one.
 *
 *  Reports, bounds nothing. The owner's decision of 2026-09-12 was **no concentration
 *  cap** — accounts run different settings, so one count is a different share of every
 *  book — and what was asked for instead was that somebody be told. */
export function deskBook(accounts: readonly AccountHeartbeat[]): DeskBook {
  const withBook = accounts.filter((a) => a.book !== undefined);
  const counts = new Map<string, number>();
  let positions = 0;
  for (const a of withBook) {
    for (const p of a.book ?? []) {
      const k = `${p.coin} ${p.side}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
      positions++;
    }
  }
  const sorted = [...counts].sort((x, y) => y[1] - x[1]);
  const top = sorted[0] ? { key: sorted[0][0], accounts: sorted[0][1] } : null;

  const sets = withBook
    .map((a) => [...new Set((a.book ?? []).map((p) => `${p.coin} ${p.side}`))].sort().join("|"))
    .filter((k) => k !== "");
  let identicalPairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) if (sets[i] === sets[j]) identicalPairs++;
  }

  const topShare = positions === 0 || top === null ? 0 : top.accounts / positions;
  return {
    accounts: accounts.length, known: withBook.length, positions,
    distinct: counts.size, top, topShare, identicalPairs,
    line: withBook.length === 0
      ? `book: no account reported one (${accounts.length} account(s))`
      : `book: ${positions} position(s) across ${withBook.length} account(s), ${counts.size} distinct` +
        (top === null ? "" : `; most held ${top.key} on ${top.accounts}`) +
        `; ${identicalPairs} pair(s) of accounts holding an identical book`,
  };
}

const sum = (xs: AccountHeartbeat[], f: (a: AccountHeartbeat) => number) =>
  Math.round(xs.reduce((t, a) => t + f(a), 0) * 100) / 100;

/** A halt that belongs to the desk rather than to an account.
 *
 *  **The speed limit's halt was invisible here** (`tasks/50` §2.1). `tick()` reports
 *  `halted` off the account row, and a global halt is deliberately not persisted there —
 *  so a desk arming the global halt at boot wrote fifteen heartbeats saying `halted:
 *  false` and the watchdog's `exec-halted` alert never fired. A refusal that survives a
 *  restart and tells nobody is a desk that quietly stops trading.
 *
 *  The operator's own halt file is **not** passed in here and stays invisible on purpose:
 *  somebody put it there, `deploy/server-cmds.md` says how to remove it, and paging them
 *  for their own kill switch is how an alert stops being read. The speed limit is the
 *  opposite — nobody chose it this boot. */
export type DeskHalt = { halted: boolean; reason: string };

export function aggregateAccounts(
  accounts: AccountHeartbeat[], desk: DeskHalt = { halted: false, reason: "" },
): Record<string, unknown> {
  const modes = [...new Set(accounts.map((a) => a.mode))];
  const halted = accounts.filter((a) => a.halted);
  const erroring = accounts.filter((a) => a.consecutiveErrors > 0);
  const reasons = halted.map((a) => `${a.account}: ${a.haltReason ?? "(no reason recorded)"}`);
  if (desk.halted) reasons.unshift(`every account: ${desk.reason}`);
  return {
    // Fields the watchdog reads. Keep the names.
    mode: modes.length === 0 ? "none" : modes.length === 1 ? modes[0]! : `mixed(${modes.join("+")})`,
    halted: halted.length > 0 || desk.halted,
    haltReason: reasons.length === 0 ? null : reasons.join(" | "),
    equityUsd: sum(accounts, (a) => a.equityUsd),
    freeUsd: sum(accounts, (a) => a.freeUsd),
    baseCapital: sum(accounts, (a) => a.baseCapital),
    deployedUsd: sum(accounts, (a) => a.deployedUsd),
    dayStartEquity: sum(accounts, (a) => a.dayStartEquity),
    openIntents: sum(accounts, (a) => a.openIntents),
    positions: sum(accounts, (a) => a.positions),
    restingOrders: sum(accounts, (a) => a.restingOrders),
    foreignOrders: sum(accounts, (a) => a.foreignOrders),
    foreignPositions: sum(accounts, (a) => a.foreignPositions),
    // New, additive.
    accountCount: accounts.length,
    accountsErroring: erroring.length,
    book: deskBook(accounts),
    accounts,
  };
}
