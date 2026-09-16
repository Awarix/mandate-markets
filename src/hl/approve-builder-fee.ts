// The builder-fee approval, and the per-account decision about whether to charge.
//
// `tasks/14`. Two things live here and they are different in kind:
//
//  - **The signature.** `approveBuilderFee` is a user-signed EIP-712 action of exactly
//    the same family as `approveAgent`, so `src/hl/approve-agent.ts` is the template
//    and its transport is reused verbatim. The master wallet signs, we relay.
//  - **The decision.** Whether an order carries a builder code at all is a *per-account*
//    question, and not by choice: Hyperliquid holds the approval per (user, builder)
//    pair, so an account that never signed has no approval and nothing we deploy can
//    create one on its behalf. `builderFor()` is that decision, and it fails closed.
//
// **Why failing closed matters more than the fee.** `builderConfig()` used to read two
// environment variables and return the same config for every account, spread into every
// order unconditionally. Setting `HL_BUILDER_ADDRESS` under that code was not a rate
// knob starting at zero — it was an outage: HL rejects an order carrying a builder code
// the master has not approved for at least that rate, and `maxBuilderFee` read **0** on
// the live accounts checked on 2026-09-07 and again on 2026-09-09. So the rule is that
// an account which approved nothing gets an order with **no builder field**, which
// fills normally. It is `tasks/14` §3 step 5 and it is what protects strangers.
//
// Everything about the wire format was verified on 2026-09-09 against the vendor SDK
// (`@nktkas/hyperliquid`, `api/exchange/_methods/approveBuilderFee.js`) and against the
// venue's own builder-codes page, not against our own notes:
//
//   f is "the builder fee to charge in tenths of basis points … a value of 10 means
//   1 basis point"; "Builder fees charged can be at most 0.1% on perps and 1% on spot";
//   "The builder must have at least 100 USDC in perps account value and must use
//   standard as the account abstraction mode"; "Each user can have a maximum of 10
//   active builder code approvals at a time."
//
// And the read, live against mainnet the same day:
//
//   POST /info {"type":"maxBuilderFee","user":"0x4fe5…c08a","builder":"0xdd03…932f"} → 0

import { BUILDER_FEE } from "../risk/params.ts";
import {
  EIP712_DOMAIN_TYPE, fromSignatureChainId, relaySignedAction, ZERO_ADDRESS,
  type HyperliquidChain, type RelayResult, type Signature, type TypedData,
} from "./approve-agent.ts";

export type BuilderConfig = { b: `0x${string}`; f: number };

// ── The unit conversion, which is the part that can cost real money ──────────
//
// ⚠ **The same quantity is written three ways across this flow** (`tasks/14` §1.4):
//
//     the order's `builder.f`          integer, tenths of a bp     6
//     `approveBuilderFee.maxFeeRate`   percent string              "0.006%"
//     the `maxBuilderFee` read         integer, tenths of a bp     6
//
// One decimal place out is a 10× fee on somebody's money, so this is a pure function
// that touches money under `CLAUDE.md` and it is tested in both directions, including
// every boundary. Nothing else in the repository is allowed to do this arithmetic.

/** Percent, as Hyperliquid's `maxFeeRate` wants it: `f / 1000`, rendered exactly.
 *
 *  Built from integer digits rather than by dividing, because `6 / 1000` is not 0.006
 *  in binary floating point and `String(f / 1000)` is one representation change away
 *  from putting an exponent in a signed field. The venue's own schema is
 *  `/^[0-9]+(\.[0-9]+)?%$/`, which `1e-3%` does not match — it would be refused rather
 *  than mis-signed, but a refusal at the wallet is still an outage nobody could read. */
export function tenthsBpToPercent(tenthsBp: number): `${string}%` {
  assertTenthsBp(tenthsBp);
  const whole = Math.floor(tenthsBp / 1000);
  const frac = String(tenthsBp % 1000).padStart(3, "0").replace(/0+$/, "");
  return (frac === "" ? `${whole}%` : `${whole}.${frac}%`) as `${string}%`;
}

/** The rate as a plain fraction of notional: `f = 6` → `0.00006`.
 *
 *  Here rather than at the call sites because it is the third spelling of the same
 *  quantity and the one that gets written from memory. `f / 1_000_000` is the mistake
 *  it is easy to make — off by ten, and it reads as a *smaller* fee, which is the
 *  direction nobody double-checks. It was made once, on 2026-09-09, in the preflight
 *  line and in the browser copy of it, and printed "2%–7% of the account a year" where
 *  the truth is 24%–72%.
 *
 *  Multiply by turnover to get the annual cost as a fraction of account value, which
 *  is the only unit in which this fee is honestly described. */
export function tenthsBpToFraction(tenthsBp: number): number {
  assertTenthsBp(tenthsBp);
  return tenthsBp / 100_000;
}

/** The inverse, for reading back what a wallet was asked to sign. Not used in the
 *  order path — the venue reports the approval in tenths of a bp already — but a
 *  conversion with only one direction tested is a conversion with an untested half. */
export function percentToTenthsBp(percent: string): number {
  const m = /^([0-9]+)(?:\.([0-9]+))?%$/.exec(percent);
  if (!m) throw new Error(`not a Hyperliquid percent string: ${JSON.stringify(percent)}`);
  const raw = m[2] ?? "";
  // Past the third decimal place only zeros are allowed. `"0.0060%"` is a legal
  // spelling of 6 tenths of a bp; `"0.0006%"` is a rate the order field cannot carry,
  // and rounding it silently — to 1, a 67% overcharge, or to 0, which looks like the
  // rail is off — is exactly the mistake this module exists to make impossible.
  if (/[1-9]/.test(raw.slice(3))) {
    throw new Error(`${percent} is finer than a tenth of a basis point, which the order field cannot carry`);
  }
  const n = Number(m[1]) * 1000 + Number(raw.slice(0, 3).padEnd(3, "0"));
  assertTenthsBp(n);
  return n;
}

/** `f` must be a whole number of tenths of a bp, above zero and inside the venue's cap
 *  for perps. Zero is refused rather than treated as "off": the rail is turned off by
 *  leaving `HL_BUILDER_ADDRESS` unset, and an `f` of 0 on a live rail is a config
 *  mistake that would look like it was working. */
export function assertTenthsBp(tenthsBp: number): void {
  if (!Number.isInteger(tenthsBp) || tenthsBp <= 0) {
    throw new Error(`builder fee must be a positive whole number of tenths of a basis point, got ${tenthsBp}`);
  }
  if (tenthsBp > BUILDER_FEE.venueMaxTenthsBp) {
    throw new Error(
      `builder fee ${tenthsBp} exceeds Hyperliquid's perp maximum of ` +
      `${BUILDER_FEE.venueMaxTenthsBp} (0.1%)`,
    );
  }
}

// ── The rail, and the per-account decision ───────────────────────────────────

/** The desk-wide rail: the builder address from the environment, the rate from
 *  version control. `undefined` when `HL_BUILDER_ADDRESS` is unset, which is the rail
 *  off and is how this shipped.
 *
 *  **The address stays an environment variable and the rate never is.** They are
 *  different kinds of decision: turning the rail on should need someone on the box,
 *  the way `HL_LIVE_ACCOUNT` does, while the number that decides what strangers pay
 *  belongs in a diff someone could have read. `HL_BUILDER_FEE` used to override the
 *  rate and has been removed for exactly that reason.
 *
 *  Throws on a malformed address rather than falling back to no builder. A typo here
 *  reaches the venue as a rejected order on every account at once — the §1.1 outage —
 *  so it is worth refusing to start over. */
export function builderRail(env: NodeJS.ProcessEnv = process.env): BuilderConfig | undefined {
  const addr = (env.HL_BUILDER_ADDRESS ?? "").trim();
  if (!addr) return undefined;
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(
      `HL_BUILDER_ADDRESS is not an address: ${JSON.stringify(addr)}. ` +
      "Every order would be rejected by Hyperliquid, on every account at once. " +
      "Unset it to run with the builder rail off.",
    );
  }
  if (env.HL_BUILDER_FEE) {
    throw new Error(
      "HL_BUILDER_FEE no longer exists — the rate lives in BUILDER_FEE.tenthsBp in " +
      "src/risk/params.ts, so that what strangers pay is a commit rather than a line " +
      "in a unit file. Remove it from the environment.",
    );
  }
  assertTenthsBp(BUILDER_FEE.tenthsBp);
  return { b: addr.toLowerCase() as `0x${string}`, f: BUILDER_FEE.tenthsBp };
}

/** Whether *this* account's orders carry the builder code.
 *
 *  `approvedMaxTenthsBp` is what `maxBuilderFee(master, builder)` returned, or `null`
 *  when we could not read it. **Both "never approved" and "could not read" mean no
 *  builder field**, and that is the whole safety property: the order still fills, we
 *  simply are not paid for it. The failure this refuses to produce is the other one —
 *  attaching a code the account has not approved, which HL rejects, which stops the
 *  account trading.
 *
 *  The comparison is `>=` and not `===` because the ceiling belongs to the account's
 *  owner: someone who signed a larger maximum elsewhere, or who signed ours and then
 *  saw us lower the rate, is charged our rate and not theirs. */
export function builderFor(
  rail: BuilderConfig | undefined,
  approvedMaxTenthsBp: number | null,
): BuilderConfig | undefined {
  if (!rail) return undefined;
  if (approvedMaxTenthsBp === null || !Number.isFinite(approvedMaxTenthsBp)) return undefined;
  return approvedMaxTenthsBp >= rail.f ? rail : undefined;
}

/** Whether **this** account has to approve before it may arm live (`tasks/33`).
 *
 *  The owner reversed `tasks/14` §5 on 2026-09-10: the fee is required rather than
 *  optional, *for new users only*. So there are now two populations and this is the
 *  line between them — `BUILDER_FEE.requiredForConnectionsFrom` argues why the line is
 *  a connection timestamp.
 *
 *  **Three ways this returns false, and they are all deliberate:**
 *
 *  - **No rail.** Nothing is charged, so there is nothing to require. This is how the
 *    predicate behaves on any box with `HL_BUILDER_ADDRESS` unset, including every
 *    test that does not set one.
 *  - **Grandfathered.** The connection predates the cutoff. Those owners agreed to a
 *    desk that charged nothing and said so in writing; turning that into a condition
 *    behind them is a different act from asking a new arrival.
 *  - **We do not know when they connected.** `null` — no `connections` row, or a
 *    timestamp we cannot parse — reads as grandfathered. This is the one that could go
 *    either way and the direction is chosen: failing **open** costs a fee, failing
 *    closed refuses to trade an account whose owner did everything right, and the
 *    second is not a trade this project makes for revenue. Same rule as `builderFor`,
 *    one layer up.
 *
 *  Pure, and it decides whether somebody's account trades, so it is tested at both
 *  boundaries. */
export function feeIsRequired(
  rail: BuilderConfig | undefined,
  connectionCreatedAt: string | null | undefined,
  from: string = BUILDER_FEE.requiredForConnectionsFrom,
): boolean {
  if (!rail) return false;
  if (!connectionCreatedAt) return false;
  const created = Date.parse(connectionCreatedAt);
  const cutoff = Date.parse(from);
  if (!Number.isFinite(created) || !Number.isFinite(cutoff)) return false;
  return created >= cutoff;
}

/** What the desk shows, and what `connectAccount` logs. Three states, the shape
 *  `tasks/13` stage A used for expiry — because a fee the user consented to and cannot
 *  see is the version of this with the worst optics. */
export type FeeStatus =
  /** No rail. Nobody is charged anything and no signature is asked for. */
  | { state: "off" }
  /** The rail is on and this account has not approved it. Orders carry no builder
   *  field and fill normally; this is a prompt, never a blocker. */
  | { state: "unapproved"; tenthsBp: number; percent: string }
  /** Charging, at `tenthsBp`, under a ceiling of `approvedMaxTenthsBp`. */
  | { state: "charging"; tenthsBp: number; percent: string; approvedMaxTenthsBp: number };

export function feeStatus(
  rail: BuilderConfig | undefined,
  approvedMaxTenthsBp: number | null,
): FeeStatus {
  if (!rail) return { state: "off" };
  const percent = tenthsBpToPercent(rail.f);
  if (approvedMaxTenthsBp === null || !builderFor(rail, approvedMaxTenthsBp)) {
    return { state: "unapproved", tenthsBp: rail.f, percent };
  }
  return { state: "charging", tenthsBp: rail.f, percent, approvedMaxTenthsBp };
}

// ── The signed action ────────────────────────────────────────────────────────

export type ApproveBuilderFeeAction = {
  type: "approveBuilderFee";
  hyperliquidChain: HyperliquidChain;
  signatureChainId: string;
  maxFeeRate: string;
  builder: string;
  nonce: number;
};

/** The four signed fields, in EIP-712 encoding order. Copied from the vendor SDK's
 *  `ApproveBuilderFeeTypes` on 2026-09-09 — note the order differs from
 *  `ApproveAgent`'s, so this is not the other one with names swapped. */
export const APPROVE_BUILDER_FEE_TYPES = {
  "HyperliquidTransaction:ApproveBuilderFee": [
    { name: "hyperliquidChain", type: "string" },
    { name: "maxFeeRate", type: "string" },
    { name: "builder", type: "address" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** The action a wallet is asked to sign.
 *
 *  `maxFeeRate` is derived from `BUILDER_FEE.tenthsBp` and is never passed in: the
 *  ceiling the owner signs and the rate we charge are **one constant** by the owner's
 *  decision of 2026-09-09, so there is no call site that could set them apart. Raising
 *  the rate therefore invalidates every approval and each account signs again, which is
 *  the property that makes the consent real — see `BUILDER_FEE` for the argument. */
export function buildApproval(opts: {
  builder: string;
  signatureChainId: string;
  chain: HyperliquidChain;
  nonce: number;
}): ApproveBuilderFeeAction {
  if (!/^0x[0-9a-fA-F]{40}$/.test(opts.builder)) {
    throw new Error(`builder address ${JSON.stringify(opts.builder)} is not an address`);
  }
  if (opts.builder.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("refusing to build an approval for the zero address");
  }
  if (!Number.isInteger(opts.nonce) || opts.nonce <= 0) {
    throw new Error(`nonce must be a positive integer, got ${opts.nonce}`);
  }
  return {
    type: "approveBuilderFee",
    hyperliquidChain: opts.chain,
    signatureChainId: opts.signatureChainId,
    maxFeeRate: tenthsBpToPercent(BUILDER_FEE.tenthsBp),
    builder: opts.builder,
    nonce: opts.nonce,
  };
}

export function typedDataFor(action: ApproveBuilderFeeAction): TypedData {
  return {
    domain: {
      name: "HyperliquidSignTransaction",
      version: "1",
      chainId: fromSignatureChainId(action.signatureChainId),
      verifyingContract: ZERO_ADDRESS,
    },
    types: { EIP712Domain: EIP712_DOMAIN_TYPE, ...APPROVE_BUILDER_FEE_TYPES },
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    // `type` and `signatureChainId` ride along in the action and are not hashed.
    message: {
      hyperliquidChain: action.hyperliquidChain,
      maxFeeRate: action.maxFeeRate,
      builder: action.builder,
      nonce: action.nonce,
    },
  };
}

export function relayApproveBuilderFee(
  action: ApproveBuilderFeeAction,
  signature: Signature,
  opts: { testnet: boolean; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<RelayResult> {
  return relaySignedAction(action, signature, opts);
}
