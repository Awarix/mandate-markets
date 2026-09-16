import { LIVE_MANDATE, RISK_PARAMS } from "../risk/params.ts";
import { maxDeployedUsd } from "../risk/ledger.ts";

export type ModeDecision = {
  mode: "live" | "paper";
  why: string;
  /** The capital every cap runs off in live: **what the account holds**, in full.
   *  There is no per-account ceiling clamping this down any more — the deposit is how
   *  the user chooses their size (`LIVE_MANDATE`). Null in paper, where the runner
   *  supplies its own simulated base. */
  baseCapitalUsd: number | null;
  /** **Paper as a refusal, not as a choice.** True when live was asked for and denied
   *  — unfunded, not permitted, no free slot — and false when
   *  paper is what was actually wanted (`DRY_RUN` not "false", or `mode: "paper"` in
   *  an operator's `accounts/<address>.json`).
   *
   *  The connect flow needs the difference. Falling back to a simulated book when
   *  someone asked for live tells them they are connected when they are not: they get
   *  a $1,000 balance that is not theirs, a frozen `baseCapital` that then blocks the
   *  live connection they wanted, and no reason they can act on. A blocked account is
   *  left **pending** instead — no ledger row, the agent address still on screen, and
   *  `why` recorded where the connect screen reads it. Found the hard way on
   *  2026-08-31, by connecting an unfunded wallet through the live site. */
  blocked: boolean;
};

/** Whether any connecting account may arm itself, or only the ones an operator has
 *  named. **Off unless explicitly "true".**
 *
 *  This is the gate that lets the connect flow stay open to anyone. With it off, a
 *  stranger who signs in and asks for live gets paper, and the only accounts trading
 *  real money are the ones a person put in `HL_LIVE_ACCOUNT` while logged into the
 *  box. With it on, anyone who connects a funded account is traded — which is the
 *  product, and is a decision to make deliberately and not by leaving a default.
 *
 *  **It is on in production, since 2026-08-31.** So when you are reading this while
 *  changing something downstream, assume real strangers' capital is behind it: the
 *  only things between a wallet that finds mandate.markets and a signed mainnet order
 *  are `LIVE_MANDATE.maxLiveAccounts` and the proportional caps in `RISK_PARAMS` —
 *  there is no longer a dollar ceiling behind them (see `LIVE_MANDATE`). It was
 *  switched on knowing the site is unpromoted, so few can find it and fewer will fund
 *  an account; that reasoning expires the day it is promoted. */
export function selfServiceLive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LIVE_SELF_SERVICE ?? "").trim().toLowerCase() === "true";
}

/** The addresses `HL_LIVE_ACCOUNT` arms, lowercased. Comma-separated, blanks ignored. */
export function liveAllowlist(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.HL_LIVE_ACCOUNT ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/** Whether this account can be **refused** live for want of a free slot.
 *
 *  Two exemptions, and they are different kinds of thing.
 *
 *  **Allowlisted.** Naming an address in `HL_LIVE_ACCOUNT` already required someone on
 *  the box, which is the strongest authorisation this system has — and the aggregate
 *  cap exists to bound *our* blast radius, not to overrule that. The old dollar total
 *  had no such exemption, so two strangers connecting first could push a deliberately
 *  armed account into paper. Arrival order is not an authority.
 *
 *  **Incumbent** — an account we were already trading live, since `tasks/34`. The same
 *  defect ran in the other direction on 2026-09-10: adding one address to the allowlist
 *  pushed `0xf03ca6…`, funded and trading for ten days, out of management entirely,
 *  because slots are consumed by a running count over an arbitrary (sorted) order and
 *  nothing in that count knew which accounts were live a minute ago. Nothing
 *  misconfigured, no rule misfiring — the last address enumerated simply lost.
 *
 *  **Dropping an incumbent is not the same act as refusing a newcomer**, which is why
 *  one predicate cannot treat them alike. A refused newcomer never had a position. A
 *  dropped incumbent keeps its **venue-side stops and targets** — they are resting
 *  orders and we are not there to cancel them — and loses everything else: no
 *  signal-change exit, no horizon close, no daily-loss halt, no foreign-actor
 *  detection. That is precisely the state `docs/USER-JOURNEY.md` §15 makes a user
 *  *confirm*, with the consequence spelled out. It must not be reachable by editing an
 *  environment variable. The displaced account was flat, and that was luck.
 *
 *  So the cap is now first-come rather than last-enumerated. **What is given up is
 *  said out loud**: incumbents alone can hold the live count above `maxLiveAccounts`,
 *  so the cap no longer refuses its way back down to the number. It can only get there
 *  by an operator act in the first place — allowlisting past it, or lowering it — since
 *  an account can only *become* an incumbent through a free slot, and `warnIfOverCap`
 *  in `runner.ts` reports the crossing either way.
 *
 *  **This is no longer the counting rule.** It was `usesLiveSlot` until 2026-09-05 and
 *  answered both questions at once — *is it counted* and *can it be refused* — which
 *  made `maxLiveAccounts` describe fewer accounts than we actually trade. Since
 *  `tasks/17` the cap counts **every** live account, ours included, and only this
 *  narrower question belongs here.
 *
 *  Exported because the caller counts live accounts and must apply the same rule
 *  `resolveMode` enforces. Two copies of this predicate that drift is a cap that
 *  silently stops binding — which is why incumbency is a parameter rather than a
 *  second check bolted on beside the call.
 *
 *  `incumbent` defaults false so that a caller asking the *allowlist* question — which
 *  is what `warnIfOverCap` wants when it names who took the count past the cap — gets
 *  exactly that and nothing else. */
export function canBeRefusedForSlot(
  master: string,
  env: NodeJS.ProcessEnv = process.env,
  incumbent = false,
): boolean {
  return !incumbent && !liveAllowlist(env).includes(master.toLowerCase());
}

/** Paper unless every independent check says otherwise.
 *
 *  `DRY_RUN` defaulting to on is inherited from OutcomeMaker, where it was the one
 *  control that kept things honest. The rest are new.
 *
 *  `HL_LIVE_ACCOUNT` listing the exact master address is the per-account opt-in, so a
 *  `.env` copied between machines cannot silently arm a different account. It holds a
 *  comma-separated allowlist rather than one address, because one variable that can
 *  only name one thing stops working the moment a second account exists. It stays an
 *  environment variable, and deliberately not a column: arming an account for real
 *  money should require someone on the box, not a row that some code path could write.
 *
 *  **What is no longer here: a dollar ceiling.** `LIVE_MANDATE.maxBaseCapitalUsd`
 *  clamped `baseCapital` to $100 and refused any account holding more than $500, and
 *  both were removed on 2026-08-31 — the argument is in `src/risk/params.ts`, at
 *  length, because it deleted this project's loudest rule. In short: the ceiling was
 *  written when every funded account was ours, and once the site opened it was
 *  standing in front of strangers' own money, where the deposit *is* the size they
 *  chose. `baseCapital` is now what the account holds, and the caps that bound the
 *  risk are the proportional ones — isolated margin, venue-side stops,
 *  `maxDeployedPct`, `maxConcurrentSignals(s)`, `dailyLossPct` — which hold at any size.
 *
 *  `LIVE_MANDATE.maxLiveAccounts` bounds the aggregate, in accounts rather than
 *  dollars, over **every** account we trade — ours included since `tasks/17`. An
 *  allowlisted address is counted and never refused; see `canBeRefusedForSlot`. It is
 *  now the only hard cap left on live trading, so read it before changing it.
 *
 *  **What this function does not decide is who is allowed to ask.** Since `tasks/17`
 *  a self-service address must be admitted from the queue before the connect flow
 *  will mint it a key at all (`src/exec/queue.ts`). That gate is upstream and about
 *  *entry*; this one is about *arming*, and neither substitutes for the other. */
export function resolveMode(
  master: string,
  /** Collateral the account actually holds, read from the venue — not a configured
   *  number. This **becomes** `baseCapital` when the account arms: nothing scales it
   *  down. The one thing checked against it here is that it is a real, positive
   *  number; whether it is large enough to place a legal order is
   *  `minFundedForLiveUsd()`, checked at connect where the user's settings are
   *  known. */
  accountCapitalUsd: number,
  env: NodeJS.ProcessEnv = process.env,
  /** How many accounts are already live — **all** of them, ours included. Allowlisted
   *  accounts are counted here and exempted from the refusal below, not the other way
   *  round (`canBeRefusedForSlot`). */
  liveSlotsUsed = 0,
  /** What the user asked for in their settings. Can only move the account down to
   *  paper; it can never be the reason an account goes live. */
  userMode: "live" | "paper" = "live",
  /** Whether we were already trading this account live — its `accounts` row reads
   *  `mode: "live"` from a previous arm. Exempts it from the slot refusal only
   *  (`canBeRefusedForSlot`), never from any other check: an incumbent that has been
   *  emptied, or whose agent approval has lapsed, is still refused, and for its own
   *  reason. `tasks/34`. */
  incumbent = false,
): ModeDecision {
  /** `blocked` defaults true: every remaining branch below is a refusal of live. The
   *  two deliberate cases opt out explicitly, which is the safer default to get wrong
   *  — a refusal mislabelled as a choice silently resurrects the paper fallback. */
  const paper = (why: string, blocked = true): ModeDecision =>
    ({ mode: "paper", why, baseCapitalUsd: null, blocked });

  // Not a refusal: this process is not live-capable at all. `npm run exec` runs here.
  if (env.DRY_RUN !== "false") return paper("DRY_RUN is not 'false'", false);

  // Not a refusal either: paper is what was asked for. Only an operator can ask, by
  // writing `mode: "paper"` into accounts/<address>.json — the web refuses the field.
  if (userMode === "paper") return paper("you chose paper for this account", false);

  // Whether the account is *permitted* to be live is not the user's to decide — and
  // incumbency deliberately does **not** enter here. `LIVE_SELF_SERVICE` off is an
  // operator saying "arm no stranger's account", which is a kill switch; a switch that
  // spares whoever was already running is not one. Permission is the allowlist alone.
  // Only the *slot* check below, which is about capacity rather than authority, knows
  // about incumbents (`tasks/34`).
  const allowlisted = liveAllowlist(env).includes(master.toLowerCase());
  if (!allowlisted && !selfServiceLive(env)) {
    return paper(
      `${master} is not enabled for live trading. An operator adds an account to ` +
      "HL_LIVE_ACCOUNT, or switches on LIVE_SELF_SERVICE to let any connecting " +
      "account arm itself — neither is something a user can do for themselves.",
    );
  }

  if (!Number.isFinite(accountCapitalUsd) || accountCapitalUsd <= 0) {
    return paper("the account holds no usable collateral — fund it before arming live");
  }

  // The per-account ceiling does not compose, so a second cap bounds the aggregate —
  // counted in accounts, because what it bounds is how many people one bug of ours can
  // reach at once, and that does not scale with anybody's dollars. Checked before
  // arming: refusing *this* account is the only safe direction, since disturbing an
  // account already live would re-price positions it already holds.
  //
  // Since `tasks/34` an incumbent is not refusable here, so the account that loses a
  // contested slot is always one we were not trading a moment ago. The message says
  // which kind this is, because until 2026-09-10 both printed the same sentence and a
  // ten-day-old funded account being dropped read exactly like a stranger being turned
  // away.
  if (canBeRefusedForSlot(master, env, incumbent) && liveSlotsUsed >= LIVE_MANDATE.maxLiveAccounts) {
    return paper(
      `the desk is already trading live for ${liveSlotsUsed} accounts, ` +
      `its limit (LIVE_MANDATE.maxLiveAccounts in src/risk/params.ts). Every account ` +
      "is exposed to the same bug in the same tick, and unwinding one is manual work — " +
      "so the number that can be affected at once is a decision, and raising it is a " +
      "commit. This address has never armed, so nothing it holds is unmanaged by this " +
      "refusal. An operator can arm it now by adding it to HL_LIVE_ACCOUNT, which does " +
      "not compete for these slots — but check `npm run preflight` first: an allowlisted " +
      "address is counted, so adding one takes the live count past the cap rather than " +
      "displacing anybody (`tasks/34`).",
    );
  }

  // The whole balance, deliberately. Everything that bounds the risk from here is a
  // fraction of this number, so it binds identically at any deposit.
  return {
    mode: "live",
    blocked: false,
    baseCapitalUsd: accountCapitalUsd,
    why: "DRY_RUN=false, this account is explicitly enabled, and it holds " +
      `$${accountCapitalUsd.toFixed(2)} — trading all of it, with at most ` +
      `$${maxDeployedUsd(accountCapitalUsd).toFixed(2)} deployed at once ` +
      `(the rest is the ${(RISK_PARAMS.reserveFrac * 100).toFixed(0)}% reserve) ` +
      `and a halt at $${(accountCapitalUsd * RISK_PARAMS.dailyLossPct).toFixed(2)} of loss in a day`,
  };
}
