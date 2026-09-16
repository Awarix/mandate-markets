import { RISK_PARAMS } from "./params.ts";

// How long an agent approval has left, and how to say so.
//
// It lives here, in `src/risk/`, rather than in `src/exec/accounts.ts` where it was
// written, for the same reason `src/broker.ts` sits at the root: the executor and the
// **web tier** both need it, and putting it in either would make one import the other.
// `accounts.ts` reaches the exchange, the keystore and the process environment; the
// public web process must import none of those to render a sentence.
//
// One definition, because there is exactly one thing to say and three audiences for
// it — the operator's alert channel, the executor's log, and the desk of the person
// whose money it is. A second set of words for the third audience would drift from
// the first two, and the drift would be invisible until someone was reading the
// reassuring version while the true one was worse.

/** How an agent approval is renewed, stated once so every message can point at it.
 *
 *  Hyperliquid's UI offers **Remove** and nothing else, which reads as though a lapsed
 *  approval were unrecoverable. It is not: an API wallet is pruned when an
 *  `ApproveAgent` action arrives *with a matching name*, so approving again under the
 *  same name replaces the entry with a fresh expiry. Re-approval **is** the extension;
 *  there is simply no separate action for it. Only the master wallet can sign it,
 *  which is why this is a human deadline and not something the process can retry. */
export const RENEWAL = "approving it again on Hyperliquid replaces it with a fresh 180 days — " +
  "there is no separate extend, and only the master wallet can sign it";

/** What survives a lapsed approval, which is the part everyone gets wrong first.
 *
 *  The frightening reading of "expired" is *my leveraged position is unprotected*, and
 *  that reading is false — the stop and the target are resting orders on Hyperliquid,
 *  placed under the master's own authority, and an expired agent does not touch them.
 *  What actually stops is us: no new position opens, and nothing we placed closes at
 *  its deadline. So every message about a lapse leads with this and states the loss
 *  second. */
const STILL_PROTECTED =
  "Your stops and targets are still on Hyperliquid and still work. What we cannot do is " +
  "place new orders: no new positions, and nothing closes at its deadline.";

export type ExpiryState =
  /** The venue reported no expiry for this agent, or the account is paper. */
  | "unknown"
  /** More than `agentExpiryWarnDays` left. Nothing to do. */
  | "healthy"
  /** Inside the warning window. Signals whose horizon falls past it are already
   *  being refused, so this is not merely advisory. */
  | "warning"
  /** Gone. We can read the account and cannot write to it. */
  | "lapsed";

export type ExpiryStatus = {
  state: ExpiryState;
  /** Fractional days, negative once lapsed. Null when there is no expiry to read. */
  daysLeft: number | null;
  /** ISO timestamp of the lapse, for a screen that wants a date rather than a count. */
  expiresAt: string | null;
  /** Worth waking someone, and worth showing prominently. True for `warning` and
   *  `lapsed` alike — the two differ in urgency, not in whether to speak. */
  firing: boolean;
  message: string;
};

/** Days until the agent approval lapses, and whether that is worth saying out loud.
 *
 *  Expiry mid-position is the bad case and the reason this is tracked continuously
 *  rather than only at connect: an expired agent can still *read* state but cannot
 *  place the order that closes a position. The venue-side stops survive it — which is
 *  the third reason they exist. */
export function expiryStatus(
  validUntil: number | null,
  nowMs: number,
  warnDays = RISK_PARAMS.agentExpiryWarnDays,
): ExpiryStatus {
  if (validUntil === null) {
    return {
      state: "unknown",
      daysLeft: null,
      expiresAt: null,
      firing: false,
      message: "no expiry recorded for this agent",
    };
  }
  const daysLeft = (validUntil - nowMs) / 86_400_000;
  const expiresAt = new Date(validUntil).toISOString();
  if (daysLeft <= 0) {
    return {
      state: "lapsed",
      daysLeft,
      expiresAt,
      firing: true,
      message:
        `${STILL_PROTECTED} The agent approval expired ${Math.abs(daysLeft).toFixed(1)} days ago, ` +
        `so every signal is now skipped rather than opened. To fix it, ${RENEWAL}.`,
    };
  }
  return {
    state: daysLeft < warnDays ? "warning" : "healthy",
    daysLeft,
    expiresAt,
    firing: daysLeft < warnDays,
    message:
      `The agent approval expires in ${daysLeft.toFixed(1)} days. After that we can read state ` +
      "but not close a position, so from now on any signal whose horizon falls past that date " +
      `is skipped rather than opened — and once it passes, ${STILL_PROTECTED.charAt(0).toLowerCase()}` +
      `${STILL_PROTECTED.slice(1)} To fix it, ${RENEWAL}.`,
  };
}
