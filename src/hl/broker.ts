import type { ExchangeClient, InfoClient } from "@nktkas/hyperliquid";
import type { AccountView, DesiredOrder, PlaceResult } from "../types.ts";
import type { Broker } from "../broker.ts";
import type { Market } from "../mapping/intent.ts";
import type { BuilderConfig } from "./approve-builder-fee.ts";
import { makeCloid } from "./cloid.ts";
import { cancelOrder, placeOrder, setIsolatedLeverage } from "./orders.ts";
import { readAccountView } from "./state.ts";
import type { Universe } from "./universe.ts";

// The live broker. Thin on purpose: every decision was made before we got here, and
// this file's only job is to talk to the venue.

export class LiveBroker implements Broker {
  readonly mode = "live" as const;
  /** Leverage is per (asset, account) on HL and sticky, so we only send it on change. */
  private readonly leverageSet = new Map<string, number>();

  constructor(
    private readonly info: InfoClient,
    private readonly exchange: ExchangeClient,
    private readonly master: `0x${string}`,
    private readonly universe: Universe,
    /** Resolved for **this** account: present only when its owner has approved a
     *  maximum of at least our rate. `undefined` is the ordinary case and means the
     *  order goes out with no builder field.
     *
     *  Read at connect and re-read hourly, never frozen — see `setBuilder`. */
    private builder?: BuilderConfig,
  ) {}

  /** The owner can approve or revoke at any time and the venue says so plainly
   *  ("can revoke permissions at any time"), so this is not a connect-time fact that
   *  stays put. Frozen it would be wrong in both directions, and the two are not
   *  symmetric: a new approval left unread only means we are not paid, but a
   *  **revocation** left unread means we keep attaching a code the account no longer
   *  permits, and Hyperliquid rejects every one of those orders. That is the account
   *  not trading — the §1.1 outage arriving one revocation at a time.
   *
   *  `runner.ts` calls this on the same hourly pass that re-reads the agent approval,
   *  for the same reason and at the same cost of one info call per live account. */
  setBuilder(builder: BuilderConfig | undefined): void {
    this.builder = builder;
  }

  view(): Promise<AccountView> {
    return readAccountView(this.info, this.master, this.universe);
  }

  async ensureIsolated(market: Market, leverage: number): Promise<void> {
    if (this.leverageSet.get(market.coin) === leverage) return;
    await setIsolatedLeverage(this.exchange, market, leverage);
    this.leverageSet.set(market.coin, leverage);
  }

  place(order: DesiredOrder, market: Market): Promise<PlaceResult> {
    return placeOrder(this.exchange, order, market, makeCloid(order.intentId, order.role), this.builder);
  }

  cancel(market: Market, cloid: string): Promise<boolean> {
    return cancelOrder(this.exchange, market, cloid as `0x${string}`);
  }
}
