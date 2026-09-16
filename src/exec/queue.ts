import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { LIVE_MANDATE } from "../risk/params.ts";
import { accountKey, type Store } from "../store/db.ts";

// The access queue (`tasks/17`).
//
// **What this file decides is who may enter the connect flow, and nothing else.** An
// admitted account still has to be permitted, funded, clean and inside the account cap
// before a single order is signed — `resolveMode` and `connectAccount` are unchanged
// and are downstream of everything here. Nothing in this file can arm an account, and
// no boost in it can raise `LIVE_MANDATE.maxLiveAccounts`.
//
// It exists because the cap became the front door. Until 2026-09-05 the site connected
// whoever arrived while a slot was free and refused the rest with a sentence; with the
// cap at four including our own account, that refusal is what most people would meet.
// A refusal is a dead end, and a dead end that arrives after somebody has funded a
// fresh Hyperliquid account is worse than one that arrives before. So the queue is the
// entrance: a position, and two ways to move.
//
// The two databases keep their existing split. The queue rows live in `web.sqlite`,
// which the web tier writes and this process reads **read-only**; the admission is a
// row in the ledger, which this process writes and the web tier reads read-only. So
// the public process can put somebody in a queue and can never let them in.

/** How long an admission holds a slot before it goes back to the queue.
 *
 *  Long enough to fund a fresh Hyperliquid account across a timezone and a weekday —
 *  the step that is not instant is a deposit, not a click. Short enough that somebody
 *  who asked, was let in, and disappeared is not holding a place indefinitely: with a
 *  cap of four, one abandoned admission is a quarter of the desk. */
export const SLOT_HOLD_HOURS = 72;

/** One waiting address, as the ordering needs it. Deliberately not the SQLite row:
 *  this shape is what the pure function below is tested against. */
export type QueueRow = {
  address: string;
  joinedAt: number;
  /** An operator put this address at the front (`npm run queue -- invite`). */
  invitedAt: number | null;
  /** A post whose URL named the linked X handle. */
  postedAt: number | null;
  /** Who referred them, if anybody. */
  referredBy: string | null;
  /** Whether this account has linked an X account. **This is what makes a referral of
   *  it count**, and it replaced funding on 2026-09-05 (see `referralCounts`). */
  xLinked: boolean;
  /** When this account was first seen funded above the floor. Recorded and not used in
   *  the ordering: it is the fact a later "your referrals are trading" reward would be
   *  built on, and it costs nothing to keep because the connect screen reads the
   *  balance anyway. */
  fundedAt: number | null;
  /** When an admission this address held expired without it connecting, if one did.
   *
   *  It takes the place of `joinedAt` in the ordering, which is the whole point: a slot
   *  that lapsed has to go back to the queue *and* the person who let it lapse has to
   *  lose their turn, or they are re-admitted on the next loop and the hold renews
   *  itself forever while everybody behind them waits. They keep their place in line —
   *  at the back of it, from the moment the hold ran out.
   *
   *  Comes from the ledger, which the queue's own table knows nothing about, so it is
   *  filled in by the caller on both sides (`serviceQueue` here, `queueStatus` in the
   *  web tier) rather than read from `queue_entries`. */
  lapsedAt: number | null;
};

/** How many valid referrals each address has. **Uncapped, and counted on the X link.**
 *
 *  Both halves changed on 2026-09-05, and the first was a plain design error.
 *
 *  **Funding could not work as the condition.** It was chosen because a wallet is free
 *  to create and funding is the one thing a sybil has to pay for (`tasks/17` §4) —
 *  true, and irrelevant, because of *when* funding happens. Depositing is step 2 of the
 *  connect flow, which is on the far side of admission; and somebody you referred is
 *  behind you in the queue by construction. So the referred account funds only after
 *  the person who referred it has already been let in, and a boost that arrives after
 *  it could have mattered is not a boost. Nobody would ever have seen it fire.
 *
 *  **The X link is the condition instead.** It happens while they are waiting, which is
 *  when the boost has to count; it is verifiable; and it is not free — `x_user_id` is
 *  UNIQUE, so N referrals need N distinct X accounts, and an X account costs a phone
 *  number and a person's time rather than a signature. That is a far higher wall than
 *  the cent it costs us.
 *
 *  **And there is no cap.** There was one (three), on the reasoning that the queue must
 *  not be decided by whoever can produce the most wallets. With the condition moved to
 *  X accounts that argument weakens, and the cap actively defeats the thing referrals
 *  are for: somebody with an audience who posts their link brings *many* people, which
 *  is exactly the outcome worth rewarding, and telling them the first three counted
 *  would be an insult dressed as a rule.
 *
 *  Self-referral is dropped rather than refused, because the refusal belongs at the
 *  door where the link is read and this function must stay total. */
export function referralCounts(rows: QueueRow[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const r of rows) {
    if (r.referredBy === null || !r.xLinked) continue;
    if (r.referredBy === r.address) continue;
    n.set(r.referredBy, (n.get(r.referredBy) ?? 0) + 1);
  }
  return n;
}

/** The queue, in the order slots are handed out. Pure, and the whole of the decision.
 *
 *  **A boost is an order change on a queue for real money** (`tasks/17` §5), so this is
 *  a total function of its rows with no clock, no database and no environment in it,
 *  and `queue.test.ts` drives it against fixtures.
 *
 *  The keys, in order, and why they are tiers rather than an arithmetic of places:
 *
 *  1. **An operator's invite.** Someone on the box named this address.
 *  2. **A verified post.** `tasks/17` §6.1, answered: a post moves you past everyone
 *     who has not posted — one tier, not "three places". With a queue of tens a number
 *     of places is meaningless and with a queue of thousands it is nothing; a tier
 *     means the same thing at every length.
 *  3. **Referrals** — people who took a place through your link and linked an X
 *     account. Uncapped: bringing many is the point.
 *  4. **When they joined** — or when a slot they were given lapsed, whichever is later
 *     — and then the address, so the order is total and stable. Two rows that differ in
 *     nothing must not swap places between two loops.
 *
 *  §2 of the task proposed storing boosts as an adjustment to `joined_at` so the order
 *  stays one `ORDER BY`. This does the same job with a sort key instead: it has the
 *  same property that nothing has to be re-derived when somebody leaves the queue, and
 *  it does not require computing "the gap to the account ahead" at boost time, which
 *  is a number that means something different depending on who else is waiting. */
export function queueOrder(rows: QueueRow[]): string[] {
  const refs = referralCounts(rows);
  const rank = (r: QueueRow): [number, number, number, number, string] => [
    r.invitedAt === null ? 1 : 0,
    r.postedAt === null ? 1 : 0,
    -(refs.get(r.address) ?? 0),
    // In line since — which is when the last held slot lapsed, if one did.
    Math.max(r.joinedAt, r.lapsedAt ?? 0),
    r.address,
  ];
  return [...rows]
    .sort((a, b) => {
      const x = rank(a), y = rank(b);
      for (let i = 0; i < x.length; i++) {
        if (x[i]! < y[i]!) return -1;
        if (x[i]! > y[i]!) return 1;
      }
      return 0;
    })
    .map((r) => r.address);
}

/** 1-based place in the queue, or null for an address that is not waiting. */
export function positionOf(rows: QueueRow[], address: string): number | null {
  const i = queueOrder(rows).indexOf(address.toLowerCase());
  return i === -1 ? null : i + 1;
}

/** Why an address is (or is not) allowed into the connect flow.
 *
 *  Pure, and shared by the two processes that must agree about it: the web tier
 *  refuses `/api/connect/start` on it, and the executor refuses to mint a key on it.
 *  Two copies of this predicate that drift would be a door that is locked on one side
 *  only. */
export function admissionState(i: {
  /** Named in `HL_LIVE_ACCOUNT`. An operator's decision on the box outranks a queue. */
  pinned: boolean;
  /** Already connected — an `accounts` row exists. */
  hasAccountRow: boolean;
  /** The `connections` row's status, if there is one. Anything but `disconnected`
   *  means a connection is already in flight, which is what grandfathers everybody who
   *  was mid-flow when this shipped. */
  connectionStatus: string | null;
  /** `admissions.expires_at`, ISO, if this address holds one. */
  admissionExpiresAt: string | null;
  now: number;
}): { admitted: boolean; why: "pinned" | "connected" | "in-flight" | "admitted" | "queued" | "lapsed" } {
  if (i.pinned) return { admitted: true, why: "pinned" };
  if (i.hasAccountRow) return { admitted: true, why: "connected" };
  if (i.connectionStatus !== null && i.connectionStatus !== "disconnected") {
    return { admitted: true, why: "in-flight" };
  }
  if (i.admissionExpiresAt !== null) {
    return Date.parse(i.admissionExpiresAt) > i.now
      ? { admitted: true, why: "admitted" }
      : { admitted: false, why: "lapsed" };
  }
  return { admitted: false, why: "queued" };
}

/** Read the queue out of the web tier's database. Read-only, for the same reason
 *  `readConnectRequests` is: this process must not be able to invent a request, or a
 *  boost, on somebody's behalf. */
export function readQueue(path: string): QueueRow[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const present = (db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'queue_entries'",
    ).get() as { n: number }).n === 1;
    // A web tier older than this deploy has no queue table, and the two deploy
    // separately. An empty queue is the right answer: nobody can have taken a place in
    // a queue a build without one could not offer.
    if (!present) return [];
    const rows = db.prepare(
      "SELECT address, joined_at, invited_at, posted_at, referred_by, funded_at, x_user_id " +
      "FROM queue_entries",
    ).all() as {
      address: string; joined_at: number; invited_at: number | null;
      posted_at: number | null; referred_by: string | null; funded_at: number | null;
      x_user_id: string | null;
    }[];
    return rows.map((r) => ({
      address: accountKey(r.address),
      joinedAt: r.joined_at,
      invitedAt: r.invited_at,
      postedAt: r.posted_at,
      referredBy: r.referred_by === null ? null : accountKey(r.referred_by),
      xLinked: r.x_user_id !== null,
      fundedAt: r.funded_at,
      // Not in this table: it is the ledger's, and the caller fills it in.
      lapsedAt: null,
    }));
  } finally {
    db.close();
  }
}

/** Fill in `lapsedAt` from the ledger's admissions.
 *
 *  Exported because the web tier shows the position and must compute it the same way.
 *  An admission that was *used* — the account connected — is not a lapse whatever its
 *  expiry says, so the account row is checked before the clock. */
export function withLapses(
  store: Pick<Store, "admission" | "account">,
  rows: QueueRow[],
  now: number,
): QueueRow[] {
  return rows.map((r) => {
    const a = store.admission(r.address);
    if (a === null || store.account(r.address) !== null) return r;
    const expires = Date.parse(a.expires_at);
    return Number.isFinite(expires) && expires <= now ? { ...r, lapsedAt: expires } : r;
  });
}

/** What one pass of the queue decides, computed before anything is written.
 *
 *  Separated from the writing so the decision can be tested without a ledger, and so
 *  the log line and the row come from the same object rather than from two
 *  computations that could disagree about who was admitted and why. */
export function planAdmissions(i: {
  queue: QueueRow[];
  /** Every account live in this process right now — ours included. The same count
   *  `resolveMode` is given. */
  liveAccounts: string[];
  /** Addresses holding an unexpired admission and not yet connected. */
  heldSlots: string[];
  /** Addresses that are past the queue already: connected, mid-connect, or pinned.
   *  They are not waiting and must not be admitted twice. */
  notWaiting: string[];
  max?: number;
}): { admit: string[]; free: number; waiting: string[] } {
  const max = i.max ?? LIVE_MANDATE.maxLiveAccounts;
  const past = new Set([
    ...i.liveAccounts.map(accountKey),
    ...i.heldSlots.map(accountKey),
    ...i.notWaiting.map(accountKey),
  ]);
  // Slots in use: what we are actually trading, plus the places being held for people
  // who were let in and have not connected yet. Counting only the live accounts would
  // admit the whole queue in one loop and then refuse most of them at the venue.
  const used = new Set([...i.liveAccounts.map(accountKey), ...i.heldSlots.map(accountKey)]).size;
  const free = Math.max(0, max - used);
  const waiting = queueOrder(i.queue).filter((a) => !past.has(a));
  return { admit: waiting.slice(0, free), free, waiting };
}

/** Admit the front of the queue for every free slot, and say which and why.
 *
 *  Called once a loop, before the connect requests are serviced. Idempotent: an
 *  address that already holds an admission is not waiting, so a second pass over an
 *  unchanged queue writes nothing. */
export function serviceQueue(deps: {
  store: Store;
  queueDb: string;
  liveAccounts: string[];
  /** Named in `HL_LIVE_ACCOUNT` — never queued, and never admitted from here. */
  pinned: string[];
  log: (m: string) => void;
  now?: number;
}): string[] {
  const now = deps.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const queue = withLapses(deps.store, readQueue(deps.queueDb), now);
  if (queue.length === 0) return [];

  const held: string[] = [];
  for (const a of deps.store.liveAdmissions(nowIso)) {
    // An admission whose account has connected is spent: the account itself is what
    // holds the slot from then on, and counting both would double-count one person.
    if (deps.store.account(a.account) === null) held.push(a.account);
  }
  const notWaiting = [
    ...deps.pinned.map(accountKey),
    ...queue
      .filter((r) => {
        if (deps.store.account(r.address) !== null) return true;
        const c = deps.store.connection(r.address);
        return c !== null && c.status !== "disconnected";
      })
      .map((r) => r.address),
  ];

  const plan = planAdmissions({ queue, liveAccounts: deps.liveAccounts, heldSlots: held, notWaiting });
  if (plan.admit.length === 0) return [];

  const refs = referralCounts(queue);
  const expires = new Date(now + SLOT_HOLD_HOURS * 3600_000);
  for (const address of plan.admit) {
    const row = queue.find((r) => r.address === address)!;
    deps.store.admit(address, "queue", expires, new Date(now));
    // The executor logs the position it chose and why, every time it fills a slot
    // (`tasks/17` §5). A queue that hands a slot to the wrong account is the failure
    // mode that matters here, and this line is what makes it visible afterwards.
    deps.log(
      `${address} admitted from the queue: ${plan.free} slot(s) were free of ` +
      `${LIVE_MANDATE.maxLiveAccounts}, ${plan.waiting.length} waiting` +
      (row.invitedAt !== null ? ", invited by an operator" : "") +
      (row.postedAt !== null ? ", posted" : "") +
      `, ${refs.get(address) ?? 0} referral(s), joined ${new Date(row.joinedAt).toISOString()}. ` +
      `The slot is held until ${expires.toISOString()}. This is entry to the connect flow, ` +
      "not permission to trade: every check in resolveMode still applies.",
    );
  }
  return plan.admit;
}
