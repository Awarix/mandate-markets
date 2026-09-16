import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Login challenges and sessions, in **their own database**.
//
// Deliberately not the trading ledger. The web tier opens `signaldesk.sqlite`
// read-only (see `src/web/desk.ts`), so a bug here — or a compromise of the public
// process — cannot write a row that an executor would later act on. Two files also
// means the session table's write traffic never contends with a tick's.
//
// The challenge row stores the **exact message** that was handed out, rather than the
// parts needed to rebuild it. Reconstructing a signed message server-side is a
// well-known source of verification bugs: any disagreement about whitespace, field
// order or timestamp formatting between the issuing path and the checking path is a
// silent auth failure at best. Storing the literal string removes the question.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS login_challenges (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
-- One row per address that has asked to connect. This is the web tier's half of the
-- connect conversation: it can ask, and only the executor can grant. The executor
-- reads this table read-only and answers in the ledger's connections table, which the
-- web tier in turn reads read-only. Neither process writes the other's database.
CREATE TABLE IF NOT EXISTS connection_requests (
  address      TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  settings     TEXT NOT NULL,
  -- The Hyperliquid referral code this person asked for, or NULL if they skipped
  -- (tasks/37 section 7.5). A column here rather than a table of its own because it is
  -- part of the connect conversation and is chosen once, in the same breath as the
  -- limits -- unlike a settings change, which needs its own row so it cannot outrank an
  -- unlink. Validated before it is written, and again by the executor before it is
  -- signed: this string leaves the building as an L1 action.
  referral_code TEXT
);
-- The other half of the same conversation: one row per address that has asked to be
-- let go. The web tier can ask; only the executor can act, because acting means
-- cancelling orders on a venue with a key this process does not hold.
CREATE TABLE IF NOT EXISTS unlink_requests (
  address      TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL
);
-- A change to the three limits on a connected account (tasks/18). Its own table and
-- deliberately not a column on connection_requests: the executor decides between a
-- connect and an unlink by whichever of those two rows is newer, and a change written
-- there would outrank an unlink the owner had already asked for and re-arm the
-- account on the next loop. Applied once by the executor, which compares
-- requested_at against the ledger's settings_at; never deleted here.
CREATE TABLE IF NOT EXISTS settings_requests (
  address      TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL,
  settings     TEXT NOT NULL
);
-- Re-read the mandate from what the account holds, at the first loop with nothing
-- open (tasks/18 section 4). No amount travels: the executor reads the venue.
CREATE TABLE IF NOT EXISTS mandate_requests (
  address      TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL
);
-- Clear a daily-loss halt (tasks/30 section 1). Its own table for the same reason the
-- two above are separate, and it carries nothing but a timestamp: what may be cleared
-- is decided by canClearHalt on both sides, and a request that carried a reason or a
-- kind would be the web tier asserting a fact about risk state it reads read-only.
--
-- Spent against the ledger's last unhalt DECISION -- cleared or refused -- rather than
-- against the clear alone. A press the executor refuses must not stay in the queue and
-- apply itself when the UTC day rolls: releasing on the day roll is tasks/30 section 4,
-- a risk decision nobody has taken.
CREATE TABLE IF NOT EXISTS unhalt_requests (
  address      TEXT PRIMARY KEY,
  requested_at INTEGER NOT NULL
);

-- The access queue (tasks/17). One row per address that has asked for access, whether
-- or not it ever gets it.
--
-- It lives here, in the web tier's own database, for the same reason every other
-- request does: this process can *ask* and only the executor can *grant*. The grant is
-- an admissions row in the ledger, which this process reads read-only. So a
-- compromise of the public tier can add somebody to a queue and cannot let them trade.
--
-- One row rather than the three tables tasks/17 section 2 sketched (x_links,
-- queue_boosts). A post counts once, which is a column; a referral counts each time,
-- which is a COUNT over other rows' referred_by. Two tables for that would be two
-- joins to say the same thing.
CREATE TABLE IF NOT EXISTS queue_entries (
  address     TEXT PRIMARY KEY,
  joined_at   INTEGER NOT NULL,
  -- Short, derived from the address, and not the address itself: it is pasted into
  -- public posts, and a queue is a list of funded wallets.
  ref_code    TEXT NOT NULL UNIQUE,
  -- Who brought them. Set once, at join, and never rewritten — a referral that could
  -- be re-pointed later is a referral that can be sold twice.
  referred_by TEXT,
  -- When we first saw this account funded above the floor. Recorded, and deliberately
  -- not part of any boost: it was the referral condition until 2026-09-05, when it
  -- turned out it could never fire in time (see referralCounts). It is kept because a
  -- later "your referrals are trading" reward would be built on it, and because the
  -- connect screen reads the balance anyway.
  funded_at   INTEGER,
  -- The X link, from OAuth. One X account per wallet (this row) and one wallet per X
  -- account (the UNIQUE), so a second wallet cannot launder a second boost through one
  -- handle. Since 2026-09-05 this is also what makes a *referral* of this account
  -- count, which is what the UNIQUE is really holding up: N referrals need N distinct
  -- X accounts.
  x_user_id   TEXT UNIQUE,
  x_handle    TEXT,
  x_linked_at INTEGER,
  -- A post whose URL names the linked handle. We check the author, never the words.
  posted_at   INTEGER,
  post_url    TEXT,
  -- An operator put this address at the front (npm run queue -- invite). It moves the
  -- position and nothing else: it cannot arm an account, and it cannot exceed the
  -- account cap. Only HL_LIVE_ACCOUNT does that, and it needs someone on the box.
  invited_at  INTEGER
);
CREATE INDEX IF NOT EXISTS queue_referrer ON queue_entries (referred_by);

-- How many times an address has started the X link handshake today (tasks/17).
--
-- **This table is a spending limit, not a rate limit.** Every completed callback is
-- one paid GET /2/users/me on our X account, and the handshake is reachable by anyone
-- who can sign a wallet message, which is free. A cookie issued by /api/x/start is
-- good for ten minutes and the authorize URL it points at can be replayed, so the
-- count has to be kept where the money is actually spent -- the callback -- and not
-- only where the flow begins.
--
-- One row per address, overwritten when the day rolls, so it never needs sweeping.
CREATE TABLE IF NOT EXISTS x_link_attempts (
  address TEXT PRIMARY KEY,
  -- UTC date the count belongs to, from dayKey().
  day     TEXT NOT NULL,
  n       INTEGER NOT NULL
);
`;

/** Long enough to read a wallet prompt, short enough that a leaked challenge is
 *  worthless by the time anyone finds it. */
export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SESSION_TTL_MS = 7 * 86_400_000;

export type Challenge = { nonce: string; address: string; message: string };
export type Session = { id: string; address: string; expiresAt: number };

/** A row of `queue_entries`, in the database's own spelling — the pure ordering in
 *  `src/exec/queue.ts` takes the shape it needs, and this is what SQLite hands back. */
export type QueueEntryRow = {
  address: string; joined_at: number; ref_code: string; referred_by: string | null;
  funded_at: number | null; x_user_id: string | null; x_handle: string | null;
  x_linked_at: number | null; posted_at: number | null; post_url: string | null;
  invited_at: number | null;
};

type ChallengeRow = { nonce: string; address: string; message: string; created_at: number };
type SessionRow = { id: string; address: string; created_at: number; expires_at: number };

export function webStorePath(dataRoot = process.env.DATA_ROOT ?? "data"): string {
  return `${dataRoot}/web.sqlite`;
}

export class WebStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    // SCHEMA is all CREATE TABLE IF NOT EXISTS, which builds a missing table and says
    // nothing about one that exists with fewer columns. `connection_requests` gained
    // `referral_code` on 2026-09-10 and the live database already had rows in it. Same
    // shape and same reasoning as `addMissingColumns` in src/store/db.ts; additive
    // only, so every existing row reads NULL — which is exactly what "this person was
    // never asked" means.
    const cols = new Set((this.db.prepare("PRAGMA table_info(connection_requests)").all() as { name: string }[])
      .map((c) => c.name));
    if (cols.size > 0 && !cols.has("referral_code")) {
      this.db.exec("ALTER TABLE connection_requests ADD COLUMN referral_code TEXT");
    }
  }

  close(): void {
    this.db.close();
  }

  // ── login challenges ──────────────────────────────────────────────────────

  /** Issue a single-use challenge bound to one address. */
  putChallenge(address: string, message: string, now = Date.now()): Challenge {
    const nonce = randomBytes(16).toString("hex");
    this.db.prepare("INSERT INTO login_challenges (nonce, address, message, created_at) VALUES (?, ?, ?, ?)")
      .run(nonce, address.toLowerCase(), message, now);
    return { nonce, address: address.toLowerCase(), message };
  }

  /** Take a challenge, consuming it. Returns null if it is unknown, already used, or
   *  expired — the caller cannot tell those apart, and should not.
   *
   *  `DELETE ... RETURNING` makes take-and-consume one statement, so a replayed
   *  signature cannot win a race against its own first use. */
  takeChallenge(nonce: string, now = Date.now()): Challenge | null {
    const row = this.db.prepare(
      "DELETE FROM login_challenges WHERE nonce = ? RETURNING nonce, address, message, created_at",
    ).get(nonce) as ChallengeRow | undefined;
    if (!row) return null;
    if (now - row.created_at > CHALLENGE_TTL_MS) return null;
    return { nonce: row.nonce, address: row.address, message: row.message };
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  createSession(address: string, now = Date.now(), ttlMs = SESSION_TTL_MS): Session {
    // 32 bytes of CSPRNG output. Looked up by primary key, so there is no string
    // comparison to time; guessing is the only attack and it is not available.
    const id = randomBytes(32).toString("hex");
    const expiresAt = now + ttlMs;
    this.db.prepare("INSERT INTO sessions (id, address, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .run(id, address.toLowerCase(), now, expiresAt);
    return { id, address: address.toLowerCase(), expiresAt };
  }

  session(id: string, now = Date.now()): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now) {
      this.destroySession(id);
      return null;
    }
    return { id: row.id, address: row.address, expiresAt: row.expires_at };
  }

  destroySession(id: string): void {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  // ── connect requests ──────────────────────────────────────────────────────

  /** Record that this address wants to connect, with the three numbers it chose.
   *
   *  Re-asking is allowed and simply replaces the settings: the executor has not
   *  frozen anything yet, so until it does, changing your mind is free. Once it
   *  connects, `baseCapital` and the settings are frozen and this row stops mattering.
   */
  requestConnection(address: string, settings: unknown, now = Date.now(), referralCode: string | null = null): void {
    this.db.prepare(
      // `requested_at` is refreshed, not preserved. It is not decoration: the executor
      // decides between a connect request and an unlink request by whichever is newer,
      // so a row that keeps its original timestamp is a request that can never win
      // again. Someone who connects, unlinks, then comes back would have sat behind
      // their own unlink forever, pressing a button that did nothing.
      `INSERT INTO connection_requests (address, requested_at, settings, referral_code) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET settings = excluded.settings,
         requested_at = excluded.requested_at,
         -- COALESCE for the same reason the ledger's column has it: re-asking with no
         -- code must not erase a code already chosen. Skipping is expressed by never
         -- having set one, not by unsetting one.
         referral_code = COALESCE(excluded.referral_code, connection_requests.referral_code)`,
    ).run(address.toLowerCase(), now, JSON.stringify(settings), referralCode);
  }

  /** Ask the executor to stop managing this account. Idempotent, and deliberately not
   *  self-clearing: the executor reads this database read-only, so the request stands
   *  until the *web* tier retires it — which it does when the same address connects
   *  again, below. A request that outlived its unlink would otherwise unlink the next
   *  connection the moment it was made. */
  requestUnlink(address: string, now = Date.now()): void {
    this.db.prepare(
      "INSERT INTO unlink_requests (address, requested_at) VALUES (?, ?) " +
      "ON CONFLICT(address) DO UPDATE SET requested_at = excluded.requested_at",
    ).run(address.toLowerCase(), now);
  }

  unlinkRequest(address: string): { address: string; requestedAt: number } | null {
    const r = this.db.prepare("SELECT * FROM unlink_requests WHERE address = ?")
      .get(address.toLowerCase()) as { address: string; requested_at: number } | undefined;
    return r ? { address: r.address, requestedAt: r.requested_at } : null;
  }

  /** Retire a spent unlink request. Called when the address asks to connect again. */
  clearUnlinkRequest(address: string): void {
    this.db.prepare("DELETE FROM unlink_requests WHERE address = ?").run(address.toLowerCase());
  }

  // ── change requests (tasks/18) ────────────────────────────────────────────

  /** Ask the executor to change the limits on a connected account. The latest request
   *  wins, as with connect; the executor applies whichever is newer than the ledger's
   *  `settings_at` and leaves the row where it is. */
  requestSettings(address: string, settings: unknown, now = Date.now()): void {
    this.db.prepare(
      `INSERT INTO settings_requests (address, requested_at, settings) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET settings = excluded.settings, requested_at = excluded.requested_at`,
    ).run(address.toLowerCase(), now, JSON.stringify(settings));
  }

  settingsRequest(address: string): { address: string; requestedAt: number; settings: string } | null {
    const r = this.db.prepare("SELECT * FROM settings_requests WHERE address = ?")
      .get(address.toLowerCase()) as { address: string; requested_at: number; settings: string } | undefined;
    return r ? { address: r.address, requestedAt: r.requested_at, settings: r.settings } : null;
  }

  /** Ask the executor to re-read the mandate from what the account holds. */
  requestMandate(address: string, now = Date.now()): void {
    this.db.prepare(
      "INSERT INTO mandate_requests (address, requested_at) VALUES (?, ?) " +
      "ON CONFLICT(address) DO UPDATE SET requested_at = excluded.requested_at",
    ).run(address.toLowerCase(), now);
  }

  mandateRequest(address: string): { address: string; requestedAt: number } | null {
    const r = this.db.prepare("SELECT * FROM mandate_requests WHERE address = ?")
      .get(address.toLowerCase()) as { address: string; requested_at: number } | undefined;
    return r ? { address: r.address, requestedAt: r.requested_at } : null;
  }

  /** Ask the executor to clear a daily-loss halt (`tasks/30` §1). Nothing about the
   *  halt travels: the executor re-checks with the same `canClearHalt` this process
   *  used to decide whether to offer the button at all. */
  requestUnhalt(address: string, now = Date.now()): void {
    this.db.prepare(
      "INSERT INTO unhalt_requests (address, requested_at) VALUES (?, ?) " +
      "ON CONFLICT(address) DO UPDATE SET requested_at = excluded.requested_at",
    ).run(address.toLowerCase(), now);
  }

  unhaltRequest(address: string): { address: string; requestedAt: number } | null {
    const r = this.db.prepare("SELECT * FROM unhalt_requests WHERE address = ?")
      .get(address.toLowerCase()) as { address: string; requested_at: number } | undefined;
    return r ? { address: r.address, requestedAt: r.requested_at } : null;
  }

  connectionRequest(address: string): { address: string; requestedAt: number; settings: string } | null {
    const r = this.db.prepare("SELECT * FROM connection_requests WHERE address = ?")
      .get(address.toLowerCase()) as { address: string; requested_at: number; settings: string } | undefined;
    return r ? { address: r.address, requestedAt: r.requested_at, settings: r.settings } : null;
  }

  // ── the access queue (tasks/17) ───────────────────────────────────────────

  /** A short public code for an address. Derived, so it never has to be generated,
   *  stored uniquely by luck, or looked up to be issued — and deliberately not the
   *  address, because a referral link is pasted in public and the queue is a list of
   *  wallets that intend to be funded. */
  static refCode(address: string): string {
    return createHash("sha256").update(address.toLowerCase()).digest("base64url").slice(0, 10);
  }

  /** Take a place in the queue. Idempotent: asking twice keeps the first `joined_at`,
   *  because re-pressing a button must never cost somebody their place — and keeps the
   *  first `referred_by` for the same reason in reverse, so a place cannot be
   *  re-credited to a second referrer later. */
  joinQueue(address: string, referredBy: string | null, now = Date.now()): void {
    this.db.prepare(
      `INSERT INTO queue_entries (address, joined_at, ref_code, referred_by) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO NOTHING`,
    ).run(address.toLowerCase(), now, WebStore.refCode(address), referredBy?.toLowerCase() ?? null);
  }

  queueEntry(address: string): QueueEntryRow | null {
    return (this.db.prepare("SELECT * FROM queue_entries WHERE address = ?")
      .get(address.toLowerCase()) as QueueEntryRow | undefined) ?? null;
  }

  queueEntryByRefCode(code: string): QueueEntryRow | null {
    return (this.db.prepare("SELECT * FROM queue_entries WHERE ref_code = ?")
      .get(code) as QueueEntryRow | undefined) ?? null;
  }

  queueEntries(): QueueEntryRow[] {
    return this.db.prepare("SELECT * FROM queue_entries").all() as QueueEntryRow[];
  }

  /** Record that this account is funded above the floor. Set once and never cleared:
   *  it is what makes a referral count, and a referrer cannot be expected to police
   *  somebody else's balance after the fact. */
  markQueueFunded(address: string, now = Date.now()): void {
    this.db.prepare("UPDATE queue_entries SET funded_at = ? WHERE address = ? AND funded_at IS NULL")
      .run(now, address.toLowerCase());
  }

  /** Attach a verified X account. Throws on the UNIQUE, which is the rule — one wallet
   *  per X account — surfacing rather than being silently overwritten. */
  linkX(address: string, xUserId: string, handle: string, now = Date.now()): void {
    this.db.prepare(
      "UPDATE queue_entries SET x_user_id = ?, x_handle = ?, x_linked_at = ? WHERE address = ?",
    ).run(xUserId, handle, now, address.toLowerCase());
  }

  /** The wallet an X account is already attached to, if any. Checked before linking so
   *  the refusal can say what happened instead of surfacing a constraint error. */
  walletForXUser(xUserId: string): string | null {
    const r = this.db.prepare("SELECT address FROM queue_entries WHERE x_user_id = ?")
      .get(xUserId) as { address: string } | undefined;
    return r?.address ?? null;
  }

  /** A post counts once. A second one replaces the URL on record and does not move the
   *  position again — the boost is a tier, not an arithmetic (tasks/17 section 6.1). */
  recordPost(address: string, url: string, now = Date.now()): void {
    this.db.prepare(
      "UPDATE queue_entries SET post_url = ?, posted_at = COALESCE(posted_at, ?) WHERE address = ?",
    ).run(url, now, address.toLowerCase());
  }

  /** An operator's invite: front of the queue, and nothing else. Written by
   *  `npm run queue -- invite`, on the box. */
  inviteToQueue(address: string, now = Date.now()): void {
    this.joinQueue(address, null, now);
    this.db.prepare("UPDATE queue_entries SET invited_at = COALESCE(invited_at, ?) WHERE address = ?")
      .run(now, address.toLowerCase());
  }

  /** How many X link attempts this address has spent today. Zero for a row from an
   *  earlier day, which is what makes the limit roll over without a sweep. */
  xAttemptsToday(address: string, day: string): number {
    const r = this.db.prepare("SELECT day, n FROM x_link_attempts WHERE address = ?")
      .get(address.toLowerCase()) as { day: string; n: number } | undefined;
    return r === undefined || r.day !== day ? 0 : r.n;
  }

  /** Count one attempt, and return the new total. Called **before** the paid call to X,
   *  so an attempt that fails at the vendor still costs its holder a place in the
   *  budget — otherwise a loop that always errors is free to run. */
  bumpXAttempt(address: string, day: string): number {
    const next = this.xAttemptsToday(address, day) + 1;
    this.db.prepare(
      `INSERT INTO x_link_attempts (address, day, n) VALUES (?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET day = excluded.day, n = excluded.n`,
    ).run(address.toLowerCase(), day, next);
    return next;
  }

  /** Expired rows are dead weight, not a correctness problem — `session()` already
   *  refuses them. Called on an interval so the file does not grow without bound. */
  sweep(now = Date.now()): { sessions: number; challenges: number } {
    const s = this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    const c = this.db.prepare("DELETE FROM login_challenges WHERE created_at <= ?")
      .run(now - CHALLENGE_TTL_MS);
    return { sessions: Number(s.changes), challenges: Number(c.changes) };
  }
}
