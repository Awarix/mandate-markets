// Strategy and risk parameters. **In version control, never in a systemd unit.**
//
// OutcomeMaker put its live tuning in `.service` files, so the repo never recorded
// what was actually running and no result could be attributed to the parameters that
// produced it. Every number below is here, in git, and changing one is a commit.
//
// Defaults come from docs/ARCHITECTURE.md §8 and docs/ACCOUNT-MODEL.md §6, which
// work a mutually consistent set. The four caps interact — change one, re-derive the
// rest.

/** The live-capital mandate. **Live trading is bounded in accounts, not in dollars.**
 *
 * There was a per-account dollar ceiling here — `maxBaseCapitalUsd`, $100 — and a
 * funding limit derived from it (`maxFundedForLiveUsd()`, $500, past which live was
 * refused outright). Both were removed on 2026-08-31. What follows is the argument,
 * because the ceiling was this project's loudest rule and deleting one of those
 * silently is how a codebase stops meaning what it says.
 *
 * **What the ceiling was actually measuring.** It was written on 2026-08-30, when
 * every funded account was ours and the risk being bounded was *our* exposure to
 * *our* untested execution code. For that it was the right instrument. One day later
 * the site opened to anyone, and the same constant was pointed at strangers' own
 * non-custodial accounts — where it no longer described anybody's risk. Each account
 * is one person's own money, deposited by them, on a key we cannot withdraw from.
 * The amount they are willing to lose is not ours to know, and `docs/USER-JOURNEY.md`
 * §3 has said from the start that **the deposit is how the user chooses their size**.
 * A ceiling under the deposit contradicts that: someone funds $300, we manage $100,
 * and $200 sits idle while their screen says they are being traded. That is not a
 * safety property. It is a silent refusal to do the thing they asked for.
 *
 * **What still bounds the risk, at every size.** Everything the ceiling was doing in
 * spirit is done by caps that are *fractions*, so they hold at $40 and at $40,000:
 * isolated margin (one signal cannot reach the rest of the account), venue-side stops
 * on every position, `maxDeployedPct` (100% of the budget in play at once, and see
 * `tasks/21` §4 for what raising it from 50% cost), `maxConcurrentSignals(s)`
 * (`floor(1 / perSignalPct)`), and `dailyLossPct` (10% of the day's opening equity,
 * which halts the account). What is genuinely given up is an **absolute** number: the
 * worst single day this system can now produce on one account is 10% of whatever that
 * account holds, and no constant caps it in dollars any more. That is the trade, and
 * it is stated here rather than discovered later.
 *
 * **Removing the clamp repaired the daily-loss halt rather than weakening it.**
 * `maxFundedForLiveUsd()` existed *only* because the clamp made `baseCapital` smaller
 * than equity. `dayLossFrac` measures against equity while our losses were bounded by
 * baseCapital, so past `dailyLossPct × equity > maxDeployedPct × baseCapital` a breach
 * needed a bigger loss than we could deploy and the halt could never fire — hence a
 * refusal above 5x the ceiling. With `baseCapital == equity` that comparison is
 * `0.10 × E` against `0.50 × E` for every E: the halt is reachable at any size, and
 * the funding limit had nothing left to guard. It went with the thing that created it.
 * (`maxDeployedPct` is 1.00 since `tasks/21`, which only widens that margin.)
 *
 * **What this is not.** It is not argued from a live P&L record — Phase 3 is still
 * waiting on closed positions (`tasks/02`), and this commit does not pretend
 * otherwise. It is not a claim that Quotient's forecasts are profitable; that was
 * never our question (`IDEA.md`). What changed is not evidence about the strategy but
 * *whose money the cap was standing in front of*, and what it turned out to measure.
 *
 * OutcomeMaker's ~90% loss of $738 is the reason this file is careful, and it is worth
 * being exact about what caused it: trading at size with **no isolated margin, no
 * venue-side stops, no daily-loss halt, no intent ledger, and a substring matcher that
 * bought the wrong market**. Five of those six defences exist here and are unaffected
 * by this change. The sixth was the ceiling.
 */
export const LIVE_MANDATE = {
  /** What live capital is for. **Not return generation** — the sample it produces is
   *  far too small for its P&L to mean anything, and reading a short winning streak
   *  as edge is the exact mistake this project exists to not repeat. It buys the
   *  facts paper cannot: real fills, real fees, real funding, partial fills, venue
   *  rejects, and a forced restart mid-position with money actually on the line. */
  purpose: "execution-validation",

  /** Hard ceiling on how many accounts trade live at once — **every** account we
   *  manage, ours included.
   *
   *  This replaced a dollar total (`maxTotalLiveCapitalUsd`, $200) on 2026-08-31, one
   *  day after that total was written. The total was right for what existed when it
   *  was written — two accounts, both ours, one person's money — and wrong the moment
   *  the site opened to anyone.
   *
   *  Summing dollars across owners describes nobody's risk. Each account is a
   *  stranger's own non-custodial account, funded by them, at a size they chose.
   *  Nobody authorised $1,000 of live exposure — but nobody has to: ten people
   *  authorised their own deposit each. And the total broke the one decision it was
   *  supposed to protect. The first two strangers to connect consumed all $200, so an
   *  address deliberately named in `HL_LIVE_ACCOUNT` — the strongest authorisation in
   *  this system, requiring someone on the box — came up **paper** behind them.
   *  Arrival order decided whose money moved.
   *
   *  That reasoning is why this cap outlived the per-account ceiling and is now the
   *  only hard bound left on live trading. What the aggregate bounds is the blast
   *  radius of **our** bug. A sizing error, a bad mapping, a wrong mark hits every
   *  managed account in the same tick, and finding those is exactly what Phase 2 is
   *  for. That risk scales with the number of accounts, not with dollars — which is
   *  precisely why it survived a change that removed every dollar figure around it.
   *
   *  **Four, and it counts our own account too. Changed 2026-09-05 from eight
   *  self-service accounts** (`tasks/17`), and both halves of that moved:
   *
   *  1. *Ours counts.* The number bounds how many accounts one bug of ours reaches in
   *     a tick and then has to be unwound by hand. Our own account is reached by that
   *     bug like any other and is unwound by the same hands, so leaving it out of the
   *     count made the number describe less than it claimed. `usesLiveSlot` used to
   *     mean two things at once — *is counted* and *can be refused* — and only the
   *     second belongs to the allowlist. `canBeRefusedForSlot` in `src/exec/mode.ts`
   *     is that second meaning, alone.
   *  2. *Four, not eight.* Eight was a morning's manual unwind for one person and is
   *     still true; four is the deliberately tighter number the owner chose when the
   *     site stopped being open-by-arrival. With the site about to be promoted, the
   *     desk is at its cap today (three self-service accounts plus ours), so everyone
   *     new joins the queue in `tasks/17` rather than arming on arrival — which is the
   *     point: who trades becomes a decision instead of a race, and the queue is where
   *     that decision is made and recorded.
   *
   *  **An allowlisted account is counted but never refused.** `HL_LIVE_ACCOUNT` is the
   *  deliberate per-account decision and needs someone on the box; letting a stranger's
   *  arrival override it was the 2026-08-31 defect and stays fixed. So naming an
   *  address there is the one way past this cap — it pushes the live count above it,
   *  loudly (`src/exec/runner.ts` logs it), and that is the same authority that could
   *  edit this constant. Nothing a user can reach, and no row in any database, can do
   *  it: the queue admits people *into the connect flow*, never over the cap.
   *
   *  A secondary cost points the same way — every account adds a `clearinghouseState`
   *  and a `frontendOpenOrders` per dex in `tradedDexes` to each 60s loop, so loop time
   *  grows linearly in accounts. That has **not** been measured at eight; measure it
   *  before raising this.
   *
   *  Checked **before** an account is armed, so breaching it makes that account paper
   *  rather than disturbing an account already trading. Raising it is a commit. */
  maxLiveAccounts: 4,

  /** When the account cap was first argued for, at eight (`tasks/04`).
   *
   *  ⚠ **Read, since 2026-09-13, and deliberately not deleted.** `tasks/46` §4 offered
   *  the choice of removing it as unread or printing it beside the two dates preflight
   *  already prints. Removing it is not free: every leaf of `LIVE_MANDATE` is inside
   *  `configHash`, so dropping a field moves the fingerprint off `f85b3fc0e794`, writes
   *  a `config` event at the next boot, and — with `sigma0.5-again` already holding one —
   *  makes `docs/STATUS.md` item 1's block unscoreable. A date costs a byte; a reading
   *  costs a week. `npm run preflight` prints it. */
  accountCapDecidedAt: "2026-08-31",
  /** When the cap became four and began counting our own account (`tasks/17`). */
  accountCapNarrowedAt: "2026-09-05",
  /** When the per-account dollar ceiling was removed. Recorded because the constant it
   *  names no longer exists to be found, and the reasoning above is the only place the
   *  decision lives. */
  perAccountCeilingRemovedAt: "2026-08-31",
} as const;

/** The builder fee: what we charge on Hyperliquid order flow, in **tenths of a basis
 *  point**, and the maximum each account's owner is asked to sign.
 *
 *  **It is one number and not two, deliberately.** Hyperliquid stores a per-(user,
 *  builder) *ceiling* and we attach a *rate* to each order; those could differ, and
 *  the owner's decision on 2026-09-09 was that they must not. A ceiling above the rate
 *  is headroom to raise the rate later on a signature given when it was lower — which
 *  is the version of "they consented" that is true on paper and false in substance.
 *  With one constant, **raising the rate requires every account to sign again**, and
 *  until they do their orders go out with no builder field and fill normally.
 *
 *  **`f = 6` — 0.6 bps — set 2026-09-09 by the owner.** The number it replaced was
 *  `f = 1`, and the note that priced it against the market
 *  (`notes/2026-09-09-builder-fee-market-comparison.md` §9) landed on **`f = 5` as the
 *  ceiling of what the evidence supports** — Proliquid's top VIP tier, which is the
 *  tier our accounts' turnover actually reaches. Six is 20% past that, and is the
 *  owner's call over that recommendation. What it costs, at the turnover measured in
 *  §4 of the same note:
 *
 *      per round trip at 10x    0.12% of margin  —  8.7% of the measured 1.38% edge
 *      per year, 4,000×          24% of account value
 *      per year, 8,000×          48%           ← the rate the desk has been running
 *      per year, 12,000×         72%
 *      per month, 4,000×         2.0pp         ← 42% of a 4.8% month
 *      per month, 8,000×         4.0pp         ← 83% of a 4.8% month
 *
 *  **A builder fee on this desk is an AUM fee**, because the turnover is ~4,000–12,000×
 *  a year rather than the venue-wide ~394×. That is the whole reason a rate that looks
 *  ordinary beside Hyperdash (`f = 15`) or Axiom (`f = 10`) is not ordinary here.
 *
 *  ⚠ **Three unit systems name this same quantity** and one decimal place is a 10×
 *  fee on somebody's money (`tasks/14` §1.4). `src/hl/approve-builder-fee.ts` is the
 *  only file that converts between them, and it is tested both directions:
 *
 *      the order's `builder.f`          integer, tenths of a bp     6
 *      `approveBuilderFee.maxFeeRate`   percent string              "0.006%"
 *      the `maxBuilderFee` read         integer, tenths of a bp     6
 *
 *  **The rate is here and not in the environment on purpose.** `HL_BUILDER_FEE` used
 *  to override it and no longer exists: a number that decides what strangers pay
 *  belongs in a diff someone could have read, which is the same rule that keeps every
 *  other strategy parameter out of a unit file. What stays an environment variable is
 *  the builder *address* — setting it is what turns the rail on, and that should need
 *  someone on the box. */
export const BUILDER_FEE = {
  /** Charged per order, and signed as the ceiling. See above for why they are equal. */
  tenthsBp: 6,
  /** Hyperliquid's own maximum for perps: 0.1%, read off the venue's docs 2026-09-09.
   *  Spot's is 1% and is not our rail. Nothing here may exceed this and the conversion
   *  refuses to build an action that does. */
  venueMaxTenthsBp: 100,
  /** The builder address must hold at least this much perp account value, and must be
   *  in `standard` abstraction mode, or the venue rejects every order carrying its
   *  code. Read off the builder-codes page 2026-09-09, not assumed. */
  builderMinPerpEquityUsd: 100,
  /** When the rate was set. Read by `npm run preflight` since 2026-09-13, and kept
   *  rather than removed for the same reason as `LIVE_MANDATE.accountCapDecidedAt`: it
   *  is a `configHash` leaf, and deleting it would cost a reading (`tasks/46` §4). */
  decidedAt: "2026-09-09",

  /** **When the fee stopped being optional, and for whom** (`tasks/33`, owner
   *  2026-09-10). An account whose `connections` row was created **on or after** this
   *  instant must approve the builder fee before it arms live; every account that
   *  connected before it is grandfathered and is asked for nothing.
   *
   *  The owner's decision was *"required means only for new users"*, and this is the
   *  narrowest durable reading of it. Three properties are why it is a connection
   *  timestamp and not something else:
   *
   *  - **It is already recorded and never rewritten.** `upsertConnection` sets
   *    `created_at` once and its `ON CONFLICT` clause does not touch it, so the cohort
   *    survives reconnects, restarts and unlinks — `disconnectAccount` sets the status
   *    to `disconnected` and leaves the row. No migration, and no new column that could
   *    disagree with the ledger.
   *  - **"Has it armed before" would have been wrong in both directions.** It flips the
   *    moment an account first arms, so a new account would be required once and never
   *    again; and it would re-require any grandfathered owner who unlinked and came
   *    back, which is not what "new users" means to the person who left.
   *  - **A date is a thing an operator can check before deploying.** Every existing
   *    connection's `created_at` is one query, and this constant sitting after all of
   *    them is the whole of the grandfathering claim.
   *
   *  ⚠ Set **after** the decision, so nothing already trading changed behaviour on
   *  deploy. Moving it later grandfathers more people; moving it earlier can stop an
   *  account that is live today, which is why it is here rather than in the environment.
   *  Verify it against the ledger before changing it.
   *
   *  ⚠ **It carries a time of day, and that is not fussiness.** It was
   *  `2026-09-11T00:00:00Z` — the day after — and was brought forward on 2026-09-10 so
   *  that the account onboarded through the new funding flow would meet the rule the
   *  desk actually charges under rather than be grandfathered by twelve hours. The
   *  ledger was read before it moved: **two accounts connected earlier the same day**,
   *  `0xacc00002…` at 08:23:46Z and `0xacc00003…` at 10:46:22Z, both active and both
   *  trading. A midnight cutoff would have made both of them required and stopped them
   *  arming on the next restart. The time of day is what keeps them grandfathered.
   *
   *  Inert while the rail is off: with `HL_BUILDER_ADDRESS` unset there is no fee to
   *  require, and `feeIsRequired` returns false without reading this at all. */
  requiredForConnectionsFrom: "2026-09-10T12:45:00.000Z",
} as const;

/** The four knobs the user gets (docs/ACCOUNT-MODEL.md §3). Everything else is ours. */
export type UserSettings = {
  /** 5 | 10 | 18 | 20. Clamped down to the asset's max, which is 10 on a third of the
   *  universe — the user is told when their 20x became 10x on a trade. */
  leverage: 5 | 10 | 18 | 20;
  stopLoss: boolean;
  /** Distance from entry, before the per-asset clamp. */
  stopPct: number;
  /** Fraction of baseCapital committed as margin per signal. */
  perSignalPct: number;
  /** Keep the position when Quotient's call goes neutral before the outlook expires,
   *  instead of closing on the next poll. Target, stop and horizon are unchanged.
   *  `ExitPlan.holdToTarget` has the exact trigger and why "neutral" is the honest
   *  word for it: ~95% of that feed is `no-direction`, so a call losing its side is
   *  the ordinary case and a series vanishing is the rare one.
   *
   *  **Defaults to false, which is what the whole live ledger was traded under**, and
   *  the default is not a guess about which is better — it is the only value that does
   *  not silently re-price a position for an owner who never asked. `intents
   *  .hold_to_target` freezes it per position, so a change here reaches the next
   *  signal and never the one already open.
   *
   *  The evidence is real but narrow, and it **reverses with the entry gate**
   *  (`notes/2026-09-07-backtest-sigma-and-exit-policy.md` §5). Over one 8-day archive
   *  window, paired on trades whose horizon has passed:
   *
   *  ```
   *      σ    │  n   close on neutral       hold to tp/sl    difference       95% CI
   *     1.0   │ 18         0.79%               -4.01%          -4.79%   -10.74%… 1.15%
   *     0.7   │ 30         2.09%                3.44%           1.35%    -3.49%… 6.18%
   *     0.5   │ 44         1.48%                4.81%           3.33%    -0.36%… 7.01%
   *     0.3   │ 65         0.50%                2.27%           1.78%    -1.08%… 4.63%
   *  ```
   *
   *  So holding wins at today's σ0.5 and loses at σ1.0, the crossover sits near σ0.8,
   *  **and not one of those intervals excludes zero.** Two live `exit-policy` readings
   *  at σ1.0 (−3.25%, −0.57%) agree with the σ1.0 row, which is the only gate where
   *  live evidence exists at all.
   *
   *  **This is the one setting whose wrong answer costs 30% rather than 3%**, and the
   *  asymmetry is not in the mean. Both −30% stops in that sweep are in the holding
   *  column, and 3.33 points of difference rest on two trades: `xyz:PLATINUM` retired
   *  at +1.07% where holding would have stopped out at −30.13%, and `xyz:CL` +2.02%
   *  against −30.21%. Holding still wins *carrying* them, because 27 of 44 reached
   *  target — but two trades is exactly the size of thing this repository keeps
   *  finding moves an answer by more than the answer. Whoever turns this on is
   *  choosing a fatter tail for a better mean, and the UI has to say so. */
  holdToTarget: boolean;
  /** **Not a web setting.** The desk trades real money; someone who connects a funded
   *  account wants it traded, so the site offers no simulation switch and never sends
   *  this field. Paper reaches the executor one way only — an operator writing
   *  `accounts/<address>.json` on the box — and it stays here in `UserSettings`
   *  because that file is parsed into this type.
   *
   *  It is still **a request, not a decision**, and can only ever move an account
   *  *down* to paper. Going live additionally needs the account to be permitted
   *  (named in `HL_LIVE_ACCOUNT`, or self-service switched on), funded to at least
   *  `minFundedForLiveUsd()`, and — for a self-service account — inside
   *  `maxLiveAccounts`. */
  mode: "live" | "paper";
};

/** **`stopPct` moved 1% -> 2% on 2026-09-12, at the owner's instruction, and it is the
 *  second default this desk has changed on measurement.** `tasks/42` §7 and
 *  `notes/2026-09-12-the-stop-is-2-percent-and-the-halt-is-the-size.md`.
 *
 *  **The evidence is a shape that held in four windows, not a swept best value.** At the
 *  shipped `minDisplacementSigma` of 0.5 and 10x, over `npm run backtest` on the whole
 *  12.9-day archive and three nested sub-windows of it:
 *
 *      window                     n     1.0%     2.0%     3.0%     4.0%     6.0%
 *      whole archive (12.9d)    104   +0.50%   +1.24%   +1.17%   +0.95%   +0.91%
 *      since 09-05    (7.3d)     60   +0.36%   +1.33%   +0.90%   +0.52%   +0.46%
 *      since 09-08    (4.3d)     58   +0.06%   +1.07%   +0.62%   +0.22%   +0.16%
 *      sigma0.5-again (1.4d)     11   -4.74%   +0.73%   +0.52%   +0.53%   +0.53%
 *
 *  **2% is the best row and 1% the worst in all four.** The windows are nested rather
 *  than independent, so this is one sample read four ways — but a value fitted to the
 *  whole archive has no reason to also be the peak on its last 1.4 days, where the sign
 *  of the 1% row is not even the same.
 *
 *  **Why there is a peak at all.** A wider stop converts stopped trades into
 *  *retirements*, not into winners: across 1/2/3/6% the stop count falls 26 -> 10 -> 5
 *  -> 1 while the **target count does not move at all** (26 every row). The rescued
 *  trade goes on to be closed at whatever price the call is at when it turns neutral, so
 *  past ~2% the room stops buying anything and only the losses get larger.
 *
 *  **Why not 3%, 6%, or a lower leverage to reach a wider stop.** The mean cannot
 *  separate them — 2%, 3% and 6% sit inside each other's intervals — so the halt does.
 *  `npm run backtest`'s Table 4 walks the daily-loss cap over the archive, marked to
 *  market because `tick()` reads the venue's `equityUsd`: at this position size **nothing
 *  halts at any stop width**, but the worst day runs -5.26% at 1%, **-7.10% at 2%** and
 *  -8.36% at 6%, and the simulator reads **~1.6x optimistic on that column** against the
 *  ledger's own worst account-days at matched settings. Scaled, 2% lands near the 10%
 *  cap and 6% past it. (Leverage was checked too: the curve peaks at 3% at 5x, 8x, 9x
 *  and 10x alike, so there is nothing a lower leverage's wider ceiling reaches.)
 *
 *  **What is given up, and it is not small.** `correlatedStopOfMandate` is `stopPct x
 *  leverage`, so it **doubles**: a correlated stop-out of a full book goes from 1.0x the
 *  daily halt to **1.98x**. ⚠ This said *"and `checkCapConsistency` starts warning at the
 *  shipped defaults again"* and that was never true — the threshold is a strict
 *  `> 2 x dailyLossPct` and the reserve leaves this at 19.8% against 20%, so the check
 *  returns `[]` and `ledger.test.ts` asserts exactly that on the line below the claim.
 *  What is true is narrower and worth more: **it now passes by two tenths of a
 *  percentage point**, so any stop wider than 2% at these settings does fire it.
 *  `stopsToHalt` halves, 10.1 -> 5.1 — still clear of the `limitsNote` boundary at 2,
 *  which is the property that has to hold. And the 1% default's own evidence is not refuted, only outgrown: the dip
 *  distributions behind it (winners median 0.23%, worst 1.69%; losers median 1.07%, p90
 *  3.05%) are measurements and stand, and a 2% stop still sits above every winner's dip
 *  in that sample.
 *
 *  ⚠ **The table is unstable and this is a hypothesis for the next block.** The 3% row
 *  alone moved **+0.67% -> +1.17%** on two days of new feed, no interval in it excludes
 *  zero, and every width overlaps every other. Re-read it at the sigma re-read rather
 *  than treating it as settled — which is exactly what the 1% default was told to expect
 *  and is now getting.
 *
 *  **This is the default, which reaches new connects only.** Existing accounts keep what
 *  their owner chose; `npm run settings -- set 0x... --stop 2` is the path that moves one
 *  without taking that owner's control away, and whether to move anybody is a separate
 *  decision from this constant.
 *
 *  **Prior history.** 3% -> 1% on 2026-09-10
 *  (`notes/2026-09-10-stop-sweep-on-the-whole-ledger.md`), on a sweep that modelled one
 *  entry per signal and so described a desk that refused to re-enter — a property the
 *  desk did not have until `blockReentryAfterStop` shipped on 2026-09-11. That block is
 *  what makes any of these replays true, and it is why this reading was worth taking.
 *
 */
export const DEFAULT_USER_SETTINGS: UserSettings = {
  leverage: 10,
  stopLoss: true,
  stopPct: 0.02,
  perSignalPct: 0.10,
  holdToTarget: false,
  mode: "live",
};

/** **What a stranger connecting today meets while the current default is still untested**
 *  — `tasks/47` Rule 4, first part, and the owner's decision of 2026-09-13 (`tasks/47`
 *  §5.3).
 *
 *  On 2026-09-10 the stop default moved 3% → 1% in the evening and seven alpha accounts
 *  connected onto it within hours. 157 of the next day's 176 trips ran the new value, so
 *  the control arm was nineteen trips across five settings and the reading that followed
 *  could not separate the change from the day. A default reaching a new cohort inside its
 *  own first block is how the control disappears.
 *
 *  **Why this is a hand-written constant rather than a lookup.** The rule as `tasks/47`
 *  drafts it reads the value the previous `config` event superseded, straight from the
 *  ledger. That version cannot be forgotten — and it would have been **wrong on
 *  2026-09-12**, when the default moved 1% → 2% *because 1% was worse*: every stranger
 *  connecting that week would have been seeded at 1%, the value the desk had just fled,
 *  by a rule whose purpose is caution. A constant an author sets in the same pull request
 *  that moves the default can decline to hand back a value that was moved away from for
 *  cause. ⚠ The cost is the mirror of that: it can be forgotten, and a forgotten one
 *  silently equals the default and the guard is off. `params.test.ts` catches the shape;
 *  nothing catches the intent, which is why it is in `CLAUDE.md`'s checklist.
 *
 *  ⚠ **It equals `DEFAULT_USER_SETTINGS` today, and that is the considered answer rather
 *  than an unset field.** The value 2% superseded is 1%, which was moved off for cause,
 *  so there is nothing safer to fall back to and no new connection is seeded away from
 *  what the desk runs. The machinery is live and inert; the next default move is where it
 *  starts doing something, and the author of that move decides this line with it.
 *
 *  **It never touches an existing account.** Those settings are their owner's — Rule 5 is
 *  alert-only for them — and this is read on one path: a new connection's omitted fields. */
export const DEFAULT_USER_SETTINGS_LAST_TESTED: UserSettings = {
  leverage: 10,
  stopLoss: true,
  stopPct: 0.02,
  perSignalPct: 0.10,
  holdToTarget: false,
  mode: "live",
};

export const RISK_PARAMS = {
  // ── Caps. None of these is raised without explicit user approval. ──────────
  /** Σ margin in play ≤ the tradeable budget × this.
   *
   *  **1.00 since 2026-09-04 (`tasks/21`), from 0.50.** The mandate is what the owner
   *  deposited and asked to have traded; half of it sitting idle was a second,
   *  unstated ceiling of exactly the kind `LIVE_MANDATE` removed above. Worse, paired
   *  with a flat concurrency count it made the per-position slider run backwards —
   *  on a $1,000 mandate, 10% deployed $500 and 20% deployed $400 — so dragging the
   *  control up put *less* capital to work. Nobody chose that; it is what two
   *  independently-picked caps did when they met.
   *
   *  **What it costs is in `tasks/21` §4 and is not small.** Quotient publishes in
   *  same-side batches, so the case that matters is every open position stopping in
   *  one move: `deployed × min(1, stopPct × leverage)`. That roughly doubles — 15% of
   *  the mandate to 30% at the defaults, and 50% to 100% for an account trading with
   *  no stop at all. The daily-loss halt does not prevent it (it is evaluated between
   *  60-second ticks and stops new *opens*), it only stays reachable.
   *
   *  Not 0.99, which was offered as a way around the float dust in `fitsBudget`: ten
   *  positions at 10% are exactly 100% of the budget and 0.99 refuses the tenth,
   *  which is the very failure this raise exists to remove, one position later. The
   *  dust is fixed where it lives, in the comparison. */
  maxDeployedPct: 1.00,
  /** Realised + unrealised loss against the day's opening equity. Breach halts. */
  dailyLossPct: 0.10,

  /** The stop must fire at most this far toward liquidation. A stop at 95% of the
   *  way to liquidation is the same event as a liquidation: mark gaps, funding
   *  accrues against margin, and fees eat the rest. */
  liqBufferFrac: 0.7,

  /** The fraction of the mandate that is never deployed as margin.
   *
   *  It replaced `freeCollateralFloorUsd: 5` on 2026-09-04, and with it the last of
   *  our own risk constants denominated in dollars. That floor was dead code behind a
   *  50% cap — `insufficient-collateral` has never once been skipped on — and at
   *  `maxDeployedPct = 1.00` it would have become the thing that refused the last
   *  position instead of the cap, leaving the raise with nothing to show.
   *
   *  **What the reserve is actually for is fees, and only fees**
   *  (`notes/2026-09-04-isolated-margin-and-the-reserve.md`). Measured on mainnet
   *  across a funding hour, 17 isolated positions on 11 accounts: funding is charged
   *  to the isolated position's own margin, exactly, and free collateral never moved —
   *  not on the six accounts holding zero of it, and not on the controls holding
   *  thousands. We also never top up an isolated position (`updateIsolatedMargin`
   *  appears nowhere in `src/`), so free collateral buys no intervention either. What
   *  is left is the entry fee, and a full book's worth of those is at most **0.90% of
   *  the mandate** — 4.5bps of notional at 20x across 100% deployed, on native
   *  markets, with no referral discount. One percent covers it 1.1× there and 5.6× on
   *  the `xyz:` markets that are 17 of our 19 intents.
   *
   *  A fraction, not a floor, because the thing being covered is a fraction: fees are
   *  bps of notional and notional is proportional to the mandate. A $5 floor is not
   *  the conservative version of this — it is a different quantity, and on a $15
   *  account it is a third of the mandate. */
  reserveFrac: 0.01,

  /** Hyperliquid rejects perp orders below this notional. */
  minOrderNotionalUsd: 10,

  /** Marketable-limit band on entries and forced closes. Trigger orders are placed
   *  as limits rather than market so the 10% slippage tolerance HL applies to market
   *  triggers cannot turn a stop into a much worse fill. */
  slippageBps: 30,

  // ── Entry gate ────────────────────────────────────────────────────────────
  /** PROVISIONAL — Phase 0 (`tasks/02`) sets this. Gate on displacement in sigmas,
   *  never on a raw percentage: a 1.5% edge over 30 minutes is 5σ, the same 1.5%
   *  over a week is noise. In the first capture 1.0 kept BTC (2.57σ), TSLA (5.10σ),
   *  META (2.35σ) and COPPER (1.30σ), and dropped HOOD (0.36σ).
   *
   *  **1.0 → 0.5 on 2026-09-07, by the owner, and it is a hypothesis rather than a
   *  measurement.** `notes/2026-09-07-phase3-fourth-reading.md` is the record. Two
   *  separate things argue it and they should not be conflated:
   *
   *  **The part that is a restoration.** `sigma_total` is this gate's denominator, and
   *  on 2026-09-04 Quotient's rose **1.23× (median)** holding asset *and* anchor fixed
   *  — concentrated in next-day and weekly, with monthly unchanged. Hyperliquid's own
   *  candles say realised volatility did **not** rise over the same window, so this is
   *  their model moving, not the market. A denominator 1.23× larger means 1.0σ today
   *  demands 1.23× the price displacement it demanded when this constant was chosen,
   *  so **σ ≈ 0.8 is the value that holds the gate still in price terms.**
   *
   *  **The part that is a loosening.** 0.5 is below that, ≈ 0.62σ in the pre-09-04
   *  scale — under anything this desk has ever traded. It buys 55 tradeable events
   *  over the eight-day archive against 23, and restarts a feed that produced
   *  **zero** for three days. It also roughly doubles turnover, and turnover is what
   *  fees are charged on (`notes/2026-09-01-builder-fee-decision.md` §2: ~4,000×
   *  account value a year already). Expectancy is +1.93%/signal on a 95% interval of
   *  −1.48% … +5.33%, so the extra cost is certain and the extra edge is not.
   *
   *  **The trip-wire, and it is the reason this is safe to try.** The restoration half
   *  is conditional on a change we did not make and do not control. If Quotient's
   *  `sigma_total` returns to its pre-09-04 level (~0.027 median on the fixed basket,
   *  against ~0.037–0.047 since), then 0.5 stops being 0.62σ-equivalent and becomes a
   *  genuine halving of the gate at 10–20× leverage. **If that happens, this goes
   *  back to 1.0 in a commit before the next trade.** The founder call on 2026-09-08
   *  asks them directly whether the shift is permanent.
   *
   *  **The trip-wire fired, and this is the revert — 2026-09-10.** Quotient's
   *  `sigma_total` came back through pre-09-04 levels (0.91x on 09-08, 0.89x on 09-09,
   *  against a 1.23x peak on 09-05), which is the condition stated above, so 0.5 is
   *  now a real halving of the gate rather than the 0.62-sigma-equivalent it was
   *  chosen as. Decided by the owner 2026-09-09 and dated to today
   *  (`notes/2026-09-09-sigma-revert-timing.md`); the day's delay was taken to let the
   *  0.5 arm on the reverted feed reach ~30 events so the two blocks differ only in
   *  our gate. **Its condition was checked before this commit: the arm reads 29
   *  distinct events closed since 2026-09-08, with 8 more open** — it grew as
   *  predicted, so the delay bought the control it was taken for. Re-read the sigma
   *  tests when the 1.0 arm reaches ~30, expected ~2026-09-13 (`tasks/31` section 3).
   *
   *  **Back to 0.5 the same day, 2026-09-10, by the owner — and the honest label for
   *  that is that a written pre-commitment was reversed twelve hours after it was
   *  honoured.** `tasks/31` section 3.6 anticipated exactly this and argued against it:
   *  *"sigma0.5 winning does not un-fire the trip-wire -- that condition is about
   *  Quotient's denominator, not about our returns, and re-loosening on the block that
   *  produced the number is adopting a swept-best value on its own sample."* That
   *  objection was put to the owner and the decision stands. It is written here rather
   *  than in a note because the next person to read this constant should meet the
   *  argument against it in the same breath as the value.
   *
   *  **The case that does hold is about diversification, not returns**, and the two
   *  must not be conflated again. Returns cannot carry it: Spearman rho between
   *  |displacement_sigma| and return on margin is **-0.08 over 58 events** against a
   *  null band of +/-0.26 (`notes/2026-09-10-what-the-losses-share.md`), so sigma is a
   *  **volume knob, not a quality knob** on everything we have measured. What it does
   *  move, immediately and by a lot, is *what the book holds*: since the 08:18Z revert
   *  sigma1.0 admitted **10** distinct outlook/sides against sigma0.5's **18**, and the
   *  eight it refused were 6 equity and 4 crypto against 8 commodity, 6 shorts against
   *  12 longs. The desk consequently ran four correlated commodity longs at 100% of the
   *  book instead of ~40%, and three accounts hit the daily-loss cap together within
   *  six minutes (`notes/2026-09-10-sigma-arms-and-the-correlated-book.md`). Widening
   *  the gate is the cheapest thing that puts other names back in the book.
   *
   *  **What this does not fix, and what should have moved first.** The damage is in the
   *  stop, not the gate: strip stopped trips and the forecast is worth +2.40% per
   *  signal on the reverted feed against +2.56% before it, so the entire decline is 12
   *  stop-outs at -31% each. The stop is armed 2.4-3.2x further out than the target and
   *  had never once fired in the first 50 trips. Moving sigma does nothing about that
   *  and the sweep says 1.0-2.0% is where the stop belongs
   *  (`notes/2026-09-10-stop-sweep-on-the-whole-ledger.md`, `docs/STATUS.md` item 21).
   *  **Nothing else is in this diff, so that stays attributable and separate.**
   *
   *  ⚠ **2026-09-11 — the restoration half above never existed, and the arithmetic for
   *  it is corrected here rather than deleted.** Recomputed from the archive with
   *  `npm run feed-sigma` (`notes/2026-09-11-sigma-elevation-recomputed.md`). The
   *  **1.23x is correct and correctly a median — over 2026-09-04..09-06.** It
   *  reproduces on all four of the fourth reading's published statistics. But that
   *  window had **closed before this constant moved**: the elevation peaked at 1.28x on
   *  09-05 and read **1.03x on 09-07**, the day of the 09:46Z deploy.
   *
   *    "sigma_total is 1.23x elevated"      -> 1.03x on the day
   *    "sigma ~ 0.8 holds the gate still"   -> ~0.97; 1.0 held it still
   *    "0.5 is ~0.62 sigma in the old scale"-> ~0.515 sigma
   *
   *  **So 1.0 -> 0.5 was a loosening and nothing else, on every day it has been in
   *  force.** Their denominator has been at baseline since 09-08 (0.90-1.00x), so 0.5
   *  is a straight 2x loosening of the original gate in price terms today. That does
   *  not touch the diversification case above, which is what the current value rests
   *  on; it removes a justification still quoted beside it.
   *
   *  ⚠ **And the trip-wire could not have worked as written.** It keyed on the
   *  *absolute* basket median (~0.027 against 0.037-0.047), and that statistic spans
   *  **0.02505..0.03820 — 1.52x — inside the untouched baseline window**. Threshold and
   *  trigger band both sit inside its own noise. The per-pair ratio does not have this
   *  problem (1.00-1.02x on every baseline day) and is what any future condition keys
   *  on. The 09-10 revert was still right: it honoured a written pre-commitment and the
   *  feed genuinely had come back. The condition was luckier than it was sound.
   *
   *  **Watched since 2026-09-13 by `FEED_SIGMA_WATCH` below** (`tasks/43` §2), which is
   *  the exit condition this value went three days without. It does not move the value:
   *  the watcher alarms and names what it would take, and the commit is still a human's.
   *  The prior question — whether this gate should divide by their model at all — is
   *  `tasks/43` §3 and is untouched. */
  minDisplacementSigma: 0.5,

  /** `coverage` is universe-filling and always neutral, so it is excluded by
   *  construction. Whether `signal` (a cross-venue disagreement) beats `projection`
   *  (Q's own model vs spot) is one of the first things Phase 0 must split on —
   *  until it has, we take both. */
  allowedModes: ["signal", "projection"] as readonly string[],

  /** All three, deliberately. `minDisplacementSigma` is the binding gate and adding
   *  a second overlapping one now would just hide which one is doing the work.
   *  Phase 0 decides whether `strength` adds anything on top of σ. */
  allowedStrengths: ["low", "medium", "high"] as readonly string[],

  /** PROVISIONAL — Phase 0 sets this. Originally argued from funding: charged on
   *  notional, so at 10x it costs ~2.4%/day of the signal's margin, 48h ≈ 5% of margin,
   *  about a sixth of a stop-out.
   *
   *  ⚠ **That argument is measurably false and the constant is kept anyway** —
   *  2026-09-11, `notes/2026-09-11-the-anchors-we-trade.md` §2.1. Over the whole ledger
   *  funding is **0.169% of margin per trip** ($9.72 on $5,766.97) and is *negative* on
   *  the weekly cell: we are paid. The stated model is ~28x the cost it describes. Fees,
   *  which it does not mention, are **0.314%** — about twice the funding it reasons from.
   *
   *  **What this actually does, and it is not a hold cap.** No position in 458 trips has
   *  been held past **19.20h**, so as a cap on holding it has never once bound. It binds
   *  absolutely as an **entry filter**: the longest horizon at entry across every real
   *  trip is 48.5h, so a `weekly` outlook is only ever traded in its final two days
   *  (median 26.5h remaining) and a `monthly` one essentially never — one trip in twelve
   *  days. That is a real selection on *when in a forecast's life we enter*, it was
   *  never chosen deliberately, and it is why our book sits almost entirely in the two
   *  anchors Quotient revised on 09-04 while the anchor they left alone is one trip.
   *
   *  **48 stays, and since 2026-09-12 that is a measurement rather than an absence of
   *  one.** The horizon check runs *before* the sigma gate in `evaluateSeries`, so an
   *  outlook refused on horizon was never tested for displacement and might fail it —
   *  which means the 16/35/43 extra outlooks a 72/96/120h cap would admit are ceilings,
   *  not forecasts. ⚠ This used to end *"Answering it needs `backtest` to sweep this
   *  constant, and that flag does not exist; the script sweeps sigma only."* Both
   *  `--hold-hours` and `--stop` exist now, and the sweep was run:
   *  `npm run backtest -- --hold-hours 48,60,72 --sigmas 0.5 --since 2026-09-08` admits
   *  **17 `daily` anchors at every one of the three caps** — widening buys one `next-day`
   *  and four `weekly` — and 72h fails a genuine first-half/second-half split
   *  (`notes/2026-09-12-the-48-hour-cap-and-the-unit-it-refuses-in.md`, `tasks/45`). The
   *  512 `horizon-too-long` series-poll rows behind the original worry are **29 distinct
   *  outlooks**, 52% of which the sigma gate would have refused as well. */
  maxHoldHours: 48,

  /** After a stop fires, refuse a **same-side** entry on that market for the rest of the
   *  UTC day, on that account. `tasks/42`.
   *
   *  **Why this is a boolean and not a window.** The obvious form is a cooldown in
   *  minutes, and a cooldown has a number in it that would have to come from somewhere.
   *  The only place available is the 9 events that suggested the rule, which is the
   *  flattery `stop-sweep` refuses on its own output. The UTC day is the boundary
   *  `rollDay` already uses for the daily-loss baseline, so this introduces no new clock
   *  and nothing to tune.
   *
   *  **What it is for.** `loop.ts` guards only against a *live* intent, so a closed one
   *  constrained nothing and a stopped-out position reopened on the next tick if the call
   *  was still in the feed — which it usually is, because a stop firing is a statement
   *  about price and not about Quotient's opinion. Measured over the whole ledger to
   *  2026-09-11: 50 such re-entries returned **−6.31% of margin against +0.24% after a
   *  `retired` close and +0.16% after a `target`**, and **none of the fifty ever reached
   *  its target** (29 retired, 21 stopped) against 19% of all trips that do.
   *
   *  **Same-side, deliberately.** Every post-stop re-entry in the ledger is same-side —
   *  zero flips at every window tested — so the side test costs nothing measured and
   *  refuses the one false positive worth having: Quotient stopping us out of a long and
   *  then genuinely calling a short.
   *
   *  **Keyed on the market, not the outlook.** The outlook is the better key — the call
   *  did not change, so the stop taught us something the call does not know — but
   *  `stableOutlookId` rotates (`tasks/41`) and an outlook-keyed block leaks 20 of the
   *  re-entries it should catch. When `41` lands, "until the side flips or the horizon
   *  passes" replaces this and the day boundary becomes the fallback.
   *
   *  ⚠ **This is 9 collapsed events and 30 of the 50 trips are one market on one day.**
   *  What justifies shipping it anyway is that it can only ever *refuse* a trade — it
   *  cannot open a position, increase one, or move a cap — and that it clears a placebo
   *  the sweep was not asked for: the identical rule applied to `retired` closes returns
   *  −1.63% and to `target` closes **+0.74%**, so it is specific to the one close that
   *  carries information about price. */
  blockReentryAfterStop: true,

  /** The perp dexes we read and trade. **This is a hard scope, not an optimisation.**
   *  Hyperliquid has 11 perp dexes on mainnet today and **257 on testnet**, and every
   *  one of them costs a `meta`, an `allMids`, a `clearinghouseState` and a
   *  `frontendOpenOrders` call per loop. Walking all of them is not a slow loop, it is
   *  no loop at all.
   *
   *  `""` is the native perp dex; `xyz` is trade.xyz, which runs ~90% of HIP-3 open
   *  interest and every HIP-3 symbol Quotient has ever referenced. A signal naming a
   *  market outside this list is rejected as `unmapped-symbol` and alerted on — which
   *  is the same rule as any other unknown symbol, and the right outcome.
   *
   *  The cost of the scope: our foreign-actor detection only sees these dexes. A user
   *  hand-trading on a dex we do not read would go unnoticed. There is no endpoint
   *  that returns positions across all dexes at once (`webData2` is main-dex only,
   *  checked live 2026-08-30), so widening this means paying per dex per loop. */
  tradedDexes: ["", "xyz"] as readonly string[],

  // ── Loop and liveness ─────────────────────────────────────────────────────
  loopIntervalSec: 60,
  /** Stop opening if the signal feed has not produced a successful poll in this long.
   *  Existing venue-side stops stay live regardless — this gates entries only.
   *
   *  **Measured from `Snapshot.polledAt`, which is the source's fact and never our
   *  clock.** It has to be, and getting that wrong disabled this constant entirely
   *  between 2026-08-30 and 2026-09-07: `runner.ts` timed its own call to
   *  `source.fetch()`, and in production that call reads a file the *recorder* writes,
   *  so it succeeded every loop however long Quotient had been down. A five-hour outage
   *  reported a feed age of zero. `notes/2026-09-07-stale-feed-age.md`.
   *
   *  Nor is it `Snapshot.at`: that is when the content last *changed*, and a vendor
   *  republishing an identical payload for an hour is normal rather than an outage. */
  staleFeedSec: 3600,
  /** Dead-man switch on every signed action, so a stalled process cannot have a
   *  stale order land minutes later. */
  actionExpirySec: 60,

  /** How long to wait between one account's connect checks and the next account's.
   *
   *  **Measured, not guessed at: this box has taken a Hyperliquid 429 storm on loop 1
   *  seven times.** A cold start runs every managed address through `connectAccount`
   *  back to back, and each one is several `info` calls — the collateral read, the
   *  builder approval, `extraAgents`, the abstraction check. With fifteen addresses that
   *  is around a hundred calls inside a second or two. On 2026-09-11 it left a **live**
   *  account unmanaged for two loops, which is the daily-loss halt, the signal-change
   *  exit and foreign-actor detection all off for two minutes on somebody's open book.
   *
   *  Half a second spreads a fifteen-account cold start over about seven seconds, inside
   *  a 60s loop — the burst goes from ~100 calls/second to ~14. It is not a rate limiter
   *  and does not pretend to be one: it is the cheapest change that makes the burst not
   *  a burst, and the fee gate now tells a 429 from a refusal to sign either way, so a
   *  storm that still happens no longer drops an account.
   *
   *  Paid on the *retry* path too, where the fifteen allowlisted-but-unconnected
   *  addresses re-run their checks every loop. That is the cost: about seven seconds of
   *  each minute. `counterfactualSec` above makes the same trade for the same reason. */
  connectPaceMs: 500,

  /** How often each live account's fills and funding are pulled from the venue.
   *
   *  Minutes, not every tick. Nothing decides anything on this data — it is what a
   *  trade *cost*, settled after the fact — so the only thing a slow cycle delays is
   *  the P&L number, while a fast one adds two `info` calls per account to a loop
   *  that already makes four per dex. Five minutes against a 60s loop means one
   *  ingest every five ticks.
   *
   *  It is also the detection lag on a foreign **fill**, which the position-level
   *  check cannot see when a second actor opens and closes inside one tick. That is
   *  the argument for not making this an hour. */
  fillIngestSec: 300,

  /** How often the executor summarises the price path of trades that have closed
   *  (`tasks/31` §5, `src/exec/counterfactual.ts`).
   *
   *  Five minutes, matching `fillIngestSec`, and for the same reason: nothing in the
   *  decision path reads the result, so the only thing a slow cycle delays is an answer
   *  about trades that are already over. A pass does at most five trades and pauses
   *  between them, so the steady-state cost is nil — the desk closes far fewer than five
   *  trades in five minutes — and a backlog drains over an hour rather than in a burst.
   *
   *  **The burst is the thing being avoided.** The unpaced version of this call, one
   *  `candleSnapshot` per closed trade, tripped Hyperliquid's rate limiter and took
   *  `npm run stop-sweep` down on four of five attempts at 207 intents on 2026-09-09.
   *  That script is allowed to fail. The executor is not. */
  counterfactualSec: 300,

  /** Can the book fill this, and — the question that matters — can it let us out?
   *
   *  **Measured before it was picked.** `tasks/07` says the sequence is measure, then
   *  pick floors, then gate, because picking a floor first is how you get a constant
   *  nobody can defend. `npm run probe:hl` prints both numbers per asset; these come
   *  from a live mainnet read on 2026-09-02.
   *
   *  **`minVolume24hUsd` = $1,000,000.** The distribution is what argues for it, not a
   *  round number: **21 of the 117 `xyz:` markets have literally $0 of 24h volume** —
   *  `xyz:URANIUM`, `xyz:ALUMINIUM`, `xyz:DXY`, `xyz:VIX`, `xyz:CORN`, `xyz:WHEAT`,
   *  `xyz:TTF`, `xyz:VOL` among them — and every one of those is exactly the kind of
   *  commodity Quotient publishes outlooks on. This is not a hypothetical gate. On the
   *  main dex, 96 of 233 markets are under $100k. A $1M floor refuses 51 of 117 `xyz:`
   *  markets and 161 of 233 native ones, and admits **everything we have actually
   *  traded**: the thinnest was `xyz:PLATINUM` at $1.46M. That closeness is
   *  deliberate and worth watching — one quiet day and PLATINUM is refused, which is
   *  the check working rather than misfiring, but it is the first place it will bind.
   *
   *  A book is a snapshot; volume is the evidence the snapshot is repeatable. This
   *  floor exists for the market that looks fine right now and is empty at 3am when a
   *  stop fires.
   *
   *  **`maxParticipationPct` = 10% of in-band depth on the thinner side.** At
   *  `slippageBps` (30), nine tenths of what is resting would have to step away before
   *  a stop failed to fill inside the band. Cassie's reference takes 25% of a 100bps
   *  band; this is a narrower band and a tighter share, and `tasks/07` says explicitly
   *  not to import their numbers.
   *
   *  What it costs today: nothing, and that is checkable. The tightest binding notional
   *  across the mapped universe is **$2,941 on `xyz:COPPER`** — ten times the largest
   *  position any of our accounts has opened. It starts to bind on `xyz:COPPER` at
   *  around $2,900 of base capital at the default 10%/10x, which is a realistic account
   *  size, so this is a live constraint rather than decoration. ETH's is $642,823.
   *
   *  **A veto, not a sizer.** We size notional-first from a mandate the user agreed to;
   *  shrinking a position to fit a book would change that silently. A skip with a
   *  visible reason does not. `src/risk/capacity.ts` carries the rest of the argument.
   *
   *  **Entry only.** A stop that cannot fill is a reason to alert, never a reason not to
   *  place it: a stop into a thin book is strictly better than no stop. If a book is
   *  too thin to leave, that is an entry-time refusal. */
  capacity: {
    minVolume24hUsd: 1_000_000,
    maxParticipationPct: 0.10,
  },

  /** How far ahead of an agent approval lapsing we start warning — and start refusing
   *  to open a position that would outlive it.
   *
   *  **Hyperliquid has no "extend".** An approval is renewed by approving again, which
   *  only the master wallet can sign, and the HL UI offers Remove and nothing else. So
   *  this is not a machine deadline that some retry will clear; it is a human one, and
   *  the human has to be at the wallet they funded the account with.
   *
   *  It was 7 days, which assumed someone was watching. Fourteen assumes they are not,
   *  and it is also longer than `maxHoldHours` by a wide margin, so an account inside
   *  the window can still open everything it could open outside it — the two numbers
   *  only interact once the approval is genuinely close. */
  agentExpiryWarnDays: 14,
} as const;

/** How many positions fit, derived from the owner's own per-position size.
 *
 *  A constant `5` until 2026-09-04 (`tasks/21` §3), and in five days of live trading
 *  it never once bound — not a single `max-concurrent` skip exists in the ledger.
 *  What it did do was collide with `maxDeployedPct`: the two were picked
 *  independently, so `min(5, floor(0.50 / perSignalPct))` made 20% deploy less than
 *  10%. Derived, the two bind at **exactly the same point by construction**, which is
 *  the property the pair lacked.
 *
 *      5% → 20      10% → 10      15% → 6      20% → 5      25% → 4
 *
 *  `floor`, never `round`: Σ margin must never be able to exceed the budget. 15% is
 *  the case that shows it — six positions, not seven.
 *
 *  **This is not the same as how many positions an account will actually hold.** The
 *  feed has never offered more than five tradeable signals at once (`tasks/21` §5), so
 *  below 15% per position this number is not the binding one and nothing changes yet.
 *
 *  ⚠ **It has bound since — and the point at which it starts is arithmetic.** `fitsBudget`
 *  refuses once this many are open, and `floor(1/p) < n` exactly when `p > 1/n`, so a book
 *  whose p90 is `n` first meets the cap at a position size above `1/n`. Across every
 *  `maxHoldHours` value simulated the live-policy p90 is **3–6**, which puts the crossing
 *  at **16.7%–20% per signal** — above the 10% default and below the 20% and 25% three
 *  accounts run. The ledger agrees exactly: **25 `max-concurrent` skips, 118 sightings,
 *  2026-09-07 → 09, and every one of them on those three accounts** (`0xacc00006…` 13 at
 *  4/4, `0xacc00007…` 8 at 5/5, `0xacc00004…` 4). Zero on any account at 10%. The
 *  paragraph above was written on 2026-09-04 and stopped being true on 09-07
 *  (`notes/2026-09-12-the-surface-and-the-concurrency-dial.md` §3.1). */
export function maxConcurrentSignals(s: Pick<UserSettings, "perSignalPct">): number {
  return Math.floor(1 / s.perSignalPct);
}

/** The part of the mandate that is never deployed, so the last position fits with the
 *  reserve intact. See `RISK_PARAMS.reserveFrac` for what it is for and why it is a
 *  fraction rather than the $5 floor it replaced. */
export function reserveFor(baseCapital: number): number {
  return baseCapital * RISK_PARAMS.reserveFrac;
}

/** What is actually available to deploy: the mandate less the reserve. Every sizing
 *  decision runs off this rather than off `baseCapital`, so that `Σ margin` over a
 *  full book lands exactly on it and free collateral lands exactly on the reserve.
 *
 *  It is deliberately **not** `min(baseCapital, equity) − reserve`. The mandate is what
 *  the owner deposited and it does not shrink when they lose (owner, 2026-09-04) — so a
 *  drawn-down account skips its last position as `insufficient-collateral`, which is a
 *  true statement about what the venue would refuse rather than a quietly smaller
 *  mandate. `src/risk/ledger.ts` keeps the fixed base for the same reason. */
export function tradeableBudgetUsd(baseCapital: number): number {
  return baseCapital - reserveFor(baseCapital);
}

/** The least an account can hold and still produce a **legal** order — the floor that
 *  replaced the ceiling as the only funding number the connect screen quotes.
 *
 *  Hyperliquid rejects a perp order under `minOrderNotionalUsd` ($10), and one
 *  signal's notional is `baseCapital × perSignalPct × leverage`. This is that,
 *  inverted. Below it every signal is skipped as `below-min-notional` and the account
 *  trades nothing while looking perfectly connected — the failure this number exists
 *  to name before someone deposits.
 *
 *  **It is a function of the user's settings, so there is no single figure.** At the
 *  defaults (10% per signal, 10x) it is $10.11; at the weakest combination the connect
 *  screen offers (5%, 5x) it is $40.41, which is why step 2 quotes ~$40 before the
 *  sliders have been touched and the exact number once they have. The cents are the
 *  reserve: sizing runs off `baseCapital − reserve`, so the base has to carry the
 *  reserve on top of the notional floor (`tasks/21` §6). Lot rounding can still bite
 *  just above the line on the most expensive markets, so treat it as the floor it is
 *  and not as a recommendation.
 *
 *  `connectAccount` and `npm run preflight` each computed this inline before it was
 *  named here. Two copies of a threshold is one copy that drifts. */
export function minFundedForLiveUsd(s: Pick<UserSettings, "perSignalPct" | "leverage">): number {
  const raw = RISK_PARAMS.minOrderNotionalUsd / s.perSignalPct / s.leverage / (1 - RISK_PARAMS.reserveFrac);
  // Rounded **up** to the cent. The reserve gave this number a fractional tail
  // ($10.1010… at the defaults), and every screen that quotes it formats to whole
  // dollars — which would print "$10" for a floor of $10.11 and send someone away
  // funded to exactly the figure we gave them, below the line, skipping every signal
  // as `below-min-notional`. A floor quoted low is not a floor.
  return Math.ceil(raw * 100) / 100;
}

/** The watcher on the gate's own denominator — `tasks/43` §2.
 *
 *  `displacement_sigma` is `ln(median_price / ref_median) / sigma_diffusive`, so when
 *  Quotient's estimate moves, the price displacement `minDisplacementSigma` demands
 *  moves with it and neither side has done anything. (⚠ The denominator is
 *  `sigma_diffusive`, not `sigma_total` — they are equal on 4,026 of the archive's 4,121
 *  directional series-polls and this sentence said `sigma_total` until 2026-09-13, when
 *  a second capture put them side by side. `FEED_SIGMA_WATCH` keys on `sigma_total`,
 *  which is the wider of the two and the one `tasks/43` §2 measured its band on; that is
 *  a choice the watcher documents rather than an oversight, and moving it would move the
 *  band with no evidence behind the new one.) That has happened twice in twelve
 *  days and moved a live constant both times, and between 2026-09-10 and 2026-09-13 the
 *  constant carried no condition that could fire.
 *
 *  **The statistic is the per-pair median ratio, never the basket median.** The basket's
 *  absolute median swings 1.52x inside the untouched baseline week; the per-pair ratio
 *  reads 1.00-1.02x across the same days. One of those can carry a threshold.
 *
 *  ── the band, argued (`notes/2026-09-13-a-watcher-for-the-denominator.md`) ──
 *
 *  **The floor is 0.983..1.046.** Each baseline day scored against the other four reads
 *  within ±4.6% of 1.00, with nothing happening. A band narrower than that fires on the
 *  statistic's own noise.
 *
 *  **±10% is the tightest round band that clears the floor, and the width is not
 *  load-bearing.** Every band from [0.90, 1.10] to [0.85, 1.25] selects exactly the same
 *  two days out of fourteen — 2026-09-05 at 1.278x and 2026-09-12 at 1.398x. The
 *  distribution is bimodal: ordinary days sit in 0.90..1.06 and an excursion jumps past
 *  1.27. So the band is chosen at the floor, where it is defensible, rather than tuned.
 *
 *  **`sustainedDays: 2`, and this is the part the measurement changed.** `tasks/43` §2.1
 *  posed the design question as a tension — *"a band tight enough to catch 09-05 fires on
 *  a one-day excursion that self-corrects"*. Measured, that tension does not exist,
 *  because **every excursion in the archive is a one-day excursion**: no two consecutive
 *  days have ever been outside any of those bands, and a trailing 3-day median never
 *  leaves ±10% at all. So a duration test cannot separate a spike from a re-basing — it
 *  can only separate *not yet* from *it stayed*. One day outside is reported; two
 *  consecutive days outside is the bar for touching the constant, and it has never been
 *  reached. If it fires it is new information, which is what a trip-wire is for.
 *
 *  **What happens when it fires is named and is not automatic.** The alarm carries the
 *  gate-equivalent — the `minDisplacementSigma` that would demand today what the current
 *  value demanded in the reference window — and asks for that commit. Nothing here
 *  writes a constant: a default that self-reverts is `docs/STATUS.md` item 29b and is
 *  undecided, and `tasks/47`'s speed limit is the machinery it would need. */
/** **What the desk watches about itself**, as opposed to about the feed.
 *
 *  `tasks/47` Rule 5's watcher list, plus the two the owner added on 2026-09-12 after
 *  `notes/2026-09-12-the-four-accounts-after-the-screenshot.md` found that at 17:25Z on
 *  09-10 **all four funded accounts held the identical book** — SILVER long, AAPL short,
 *  NATGAS short, COPPER long — and that three of them halted within six minutes of each
 *  other. The owner's decision that day was **no concentration cap**: accounts run
 *  different settings, so one count is a different share of every book, and a cap would
 *  bind arbitrarily. What was asked for instead is that somebody be *told*.
 *
 *  ⚠ **Deliberately not inside `RISK_PARAMS`.** These are alarm thresholds, not money
 *  constants: nothing here sizes, gates or exits anything. Putting them in one of the five
 *  fingerprinted objects would move `configHash` on deploy, which writes a `config` event,
 *  which `expectancy` counts — and the block accumulating for `docs/STATUS.md` item 1's
 *  reading already holds one, so a second would make that reading unscoreable. A watcher
 *  that costs a reading to install is the wrong watcher. */
export const DESK_WATCH = {
  /** N halts in M minutes. **Three in six** is what 09-10 actually did, so the alarm is
   *  set to fire on a repeat of it and not more tightly: two accounts halting in an hour
   *  is a correlated book doing its job, and three inside half an hour is the mechanism.
   *  ⚠ It cannot fire on the first halt, by construction, and that is correct — one halt
   *  already has its own alert (`exec-halted`) and has had since Phase 1. */
  haltCount: 3,
  haltWindowMin: 30,
  /** The share of the desk's open positions that one coin-and-side may reach before the
   *  daily line says so. **0.5 is a reporting threshold and bounds nothing** — at the
   *  09-10 peak four accounts held four identical positions each, so every one of the four
   *  legs sat at exactly 1.00 of the accounts and 0.25 of the positions. The number that
   *  actually described it is `identicalBooks`, below; this one catches the narrower case
   *  of one call everybody piled into. */
  concentrationWarn: 0.5,
  /** Below this many distinct events in a block, the cohort comparison **refuses to
   *  score** rather than printing a number nobody should read. Same floor and same shape
   *  as `feed-sigma`'s refusal: *"cannot score"* and *"they are the same"* are different
   *  claims, and the second is the one a tripwire must never make by accident. */
  cohortFloor: 12,
} as const;

export const FEED_SIGMA_WATCH = {
  /** The window every ratio is measured against, by `FEED_REGIMES` name. Five days,
   *  ours, untouched by either side — the only window in the archive long enough to be
   *  a baseline. ⚠ It is **not** the regime `minDisplacementSigma` was last chosen in:
   *  `reverted` is two days and `npm run feed-sigma` refuses a baseline that short, for
   *  the reason in `resolveWindow`. The offset is known and stated rather than hidden —
   *  the reverted feed read 0.92x and 0.90x of this baseline — so a ratio here is an
   *  elevation against the archive's quiet week, not against the day of the decision. */
  baseline: "pre-09-04",
  /** Outside this and the day is reported loudly. Inclusive; see the argument above. */
  band: [0.90, 1.10] as readonly [number, number],
  /** Consecutive complete days outside the band before the alarm asks for a commit. */
  sustainedDays: 2,
  /** Days of archive below which nothing is scored. `feed-sigma` refuses a baseline
   *  under three days; this is the same refusal for the watcher, which runs unattended
   *  and must never turn a thin archive into a confident ratio. */
  minBaselineDays: 3,
} as const;

// `checkCapConsistency` — the startup sanity check on the cap set — lives in
// `src/risk/halt.ts` since `tasks/19`, beside the arithmetic the desk prints, so the
// warning an operator reads and the sentence an owner reads are one number.
