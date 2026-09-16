import type { Store } from "../store/db.ts";
import { excludeSyntheticSql, SYNTHETIC_INTENTS } from "../store/synthetic.ts";
import { type ExecHeartbeat, heartbeatFor } from "./heartbeat.ts";

// Every account we currently trade, ranked, for the people whose accounts they are.
//
// **This is the only route that reads across accounts**, and the only screen on the
// site that shows one owner a figure belonging to another. Both halves of that are
// bounded to the same set of people:
//
//   - **Who is listed**: an account we are trading right now — `mode = 'live'` in the
//     ledger *and* present in the executor's current heartbeat, which is the observable
//     form of "armed, funded, and holding a slot". An account that was emptied below
//     the funding floor, unlinked, or crowded out of `LIVE_MANDATE.maxLiveAccounts`
//     drops off the roster and therefore off this table. Its history stays in the
//     ledger; it is simply not one of the accounts being traded.
//   - **Who may read it**: the owner of a live account, checked in `server.ts`. A
//     stranger gets a 401 and a paper or unconnected wallet a 403.
//
// The second rule is what makes the first one's disclosure defensible: everybody who
// can see the table is on it, so the figures are shared among the people taking the
// same risk rather than published to the internet.
//
// What it still does not carry, each for its own reason:
//
//   - **No positions and no trade rows.** An open position shown to anyone but its
//     owner is an invitation to trade against a stranger's stop.
//   - ~~**No settings.**~~ **Reversed 2026-09-10, by the owner, and the original
//     objection is answered rather than ignored.** It read: *leverage, stop and
//     per-signal size are how an account behaves, and reading them off a table beside a
//     mandate is a guess at where the stop sits.* That is true and it is now a
//     deliberate trade.
//
//     What it buys is the only thing this table is for. Every account here trades **the
//     same signals** — the differences between these rows are the settings and nothing
//     else, so a ranking without them says *who* is ahead while withholding the one
//     column that says *why*. `tasks/19` and the σ sweeps ask that question of our own
//     ledger; this asks it of a dozen accounts at once, which is the faster answer.
//
//     What it costs is bounded by who can read it. The audience is already exactly the
//     people on the table (`server.ts` refuses everyone else), so this discloses to the
//     same group, taking the same risk, on the same feed. And it is settings **without a
//     position**: the entry price a stop hangs off is still nobody's but its owner's, so
//     what a reader can compute is the *shape* of somebody's risk, not where a live stop
//     is resting. The rule that keeps that true is the one above — no positions, no
//     trade rows — and it is why this reversal is safe while that one must not be.
//   - **No balance.** The mandate says what an account is traded at, which is what the
//     return column needs a denominator for; live equity is a different fact and its
//     owner's alone.
//   - **No `creditUsd`.** Our own supplier balance was on `/api/desk` until `tasks/22`
//     took it off (2026-09-16); it was never going to arrive here first.

/** One account's line. Every figure is the ledger's; nothing here is a venue read. */
export type LeaderboardRow = {
  rank: number;
  account: string;
  /** A halted account is still one we are trading — the halt is a pause, and it keeps
   *  its slot — so it stays on the table and says so rather than vanishing. */
  halted: boolean;
  /** `accounts.base_capital` — the mandate the account is traded at now, after any
   *  owner-requested re-read. */
  mandateUsd: number;
  /** Closed trades the fill ingest could settle, which are the ones that can be
   *  scored. `wins / trades` is exactly `winRate`, so the three columns agree on the
   *  page instead of looking like arithmetic nobody checked. */
  trades: number;
  wins: number;
  winRate: number | null;
  /** Closed trades with no venue fills attributed to them. Neither wins nor losses, so
   *  they are out of the three columns above and counted here for the footnote. The
   *  live ledger holds one: an `xyz:COPPER` short closed on `disconnect`. */
  unsettled: number;
  /** Summed `intents.net_pnl` — the venue's own fills, fees and funding
   *  (`src/exec/fills.ts`), never the ledger's older estimate. */
  netPnlUsd: number;
  /** `netPnlUsd / mandateUsd`, and the column this table is ranked on.
   *
   *  The mandate is the denominator because it is the only starting figure the ledger
   *  actually holds. The balance an account opened with is recorded nowhere:
   *  `base_capital` is frozen at connect but an owner-requested re-read moves it
   *  (`tasks/18`), and our own account's was clamped to $100 by the ceiling removed on
   *  2026-08-31. So this is "what this account made against what it is traded at",
   *  which the ledger can support, rather than a lifetime return, which it cannot. */
  returnFrac: number | null;
  firstTradeAt: string | null;
  lastCloseAt: string | null;
  /** How this account is traded, which is the only difference between these rows: every
   *  account here takes the same signals. Null when the stored settings cannot be read,
   *  which the page renders as nothing rather than as a guess. */
  settings: LeaderboardSettings | null;
};

/** The four the desk lets an owner choose, in the units the connect screen shows them.
 *  Deliberately not `UserSettings`: `mode` is not somebody else's business and would be
 *  the one field here that is neither chosen nor meaningful to a reader. */
export type LeaderboardSettings = {
  leverage: number;
  perSignalPct: number;
  /** Null when the stop is off, which is a different thing from a stop of zero. */
  stopPct: number | null;
  holdToTarget: boolean;
};

/** Read the four from the stored JSON, or null if it is unreadable.
 *
 *  Every field is checked for type rather than trusted: this row is written by the
 *  executor, but it is a `TEXT` column and a bad one must not put `NaN×` on a page that
 *  other people read. `holdToTarget` is absent on rows written before it existed, and
 *  absent means what it did then — the signal-change exit, which is the default. */
export function leaderboardSettings(raw: string | null): LeaderboardSettings | null {
  if (raw === null) return null;
  let p: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    // `JSON.parse("null")` succeeds and returns null, and an array parses to an object
    // whose fields are all undefined. Both reach the field reads below, and the first
    // throws — which on this route would be a 500 for everybody, over one bad row.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    p = parsed as Record<string, unknown>;
  } catch { return null; }
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const leverage = num(p.leverage);
  const perSignalPct = num(p.perSignalPct);
  if (leverage === null || perSignalPct === null) return null;
  const stopPct = num(p.stopPct);
  return {
    leverage,
    perSignalPct,
    stopPct: p.stopLoss === false ? null : stopPct,
    holdToTarget: p.holdToTarget === true,
  };
}

export type Leaderboard = {
  rows: LeaderboardRow[];
  /** Accounts we are trading that have not closed a trade yet. Counted rather than
   *  listed — a row of dashes cannot be ranked. */
  awaitingFirstTrade: number;
  /** How many operator-test intents were left out, so the page can say so. */
  excludedIntents: number;
  /** Age of `exec-heartbeat.json` in seconds, or null when there is none. Null is why
   *  the table can be empty while accounts are live, and the page says that rather
   *  than reporting nobody is trading. */
  heartbeatAgeSeconds: number | null;
  generatedAt: string;
};

type Totals = {
  account: string; trades: number; settled: number; wins: number;
  net: number; first_at: string | null; last_at: string | null;
};

/** Read-only: two aggregate queries and one small JSON file.
 *
 *  **No Hyperliquid read.** The desk calls `readAccountView` because it answers one
 *  owner about one account; doing it here would be a venue round trip per account on
 *  every load, and nothing on this table needs a live figure — the mandate is the
 *  ledger's and the P&L is settled history.
 *
 *  Paper accounts are excluded twice over: they are not `mode = 'live'`, and a paper
 *  P&L is not a return anyway (`src/exec/paper.ts` models no fees, no funding and no
 *  partial fills). */
export function buildLeaderboard(store: Store, beat: ExecHeartbeat | null, now = new Date()): Leaderboard {
  const accounts = store.db.prepare(
    "SELECT account, base_capital, halted, settings FROM accounts WHERE mode = 'live'",
  ).all() as { account: string; base_capital: number; halted: number; settings: string | null }[];

  // Composed the way `expectancy.ts` composes it — the ids are a compile-time constant
  // and `excludeSyntheticSql` asserts they are plain UUIDs. A leaderboard is exactly
  // the kind of measurement `src/store/synthetic.ts` says must not count them: they
  // were placed on a real account with real money against a fabricated horizon, so
  // they are our test and not the feed's result.
  const totals = store.db.prepare(
    "SELECT account, COUNT(*) AS trades, COUNT(net_pnl) AS settled, " +
    "  SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) AS wins, " +
    "  COALESCE(SUM(net_pnl), 0) AS net, " +
    "  MIN(created_at) AS first_at, MAX(closed_at) AS last_at " +
    `FROM intents WHERE status = 'closed' AND ${excludeSyntheticSql()} GROUP BY account`,
  ).all() as unknown as Totals[];
  const byAccount = new Map(totals.map((t) => [t.account.toLowerCase(), t]));

  let awaitingFirstTrade = 0;
  const rows: Omit<LeaderboardRow, "rank">[] = [];
  for (const a of accounts) {
    // The roster test. Being in the heartbeat is what "we are trading this account"
    // means from here: the executor put it there after its connect checks passed, and
    // an account that is unfunded, unlinked or without a free slot is not in it.
    if (heartbeatFor(beat, a.account) === null) continue;
    const t = byAccount.get(a.account.toLowerCase());
    if (!t || t.settled === 0) { awaitingFirstTrade++; continue; }
    rows.push({
      account: a.account.toLowerCase(),
      halted: a.halted === 1,
      mandateUsd: a.base_capital,
      trades: t.settled,
      wins: t.wins,
      winRate: t.wins / t.settled,
      unsettled: t.trades - t.settled,
      netPnlUsd: t.net,
      returnFrac: a.base_capital > 0 ? t.net / a.base_capital : null,
      firstTradeAt: t.first_at,
      lastCloseAt: t.last_at,
      settings: leaderboardSettings(a.settings),
    });
  }

  // Ranked on return, then on the dollars behind it so two accounts at the same
  // percentage do not order themselves by whatever SQLite handed back.
  rows.sort((x, y) => (y.returnFrac ?? -Infinity) - (x.returnFrac ?? -Infinity) || y.netPnlUsd - x.netPnlUsd);

  return {
    rows: rows.map((r, i) => ({ rank: i + 1, ...r })),
    awaitingFirstTrade,
    excludedIntents: SYNTHETIC_INTENTS.length,
    heartbeatAgeSeconds: beat?.ageSeconds ?? null,
    generatedAt: now.toISOString(),
  };
}
