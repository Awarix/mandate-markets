import {
  admissionState, positionOf, queueOrder, referralCounts, withLapses, type QueueRow,
} from "../exec/queue.ts";
import { liveAllowlist } from "../exec/mode.ts";
import { LIVE_MANDATE } from "../risk/params.ts";
import type { Store } from "../store/db.ts";
import { X_HANDLES } from "./cards.ts";
import { X_LINK_ATTEMPTS_PER_DAY } from "./xoauth.ts";
import type { QueueEntryRow, WebStore } from "./sessions.ts";

// The queue, from the web side (`tasks/17`).
//
// Same split as the rest of the connect flow: this process records that somebody asked
// and reports what the executor decided. It cannot admit anybody — the `admissions`
// table is in the ledger, which is opened read-only here and SQLite enforces that.
//
// **A position is private to its owner** (`tasks/17` §6.4). There is no route that
// lists the queue, and there never should be: a queue of people waiting to trade is a
// list of wallets that intend to be funded, published in arrival order. What a person
// gets is their own number and the totals around it.

export type QueueStatus = {
  /** May this address proceed through the connect flow at all. */
  admitted: boolean;
  /** Why, in the executor's own vocabulary — `admissionState` decides both this and
   *  the executor's copy, so the screen cannot describe the door differently from the
   *  process that opens it. */
  why: "pinned" | "connected" | "in-flight" | "admitted" | "queued" | "lapsed" | "not-joined";
  joined: boolean;
  /** 1-based place among those still waiting, or null when not waiting.
   *
   *  **The only count on this payload, and deliberately.** How many others are waiting,
   *  and how many accounts are trading, were both here and both came off on 2026-09-05:
   *  a queue that publishes its own length is either bragging or apologising, and the
   *  reader is the one person it should be talking about. `cap` stays because it is a
   *  published parameter (`llms.txt`) rather than a fact about anybody. */
  position: number | null;
  /** `LIVE_MANDATE.maxLiveAccounts` — every account we trade, ours included. */
  cap: number;
  /** When the held slot lapses, ISO. Only while `why` is "admitted". */
  admittedUntil: string | null;
  /** This address's own referral code, once it has joined. */
  refCode: string | null;
  /** People who took a place through this address's link and linked an X account.
   *  Uncapped — see `referralCounts` for why the cap and the funding condition both
   *  went on 2026-09-05. */
  referrals: number;
  posted: boolean;
  postUrl: string | null;
  xHandle: string | null;
  /** Whether an X app is configured at all. Unconfigured, the X controls are absent
   *  rather than broken (`tasks/17` §3) — the page hides them instead of offering a
   *  button that dead-ends after somebody has cleared X's consent screen. */
  xConfigured: boolean;
  /** Whether a post can actually be checked — the app-only bearer token is set. The
   *  post boost is hidden without it, while linking X stays available, because a
   *  linked handle is also what makes a referral of this account count. */
  postCheckable: boolean;
  /** X's composer, prefilled with a draft they are free to rewrite. Null until they
   *  have a place (and so a referral code to put in it). */
  draftUrl: string | null;
  /** Seen funded above the floor. Nothing on the screen turns on it any more — it is
   *  kept for the "your referrals are trading" reward that does not exist yet. */
  funded: boolean;
};

/** The queue rows, in the shape the pure ordering wants. */
export function toQueueRows(rows: QueueEntryRow[]): QueueRow[] {
  return rows.map((r) => ({
    address: r.address.toLowerCase(),
    joinedAt: r.joined_at,
    invitedAt: r.invited_at,
    postedAt: r.posted_at,
    referredBy: r.referred_by?.toLowerCase() ?? null,
    xLinked: r.x_user_id !== null,
    fundedAt: r.funded_at,
    // Filled in from the ledger by `withLapses`, below: a slot that lapsed moves its
    // holder to the back, and the position this screen shows has to say so.
    lapsedAt: null,
  }));
}

/** Who is past the queue: connected, mid-connect, holding an unexpired admission, or
 *  named in `HL_LIVE_ACCOUNT`. They are not waiting, so they do not take up a place in
 *  front of anybody, and the count the screen shows is of people actually in line. */
function stillWaiting(store: Store, rows: QueueRow[], env: NodeJS.ProcessEnv, now: number): QueueRow[] {
  const allowlisted = liveAllowlist(env);
  return withLapses(store, rows, now).filter((r) => {
    const conn = store.connection(r.address);
    const gate = admissionState({
      pinned: allowlisted.includes(r.address),
      hasAccountRow: store.account(r.address) !== null,
      connectionStatus: conn?.status ?? null,
      admissionExpiresAt: store.admission(r.address)?.expires_at ?? null,
      now,
    });
    return !gate.admitted;
  });
}

export function queueStatus(i: {
  store: Store;
  web: WebStore;
  address: string;
  xConfigured: boolean;
  postCheckable: boolean;
  /** The public host a post has to link to, and the one the draft carries. Never the
   *  runtime origin, which is `127.0.0.1` on the machine this is tested from. */
  domain: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): QueueStatus {
  const env = i.env ?? process.env;
  const now = i.now ?? Date.now();
  const address = i.address.toLowerCase();
  const all = toQueueRows(i.web.queueEntries());
  const mine = i.web.queueEntry(address);
  const conn = i.store.connection(address);
  const admission = i.store.admission(address);

  const gate = admissionState({
    pinned: liveAllowlist(env).includes(address),
    hasAccountRow: i.store.account(address) !== null,
    connectionStatus: conn?.status ?? null,
    admissionExpiresAt: admission?.expires_at ?? null,
    now,
  });

  const waiting = stillWaiting(i.store, all, env, now);
  // Referrals are counted over **every** row, not only the waiting ones: somebody who
  // brought three people who have since been let in still brought them.
  const refs = referralCounts(all);

  return {
    admitted: gate.admitted,
    why: mine === null && !gate.admitted ? "not-joined" : gate.why,
    joined: mine !== null,
    position: gate.admitted ? null : positionOf(waiting, address),
    cap: LIVE_MANDATE.maxLiveAccounts,
    admittedUntil: gate.why === "admitted" ? admission?.expires_at ?? null : null,
    refCode: mine?.ref_code ?? null,
    referrals: refs.get(address) ?? 0,
    posted: mine?.posted_at !== null && mine?.posted_at !== undefined,
    postUrl: mine?.post_url ?? null,
    xHandle: mine?.x_handle ?? null,
    xConfigured: i.xConfigured,
    postCheckable: i.postCheckable,
    draftUrl: mine === null ? null : draftPost(i.domain, mine.ref_code),
    funded: mine?.funded_at !== null && mine?.funded_at !== undefined,
  };
}

/** The order the executor will use, for an operator reading the queue on the box.
 *  Exported here so `npm run queue -- list` and the screen cannot disagree. */
export function queueListing(store: Store, web: WebStore, env = process.env, now = Date.now()): QueueRow[] {
  const waiting = stillWaiting(store, toQueueRows(web.queueEntries()), env, now);
  const order = queueOrder(waiting);
  return order.map((a) => waiting.find((r) => r.address === a)!);
}

// ── Who may spend a call on X ───────────────────────────────────────────────

/** Whether this wallet may run the X link handshake again.
 *
 *  Pure, because it is the decision that stands between a public route and a paid
 *  vendor call, and both places that ask it must agree: `/api/x/start`, where it is
 *  cheap to refuse, and `/api/x/callback`, where the money is actually spent. The
 *  second is the one that matters — a PKCE cookie is good for ten minutes and the
 *  authorize URL it points at can be replayed, so a gate only at the start bounds
 *  nothing.
 *
 *  Already linked is a refusal rather than a no-op: the boost counts once, so a second
 *  link buys the person nothing and buys us a bill. */
export function canSpendXCall(i: { attemptsToday: number; limit?: number }):
  { ok: true } | { ok: false; reason: "limited"; error: string } {
  if (i.attemptsToday >= (i.limit ?? X_LINK_ATTEMPTS_PER_DAY)) {
    return {
      ok: false,
      reason: "limited",
      error: "That is enough X checks for one day. Try again tomorrow.",
    };
  }
  return { ok: true };
}

export function canAttemptXLink(i: {
  handle: string | null;
  attemptsToday: number;
  limit?: number;
}): { ok: true } | { ok: false; reason: "already" | "limited"; error: string } {
  if (i.handle !== null) {
    return {
      ok: false,
      reason: "already",
      error: `This wallet is already linked to @${i.handle}. A post counts once, so there ` +
        "is nothing more to link.",
    };
  }
  return canSpendXCall(i);
}

// ── Verifying a post ────────────────────────────────────────────────────────
//
// The whole check is the URL, and that is a deliberate limit rather than a shortcut.
// `x.com/<handle>/status/<id>` names its author, so a pasted post cannot be somebody
// else's without also claiming somebody else's handle — and the handle is the one we
// verified through OAuth. Reading the *text* would need a bearer token and a paid
// `Posts: Read` call, and would tell us what the post says on the day we looked
// (`tasks/17` §3). The screen says exactly this: we check that the post is yours, we
// do not read what it says.

/** The handle and status id in an X post URL, or null.
 *
 *  Deliberately strict about the shape and deliberately liberal about the noise
 *  around it: people paste with `?t=…&s=20` tracking parameters, with `www.`, from
 *  `twitter.com`, from `mobile.twitter.com`, and with a trailing slash. None of those
 *  changes who wrote it. What it will not accept is a host that merely ends in
 *  `x.com` — `notx.com` and `x.com.evil.tld` are somebody else's domains. */
export function parsePostUrl(raw: string): { handle: string; id: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(www|mobile|m)\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;
  const parts = url.pathname.split("/").filter((p) => p.length > 0);
  // <handle>/status/<id>, and nothing else — /i/web/status/<id> carries no author, so
  // it is refused rather than guessed at.
  if (parts.length < 3 || parts[1]?.toLowerCase() !== "status") return null;
  const handle = parts[0]!;
  const id = parts[2]!;
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (!/^\d{1,25}$/.test(id)) return null;
  return { handle, id };
}

/** Does this post belong to the linked handle? Case-insensitive, because X's own URLs
 *  are: the same post resolves at any casing of its author's handle. */
export function postIsBy(raw: string, linkedHandle: string): boolean {
  const p = parsePostUrl(raw);
  return p !== null && p.handle.toLowerCase() === linkedHandle.toLowerCase().replace(/^@/, "");
}

/** Does this post link to us? Read off `entities.urls`, which is where X keeps the
 *  original of every link it rewrote to `t.co`.
 *
 *  Host-only, and `www.` tolerated: what matters is that somebody following the post
 *  arrives at our site, not which page they land on — a referral link, the home page and
 *  a shared card are all the same answer. Anything unparseable is not a link to us. */
export function postLinksTo(urls: string[], domain: string): boolean {
  const want = domain.toLowerCase().replace(/^www\./, "");
  return urls.some((u) => {
    try {
      return new URL(u).hostname.toLowerCase().replace(/^www\./, "") === want;
    } catch {
      return false;
    }
  });
}

/** The post we hand people, prefilled into X's own composer.
 *
 *  **A draft and not a script**: they can rewrite every word of it, and the only thing
 *  the check requires is the link. It carries their referral code, so a post that brings
 *  somebody also counts as a referral — the two boosts are the same act.
 *
 *  **Both accounts are tagged**, from the one place the handles live, and the sentence
 *  is arranged so that neither is the first thing in it: X treats a post beginning with
 *  a mention as a reply and shows it only to people who follow both accounts. This one
 *  goes nowhere but X's composer, so unlike `shareText` it needs no plain spelling.
 *
 *  Deliberately says nothing about returns. Phase 3 has not answered whether this makes
 *  money, and a sentence we put in somebody else's mouth is the last place to get ahead
 *  of that. */
export function draftPost(domain: string, refCode: string | null): string {
  const link = `https://${domain}/${refCode === null ? "" : `?r=${refCode}`}`;
  const text = `I'm in the queue for ${X_HANDLES.us} — it trades ${X_HANDLES.them}'s market outlooks ` +
    "on my own Hyperliquid account, non-custodial, and the key it uses cannot withdraw.\n\n" + link;
  return `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
}
