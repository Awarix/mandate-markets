import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { BUILDER_FEE, DEFAULT_USER_SETTINGS, LIVE_MANDATE, RISK_PARAMS } from "../risk/params.ts";
import { SITE_OFFERS } from "../web/discovery.ts";
import { excludeSyntheticSql } from "../store/synthetic.ts";
import type { Store } from "../store/db.ts";

// `tasks/47` Rule 1, write half: **the ledger records every change to a money
// constant, and it records the instant rather than reconstructing it.**
//
// Between 2026-09-10 08:18Z and 2026-09-11 10:45Z the desk moved `minDisplacementSigma`
// twice, the stop default once and the re-entry rule once, admitted seven accounts, and
// then read a per-signal figure off the result. The `events` table has **no row for any
// of the constants**: every one of those instants had to be recovered afterwards from
// `journalctl` and a deploy log, which is the reconstruction `src/risk/regimes.ts`
// already warns against doing. `npm run expectancy` learned to refuse a block holding
// two `config` events on 2026-09-12 (`tasks/47` step 4), deliberately ahead of the
// writer, and has printed `0 config` inside every block since — because there was
// nothing writing them. This is the writer.
//
// **What is hashed is what bounds money**, not the whole module: `RISK_PARAMS` (our
// caps and the gate), `DEFAULT_USER_SETTINGS` (what the next stranger connects on),
// `LIVE_MANDATE` (how many accounts trade live at all), `BUILDER_FEE` (what they pay)
// and `SITE_OFFERS` (the range they may choose inside). Five objects.
//
// ⚠ **The leaf count is printed at boot rather than written here.** This comment said
// *"42 leaves"* from the day the writer shipped, and the real count was **43** at that
// very commit — the wrong number then travelled into `tasks/47`, `docs/STATUS.md`,
// `notes/README.md` and the findings note, where a reader checking *"is everything
// covered?"* would have compared against it. A count is a fact about the code and belongs
// in the output, where it is recomputed every boot and cannot rot.
//
// ⚠ **The git SHA the task asked for is not here, and the reason is the deploy.**
// `deploy/server-cmds.md` rsyncs with `--exclude=.git`, so there is no repository on the
// box to ask and `git rev-parse` would fail on the one machine this runs on. What is
// recorded instead is the hash of the constants themselves, which is the better
// identity for this purpose anyway: two commits that leave every one of these values
// alone are the same desk, and the block they trade in is not divided. Joining a change
// to the pull request that argued it is `tasks/47` Rule 4's practice, step 8, and it
// belongs in the detail a person writes rather than in a field this can fabricate.

/** One leaf per line, `path = json`, sorted. The wire format for both the hash and the
 *  diff, and it is deliberately human-readable: the thing a person reads in the ledger
 *  and the thing the hash covers must be the same bytes, or the diff can disagree with
 *  the refusal it triggers. */
export function configValues(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (path: string, v: unknown): void => {
    // An array is a leaf. `tradedDexes` and `SITE_OFFERS.leverage` are sets of choices,
    // and `["5","10","18"] -> ["5","10","18","20"]` is one change to report, not four.
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      out[path] = JSON.stringify(v);
      return;
    }
    for (const k of Object.keys(v as object).sort()) walk(`${path}.${k}`, (v as Record<string, unknown>)[k]);
  };
  for (const [name, obj] of Object.entries({
    RISK_PARAMS, DEFAULT_USER_SETTINGS, LIVE_MANDATE, BUILDER_FEE, SITE_OFFERS,
  })) walk(name, obj);
  return out;
}

/** Twelve hex characters of SHA-256 over the sorted leaves. Long enough that a
 *  collision is not a thing that happens, short enough to read in a log line. */
export function configHash(values: Record<string, string>): string {
  const canonical = Object.keys(values).sort().map((k) => `${k} = ${values[k]}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 12);
}

/** What moved, in the order the constants are declared in. Pure, and it is the sentence
 *  the ledger keeps: `minDisplacementSigma 1 -> 0.5`.
 *
 *  A constant that appears or disappears is reported too — as `(unset)` on the side it
 *  is missing from — because adding a cap and removing one are both changes to what
 *  bounds money, and a diff that only compares shared keys is silent about exactly the
 *  changes nobody is expecting. */
export function diffConfig(prev: Record<string, string>, next: Record<string, string>): string[] {
  const keys = [...new Set([...Object.keys(prev), ...Object.keys(next)])].sort();
  const lines: string[] = [];
  for (const k of keys) {
    const a = prev[k];
    const b = next[k];
    if (a === b) continue;
    lines.push(`${k} ${a ?? "(unset)"} -> ${b ?? "(unset)"}`);
  }
  return lines;
}

export type ConfigSnapshot = {
  at: string;
  hash: string;
  values: Record<string, string>;
  /** The desk **before** the change this snapshot records — what the last `config` event
   *  superseded. Null after a first boot, which recorded no move.
   *
   *  Kept because the speed limit's whole question is *"may this value move back?"*, and
   *  answering it from the event's prose (`minDisplacementSigma 1 -> 0.5`) would mean
   *  parsing our own log line to decide whether to trade — the fuzzy match `CLAUDE.md`
   *  forbids for a vendor's symbol, applied to ourselves. One generation is enough: the
   *  rule allows a revert, and a revert is one step.
   *
   *  ⚠ **Null only on a file written before 2026-09-14.** A first boot now records itself
   *  as its own predecessor (`tasks/50` §2.2): the alternative left the limit unarmed for
   *  one more change while `expectancy` already counted the first-boot event, so the next
   *  change on the box would have been unrefused *and* would have made the block
   *  unscoreable — the worst of both, and the opposite of what `CLAUDE.md` says happens. */
  previous: { at: string; hash: string; values: Record<string, string> } | null;
  /** **The refusal this desk is under, if any** (`tasks/50` §2.1).
   *
   *  `speedHalt` was a local in `runner.ts` and the snapshot was rewritten even when the
   *  limit refused — deliberately, so a second boot would not refuse a change that is
   *  already running. The two together meant the second boot read `changed = false` and
   *  came up **unhalted with no override recorded**, and `deploy/signaldesk-exec.service`
   *  has `Restart=always`. So the refusal `tasks/47` §5.1 priced as *"boot, read the hash,
   *  set it, boot again"* was cleared by a crash, a deploy or a reboot.
   *
   *  Written when the limit refuses and carried until somebody acts: an override naming
   *  this hash, or the constants moving again in a way the limit allows (a revert is
   *  one). **A halted desk cannot clear it by waiting** — it opens nothing, so no new
   *  event closes and the block it is measured against does not grow. That is the
   *  intended shape and it is the strongest thing in this file: a desk under a standing
   *  refusal manages every exit and opens nothing until a person says the hash. */
  refused?: { at: string; hash: string; reason: string } | null;
};

/** The last boot's snapshot, or null when there has never been one.
 *
 *  A file under `DATA_ROOT`, beside the heartbeat and the alert state, and for the same
 *  reason: it is per-box runtime state that the repository must not carry. Losing it
 *  costs one `config` event reading *first boot* — an honest answer, and the only one
 *  available, since a snapshot that does not exist cannot be diffed against. */
export function readSnapshot(path: string): ConfigSnapshot | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ConfigSnapshot>;
    if (typeof raw.hash !== "string" || typeof raw.values !== "object" || raw.values === null) return null;
    const p = raw.previous;
    const r = raw.refused;
    return {
      at: String(raw.at ?? ""),
      hash: raw.hash,
      values: raw.values as Record<string, string>,
      // A file written before `previous` existed reads as null, which is the honest
      // answer: we do not know what the desk was before it, so the speed limit cannot
      // claim a move is a revert and lets the change through. It arms itself one change
      // later, and says which state it is in.
      previous: p && typeof p.hash === "string" && p.values && typeof p.values === "object"
        ? { at: String(p.at ?? ""), hash: p.hash, values: p.values as Record<string, string> }
        : null,
      // Same defensiveness: a file from before this field existed, or one whose refusal
      // is half-written, reads as no refusal. The failure direction is a desk that comes
      // up trading, so the field is written before the process that would act on it can
      // be restarted — `writeSnapshot` is one `writeFileSync` of the whole object.
      refused: r && typeof r.hash === "string" && typeof r.reason === "string"
        ? { at: String(r.at ?? ""), hash: r.hash, reason: r.reason }
        : null,
    };
  } catch {
    return null;
  }
}

export function writeSnapshot(path: string, snap: ConfigSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);
}

export type ConfigReport = {
  hash: string;
  /** True when this boot's constants differ from the last boot's, or when there was no
   *  last boot. */
  changed: boolean;
  /** True when there was nothing to compare against. No constant moved; we simply
   *  cannot say that it did not. */
  first: boolean;
  lines: string[];
  /** Rule 4's speed limit. `ok: false` arms the global halt for this process: every
   *  account keeps its exits and its halt checks and opens nothing. */
  speed: SpeedVerdict;
};

/** The sentence the `events` row carries. Kept out of the writer so a test can read it
 *  without a ledger, and so the log line and the ledger row are the same words. */
export function configDetail(r: ConfigReport): string {
  if (r.first) {
    return `first boot with change tracking: money constants at ${r.hash}. ` +
      "Nothing moved — there was no previous fingerprint to compare against, which is " +
      "not the same statement and this block should be read as starting here.";
  }
  return `money constants ${r.hash}: ${r.lines.join("; ")}`;
}

// ── `tasks/47` Rule 4, third part: a constant that moved inside the last block may
//    only move back ────────────────────────────────────────────────────────────────
//
// Between 2026-09-10 08:18Z and 2026-09-11 10:45Z the desk moved `minDisplacementSigma`
// twice — 0.5 → 1.0 on a written pre-commitment, then 1.0 → 0.5 twelve hours later,
// reversing it — moved the stop default, and shipped the re-entry block. Four changes in
// twenty-six hours, and the reading that followed could attribute none of them. The
// reversal was found the next afternoon by a hand query.
//
// **The unit is `SAMPLE_FLOOR` events, and that is the owner's decision of 2026-09-13**
// (`tasks/47` §5.1). The alternative offered was a fixed number of days; events won
// because it is the unit `npm run expectancy` already refuses a block on, so the speed
// limit and the reading cannot disagree about what a block is. It is ~7.5 days at the
// 4.0 events/day the feed yields today and ~2 days at `reverted`'s 15.1 — **tighter
// exactly when the feed is quiet**, which is when a reading has least power. ⚠ The cost
// taken with it: a famine like 09-04 freezes every constant for as long as it lasts. A
// 14-day ceiling was offered and declined.
//
// ── What it does when it fires, and why it is not a refusal to boot ───────────────
//
// `tasks/47` says the check "fails a boot check". **It must not exit the process**, and
// the reason is the one this repository is arranged around: on a restart the runner
// cancels our exposure-opening orders and leaves the reduce-only exits resting, so a
// desk that will not come back up keeps its stops and loses everything else — the
// signal-change exit, the horizon close, foreign-actor detection and the daily-loss
// halt. That is `docs/STATUS.md` item 20's failure induced on purpose, to protect a
// property of the *analysis*. Money safety outranks readability here and is not close.
//
// So a breach arms the **global halt** instead, which already means precisely the right
// thing: every account stops opening, every exit stays managed, and `tick()` checks it
// before `considerSignals` rather than after, so not one signal slips through on the
// first pass. The desk is then live, protected, and taking no new position under a
// constant nobody can attribute — which is the whole of what the rule was protecting.
// It clears by setting the override and restarting, or by putting the constant back.

/** One block, in distinct tradeable events. The same floor `npm run expectancy` refuses
 *  a reading under, imported nowhere because that file is a script: the number is the
 *  decision and it is stated in both places with the same name. */
export const SAMPLE_FLOOR = 30;

export type SpeedVerdict = {
  /** True when this boot may trade on these constants without an override. */
  ok: boolean;
  /** Set when `ok` is false: the sentence the halt, the log line and Telegram all carry. */
  reason: string;
  /** True when an override was present and honoured. The change went through *and* it is
   *  recorded that somebody said so. */
  overridden: boolean;
  /** Events counted since the last `config` event, or null when there was none to count
   *  from. */
  eventsInBlock: number | null;
};

/** May this desk trade on constants that just moved?
 *
 *  Pure. The event count and the override come in as values, so the rule is decided in a
 *  unit test rather than against a ledger and an environment.
 *
 *  **A change is allowed when any of these holds**, and the reason says which:
 *
 *  - nothing moved (the ordinary restart);
 *  - there is no previous change to be inside the block of — a first boot, or a
 *    fingerprint file written before this rule existed;
 *  - `SAMPLE_FLOOR` events have closed since the last change, so the block is complete
 *    and the last change has been read;
 *  - **every** leaf that moved moved *back* to the value the last change superseded;
 *  - an override names this exact desk.
 *
 *  Otherwise it is a second change inside one block, which is mechanism 3 of `tasks/47`
 *  §1 — *changes stacked inside one block* — and the reason the 09-11 reading could
 *  attribute nothing. ⚠ **Note what that refuses: not only the same constant moving
 *  twice, but a different constant moving beside it.** 09-10 stacked σ, the stop default
 *  and the re-entry block, and it is the stacking rather than any one of them that cost
 *  the attribution. A deliberate stack is one environment variable away. */
export function speedLimit(i: {
  changed: boolean;
  /** The desk as it is booting. */
  next: Record<string, string>;
  /** The last recorded state, and the one before it. Null when there has never been a
   *  snapshot. */
  snapshot: ConfigSnapshot | null;
  /** Distinct settled events opened since `snapshot.at`. Null when it could not be
   *  counted — a missing ledger, a query that threw. */
  eventsInBlock: number | null;
  /** `process.env.CONFIG_OVERRIDE`, verbatim. */
  override: string | undefined;
  /** This boot's hash, which a valid override must equal. */
  hash: string;
}): SpeedVerdict {
  const n = i.eventsInBlock;
  if (!i.changed) {
    // ── `tasks/50` §2.1: the refusal an earlier boot recorded ──────────────────
    //
    // Nothing moved *since the last boot*, and that is exactly the state a refused desk
    // restarts into — the snapshot is written even when the limit refuses, so the change
    // is already the recorded one. Reading `changed = false` as "nothing to check" is
    // what let `Restart=always` clear the halt. The refusal is pinned to the hash it was
    // issued against, so a desk whose constants have since moved is decided afresh below.
    const standing = i.snapshot?.refused;
    if (standing && standing.hash === i.hash) {
      if (i.override !== undefined && i.override.trim() === i.hash) {
        return {
          ok: true, overridden: true, eventsInBlock: n,
          reason: `CONFIG_OVERRIDE=${i.hash} honoured: the speed limit's refusal of ${standing.at} is cleared `
            + "and the desk opens positions again. What it refused: " + standing.reason,
        };
      }
      return {
        ok: false, overridden: false, eventsInBlock: n,
        reason: `the speed limit refused this desk at ${standing.at} and nothing has moved since — a restart `
          + "does not clear it (tasks/50 §2.1). " + standing.reason,
      };
    }
    return { ok: true, reason: "", overridden: false, eventsInBlock: n };
  }
  if (i.snapshot === null || i.snapshot.previous === null) {
    return {
      ok: true, overridden: false, eventsInBlock: n,
      reason: "",
    };
  }
  // The block is complete: the last change has had a readable run and this one starts a
  // new block rather than stacking inside the old one.
  if (n !== null && n >= SAMPLE_FLOOR) {
    return { ok: true, reason: "", overridden: false, eventsInBlock: n };
  }

  const prev = i.snapshot.values;
  const before = i.snapshot.previous.values;
  const moved = diffConfig(prev, i.next);
  // A revert is every moved leaf landing back on the value the last change superseded.
  // Partial reverts are refused: half of 09-10 put back is a third desk, not the second.
  const notReverts = Object.keys({ ...prev, ...i.next })
    .filter((k) => prev[k] !== i.next[k])
    .filter((k) => before[k] !== i.next[k]);
  if (notReverts.length === 0) {
    return {
      ok: true, overridden: false, eventsInBlock: n,
      reason: "",
    };
  }

  if (i.override !== undefined && i.override.trim() === i.hash) {
    return {
      ok: true, overridden: true, eventsInBlock: n,
      reason: `CONFIG_OVERRIDE=${i.hash} honoured: ${moved.length} constant(s) moved inside a block holding `
        + `${n === null ? "an uncounted number of" : n} event(s), and somebody on the box said so.`,
    };
  }

  const counted = n === null
    ? "the events since it could not be counted (no ledger, or the query failed), which is read as zero"
    : `${n} event(s) have closed since — the block needs ${SAMPLE_FLOOR}`;
  return {
    ok: false, overridden: false, eventsInBlock: n,
    reason:
      `a money constant moved inside an unfinished block. The last change was ${i.snapshot.at} and `
      + `${counted}. Moving now stacks two changes in one block, which is what made 2026-09-11 `
      + `unattributable — four changes in twenty-six hours and a reading that could separate none of `
      + `them. What moved: ${moved.join("; ")}. `
      + `${notReverts.length} of them ${notReverts.length === 1 ? "is" : "are"} not a move back to the `
      + `value the last change superseded (${notReverts.join(", ")}). `
      + `THE DESK IS LIVE AND HALTED FOR OPENING: every exit, halt check and foreign-actor check still `
      + `runs and every venue-side stop is still resting; no new position opens. `
      + `To proceed deliberately, set CONFIG_OVERRIDE=${i.hash} and restart. To undo, put the constant `
      + `back and restart. (tasks/47 Rule 4)`,
  };
}

/** **Has the default in force had a block of trades behind it?** `tasks/47` Rule 4, first
 *  part — the other half of the speed limit, read by the connect path rather than by the
 *  executor's boot.
 *
 *  True when there is no recorded change at all (nothing is untested if nothing moved),
 *  and when `SAMPLE_FLOOR` events have closed since the last one. False only in the
 *  window between a `config` event and its block completing — which is when a new cohort
 *  meeting the new default would destroy the control, as it did on 2026-09-10.
 *
 *  ⚠ **Reads the ledger's own `events` table, not the fingerprint file.** The web tier has
 *  no `DATA_ROOT` fingerprint of its own and must not grow one: two processes keeping
 *  separate copies of "when did the desk last change" is how they come to disagree. The
 *  executor writes the row; this reads it.
 *
 *  Fails **open** — a ledger it cannot read returns true and a new connection meets the
 *  shipped default. That is the smaller error: the alternative is a read failure quietly
 *  seeding strangers with a value nobody chose. */
export function defaultBlockComplete(store: Store, count = countEventsSince(store)): boolean {
  try {
    const r = store.db.prepare(
      "SELECT at FROM events WHERE kind = 'config' ORDER BY at DESC LIMIT 1",
    ).get() as unknown as { at: string } | undefined;
    if (r === undefined) return true;
    const n = count(r.at);
    return n === null ? true : n >= SAMPLE_FLOOR;
  } catch {
    return true;
  }
}

/** The account column on a desk-wide event.
 *
 *  Every other `events` row belongs to one account. A constant reaches all of them at
 *  once, which is the whole reason it is the change that needs recording — so it is
 *  written against a name that is not an address and cannot collide with one. */
export const DESK = "desk";

export type ConfigEventDeps = {
  store: Store;
  /** `data/config-fingerprint.json` in production. */
  path: string;
  log: (m: string) => void;
  notify?: (m: string) => Promise<unknown>;
  now?: Date;
  /** Distinct settled events opened since an instant — the block the speed limit
   *  measures. A dependency so this file owns no SQL and the rule stays testable; the
   *  runner passes `countEventsSince(store)`. Returning null means *could not count*,
   *  which the limit reads as zero rather than as clear. */
  countEventsSince?: (iso: string) => number | null;
  /** `process.env.CONFIG_OVERRIDE`. Passed in rather than read here so a test never
   *  touches the environment of the process running it. */
  override?: string | undefined;
};

/** Distinct settled events opened since an instant, the way `expectancy` counts one.
 *
 *  **Opened after, not closed after**: a trip that opened before the change was traded
 *  under the old constants and is evidence about them, however late it closed. And
 *  **settled**, because an open position is not yet evidence about anything — which is
 *  also what makes this number move only as trades resolve, so a stalled desk cannot
 *  wait out the speed limit by doing nothing. */
export function countEventsSince(store: Store): (iso: string) => number | null {
  return (iso: string) => {
    try {
      const r = store.db.prepare(
        `SELECT COUNT(DISTINCT signal_ref) AS n FROM intents
         WHERE status = 'closed' AND net_pnl IS NOT NULL AND created_at >= ?
           AND ${excludeSyntheticSql("intent_id")}`,
      ).get(iso) as unknown as { n: number } | undefined;
      return r === undefined ? null : Number(r.n);
    } catch {
      return null;
    }
  };
}

/** Compare this boot's money constants to the last boot's; record the difference.
 *
 *  Called once at startup, before any account connects, so the event's timestamp is the
 *  instant the desk began trading on the new value and not some point after it. Writes
 *  nothing when nothing moved, which is the ordinary case on a restart — an `events`
 *  table with a row per deploy would drown the rows that matter, and `expectancy`
 *  refuses a block on the **count** of these. */
export async function recordConfigChange(d: ConfigEventDeps): Promise<ConfigReport> {
  const now = d.now ?? new Date();
  const values = configValues();
  const hash = configHash(values);
  const prev = readSnapshot(d.path);
  const changed = prev === null || prev.hash !== hash;
  const speed = speedLimit({
    changed, next: values, snapshot: prev, hash, override: d.override,
    // Counted only when it can matter. The query is cheap, but a restart that moved
    // nothing is nearly every restart and should touch nothing.
    eventsInBlock: changed && prev !== null && d.countEventsSince
      ? d.countEventsSince(prev.at)
      : null,
  });
  const report: ConfigReport = {
    hash,
    changed,
    first: prev === null,
    lines: prev === null ? [] : diffConfig(prev.values, values),
    speed,
  };

  if (!report.changed) {
    d.log(`money constants unchanged at ${hash}, ${Object.keys(values).length} leaves (since ${prev?.at ?? "?"})`);
    // ── `tasks/50` §2.2: arm the limit on a file that predates the rule ────────
    //
    // A first boot used to record `previous: null`, and `speedLimit` passes anything when
    // it is null — so the box that booted 2026-09-13 would have let its next change
    // through unrefused while `expectancy` counted the first-boot event against the
    // block. Seeding `previous` when the constants are written is only half the repair:
    // the live box's file already says null and an unchanged boot writes nothing, so it
    // would have stayed unarmed until something moved. This upgrades it in place. No
    // event, no constant, nothing moved — the desk before this change *is* the one
    // recorded, which is what the field now says.
    if (prev !== null && prev.previous === null) {
      writeSnapshot(d.path, {
        at: prev.at, hash: prev.hash, values: prev.values,
        previous: { at: prev.at, hash: prev.hash, values: prev.values },
        refused: prev.refused ?? null,
      });
      d.log(`config fingerprint upgraded: it recorded no predecessor, so the speed limit could not have `
        + `refused the next change. It is now its own predecessor as of ${prev.at} (tasks/50 §2.2).`);
    }
    // A refusal an earlier boot recorded, or the override that clears it.
    if (speed.overridden) {
      writeSnapshot(d.path, {
        at: prev?.at ?? now.toISOString(), hash, values,
        previous: prev?.previous ?? { at: prev?.at ?? now.toISOString(), hash, values },
        refused: null,
      });
      d.store.recordEvent(DESK, "config-override", speed.reason, now);
      d.log(`CONFIG-OVERRIDE ${speed.reason}`);
      if (d.notify) await d.notify(`⚠️ SignalDesk · speed limit overridden\n${speed.reason}`);
      return report;
    }
    if (!speed.ok) {
      // Logged every boot and recorded once. A second `config-refused` row per restart
      // would turn a crash loop into a wall of identical rows in the one table a reading
      // reads, and the row that matters — the boot that refused — is already there.
      d.log(`CONFIG-REFUSED (standing) ${speed.reason}`);
    }
    return report;
  }

  const detail = configDetail(report);
  d.store.recordEvent(DESK, "config", detail, now);
  // Written after the event, so a crash between them rescans rather than forgets: the
  // next boot would re-diff against the old snapshot and write the row again, which is
  // a duplicate somebody can see. The other order loses the row silently.
  //
  // ⚠ **The snapshot is written even when the speed limit refuses**, and it has to be.
  // The change is what the desk is running — the constants are compiled in and this file
  // cannot un-deploy them — so the ledger must say so, and the halt is what makes the
  // refusal real. Not writing it would leave the next boot diffing against a desk that
  // stopped existing, and the second restart would refuse for a reason that had already
  // been handled.
  writeSnapshot(d.path, {
    at: now.toISOString(), hash, values,
    // **A first boot is its own predecessor** (`tasks/50` §2.2), not a null: the block
    // this event opens is the one `expectancy` is already counting it against, so the
    // next change is inside it and the limit has to be able to say so. The old null made
    // the two halves of Rule 1 disagree about the same boot.
    previous: prev === null
      ? { at: now.toISOString(), hash, values }
      : { at: prev.at, hash: prev.hash, values: prev.values },
    // The refusal, so the next boot meets it (`tasks/50` §2.1). Cleared by any change the
    // limit allows — putting the constant back is one — because the reason it records has
    // stopped describing the desk.
    refused: speed.ok ? null : { at: now.toISOString(), hash, reason: speed.reason },
  });
  d.log(`CONFIG ${detail}`);
  if (speed.overridden) {
    d.store.recordEvent(DESK, "config-override", speed.reason, now);
    d.log(`CONFIG-OVERRIDE ${speed.reason}`);
    if (d.notify) await d.notify(`\u26a0\ufe0f SignalDesk · speed limit overridden\n${speed.reason}`);
  }
  if (!speed.ok) {
    d.store.recordEvent(DESK, "config-refused", speed.reason, now);
    d.log(`CONFIG-REFUSED ${speed.reason}`);
    if (d.notify) {
      await d.notify(
        `\ud83d\udd34 SignalDesk · the speed limit fired — no account opens a position\n\n${speed.reason}`,
      );
    }
  }
  if (report.first && d.notify) {
    // ⚠ **A first boot is also how a standing refusal disappears** (`tasks/50` §2.1): the
    // refusal lives in the fingerprint file, so deleting or corrupting that file is a
    // desk that comes up trading with no memory of having been halted. The file is under
    // `DATA_ROOT` and losing it already costs the block boundary, but until 2026-09-14
    // this case sent nothing at all — the one boot where the desk cannot say what it was
    // running yesterday was the one boot nobody was told about.
    await d.notify(
      `⚙️ SignalDesk · first boot with change tracking\nMoney constants ${hash}, ` +
      `${Object.keys(values).length} leaves. There was no fingerprint to compare against, so nothing can be ` +
      "said to have moved — and any speed-limit refusal recorded before it is gone with it. " +
      "If this box has run before, the fingerprint file was lost.",
    );
  }
  if (!report.first && d.notify) {
    // The 2026-09-10 20:39Z reversal of a written pre-commitment was found the next
    // afternoon by a hand query. One line, on the edge, on the only change that reaches
    // every account at once. `tasks/47` Rule 5 is the watcher that acts; this is the
    // one that speaks.
    await d.notify(
      `⚙️ SignalDesk · money constants changed\n${report.lines.join("\n")}\n` +
      `Fingerprint ${hash}. Every account trades on this from now; open positions keep their own terms.`,
    );
  }
  return report;
}
