import assert from "node:assert/strict";
import { test } from "node:test";
import { abstractionPlan, ensureTradeable, reachAgrees, type Reach } from "./abstraction.ts";

// The mode decides whether an account's money can back an order at all, so the two
// halves of the decision — which mode to ask for, and whether the books agree
// afterwards — are pinned here rather than left to the one call site.

test("a plain account is unified, a unified one is left alone", () => {
  assert.equal(abstractionPlan("default").act, "unify");
  assert.equal(abstractionPlan("disabled").act, "unify");
  assert.equal(abstractionPlan("unifiedAccount").act, "keep");
});

// Never silently, and never "fix" it into something else: portfolio margin changes
// margining across the whole account, which is the one assumption every sizing and
// liquidation number in this repo is built on.
test("portfolio margin is refused, not corrected", () => {
  const p = abstractionPlan("portfolioMargin");
  assert.equal(p.act, "refuse");
  assert.match(p.why, /isolated margin/);
});

// A mode Hyperliquid adds later is one we have not measured. Unifying it is the same
// request we make of a plain account and leaves the account in the state every working
// account is already in — where doing nothing would leave collateral stranded silently,
// which is the failure this file exists for.
test("a mode we have never heard of is unified rather than trusted", () => {
  assert.equal(abstractionPlan("someNewMode").act, "unify");
});

const reach = (core: number, xyz: number): Reach[] => [
  { dex: "", coin: "BTC", availableUsd: core },
  { dex: "xyz", coin: "xyz:XYZ100", availableUsd: xyz },
];

// The live invariant, from three accounts carrying 3–4 positions each on 2026-09-10:
// every dex reports the same free collateral, because they draw on one pool. Deployed
// or empty does not matter, which is the whole point of comparing the books against
// each other rather than against a floor.
test("dexes drawing on one pool agree, at any size including zero", () => {
  assert.equal(reachAgrees(reach(65.226783, 65.226783)), true);
  assert.equal(reachAgrees(reach(0, 0)), true, "a fully deployed account is not a broken one");
  assert.equal(reachAgrees(reach(29.54, 29.5401)), true, "a cent of rounding is not a disagreement");
});

test("stranded collateral is the disagreement, and it is refused", () => {
  assert.equal(reachAgrees(reach(42, 0)), false, "the 2026-09-10 shape: money on core, nothing on xyz");
  assert.equal(reachAgrees(reach(NaN, 0)), false, "an unreadable book is not an agreement");
});

test("one dex in scope cannot disagree with anything", () => {
  assert.equal(reachAgrees([{ dex: "", coin: "BTC", availableUsd: 12 }]), true);
});

// ── The whole step, end to end ─────────────────────────────────────────────

const probes = [{ dex: "", coin: "BTC" }, { dex: "xyz", coin: "xyz:XYZ100" }];

function venue(o: { abstractionAfter?: string; core?: number; xyz?: number; throws?: boolean }) {
  const calls = { set: 0 };
  return {
    calls,
    info: {
      userAbstraction: async () => o.abstractionAfter ?? "unifiedAccount",
      activeAssetData: async (p: { coin: string }) => ({
        availableToTrade: ["0", String(p.coin.startsWith("xyz") ? o.xyz ?? 50 : o.core ?? 50)],
        maxTradeSzs: ["0", "0"],
      }),
    } as never,
    exchange: {
      agentSetAbstraction: async () => {
        calls.set++;
        if (o.throws) throw new Error("nonce too old");
        return { status: "ok" };
      },
    } as never,
  };
}

const MASTER = "0xacc00001c53162712f3d8d10764b5e7b17d1c08a" as const;

test("a plain account is set to unified and the mode is read back from the venue", async () => {
  const v = venue({});
  const out = await ensureTradeable({
    info: v.info, exchange: v.exchange, master: MASTER, abstraction: "default", probes, log: () => {},
  });
  assert.equal(out.ok, true);
  assert.equal(v.calls.set, 1);
  assert.equal(out.ok && out.changed, true);
});

test("an account already unified is not asked again", async () => {
  const v = venue({});
  const out = await ensureTradeable({
    info: v.info, exchange: v.exchange, master: MASTER, abstraction: "unifiedAccount", probes, log: () => {},
  });
  assert.equal(out.ok, true);
  assert.equal(v.calls.set, 0, "one round trip saved on every restart of every account");
  assert.equal(out.ok && out.changed, false);
});

// The request can be accepted and not take effect, and the difference is invisible
// unless it is read back. Believing our own POST is how the original bug read `ok`.
test("a mode that did not move is a refusal, not a success", async () => {
  const v = venue({ abstractionAfter: "default" });
  const out = await ensureTradeable({
    info: v.info, exchange: v.exchange, master: MASTER, abstraction: "default", probes, log: () => {},
  });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.reason : "", /still reports this account as "default"/);
});

test("a venue that refuses the change says so instead of arming", async () => {
  const v = venue({ throws: true });
  const out = await ensureTradeable({
    info: v.info, exchange: v.exchange, master: MASTER, abstraction: "default", probes, log: () => {},
  });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.reason : "", /nonce too old/);
});

test("portfolio margin never reaches the venue at all", async () => {
  const v = venue({});
  const out = await ensureTradeable({
    info: v.info, exchange: v.exchange, master: MASTER, abstraction: "portfolioMargin", probes, log: () => {},
  });
  assert.equal(out.ok, false);
  assert.equal(v.calls.set, 0);
});
