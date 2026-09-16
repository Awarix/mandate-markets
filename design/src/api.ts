// The HTTP surface of src/web/server.ts, from the browser's side.
//
// The payload types below mirror `DeskPayload` (src/web/desk.ts), `ConnectStatus` and
// `ConnectBalance` (src/web/connect.ts). They are a second declaration of a shape the
// server owns, which is a real cost — but the alternative is importing across the
// node/browser boundary, and these are checked against the server's own types by
// nothing but review. **If a field moves on the server, it moves here.**

export type ApiError = Error & { status?: number };

export async function api<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(path, { credentials: "same-origin", ...(opts ?? {}) });
  const body = await r.json().catch(() => ({})) as { error?: string };
  if (!r.ok) {
    const e = new Error(body.error ?? `HTTP ${r.status}`) as ApiError;
    e.status = r.status;
    throw e;
  }
  return body as T;
}

export type Me = { address: string; connected: boolean; mode: "live" | "paper" | null };

export type DeskPosition = {
  /** Never displayed. It is what the share button hands to `/api/share/position`, so
   *  the server can re-read the row rather than trust figures from this page. */
  intentId: string;
  coin: string;
  side: "long" | "short";
  leverage: number;
  sizeAbs: number;
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
  awaitingFill: boolean;
};

/** Mirrors `DeskAgent` in src/web/desk.ts. Null for a paper account, and whenever the
 *  executor is not reporting this one. */
export type DeskAgent = {
  state: "unknown" | "healthy" | "warning" | "lapsed";
  daysLeft: number | null;
  expiresAt: string | null;
  message: string;
};

/** Mirrors `PreparedRenewal` in src/web/renew.ts.
 *
 *  `typedData` is deliberately opaque here: the page never inspects it, it hands it
 *  straight to the wallet. Everything a person needs to read before signing is in the
 *  decoded fields beside it, which is the point — the screen states the agent, the name
 *  and the date, and does not ask anybody to parse EIP-712 in their head. */
export type RenewStep = "remove" | "approve";
export type PreparedRenewal = {
  steps: Array<{ step: RenewStep; typedData: unknown }>;
  agentAddress: string;
  agentName: string;
  expiresAt: string;
  /** Two signatures rather than one: Hyperliquid refuses to re-approve an address it
   *  still holds, so the existing entry is cleared first. */
  replacingExisting: boolean;
};

/** Mirrors `FeeStatus` in src/hl/approve-builder-fee.ts — what this account is charged
 *  on its order flow.
 *
 *  `off` means no rail at all and nobody is charged anything. `unapproved` means a rate
 *  exists and this account has not agreed to it, so its orders carry no builder code
 *  and fill exactly as they do now. `charging` names the rate and the ceiling the owner
 *  signed, which are the same number by design.
 *
 *  The desk's copy comes from the executor, so it is what the orders actually carry;
 *  `/api/fee` reads the venue and is used to confirm a signature landed. */
export type FeeStatus =
  | { state: "off" }
  | { state: "unapproved"; tenthsBp: number; percent: string }
  | { state: "charging"; tenthsBp: number; percent: string; approvedMaxTenthsBp: number };

/** What `/api/fee` adds on top: whether *this* account must approve before it arms.
 *
 *  `unapproved` used to mean one thing — an invitation. Since `tasks/33` it means two,
 *  and they read completely differently to the person on the screen: an owner who
 *  connected before `BUILDER_FEE.requiredForConnectionsFrom` is being *offered*
 *  something, and one who connected after is being told what the desk charges. Which
 *  is not a property of the fee, so it is not on `FeeStatus`; it is a property of the
 *  account, decided from the connection's own age, and the server is the only place
 *  that knows it.
 *
 *  Absent or false is the safe reading and the one every older cached response gives. */
export type FeeState = FeeStatus & { required?: boolean };

/** Mirrors `PreparedApproval` in src/web/builder-fee.ts. `typedData` is opaque for the
 *  same reason a renewal's is: the page hands it to the wallet and states the decoded
 *  values beside it rather than asking anybody to read EIP-712. */
export type PreparedApproval = {
  typedData: unknown;
  builder: string;
  percent: string;
  tenthsBp: number;
};

/** Mirrors `Portfolio` in src/hl/portfolio.ts — Hyperliquid's own equity history, on
 *  its own ~2-hourly grid, from `GET /api/desk/history`.
 *
 *  `nav` is what the account was worth and `pnl` is that less money paid in. **The
 *  chart draws `pnl`**: a deposit is a climb in the first and not in the second, and
 *  drawing it would render paying money in as making it.
 *
 *  `changeUsd` is the change *across* the window, not `pnl`'s last value — that one is
 *  cumulative since the account opened and would put an all-time figure under a tab
 *  reading 24H. Null for a window with nothing in it. */
export type PortfolioWindow = "day" | "week" | "month" | "allTime";
export type PortfolioSeries = {
  points: { t: number; nav: number; pnl: number }[];
  changeUsd: number | null;
  /** That as a fraction of what the account was worth when the window opened — the
   *  simple return over it. Null when that base was under a dollar, where a true
   *  percentage runs into the hundreds of thousands and says nothing. */
  changePct: number | null;
};
export type Portfolio = Record<PortfolioWindow, PortfolioSeries>;

/** Mirrors `DeskFeed` in src/web/desk.ts. Every field nullable: the numbers come from
 *  files two other processes write, and a missing one means we say less, not that the
 *  desk breaks. */
export type DeskFeed = {
  pollSeconds: number | null;
  month: string | null;
  monthCalls: number | null;
  monthUsd: number | null;
  lastPollAt: string | null;
};

export type DeskHalt = {
  /** `daily-loss` is the only kind the owner can clear. Null is a halt that fired
   *  before the desk recorded the kind, and is operator-only for the same reason: the
   *  alternative is guessing it out of the sentence. */
  kind: "daily-loss" | "foreign-position" | "foreign-order" | "liquidation" | "operator" | null;
  reason: string;
  sinceIso: string | null;
  clearable: boolean;
  /** Shown whether or not the button is. For a foreign-actor halt the explanation *is*
   *  the content of the halt, and a disabled control with none is what `tasks/30` §1
   *  says not to ship. */
  why: string;
  pending: boolean;
  closedToday: { coin: string; side: string; reason: string | null; netUsd: number | null; ofMargin: number | null }[];
};

export type Desk = {
  network: "mainnet" | "testnet";
  address: string;
  connected: boolean;
  mode: "live" | "paper" | null;
  halted: boolean;
  haltReason: string | null;
  /** The halt in force, in the units it happened in (`tasks/30` §1–§2). Null when the
   *  account is not paused. `haltReason` above is the same sentence and is kept for the
   *  one-line version; everything else about the day is here. */
  halt: DeskHalt | null;
  connectedAt: string | null;
  agent: DeskAgent | null;
  /** Null when the executor is not reporting this account — not `off`, which would be
   *  a claim about somebody's money made from an absence of data. The `state` is the
   *  executor's, off the heartbeat, so it is what the orders carry; `required` is not a
   *  venue fact and is decided by the web tier from this connection's own age. */
  fee: FeeState | null;
  feed: DeskFeed;
  balanceUsd: number | null;
  /** The split under it: what open positions hold, and what is free. They add to
   *  `balanceUsd` by construction — one venue read, not two. Null with it. */
  positionsUsd: number | null;
  cashUsd: number | null;
  todayUsd: number | null;
  /** How far the day can go (tasks/19). All from the ledger row and RISK_PARAMS, so
   *  they render when Hyperliquid is unreachable. `haltAtUsd` is null until the first
   *  tick seeds the baseline; `stopOut` is null when the settings could not be read. */
  dayStartEquityUsd: number | null;
  dailyLossPct: number;
  /** What the limits card needs to price a change and to say how long it waits
   *  (`tasks/18` §9). Same constants the connect screen is sent, same reason. */
  minOrderNotionalUsd: number;
  reserveFrac: number;
  loopIntervalSec: number;
  executorSeenSecondsAgo: number | null;
  haltAtUsd: number | null;
  stopOut: { usd: number; ofMandate: number; ofMargin: number; stopsToHalt: number } | null;
  realisedWeekUsd: number;
  mandateUsd: number | null;
  atRiskUsd: number;
  maxAtRiskUsd: number | null;
  /** What one correlated move costs if every open position stops together, as a
   *  fraction of the mandate (`tasks/21` §4). Null until the settings parse. */
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
    /** Never null: an account connected before this setting existed was traded on the
     *  closing policy, which is what `false` says. */
    holdToTarget: boolean;
  } | null;
  /** `label` is added by the route, not by `buildDesk` — see server.ts. */
  skipReasons: { reason: string; count: number; label: string }[];
  /** Mirrors `Changes` in src/web/changes.ts (tasks/18). Null with no ledger row. */
  changes: {
    pendingSettings: { requestedAt: string; settings: UserSettings } | null;
    pendingMandate: { requestedAt: string } | null;
    settingsAt: string | null;
    mandateAt: string | null;
    pinned: boolean;
    refused: string | null;
  } | null;
};

export type UserSettings = {
  leverage: number;
  stopLoss: boolean;
  stopPct: number;
  perSignalPct: number;
  /** Optional on the wire: an account connected before this setting existed has no
   *  such key in its stored row, and the server sends the row back as it found it. */
  holdToTarget?: boolean;
};

export type ConnectStatus = {
  step: "choose" | "minting" | "approve" | "active";
  unlinking: boolean;
  address: string;
  agentAddress: string | null;
  settings: UserSettings | null;
  lastError: string | null;
  /** `lastError` is the desk waiting on this person, not refusing them. */
  awaitingUser: boolean;
  resolvedMode: "live" | "paper" | null;
  executorSeenSecondsAgo: number | null;
  minOrderNotionalUsd: number;
  dailyLossPct: number;
  reserveFrac: number;
  network: "mainnet" | "testnet";
};

/** Mirrors `QueueStatus` in src/web/queue.ts (`tasks/17`). */
export type QueueStatus = {
  admitted: boolean;
  why: "pinned" | "connected" | "in-flight" | "admitted" | "queued" | "lapsed" | "not-joined";
  joined: boolean;
  position: number | null;
  cap: number;
  admittedUntil: string | null;
  refCode: string | null;
  referrals: number;
  posted: boolean;
  postUrl: string | null;
  xHandle: string | null;
  xConfigured: boolean;
  postCheckable: boolean;
  draftUrl: string | null;
  funded: boolean;
};

export type ConnectBalance = {
  perpEquityUsd: number;
  spotUsdc: number;
  abstraction: string;
  usableUsd: number;
  enough: boolean;
  minUsd: number;
  message: string;
};

/** Mirrors the `/api/referral` payload (src/hl/referral.ts). `state` is the whole of
 *  the decision: the page speaks in exactly one of the three. */
export type ReferralInfo = {
  state: "none" | "ours" | "theirs";
  /** This account's own code, null when it has none — which is the state the step that
   *  offers one renders in. */
  code: string | null;
  /** Ours, to prefill the box with. Sent so the page holds no second copy of it. */
  ourCode: string;
  link: string;
  discountPct: number;
  sharePct: number;
};

export type Challenge = { nonce: string; message: string };

/** Mirrors `SignalRow` / `SignalHistory` in src/web/desk.ts (`GET /api/signals`).
 *
 *  `netPnlUsd` is settled net of fees and funding. There is deliberately no field for
 *  the ledger's *estimate*: it disagrees with what Hyperliquid shows the account's
 *  owner — measured, by $3.35 over 18 trips — and not disagreeing with Hyperliquid is
 *  the promise in `docs/USER-JOURNEY.md` §13. */
export type SignalRow = {
  outcome: "taken" | "skipped";
  signalRef: string;
  coin: string | null;
  firstAt: string;
  lastAt: string;
  firstRevision: number;
  lastRevision: number;
  seenCount: number;
  reason: string | null;
  label: string | null;
  detail: string | null;
  intentId: string | null;
  side: string | null;
  status: string | null;
  closeReason: string | null;
  netPnlUsd: number | null;
  rationale: string | null;
};

export type SignalHistory = {
  address: string;
  mode: "live" | "paper" | null;
  since: string;
  rows: SignalRow[];
};

/** Mirrors `TradeRow` / `TradeHistory` in src/web/desk.ts (`GET /api/history`).
 *
 *  There is no field for the ledger's estimate here either, for the same reason: see
 *  `SignalRow`. `nextBefore` is opaque — pass it straight back as `?before=`. */
export type TradeRow = {
  intentId: string;
  coin: string;
  /** Narrowed to match the server, which reads it from the intent row and never writes
   *  anything else. A bare `string` here forced a cast at every arithmetic call site. */
  side: "long" | "short";
  leverage: number;
  marginUsd: number;
  sizeAbs: number;
  refPx: number;
  entryPx: number | null;
  targetPx: number | null;
  stopPx: number | null;
  openedAt: string;
  closedAt: string | null;
  closeReason: string | null;
  netPnlUsd: number | null;
  feeUsd: number | null;
  fundingUsd: number | null;
  pnlNote: string | null;
  /** The forecast's own numbers, joined from `signals` server-side. Null means the row
   *  is gone or predates that table — a dash, never an invented 0.00σ. */
  sigma: number | null;
  strength: string | null;
  /** The price it actually left at. Null until the fills are ingested. */
  exitPx: number | null;
  rationale: string;
  paper: boolean;
};

export type TradeHistory = {
  address: string;
  mode: "live" | "paper" | null;
  rows: TradeRow[];
  nextBefore: string | null;
};

/** Mirrors `LeaderboardRow` in src/web/leaderboard.ts. The one payload on this page
 *  about accounts other than the reader's own — which is why the route behind it wants
 *  a session *and* a live account of your own. */
export type LeaderboardRow = {
  rank: number;
  account: string;
  halted: boolean;
  mandateUsd: number;
  /** Settled trades, so `wins / trades` is exactly `winRate`. */
  trades: number;
  wins: number;
  winRate: number | null;
  /** Closed with no venue fills attributed — neither a win nor a loss, and out of the
   *  three columns above. */
  unsettled: number;
  netPnlUsd: number;
  returnFrac: number | null;
  /** How the account is traded. Every row here takes the same signals, so this is the
   *  only thing that differs between them. Null when unreadable. */
  settings: {
    leverage: number;
    perSignalPct: number;
    /** Null when the stop is off, which is not a stop of zero. */
    stopPct: number | null;
    holdToTarget: boolean;
  } | null;
  firstTradeAt: string | null;
  lastCloseAt: string | null;
};

export type Leaderboard = {
  rows: LeaderboardRow[];
  awaitingFirstTrade: number;
  excludedIntents: number;
  heartbeatAgeSeconds: number | null;
  generatedAt: string;
};
