// The five settings that are not the default, and the reason each one is in the list.
//
// **Test-only, and one list rather than two copies.** `exec/loop.test.ts` runs each of
// these end to end through the paper broker and `risk/governor.test.ts` runs each
// through `preTradeCheck`; a second copy in the second file is a second copy that
// drifts, and the point of `tasks/46` §3.2 is that the *same* five reach both.
//
// **Why the list exists.** `DEFAULT_USER_SETTINGS` — 10x / 10% / 2% / stop on / hold
// off — was, until 2026-09-13, the only complete settings object any test instantiated.
// Off-default coverage was arithmetic-only: `halt.test.ts` and `ledger.test.ts` call
// `stopsToHalt` with other numbers and nothing ran them through the loop. So the site
// sold four leverages, three of which no test had ever placed an order at; it sold
// stops to 8%, which no test had ever armed; and **no loop test reached a daily-loss
// halt at any position size**, on a desk where the account that actually halted on
// 2026-09-10 was running 25% per signal.
//
// The five are chosen to be the corners a real owner can reach from the connect screen,
// not a grid: the weakest combination it offers, the two leverages that differ only in
// what they can arm, the size that halts on one stop, and the exit policy the site still
// holds back.
//
// ⚠ **`tasks/46` §3.2 named `blockReentryAfterStop: false` as the fifth and it is not a
// `UserSettings` field** — it is a `RISK_PARAMS` constant, so the governor cannot be
// handed it and it cannot go in this list. Its `false` branch is executed by its own
// test in `exec/loop.test.ts`, which is the only place it can be. `holdToTarget: true`
// takes the fifth slot here: it is a user setting, it is the one the connect screen is
// still holding back, and it had never been through `preTradeCheck`.

import { DEFAULT_USER_SETTINGS, type UserSettings } from "./params.ts";

export type SettingsCase = {
  /** Used in the test name, so a failure says which corner broke. */
  name: string;
  settings: UserSettings;
  /** One line on what this case is for — read it before changing the numbers. */
  why: string;
};

export const SETTINGS_CASES: readonly SettingsCase[] = [
  {
    name: "5x / 5% / 8% — the weakest the site offers",
    settings: { ...DEFAULT_USER_SETTINGS, leverage: 5, perSignalPct: 0.05, stopPct: 0.08 },
    why: "the combination that sets the funding floor at $40.41, and the only one where an 8% " +
      "stop arms in full: 5x leaves 13.1% of room on a 40x-max market against 10x's 6.1%",
  },
  {
    name: "18x / 10% / 2% — the leverage that exists because of the clamp",
    settings: { ...DEFAULT_USER_SETTINGS, leverage: 18 },
    why: "18x arms a full 2.00% on a 20x-max market (its ceiling is 2.14%) where 20x arms 1.75%, " +
      "which is the whole argument for the tier (notes/2026-09-12-how-a-20x-account-arms-a-2-percent-stop.md)",
  },
  {
    name: "20x / 25% / 2% — the account that halted on 2026-09-10",
    settings: { ...DEFAULT_USER_SETTINGS, leverage: 20, perSignalPct: 0.25 },
    why: "the clamp bites (2% asked, 1.75% armed), the book is four positions and the whole budget, " +
      "and `stopsToHalt` is 1.01 — one stopped position reaches the daily-loss cap",
  },
  {
    name: "the stop off",
    settings: { ...DEFAULT_USER_SETTINGS, stopLoss: false },
    why: "`stopOutOfMargin` is 1 rather than `stopPct × leverage`: isolated margin is the whole " +
      "protection, and nothing rests on the venue but a target",
  },
  {
    name: "hold to resolve",
    settings: { ...DEFAULT_USER_SETTINGS, holdToTarget: true },
    why: "the one setting whose wrong answer costs 30% of a position rather than 3%, and the one " +
      "the connect screen still holds back (docs/STATUS.md item 5)",
  },
];
