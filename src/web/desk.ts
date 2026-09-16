import type { InfoClient } from "@nktkas/hyperliquid";
import { readAccountView } from "../hl/state.ts";
import type { Universe } from "../hl/universe.ts";
import { expiryStatus, type ExpiryState } from "../risk/expiry.ts";
import { canClearHalt, correlatedStopOfMandate, haltDistance } from "../risk/halt.ts";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, RISK_PARAMS, type UserSettings } from "../risk/params.ts";
import { bookShape, maxDeployedUsd } from "../risk/ledger.ts";
import type { AccountRow, Store } from "../store/db.ts";
import type { HaltKind, LivePosition } from "../types.ts";
import { changeStatus, type Changes } from "./changes.ts";
import { type ExecHeartbeat, heartbeatFor, readExecHeartbeat, readFeedCost } from "./heartbeat.ts";
import type { WebStore } from "./sessions.ts";
import { builderRail, feeIsRequired, type FeeStatus } from "../hl/approve-builder-fee.ts";

// The desk payload: everything one account's screen shows, assembled from the two
// sources of truth in the order the architecture demands.
//
// **Hyperliquid is authoritative for facts** — equity, positions, marks. **The ledger
// is authoritative for intent** — which signal opened which position, what the plan
// was, what got skipped and why. A position on the venue with no matching intent is
// not a display quirk; it is the foreign-actor condition the executor halts on, so it
// is surfaced as its own number rather than quietly filtered out.

export type DeskPosition = {
  /** Which intent this position belongs to. The desk itself never shows it; the share
   *  button names it, so `POST /api/share/position` can re-read that one row rather
   *  than being handed figures by a browser (`tasks/16`). */
  intentId: string;
  coin: string;
  side: "long" | "short";
  leverage: number;
  sizeAbs: number;
  /** What the position posted — the venue's own figure once it exists, the intent's
   *  plan before it fills. The denominator of the card's percentage (`tasks/19`): a
   *  1.2% move at 10× is 12% of what was committed, which is where leverage shows. */
  marginUsd: number;
  entryPx: number | null;
  markPx: number | null;
  stopPx: number | null;
  targetPx: number | null;
  unrealizedPnlUsd: number | null;
  liquidationPx: number | null;
  horizonAt: string;
  rationale: string;
  status: string;
  /** True when the venue shows no position for this intent — pending entry, or a fill
   *  we have not reconciled yet. The screen must not draw it as live. */
  awaitingFill: boolean;
};

/** How long the agent approval has left, in the words of `src/risk/expiry.ts`.
 *
 *  On the desk because the desk is the **only** channel we have to the person whose
 *  money it is. Wallet sign-in means we hold no email and no push token, and an
 *  approval that lapses breaks nothing loudly: the account keeps reporting
 *  `mode=live`, this screen keeps rendering, and every signal is quietly skipped as
 *  `agent-expires-before-horizon`. On 2026-09-02 a live self-service account holding
 *  $73.55 was 3.8 hours from that state with no way to be told.
 *
 *  Null for a paper account, and for any account the executor is not currently
 *  managing — there is no approval to describe, and inventing "unknown" for an
 *  account that never had an agent would be noise on every paper desk. */
export type DeskAgent = {
  state: ExpiryState;
  daysLeft: number | null;
  expiresAt: string | null;
  /** Reassurance first, loss second — see `src/risk/expiry.ts`. */
  message: string;
};

/** What the signal feed costs, and how often we ask it.
 *
 *  Shown to every account rather than kept for the operator: the whole product is
 *  "we route someone else's research", and how often we look plus what that costs is
 *  the honest version of that sentence. It also answers the question people actually
 *  ask — *why did I not see this signal sooner* — which no other number on the desk
 *  can.
 *
 *  Every field is nullable because both files are written by **other processes**
 *  (the recorder and the executor) into `DATA_ROOT`. A missing or malformed file means
 *  a section that says nothing, never a desk that fails to render. */
export type DeskFeed = {
  /** Seconds between polls of each Quotient endpoint. */
  pollSeconds: number | null;
  /** Month-to-date, from the meter the recorder and the executor both write. */
  month: string | null;
  monthCalls: number | null;
  monthUsd: number | null;
  /** When the recorder last completed a poll. */
  lastPollAt: string | null;
};

export type DeskHalt = {
  /** `null` on a halt that fired before the desk recorded the kind. Untyped is
   *  operator-only: guessing a kind out of the stored sentence is the substring match
   *  `halt_kind` exists to remove. */
  kind: HaltKind | null;
  reason: string;
  /** When it fired, from the ledger's own `halt` event. Null when the halt predates the
   *  event being written for it. */
  sinceIso: string | null;
  /** Whether the owner may clear it from here, and — always — why. The `why` is shown
   *  either way: a disabled control with no explanation is the thing `tasks/30` §1 says
   *  not to ship, and for a foreign-actor halt the explanation *is* the content. */
  clearable: boolean;
  why: string;
  /** A clear asked for and not yet decided by the executor. */
  pending: boolean;
  /** What the day looked like: every trip that closed today, worst first. */
  closedToday: { coin: string; side: string; reason: string | null; netUsd: number | null; ofMargin: number | null }[];
};

export type DeskPayload = {
  network: "mainnet" | "testnet";
  address: string;
  connected: boolean;
  mode: "live" | "paper" | null;
  halted: boolean;
  haltReason: string | null;
  /** The halt in force, in the units it happened in (`tasks/30` §1–§2). Null when the
   *  account is not halted.
   *
   *  The desk knew `haltReason` and showed it; what no screen said was what the day
   *  looked like. On 2026-09-08 that was two positions at −38.1% and −35.6% of their
   *  margin against 17 winners — a 65% hit rate that still reached the cap — which is
   *  the shape of day where the *setting* and not the signals is the thing to look at,
   *  and the owner had no way to see it. */
  halt: DeskHalt | null;
  connectedAt: string | null;
  agent: DeskAgent | null;
  /** What this account is being charged on its order flow, and — when it is not — the
   *  fact that a fee exists to be approved.
   *
   *  On the desk for the reason `tasks/14` §2.4 gives: a fee somebody consented to and
   *  cannot see is the worst version of charging one. It is the executor's own answer,
   *  carried on the heartbeat, so the number here is the number the orders carry.
   *
   *  Null when the executor is not reporting this account, or is reporting it from a
   *  build that predates the field — not "off", which would be a claim about somebody's
   *  money made from an absence of data. */
  fee: (FeeStatus & { required: boolean }) | null;
  feed: DeskFeed;
  balanceUsd: number | null;
  /** The balance split the way the owner of it thinks about it: what is committed to
   *  open positions, and what is sitting there. Both from the same `readAccountView`
   *  the balance comes from — `cash` is its `freeUsd` and `positions` is the rest — so
   *  they add up to `balanceUsd` by construction rather than by two reads agreeing.
   *
   *  Not `atRiskUsd`, which is beside them and answers a different question: that is
   *  margin *we* committed, from the intent ledger, and it excludes anything the owner
   *  opened by hand. This pair is the venue's own arithmetic about the whole account.
   *
   *  Null together, and only when the balance is null. */
  positionsUsd: number | null;
  cashUsd: number | null;
  /** Marked to market against the day's opening equity — the same quantity the
   *  daily-loss halt measures, so the screen and the halt cannot disagree. */
  todayUsd: number | null;
  /** The denominator of `todayUsd`'s percentage and the base of the halt level. From
   *  the ledger row, so it renders when Hyperliquid is unreachable; null until the
   *  first tick seeds it. */
  dayStartEquityUsd: number | null;
  /** `RISK_PARAMS.dailyLossPct`, so the screen's "−10%" is the executor's and not a
   *  literal in the page. */
  dailyLossPct: number;
  /** The two things the limits controls on the desk need beyond the mandate, and for
   *  the same reason the connect screen is sent them (`connectStatus`): the floor a
   *  set of limits has to clear is `minOrderNotionalUsd / (perSignalPct × leverage)`,
   *  and a copy of $10 that drifted would price a change the executor then refuses. */
  minOrderNotionalUsd: number;
  /** The part of the mandate never posted as margin. Travels for the same reason
   *  `minOrderNotionalUsd` does: the card sizes every figure off `base − reserve`. */
  reserveFrac: number;
  /** How long a change waits, and whether anything is there to apply it. `tasks/18`
   *  §9: the card counts `loopIntervalSec − executorSeenSecondsAgo` down to the next
   *  loop, and says *the desk is not running* rather than counting when the heartbeat
   *  is stale or absent. Null there means we have never seen the executor at all. */
  loopIntervalSec: number;
  executorSeenSecondsAgo: number | null;
  /** Where the halt sits today, in dollars of loss: `dailyLossPct × dayStartEquity`.
   *  Null with `dayStartEquityUsd`. */
  haltAtUsd: number | null;
  /** What one stopped-out position costs and about how many reach the halt — the
   *  same `haltDistance` the executor's startup warning reads (`src/risk/halt.ts`).
   *  Null when the settings could not be read. */
  stopOut: { usd: number; ofMandate: number; ofMargin: number; stopsToHalt: number } | null;
  /** Realised only, over seven days. A different question from `todayUsd`, and
   *  labelled as one. */
  realisedWeekUsd: number;
  mandateUsd: number | null;
  atRiskUsd: number;
  maxAtRiskUsd: number | null;
  /** What one correlated move costs if every open position stops together, as a
   *  fraction of the mandate — `tasks/21` §4. Null until the settings parse. */
  correlatedStopOfMandate: number | null;
  openCount: number;
  maxOpen: number;
  positions: DeskPosition[];
  taken: number;
  skipped: number;
  foreignPositions: number;
  limits: {
    leverage: number | null;
    stopLoss: boolean | null;
    stopPct: number | null;
    perSignalPct: number | null;
    /** Never null: a row written before this setting existed was traded on the
     *  withdrawal exit, which is what `false` says. The other four stay nullable
     *  because a missing one means the row is unreadable, not that it means a
     *  default — and a wrong leverage is a wrong position size. */
    holdToTarget: boolean;
  } | null;
  skipReasons: { reason: string; count: number }[];
  /** A limits change or a mandate re-read asked for from this desk, and where it
   *  stands (`tasks/18`). Null for an account with no ledger row, and when the route
   *  had no request store to read. */
  changes: Changes | null;
};

/** Reasons in the ledger are machine slugs. The desk is read by the person whose
 *  money it is, so they arrive as sentences. An unmapped reason falls through as
 *  itself rather than being dropped — a skip we cannot name is still a skip that
 *  happened. */
const SKIP_LABELS: Record<string, string> = {
  "no-direction": "No direction in the forecast",
  "not-active": "Forecast not active",
  "mode-excluded": "Forecast mode we do not trade",
  "strength-excluded": "Conviction below our threshold",
  "displacement-below-gate": "Move too small to cover fees",
  "unmapped-symbol": "Market we could not map",
  "horizon-too-long": "Held too long to be worth it",
  "horizon-passed": "Deadline already passed",
  "already-open": "Already holding that market",
  "stopped-recently": "Stopped out of that market earlier today",
  "snapshot-predates-close": "The forecast we have is older than our own exit",
  "no-budget": "No budget left under the caps",
  "max-concurrent": "Too many positions open",
  "account-halted": "Account halted",
  "below-min-notional": "Under the venue's minimum order size",
  "stop-inside-liquidation": "Stop would sit past liquidation",
  "insufficient-collateral": "Not enough free collateral",
  "leverage-unavailable": "Venue would not set that leverage",
  "thin-book": "Too little resting to get back out of",
  "below-volume-floor": "Market too quiet to trade safely",
  // Not a cap doing its job, and the only reason in this list the *user* has to clear.
  // It fell through to the auto-tidy as "Agent expires before horizon", which reads
  // like our jargon rather than like something they can act on.
  "agent-expires-before-horizon": "Your approval of us ends before the forecast does",
  "stale-feed": "Signal feed went quiet",
};

// ── What we saw, and what we did about it ───────────────────────────────────
//
// `docs/USER-JOURNEY.md`: *"A user seeing '3 signals skipped: no budget' understands
// the caps are working. A user seeing nothing assumes we're broken."* The desk had two
// aggregate counts and a reason breakdown, and no history behind either.
//
// **Taken and skipped come back in one list**, because the interesting comparison is
// between them: a screen that only shows refusals cannot answer "and what did you take
// instead". A taken row carries its intent through to what happened to it, which is
// where `tasks/09`'s trade row picks it up.

export type SignalRow = {
  outcome: "taken" | "skipped";
  signalRef: string;
  coin: string | null;
  firstAt: string;
  lastAt: string;
  /** The published revisions this decision spanned. 0 on rows collapsed from the
   *  pre-2026-09-02 log, which had no revision column. */
  firstRevision: number;
  lastRevision: number;
  /** How many times we made this decision. One row per (signal, reason), so this is
   *  the repetition that used to be one database row each. */
  seenCount: number;
  reason: string | null;
  /** `reason` as a sentence. Same map the desk's breakdown uses. */
  label: string | null;
  detail: string | null;
  intentId: string | null;
  side: string | null;
  status: string | null;
  closeReason: string | null;
  /** Settled net of fees and funding (`tasks/08`). Null until the fills are in — and
   *  the *estimate* is deliberately never sent: it disagrees with what Hyperliquid
   *  shows the account's owner, which is the one thing `docs/USER-JOURNEY.md` §13
   *  promises it will not do. */
  netPnlUsd: number | null;
  rationale: string | null;
};

export type SignalHistory = {
  address: string;
  /** Whole-payload, not per row. A paper account's trades are a price series and not
   *  a track record, and every row on the screen has to say so. */
  mode: "live" | "paper" | null;
  since: string;
  rows: SignalRow[];
};

export function buildSignalHistory(store: Store, address: string, sinceIso: string, limit = 200): SignalHistory {
  const row = store.account(address);
  const account = row?.account ?? address.toLowerCase();
  return {
    address: account,
    mode: row ? (row.mode as "live" | "paper") : null,
    since: sinceIso,
    rows: store.signalHistory(account, sinceIso, limit).map((r) => ({
      outcome: r.outcome,
      signalRef: r.signal_ref,
      coin: r.coin,
      firstAt: r.first_at,
      lastAt: r.last_at,
      firstRevision: r.first_revision,
      lastRevision: r.last_revision,
      seenCount: r.seen_count,
      reason: r.reason,
      label: r.reason === null ? null : labelSkip(r.reason),
      detail: r.detail,
      intentId: r.intent_id,
      side: r.side,
      status: r.status,
      closeReason: r.close_reason,
      netPnlUsd: r.net_pnl,
      rationale: r.rationale,
    })),
  };
}

// ── Trade history (tasks/09) ────────────────────────────────────────────────
//
// `docs/USER-JOURNEY.md`: *"The dashboard answers 'why' not just 'what'"* and *"losses
// are explained the same day."* A row is not `NVDA +$12`. A row is why we opened it,
// what the plan was, why it closed, and what it cost — and every field of that already
// exists in the ledger, which is the whole reason the intent store was built first.
//
// `close_reason` is the load-bearing one: the executor records **why** a position
// closed from which of its own exit orders stopped resting, not from where the price
// ended up (`src/exec/loop.ts` says why), so "stopped out" versus "hit target" versus
// "the outlook was retired" is a fact we can state rather than infer.
//
// Pure ledger — no venue read — so this is the one part of the screen that should
// never come back null when Hyperliquid is unreachable.

export type TradeRow = {
  intentId: string;
  coin: string;
  side: string;
  leverage: number;
  marginUsd: number;
  sizeAbs: number;
  refPx: number;
  entryPx: number | null;
  targetPx: number | null;
  stopPx: number | null;
  openedAt: string;
  closedAt: string | null;
  /** From our own exit orders, never guessed from the price. */
  closeReason: string | null;
  /** Settled from real fills, fees and funding. Null until the fills are in. The
   *  ledger's estimate is never sent: it disagrees with what Hyperliquid shows this
   *  account's owner, measured at $3.35 over 18 trips, and not disagreeing with
   *  Hyperliquid is the promise `docs/USER-JOURNEY.md` §13 makes. */
  netPnlUsd: number | null;
  feeUsd: number | null;
  fundingUsd: number | null;
  /** Why the figures above are null, when they are. */
  pnlNote: string | null;
  /** The forecast's own two numbers, joined from `signals`. **Null is "we no longer
   *  hold that"**, not zero — a trade whose signal row was pruned, or which predates
   *  the table, has no sigma to report and `0.00σ` would be a claim we cannot make. */
  sigma: number | null;
  strength: string | null;
  /** What it actually left at, size-weighted across the closing fills. Null until the
   *  venue's rows are in — the same settlement `netPnlUsd` waits for. */
  exitPx: number | null;
  rationale: string;
  /** On **every row**, not once on the payload. `src/exec/paper.ts` models no fees, no
   *  funding, no queue position and no partial fills, so a paper history is a price
   *  series and not a track record — and an account can come up paper for reasons its
   *  owner did not choose, which is exactly when an unlabelled row would mislead. */
  paper: boolean;
};

export type TradeHistory = {
  address: string;
  mode: "live" | "paper" | null;
  rows: TradeRow[];
  /** Opaque cursor for the next page, or null at the end. Encodes `(closed_at,
   *  intent_id)` because two trades can close in the same millisecond. */
  nextBefore: string | null;
};

/** Decode the cursor. Anything malformed is treated as "start from the top" rather
 *  than as an error: a bad cursor is a client bug, and the useful response to it is
 *  the first page, not a 400 on a screen someone is trying to read. */
export function parseCursor(raw: string | null): { at: string; id: string } | null {
  if (!raw) return null;
  const cut = raw.lastIndexOf("|");
  if (cut <= 0) return null;
  return { at: raw.slice(0, cut), id: raw.slice(cut + 1) };
}

export function buildTradeHistory(store: Store, address: string, before: string | null, limit = 50): TradeHistory {
  const row = store.account(address);
  const account = row?.account ?? address.toLowerCase();
  // **The account's current mode, which is not quite the same as the mode each trade
  // ran under.** `connectAccount` refuses a mode change on a live ledger row, so the
  // two can only diverge across a disconnect-and-reconnect — the row is deleted and
  // rebuilt, while the intents stay. Rare, and worth knowing about before someone
  // trusts a label on a five-week-old row.
  const paper = row?.mode !== "live";
  // One extra row, so "is there a next page" is answered by the query rather than
  // guessed from whether this page came back full.
  const page = store.closedTradesPage(account, parseCursor(before), limit + 1);
  const rows = page.slice(0, limit);
  const last = rows.at(-1);
  return {
    address: account,
    mode: row ? (row.mode as "live" | "paper") : null,
    nextBefore: page.length > limit && last?.closed_at ? `${last.closed_at}|${last.intent_id}` : null,
    rows: rows.map((i) => ({
      intentId: i.intent_id,
      coin: i.coin,
      side: i.side,
      leverage: i.leverage,
      marginUsd: i.margin_usd,
      sizeAbs: i.size_abs,
      refPx: i.ref_px,
      entryPx: i.entry_px,
      targetPx: i.target_px,
      stopPx: i.stop_px,
      openedAt: i.created_at,
      closedAt: i.closed_at,
      closeReason: i.close_reason,
      netPnlUsd: i.net_pnl,
      feeUsd: i.fee_usd,
      fundingUsd: i.funding_usd,
      pnlNote: i.pnl_note,
      sigma: i.displacement_sigma,
      strength: i.strength,
      exitPx: i.exit_px,
      rationale: i.rationale,
      paper,
    })),
  };
}

export function labelSkip(reason: string): string {
  // Reasons are hyphenated slugs (`horizon-passed`). Older ledgers hold values no
  // longer in `SkipReason` — `unverified-mapping` is in the live one — so an unknown
  // reason is tidied rather than dropped. A skip we cannot name still happened.
  const known = SKIP_LABELS[reason];
  if (known) return known;
  const words = reason.replace(/[-_]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Realised P&L on intents closed since a cutoff: the settled figure where the
 *  venue's own rows are in, the estimate where they are not yet. `Store.realisedToday`
 *  reads the ledger the same way, for the same reason — those two numbers are the
 *  desk's and the rebase's answer to one question and must not disagree.
 *
 *  It summed `realized_pnl` alone until 2026-09-04, and the estimate is not a rounding
 *  error. On a live self-service account the desk read **+$3.75** across four closed
 *  trades whose settled net was **+$8.18** — the whole of that account's growth from
 *  its $115.50 mandate to $123.68, reported as under half of it. `src/exec/fills.ts`
 *  has the reason the estimate misses low: a forced close is an IOC priced a slippage
 *  band from the mark, so the estimate books ~30bps of notional that was never paid,
 *  against a fee 35x smaller. The trade rows on the same screen already show
 *  `net_pnl`, so the total under them disagreed with their own sum. */
function realisedSince(store: Store, account: string, sinceIso: string): number {
  const r = store.db.prepare(
    "SELECT COALESCE(SUM(COALESCE(net_pnl, realized_pnl)), 0) AS p FROM intents " +
    "WHERE account = ? AND status = 'closed' AND closed_at >= ?",
  ).get(account, sinceIso) as { p: number };
  return r.p;
}

function countIntents(store: Store, account: string): number {
  const r = store.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE account = ?")
    .get(account) as { n: number };
  return r.n;
}

/** Distinct **signals** refused, not decisions and certainly not rows.
 *
 *  This was `COUNT(*)` over an append-only log written once per signal per 60s loop,
 *  so the desk told one live account it had skipped 6,363 signals when the number was
 *  73. `tasks/10` collapsed the write, which fixes the ratio but not the unit: with
 *  one row per (signal, reason) a signal refused for two different reasons across its
 *  life still counts twice. The label says "signals", so the query counts signals. */
function countSkips(store: Store, account: string): number {
  const r = store.db.prepare("SELECT COUNT(DISTINCT signal_ref) AS n FROM skips WHERE account = ?")
    .get(account) as { n: number };
  return r.n;
}

type PaperPositionRow = {
  coin: string; szi: number; entry_px: number; margin_used: number; leverage: number;
};

/** Paper accounts are marked against the simulated book, never the venue.
 *
 *  Reading venue equity for a paper account produced a `todayUsd` of −$896: a paper
 *  ledger's $1,000 opening equity differenced against the account's real $103 of
 *  collateral. Both numbers were correct and the subtraction was meaningless.
 *
 *  Scoped by account: the paper tables are shared with every other paper account in
 *  the same ledger, and were keyed only by coin until 2026-08-31. */
function paperBook(store: Store, account: string): { equity: number | null; positions: PaperPositionRow[] } {
  const cash = store.db.prepare("SELECT equity FROM paper_cash WHERE account = ?")
    .get(account) as { equity: number } | undefined;
  const positions = store.db.prepare(
    "SELECT coin, szi, entry_px, margin_used, leverage FROM paper_positions WHERE account = ? AND szi != 0",
  ).all(account) as unknown as PaperPositionRow[];
  return { equity: cash?.equity ?? null, positions };
}

/** How many signals each reason stopped — ranked by that, not by how long each
 *  persisted.
 *
 *  The old query counted log rows, so a signal sitting below the sigma gate for a day
 *  contributed 1,440 of them and buried the one refused for no budget. Ranking by
 *  persistence answers a question nobody asked. */
function skipBreakdown(store: Store, account: string, sinceIso: string): { reason: string; count: number }[] {
  return store.db.prepare(
    "SELECT reason, COUNT(DISTINCT signal_ref) AS count FROM skips WHERE account = ? AND last_at >= ? " +
    "GROUP BY reason ORDER BY count DESC",
  ).all(account, sinceIso) as unknown as { reason: string; count: number }[];
}

/** What the desk can say about the agent approval, from the heartbeat alone.
 *
 *  `agentDaysLeft` is a **countdown measured when the heartbeat was written**, so it
 *  is turned back into an instant using that write time rather than now. Reading it as
 *  though it were current would make a stale heartbeat report an approval as healthier
 *  than it is, in exactly the situation — the executor is down — where nobody is
 *  renewing anything either.
 *
 *  Everything after that is `expiryStatus`, which is also what the operator's alert
 *  and the executor's log say. One set of words, three audiences.
 *
 *  Null rather than "unknown" when the executor is not reporting this account at all:
 *  a paper desk, or one whose process is down. "We cannot see your approval" is not
 *  information the owner of a paper account can use. */
function agentStatus(account: string, mode: string, beat: ExecHeartbeat | null, now: Date): DeskAgent | null {
  if (mode !== "live") return null;
  const mine = heartbeatFor(beat, account);
  if (!beat || !mine || mine.agentDaysLeft === null || mine.agentDaysLeft === undefined) return null;
  const validUntil = beat.writtenAtMs + mine.agentDaysLeft * 86_400_000;
  const e = expiryStatus(validUntil, now.getTime());
  return { state: e.state, daysLeft: e.daysLeft, expiresAt: e.expiresAt, message: e.message };
}

/** The account's screen. `info` and `universe` may be null when the venue is
 *  unreachable — the ledger half still renders, and every venue-sourced number comes
 *  back null rather than stale or zero. A zero balance and an unknown balance are very
 *  different claims to make to someone about their money. */
/** How often the recorder polls each Quotient endpoint.
 *
 *  Read from the environment rather than `RISK_PARAMS` because it is an operational
 *  setting, not a risk one — `deploy/server-cmds.md` documents changing it in `.env`
 *  and restarting, and a constant here would quietly disagree with the box. */
function pollSeconds(): number | null {
  const raw = Number(process.env.QUOTIENT_POLL_SEC);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** The halt in force, in the units it happened in (`tasks/30` §1–§2).
 *
 *  ⚠ **The equity handed to `canClearHalt` is the heartbeat's**, which is the executor's
 *  own read and at most a loop old — deliberately, rather than this process asking the
 *  venue. Two reads are two answers, and the answer that decides is the one the
 *  executor takes next to the ledger it writes (`src/exec/change-queue.ts`). What this
 *  decides is only whether to *offer* the button; pressing it is re-checked there.
 *
 *  So the verdict here can be generous by a loop, and the failure mode is the harmless
 *  one: the button is offered, the executor refuses, and the screen says why. The
 *  opposite — refusing to show a button the executor would have honoured — costs the
 *  owner a message to us. */
function haltBlock(
  store: Store,
  web: WebStore | null,
  row: AccountRow | null,
  beat: ExecHeartbeat | null,
  now: Date,
): DeskHalt | null {
  if (!row || row.halted !== 1) return null;
  const account = row.account;
  const hb = heartbeatFor(beat, account) as { equityUsd?: number } | null;
  const verdict = canClearHalt({
    actor: "owner",
    kind: row.halt_kind ?? null,
    haltedAt: store.haltedAt(account),
    day: row.day,
    dayStartEquity: row.day_start_equity,
    equityUsd: typeof hb?.equityUsd === "number" ? hb.equityUsd : null,
    now,
  });
  const req = web?.unhaltRequest(account) ?? null;
  return {
    kind: row.halt_kind ?? null,
    reason: row.halt_reason ?? "No reason recorded.",
    sinceIso: store.haltedAt(account),
    clearable: verdict.ok,
    why: verdict.ok ? verdict.note : verdict.reason,
    pending: req !== null && new Date(req.requestedAt).toISOString() > (store.lastHaltDecisionAt(account) ?? row.connected_at),
    closedToday: store.stoppedOn(account, (row.day ?? now.toISOString()).slice(0, 10)).map((t) => ({
      coin: t.coin,
      side: t.side,
      reason: t.close_reason,
      netUsd: t.net_pnl,
      ofMargin: t.net_pnl !== null && t.margin_usd > 0 ? t.net_pnl / t.margin_usd : null,
    })),
  };
}

export async function buildDesk(
  store: Store,
  address: string,
  venue: { info: InfoClient; universe: Universe } | null,
  now = new Date(),
  /** Where `exec-heartbeat.json` lives. The agent's remaining validity comes from
   *  there — the executor reads it from `extraAgents` once an hour, and this process
   *  has no business making that call once per page load. */
  dataRoot = process.env.DATA_ROOT ?? "data",
  /** The web tier's own database, for the change requests. Optional so a caller
   *  with no request store — a test, a script — still gets the rest of the desk. */
  web: WebStore | null = null,
): Promise<DeskPayload> {
  const row = store.account(address);
  // `account()` matches case-insensitively; every other query below is exact, so from
  // here on use the ledger's own spelling of the key, not the caller's.
  const account = row?.account ?? address.toLowerCase();
  const network = process.env.HYPERLIQUID_TESTNET === "true" ? "testnet" : "mainnet";
  // Read once and passed down. Two callers want it — the agent countdown and "how long
  // until a change applies" — and reading a file another process owns twice in one
  // request could answer them from two different versions of it.
  const beat = readExecHeartbeat(dataRoot, now.getTime());

  const base: DeskPayload = {
    network,
    address: account,
    connected: row !== null,
    mode: row ? (row.mode as "live" | "paper") : null,
    halted: row ? row.halted === 1 : false,
    haltReason: row?.halt_reason ?? null,
    halt: haltBlock(store, web, row, beat, now),
    connectedAt: row?.connected_at ?? null,
    agent: null,
    fee: null,
    // In `base`, so it survives the early return for an account with no ledger row:
    // the poll cadence and what the feed costs are facts about us, true before anyone
    // connects anything.
    feed: { pollSeconds: pollSeconds(), ...readFeedCost(dataRoot) },
    balanceUsd: null,
    positionsUsd: null,
    cashUsd: null,
    todayUsd: null,
    dayStartEquityUsd: row?.day_start_equity ?? null,
    dailyLossPct: RISK_PARAMS.dailyLossPct,
    minOrderNotionalUsd: RISK_PARAMS.minOrderNotionalUsd,
    reserveFrac: RISK_PARAMS.reserveFrac,
    loopIntervalSec: RISK_PARAMS.loopIntervalSec,
    executorSeenSecondsAgo: beat?.ageSeconds ?? null,
    haltAtUsd: null,
    stopOut: null,
    realisedWeekUsd: 0,
    mandateUsd: row?.base_capital ?? null,
    atRiskUsd: 0,
    maxAtRiskUsd: null,
    correlatedStopOfMandate: null,
    openCount: 0,
    // Derived from this account's own per-position size since `tasks/21`, so the
    // header can no longer say "5 allowed" to an account whose answer is 4 or 10. It
    // stays at the default until the settings parse below, because that is the only
    // honest answer before we know what the owner chose.
    maxOpen: maxConcurrentSignals(DEFAULT_USER_SETTINGS),
    positions: [],
    taken: 0,
    skipped: 0,
    foreignPositions: 0,
    limits: null,
    skipReasons: [],
    changes: null,
  };

  if (!row) return base;
  base.changes = web ? changeStatus(store, web, account) : null;

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  base.realisedWeekUsd = realisedSince(store, account, weekAgo);
  base.atRiskUsd = store.deployedMargin(account);
  base.openCount = store.openCount(account);
  base.maxAtRiskUsd = maxDeployedUsd(row.base_capital);
  base.taken = countIntents(store, account);
  base.skipped = countSkips(store, account);
  base.skipReasons = skipBreakdown(store, account, weekAgo);
  base.agent = agentStatus(account, row.mode, beat, now);
  // The state is the executor's — the number here has to be the number the orders
  // carry. Whether it is *required* is not a venue fact and is not on the heartbeat: it
  // is this account's own connection age against a constant, so it is decided here,
  // beside the row it is decided from (`tasks/33`). Without it the settings card would
  // offer a required account the grandfathered invitation — "if you want to support the
  // desk" — for an approval its own executor is refusing to trade without.
  const beatFee = heartbeatFor(beat, account)?.fee ?? null;
  base.fee = beatFee
    && { ...beatFee, required: feeIsRequired(builderRail(), store.connection(account)?.created_at) };

  try {
    const s = JSON.parse(row.settings) as Record<string, unknown>;
    base.limits = {
      leverage: typeof s.leverage === "number" ? s.leverage : null,
      stopLoss: typeof s.stopLoss === "boolean" ? s.stopLoss : null,
      stopPct: typeof s.stopPct === "number" ? s.stopPct : null,
      perSignalPct: typeof s.perSignalPct === "number" ? s.perSignalPct : null,
      holdToTarget: s.holdToTarget === true,
    };
  } catch {
    base.limits = null;
  }
  const L = base.limits;
  if (L && L.leverage !== null && L.stopLoss !== null && L.stopPct !== null && L.perSignalPct !== null) {
    const settings: UserSettings = {
      leverage: L.leverage as UserSettings["leverage"], stopLoss: L.stopLoss,
      stopPct: L.stopPct, perSignalPct: L.perSignalPct, holdToTarget: L.holdToTarget,
      mode: row.mode as UserSettings["mode"],
    };
    const h = haltDistance(settings, row.base_capital, row.day_start_equity);
    base.haltAtUsd = h.haltAtUsd;
    base.stopOut = { ...h.stopOut, stopsToHalt: h.stopsToHalt };
    const shape = bookShape(row.base_capital, settings);
    base.maxOpen = shape.positions;
    base.maxAtRiskUsd = shape.deployedAtFullUsd;
    base.correlatedStopOfMandate = correlatedStopOfMandate(settings);
  }

  const intents = store.liveIntents(account);

  if (!venue) {
    // Ledger-only rendering. Marks, equity and unrealised P&L stay null.
    base.positions = intents.map((i) => ({
      intentId: i.intent_id,
      coin: i.coin,
      side: i.side,
      leverage: i.leverage,
      sizeAbs: i.size_abs,
      marginUsd: i.margin_usd,
      entryPx: i.entry_px,
      markPx: null,
      stopPx: i.stop_px,
      targetPx: i.target_px,
      unrealizedPnlUsd: null,
      liquidationPx: null,
      horizonAt: i.horizon_at,
      rationale: i.rationale,
      status: i.status,
      awaitingFill: i.status === "pending",
    }));
    return base;
  }

  // One venue read either way: live accounts need its equity and positions, paper
  // accounts need only its marks — a paper book priced off live marks is the whole
  // point of paper mode. The route caches this for a few seconds, so a browser
  // polling the screen does not become a matching number of venue reads.
  const view = await readAccountView(venue.info, account as `0x${string}`, venue.universe);
  const paper = row.mode === "paper" ? paperBook(store, account) : null;

  const equity = paper ? paper.equity : view.equityUsd;
  base.balanceUsd = equity;
  /* A paper account's free collateral is not modelled — `paper_cash` holds one equity
     figure and the positions carry their own margin — so the split is the margin those
     positions posted, and the remainder. On a live account it is the venue's, which is
     the only one of the two that includes money the owner committed by hand. */
  if (equity !== null) {
    const committed = paper
      ? paper.positions.reduce((n, p) => n + p.margin_used, 0)
      : equity - view.freeUsd;
    base.positionsUsd = Math.max(0, committed);
    base.cashUsd = Math.max(0, equity - base.positionsUsd);
  }
  base.todayUsd = row.day_start_equity === null || equity === null
    ? null
    : equity - row.day_start_equity;

  const byCoin = new Map<string, LivePosition>();
  if (paper) {
    for (const p of paper.positions) {
      const mark = view.marks.get(p.coin) ?? p.entry_px;
      byCoin.set(p.coin, {
        coin: p.coin,
        szi: p.szi,
        entryPx: p.entry_px,
        marginUsed: p.margin_used,
        // Paper does not model fees or funding, so this is a price difference and
        // nothing more. `src/exec/paper.ts` says the same about its P&L.
        unrealizedPnl: (mark - p.entry_px) * p.szi,
        liquidationPx: null,
        leverage: p.leverage,
      });
    }
  } else {
    for (const p of view.positions) byCoin.set(p.coin, p);
  }

  base.positions = intents.map((i) => {
    const p = byCoin.get(i.coin) ?? null;
    return {
      intentId: i.intent_id,
      coin: i.coin,
      side: i.side,
      leverage: p?.leverage ?? i.leverage,
      sizeAbs: p ? Math.abs(p.szi) : i.size_abs,
      marginUsd: p?.marginUsed ?? i.margin_usd,
      entryPx: p?.entryPx ?? i.entry_px,
      markPx: view.marks.get(i.coin) ?? null,
      stopPx: i.stop_px,
      targetPx: i.target_px,
      unrealizedPnlUsd: p?.unrealizedPnl ?? null,
      liquidationPx: p?.liquidationPx ?? null,
      horizonAt: i.horizon_at,
      rationale: i.rationale,
      status: i.status,
      awaitingFill: p === null,
    };
  });

  // A venue position we have no live intent for. The executor halts on this; the
  // screen states it plainly rather than showing a tidy list that omits it.
  //
  // Only meaningful for a live account. A paper account's venue positions belong to
  // whoever else trades that address, which is not our business and not a halt.
  if (!paper) {
    const ours = new Set(intents.map((i) => i.coin));
    base.foreignPositions = view.positions.filter((p) => !ours.has(p.coin)).length;
  }

  return base;
}
