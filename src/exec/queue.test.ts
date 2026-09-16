import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LIVE_MANDATE } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { WebStore } from "../web/sessions.ts";
import {
  admissionState, planAdmissions, positionOf, queueOrder, readQueue, referralCounts,
  serviceQueue, SLOT_HOLD_HOURS, type QueueRow,
} from "./queue.ts";

// A boost is an order change on a queue for real money (`tasks/17` §5). The failure
// that matters is not somebody gaming the order — it is a slot going to the wrong
// account. So the ordering is a pure function and this file is the fixture it is held
// to.

const HOUR = 3600_000;
const T0 = Date.parse("2026-09-05T00:00:00.000Z");

function row(address: string, hoursAgo: number, extra: Partial<QueueRow> = {}): QueueRow {
  return {
    address, joinedAt: T0 - hoursAgo * HOUR,
    invitedAt: null, postedAt: null, referredBy: null, xLinked: false, fundedAt: null,
    lapsedAt: null,
    ...extra,
  };
}

test("with no boosts the queue is arrival order", () => {
  const rows = [row("0xc", 1), row("0xa", 3), row("0xb", 2)];
  assert.deepEqual(queueOrder(rows), ["0xa", "0xb", "0xc"]);
  assert.equal(positionOf(rows, "0xb"), 2);
  assert.equal(positionOf(rows, "0xzz"), null);
});

test("a post moves you past everyone who has not posted, and no further", () => {
  const rows = [
    row("0xearly", 10),
    row("0xlate", 1, { postedAt: T0 }),
    row("0xearlier", 20),
    row("0xalso", 2, { postedAt: T0 }),
  ];
  // One tier, not an arithmetic of places (`tasks/17` §6.1): both posters come first,
  // and among themselves they are still in arrival order.
  assert.deepEqual(queueOrder(rows), ["0xalso", "0xlate", "0xearlier", "0xearly"]);
});

test("a second post does not move you twice — the boost is a tier", () => {
  const once = [row("0xa", 5, { postedAt: T0 - HOUR }), row("0xb", 4, { postedAt: T0 })];
  const twice = [row("0xa", 5, { postedAt: T0 - HOUR }), row("0xb", 4, { postedAt: T0 })];
  assert.deepEqual(queueOrder(once), queueOrder(twice));
});

// The condition is the X link and not funding, and that is a correction rather than a
// preference: depositing happens at step 2 of the connect flow, on the far side of
// admission, and a referred account is behind its referrer in the queue by construction.
// A funded referral could therefore only ever land after it could have mattered.
test("a referral counts once the account it brought has linked X", () => {
  const rows = [
    row("0xref", 5),
    row("0xbrought", 1, { referredBy: "0xref", xLinked: true }),
    row("0xtyre-kicker", 1, { referredBy: "0xref" }),
  ];
  assert.equal(referralCounts(rows).get("0xref"), 1, "the unlinked one must not count");
});

test("funding is not the condition, and does not quietly become one again", () => {
  const rows = [
    row("0xref", 5),
    row("0xfunded-only", 1, { referredBy: "0xref", fundedAt: T0 }),
  ];
  assert.equal(referralCounts(rows).get("0xref"), undefined);
});

// Uncapped on purpose: somebody with an audience who posts their link brings many
// people, and that is the outcome referrals exist to reward.
test("referrals are not capped", () => {
  const brought = Array.from({ length: 40 }, (_, i) =>
    row(`0xb${i}`, 1, { referredBy: "0xref", xLinked: true }));
  const rows = [row("0xref", 5), ...brought];
  assert.equal(referralCounts(rows).get("0xref"), 40);
});

test("more referrals outrank fewer", () => {
  const rows = [
    row("0xfew", 10), row("0xmany", 10),
    row("0xb1", 1, { referredBy: "0xfew", xLinked: true }),
    ...Array.from({ length: 5 }, (_, i) => row(`0xm${i}`, 1, { referredBy: "0xmany", xLinked: true })),
  ];
  const order = queueOrder(rows);
  assert.ok(order.indexOf("0xmany") < order.indexOf("0xfew"));
});

test("self-referral earns nothing", () => {
  const rows = [row("0xa", 5, { referredBy: "0xa", xLinked: true })];
  assert.equal(referralCounts(rows).get("0xa"), undefined);
});

test("an operator's invite outranks a post, and a post outranks referrals", () => {
  const rows = [
    row("0xreferrer", 30),
    row("0xb1", 29, { referredBy: "0xreferrer", xLinked: true }),
    row("0xb2", 28, { referredBy: "0xreferrer", xLinked: true }),
    row("0xposter", 2, { postedAt: T0 }),
    row("0xkol", 1, { invitedAt: T0 }),
    row("0xnobody", 40),
  ];
  const order = queueOrder(rows);
  assert.equal(order[0], "0xkol");
  assert.equal(order[1], "0xposter");
  assert.equal(order[2], "0xreferrer");
  // Everyone else is arrival order among themselves.
  assert.deepEqual(order.slice(3), ["0xnobody", "0xb1", "0xb2"]);
});

test("the order is total and stable — two identical rows never swap between loops", () => {
  const rows = [row("0xb", 5), row("0xa", 5)];
  assert.deepEqual(queueOrder(rows), ["0xa", "0xb"]);
  assert.deepEqual(queueOrder([...rows].reverse()), ["0xa", "0xb"]);
});

test("queueOrder does not mutate what it is given", () => {
  const rows = [row("0xc", 1), row("0xa", 3)];
  const before = rows.map((r) => r.address);
  queueOrder(rows);
  assert.deepEqual(rows.map((r) => r.address), before);
});

// ── Who may enter the connect flow ──────────────────────────────────────────

const gate = (o: Partial<Parameters<typeof admissionState>[0]>) => admissionState({
  pinned: false, hasAccountRow: false, connectionStatus: null,
  admissionExpiresAt: null, now: T0, ...o,
});

test("an address with nothing is queued, not admitted", () => {
  assert.deepEqual(gate({}), { admitted: false, why: "queued" });
});

test("an operator-named address is admitted whatever the queue says", () => {
  assert.deepEqual(gate({ pinned: true }), { admitted: true, why: "pinned" });
});

// Everybody who was already connected, or mid-connect, when this shipped. A gate that
// locked them out would have been a queue in front of accounts we are already trading.
test("an account already connected, or in flight, stays admitted", () => {
  assert.equal(gate({ hasAccountRow: true }).admitted, true);
  assert.equal(gate({ connectionStatus: "awaiting_approval" }).admitted, true);
  assert.equal(gate({ connectionStatus: "active" }).admitted, true);
  assert.equal(gate({ connectionStatus: "disconnected" }).admitted, false,
    "an account that was let go starts over");
});

test("an admission holds until it expires, and then it is lapsed rather than absent", () => {
  const soon = new Date(T0 + HOUR).toISOString();
  const gone = new Date(T0 - HOUR).toISOString();
  assert.deepEqual(gate({ admissionExpiresAt: soon }), { admitted: true, why: "admitted" });
  assert.deepEqual(gate({ admissionExpiresAt: gone }), { admitted: false, why: "lapsed" });
});

// ── How many are let in ─────────────────────────────────────────────────────

test("nobody is admitted while every slot is in use", () => {
  const queue = [row("0xa", 5), row("0xb", 4)];
  const live = Array.from({ length: LIVE_MANDATE.maxLiveAccounts }, (_, i) => `0xlive${i}`);
  const plan = planAdmissions({ queue, liveAccounts: live, heldSlots: [], notWaiting: [] });
  assert.deepEqual(plan.admit, []);
  assert.equal(plan.free, 0);
  assert.deepEqual(plan.waiting, ["0xa", "0xb"], "and both are still waiting");
});

test("a freed slot goes to the front of the queue, one slot at a time", () => {
  const queue = [row("0xa", 5), row("0xb", 4), row("0xc", 3)];
  const live = Array.from({ length: LIVE_MANDATE.maxLiveAccounts - 1 }, (_, i) => `0xlive${i}`);
  const plan = planAdmissions({ queue, liveAccounts: live, heldSlots: [], notWaiting: [] });
  assert.deepEqual(plan.admit, ["0xa"]);
});

// The slot has to be held by the admission, or one loop admits the whole queue and the
// venue refuses all but the last of them.
test("an admission that has not connected yet still holds its slot", () => {
  const queue = [row("0xa", 5), row("0xb", 4)];
  const live = Array.from({ length: LIVE_MANDATE.maxLiveAccounts - 1 }, (_, i) => `0xlive${i}`);
  const plan = planAdmissions({ queue, liveAccounts: live, heldSlots: ["0xa"], notWaiting: [] });
  assert.deepEqual(plan.admit, [], "the free slot is the one 0xa is holding");
  assert.deepEqual(plan.waiting, ["0xb"], "and 0xa is no longer waiting");
});

test("addresses that are already past the queue are never admitted twice", () => {
  const queue = [row("0xa", 5), row("0xb", 4)];
  const plan = planAdmissions({
    queue, liveAccounts: [], heldSlots: [], notWaiting: ["0xA"], max: 4,
  });
  assert.deepEqual(plan.admit, ["0xb"], "case must not decide this");
});

test("the plan never admits more than the cap, whatever the queue length", () => {
  const queue = Array.from({ length: 50 }, (_, i) => row(`0x${i}`, 50 - i));
  const plan = planAdmissions({ queue, liveAccounts: [], heldSlots: [], notWaiting: [] });
  assert.equal(plan.admit.length, LIVE_MANDATE.maxLiveAccounts);
});

test("a held slot outlives a weekend deposit and not the person's interest", () => {
  assert.ok(SLOT_HOLD_HOURS >= 24 && SLOT_HOLD_HOURS <= 168);
});

// ── One pass over the real two databases ────────────────────────────────────
//
// The pure parts above are the decision; this is the wiring that has to agree with it —
// the read-only read of the web tier's file, the admission written into the ledger, and
// the idempotence that stops a second loop handing out the same slot twice.

function rig() {
  const dir = mkdtempSync(join(tmpdir(), "signaldesk-queue-"));
  const store = new Store(join(dir, "ledger.sqlite"), { log: () => {} });
  const web = new WebStore(join(dir, "web.sqlite"));
  return {
    dir, store, web, queueDb: join(dir, "web.sqlite"),
    run: (liveAccounts: string[], pinned: string[] = []) =>
      serviceQueue({ store, queueDb: join(dir, "web.sqlite"), liveAccounts, pinned, log: () => {} }),
    done: () => { store.close(); web.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const ADDR = (n: number) => `0x${String(n).padStart(40, "0")}`;

test("the queue is read out of the web tier's own database, and read-only", () => {
  const r = rig();
  try {
    r.web.joinQueue(ADDR(1), null, T0);
    assert.deepEqual(readQueue(r.queueDb).map((q) => q.address), [ADDR(1)]);
    assert.equal(readQueue(join(r.dir, "nothing-here.sqlite")).length, 0,
      "no database is an empty queue, not a crash");
  } finally { r.done(); }
});

test("a free slot is filled from the front, and only once", () => {
  const r = rig();
  try {
    r.web.joinQueue(ADDR(1), null, T0 - 2 * HOUR);
    r.web.joinQueue(ADDR(2), null, T0 - HOUR);
    const live = [ADDR(90), ADDR(91), ADDR(92)].slice(0, LIVE_MANDATE.maxLiveAccounts - 1);

    assert.deepEqual(r.run(live), [ADDR(1)]);
    assert.equal(r.store.admission(ADDR(1))?.reason, "queue");
    // The admission now holds the slot, so a second pass over an unchanged venue
    // writes nothing — the property every loop in this system has to have.
    assert.deepEqual(r.run(live), []);
    assert.equal(r.store.admission(ADDR(2)), null);
  } finally { r.done(); }
});

test("nobody is admitted while the desk is full, ours included in the count", () => {
  const r = rig();
  try {
    r.web.joinQueue(ADDR(1), null, T0);
    const live = Array.from({ length: LIVE_MANDATE.maxLiveAccounts }, (_, i) => ADDR(90 + i));
    assert.deepEqual(r.run(live, [ADDR(90)]), [], "the pinned account is counted, not exempt");
    assert.equal(r.store.admission(ADDR(1)), null);
  } finally { r.done(); }
});

test("an account that connected releases the slot its admission was holding", () => {
  const r = rig();
  try {
    r.web.joinQueue(ADDR(1), null, T0 - 2 * HOUR);
    r.web.joinQueue(ADDR(2), null, T0 - HOUR);
    const live = [ADDR(90), ADDR(91), ADDR(92)].slice(0, LIVE_MANDATE.maxLiveAccounts - 1);
    assert.deepEqual(r.run(live), [ADDR(1)]);

    // 0x…1 connects. Its account row is what holds the slot from here, so counting the
    // admission as well would double-count one person and freeze the queue.
    r.store.connectAccount(ADDR(1), 100, { leverage: 10 }, "live");
    assert.deepEqual(r.run([...live, ADDR(1)]), [], "the desk is full again, so nobody moves");
    assert.deepEqual(r.run(live), [ADDR(2)], "and a slot freeing goes to the next in line");
  } finally { r.done(); }
});

// A lapse has to do two things at once: give the slot back, and cost the person who
// let it lapse their turn. Only the first would re-admit them on the next loop, and the
// hold would renew itself forever while everybody behind them waited.
test("a lapsed admission gives its slot back and its holder goes to the back", () => {
  const r = rig();
  try {
    r.web.joinQueue(ADDR(1), null, T0 - 2 * HOUR);
    r.web.joinQueue(ADDR(2), null, T0 - HOUR);
    const live = [ADDR(90), ADDR(91), ADDR(92)].slice(0, LIVE_MANDATE.maxLiveAccounts - 1);
    r.store.admit(ADDR(1), "queue", new Date(Date.now() - 1000));
    assert.deepEqual(r.run(live), [ADDR(2)], "the slot goes to the person who waited");
  } finally { r.done(); }
});

test("in the ordering, a lapse counts as joining again at the moment it ran out", () => {
  const rows = [
    row("0xlapsed", 10, { lapsedAt: T0 - HOUR }),
    row("0xwaiting", 2),
  ];
  assert.deepEqual(queueOrder(rows), ["0xwaiting", "0xlapsed"]);
});
