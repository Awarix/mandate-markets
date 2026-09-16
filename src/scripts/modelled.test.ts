import { strict as assert } from "node:assert";
import { test } from "node:test";
import { BUILDER_FEE, RISK_PARAMS } from "../risk/params.ts";
import { modelled, modelledTable, type ScriptName } from "./modelled.ts";

// `tasks/46` §2.5: the table is "asserted by one test that reads the same function".
//
// What is worth asserting is not the words — they are prose and they should be free to
// improve — but the three properties that make the table load-bearing: every script
// answers for every mechanism, no refusal is a bare "not modelled", and **every clause
// that quotes a money constant derives it** rather than spelling a digit that can rot.
// The last is `tasks/46` §3.3 applied to output instead of to a test.

const SCRIPTS: ScriptName[] = ["backtest", "stop-sweep", "exit-policy"];

const MECHANISMS = [
  "entry", "stop", "target", "fee", "funding", "band", "re-entry", "re-gate", "halt", "interval",
];

test("every script answers for every mechanism, in one order", () => {
  for (const s of SCRIPTS) {
    assert.deepEqual(modelled(s).map((r) => r.what), MECHANISMS,
      `${s} must answer for all ten mechanisms in the same order — a table that omits a row ` +
      "reads as a mechanism that does not exist");
  }
});

test("no refusal is a bare refusal: every `no` and `partial` says what is missing", () => {
  for (const s of SCRIPTS) {
    for (const r of modelled(s)) {
      if (r.fidelity === "yes") continue;
      // Long enough to carry a clause. The failure this guards is a future row reading
      // `partial` with `how: "not modelled"`, which is the state the header comments were
      // in before this file existed.
      assert.ok(r.how.length > 40,
        `${s}/${r.what} is "${r.fidelity}" but says only "${r.how}" — a partial whose clause ` +
        "does not name the part that is missing is a yes that has not been checked");
      assert.ok(!/^not modelled\.?$/i.test(r.how.trim()), `${s}/${r.what}: "not modelled" is not a clause`);
    }
  }
});

test("the executor column derives its numbers from the constants, so a moved constant moves the table", () => {
  // One row per constant that appears in the executor's own description. If a constant
  // moves and this table keeps the old digits, every reader of every sweep is told the
  // desk does something it stopped doing — which is the class of error `tasks/46` was
  // written about.
  const rows = modelled("backtest");
  const find = (what: string) => rows.find((r) => r.what === what)!;

  assert.match(find("band").executor, new RegExp(`\\b${RISK_PARAMS.slippageBps}bps\\b`),
    "the band row must quote RISK_PARAMS.slippageBps");
  assert.match(find("entry").executor, new RegExp(`\\b${RISK_PARAMS.slippageBps}bps\\b`),
    "the entry row must quote the same band the executor arms");
  assert.match(find("halt").executor, new RegExp(`\\b${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}%`),
    "the halt row must quote RISK_PARAMS.dailyLossPct");
  assert.match(find("re-gate").executor, new RegExp(`${RISK_PARAMS.minDisplacementSigma}`),
    "the re-gate row must quote the gate in force");
  assert.match(find("fee").how, new RegExp(`\\b${BUILDER_FEE.tenthsBp}\\b`),
    "the fee row must quote BUILDER_FEE.tenthsBp");
});

test("the stop is never `yes` anywhere: a stop-limit that can miss is modelled by nothing", () => {
  // The one fidelity claim this desk has been wrong about twice. `exit-policy.ts` still
  // said "no stop has ever fired on this account" on 2026-09-12, when 107 had, and the
  // 09-10 COPPER liquidation is a stop that missed entirely. No script may claim to
  // reproduce it.
  for (const s of SCRIPTS) {
    const stop = modelled(s).find((r) => r.what === "stop")!;
    assert.notEqual(stop.fidelity, "yes", `${s} claims to model the stop; a stop-limit can miss`);
    assert.match(stop.how, /miss|3\.3bps|trigger/,
      `${s}'s stop clause must say where the modelled fill sits against the real one`);
  }
});

test("the options flip the rows they name, and nothing else", () => {
  const off = modelled("backtest", { builderFee: false, reentry: false });
  const on = modelled("backtest", { builderFee: true, reentry: true });
  assert.equal(off.find((r) => r.what === "fee")!.fidelity, "partial");
  assert.equal(on.find((r) => r.what === "fee")!.fidelity, "yes");
  assert.equal(off.find((r) => r.what === "re-entry")!.fidelity, "no");
  assert.equal(on.find((r) => r.what === "re-entry")!.fidelity, "partial");
  // Every other row is untouched by the two flags.
  for (const what of MECHANISMS.filter((m) => m !== "fee" && m !== "re-entry")) {
    assert.deepEqual(off.find((r) => r.what === what), on.find((r) => r.what === what),
      `${what} must not move with --reentry or --no-builder-fee`);
  }
});

test("the interval row names the interval in force, because it sets how far back the venue serves", () => {
  assert.match(modelled("backtest", { interval: "15m" }).find((r) => r.what === "interval")!.how, /15m/);
  assert.match(modelled("backtest").find((r) => r.what === "interval")!.how, /5m/);
});

test("the table prints every row and counts the refusals honestly", () => {
  for (const s of SCRIPTS) {
    const rows = modelled(s);
    const text = modelledTable(s);
    for (const r of rows) {
      assert.ok(text.includes(r.what), `${s}: the table omits ${r.what}`);
      assert.ok(text.includes(r.how), `${s}: the table truncates ${r.what}'s clause`);
    }
    const no = rows.filter((r) => r.fidelity === "no").length;
    const partial = rows.filter((r) => r.fidelity === "partial").length;
    assert.ok(text.includes(`${rows.length - no - partial} of ${rows.length} reproduced, ${partial} partial, ${no} not`),
      `${s}: the summary line must count what the rows say`);
    assert.ok(text.includes("not a correction"), `${s}: the table must refuse to be used as a correction factor`);
    // Only `backtest` has a replication row; the other two must not imply one they do
    // not print. A reader who goes looking for a check that is not there concludes the
    // opposite of what the missing check would have said.
    if (s === "backtest") {
      assert.ok(text.includes("replication row below"), "backtest must point at the row it prints");
    } else {
      assert.ok(!text.includes("replication row below"), `${s} has no replication row and must not imply one`);
      assert.ok(text.includes("does not apply and is not implied"), `${s} must say why the check is absent`);
    }
  }
});
