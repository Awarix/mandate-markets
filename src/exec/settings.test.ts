import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATOR_CHANGE, OPERATOR_CHANGE_EVERYONE, settingsScope } from "./settings.ts";

// `tasks/47` Rule 4, second part. The night this guard exists for: 2026-09-10, when a
// stop default moved and ten of fourteen accounts were rewritten to it, seven of them
// other people's. The next day's reading had nineteen control trips out of 176.

const OURS = [
  "0xacc000021db30319be75d26a29642946e21929e7",
  "0xacc000039752b2078903c492e5e617b4b3566559",
  "0xacc00001c53162712f3d8d10764b5e7b17d1c08a",
];
const STRANGER = (n: number) => `0x${String(n).repeat(40).slice(0, 40)}`;

const scope = (over: Partial<Parameters<typeof settingsScope>[0]> = {}) => settingsScope({
  master: STRANGER(9), everyone: false, ourAccounts: OURS, changedToday: [], ...over,
});

test("the day's budget is the number of accounts we pin with a file", () => {
  assert.equal(scope({ changedToday: [] }).ok, true);
  assert.equal(scope({ changedToday: [STRANGER(1), STRANGER(2)] }).ok, true);
  const refused = scope({ changedToday: [STRANGER(1), STRANGER(2), STRANGER(3)] });
  assert.equal(refused.ok, false);
  // The refusal has to say what it is protecting, not only that it refused.
  assert.match(refused.ok ? "" : refused.reason, /budget of 3/);
  assert.match(refused.ok ? "" : refused.reason, /--everyone/);
  assert.match(refused.ok ? "" : refused.reason, /Nothing was changed/);
});

// The 09-10 move, priced by this guard: three accounts, eleven left as the control.
test("ten accounts in one night reaches three and stops", () => {
  const moved: string[] = [];
  let reached = 0;
  for (let i = 1; i <= 10; i++) {
    const addr = STRANGER(i);
    if (!scope({ master: addr, changedToday: moved }).ok) break;
    moved.push(addr);
    reached++;
  }
  assert.equal(reached, 3);
});

// One decision being corrected is not a second cohort being moved. Typing the wrong
// percentage and retyping it must not cost a slot.
test("re-editing an account already moved today costs nothing further", () => {
  const addr = STRANGER(1);
  const full = [STRANGER(1), STRANGER(2), STRANGER(3)];
  assert.equal(scope({ master: addr, changedToday: full }).ok, true);
  assert.equal(scope({ master: STRANGER(4), changedToday: full }).ok, false);
});

test("case is not an account: the same address in another spelling is the same slot", () => {
  const addr = STRANGER(1);
  const full = [addr.toUpperCase().replace("0X", "0x"), STRANGER(2), STRANGER(3)];
  assert.equal(scope({ master: addr, changedToday: full }).ok, true);
});

// A box with no `accounts/` files has nothing of its own to move first. The guard is a
// speed limit and must not become a lock.
test("with no accounts of our own the budget is one, not zero", () => {
  assert.equal(scope({ ourAccounts: [], changedToday: [] }).ok, true);
  assert.equal(scope({ ourAccounts: [], changedToday: [STRANGER(1)] }).ok, false);
});

// `--everyone` is not a bypass that hides: the word goes on every event row it writes,
// so a day that was overridden is legible as one afterwards.
test("--everyone passes, and says so on the row", () => {
  const v = scope({ everyone: true, changedToday: [STRANGER(1), STRANGER(2), STRANGER(3)] });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.why, OPERATOR_CHANGE_EVERYONE);
  assert.ok(OPERATOR_CHANGE_EVERYONE.includes(OPERATOR_CHANGE), "and it is still counted by the budget query");
  assert.match(OPERATOR_CHANGE_EVERYONE, /--everyone/);
});
