import type { HaltKind } from "../types.ts";
import { RISK_PARAMS, maxConcurrentSignals, type UserSettings } from "./params.ts";

// How far a day can go: what one stopped-out position costs, and about how many of
// them reach the daily-loss halt. Pure arithmetic on the mandate and the user's three
// settings (`tasks/19` §2).
//
// One function, three readers. `checkCapConsistency` warns the operator at startup,
// the desk prints the same sentence to the account's owner, and the connect screen
// keeps its own copy of the multiplication (it recomputes on every slider drag and
// cannot round-trip for it) which `design/src/limits.test.ts` pins to this one. The
// warning an operator reads and the line the owner reads cannot disagree because they
// are the same number.

export type HaltDistance = {
  /** What one position that loses at its stop costs — or, with the stop off, its whole
   *  margin, which on isolated margin is the most any position can lose. In dollars,
   *  as a fraction of the mandate, and as a fraction of the position's own margin. */
  stopOut: { usd: number; ofMandate: number; ofMargin: number };
  /** About how many of those in one day reach the halt.
   *
   *  "About", deliberately. The count is arithmetic on the mandate; the halt is
   *  measured on equity, which fees, funding, partial fills, the per-asset stop clamp
   *  and every open position's unrealised P&L all move. The two are equal at connect
   *  and drift from the first trade. A whole number here would be a claim the
   *  executor does not make. */
  stopsToHalt: number;
  /** Where the halt sits today: `dailyLossPct` × the day's opening equity. Null until
   *  the first tick seeds the baseline — `Store.connectAccount` says why it is not
   *  seeded from the mandate. */
  haltAtUsd: number | null;
};

/** The share of a position's margin one stop-out costs. `stopPct × leverage` with a
 *  stop; the whole margin without one. Capped at 1: a 8% stop at 20× is 160% of the
 *  margin on paper and past liquidation on every real market, where the per-asset
 *  clamp (`docs/ACCOUNT-MODEL.md` §5) pulls it back under the liquidation distance —
 *  this figure does not know the market, so it states the most an isolated position
 *  can lose rather than a number the venue cannot produce. */
export function stopOutOfMargin(s: Pick<UserSettings, "stopLoss" | "stopPct" | "leverage">): number {
  return s.stopLoss ? Math.min(1, s.stopPct * s.leverage) : 1;
}

/** What one stopped-out position costs as a fraction of the **mandate**.
 *
 *  `stopOutOfMargin × perSignalPct`, times `(1 − reserveFrac)` since `tasks/21`,
 *  because `perSignalPct` is a fraction of the budget and the budget is the mandate
 *  less the reserve. Without that factor this figure and the connect screen's would
 *  disagree by the reserve on every number they both show — which is precisely what
 *  `design/src/limits.test.ts` exists to catch. */
export function stopOutOfMandate(s: UserSettings): number {
  return stopOutOfMargin(s) * s.perSignalPct * (1 - RISK_PARAMS.reserveFrac);
}

/** `dailyLossPct / (perSignalPct × stopPct × leverage)`, or `dailyLossPct /
 *  perSignalPct` with the stop off — the count the connect screen has always shown. */
export function stopsToHalt(s: UserSettings): number {
  return RISK_PARAMS.dailyLossPct / stopOutOfMandate(s);
}

/** The fraction of the mandate deployed as margin when the book is full.
 *
 *  `positions × perSignalPct` off the budget, so it lands just under 1 rather than on
 *  it — the reserve is the difference. It is not `maxDeployedPct` itself: at 15% per
 *  position six positions deploy 90% of the budget, not 100%, because `floor` leaves
 *  the remainder unused. */
export function deployedAtFullBook(s: Pick<UserSettings, "perSignalPct">): number {
  return maxConcurrentSignals(s) * s.perSignalPct * (1 - RISK_PARAMS.reserveFrac) * RISK_PARAMS.maxDeployedPct;
}

/** **Every open position stopping in the same move**, as a fraction of the mandate.
 *
 *  `tasks/21` §4's number, and the one that roughly doubled when `maxDeployedPct` went
 *  to 1.00. It is not a tail scenario dressed up: Quotient publishes in same-side
 *  batches and the ledger has all four live accounts opening two longs in one tick,
 *  twice on 2026-09-04 alone. The conservative assumption — every position moves
 *  together — is the right one to state, because nothing in the system caps
 *  correlation. (`tasks/21` §11: a real correlation cap is a different task, and it is
 *  the thing that would bound this number rather than describe it.) */
export function correlatedStopOfMandate(s: UserSettings): number {
  return deployedAtFullBook(s) * stopOutOfMargin(s);
}

export function haltDistance(s: UserSettings, baseCapital: number, dayStartEquity: number | null): HaltDistance {
  const ofMargin = stopOutOfMargin(s);
  const ofMandate = stopOutOfMandate(s);
  return {
    stopOut: { usd: baseCapital * ofMandate, ofMandate, ofMargin },
    stopsToHalt: stopsToHalt(s),
    haltAtUsd: dayStartEquity === null ? null : dayStartEquity * RISK_PARAMS.dailyLossPct,
  };
}

/** Sanity check on the cap set, run at startup and at every settings change.
 *
 *  Settings contradict each other easily: at 10% per signal, 10x and a 3% stop one
 *  stopped-out signal costs 3% of base, so a 5% daily cap would halt on the second
 *  ordinary loss. That was the shipped default until 2026-09-10, and both warnings
 *  below fired on every account on the day three of them hit the daily cap together.
 *
 *  **Neither fires at today's defaults, and the second one very nearly does.** At 10% per
 *  signal, 10x and the 2% stop shipped on 2026-09-12 a stop-out costs **1.98%** of the
 *  mandate and a full correlated book **19.8%** against a strict `> 2 × 10%` — so it
 *  passes by two tenths of a percentage point, and would fire on any stop wider than 2%.
 *  (It was 9.9% and 1.0× at the 1% default of 2026-09-10, and 29.7% at the 3% one.) The
 *  check is not thereby decorative: the site offers stops up to 8% and sizes up to 25%,
 *  and the two accounts that carried the desk's losses that day were at 8%/20% and
 *  4%/20%.
 *
 *  Lived in `params.ts` until `tasks/19`; moved here so it and the desk read one
 *  number. */
export const CORRELATED_STOP_WARN_MULTIPLE = 2;

export function checkCapConsistency(s: UserSettings): string[] {
  const warnings: string[] = [];
  const stops = stopsToHalt(s);
  if (stops < 2) {
    warnings.push(
      `dailyLossPct ${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% halts after ` +
      `${stops.toFixed(1)} stopped signals — that is one ordinary losing day, ` +
      "not a tail event. Raise the daily cap or lower perSignalPct.",
    );
  }
  if (s.perSignalPct > RISK_PARAMS.maxDeployedPct) {
    warnings.push("perSignalPct exceeds maxDeployedPct — no signal could ever fit.");
  }
  // What this replaced, and why. Until `tasks/21` this warned when
  // `maxConcurrentSignals × perSignalPct < maxDeployedPct` — that the count would bind
  // first and the deployed cap was dead. With the count derived as
  // `floor(1 / perSignalPct)` the two bind at the same point **by construction**, so
  // that warning can never fire again and a check that cannot fire is not a check.
  //
  // The number that now matters is the correlated stop, and it is deliberately loud:
  // it exceeds the daily halt at *every* setting the site offers, so a threshold
  // chosen to keep the log quiet would be a threshold chosen to hide the thing this
  // change did. 2× the halt (owner, 2026-09-04). ⚠ The sentence here used to say "the
  // 10x/3% default warns at 3×" and read as a statement about the shipped default; the
  // default has been 1% and then 2% since, and at 2% this sits at **1.98×** — under the
  // threshold, and the closest it has ever been to it without firing.
  const correlated = correlatedStopOfMandate(s);
  if (correlated > CORRELATED_STOP_WARN_MULTIPLE * RISK_PARAMS.dailyLossPct) {
    warnings.push(
      `a correlated stop-out of a full book costs ${(correlated * 100).toFixed(0)}% of the mandate, ` +
      `${(correlated / RISK_PARAMS.dailyLossPct).toFixed(1)}× the ` +
      `${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% daily halt — the halt stops new opens ` +
      "between ticks, it is not a stop-loss on the portfolio.",
    );
  }
  return warnings;
}

// ── Clearing a halt (`tasks/30` §1) ─────────────────────────────────────────
//
// **The one line that makes a Clear button a feature rather than the exploit
// `notes/2026-08-31-halt-survives-unlink.md` closed:** clear `halted`, never touch
// `day_start_equity` or `day`. `Store.clearHalt` is where that is enforced and this is
// where it is decided.
//
// The safety property does not depend on this function being right. With the baseline
// untouched, `haltCheck` re-halts on the next tick and `preTradeCheck` refuses every
// signal in between, so a clear can only *stick* when the condition has genuinely gone.
// What this adds is that the clear should not be **offered** in a state where it will
// visibly undo itself — three times an operator cleared halts early and watched them
// come back, and once (2026-09-10 22:23Z) a cleared account opened three losers in
// 35 minutes.

/** What the caller knows about the account it wants to un-halt. Every field is
 *  something a screen or an operator can already see; nothing here reads the venue. */
export type ClearInput = {
  actor: "owner" | "operator";
  kind: HaltKind | null;
  /** When the halt in force fired, ISO, or null when the ledger has no event for it. */
  haltedAt: string | null;
  /** `accounts.day` — the UTC day the baseline belongs to. */
  day: string | null;
  dayStartEquity: number | null;
  /** The most recent equity anybody has: the heartbeat's for the operator, the desk's
   *  own read for the owner. Null when nothing is reporting this account. */
  equityUsd: number | null;
  now: Date;
};

export type ClearVerdict =
  | { ok: true; note: string }
  | { ok: false; reason: string };

const utcDay = (d: Date | string): string =>
  (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/** Whether this halt can be cleared now, by this actor.
 *
 *  **Only a daily-loss halt is the owner's**, and that is the whole design rather than a
 *  caution. The content of a foreign-actor halt is *our position accounting can no
 *  longer be trusted*, and the account's owner is the one person who cannot verify it,
 *  since they are the second actor. A liquidation is not a second actor and our
 *  accounting is fine — but the risk machinery did not do its job, and somebody should
 *  look at that before the account trades again.
 *
 *  **And a daily-loss halt does not clear before 00:00Z.** `rollDay` rebaselines
 *  `day_start_equity` at the UTC boundary, so the condition is gone by construction
 *  after it and is *not* gone before it, whatever the screen currently shows: an
 *  unrealised recovery inside the day leaves the account free to lose another 10% of a
 *  baseline it has already spent. This is the rule `docs/LOG.md` records being learned
 *  three times. */
export function canClearHalt(i: ClearInput): ClearVerdict {
  // `== null`, not `=== null`. A **read-only** opener — the public web tier — does not
  // run `addMissingColumns`, so against a ledger an older executor wrote `SELECT *`
  // returns a row with no `halt_kind` key at all and the field is `undefined`. That is
  // the same fact as null and must produce the same answer; a strict check here read
  // every pre-migration halt as typed and offered to clear it.
  if (i.kind == null && i.actor === "owner") {
    return {
      ok: false,
      reason: "We cannot say which condition stopped this account: it halted before the desk " +
        "recorded the kind, and reading it back out of the sentence would be a guess. Message " +
        "us and we will clear it with you.",
    };
  }
  if (i.kind != null && i.kind !== "daily-loss" && i.actor === "owner") {
    return { ok: false, reason: OWNER_CANNOT_CLEAR[i.kind] };
  }
  if (i.kind != null && i.kind !== "daily-loss") {
    // The operator's to clear, after looking. There is no time rule on these: the
    // condition is not one that expires, so waiting for midnight would buy nothing.
    return { ok: true, note: `${i.kind} halt, cleared by an operator who looked at the account.` };
  }

  // From here: a daily-loss halt, or — for an operator only — an **untyped** one.
  //
  // Untyped is the state every halt on the desk was in the day this shipped, because a
  // `halt_kind` is written when the condition fires or when it is still true on a later
  // tick, and a daily-loss condition has gone by the time anybody clears it. Refusing
  // those would leave the hand `UPDATE` in place on exactly the halts this replaces. So
  // an untyped halt is cleared under the **strictest** rules available — the daily-loss
  // ones — which is the safe direction: applied to a foreign-actor halt they cost an
  // operator nothing, because that halt's own instant is days old and passes.
  const untyped = i.kind == null;
  const today = utcDay(i.now);
  if (i.haltedAt !== null && utcDay(i.haltedAt) === today) {
    return {
      ok: false,
      reason: `This halt fired today (${i.haltedAt}) and the daily cap is measured against ` +
        "today's opening equity, so the condition is still there — clearing it now re-halts on " +
        "the next tick. It clears after 00:00Z, when the baseline rolls. Cleared early on " +
        "2026-09-10 at 22:23Z, two accounts re-halted at 14.4% and 15.2%, and a third opened " +
        "three losers in 35 minutes.",
    };
  }
  if (i.day !== null && i.day !== today) {
    return {
      ok: false,
      reason: `This account's day baseline is still ${i.day} and today is ${today}, so nothing ` +
        "has rolled it — which means nothing is ticking this account. Clearing the halt would " +
        "not bring it back. Find out why it is not being managed first.",
    };
  }
  if (i.equityUsd !== null && i.dayStartEquity !== null && i.dayStartEquity > 0) {
    const loss = (i.dayStartEquity - i.equityUsd) / i.dayStartEquity;
    if (loss >= RISK_PARAMS.dailyLossPct) {
      return {
        ok: false,
        reason: `The account is still ${(loss * 100).toFixed(1)}% below today's opening equity ` +
          `($${i.equityUsd.toFixed(2)} against $${i.dayStartEquity.toFixed(2)}), past the ` +
          `${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% cap. The next tick would re-halt it.`,
      };
    }
    return {
      ok: true,
      note: untypedNote(untyped) +
        `Looked first: $${i.equityUsd.toFixed(2)} against a $${i.dayStartEquity.toFixed(2)} ` +
        `baseline for ${today}, ${(loss * 100).toFixed(1)}% down on the day.`,
    };
  }
  return {
    ok: true,
    note: untypedNote(untyped) +
      "⚠ Cleared without an equity to check it against — nothing is reporting this account, " +
      "so whether the condition has gone was not verified here. The next tick re-halts if it " +
      "has not.",
  };
}

const untypedNote = (untyped: boolean): string => untyped
  ? "The kind was not recorded — this halt predates the column — so the daily-loss rules were " +
    "applied, which are the strictest. "
  : "";

/** Why the owner is not offered the button, in their terms. One sentence per kind, and
 *  the screen shows it instead of a disabled control with no explanation. */
const OWNER_CANNOT_CLEAR: Record<Exclude<HaltKind, "daily-loss">, string> = {
  "foreign-position":
    "Someone else traded on this account, so we stopped. That is the one thing you cannot " +
    "confirm for us from here, because you are the other person who can trade it — message us " +
    "and we will look at it with you.",
  "foreign-order":
    "There is an order on this account that we did not place, so we stopped. Message us and we " +
    "will look at it with you.",
  liquidation:
    "Hyperliquid closed one of your positions out itself, which means the stop we placed did not " +
    "fill in time. That is ours to look at before the account trades again — message us.",
  operator:
    "The desk is paused by an operator, for every account rather than just yours. It resumes " +
    "when that is lifted; nothing about your account is wrong.",
};
