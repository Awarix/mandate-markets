import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILDER_FEE } from "../risk/params.ts";
import {
  APPROVE_BUILDER_FEE_TYPES, assertTenthsBp, buildApproval, builderFor, builderRail,
  feeIsRequired, feeStatus, percentToTenthsBp, tenthsBpToFraction, tenthsBpToPercent, typedDataFor,
} from "./approve-builder-fee.ts";

// `tasks/14` §1.4: the same quantity is written three ways and one decimal place out
// is a 10× fee on somebody's money. These are the tests that stand between those two
// facts, so they check the boundaries rather than a happy path.

const BUILDER = "0xdd03fe71e3131d85c295d1fddf108a04de07932f";

test("tenthsBpToPercent renders the three units the flow actually uses", () => {
  assert.equal(tenthsBpToPercent(6), "0.006%");     // ours, decided 2026-09-09
  assert.equal(tenthsBpToPercent(1), "0.001%");     // the rate it replaced
  assert.equal(tenthsBpToPercent(10), "0.01%");     // Axiom's, 1 bp
  assert.equal(tenthsBpToPercent(15), "0.015%");    // Hyperdash's
  assert.equal(tenthsBpToPercent(100), "0.1%");     // the venue's perp maximum
});

test("the percent string never carries an exponent or trailing noise", () => {
  // The venue's own schema is /^[0-9]+(\.[0-9]+)?%$/. Anything this function can
  // produce has to match it, or the wallet is asked to sign something HL refuses.
  for (let f = 1; f <= BUILDER_FEE.venueMaxTenthsBp; f++) {
    const s = tenthsBpToPercent(f);
    assert.match(s, /^[0-9]+(\.[0-9]+)?%$/, `f=${f} produced ${s}`);
    assert.ok(!s.includes("e"), `f=${f} produced an exponent: ${s}`);
  }
});

test("the conversion round-trips at every legal rate", () => {
  for (let f = 1; f <= BUILDER_FEE.venueMaxTenthsBp; f++) {
    assert.equal(percentToTenthsBp(tenthsBpToPercent(f)), f);
  }
});

test("percentToTenthsBp reads the spellings a human might write", () => {
  assert.equal(percentToTenthsBp("0.006%"), 6);
  assert.equal(percentToTenthsBp("0.0060%"), 6);   // a trailing zero is the same rate
  assert.equal(percentToTenthsBp("0.1%"), 100);
  assert.equal(percentToTenthsBp("0.100%"), 100);
});

test("a rate finer than the order field can carry is refused, never rounded", () => {
  // 0.0006% is 0.6 tenths of a bp. Rounding it to 1 would be a 67% overcharge and
  // rounding it to 0 would look like the rail was off.
  assert.throws(() => percentToTenthsBp("0.0006%"), /finer than a tenth of a basis point/);
});

test("the venue's perp maximum is a hard edge in both directions", () => {
  assert.throws(() => tenthsBpToPercent(101), /exceeds Hyperliquid's perp maximum/);
  assert.throws(() => percentToTenthsBp("0.11%"), /exceeds Hyperliquid's perp maximum/);
  assert.throws(() => percentToTenthsBp("1%"), /exceeds Hyperliquid's perp maximum/);  // spot's cap, not ours
});

test("zero and fractions are refused: the rail is turned off by unsetting the address", () => {
  assert.throws(() => assertTenthsBp(0), /positive whole number/);
  assert.throws(() => assertTenthsBp(-1), /positive whole number/);
  assert.throws(() => assertTenthsBp(1.5), /positive whole number/);
  assert.throws(() => percentToTenthsBp("nonsense"), /not a Hyperliquid percent string/);
  assert.throws(() => percentToTenthsBp("0.006"), /not a Hyperliquid percent string/);
});

test("the rate charged and the ceiling signed are the same number", () => {
  // The owner's decision, 2026-09-09. A ceiling above the rate would be headroom to
  // raise the rate on a signature given when it was lower. If these ever differ, the
  // consent story in BUILDER_FEE is no longer true and this test is where it shows.
  const action = buildApproval({
    builder: BUILDER, signatureChainId: "0xa4b1", chain: "Mainnet", nonce: 1_757_000_000_000,
  });
  assert.equal(action.maxFeeRate, tenthsBpToPercent(BUILDER_FEE.tenthsBp));
  assert.equal(percentToTenthsBp(action.maxFeeRate), BUILDER_FEE.tenthsBp);
});

test("the fraction is the third spelling, and it is the one written from memory", () => {
  // `f / 1_000_000` is off by ten and reads as a *smaller* fee — the direction nobody
  // double-checks. It shipped in a preflight line and a browser copy on 2026-09-09 and
  // printed 2%-7% a year where the truth was 24%-72%.
  assert.equal(tenthsBpToFraction(6), 0.00006);
  assert.equal(tenthsBpToFraction(1), 0.00001);
  assert.equal(tenthsBpToFraction(100), 0.001);        // the venue cap, 10 bps
  // The unit that is not a lie: what it costs a year at this desk's measured turnover.
  assert.equal(Math.round(tenthsBpToFraction(6) * 4_000 * 100), 24);
  assert.equal(Math.round(tenthsBpToFraction(6) * 8_000 * 100), 48);
  assert.equal(Math.round(tenthsBpToFraction(6) * 12_000 * 100), 72);
  // And it agrees with the percent string, which is the same number a hundred times over.
  assert.equal(tenthsBpToFraction(6) * 100, Number(tenthsBpToPercent(6).replace("%", "")));
});

test("TRIPWIRE: the rate is 6 tenths of a bp, and moving it is a decision not a refactor", () => {
  // Pinned deliberately. `notes/2026-09-09-builder-fee-market-comparison.md` §9 argued
  // f = 5 as the ceiling the evidence supports; 6 is the owner's call over it. Either
  // way the number is not something a passing edit should be able to move quietly.
  assert.equal(BUILDER_FEE.tenthsBp, 6);
  assert.equal(tenthsBpToPercent(BUILDER_FEE.tenthsBp), "0.006%");
});

// ── The per-account decision: `tasks/14` §3 step 5, the one that protects strangers ──

const RAIL = { b: BUILDER as `0x${string}`, f: 6 };

test("an account that approved nothing gets no builder field", () => {
  assert.equal(builderFor(RAIL, 0), undefined);
});

test("an account we could not read gets no builder field", () => {
  // Failing closed. The order fills and we are not paid; the alternative is attaching
  // a code the account may not have approved, which HL rejects — and a rejected entry
  // is the account not trading.
  assert.equal(builderFor(RAIL, null), undefined);
  assert.equal(builderFor(RAIL, NaN), undefined);
});

test("an account approved below our rate gets no builder field", () => {
  // Someone who signed when the rate was 1 and has not signed again. Their orders keep
  // filling; they are simply not charged the new rate until they agree to it.
  assert.equal(builderFor(RAIL, 5), undefined);
  assert.equal(builderFor(RAIL, 1), undefined);
});

test("an account approved at or above our rate is charged our rate, not theirs", () => {
  assert.deepEqual(builderFor(RAIL, 6), RAIL);
  assert.deepEqual(builderFor(RAIL, 100), RAIL);
  assert.equal(builderFor(RAIL, 100)?.f, 6);
});

test("with the rail off nobody is charged, whatever they approved", () => {
  assert.equal(builderFor(undefined, 100), undefined);
  assert.equal(builderFor(undefined, null), undefined);
});

test("builderRail reads the address from the environment and the rate from git", () => {
  assert.equal(builderRail({} as NodeJS.ProcessEnv), undefined);
  assert.equal(builderRail({ HL_BUILDER_ADDRESS: "" } as NodeJS.ProcessEnv), undefined);

  const rail = builderRail({ HL_BUILDER_ADDRESS: BUILDER.toUpperCase().replace("0X", "0x") } as NodeJS.ProcessEnv);
  assert.deepEqual(rail, { b: BUILDER, f: BUILDER_FEE.tenthsBp });
});

test("a malformed builder address refuses to start rather than trading without one", () => {
  // The §1.1 outage: a bad address reaches the venue as a rejected order on every
  // account at once. Better to fail where somebody is looking.
  assert.throws(
    () => builderRail({ HL_BUILDER_ADDRESS: "0xnope" } as NodeJS.ProcessEnv),
    /is not an address/,
  );
});

test("HL_BUILDER_FEE is refused rather than ignored", () => {
  // It used to set the rate. Silently ignoring it would leave an operator believing
  // they had changed what strangers pay.
  assert.throws(
    () => builderRail({ HL_BUILDER_ADDRESS: BUILDER, HL_BUILDER_FEE: "15" } as NodeJS.ProcessEnv),
    /no longer exists/,
  );
});

// ── What the desk is allowed to say ─────────────────────────────────────────

test("feeStatus is three states and never claims a charge that is not happening", () => {
  assert.deepEqual(feeStatus(undefined, 0), { state: "off" });
  assert.deepEqual(feeStatus(undefined, 100), { state: "off" });
  assert.deepEqual(feeStatus(RAIL, 0), { state: "unapproved", tenthsBp: 6, percent: "0.006%" });
  assert.deepEqual(feeStatus(RAIL, null), { state: "unapproved", tenthsBp: 6, percent: "0.006%" });
  assert.deepEqual(feeStatus(RAIL, 5), { state: "unapproved", tenthsBp: 6, percent: "0.006%" });
  assert.deepEqual(feeStatus(RAIL, 6), {
    state: "charging", tenthsBp: 6, percent: "0.006%", approvedMaxTenthsBp: 6,
  });
});

// ── The signed action ───────────────────────────────────────────────────────

test("the EIP-712 field order is the SDK's, and it is not ApproveAgent's", () => {
  // Read from @nktkas/hyperliquid api/exchange/_methods/approveBuilderFee.js on
  // 2026-09-09. Order is the encoding order: get it wrong and every signature recovers
  // to a stranger, which our own relay then refuses — after the owner signed.
  assert.deepEqual(APPROVE_BUILDER_FEE_TYPES["HyperliquidTransaction:ApproveBuilderFee"], [
    { name: "hyperliquidChain", type: "string" },
    { name: "maxFeeRate", type: "string" },
    { name: "builder", type: "address" },
    { name: "nonce", type: "uint64" },
  ]);
});

test("the typed data hashes exactly the four declared fields", () => {
  const action = buildApproval({
    builder: BUILDER, signatureChainId: "0xa4b1", chain: "Mainnet", nonce: 1_757_000_000_000,
  });
  const td = typedDataFor(action);

  assert.equal(td.primaryType, "HyperliquidTransaction:ApproveBuilderFee");
  assert.equal(td.domain.chainId, 42161);
  assert.equal(td.domain.name, "HyperliquidSignTransaction");
  assert.equal(td.domain.verifyingContract, "0x0000000000000000000000000000000000000000");
  // `type` and `signatureChainId` ride along in the action and must not be in the struct.
  assert.deepEqual(Object.keys(td.message).sort(), ["builder", "hyperliquidChain", "maxFeeRate", "nonce"]);
  assert.equal(td.message.maxFeeRate, "0.006%");
});

test("buildApproval refuses the addresses that would cost something", () => {
  const ok = { signatureChainId: "0xa4b1", chain: "Mainnet" as const, nonce: 1 };
  assert.throws(() => buildApproval({ ...ok, builder: "0xshort" }), /is not an address/);
  assert.throws(
    () => buildApproval({ ...ok, builder: "0x0000000000000000000000000000000000000000" }),
    /zero address/,
  );
  assert.throws(() => buildApproval({ builder: BUILDER, signatureChainId: "0xa4b1", chain: "Mainnet", nonce: 0 }), /nonce/);
});

// ── Who has to approve, and who does not (`tasks/33`) ───────────────────────
//
// The owner reversed `tasks/14` §5 on 2026-09-10: the fee is required rather than
// optional, **for new users only**. So `feeIsRequired` is the line between two
// populations and it decides whether somebody's account is traded — which puts it in
// the same class as `builderFor` above and means both boundaries are pinned here.

const CUTOFF = "2026-09-10T12:45:00.000Z";

test("the cutoff is inclusive on the new side and exclusive on the old one", () => {
  // A millisecond either side of the instant, which is the whole of the rule.
  assert.equal(feeIsRequired(RAIL, "2026-09-10T12:44:59.999Z", CUTOFF), false);
  assert.equal(feeIsRequired(RAIL, CUTOFF, CUTOFF), true, "on the instant is required");
  assert.equal(feeIsRequired(RAIL, "2026-09-10T12:45:00.001Z", CUTOFF), true);

  // The accounts that were live when this moved, by connection date — including the two
  // that connected earlier on the same day and are the reason the cutoff carries a time.
  assert.equal(feeIsRequired(RAIL, "2026-08-30T12:00:00.000Z", CUTOFF), false);
  assert.equal(feeIsRequired(RAIL, "2026-09-10T08:23:46.337Z", CUTOFF), false, "0xacc00002…");
  assert.equal(feeIsRequired(RAIL, "2026-09-10T10:46:22.615Z", CUTOFF), false, "0xacc00003…");
});

test("no rail means nothing to require, whatever the dates say", () => {
  // The shipped state until 2026-09-10, and the state of every box and every test that
  // does not set HL_BUILDER_ADDRESS. A gate that fired without a fee behind it would
  // refuse to trade accounts over a fee nobody is charging.
  assert.equal(feeIsRequired(undefined, "2027-01-01T00:00:00.000Z", CUTOFF), false);
});

test("an unknown connection date is grandfathered, never required", () => {
  // The direction is chosen rather than fallen into: failing open costs a fee, failing
  // closed refuses to trade an account whose owner did everything right. Same rule as
  // `builderFor` one layer up — the expensive failure is the account not trading.
  for (const bad of [null, undefined, "", "not a date", "2026-13-45T99:00:00Z"]) {
    assert.equal(feeIsRequired(RAIL, bad, CUTOFF), false, `${JSON.stringify(bad)} must not be required`);
  }
  // And an unparseable *cutoff* fails the same way, rather than making NaN comparisons
  // decide who trades.
  assert.equal(feeIsRequired(RAIL, "2027-01-01T00:00:00.000Z", "whenever"), false);
});

test("the shipped cutoff sits after this repository's own live accounts connected", () => {
  // A tripwire on the constant itself. Moving it earlier can stop an account that is
  // trading today, which is the reason it lives in version control rather than in the
  // environment — so a change to it should fail here first and be argued.
  //
  // It did exactly that on 2026-09-10, which is why the bound below is now a *read*
  // rather than a round number. The cutoff was brought forward from the next midnight
  // so the account onboarded through the new funding flow would meet the real rule, and
  // this test refused the change until the production `connections` table had been
  // queried: the last account to connect before it did so at **10:46:22.615Z**
  // (`0xacc00003…`, active), and `0xacc00002…` at 08:23:46.337Z. A midnight-to-midnight
  // guard would have passed a cutoff that stopped both.
  assert.equal(BUILDER_FEE.requiredForConnectionsFrom, CUTOFF);
  assert.ok(
    Date.parse(BUILDER_FEE.requiredForConnectionsFrom) > Date.parse("2026-09-10T10:46:22.615Z"),
    "every account already live when this moved connected before the cutoff and must stay grandfathered",
  );
});
