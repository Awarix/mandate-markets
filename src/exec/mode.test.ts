import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_MANDATE, minFundedForLiveUsd, RISK_PARAMS } from "../risk/params.ts";
import { canBeRefusedForSlot, resolveMode } from "./mode.ts";

const MASTER = "0xacc00001C53162712f3d8D10764B5E7b17D1C08A";
/** An ordinary funded account. There is no longer a size at which the answer changes:
 *  the per-account dollar ceiling and the funding limit derived from it were removed
 *  on 2026-08-31, so these constants exist only to be readable. */
const FUNDED = 100;
const LARGE = 50_000;

const armed = { DRY_RUN: "false", HL_LIVE_ACCOUNT: MASTER };

test("no environment is paper", () => {
  assert.equal(resolveMode(MASTER, FUNDED, {}).mode, "paper");
});

test("DRY_RUN unset or anything but 'false' is paper", () => {
  for (const v of [undefined, "true", "TRUE", "", "0", "no"]) {
    assert.equal(resolveMode(MASTER, FUNDED, { ...armed, DRY_RUN: v }).mode, "paper", `DRY_RUN=${v}`);
  }
});

test("live also needs the account permitted, not just DRY_RUN=false", () => {
  const r = resolveMode(MASTER, FUNDED, { DRY_RUN: "false", HL_LIVE_ACCOUNT: "0xsomeoneelse" });
  assert.equal(r.mode, "paper");
  assert.ok(r.why.includes("not enabled for live trading"), r.why);
});

test("the account opt-in is case-insensitive, since HL addresses are echoed both ways", () => {
  const r = resolveMode(MASTER, FUNDED, { ...armed, HL_LIVE_ACCOUNT: MASTER.toLowerCase() });
  assert.equal(r.mode, "live", r.why);
});

// The rule that replaced the per-account ceiling on 2026-08-31: **the deposit is the
// size**. A ceiling under it managed $100 of someone's $300 while their screen said
// they were connected, which is not a safety property but a silent refusal to do what
// they asked. `src/risk/params.ts` carries the full argument.
test("an account is traded at everything it holds, at any size", () => {
  for (const held of [40, 100, 317.42, LARGE]) {
    const r = resolveMode(MASTER, held, armed);
    assert.equal(r.mode, "live", r.why);
    assert.equal(r.baseCapitalUsd, held, `$${held} must not be scaled down`);
    assert.doesNotMatch(r.why, /sits idle/, "nothing is held back any more");
  }
});

test("no amount of funding refuses an account outright", () => {
  // A cent over $500 used to come up paper, with a reason naming a constant only a
  // commit could change. There is no such cliff left to fall off.
  for (const held of [500.01, 1_000, LARGE]) {
    const r = resolveMode(MASTER, held, armed);
    assert.equal(r.mode, "live", `$${held}: ${r.why}`);
    assert.equal(r.blocked, false);
  }
});

// **The invariant that let the funding limit go.** `dayLossFrac` measures the halt
// against account equity, while what we can lose is bounded by baseCapital. The clamp
// made those two numbers differ, so past `dailyLossPct × equity > maxDeployedPct ×
// baseCapital` a breach needed a bigger loss than we could deploy and the halt could
// never fire — which is what the $500 refusal was guarding. With baseCapital == equity
// the comparison is between two fractions of the same number, and it holds at every
// size. Reintroduce a clamp, or raise dailyLossPct past maxDeployedPct, and this fails.
test("the daily-loss halt stays reachable at every account size", () => {
  assert.ok(
    RISK_PARAMS.dailyLossPct <= RISK_PARAMS.maxDeployedPct,
    "a halt measured against equity cannot fire if it needs a bigger loss than we can deploy",
  );
  for (const held of [40, 100, 500, LARGE]) {
    const base = resolveMode(MASTER, held, armed).baseCapitalUsd;
    assert.equal(base, held, "baseCapital must equal equity for the halt to be reachable");
    assert.ok(RISK_PARAMS.dailyLossPct * held <= RISK_PARAMS.maxDeployedPct * base!);
  }
});

// The floor that replaced the ceiling, and the only funding threshold left. Below it
// every signal is skipped as `below-min-notional` and the account trades nothing while
// looking perfectly connected — enforced in `connectAccount`, quoted by the connect
// screen, and derived here rather than written down.
// ⚠ The last two assertions are a **deliberate tripwire** on `$10.11` and `$40.41` —
// the two figures the connect screen quotes in prose and a stranger funds against
// (`tasks/46` §3.3, which asked that such tests say so in their name). Everything above
// them is derived; those two are not, and are meant to fail when `minOrderNotionalUsd`
// or `reserveFrac` moves, because the copy has to move with them.
test("TRIPWIRE: the funding floor is derived from the order minimum and the user's settings", () => {
  const min = (perSignalPct: number, leverage: 5 | 10 | 20) =>
    minFundedForLiveUsd({ perSignalPct, leverage });

  // One signal at exactly the floor is worth at least HL's minimum notional. Sizing
  // runs off the mandate less the reserve, so the base has to carry both — and the
  // figure is rounded *up* to the cent, which is why this is `>=` rather than `===`.
  for (const [pct, lev] of [[0.10, 10], [0.05, 5], [0.25, 20]] as const) {
    const notionalAtFloor = min(pct, lev) * (1 - RISK_PARAMS.reserveFrac) * pct * lev;
    assert.ok(notionalAtFloor >= RISK_PARAMS.minOrderNotionalUsd,
      `${pct}/${lev}x: $${notionalAtFloor.toFixed(4)} is under the $${RISK_PARAMS.minOrderNotionalUsd} minimum`);
    // A cent of *base* is worth `pct × leverage` cents of notional, so the round-up
    // shows up here multiplied — 5 cents at 25%/20x. Still the tightest floor that is
    // expressible in money.
    assert.ok(notionalAtFloor < RISK_PARAMS.minOrderNotionalUsd + 0.01 * pct * lev,
      `${pct}/${lev}x: $${notionalAtFloor.toFixed(4)} overshoots by more than the round-up`);
  }
  // The two figures the connect screen quotes: the default, and the weakest
  // combination its sliders offer. Both gained a rounded-up cent to the reserve — a
  // floor quoted low is not a floor.
  assert.equal(min(0.10, 10), 10.11);
  assert.equal(min(0.05, 5), 40.41);
  // Smaller settings need *more* capital, which is the direction people get wrong.
  assert.ok(min(0.05, 5) > min(0.10, 10));
});

test("an unfunded or unreadable account is paper, never live", () => {
  for (const v of [0, -1, NaN, Infinity]) {
    const r = resolveMode(MASTER, v, armed);
    assert.equal(r.mode, "paper", `capital=${v}`);
    assert.equal(r.baseCapitalUsd, null);
  }
});

test("paper never reports a live base capital", () => {
  assert.equal(resolveMode(MASTER, FUNDED, {}).baseCapitalUsd, null);
});

// A tripwire, not a preference. There were two of these — one on the dollar ceiling,
// one on the account cap — and the ceiling's went with the ceiling. What is left has to
// carry more weight, because `maxLiveAccounts` is now the only hard bound on live
// trading: nothing else refuses anything in dollars.
test("no dollar cap has quietly come back", () => {
  assert.ok(
    !("maxBaseCapitalUsd" in LIVE_MANDATE) && !("maxTotalLiveCapitalUsd" in LIVE_MANDATE),
    "a per-account or aggregate dollar cap was removed deliberately on 2026-08-31 — " +
    "reintroducing one means clamping baseCapital below equity again, which is what " +
    "made the daily-loss halt unreachable. Read LIVE_MANDATE before adding it back.",
  );
  assert.equal(LIVE_MANDATE.purpose, "execution-validation");
});

// A second live account is the first time the per-account ceiling has to compose,
// and it does not. These pin the two mechanisms that make it safe: an allowlist that
// can name more than one address, and an aggregate cap checked before arming — in
// accounts, because what it bounds is how many people one bug of ours can reach.

const LIVE_ENV = (accounts: string) => ({ DRY_RUN: "false", HL_LIVE_ACCOUNT: accounts });

test("HL_LIVE_ACCOUNT arms every address it lists, and nothing else", () => {
  const a = "0xAAA0000000000000000000000000000000000001";
  const b = "0xbbb0000000000000000000000000000000000002";
  const c = "0xccc0000000000000000000000000000000000003";
  const env = LIVE_ENV(`${a}, ${b}`);

  assert.equal(resolveMode(a, 100, env).mode, "live");
  assert.equal(resolveMode(b, 100, env).mode, "live", "a second address must arm too");
  assert.equal(resolveMode(c, 100, env).mode, "paper", "an address not listed stays paper");
  // Case must not decide whether real money moves.
  assert.equal(resolveMode(a.toLowerCase(), 100, env).mode, "live");
  assert.equal(resolveMode(b.toUpperCase().replace("0X", "0x"), 100, env).mode, "live");
});

test("an empty or unset HL_LIVE_ACCOUNT arms nothing", () => {
  const a = "0xAAA0000000000000000000000000000000000001";
  assert.equal(resolveMode(a, 100, { DRY_RUN: "false" }).mode, "paper");
  assert.equal(resolveMode(a, 100, LIVE_ENV("")).mode, "paper");
  assert.equal(resolveMode(a, 100, LIVE_ENV("  ,  ")).mode, "paper");
});

test("the account cap is checked before arming, not after", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };
  const cap = LIVE_MANDATE.maxLiveAccounts;

  // Nothing armed yet: the account arms at what it holds.
  const first = resolveMode(stranger, 100, env, 0);
  assert.equal(first.mode, "live");
  assert.equal(first.baseCapitalUsd, 100);

  // The last free slot is allowed; one past it is not.
  assert.equal(resolveMode(stranger, 100, env, cap - 1).mode, "live");
  const over = resolveMode(stranger, 100, env, cap);
  assert.equal(over.mode, "paper", "the account that would breach the cap goes paper");
  assert.match(over.why, /maxLiveAccounts/);
  assert.equal(over.baseCapitalUsd, null);
});

test("self-service accounts fill the slots, and the one past the cap is refused", () => {
  const env = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };
  const addr = (n: number) => `0x${String(n).padStart(40, "0")}`;

  // Armed one at a time, exactly as the runner does it.
  let used = 0;
  const modes: string[] = [];
  for (let i = 0; i <= LIVE_MANDATE.maxLiveAccounts; i++) {
    const d = resolveMode(addr(i), 500, env, used);
    modes.push(d.mode);
    if (d.mode === "live") used += 1;
  }
  assert.equal(used, LIVE_MANDATE.maxLiveAccounts);
  assert.equal(modes.filter((m) => m === "live").length, LIVE_MANDATE.maxLiveAccounts);
  assert.equal(modes.at(-1), "paper", "the account past the cap is refused live");
});

// The defect that killed the dollar total: it had no exemption, so the first two
// strangers to connect consumed all $200 and an address deliberately named in
// HL_LIVE_ACCOUNT came up paper behind them. Arrival order is not an authority.
test("an allowlisted account is never displaced by self-service accounts", () => {
  const mine = "0xAAA0000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", HL_LIVE_ACCOUNT: mine, LIVE_SELF_SERVICE: "true" };

  // Every slot taken, and then some — the operator's account still arms.
  for (const used of [0, LIVE_MANDATE.maxLiveAccounts, LIVE_MANDATE.maxLiveAccounts * 10]) {
    const d = resolveMode(mine, 100, env, used, "live");
    assert.equal(d.mode, "live", `allowlisted account refused with ${used} slots in use: ${d.why}`);
    assert.equal(d.baseCapitalUsd, 100);
  }
});

// The counting rule and the refusal rule are separate since `tasks/17`: an
// allowlisted account is counted like any other and only exempt from being refused.
test("an allowlisted account is exempt from the refusal, not from the count", () => {
  const mine = "0xAAA0000000000000000000000000000000000001";
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", HL_LIVE_ACCOUNT: mine, LIVE_SELF_SERVICE: "true" };

  assert.equal(canBeRefusedForSlot(mine, env), false);
  assert.equal(canBeRefusedForSlot(mine.toLowerCase(), env), false, "case must not decide this");
  assert.equal(canBeRefusedForSlot(stranger, env), true);
});

// ── The cap has no incumbency (`tasks/34`) ──────────────────────────────────
//
// From a real incident on 2026-09-10: adding one address to HL_LIVE_ACCOUNT pushed
// `0xf03ca6…`, funded and trading for ten days, out of management. Slots are consumed
// by a running count over an arbitrary (sorted) order, and nothing in that count knew
// which accounts were live a minute ago, so the last one enumerated lost. It was flat,
// and that was luck: a dropped account keeps its venue-side stops and loses the
// signal-change exit, the horizon close, the daily-loss halt and foreign-actor
// detection — the state `docs/USER-JOURNEY.md` §15 makes a user *confirm*.

test("an account already trading live is not dropped for a slot", () => {
  const incumbent = "0xf03c000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };
  const cap = LIVE_MANDATE.maxLiveAccounts;

  // Enumerated last, with every slot already taken — the exact shape of the incident.
  for (const used of [cap, cap + 1, cap * 10]) {
    const d = resolveMode(incumbent, FUNDED, env, used, "live", true);
    assert.equal(d.mode, "live", `incumbent dropped with ${used} slots in use: ${d.why}`);
    assert.equal(d.baseCapitalUsd, FUNDED);
  }

  // And the newcomer beside it, identical but for incumbency, still loses.
  const newcomer = resolveMode(incumbent, FUNDED, env, cap, "live", false);
  assert.equal(newcomer.mode, "paper");
  assert.match(newcomer.why, /maxLiveAccounts/);
  assert.match(newcomer.why, /never armed/, "the refusal must say which kind of account this is");
});

// The acceptance test tasks/34 asks for, driven the way the runner drives it.
test("cap+1 accounts with one already live: the incumbent survives, the newcomer is refused", () => {
  const env = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };
  const cap = LIVE_MANDATE.maxLiveAccounts;
  // Sorted order puts the incumbent last, which is what made it lose before.
  const addrs = Array.from({ length: cap + 1 }, (_, i) => `0x${String(i).padStart(40, "0")}`);
  const incumbent = addrs.at(-1)!;

  let used = 0;
  const decided = new Map<string, string>();
  for (const a of addrs) {
    const d = resolveMode(a, 500, env, used, "live", a === incumbent);
    decided.set(a, d.mode);
    if (d.mode === "live") used += 1;
  }

  assert.equal(decided.get(incumbent), "live", "the account we were already trading must survive");
  assert.equal(used, cap + 1, "an incumbent holds the count above the cap rather than being dropped");
  assert.equal([...decided.values()].filter((m) => m === "paper").length, 0);

  // Same set, nobody incumbent: the cap binds exactly as it did before.
  let plainUsed = 0;
  const plain = addrs.map((a) => {
    const d = resolveMode(a, 500, env, plainUsed, "live", false);
    if (d.mode === "live") plainUsed += 1;
    return d.mode;
  });
  assert.equal(plainUsed, cap);
  assert.equal(plain.at(-1), "paper");
});

// Incumbency buys exemption from the *slot* and from nothing else. An account we were
// trading that has since been emptied, or whose agent approval lapsed, is still
// refused — and for its own reason, not for a slot.
test("incumbency does not survive an unfunded account or a kill switch", () => {
  const incumbent = "0xf03c000000000000000000000000000000000001";

  const broke = resolveMode(incumbent, 0, { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" }, 0, "live", true);
  assert.equal(broke.mode, "paper");
  assert.match(broke.why, /collateral/);

  // LIVE_SELF_SERVICE off is an operator saying "arm no stranger's account". A switch
  // that spared whoever was already running would not be a kill switch.
  const off = resolveMode(incumbent, FUNDED, { DRY_RUN: "false" }, 0, "live", true);
  assert.equal(off.mode, "paper");
  assert.match(off.why, /not enabled for live trading/);

  // And DRY_RUN still outranks everything.
  assert.equal(resolveMode(incumbent, FUNDED, { LIVE_SELF_SERVICE: "true" }, 0, "live", true).mode, "paper");
});

test("canBeRefusedForSlot answers the allowlist question unless asked about incumbency", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };

  // The default is the allowlist alone — what `warnIfOverCap` asks when it names who
  // took the count past the cap. Folding incumbency in by default would make that
  // line report every live account as pinned.
  assert.equal(canBeRefusedForSlot(stranger, env), true);
  assert.equal(canBeRefusedForSlot(stranger, env, false), true);
  assert.equal(canBeRefusedForSlot(stranger, env, true), false);
});

test("the account cap cannot be raised by an environment variable", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = {
    DRY_RUN: "false", LIVE_SELF_SERVICE: "true",
    LIVE_MANDATE_MAX_ACCOUNTS: "999999", MAX_LIVE_ACCOUNTS: "999999",
  };
  const d = resolveMode(stranger, 100, env, LIVE_MANDATE.maxLiveAccounts);
  assert.equal(d.mode, "paper", "only a commit may raise the cap");
});

// A tripwire, like the ceiling's. What this cap bounds is how many people one bug of
// ours reaches in a single tick, and unwinding each one is manual work.
test("the account cap ships small", () => {
  assert.ok(
    LIVE_MANDATE.maxLiveAccounts <= 25,
    "raising the live account cap above 25 is a deliberate decision — measure loop " +
    "time per account first, and update this test with what you found",
  );
});

// The site is open to any wallet, so what stops a stranger's account trading real
// money is this gate and nothing else. These are the tests that matter most.

test("a stranger asking for live gets paper while self-service is off", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", HL_LIVE_ACCOUNT: MASTER };
  const r = resolveMode(stranger, 100, env, 0, "live");
  assert.equal(r.mode, "paper", "wanting live is not the same as being allowed it");
  assert.match(r.why, /not enabled for live trading/);
});

test("self-service is off unless it says exactly true", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  for (const v of [undefined, "", "false", "1", "yes", "TRUE ", " true"]) {
    const env: NodeJS.ProcessEnv = { DRY_RUN: "false", HL_LIVE_ACCOUNT: "" };
    if (v !== undefined) env.LIVE_SELF_SERVICE = v;
    const expected = (v ?? "").trim().toLowerCase() === "true";
    assert.equal(resolveMode(stranger, 100, env, 0, "live").mode, expected ? "live" : "paper",
      `LIVE_SELF_SERVICE=${JSON.stringify(v)} should ${expected ? "" : "not "}arm`);
  }
});

test("with self-service on, an unlisted account may arm — still inside every cap", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };
  assert.equal(resolveMode(stranger, 100, env, 0, "live").mode, "live");
  // A stranger's deposit is traded in full, exactly as ours is.
  assert.equal(resolveMode(stranger, 500, env, 0, "live").baseCapitalUsd, 500);
  // And the account cap still refuses one past the last slot.
  const full = resolveMode(stranger, 100, env, LIVE_MANDATE.maxLiveAccounts, "live");
  assert.equal(full.mode, "paper");
  assert.match(full.why, /maxLiveAccounts/);
});

test("choosing paper is honoured even when the account is fully permitted", () => {
  const env = { DRY_RUN: "false", HL_LIVE_ACCOUNT: MASTER, LIVE_SELF_SERVICE: "true" };
  const r = resolveMode(MASTER, FUNDED, env, 0, "paper");
  assert.equal(r.mode, "paper");
  assert.match(r.why, /you chose paper/);
  assert.equal(r.baseCapitalUsd, null);
});

test("the user's choice can only move an account down, never up", () => {
  const stranger = "0xf00d000000000000000000000000000000000001";
  const env = { DRY_RUN: "false", HL_LIVE_ACCOUNT: "" };
  // Every combination a user controls, with nothing an operator controls enabled.
  for (const want of ["live", "paper"] as const) {
    assert.equal(resolveMode(stranger, 100, env, 0, want).mode, "paper");
  }
});

// `blocked` is what stops an unfunded account being handed a $1,000 simulated book and
// told it is connected. Found on 2026-08-31 by connecting an unfunded wallet through
// the live site: it came up paper, the screen said "not enabled for real money — an
// operator decision", and the real reason ($0.00 collateral, which the user could have
// fixed in a minute) was never shown. The frozen paper row then blocked the live
// connection they had asked for.

test("paper that is a refusal is marked blocked; paper that was chosen is not", () => {
  const a = "0xAAA0000000000000000000000000000000000001";
  const live = { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" };

  // Deliberate paper — the process is not live-capable, or an operator asked for it.
  assert.equal(resolveMode(a, 100, {}).blocked, false, "DRY_RUN off is not a refusal");
  assert.equal(resolveMode(a, 100, { DRY_RUN: "true" }).blocked, false);
  assert.equal(resolveMode(a, 100, live, 0, "paper").blocked, false, "choosing paper is not a refusal");

  // Refusals, every one of them fixable by someone.
  assert.equal(resolveMode(a, 0, live, 0, "live").blocked, true, "unfunded");
  assert.equal(resolveMode(a, 100, live, LIVE_MANDATE.maxLiveAccounts, "live").blocked, true, "no slot");
  assert.equal(resolveMode(a, 100, { DRY_RUN: "false" }, 0, "live").blocked, true, "not permitted");
});

test("a live decision is never blocked", () => {
  const a = "0xAAA0000000000000000000000000000000000001";
  const d = resolveMode(a, 100, { DRY_RUN: "false", HL_LIVE_ACCOUNT: a }, 0, "live");
  assert.equal(d.mode, "live");
  assert.equal(d.blocked, false);
});

// The specific case from 2026-08-31, end to end: what the screen should have said.
test("an unfunded account is blocked, and says so in words its owner can act on", () => {
  const stranger = "0xacc00006aa15180a4af68712ac7efaa5578ac81c";
  const d = resolveMode(stranger, 0, { DRY_RUN: "false", LIVE_SELF_SERVICE: "true" }, 0, "live");
  assert.equal(d.mode, "paper");
  assert.equal(d.blocked, true);
  assert.match(d.why, /fund it/, "the reason must name the thing the owner can change");
  assert.doesNotMatch(d.why, /operator/, "an unfunded account is not waiting on an operator");
});
