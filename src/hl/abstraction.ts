import type { ExchangeClient, InfoClient } from "@nktkas/hyperliquid";

// Making an account's money reachable by the markets we actually trade.
//
// This exists because of a failure that looked like nothing at all. On 2026-09-10 a
// funded, connected, agent-approved account had **five consecutive entries rejected**
// with `Insufficient margin` over 28 minutes — $41.58 of notional at 10x, $4.16 of
// margin, refused by an account holding $42.00 — while every check we had reported it
// healthy (`notes/2026-09-10-onboarding-without-hyperliquid.md`).
//
// The money was in the wrong **pool**, and not in the spot-versus-perp sense this
// project already documents. A raw Bridge2 deposit credits the *core* perp wallet and
// leaves `userAbstraction` at `default`; the markets we trade are HIP-3 `xyz:` markets,
// and on a `default` account core perp collateral cannot reach them. Every account that
// trades reads core perp **$0.00**, everything in spot, with `xyz` drawing against it:
//
//                                abstraction     core perp   xyz perp   spot USDC
//     0xacc00003  (before)       default            42.00       0.00        0.00   ← rejected
//     0xacc00001  (working)      unifiedAccount      0.00      41.59      106.82
//
// That shape is produced by the **abstraction mode**, not by any deposit rail. Neither
// rail sets it: Bridge2 leaves it alone, and Circle's CCTP — which is what Hyperliquid's
// own Deposit button uses — hardcodes destination dex 0 in its `hookData` and sets
// nothing either. What sets it is HL's *frontend*, silently, on any fresh account with
// no order history, using the agent minted at *Establish Connection*:
//
//     async function fN(e){ await L6({type:`agentSetAbstraction`, abstraction:`u`},
//                                     e.agentWallet, e.activeAccount); }
//
// So we do the same thing, for the same reason, with the authority we were already
// granted. **Margin mode is how the account trades**, which is exactly what an agent is
// for — the contrast is `tasks/37`, where the same mechanism would set a referral code
// that pays us, and is refused on those grounds. Setting the mode costs nothing, needs
// no user signature, and on the account above the next signal filled six minutes later.
//
// `portfolioMargin` is the one mode we will not set and will not run under: it changes
// margining semantics across the whole account, and the per-signal blast-radius argument
// this desk is built on assumes isolated margin.

/** Hyperliquid's four modes, as `userAbstraction` reports them. Typed as a string
 *  because a mode we have never heard of must reach `abstractionPlan` and be refused
 *  there, not fail a cast on the way in. */
export type AbstractionMode = string;

/** The venue's own single-letter encoding, from the SDK's own schema. */
export const UNIFIED = "u" as const;

export type AbstractionPlan =
  | { act: "keep"; why: string }
  | { act: "unify"; why: string }
  | { act: "refuse"; why: string };

/** What to do about the mode this account is in. Pure, and separate from the doing,
 *  because it is the whole of the decision — the rest is one signed request. */
export function abstractionPlan(current: AbstractionMode): AbstractionPlan {
  if (current === "unifiedAccount") {
    return { act: "keep", why: "already unified — spot USDC is collateral on every dex" };
  }
  if (current === "portfolioMargin") {
    return {
      act: "refuse",
      why: "This account is in portfolio-margin mode. SignalDesk only trades isolated margin — " +
        "switch the account back to the default margin mode on Hyperliquid, or connect a different account.",
    };
  }
  // `default` and `disabled`, and anything Hyperliquid adds later. Both of the named
  // ones strand collateral on whichever book it was deposited into, which is the
  // failure at the top of this file; an unknown one we have not measured is not a mode
  // we should leave an account trading in either.
  return { act: "unify", why: `abstraction is "${current}" — collateral cannot reach every dex we trade` };
}

/** One market per dex, and what the venue says this account can put behind an order
 *  there. `availableToTrade` is *free* collateral, so it moves as positions open — which
 *  is why nothing here compares it to a dollar floor. */
export type Reach = { dex: string; coin: string; availableUsd: number };

export async function readReach(
  info: Pick<InfoClient, "activeAssetData">,
  master: `0x${string}`,
  probes: readonly { dex: string; coin: string }[],
): Promise<Reach[]> {
  return await Promise.all(probes.map(async ({ dex, coin }) => {
    const a = await info.activeAssetData({ user: master, coin });
    return { dex, coin, availableUsd: Number(a.availableToTrade[1]) };
  }));
}

/** Do the books agree about what this account can spend?
 *
 *  **This is the size-independent version of the question**, and it is the one worth
 *  asking. Comparing `availableToTrade` against our funding floor would refuse a
 *  perfectly healthy account that simply has all of its collateral deployed — a restart
 *  mid-position reads near zero and is fine. But on a unified account every dex reports
 *  the *same* number, because they are drawing on one pool, and that holds with
 *  positions open. Measured on three live accounts on 2026-09-10, each carrying 3–4
 *  positions:
 *
 *      0xacc00001   BTC 65.226783   xyz:XYZ100 65.226783    (= spot 106.82 − hold 41.59)
 *      0xacc00002   BTC 34.136949   xyz:XYZ100 34.136949
 *      0xacc00003   BTC 29.542916   xyz:XYZ100 29.542916
 *
 *  A stranded account is exactly the disagreement: core carrying the money, `xyz` at
 *  zero. So the invariant is equality, to the cent, and it catches any future mechanism
 *  that strands collateral on one book — not just the one we have met. */
export function reachAgrees(reach: readonly Reach[], tolUsd = 0.01): boolean {
  if (reach.length < 2) return true;
  const values = reach.map((r) => r.availableUsd);
  if (values.some((v) => !Number.isFinite(v))) return false;
  return Math.max(...values) - Math.min(...values) <= tolUsd;
}

export type Tradeable =
  | { ok: true; changed: boolean; abstraction: AbstractionMode; reach: Reach[] }
  | { ok: false; reason: string; abstraction: AbstractionMode; reach: Reach[] };

/** Leave this account in a state where the orders we are about to place can actually
 *  draw on its collateral — or say why we could not.
 *
 *  Returns rather than throws: `src/hl/` must never import from `src/exec/`, and the
 *  refusal an account owner reads is a `ConnectPending`, which lives there.
 *
 *  Called **after** the agent approval and **before** the ledger freezes `baseCapital`,
 *  which is the only window where both are true: the agent exists to sign this, and
 *  nothing has yet been written against an account that might not be tradeable. */
export async function ensureTradeable(a: {
  info: Pick<InfoClient, "activeAssetData" | "userAbstraction">;
  exchange: Pick<ExchangeClient, "agentSetAbstraction">;
  master: `0x${string}`;
  /** What `checkCollateral` already read this connect. Passed in rather than re-read:
   *  one fewer round trip, and the mode the decision is made on is the same one the
   *  log line above it printed. */
  abstraction: AbstractionMode;
  probes: readonly { dex: string; coin: string }[];
  log: (msg: string) => void;
}): Promise<Tradeable> {
  const plan = abstractionPlan(a.abstraction);
  if (plan.act === "refuse") {
    return { ok: false, reason: plan.why, abstraction: a.abstraction, reach: [] };
  }

  let abstraction = a.abstraction;
  let changed = false;
  if (plan.act === "unify") {
    a.log(`${a.master} ${plan.why} — setting unifiedAccount (agent-signed, free, no user signature)`);
    try {
      await a.exchange.agentSetAbstraction({ abstraction: UNIFIED });
    } catch (e) {
      return {
        ok: false,
        reason: "we could not put this account into unified-margin mode, so its collateral cannot reach " +
          `the markets we trade: ${e instanceof Error ? e.message : String(e)}`,
        abstraction, reach: [],
      };
    }
    // Read it back from the venue rather than assuming the request took. This is the
    // one fact the rest of the connect is about to rely on.
    abstraction = await a.info.userAbstraction({ user: a.master });
    changed = true;
    if (abstraction !== "unifiedAccount") {
      return {
        ok: false,
        reason: `Hyperliquid still reports this account as "${abstraction}" after we asked for unified margin. ` +
          "Until it is unified, money deposited into one wallet cannot back orders on the other.",
        abstraction, reach: [],
      };
    }
    a.log(`${a.master} abstraction is now unifiedAccount`);
  }

  const reach = await readReach(a.info, a.master, a.probes);
  a.log(`${a.master} reachable: ${reach.map((r) => `${r.dex === "" ? "core" : r.dex} $${r.availableUsd.toFixed(2)}`).join(" · ")}`);
  if (!reachAgrees(reach)) {
    const worst = reach.reduce((m, r) => (r.availableUsd < m.availableUsd ? r : m));
    return {
      ok: false,
      reason: `this account's collateral does not reach every market we trade — ${worst.dex === "" ? "the main book" : worst.dex} ` +
        `reports $${worst.availableUsd.toFixed(2)} available while another reports $${Math.max(...reach.map((r) => r.availableUsd)).toFixed(2)}. ` +
        "Orders would be rejected for insufficient margin on an account that looks funded.",
      abstraction, reach,
    };
  }
  return { ok: true, changed, abstraction, reach };
}
