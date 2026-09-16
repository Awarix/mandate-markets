import type { InfoClient } from "@nktkas/hyperliquid";
import type { AccountView, LiveOrder, LivePosition } from "../types.ts";
import { abstractionPlan } from "./abstraction.ts";
import type { Universe } from "./universe.ts";

// Reading account truth from Hyperliquid.
//
// **Hyperliquid is authoritative for facts** — positions, fills, margin, free
// collateral. Never cache these across a decision; always re-read before acting.
// Our database is authoritative for *intent* only.
//
// Query with the master/sub address, never the agent address. Querying the agent
// address is the classic pitfall and returns empty state, which would read to us as
// "no positions" and is the worst possible lie.
//
// HIP-3 dexes are separate books: `clearinghouseState`, `openOrders` and `allMids`
// all take a `dex` parameter and return only that dex's slice. A position on
// `xyz:NVDA` is invisible to a main-dex read. We therefore read every dex the
// universe knows about, not just the main one — a foreign position we cannot see is
// a foreign position we cannot halt on.

export async function readAccountView(
  info: InfoClient,
  master: `0x${string}`,
  universe: Universe,
  dexes: readonly string[] = universe.dexes,
): Promise<AccountView> {
  const positions: LivePosition[] = [];
  const orders: LiveOrder[] = [];
  const marks = new Map<string, number>();
  let equityUsd = 0;
  let freeUsd = 0;

  for (const dex of dexes) {
    const arg = dex === "" ? { user: master } : { user: master, dex };
    const [state, open, mids] = await Promise.all([
      info.clearinghouseState(arg),
      info.frontendOpenOrders(arg),
      info.allMids(dex === "" ? {} : { dex }),
    ]);

    equityUsd += Number(state.marginSummary.accountValue);
    freeUsd += Number(state.withdrawable);

    for (const ap of state.assetPositions) {
      const p = ap.position;
      positions.push({
        coin: p.coin,
        szi: Number(p.szi),
        entryPx: Number(p.entryPx),
        marginUsed: Number(p.marginUsed),
        unrealizedPnl: Number(p.unrealizedPnl),
        liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
        leverage: p.leverage.value,
      });
    }
    for (const o of open) {
      orders.push({
        coin: o.coin,
        oid: o.oid,
        cloid: o.cloid,
        isBuy: o.side === "B",
        sz: Number(o.sz),
        limitPx: Number(o.limitPx),
        triggerPx: o.isTrigger ? Number(o.triggerPx) : null,
        isTrigger: o.isTrigger,
        reduceOnly: o.reduceOnly,
      });
    }
    for (const [coin, px] of Object.entries(mids)) {
      const n = Number(px);
      if (Number.isFinite(n)) marks.set(coin, n);
    }
  }

  // On a `unifiedAccount`, spot USDC *is* perp collateral, and the perp wallet reads
  // `accountValue: 0.0` until a position exists. `checkCollateral` has always known
  // this; this function did not, and the gap was live-only and immediate:
  // `connectAccount` seeds `day_start_equity` from baseCapital ($100), the first tick
  // read equity as $0, and the governor computed a 100% daily loss and halted before
  // a single order. `freeUsd: 0` would then have rejected every signal as
  // `insufficient-collateral` anyway. Found on the first live start, 2026-08-30.
  //
  // Read per tick rather than cached at connect: HL is authoritative for money and a
  // spot balance moves. Two extra calls on a 60s loop.
  // ⚠ Add only the **unheld** part. Spot `total` already includes the collateral
  // backing open perp positions, and `hold` is exactly that portion — verified live
  // 2026-08-30 with two positions open:
  //
  //     spot USDC total 101.093738   hold 19.886673
  //     perp accountValue  9.900915 (main) + 9.985758 (xyz) = 19.886673  ← == hold
  //     portfolio accountValue      101.096258              ← the real total
  //
  // So `spotTotal + perpAccountValue` double-counts the margin by exactly `hold`.
  // The first version of this fix did that and reported $120.90 on a $101 account,
  // which flatters the daily-loss cap and overstates collateral the governor may
  // commit. `total - hold` plus perp equity reconstructs the portfolio figure.
  const [spot, abstraction] = await Promise.all([
    info.spotClearinghouseState({ user: master }),
    info.userAbstraction({ user: master }),
  ]);
  if (abstraction === "unifiedAccount") {
    const usdc = spot.balances.find((b) => b.coin === "USDC");
    const total = Number(usdc?.total ?? 0);
    const held = Number(usdc?.hold ?? 0);
    const unheld = total - (Number.isFinite(held) ? held : 0);
    if (Number.isFinite(unheld) && unheld > 0) {
      equityUsd += unheld;
      freeUsd += unheld;
    }
  }

  return { at: new Date().toISOString(), equityUsd, freeUsd, positions, orders, marks };
}

export type CollateralCheck = {
  ok: boolean;
  perpEquityUsd: number;
  spotUsdc: number;
  abstraction: string;
  /** What this account can actually trade with, and therefore what becomes its
   *  `baseCapital`: perp equity plus unheld spot USDC.
   *
   *  It used to add the spot half **only** on a `unifiedAccount`, which was the honest
   *  answer while we inherited whatever mode a deposit rail happened to leave behind.
   *  Since 2026-09-10 we do not inherit it: `ensureTradeable` puts every account we arm
   *  into unified margin, agent-signed, before the ledger freezes anything
   *  (`src/hl/abstraction.ts`). So both pools are collateral by the time an order is
   *  placed, and reporting only the perp half would quote a mandate smaller than the
   *  deposit — and, worse, refuse a correctly-funded account for being under the floor.
   *
   *  Returned rather than left to the caller because three of them were recomputing
   *  the same conditional (`connectAccount`, `preflight`, the connect screen), and the
   *  branch that is easy to drop is the one that decides whether a funded account
   *  reads as empty. */
  usableUsd: number;
  /** What to tell the user, in their terms. */
  message: string;
};

/** The connect-time collateral check: **is there enough money here, wherever it sits.**
 *
 *  Hyperliquid keeps spot and perp collateral in separate pools, and a user can fund
 *  either one. Which pool counts used to depend on the account: on a `unifiedAccount`
 *  spot USDC *is* perp collateral (verified live 2026-08-30 — the bucket test account
 *  read `accountValue: 0.0` while `activeAssetData` reported `availableToTrade: 5.36`),
 *  and on a plain one it was money we could not reach, which is why this function used
 *  to tell people to move it.
 *
 *  **It no longer tells anybody to move anything**, because we no longer inherit the
 *  mode: `ensureTradeable` unifies the account, agent-signed, during the same connect
 *  (`src/hl/abstraction.ts`). Both pools are therefore collateral by the time an order
 *  goes out, and the old advice — *"your money is in SPOT, move it to your perp wallet"*
 *  — would now be a chore we invented for a state we fix ourselves.
 *
 *  ⚠ **This function answers "how much", and deliberately not "can these dollars reach
 *  the markets we trade".** It cannot: it reads pools, and reachability is a property
 *  of the dex. That gap is what let a $42 account arm and then have five entries
 *  rejected for insufficient margin over 28 minutes on 2026-09-10, with `ok: true`
 *  printed throughout. The other half of the answer lives in `ensureTradeable`, which
 *  reads `activeAssetData` on every dex in scope and refuses to arm an account whose
 *  books disagree — and `connectAccount` calls both.
 *
 *  `portfolioMargin` is rejected outright: it changes margining semantics across the
 *  whole account, and our per-signal blast-radius argument assumes isolated margin. */
export async function checkCollateral(
  info: InfoClient,
  master: `0x${string}`,
  minUsd: number,
): Promise<CollateralCheck> {
  const [state, spot, abstraction] = await Promise.all([
    info.clearinghouseState({ user: master }),
    info.spotClearinghouseState({ user: master }),
    info.userAbstraction({ user: master }),
  ]);
  const perpEquityUsd = Number(state.marginSummary.accountValue);
  // `total - hold` for the same reason `readAccountView` does it: on a unified
  // account the spot total already includes the collateral backing open perps, so
  // adding `perpEquityUsd` to the raw total counts that margin twice. Identical at
  // first connect (a clean account holds nothing), visible on a restart with
  // positions open — which reported $110.92 against a real $101.10 on 2026-08-30.
  const usdc = spot.balances.find((b) => b.coin === "USDC");
  const spotUsdc = Math.max(0, Number(usdc?.total ?? 0) - Number(usdc?.hold ?? 0));
  const usable = perpEquityUsd + spotUsdc;

  if (abstraction === "portfolioMargin") {
    return {
      ok: false, perpEquityUsd, spotUsdc, abstraction, usableUsd: usable,
      message: abstractionPlan(abstraction).why,
    };
  }
  if (usable < minUsd) {
    return {
      ok: false, perpEquityUsd, spotUsdc, abstraction, usableUsd: usable,
      message: `This account holds $${usable.toFixed(2)} of usable collateral; the minimum is $${minUsd.toFixed(2)}.`,
    };
  }
  return {
    ok: true, perpEquityUsd, spotUsdc, abstraction, usableUsd: usable,
    // Which pool it is in still gets said, because it is the difference between an
    // account that is ready and one we are about to unify — and because somebody who
    // just deposited is looking for their own number on the screen.
    message: spotUsdc > 0 && perpEquityUsd > 0
      ? `$${usable.toFixed(2)} usable ($${perpEquityUsd.toFixed(2)} perp, $${spotUsdc.toFixed(2)} spot).`
      : spotUsdc > 0
        ? `$${usable.toFixed(2)} usable, all of it spot USDC.`
        : `$${usable.toFixed(2)} usable in the perp wallet.`,
  };
}
