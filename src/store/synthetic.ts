// Intents the executor really did place, on a real account, with real money — but
// against a signal that did not come from Quotient. They are the record of an operator
// test and they are **not** signal outcomes, so nothing that measures whether the feed
// makes money may count them.
//
// Why a list here rather than a column on `intents`: a column would have to be written
// by something, and the only thing that could write it is a hand-run UPDATE — which is
// the same trust as this list, with a migration and a write path attached. A column
// also travels silently; a constant with the argument beside it does not. If operator
// tests ever become routine the column is the right answer and this file is the
// evidence for it.
//
// Nothing is deleted. The ledger is the record of what the executor did, and it did do
// these; the correction belongs at the point of measurement.

export type SyntheticIntent = { intentId: string; why: string };

/** The `tasks/21` §10 acceptance runs of 2026-09-05, on `0xdaa2…c81c`.
 *  `notes/2026-09-05-tasks-15-18-19-21-live-check.md` §2 and §6 are the record. */
export const SYNTHETIC_INTENTS: readonly SyntheticIntent[] = [
  // Run 1, 10:53Z. Real published Quotient numbers from the committed capture
  // `fixtures/perps-2026-08-30.json`, but with `anchor_at` shifted to nine minutes out
  // so the horizon would close them inside the test. A nine-minute hold at 20x measures
  // noise, not the outlook.
  { intentId: "7910023e-a3e7-4023-bc9e-bd507e915f7d", why: "tasks/21 §10 run 1 — real signal, fabricated 9-minute horizon" },
  { intentId: "a798eb40-21b0-4ba4-86a8-b44d836df063", why: "tasks/21 §10 run 1 — real signal, fabricated 9-minute horizon" },
  // Run 2, 11:20Z. Targets *constructed* against the live mark (3% edge, sigma_total
  // 0.015) because no real capture could supply four simultaneously-valid signals that
  // day. These are not Quotient outcomes in any sense.
  { intentId: "888abe34-cb52-40f9-a60c-80ae2853fef4", why: "tasks/21 §10 run 2 — target constructed against the live mark" },
  { intentId: "49990d99-3e2a-4c60-a1f1-52e09fff7fc0", why: "tasks/21 §10 run 2 — target constructed against the live mark" },
  { intentId: "a0da5eaf-1dad-46a7-90a3-ae8790eff136", why: "tasks/21 §10 run 2 — target constructed against the live mark" },
  { intentId: "78023e14-fc80-4c63-85a6-4c654f9d16da", why: "tasks/21 §10 run 2 — target constructed against the live mark" },
  // The builder-fee x referral run of 2026-09-10, on the test wallet `0xacc00002…`.
  // Same method as run 1 above and for the same reason: the committed real capture
  // with `as_of` and every `anchor_at` shifted nine minutes out, replayed through the
  // executor's own path with `SIGNAL_SOURCE=file` behind an `HL_MASTER_ADDRESS` pin so
  // no other account could be reached. A nine-minute hold at 10x measures the fee
  // schedule, which is what it was for; it measures nothing about the outlook.
  // `notes/2026-09-10-builder-fee-and-referral-together.md` is the record.
  { intentId: "e3b8e00b-fea5-4065-bb66-1ebaa174da4a", why: "2026-09-10 fee test — real signal, fabricated 9-minute horizon" },
  { intentId: "ec2eee0e-354d-4481-9559-f1a8120d4126", why: "2026-09-10 fee test — real signal, fabricated 9-minute horizon" },
  { intentId: "06469c84-4486-4ed1-a058-fa530e0f1777", why: "2026-09-10 fee test — real signal, fabricated 9-minute horizon" },
];

const IDS = new Set(SYNTHETIC_INTENTS.map((s) => s.intentId));

export function isSyntheticIntent(intentId: string): boolean {
  return IDS.has(intentId);
}

/** A SQL fragment excluding them, for the analysis scripts' own queries.
 *
 *  Inlined rather than parameterised because these ids are a compile-time constant and
 *  the fragment is composed into `WHERE` clauses in three scripts; the literals are
 *  asserted to be plain UUIDs below so nothing can be smuggled in.
 *
 *  @param col the qualified column, e.g. `"i.intent_id"`. */
export function excludeSyntheticSql(col = "intent_id"): string {
  if (IDS.size === 0) return "1=1";
  return `${col} NOT IN (${[...IDS].map((id) => `'${id}'`).join(", ")})`;
}

for (const { intentId } of SYNTHETIC_INTENTS) {
  if (!/^[0-9a-f-]{36}$/.test(intentId)) throw new Error(`not a plain uuid: ${intentId}`);
}

/** One line for a script to print, so a reading always says what it left out. */
export function syntheticNote(): string {
  return `excluding ${SYNTHETIC_INTENTS.length} operator-test intent(s) — tasks/21 §10 ` +
    "(2026-09-05) and the fee test (2026-09-10) (src/store/synthetic.ts)";
}
