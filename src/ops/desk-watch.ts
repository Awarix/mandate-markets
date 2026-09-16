import { DESK_WATCH } from "../risk/params.ts";
import type { Store } from "../store/db.ts";

// `tasks/47` Rule 5's watcher list, the two entries the owner added on 2026-09-12.
//
// `notes/2026-09-12-the-four-accounts-after-the-screenshot.md` followed the four funded
// accounts through 09-10 and found two things no cap in this repository can see. At 17:25Z
// **all four held the identical book** — SILVER long, AAPL short, NATGAS short, COPPER
// long — and three of them halted **within six minutes** of each other.
//
// The owner's decision that day was **no concentration cap**: accounts run different
// settings, so one position is a different share of every book and a cap would bind
// arbitrarily. What was asked for instead is that somebody be told. So both of these
// report; neither refuses anything, and neither writes a constant.
//
// ⚠ **The thresholds are in `DESK_WATCH`, not `RISK_PARAMS`, and that is load-bearing.**
// Nothing here sizes, gates or exits; putting an alarm threshold into one of the five
// fingerprinted objects would move `configHash` on deploy, write a `config` event, and —
// because the block accumulating for `docs/STATUS.md` item 1 already holds one — make that
// reading unscoreable. A watcher that costs a reading to install is the wrong watcher.

/** **Distinct accounts halted in the last M minutes.**
 *
 *  Distinct, not rows: one account halting, being cleared and halting again is a different
 *  story, and it already has its own alert. Read from the ledger's `events`, which is where
 *  `tick()` writes a halt the moment it fires — so the window is the real one and not the
 *  gap between two watchdog runs.
 *
 *  Fails to **zero** on a read it cannot make. An alarm that fires because a query threw
 *  is an alarm that gets muted, and the halt itself already alerts by another path. */
export function haltsInWindow(store: Store, windowMin: number, nowMs: number): number {
  try {
    const from = new Date(nowMs - windowMin * 60_000).toISOString();
    const r = store.db.prepare(
      "SELECT COUNT(DISTINCT account) AS n FROM events WHERE kind = 'halt' AND at >= ?",
    ).get(from) as unknown as { n: number } | undefined;
    return r === undefined ? 0 : Number(r.n);
  } catch {
    return 0;
  }
}

/** Whether the burst alarm should be firing, and the sentence it carries.
 *
 *  Pure, so the threshold is argued in a unit test rather than against a live desk. */
export function haltBurst(i: { halts: number; windowMin: number; accounts: number }): {
  firing: boolean; message: string;
} {
  const firing = i.halts >= DESK_WATCH.haltCount;
  return {
    firing,
    message:
      `${i.halts} of ${i.accounts} account(s) halted inside ${i.windowMin} minutes.\n` +
      "That is the 2026-09-10 shape: three accounts halted within six minutes of each other, " +
      "holding the same four positions, and nothing said so at the time.\n" +
      "Each halt has its own alert and its own reason; this one is about them arriving together, " +
      "which means one book rather than three accounts having a bad day.\n" +
      "Nothing is capped and nothing has changed — `npm run unhalt -- list` is what to read next.",
  };
}

// ── `tasks/47` Rule 5 / step 7: the default's cohort tripwire — **alert only** ────
//
// Item 29b, decided 2026-09-13: *no self-revert.* The threshold and the duration still
// fire, Telegram still says which cohort is behind and by how much, and the revert is a
// commit a person merges. The deciding argument was not that acting is risky — a default
// reaches nobody's open position and nobody's chosen setting — but **consistency**:
// `tasks/43` §2's σ watcher shipped the same day under the rule *"nothing writes a
// constant; the alarm names the commit"*, and a desk with one rule for gate constants and
// another for defaults has two rules to remember at the moment it is least able to.
//
// ⚠ What is given up is §4's *"this needs no person"*: a bad default keeps reaching new
// connects until somebody reads Telegram.

export type CohortRead = {
  /** Distinct events in this cohort's half of the block. */
  n: number;
  /** Mean per-signal **price** return — the unit that does not move when a new account is
   *  funded, which is the whole reason a cohort comparison is possible at all
   *  (`tasks/46` §1.1). */
  priceRet: number;
};

export type CohortVerdict = {
  /** Null when it scored. A sentence when it refused — and *cannot score* and *they are
   *  the same* are different claims, which is the one thing a tripwire must never confuse.
   *  Same shape as `feed-sigma`'s refusal, deliberately. */
  refusal: string | null;
  firing: boolean;
  /** Changed minus control, in percentage points of price return per signal. Null when
   *  it refused. */
  gapPP: number | null;
  message: string;
};

/** Is the cohort that met the new default doing worse than the one that did not?
 *
 *  Pure. Both halves come in as already-collapsed reads, so the threshold is argued in a
 *  unit test rather than against a live ledger.
 *
 *  ⚠ **It refuses below `DESK_WATCH.cohortFloor` on either side.** The block accumulating
 *  today holds 7 events across every account there is, so a cohort split of it would put
 *  single digits on each side and the difference of two such means is noise with a sign.
 *  Printing that as a tripwire reading would be worse than printing nothing, because it
 *  would look like evidence. */
export function cohortTripwire(i: {
  changed: CohortRead;
  control: CohortRead;
  /** Percentage points of price return the changed cohort may sit behind the control
   *  before this fires. */
  thresholdPP: number;
  /** What moved, and when — for the sentence. */
  what: string;
  since: string;
}): CohortVerdict {
  const floor = DESK_WATCH.cohortFloor;
  if (i.changed.n < floor || i.control.n < floor) {
    return {
      refusal:
        `${i.changed.n} event(s) in the changed cohort and ${i.control.n} in the control, against a floor of ` +
        `${floor} on each side — the difference of two means that small is noise with a sign, and printing ` +
        "it as a reading would look like evidence",
      firing: false,
      gapPP: null,
      message:
        `cohort tripwire for ${i.what} (since ${i.since}): NOT SCORED. ` +
        `${i.changed.n} changed / ${i.control.n} control, floor ${floor} each.`,
    };
  }
  const gapPP = (i.changed.priceRet - i.control.priceRet) * 100;
  const firing = gapPP <= -i.thresholdPP;
  const signed = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  return {
    refusal: null,
    firing,
    gapPP,
    message: firing
      ? `The cohort that met ${i.what} is behind the one that did not.\n` +
        `changed: ${signed(i.changed.priceRet)} per signal in price over ${i.changed.n} event(s)\n` +
        `control: ${signed(i.control.priceRet)} over ${i.control.n}\n` +
        `gap: ${gapPP.toFixed(2)}pp, against a ${i.thresholdPP.toFixed(2)}pp threshold, since ${i.since}.\n\n` +
        "NOTHING HAS CHANGED and nothing here writes a constant (item 29b: alert only). " +
        "The revert is a commit somebody merges, and it reaches NEW CONNECTS only — no open " +
        "position and no chosen setting moves with it."
      : `cohort tripwire for ${i.what}: changed ${signed(i.changed.priceRet)} (n=${i.changed.n}) vs ` +
        `control ${signed(i.control.priceRet)} (n=${i.control.n}), gap ${gapPP.toFixed(2)}pp — inside the ` +
        `${i.thresholdPP.toFixed(2)}pp threshold.`,
  };
}
