// The feed regimes a reading may not average across (`tasks/32` §2.2).
//
// `expectancy.ts` collapses every account-trip on one signal into a single event
// because four accounts on one outlook are one draw repeated. By that same standard
// **three feed regimes are three populations, not one sample of 42** — and until this
// table existed, the collapse pooled them and still printed one mean and one interval.
// The fourth reading had to say in prose *"the next reading must split the sample there
// rather than averaging across it"*, and the fifth had to compute the split with a
// throwaway script. A rule that lives in a note and not in the script is a rule that
// will be forgotten at the sixth reading.
//
// **Two of these boundaries are ours and two are Quotient's**, which is the point: the
// sample is cut by whichever moved last, and only ours are in this repository's git
// history. Theirs are observed, from the archive, at the granularity we observed them
// — a day — so a vendor boundary is a UTC midnight and not a claim about an instant.
//
// Nothing is stored on a row. `intents.created_at` already says when a trade opened,
// so the regime is derived (`tasks/32` §3: *do not backfill a regime column onto old
// rows from a guess*).

export type FeedRegime = {
  /** Inclusive start, UTC, ISO-8601. Ours carry the deploy's second; Quotient's carry
   *  a date, because a day is the resolution we can see their changes at. */
  from: string;
  /** Short label. Appears in every report that splits on this. */
  name: string;
  /** `ours` is a constant in this repo and is in git; `quotient` is a change we only
   *  observed, and the note is the only record of it. */
  by: "ours" | "quotient";
  /** What moved. */
  what: string;
  /** The note that argues it. `regimes.test.ts` asserts the file is still there. */
  note: string;
};

/** Oldest first. A new boundary is appended **when the change is made**, in the same
 *  commit that makes it — not reconstructed afterwards from a heartbeat.
 *
 *  **That rule was broken once, and this is the row it cost.** The σ1.0 revert shipped
 *  as PR #113 on 2026-09-10 and did not append here, so for the rest of that day every
 *  reading pooled the σ0.5 arm and the σ1.0 arm into one `reverted` block — the exact
 *  silent collapse `tasks/32` exists to refuse, on the one comparison the revert was
 *  delayed a day to create. The timestamp below was recovered from the restart in
 *  `journalctl`, which is the reconstruction this comment warns against; it is right
 *  because the gap around it is 48 minutes wide, and next time it may not be. */
export const FEED_REGIMES: readonly FeedRegime[] = [
  {
    from: "2026-08-30T00:00:00Z",
    name: "pre-09-04",
    by: "ours",
    // Not a change — the left edge. The recorder went live this day and
    // `minDisplacementSigma` was 1.0, an unvalidated number from the first capture.
    what: "the archive begins; minDisplacementSigma 1.0",
    note: "notes/2026-08-30-phase1-findings.md",
  },
  {
    from: "2026-09-04T00:00:00Z",
    name: "09-04 famine",
    by: "quotient",
    // The x1.23 is the per-pair median over this regime's own span, 09-04..09-06, and it
    // reproduces (`notes/2026-09-11-sigma-elevation-recomputed.md`). What it is *not* is
    // the state on 09-07, when the gate moved on it: that day read 1.03x. The boundary
    // and everything else in this row stand — the anchor mix did change and `two-day`
    // did go to zero — so this is a window figure correctly labelled with its window.
    what: "sigma_total x1.23 (per-pair median, 09-04..09-06), `daily` anchor 15% -> 6%, two-day anchors to zero",
    note: "notes/2026-09-07-phase3-fourth-reading.md",
  },
  {
    from: "2026-09-07T09:46:03Z",
    name: "sigma0.5",
    by: "ours",
    what: "minDisplacementSigma 1.0 -> 0.5, deployed 09:46:03Z",
    note: "notes/2026-09-07-phase3-fourth-reading.md",
  },
  {
    from: "2026-09-08T00:00:00Z",
    name: "reverted",
    by: "quotient",
    what: "sigma_total back to 0.89-0.91x of baseline, `daily` anchor back to 20%",
    note: "notes/2026-09-09-quotient-sigma-reverted.md",
  },
  {
    from: "2026-09-10T08:18:04Z",
    name: "sigma1.0",
    by: "ours",
    // The feed is still the reverted one; only our gate moved. That is what makes this
    // boundary worth the row — `reverted` and `sigma1.0` differ in one constant and
    // nothing else, which is the paired comparison `tasks/31` §3.1a delayed the revert
    // by a day to get, and pooling them throws it away.
    what: "minDisplacementSigma 0.5 -> 1.0, deployed 08:18:04Z on the reverted feed",
    note: "notes/2026-09-09-sigma-revert-timing.md",
  },
  {
    from: "2026-09-10T20:39:18Z",
    name: "sigma0.5-again",
    by: "ours",
    // Twelve hours and twenty-one minutes long, which is the whole life of `sigma1.0` —
    // and that is a fact about this table rather than a complaint. The block it closes
    // holds **7 distinct events**, so the paired comparison the revert was delayed a day
    // to build was never reached, and no reading may treat `sigma1.0` as an arm.
    //
    // The name says "again" because it is the same gate value as the 09-07 block and a
    // different population: that one sat on the 09-04 famine feed, this one on the
    // reverted feed. Two blocks can share a constant and still not share a distribution,
    // which is the entire reason this table exists.
    what: "minDisplacementSigma 1.0 -> 0.5, deployed 20:39:18Z; the owner's call, on diversification",
    note: "notes/2026-09-10-sigma-arms-and-the-correlated-book.md",
  },
] as const;

/** The regime in force at an instant. Anything before the archive begins belongs to the
 *  first regime rather than to none: a trade cannot predate the recorder, so a timestamp
 *  that does is a clock problem and not a fifth population. */
export function regimeAt(at: Date | string): FeedRegime {
  const t = typeof at === "string" ? Date.parse(at) : at.getTime();
  let cur = FEED_REGIMES[0]!;
  for (const r of FEED_REGIMES) {
    if (t >= Date.parse(r.from)) cur = r;
  }
  return cur;
}
