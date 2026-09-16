import type { AccountView, DesiredOrder, LiveOrder, LivePosition, PlaceResult } from "../types.ts";
import type { Broker } from "../broker.ts";
import type { Market } from "../mapping/intent.ts";
import type { Store } from "../store/db.ts";
import { makeCloid } from "../hl/cloid.ts";

// The paper broker.
//
// Phase 1's gate is "7 days unattended, every intent traceable to a signal, every skip
// explained, zero orphaned state after a forced restart mid-position". That is a test
// of the *lifecycle*, so paper mode has to actually have a lifecycle: entries fill,
// stops and targets arm and trigger, positions close, and the ledger has to line up
// afterwards. Logging "[DRY] would place ..." and moving on would prove nothing.
//
// So this is a simulated book that presents the same `Broker` surface as the live
// one, marks against **live Hyperliquid mid prices**, and keeps its state in the same
// SQLite file as the intent ledger — which is what makes killing the process
// mid-position a real test rather than a fresh start.
//
// What it does not model: queue position, partial fills from thin books, funding, and
// fees. It is a correctness harness for our own state machine, not a backtest. The
// P&L question belongs to Phase 0 (`tasks/02`), which models all four properly.

export class PaperBroker implements Broker {
  readonly mode = "paper" as const;

  constructor(
    private readonly store: Store,
    /** Live marks, refreshed by the runner from HL before each view. */
    private readonly marks: () => Map<string, number>,
    startingEquity: number,
    /** Whose book this is. Every statement below is scoped by it: the tables are
     *  shared with every other paper account in the same ledger, and one account
     *  seeing another's positions would be the same failure as two agents on one
     *  Hyperliquid account. */
    private readonly account: string,
  ) {
    const row = store.db.prepare("SELECT equity FROM paper_cash WHERE account = ?")
      .get(account) as { equity: number } | undefined;
    if (row === undefined) {
      store.db.prepare("INSERT INTO paper_cash (account, equity) VALUES (?, ?)").run(account, startingEquity);
    }
  }

  /** Order ids are unique across the whole file, as a venue's are — allocated in the
   *  INSERT rather than from a counter, so two accounts placing orders in the same
   *  process cannot be handed the same id. */
  private equity(): number {
    return (this.store.db.prepare("SELECT equity FROM paper_cash WHERE account = ?")
      .get(this.account) as { equity: number }).equity;
  }

  private setEquity(v: number): void {
    this.store.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(v, this.account);
  }

  private positions(): LivePosition[] {
    const rows = this.store.db.prepare("SELECT * FROM paper_positions WHERE account = ? AND szi != 0")
      .all(this.account) as unknown as PaperPositionRow[];
    const marks = this.marks();
    return rows.map((r) => {
      const mark = marks.get(r.coin) ?? r.entry_px;
      return {
        coin: r.coin,
        szi: r.szi,
        entryPx: r.entry_px,
        marginUsed: r.margin_used,
        unrealizedPnl: (mark - r.entry_px) * r.szi,
        liquidationPx: null,
        leverage: r.leverage,
      };
    });
  }

  private paperOrderRows(): PaperOrderRow[] {
    return this.store.db.prepare("SELECT * FROM paper_orders WHERE account = ?")
      .all(this.account) as unknown as PaperOrderRow[];
  }

  private restingOrders(): LiveOrder[] {
    return this.paperOrderRows().map((r) => ({
      coin: r.coin, oid: r.oid, cloid: r.cloid, isBuy: r.is_buy === 1, sz: r.sz,
      limitPx: r.px, triggerPx: r.trigger_px, isTrigger: r.trigger_px !== null, reduceOnly: r.reduce_only === 1,
    }));
  }

  /** Arm and fire resting triggers against the current mark. HL triggers fire on
   *  **mark** price, not last trade, which is what this reproduces.
   *
   *  A long's stop and a short's take-profit both sit *below* the mark and fire on a
   *  fall; a long's take-profit and a short's stop sit above and fire on a rise. The
   *  side alone does not decide it, so the direction is recorded at placement. */
  private settleTriggers(): void {
    const marks = this.marks();
    for (const r of this.paperOrderRows()) {
      if (r.trigger_px === null) continue;
      const mark = marks.get(r.coin);
      if (mark === undefined) continue;
      const fired = r.fire_below === 1 ? mark <= r.trigger_px : mark >= r.trigger_px;
      if (!fired) continue;
      this.fill(r.coin, r.is_buy === 1, r.sz, r.trigger_px, r.reduce_only === 1);
      this.store.db.prepare("DELETE FROM paper_orders WHERE cloid = ? AND account = ?").run(r.cloid, this.account);
      this.store.setOrderStatus(r.cloid, "filled", `paper trigger at ${r.trigger_px}`);
    }
  }

  /** Apply a fill to the simulated book, returning realised P&L.
   *
   *  Two venue semantics that matter and are easy to get wrong:
   *  a reduce-only order can **never open or increase** a position — against a flat
   *  book it is a no-op, and against a smaller position it fills only what is there;
   *  and a non-reduce-only order large enough to flip the side closes the old
   *  position and opens the remainder at the fill price. Without the first rule a
   *  stop and a target both triggering on one gap would close the position and then
   *  *reopen* it inverted, which is a state the real venue cannot reach. */
  private fill(coin: string, isBuy: boolean, sz: number, px: number, reduceOnly: boolean): number {
    const row = this.positionRow(coin);
    const prev = row?.szi ?? 0;
    let signed = isBuy ? sz : -sz;

    if (reduceOnly) {
      if (prev === 0 || Math.sign(signed) === Math.sign(prev)) return 0;
      signed = Math.sign(signed) * Math.min(Math.abs(signed), Math.abs(prev));
    }

    const closedSz = prev === 0 ? 0 : Math.min(Math.abs(prev), Math.abs(signed)) * (Math.sign(signed) === Math.sign(prev) ? 0 : 1);
    const pnl = closedSz === 0 ? 0 : (px - row!.entry_px) * (prev > 0 ? closedSz : -closedSz);
    if (pnl !== 0) this.setEquity(this.equity() + pnl);

    const next = prev + signed;
    if (next === 0) {
      this.store.db.prepare("DELETE FROM paper_positions WHERE account = ? AND coin = ?").run(this.account, coin);
      return pnl;
    }

    // Same side (or a flip): whatever remains is carried at the price it was opened.
    const flipped = prev !== 0 && Math.sign(next) !== Math.sign(prev);
    const entry = prev === 0 || flipped ? px : ((row!.entry_px * prev) + px * signed) / next;
    const leverage = this.leverageFor(coin, row?.leverage ?? 10);
    this.store.db.prepare(
      `INSERT INTO paper_positions (account, coin, szi, entry_px, margin_used, leverage, opened_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account, coin) DO UPDATE SET szi = excluded.szi, entry_px = excluded.entry_px,
         margin_used = excluded.margin_used, leverage = excluded.leverage`,
    ).run(this.account, coin, next, entry, Math.abs(next * entry) / leverage, leverage, new Date().toISOString());
    return pnl;
  }

  private positionRow(coin: string): PaperPositionRow | undefined {
    return this.store.db.prepare("SELECT * FROM paper_positions WHERE account = ? AND coin = ?")
      .get(this.account, coin) as unknown as PaperPositionRow | undefined;
  }

  async view(): Promise<AccountView> {
    this.settleTriggers();
    const positions = this.positions();
    const marks = this.marks();
    const equity = this.equity() + positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    const deployed = positions.reduce((s, p) => s + p.marginUsed, 0);
    return {
      at: new Date().toISOString(),
      equityUsd: equity,
      freeUsd: Math.max(0, equity - deployed),
      positions,
      orders: this.restingOrders(),
      marks,
    };
  }

  /** Recorded before the entry is placed, exactly as `updateLeverage` is on the real
   *  venue — the margin a position posts is decided by this, and that number feeds
   *  the free-collateral check the *next* signal has to pass. */
  async ensureIsolated(market: Market, leverage: number): Promise<void> {
    this.store.db.prepare(
      "INSERT INTO paper_leverage (account, coin, leverage) VALUES (?, ?, ?) " +
      "ON CONFLICT(account, coin) DO UPDATE SET leverage = excluded.leverage",
    ).run(this.account, market.coin, leverage);
    this.store.db.prepare("UPDATE paper_positions SET leverage = ? WHERE account = ? AND coin = ?")
      .run(leverage, this.account, market.coin);
  }

  private leverageFor(coin: string, fallback: number): number {
    const r = this.store.db.prepare("SELECT leverage FROM paper_leverage WHERE account = ? AND coin = ?")
      .get(this.account, coin) as { leverage: number } | undefined;
    return r?.leverage ?? fallback;
  }

  async place(order: DesiredOrder, market: Market): Promise<PlaceResult> {
    const cloid = makeCloid(order.intentId, order.role);
    const mark = this.marks().get(order.coin);
    if (mark === undefined) return { ok: false, cloid, error: `no mark for ${order.coin}` };

    if (order.triggerPx !== undefined) {
      this.store.db.prepare(
        `INSERT INTO paper_orders (cloid, account, coin, is_buy, sz, px, trigger_px, fire_below, reduce_only, oid, placed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(oid), 0) + 1 FROM paper_orders), ?)`,
      ).run(cloid, this.account, order.coin, order.isBuy ? 1 : 0, order.sz, order.px, order.triggerPx,
        order.triggerPx < mark ? 1 : 0, order.reduceOnly ? 1 : 0, new Date().toISOString());
      const oid = (this.store.db.prepare("SELECT oid FROM paper_orders WHERE cloid = ?")
        .get(cloid) as { oid: number }).oid;
      return { ok: true, cloid, oid, filledSz: 0, avgPx: null };
    }

    // IOC: fills at the mark if the limit allows it, otherwise it is simply gone.
    const fillable = order.isBuy ? order.px >= mark : order.px <= mark;
    if (!fillable) return { ok: true, cloid, oid: null, filledSz: 0, avgPx: null };
    if (!order.reduceOnly) {
      this.store.db.prepare(
        `INSERT INTO paper_positions (account, coin, szi, entry_px, margin_used, leverage, opened_at)
         VALUES (?, ?, 0, ?, 0, ?, ?) ON CONFLICT(account, coin) DO NOTHING`,
      ).run(this.account, order.coin, mark, this.leverageFor(order.coin, market.maxLeverage), new Date().toISOString());
    }
    this.fill(order.coin, order.isBuy, order.sz, mark, order.reduceOnly);
    return { ok: true, cloid, oid: null, filledSz: order.sz, avgPx: mark };
  }

  async cancel(_market: Market, cloid: string): Promise<boolean> {
    const before = this.store.db.prepare("SELECT COUNT(*) AS n FROM paper_orders WHERE cloid = ? AND account = ?")
      .get(cloid, this.account) as { n: number };
    this.store.db.prepare("DELETE FROM paper_orders WHERE cloid = ? AND account = ?").run(cloid, this.account);
    return before.n > 0;
  }

  /** Paper mode's own bookkeeping, for the ops report. */
  cashEquity(): number {
    return this.equity();
  }
}

type PaperPositionRow = {
  coin: string; szi: number; entry_px: number; margin_used: number; leverage: number;
};

type PaperOrderRow = {
  cloid: string; coin: string; is_buy: number; sz: number; px: number;
  trigger_px: number | null; fire_below: number; reduce_only: number; oid: number;
};
