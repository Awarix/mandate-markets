import type { InfoClient } from "@nktkas/hyperliquid";
import { validate } from "../exec/settings.ts";
import { isValidReferralCode } from "../hl/referral.ts";
import { checkCollateral } from "../hl/state.ts";
import {
  DEFAULT_USER_SETTINGS, DEFAULT_USER_SETTINGS_LAST_TESTED, minFundedForLiveUsd, RISK_PARAMS,
  type UserSettings,
} from "../risk/params.ts";
import type { Store } from "../store/db.ts";
import { holdToTargetOpen, SITE_OFFERS } from "./discovery.ts";
import { readExecHeartbeat } from "./heartbeat.ts";
import type { WebStore } from "./sessions.ts";

// The connect flow, from the web side.
//
// The web tier records what the user wants and reports what the executor has done
// about it. It never mints a key, never holds the keystore passphrase, and never
// writes the ledger — `src/exec/connect-queue.ts` does all three, in the process that
// is not exposed to the internet.
//
// So the steps a user sees are not a wizard we drive; they are the observable states
// of a handshake between two processes. That is why `status` is computed from the two
// databases rather than stored: there is no third place for it to go stale.

export type ConnectStep = "choose" | "minting" | "approve" | "active";

export type ConnectStatus = {
  step: ConnectStep;
  /** An unlink has been asked for and not yet serviced. */
  unlinking: boolean;
  address: string;
  agentAddress: string | null;
  settings: UserSettings | null;
  lastError: string | null;
  /** Whether `lastError` is the desk **waiting on this person** rather than refusing
   *  them. The executor already draws that line — a `ConnectPending` is logged quietly
   *  and written with `status = "awaiting_approval"`, an unexpected failure raises an
   *  ALERT and is never written here at all — and this carries the distinction out to
   *  the page, which otherwise has to guess from the prose.
   *
   *  It exists because guessing went wrong: `waitForKey` treated any `lastError` as
   *  fatal, and the one the executor republishes every 60 seconds between minting a key
   *  and the user approving it — *"agent 0x… is not approved yet"* — is the state the
   *  connect chain is **waiting to move through**. So the chain stopped, on every new
   *  account, at its last step (`tasks/38` §1.1). The page must never match on the
   *  sentence: the executor is the only thing that knows which of its own messages mean
   *  what, and this is it saying so. */
  awaitingUser: boolean;
  /** What the executor actually decided, once it has connected the account. Connecting
   *  is a request for live and nothing else, but it does not make an account live — it
   *  must also be permitted, funded, and inside the account cap. So the screen reports
   *  the outcome rather than assuming it. Null until connected. */
  resolvedMode: "live" | "paper" | null;
  /** How long ago the executor last completed a loop. Null when it has never run.
   *  Shown because every step after "choose" waits on it, and "nothing is happening"
   *  is a much worse message than "the desk is not running". */
  executorSeenSecondsAgo: number | null;
  /** Hyperliquid's minimum order notional, from which the connect screen derives the
   *  **only** funding threshold left: the floor.
   *
   *  There used to be two numbers here — a $100 ceiling on what we would trade and a
   *  $500 limit on what an account could hold — and step 2 led with the ceiling. Both
   *  were removed on 2026-08-31 (`LIVE_MANDATE` carries the argument): an account is
   *  now traded at whatever it holds, so there is nothing to warn anyone about at the
   *  top end. The floor is real and was the footnote: below
   *  `minOrderNotionalUsd / (perSignalPct × leverage)` every signal is skipped as
   *  `below-min-notional` and the account trades nothing while looking connected.
   *
   *  The constant travels rather than the answer because the answer depends on the
   *  sliders, which the page owns: it computes $40 for the weakest combination it
   *  offers (5%, 5x) before step 3, and the exact figure once the user has chosen.
   *  `minFundedForLiveUsd()` is the same formula server-side, and is what the executor
   *  actually enforces. */
  minOrderNotionalUsd: number;
  /** The daily-loss halt, as a fraction of the day's opening equity.
   *
   *  Sent because the connect screen states it in dollars, and it had been a literal
   *  `0.10` in the page's own arithmetic. That was survivable while a $100 ceiling was
   *  the headline protection; with the ceiling gone this **is** the protection, and a
   *  copy of it that drifts from `RISK_PARAMS` would misdescribe the only thing
   *  standing between a bad day and a worse one. */
  dailyLossPct: number;
  /** The part of the mandate that is never posted as margin (`tasks/21` §6).
   *
   *  Travels for the same reason `dailyLossPct` does: the card sizes every figure it
   *  shows off `base − reserve`, and a literal copy of `0.01` on the page would quote
   *  a margin, a position count and a funding floor that the executor does not use.
   *  It is also what makes "10% per position, ten positions" true to the cent rather
   *  than one position short. */
  reserveFrac: number;
  network: "mainnet" | "testnet";
};

/** What the user is allowed to choose. Mirrors `validate()` exactly by calling it —
 *  one definition of a legal setting, not two that drift. */
/** The referral code from a connect request body (`tasks/37` §7.5).
 *
 *  Deliberately **not** part of `parseSettings`: it is not a setting, it is not frozen
 *  into a position, and it cannot be changed later — the slot is spent once, ever. It
 *  travels beside the settings and is parsed beside them.
 *
 *  Three answers, and the middle one is the one to keep straight. Absent or `null` is
 *  **skip**, which is a real choice a person makes with a button and is never an error.
 *  A string that is not a code Hyperliquid would accept is refused outright rather than
 *  sanitised, because it leaves this building as a signed L1 action. */
export function parseReferralCode(
  body: Record<string, unknown>,
): { ok: true; code: string | null } | { ok: false; error: string } {
  const raw = body.referralCode;
  if (raw === undefined || raw === null) return { ok: true, code: null };
  if (typeof raw !== "string") return { ok: false, error: "referralCode must be text" };
  const code = raw.trim();
  if (code === "") return { ok: true, code: null };
  if (!isValidReferralCode(code)) {
    return {
      ok: false,
      error: "That is not a referral code Hyperliquid would accept — they are 1 to 20 letters " +
        "and digits, with nothing else in them.",
    };
  }
  return { ok: true, code };
}

/** What a body's **omitted** fields fall back to.
 *
 *  `tasks/47` Rule 4, first part. On a new connection this is the last block-tested
 *  default while the shipped one is still inside its first block; everywhere else it is
 *  the shipped default. ⚠ The two are equal today and deliberately so
 *  (`DEFAULT_USER_SETTINGS_LAST_TESTED` carries the argument), so nothing about what a
 *  stranger meets changes with this — the machinery is in place for the next default
 *  move, where the author decides both lines together.
 *
 *  ⚠ **A change from an existing account never uses this.** Those settings are their
 *  owner's; `/api/settings` keeps passing the shipped default, which is what it always
 *  did. */
export function seedForNewConnect(i: { blockComplete: boolean }): UserSettings {
  return i.blockComplete ? DEFAULT_USER_SETTINGS : DEFAULT_USER_SETTINGS_LAST_TESTED;
}

export function parseSettings(
  body: Record<string, unknown>,
  now = new Date(),
  /** The fallback for omitted fields. Defaults to the shipped default, so every existing
   *  caller keeps its behaviour and only the connect path opts in. */
  seed: UserSettings = DEFAULT_USER_SETTINGS,
): { ok: true; settings: UserSettings } | { ok: false; error: string } {
  // `mode` is not a web setting. The desk trades real money — someone who connects a
  // funded account wants it traded — so the site offers no simulation switch and never
  // sends this field. Paper is an operator tool, reached one way only: writing
  // `accounts/<address>.json` on the box, which needs someone there.
  //
  // Refused rather than ignored. A body carrying `mode` did not come from our UI, and
  // quietly dropping a field is precisely what turned `mode: "turbo"` into a live
  // account once already. It is also the safer direction to be wrong in: a request
  // asking for paper is told plainly that it will not get it, rather than being
  // answered live without comment.
  if ("mode" in body) {
    return { ok: false, error: "mode is not a setting — the desk trades live, and paper is an operator tool" };
  }

  // `holdToTarget` exists, ships in the UI, and is locked until `holdToTargetOpensAt`
  // so the σ0.5 block is judged against one change rather than two (`SITE_OFFERS`).
  //
  // Refused the same way `mode` is, and for the stronger version of the same reason:
  // the disabled control in the markup is a courtesy to a person, and a POST does not
  // read markup. Only `true` is refused — a body that says `false` is asking for what
  // it would get anyway, and failing that would break every existing client.
  if (body.holdToTarget === true && !holdToTargetOpen(now)) {
    return {
      ok: false,
      error: `holding through a neutral call opens on ${SITE_OFFERS.holdToTargetOpensAt} — ` +
        "we are measuring the current exit policy until then",
    };
  }

  // A key that is present is passed through as-is, even when it is nonsense, so that
  // `validate` refuses it. Type-checking here and silently dropping what fails would
  // apply the default instead. `validate` refuses rather than clamps for exactly this
  // reason; the parser must not undo that.
  const pick = (k: string) => (k in body ? { [k]: body[k] } : {});
  const merged = {
    ...seed,
    ...pick("leverage"), ...pick("stopLoss"), ...pick("stopPct"),
    ...pick("perSignalPct"), ...pick("holdToTarget"),
  } as Parameters<typeof validate>[0];
  try {
    return { ok: true, settings: validate(merged) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "those settings are not valid" };
  }
}

export function connectStatus(
  store: Store,
  web: WebStore,
  address: string,
  dataRoot: string,
  now = Date.now(),
): ConnectStatus {
  const request = web.connectionRequest(address);
  const conn = store.connection(address);
  const account = store.account(address);
  // Asked to be let go, and the executor has not got to it yet. Reported so the screen
  // can say "we are letting go" rather than showing a live-looking desk for the second
  // or two before the next loop runs.
  const unlinking = web.unlinkRequest(address) !== null && conn?.status !== "disconnected";

  let settings: UserSettings | null = null;
  const raw = conn?.settings ?? request?.settings ?? null;
  if (raw !== null) {
    try { settings = { ...DEFAULT_USER_SETTINGS, ...(JSON.parse(raw) as Partial<UserSettings>) }; } catch { settings = null; }
  }

  // An account row means the executor completed every connect-time check and froze
  // the capital. That, not the connections row, is what "connected" actually means.
  let step: ConnectStep;
  if (account !== null) step = "active";
  // An account that was let go starts over. Without this it would fall through to
  // "approve" — its connections row still carries the agent address — and show someone
  // who just unlinked a screen telling them to approve an agent.
  else if (conn?.status === "disconnected") step = "choose";
  else if (request === null && conn === null) step = "choose";
  else if (conn?.agent_address) step = "approve";
  else step = "minting";

  return {
    step,
    unlinking,
    address: address.toLowerCase(),
    agentAddress: conn?.agent_address ?? null,
    settings,
    lastError: conn?.last_error ?? null,
    awaitingUser: conn?.status === "awaiting_approval",
    resolvedMode: (account?.mode as "live" | "paper" | undefined) ?? null,
    executorSeenSecondsAgo: readExecHeartbeat(dataRoot, now)?.ageSeconds ?? null,
    minOrderNotionalUsd: RISK_PARAMS.minOrderNotionalUsd,
    dailyLossPct: RISK_PARAMS.dailyLossPct,
    reserveFrac: RISK_PARAMS.reserveFrac,
    network: process.env.HYPERLIQUID_TESTNET === "true" ? "testnet" : "mainnet",
  };
}

// ── What the account actually holds ─────────────────────────────────────────
//
// Step 2 used to be advice and nothing else: deposit into the perp wallet, and find
// out on the executor's next loop whether you got it right. The two ways to get it
// wrong are both silent — funding the spot wallet instead (Hyperliquid collateralises
// them separately, and every OutcomeMaker wallet is still in that state) and funding
// too little for any signal to clear the $10 minimum notional. Neither looks like an
// error from the outside; the account simply never trades.
//
// So the screen reads the balance and says what it means. This is a **display** read:
// `checkCollateral` is the same function the executor calls at connect, and the
// executor still calls it there, on its own, before a single order. Nothing here
// decides anything.

export type ConnectBalance = {
  /** Perp-wallet equity. What is tradeable, unless the account is unified. */
  perpEquityUsd: number;
  /** Unheld spot USDC. Collateral **only** on a `unifiedAccount`; otherwise this is
   *  money sitting where we cannot reach it, and the reason we say so out loud. */
  spotUsdc: number;
  abstraction: string;
  /** What would become `baseCapital` if the account armed right now. With the ceiling
   *  gone this is traded in full, so it is also the answer to "how much". */
  usableUsd: number;
  /** Enough for at least one legal order at `minUsd`. */
  enough: boolean;
  /** The floor `enough` was measured against — computed from the settings this account
   *  has chosen, or the defaults before it has chosen any. */
  minUsd: number;
  /** `checkCollateral`'s own sentence. Deliberately the same words the executor logs
   *  and writes to `lastError`, so the screen cannot describe the account differently
   *  from the process that trades it. */
  message: string;
};

export async function readConnectBalance(
  info: InfoClient,
  address: string,
  /** The user's chosen settings when they have chosen, the defaults when they have
   *  not. The floor depends on both, so a balance that is "enough" at 10%/10x may not
   *  be at 5%/5x — the page recomputes it live as the sliders move. */
  settings: Pick<UserSettings, "perSignalPct" | "leverage"> = DEFAULT_USER_SETTINGS,
): Promise<ConnectBalance> {
  const minUsd = minFundedForLiveUsd(settings);
  const c = await checkCollateral(info, address as `0x${string}`, minUsd);
  return {
    perpEquityUsd: c.perpEquityUsd,
    spotUsdc: c.spotUsdc,
    abstraction: c.abstraction,
    usableUsd: c.usableUsd,
    enough: c.ok,
    minUsd,
    message: c.message,
  };
}

/** Is there anything for an unlink to stop?
 *
 *  Three states can be stopped, and only the first was recognised before:
 *
 *  - a **connected** account (an `accounts` row) — the desk's Unlink button;
 *  - an unlink **already requested** and not yet serviced, so pressing twice is safe;
 *  - a connection **still pending** — the agent key is minted and sealed, the
 *    connections row is live, and the executor retries the address every loop for as
 *    long as it is there. An abandoned connect logged "holds no usable collateral"
 *    once a minute, indefinitely, and the person who abandoned it had no way to say
 *    so. Reading "not connected" off the account row alone was true of that row and
 *    false of everything else, which made the one state you most want to back out of
 *    the one state you could not.
 *
 *  A connection already `disconnected` is not stoppable — it is already stopped.
 *
 *  **An account pinned by `accounts/<address>.json` is not stoppable from here
 *  either.** The file is the operator's decision to manage it, and `managedAddresses`
 *  lists it from the file regardless of any request — so an unlink is honoured for
 *  one second and the account is re-admitted on the same loop, then released again on
 *  the next, forever, because the executor never deletes a serviced unlink row. That
 *  ran live on our own account for seven loops on 2026-09-04
 *  (`notes/2026-09-04-pinned-account-unlink-loop.md`). Refusing here, with the reason,
 *  is the honest answer: remove the file to stop managing a pinned account.
 *
 *  Pure, and separate from the route, because it is the whole of the decision. */
export function canUnlink(i: {
  hasAccountRow: boolean;
  connectionStatus: string | null;
  unlinkAlreadyRequested: boolean;
  pinned?: boolean;
}): boolean {
  if (i.pinned) return false;
  if (i.hasAccountRow || i.unlinkAlreadyRequested) return true;
  return i.connectionStatus !== null && i.connectionStatus !== "disconnected";
}
