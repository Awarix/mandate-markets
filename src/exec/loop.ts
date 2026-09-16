import type { AccountView, CloseReason, DesiredOrder, LiveOrder, SkipReason } from "../types.ts";
import type { Market } from "../mapping/intent.ts";
import { buildIntent, skip } from "../mapping/intent.ts";
import { evaluateSeries, liveDisplacementSigma, stableOutlookId, type Gate } from "../mapping/quotient.ts";
import { intentPrefix, parseCloid } from "../hl/cloid.ts";
import type { Universe } from "../hl/universe.ts";
import { haltCheck, preTradeCheck } from "../risk/governor.ts";
import type { Allocation } from "../risk/ledger.ts";
import { RISK_PARAMS, type UserSettings } from "../risk/params.ts";
import type { Snapshot } from "../signals/source.ts";
import { Store, type IntentRow, type OrderRow } from "../store/db.ts";
import type { Broker } from "../broker.ts";
import { planIntent } from "./plan.ts";
import { orderActions, reconcile, type ReconcileAction } from "./reconcile.ts";

// One iteration of the execution loop, as a function of its inputs.
//
//   account truth → halt checks → signals to intents → desired orders
//                 → diff against what is resting → emit the delta → settle the ledger
//
// It lives apart from `runner.ts` (process wiring, clock, signals, shutdown) so the
// whole state machine can be driven in a test with a paper broker and a scripted
// price series. The Phase 1 gate is about lifecycle behaviour, so lifecycle behaviour
// is what has to be testable.
//
// Every step is idempotent: running `tick` twice against an unchanged venue produces
// no second order, and running it after a restart re-derives the same desired set
// from the venue plus the ledger.

export const GATE: Gate = {
  minDisplacementSigma: RISK_PARAMS.minDisplacementSigma,
  allowedModes: RISK_PARAMS.allowedModes,
  allowedStrengths: RISK_PARAMS.allowedStrengths,
  maxHoldHours: RISK_PARAMS.maxHoldHours,
};

export type LoopDeps = {
  store: Store;
  master: string;
  universe: Universe;
  settings: UserSettings;
  baseCapital: number;
  broker: Broker;
  /** Refresh live marks before the account read. Paper prices against the real venue. */
  refreshMarks: () => Promise<void>;
  /** The order book and 24h volume for one market, or null when either read failed.
   *
   *  A dependency rather than a call, so `tick()` stays a function of its inputs —
   *  which is the property `loop.test.ts` drives the whole state machine through. It is
   *  called only for a signal that has already passed every cheaper gate, which on the
   *  measured feed is one or two per poll rather than one per series. */
  readDepth: (coin: string) => Promise<{ book: { bids: { px: string; sz: string }[]; asks: { px: string; sz: string }[] }; volume24hUsd: number } | null>;
  /** The most recent signal snapshot, or null if we have never had one. */
  snapshot: Snapshot | null;
  /** True only when `snapshot` was fetched this tick. A failed poll must never read
   *  as "every signal disappeared", so retirement is judged on fresh data only. */
  fresh: boolean;
  feedAgeSec: number;
  globalHalt: { halted: boolean; reason: string };
  /** When this account's agent approval lapses, ms since epoch, or null when there is
   *  none to read. Refreshed by the runner rather than frozen at connect: a user who
   *  re-approves must be picked up on the next loop, not on the next restart. */
  agentValidUntil: number | null;
  now: Date;
  log: (msg: string) => void;
  notify: (msg: string) => Promise<unknown>;
};

export type TickReport = {
  view: AccountView;
  allocation: Allocation;
  halted: boolean;
  haltReason: string | null;
  opened: number;
  placed: number;
  cancelled: number;
  closed: number;
  foreignOrders: number;
  foreignPositions: number;
};

export async function tick(d: LoopDeps): Promise<TickReport> {
  await d.refreshMarks();
  const view = await d.broker.view();

  const day = d.store.rollDay(d.master, view.equityUsd, d.now);
  const before = d.store.liveIntents(d.master);
  const allocation: Allocation = {
    baseCapital: d.baseCapital,
    deployedUsd: d.store.deployedMargin(d.master),
    openCount: d.store.openCount(d.master),
    dayStartEquity: day.dayStartEquity,
    equityNow: view.equityUsd,
  };

  const accountRow = d.store.account(d.master);
  const halted = accountRow?.halted === 1 || d.globalHalt.halted;

  // Signals that vanished from a fresh snapshot have been retired: close on the next
  // poll that shows them gone (docs/ACCOUNT-MODEL.md §8).
  //
  // Compare on `stableOutlookId`, never the raw `outlook_id` — the vendor rotates
  // that on every revision, roughly hourly, so the raw id made a routine revision
  // indistinguishable from a retirement and force-closed healthy live positions.
  //
  // `hold_to_target` opts one position out of this exit and only this one. The
  // position keeps its target, its stop and its horizon, so a held intent is never
  // unbounded — it exits on a level or on time, just not on the vendor's withdrawal.
  // The flag is read from the intent row, never from `d.settings`: the policy is
  // frozen at open, so changing the setting cannot re-price something already running.
  const retired = new Set<string>();
  const flipped = new Set<string>();
  if (d.fresh && d.snapshot) {
    // **Keyed on the side, not only on the outlook** (`tasks/44`). Membership alone
    // cannot see a reversal: a call that goes long → short still carries
    // `side !== null && status === "active"`, so its id stayed in this set and the
    // position was held against the thesis that opened it — until a target, a stop, a
    // horizon or a *later* neutral turn, with nothing anywhere recording that the
    // forecast had inverted. Three direct flips in twelve days and 0 of 461 closed
    // trips affected, so this is built while it is free rather than met at 10× and size.
    const liveSides = new Map<string, Set<string>>();
    for (const s of d.snapshot.series) {
      if (s.outlook.side === null || s.outlook.status !== "active") continue;
      const id = stableOutlookId(s.outlook.outlook_id);
      let sides = liveSides.get(id);
      if (!sides) { sides = new Set(); liveSides.set(id, sides); }
      sides.add(s.outlook.side);
    }
    for (const i of before) {
      if (i.status !== "open") continue;
      const sides = liveSides.get(i.signal_ref);
      if (sides?.has(i.side)) continue;

      // The outlook is still being called, just the other way. A different fact from a
      // withdrawal and it gets its own stamp, its own close reason and its own log line
      // — three events in twelve days is rare enough that each one is worth reading.
      //
      // **It is treated as a retirement, not as a flip primitive.** Close, and let the
      // ordinary path reopen the other side on a later tick if it clears every gate.
      // A single order through flat would leave two reduce-only triggers sized and
      // signed for a position that no longer exists, which is the partial-fill failure
      // `CLAUDE.md` forbids attaching children for; reusing retirement instead buys the
      // σ gate, `blockReentryAfterStop`, the budget and the capacity veto for free.
      if (sides !== undefined) {
        if (i.flipped_at === null) {
          d.store.markFlipped(i.intent_id, d.now);
          const to = [...sides].join("/");
          d.log(
            i.hold_to_target
              ? `${i.coin} ${short(i.intent_id)}: Quotient reversed this call — ${i.side} → ${to} — ` +
                `holding to target, stop or ${i.horizon_at} (hold-to-resolve is on for this position)`
              : `${i.coin} ${short(i.intent_id)}: Quotient reversed this call — ${i.side} → ${to} — closing`,
          );
          // The record for the half we do not act on. Under `hold_to_target` nothing
          // else would ever say this happened: the position exits on a level or on time
          // and its close reason carries no trace of the reversal.
          if (i.hold_to_target) {
            d.store.recordSkip(d.master, skip(
              "side-flipped", `held ${i.side} while the forecast turned ${to} (hold-to-resolve)`,
              i.signal_ref, i.signal_revision, i.coin, d.now,
            ));
          }
        }
        if (!i.hold_to_target) flipped.add(i.intent_id);
        continue;
      }

      // Stamp it on the row the first time we see it, under either policy.
      //
      // Under the old one this was implicit — `close_reason = "retired"` said it — but
      // a held position exits on its target or its horizon, so nothing would record
      // that the call ever went neutral, and the two policies could never be compared
      // on live trades again. `tasks/02`'s question is exactly that comparison, so the
      // fact is written down when it happens rather than inferred afterwards from a
      // close reason that no longer carries it.
      //
      // The null check is what keeps this idempotent and off the per-tick log: the
      // call stays out of `stillLive` in every later snapshot, so without it this
      // would fire once a loop for the life of the position.
      if (i.withdrawn_at === null) {
        d.store.markWithdrawn(i.intent_id, d.now);
        d.log(
          i.hold_to_target
            ? `${i.coin} ${short(i.intent_id)}: Quotient went neutral on this call — holding to ` +
              `target, stop or ${i.horizon_at} (hold-to-resolve is on for this position)`
            : `${i.coin} ${short(i.intent_id)}: Quotient went neutral on this call — closing`,
        );
      }
      if (!i.hold_to_target) retired.add(i.intent_id);
    }
  }

  const opened = d.fresh && d.snapshot && !halted
    ? await considerSignals(d, view, allocation)
    : 0;

  // Desired order set, from the ledger plus what is actually held.
  const intents = d.store.liveIntents(d.master);
  const desired: DesiredOrder[] = [];
  const closings = new Map<string, CloseReason>();
  for (const i of intents) {
    const market = d.universe.resolve(i.coin);
    if (!market) {
      d.log(`ALERT ${i.coin} no longer resolves in HL meta — intent ${short(i.intent_id)} left untouched`);
      continue;
    }
    const mark = view.marks.get(i.coin);
    if (mark === undefined) continue;
    const pos = view.positions.find((p) => p.coin === i.coin && p.szi !== 0) ?? null;
    const plan = planIntent(i, pos, market, {
      now: d.now, markPx: mark, slippageBps: RISK_PARAMS.slippageBps,
      forceClose: flipped.has(i.intent_id) ? "flipped" : retired.has(i.intent_id) ? "retired" : undefined,
    });
    for (const n of plan.notes) d.log(`${i.coin} ${short(i.intent_id)}: ${n}`);
    if (plan.closing) closings.set(i.intent_id, plan.closing);
    desired.push(...plan.desired);
  }

  const plan = reconcile({
    desired,
    orders: view.orders,
    positions: view.positions,
    liveIntentIds: intents.map((i) => i.intent_id),
    claimedCoins: intents.map((i) => i.coin),
    szDecimalsFor: (coin) => d.universe.resolve(coin)?.szDecimals ?? 2,
  });

  const h = haltCheck({
    foreignOrders: plan.foreignOrders.length,
    foreignPositions: plan.foreignPositions.length,
    allocation,
    globalHalt: d.globalHalt.halted,
  });

  let actions: ReconcileAction[];
  if (h.halt) {
    // Only a sticky halt is persisted. The operator halt file stops opening while it
    // is there and stops stopping when it is removed — otherwise "delete the file to
    // resume" would be a lie, and the kill switch would be one-way.
    if (h.sticky && accountRow?.halted !== 1) {
      d.store.setHalt(d.master, true, h.reason, h.kind);
      d.store.recordEvent(d.master, "halt", h.reason, d.now);
      d.log(`HALT: ${h.reason}`);
      await d.notify(`🔴 SignalDesk HALT · ${d.master}\n${h.reason}\nNo new positions. Existing venue-side stops stay live.`);
    } else if (h.sticky && accountRow?.halt_kind == null) {
      // A halt that predates `halt_kind`, whose condition is still true. Record what
      // the check says rather than guessing a kind out of the stored sentence — and
      // write no event and send no alert, because nothing happened: this is the halt
      // that was already there. Until it is typed the desk offers no Clear button,
      // which is the safe direction and the reason this is worth doing at all.
      if (d.store.typeExistingHalt(d.master, h.kind)) {
        d.log(`the halt in force is a ${h.kind} halt; recording the kind on a row that predates the column`);
      }
    } else if (!h.sticky) {
      d.log(`holding: ${h.reason} — no new positions, exits still managed`);
    }
    // A halt stops opening. It does **not** pull the exits: the stops are the
    // protection, and cancelling them is the opposite of safe. Only re-sizes and
    // wrong-trigger replacements still run, so a stop keeps matching its position.
    actions = orderActions(plan.actions).filter(
      (a) => a.kind === "cancel" ? a.reason === "wrong-size" || a.reason === "wrong-trigger" || a.reason === "duplicate"
        : a.order.role !== "entry",
    );
  } else {
    actions = orderActions(plan.actions);
  }

  const first = await execute(actions, d);
  const exitsPlaced = await protectFreshFills(d, first.filledEntries);
  const placed = first.placed + exitsPlaced;
  const cancelled = first.cancelled;

  // Settle against a fresh read, not the one this tick opened with. An IOC close
  // placed a few lines above has already changed the account, and settling on the
  // stale view would report the position as still open for another whole loop —
  // which is exactly the kind of drift an intent ledger exists to prevent.
  const settleView = placed + cancelled > 0 ? await d.broker.view() : view;
  const closed = settleLedger(d, intents, settleView, closings);

  return {
    view: settleView, allocation,
    halted: d.store.account(d.master)?.halted === 1,
    haltReason: d.store.account(d.master)?.halt_reason ?? null,
    opened, placed, cancelled, closed,
    foreignOrders: plan.foreignOrders.length,
    foreignPositions: plan.foreignPositions.length,
  };
}

function short(id: string): string {
  return id.slice(0, 8);
}

/** Turn a snapshot into intents. Every rejection is recorded with its reason —
 *  a user seeing "3 signals skipped: no budget" understands the caps are working;
 *  a user seeing nothing assumes we are broken. */
async function considerSignals(d: LoopDeps, view: AccountView, allocation: Allocation): Promise<number> {
  if (!d.snapshot) return 0;
  // Strongest calls first, so a budget that runs out runs out on the weakest.
  const ranked = [...d.snapshot.series].sort(
    (x, y) => Math.abs(y.outlook.displacement_sigma) - Math.abs(x.outlook.displacement_sigma),
  );

  let deployed = allocation.deployedUsd;
  let openCount = allocation.openCount;
  let opened = 0;

  for (const series of ranked) {
    const ev = evaluateSeries(series, d.now, GATE);
    if (!ev.ok) {
      // `no-direction` and `mode-excluded` used to be dropped here, because 264 of 277
      // outlooks are neutral and one row per neutral series per 60s loop would have
      // buried the skips that say something about the caps. That solved the repetition
      // by discarding the information: "62 of 76 outlooks carried no direction" is the
      // honest answer to *why did nothing happen today*, which is the question the
      // screen exists to answer.
      //
      // `recordSkip` is an upsert now — one row per (signal, reason), whatever the
      // loop interval — so a neutral series costs one row for its whole life instead
      // of 1,440 a day, and there is nothing left to suppress.
      d.store.recordSkip(d.master, skip(
        ev.reason, ev.detail, stableOutlookId(series.outlook.outlook_id),
        series.outlook.revision, ev.coin, d.now,
      ));
      continue;
    }
    const call = ev.call;
    d.store.recordSignal({
      signalRef: call.signalRef, revision: call.signalRevision, coin: call.coin, side: call.side,
      mode: call.mode, strength: call.strength, displacementSigma: call.displacementSigma,
      targetPx: call.targetPx, horizonAt: call.horizonAt, raw: series,
    }, d.now);

    const record = (reason: SkipReason, detail: string) =>
      d.store.recordSkip(d.master, skip(reason, detail, call.signalRef, call.signalRevision, call.coin, d.now));

    // Re-published every poll, and under a new `outlook_id` on every revision.
    // `call.signalRef` is the stable id, so a revision of an outlook we already hold
    // is the same signal: ignore it and hold to target, stop, or horizon.
    if (d.store.hasLiveIntentFor(d.master, call.signalRef)) continue;
    if (d.store.hasLiveIntentOn(d.master, call.coin)) {
      record("already-open", `another live intent already holds ${call.coin}`);
      continue;
    }
    // A stop already fired on this market and side today, so we are not getting back in
    // (`tasks/42`, and `RISK_PARAMS.blockReentryAfterStop` carries the argument). The
    // call being still live is not new information: a stop is a statement about price,
    // and the outlook does not know it fired.
    if (RISK_PARAMS.blockReentryAfterStop
      && d.store.stoppedOutToday(d.master, call.coin, call.side, d.now)) {
      record("stopped-recently",
        `a ${call.side} on ${call.coin} already stopped out today — no re-entry until the UTC day rolls`);
      continue;
    }
    // The forecast in hand is older than our own exit on this outlook, so it cannot have
    // priced the move we just took — and after a move Quotient re-bases `ref_median` to
    // the new spot, carrying the target and `sigma_total` with it. `liveDisplacementSigma`
    // repairs the spot and cannot repair the rest, so a consumed call still reads above
    // the gate against a stale target. On 2026-09-15 that put fifteen accounts back into
    // an ETH long seven seconds before the revision that priced it at 0.354σ landed.
    //
    // Deliberately **not** a `RISK_PARAMS` constant: this is a correctness guard of the
    // same class as the live re-gate below, not a strategy knob, and it refuses only.
    // `notes/2026-09-16-the-snapshot-that-predates-the-fill.md` carries the measurement.
    const lastClose = d.store.lastCloseAt(d.master, call.signalRef);
    if (lastClose !== null && call.observedAt < lastClose) {
      record("snapshot-predates-close",
        `the forecast was observed ${call.observedAt} but we closed this outlook at ` +
        `${lastClose} — waiting for one the vendor observed after our exit`);
      continue;
    }

    // Validate, never infer: an exact lookup against live `meta`, or nothing.
    const market = d.universe.resolve(call.coin);
    if (!market) {
      record("unmapped-symbol", `${call.coin} does not resolve in HL meta`);
      await d.notify(`⚠️ SignalDesk: Quotient named an unknown Hyperliquid market "${call.coin}" — signal rejected.`);
      continue;
    }
    const mark = view.marks.get(call.coin);
    if (mark === undefined) {
      record("unmapped-symbol", `${call.coin} resolves but has no live mid`);
      continue;
    }

    // Re-gate on the price we can actually trade at. The published sigma count was
    // measured against a spot up to one poll interval old — 30 minutes at the
    // recorder's current interval. If the market has already walked to the target,
    // the edge is gone and the published number is a fiction.
    const liveSigma = liveDisplacementSigma(call, mark);
    if (Math.abs(liveSigma) < GATE.minDisplacementSigma) {
      record("displacement-below-gate",
        `${liveSigma.toFixed(2)}σ against the live mark ${mark} ` +
        `(published ${call.displacementSigma.toFixed(2)}σ vs ${call.observedSpot})`);
      continue;
    }
    if (Math.sign(liveSigma) !== (call.side === "long" ? 1 : -1)) {
      record("displacement-below-gate", `live displacement ${liveSigma.toFixed(2)}σ contradicts side=${call.side}`);
      continue;
    }

    // Read the book only now: every cheaper gate above has already passed, so this is
    // one or two info calls per poll rather than one per series.
    const capacity = await d.readDepth(call.coin);

    const verdict = preTradeCheck({
      halted: false, haltReason: null, feedAgeSec: d.feedAgeSec, side: call.side,
      allocation: { ...allocation, deployedUsd: deployed, openCount },
      settings: d.settings, freeCollateralUsd: view.freeUsd, capacity,
      agentValidUntil: d.agentValidUntil, horizonAt: new Date(call.horizonAt), now: d.now,
    });
    if (!verdict.approved) {
      record(verdict.reason, verdict.detail);
      continue;
    }

    const built = buildIntent(call, market, d.settings, verdict.marginUsd, mark, d.now);
    if (!built.ok) {
      record(built.reason, built.detail);
      continue;
    }

    await d.broker.ensureIsolated(market, built.intent.leverage);
    d.store.insertIntent(d.master, built.intent);
    deployed += built.intent.marginUsd;
    openCount += 1;
    opened += 1;
    d.log(`INTENT ${short(built.intent.intentId)} ${built.intent.rationale}`);
  }
  return opened;
}

/** Put the stop and the target on in the same tick that opened the position.
 *
 *  **The gap this closes.** `considerSignals` only writes the intent; the entry IOC
 *  goes out in `execute`, and the exits are derived from the position that exists —
 *  which, on the view the tick opened with, it does not yet. So the desired set for a
 *  fresh intent contained its entry and nothing else, and its stop waited for the next
 *  loop. Measured on mainnet 2026-09-05: entries filled at 11:20:55–58, stops rested at
 *  11:22:01–04. **63 seconds with a 20x position carrying no venue-side stop**, which is
 *  the exact failure venue-side stops exist to prevent (`docs/ACCOUNT-MODEL.md` §2).
 *
 *  **Why a second read rather than attaching the exits to the entry.** The hard rule in
 *  `CLAUDE.md` stands: HL places child orders only on a *full* parent fill, so a partial
 *  fill would carry no stop. The exits must be sized to what actually filled, and the
 *  authority on that is the venue. This is the same argument `settleView` below makes in
 *  the same function — an IOC placed a few lines up has already changed the account, so
 *  re-read rather than reason from a stale view.
 *
 *  **Why it is this narrow.** Only intents whose entry filled in *this* tick, and only
 *  their non-entry orders. It therefore cannot re-enter a position (a pending intent
 *  whose IOC did not fill keeps its existing next-loop retry, at a fresh price, rather
 *  than being retried a second later) and cannot cancel anything. Those intents also
 *  provably have no resting exits of ours to duplicate: no earlier tick ever saw the
 *  position, because it did not exist. One extra account read per tick that opened
 *  something, and none at all on the overwhelming majority of ticks that did not. */
async function protectFreshFills(d: LoopDeps, filledEntries: string[]): Promise<number> {
  if (filledEntries.length === 0) return 0;
  const fresh = await d.broker.view();
  const wanted = new Set(filledEntries);
  const exits: ReconcileAction[] = [];
  for (const i of d.store.liveIntents(d.master)) {
    if (!wanted.has(i.intent_id)) continue;
    const market = d.universe.resolve(i.coin);
    const mark = fresh.marks.get(i.coin);
    const pos = fresh.positions.find((p) => p.coin === i.coin && p.szi !== 0) ?? null;
    // No position on the fresh read means the venue has not caught up with our own
    // fill. Leave it: the next tick derives the same exits from a view that has it,
    // which is exactly the behaviour this function replaces and never worse than it.
    if (!market || mark === undefined || !pos) continue;
    const plan = planIntent(i, pos, market, {
      now: d.now, markPx: mark, slippageBps: RISK_PARAMS.slippageBps,
    });
    for (const order of plan.desired) {
      if (order.role !== "entry") exits.push({ kind: "place", order });
    }
  }
  if (exits.length === 0) return 0;
  const { placed } = await execute(exits, d);
  return placed;
}

async function execute(
  actions: ReconcileAction[],
  d: LoopDeps,
): Promise<{ placed: number; cancelled: number; filledEntries: string[] }> {
  let placed = 0;
  let cancelled = 0;
  // Intents whose entry filled in *this* call. `protectFreshFills` turns these into
  // resting exits before the tick ends; without them a new position would carry no
  // venue-side stop until the next loop.
  const filledEntries: string[] = [];
  for (const a of actions) {
    const market = d.universe.resolve(a.order.coin);
    if (!market) continue;
    if (a.kind === "cancel") {
      // Never touch an order that is not ours. There is no bulk path on purpose.
      if (!a.order.cloid) continue;
      const ok = await d.broker.cancel(market, a.order.cloid);
      d.store.setOrderStatus(a.order.cloid, ok ? "cancelled" : "gone", `reconcile: ${a.reason}`);
      d.log(`cancel ${a.order.coin} ${a.reason} ${a.order.cloid.slice(0, 10)} → ${ok ? "cancelled" : "already gone"}`);
      if (ok) cancelled++;
      continue;
    }
    const res = await placeAndRecord(a.order, market, d);
    if (res.ok) placed++;
    if (res.entryFilled) filledEntries.push(a.order.intentId);
  }
  return { placed, cancelled, filledEntries };
}

async function placeAndRecord(
  order: DesiredOrder,
  market: Market,
  d: LoopDeps,
): Promise<{ ok: boolean; entryFilled: boolean }> {
  const res = await d.broker.place(order, market);
  d.store.recordOrder({
    cloid: res.cloid, intentId: order.intentId, role: order.role, coin: order.coin,
    isBuy: order.isBuy, px: order.px, triggerPx: order.triggerPx ?? null, sz: order.sz,
    reduceOnly: order.reduceOnly, oid: res.ok ? res.oid : null,
    status: res.ok ? (res.filledSz > 0 ? "filled" : "placed") : "rejected",
    detail: res.ok ? null : res.error,
  }, d.now);

  if (!res.ok) {
    d.log(`REJECTED ${order.role} ${order.coin} ${order.sz}@${order.px}: ${res.error}`);
    // An entry the venue will not accept is a dead intent, not one to retry forever.
    if (order.role === "entry") d.store.markFailed(order.intentId, `entry rejected: ${res.error}`, d.now);
    return { ok: false, entryFilled: false };
  }
  d.log(
    `place ${order.role} ${order.coin} ${order.isBuy ? "buy" : "sell"} ${order.sz}` +
    `${order.triggerPx !== undefined ? ` trigger@${order.triggerPx}` : ""} limit@${order.px}` +
    `${res.filledSz > 0 ? ` → filled ${res.filledSz}@${res.avgPx}` : ""}`,
  );
  if (order.role === "entry" && res.filledSz > 0 && res.avgPx !== null) {
    d.store.markFilled(order.intentId, res.avgPx, res.filledSz);
    return { ok: true, entryFilled: true };
  }
  return { ok: true, entryFilled: false };
}

/** Did this position leave with the price on the stop's side of its own book?
 *
 *  **This is not an attribution and must never become one.** `close_reason` names the
 *  exit from the venue's own fill rows and `settleLedger`'s objection below stands: a
 *  wick that touched both levels is indistinguishable from the mark alone. What this
 *  answers is the narrower question `blockReentryAfterStop` actually asks — *was the
 *  price against us when we left* — which is decidable inside the tick that closes,
 *  from two numbers already frozen on the intent row.
 *
 *  Two conditions, and the first does most of the work:
 *
 *  1. **No `close` order of ours exists.** Then the position left on one of our own two
 *     resting triggers, so the only candidates are the stop and the target. A
 *     retirement, a horizon, a flip and a halt all place a `close` order and are
 *     excluded here — they are our decision, not the market's, and re-entry after one
 *     is a path the desk deliberately keeps (`tasks/46` §2.3).
 *  2. **The exit is nearer the stop than the target.** Not *at or through* the stop:
 *     measured over the 645 closed intents on the box, a strict test missed **51 of
 *     115** real stops, because `exitPx` here is the mark up to a loop interval after
 *     the trigger fired and it bounces back over the level — `xyz:CL` stopped at 99.872
 *     and read 99.889 by the time we looked, 1.7 bps above. Nearest-trigger separates
 *     the same population **perfectly: 115 of 115 stops caught, 0 missed, and all 102
 *     targets ignored.** The one extra row it flags is the 2026-09-10 `xyz:COPPER`
 *     liquidation, which is a stop that went further and is exactly what the block is
 *     for.
 *
 *  With `target_px` missing there is no second level to be nearer to, so it falls back
 *  to at-or-through the stop and under-reports rather than guessing. With `stop_px`
 *  missing the account is running without a stop and there is nothing to be blocked by.
 *
 *  ⚠ The cost of a wrong answer is deliberately asymmetric, and that is why the test
 *  may be loose: a false positive skips one signal on one market for the rest of the
 *  UTC day. A false negative is the desk buying back into what just stopped it out,
 *  which `tasks/42` measured at 54% of the desk's entire net loss. */
export function leftOnTheStopSide(i: IntentRow, orders: OrderRow[], exitPx: number): boolean {
  if (i.stop_px === null) return false;
  if (orders.some((o) => o.role === "close")) return false;
  const toStop = Math.abs(exitPx - i.stop_px);
  if (i.target_px === null) return i.side === "long" ? exitPx <= i.stop_px : exitPx >= i.stop_px;
  return toStop < Math.abs(exitPx - i.target_px);
}

/** Make the ledger agree with the venue: sizes, fills and closes.
 *
 *  *Why* a position closed is read from which of our own exit orders stopped resting,
 *  not from where the price is now — guessing from the last mark misattributes a stop
 *  as a target on any wick that touched both. */
function settleLedger(
  d: LoopDeps,
  intents: IntentRow[],
  view: AccountView,
  closings: Map<string, CloseReason>,
): number {
  const restingByKey = new Map<string, LiveOrder>();
  for (const o of view.orders) {
    const tag = parseCloid(o.cloid);
    if (tag) restingByKey.set(`${tag.intentPrefix}|${tag.role}`, o);
  }

  let closed = 0;
  for (const i of intents) {
    const pos = view.positions.find((p) => p.coin === i.coin && p.szi !== 0) ?? null;

    if (pos) {
      const held = Math.abs(pos.szi);
      if (i.status === "pending") d.store.markFilled(i.intent_id, pos.entryPx, held);
      else if (Math.abs(held - i.filled_sz) > 1e-9) d.store.updateFilled(i.intent_id, held);
      const closing = closings.get(i.intent_id);
      if (closing && i.status !== "closing") d.store.markClosing(i.intent_id, closing);
      continue;
    }

    // No position. A pending intent simply has not filled yet.
    if (i.status === "pending") {
      const forced = closings.get(i.intent_id);
      if (forced) {
        d.store.markClosed(i.intent_id, forced, 0, d.now);
        closed++;
      }
      continue;
    }

    const orders = d.store.ordersFor(i.intent_id);
    const filled = orders.find((o) => o.status === "filled" && (o.role === "tp" || o.role === "sl" || o.role === "close"));
    // A `tp` or `sl` we have *seen* fill outranks the plan, because a trigger fires
    // for exactly one reason and it has already happened. The plan comes next: a
    // `close` order is placed for a horizon, a retirement and a halt alike, so its
    // role alone cannot tell those apart and only the plan can.
    //
    // This ordering is close to a no-op here and is written for correctness rather
    // than for the bug it looks like it fixes. `status` is set once, at placement,
    // from the IOC's own response, so a *resting* trigger is `placed` forever and
    // only a trigger that crossed on arrival is ever seen as `filled`. The real
    // correction is `exitFromFills` in `src/exec/fills.ts`, which reads the venue's
    // rows after the fact — see the comment there.
    const seenTrigger: CloseReason | null =
      filled?.role === "tp" ? "target" : filled?.role === "sl" ? "stop" : null;
    const reason: CloseReason = seenTrigger
      ?? closings.get(i.intent_id)
      ?? (i.close_reason as CloseReason | null)
      ?? "retired";
    const exitPx = filled?.trigger_px ?? filled?.px ?? view.marks.get(i.coin) ?? i.entry_px ?? 0;
    const signed = i.side === "long" ? i.filled_sz : -i.filled_sz;
    const pnl = i.entry_px === null ? null : Math.round((exitPx - i.entry_px) * signed * 100) / 100;
    d.store.markClosed(i.intent_id, reason, pnl, d.now);
    if (leftOnTheStopSide(i, orders, exitPx)) {
      d.store.markStoppedOut(i.intent_id, d.now);
      d.log(
        `${i.coin} ${short(i.intent_id)}: left at ${exitPx} — nearer its stop ${i.stop_px} than its ` +
        `target ${i.target_px}, on a trigger we did not place. No re-entry on ${i.coin} ${i.side} ` +
        `until the UTC day rolls, whatever the fill ingest ends up calling it`,
      );
    }
    d.store.recordEvent(d.master, "close", `${i.coin} ${i.side} closed on ${reason}, P&L ≈ $${pnl?.toFixed(2) ?? "?"}`, d.now);
    d.log(`CLOSED ${short(i.intent_id)} ${i.coin} ${i.side} on ${reason}, P&L ≈ $${pnl?.toFixed(2) ?? "?"}`);
    closed++;

    // Nothing of ours should still be resting against a closed intent.
    const prefix = intentPrefix(i.intent_id);
    for (const role of ["tp", "sl", "close"] as const) {
      const leftover = restingByKey.get(`${prefix}|${role}`);
      if (leftover?.cloid) d.store.setOrderStatus(leftover.cloid, "orphaned", "position closed");
    }
  }
  return closed;
}

/** SIGTERM path.
 *
 *  Two rules in the design point opposite ways here, and the resolution is not
 *  "cancel everything":
 *
 *   * `tasks/03` says every runner cancels its own resting orders before exit.
 *     That rule exists because `systemctl stop` on OutcomeMaker left *quoting* orders
 *     on the book — resting bids that could fill while nothing was watching and open
 *     exposure nobody had decided to take.
 *   * `docs/ACCOUNT-MODEL.md` §2 says a position keeps its stop even if our process
 *     is gone, and that a disconnect leaving a position open is degraded rather than
 *     naked. That property is the reason stops go on the venue at all.
 *
 *  Cancelling a reduce-only stop on the way out would satisfy the first rule and
 *  destroy the second, leaving a leveraged position unprotected for the length of a
 *  deploy. So the rule this implements is the one both are actually reaching for:
 *  **cancel every order of ours that could open or increase exposure; leave the
 *  reduce-only exits resting.** A reduce-only order cannot create a position — the
 *  worst it can do is close one we already decided to close.
 *
 *  Orders that are not ours are never touched, on the way out or otherwise. */
export async function cancelOurRestingOrders(d: Pick<LoopDeps, "broker" | "universe" | "store" | "master" | "log">): Promise<number> {
  const view = await d.broker.view();
  let cancelled = 0;
  let kept = 0;
  let foreign = 0;
  for (const o of view.orders) {
    if (!o.cloid || !parseCloid(o.cloid)) { foreign++; continue; }
    if (o.reduceOnly) { kept++; continue; }
    const market = d.universe.resolve(o.coin);
    if (!market) continue;
    if (await d.broker.cancel(market, o.cloid)) {
      d.store.setOrderStatus(o.cloid, "cancelled", "shutdown");
      cancelled++;
    }
  }
  const detail = `cancelled ${cancelled} exposure-opening order(s); left ${kept} reduce-only exit(s) ` +
    `on the venue and ${foreign} order(s) that were not ours`;
  d.store.recordEvent(d.master, "shutdown", detail);
  d.log(`shutdown: ${detail}`);
  return cancelled;
}
