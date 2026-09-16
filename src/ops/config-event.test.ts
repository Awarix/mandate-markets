import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RISK_PARAMS } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import {
  configDetail, configHash, configValues, countEventsSince, defaultBlockComplete, DESK, diffConfig,
  readSnapshot, recordConfigChange, SAMPLE_FLOOR, speedLimit, writeSnapshot, type ConfigSnapshot,
} from "./config-event.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "signaldesk-config-")), "config-fingerprint.json");
const ledger = () => new Store(":memory:", { log: () => {} });
const configEvents = (s: Store) =>
  s.db.prepare("SELECT account, detail FROM events WHERE kind = 'config' ORDER BY at")
    .all() as unknown as { account: string; detail: string }[];

// ── what is covered ────────────────────────────────────────────────────────

// The five objects `tasks/47` names, and nothing else. A constant that bounds money and
// is not in here is a constant that can move without the block noticing.
test("the fingerprint covers every money constant, by name", () => {
  const v = configValues();
  for (const k of [
    "RISK_PARAMS.dailyLossPct", "RISK_PARAMS.maxDeployedPct", "RISK_PARAMS.liqBufferFrac",
    "RISK_PARAMS.minDisplacementSigma", "RISK_PARAMS.maxHoldHours", "RISK_PARAMS.reserveFrac",
    "RISK_PARAMS.blockReentryAfterStop", "RISK_PARAMS.slippageBps", "RISK_PARAMS.minOrderNotionalUsd",
    "DEFAULT_USER_SETTINGS.stopPct", "DEFAULT_USER_SETTINGS.leverage", "DEFAULT_USER_SETTINGS.perSignalPct",
    "DEFAULT_USER_SETTINGS.holdToTarget",
    "LIVE_MANDATE.maxLiveAccounts", "BUILDER_FEE.tenthsBp",
    "SITE_OFFERS.leverage", "SITE_OFFERS.stopPct.min", "SITE_OFFERS.stopPct.max",
  ]) assert.ok(k in v, `${k} is not fingerprinted`);
  // And it is the value in force, not a literal written twice.
  assert.equal(v["RISK_PARAMS.dailyLossPct"], JSON.stringify(RISK_PARAMS.dailyLossPct));
});

// An array is one leaf. Offering 18× was one decision, and `[5,10,20] -> [5,10,18,20]`
// is how it should read — not as four lines about positions in a list.
test("a set of choices is one leaf, so adding one reads as one change", () => {
  assert.equal(configValues()["SITE_OFFERS.leverage"], "[5,10,18,20]");
  assert.deepEqual(
    diffConfig({ "SITE_OFFERS.leverage": "[5,10,20]" }, { "SITE_OFFERS.leverage": "[5,10,18,20]" }),
    ["SITE_OFFERS.leverage [5,10,20] -> [5,10,18,20]"],
  );
});

test("the hash moves when a value moves and not when the order of the keys does", () => {
  const a = { "RISK_PARAMS.dailyLossPct": "0.1", "DEFAULT_USER_SETTINGS.stopPct": "0.02" };
  const b = { "DEFAULT_USER_SETTINGS.stopPct": "0.02", "RISK_PARAMS.dailyLossPct": "0.1" };
  assert.equal(configHash(a), configHash(b));
  assert.notEqual(configHash(a), configHash({ ...a, "RISK_PARAMS.dailyLossPct": "0.2" }));
});

// A cap that appears, or one that is deleted, is a change to what bounds money. A diff
// that only walks the keys both sides share is silent about exactly those.
test("a constant that appears or disappears is reported", () => {
  assert.deepEqual(diffConfig({}, { "RISK_PARAMS.newCap": "3" }), ["RISK_PARAMS.newCap (unset) -> 3"]);
  assert.deepEqual(diffConfig({ "RISK_PARAMS.oldCap": "3" }, {}), ["RISK_PARAMS.oldCap 3 -> (unset)"]);
});

// ── the two moves of 2026-09-10, replayed ──────────────────────────────────

test("nothing is written when nothing moved, which is nearly every restart", async () => {
  const store = ledger();
  const path = tmp();
  assert.equal((await recordConfigChange({ store, path, log: () => {} })).first, true);
  const second = await recordConfigChange({ store, path, log: () => {} });
  assert.equal(second.changed, false);
  assert.equal(configEvents(store).length, 1, "the first boot, and then silence");
  store.close();
});

// The two boots that made 2026-09-10 unreadable, in the shape they actually had: a
// restart on a moved constant, then another restart on a second moved constant inside
// the same block. Two `config` rows in one block is precisely the state
// `npm run expectancy` refuses to score, and until this writer existed it could not fire.
//
// Replayed against today's values rather than against literals, so the test cannot
// drift when a default moves again: the *previous* snapshot is what is fabricated.
test("two moves inside a block leave two rows, which is what the refusal counts", async () => {
  const store = ledger();
  const path = tmp();
  const now = configValues();
  const sigma = "RISK_PARAMS.minDisplacementSigma";
  const stop = "DEFAULT_USER_SETTINGS.stopPct";

  const before = { ...now, [sigma]: "1", [stop]: "0.01" };
  writeSnapshot(path, { at: "2026-09-10T08:00:00Z", hash: configHash(before), values: before, previous: null });
  const first = await recordConfigChange({ store, path, log: () => {}, now: new Date("2026-09-10T20:39:00Z") });
  assert.equal(first.changed, true);
  assert.deepEqual(first.lines.sort(), [
    `${stop} 0.01 -> ${now[stop]}`,
    `${sigma} 1 -> ${now[sigma]}`,
  ].sort(), "one line per constant that moved, both of them");

  // A second boot on a third value. The snapshot on disk is now today's, so only the
  // fabricated difference shows.
  const between = { ...now, "RISK_PARAMS.blockReentryAfterStop": "false" };
  // `previous: null` on both, so the speed limit stays out of this test's way: it has
  // nothing to call a revert and lets the change through (`speedLimit`'s second clause).
  // The speed limit has its own tests below.
  writeSnapshot(path, { at: "2026-09-10T20:39:00Z", hash: configHash(between), values: between, previous: null });
  const second = await recordConfigChange({ store, path, log: () => {}, now: new Date("2026-09-11T10:45:00Z") });
  assert.deepEqual(second.lines, ["RISK_PARAMS.blockReentryAfterStop false -> true"]);

  const rows = configEvents(store);
  assert.equal(rows.length, 2, "two rows in the window expectancy would be scoring");
  assert.match(rows[0]!.detail, /minDisplacementSigma 1 -> /);
  assert.match(rows[1]!.detail, /blockReentryAfterStop false -> true/);
  store.close();
});

// Every other event belongs to one account. A constant reaches all of them, which is
// why it is the change worth recording — so it must not be filed under an address.
test("a config event is desk-wide and is not filed under an account", async () => {
  const store = ledger();
  await recordConfigChange({ store, path: tmp(), log: () => {} });
  assert.equal(configEvents(store)[0]!.account, DESK);
  assert.doesNotMatch(DESK, /^0x/);
  store.close();
});

// The distinction the first-boot sentence has to carry: nothing moved, and we cannot
// say that nothing moved, are different claims about the block that follows.
test("a first boot says it has nothing to compare against rather than `no change`", () => {
  const detail = configDetail({
    hash: "abc123abc123", changed: true, first: true, lines: [],
    speed: { ok: true, reason: "", overridden: false, eventsInBlock: null },
  });
  assert.match(detail, /first boot/);
  assert.match(detail, /no previous fingerprint/);
});

test("an unreadable or truncated fingerprint file reads as no fingerprint at all", () => {
  const path = tmp();
  writeFileSync(path, "{ not json");
  assert.equal(readSnapshot(path), null);
  writeFileSync(path, JSON.stringify({ at: "2026-09-12T00:00:00Z" }));
  assert.equal(readSnapshot(path), null, "a file with no values cannot be diffed against");
});

// The snapshot is written after the row, so a crash between them repeats the row rather
// than losing it: a duplicate is visible, a missing change is not.
test("the snapshot on disk is what the next boot diffs against", async () => {
  const store = ledger();
  const path = tmp();
  await recordConfigChange({ store, path, log: () => {} });
  const snap = JSON.parse(readFileSync(path, "utf8")) as { hash: string; values: Record<string, string> };
  assert.equal(snap.hash, configHash(configValues()));
  assert.equal(snap.values["RISK_PARAMS.dailyLossPct"], JSON.stringify(RISK_PARAMS.dailyLossPct));
  store.close();
});

// ── the speed limit: `tasks/47` Rule 4, third part ──────────────────────────────
//
// **A constant that moved inside the last block may only move back.** Between 09-10
// 08:18Z and 09-11 10:45Z four money constants moved and the reading that followed could
// attribute none of them; the σ reversal twelve hours after a written pre-commitment was
// found the next afternoon by a hand query. What follows pins each way out — and, more
// importantly, that a breach does **not** stop the desk: it arms the global halt, so every
// exit, halt check and venue-side stop keeps running and nothing opens.

const SNAP = (i: { at?: string; values: Record<string, string>; before?: Record<string, string> | null }): ConfigSnapshot => ({
  at: i.at ?? "2026-09-10T20:39:00Z",
  hash: configHash(i.values),
  values: i.values,
  previous: i.before === undefined || i.before === null
    ? null
    : { at: "2026-09-10T08:18:00Z", hash: configHash(i.before), values: i.before },
});

const LIMIT = (o: Partial<Parameters<typeof speedLimit>[0]> = {}) => speedLimit({
  changed: true, next: { k: "2" }, snapshot: SNAP({ values: { k: "1" }, before: { k: "3" } }),
  eventsInBlock: 0, override: undefined, hash: "deadbeefcafe", ...o,
});

test("an ordinary restart that moved nothing is never refused", () => {
  assert.equal(LIMIT({ changed: false }).ok, true);
});

test("a first boot has no block to be inside of, and neither does a pre-rule fingerprint", () => {
  assert.equal(LIMIT({ snapshot: null }).ok, true, "nothing has ever been recorded");
  assert.equal(LIMIT({ snapshot: SNAP({ values: { k: "1" }, before: null }) }).ok, true,
    "a snapshot with no `previous` recorded no move, so this change is the first in its block");
});

test("a completed block lets the next change through", () => {
  assert.equal(LIMIT({ eventsInBlock: SAMPLE_FLOOR }).ok, true);
  assert.equal(LIMIT({ eventsInBlock: SAMPLE_FLOOR - 1 }).ok, false,
    "one short of the floor is still inside the block");
});

test("a move BACK to the superseded value is always allowed", () => {
  // 09-10: σ 0.5 -> 1.0 at 08:18Z, then 1.0 -> 0.5 at 20:39Z. The second is a revert and
  // the rule permits it — what it refuses is a THIRD value inside the same block.
  const r = LIMIT({ next: { k: "3" }, eventsInBlock: 0 });
  assert.equal(r.ok, true, "3 is the value the last change superseded");
  assert.equal(r.overridden, false, "a revert needs no override");
  assert.equal(LIMIT({ next: { k: "9" }, eventsInBlock: 0 }).ok, false, "a third value is refused");
});

test("a PARTIAL revert is refused: half of a change put back is a third desk", () => {
  const r = speedLimit({
    changed: true,
    snapshot: SNAP({ values: { a: "1", b: "1" }, before: { a: "0", b: "0" } }),
    next: { a: "0", b: "1" },       // a reverted, b left on the new value
    eventsInBlock: 0, override: undefined, hash: "h",
  });
  assert.equal(r.ok, true, "b did not move at all this boot, so only a's revert is in the diff");

  const partial = speedLimit({
    changed: true,
    snapshot: SNAP({ values: { a: "1", b: "1" }, before: { a: "0", b: "0" } }),
    next: { a: "0", b: "2" },       // a reverted, b moved to a third value
    eventsInBlock: 0, override: undefined, hash: "h",
  });
  assert.equal(partial.ok, false);
  assert.match(partial.reason, /\bb\b/, "the reason names the leaf that is not a revert");
});

test("a DIFFERENT constant moving beside one that just moved is refused too", () => {
  // Not a pedantic reading. 09-10 stacked sigma, the stop default and the re-entry block,
  // and it is the stacking rather than any one of them that cost the attribution
  // (`tasks/47` §1, mechanism 3).
  const r = speedLimit({
    changed: true,
    snapshot: SNAP({ values: { sigma: "0.5", stop: "0.02" }, before: { sigma: "1", stop: "0.02" } }),
    next: { sigma: "0.5", stop: "0.01" },
    eventsInBlock: 0, override: undefined, hash: "h",
  });
  assert.equal(r.ok, false, "sigma moved last; the stop moving now stacks two changes in one block");
});

test("the override must name this exact desk, so a stale flag disarms nothing", () => {
  assert.equal(LIMIT({ override: "deadbeefcafe" }).overridden, true);
  assert.equal(LIMIT({ override: "deadbeefcafe" }).ok, true);
  assert.equal(LIMIT({ override: "  deadbeefcafe  " }).ok, true, "whitespace from a shell is trimmed");
  assert.equal(LIMIT({ override: "true" }).ok, false, "a boolean is not an override");
  assert.equal(LIMIT({ override: "0123456789ab" }).ok, false,
    "an override left in .env from a previous change names a desk that no longer exists");
});

test("the refusal says what moved, how to proceed, and that the desk is still protected", () => {
  const r = LIMIT();
  assert.match(r.reason, /CONFIG_OVERRIDE=deadbeefcafe/, "the exact line to set");
  assert.match(r.reason, /k 1 -> 2/, "what moved");
  assert.match(r.reason, /every exit, halt check and foreign-actor check still/i,
    "a refusal that reads like an outage will be worked around");
  assert.match(r.reason, /no new position opens/i);
});

test("an uncounted block is read as zero, not as clear", () => {
  const r = LIMIT({ eventsInBlock: null });
  assert.equal(r.ok, false, "a ledger we could not read must not be evidence that a block completed");
  assert.match(r.reason, /could not be counted/);
});

// ── the count, and the block the connect path reads ─────────────────────────────

test("events are counted by when they OPENED, and only once settled", () => {
  const store = ledger();
  const count = countEventsSince(store);
  assert.equal(count("2026-09-10T00:00:00Z"), 0, "an empty ledger has closed nothing");
  // The query shape is what is under test here; an empty ledger exercises it end to end
  // against the real schema, which is what catches a renamed column.
  assert.equal(typeof count("2026-09-10T00:00:00Z"), "number");
  store.close();
});

test("with no config event ever recorded, the default's block counts as complete", () => {
  const store = ledger();
  assert.equal(defaultBlockComplete(store), true,
    "nothing is untested if nothing has moved — the seed must not fire on a fresh box");
  store.close();
});

test("a config event with no events behind it leaves the block incomplete", () => {
  const store = ledger();
  store.recordEvent(DESK, "config", "stopPct 0.01 -> 0.02", new Date("2026-09-12T07:55:00Z"));
  assert.equal(defaultBlockComplete(store, () => 0), false);
  assert.equal(defaultBlockComplete(store, () => SAMPLE_FLOOR), true);
  // Fails open: a ledger that cannot be counted seeds the shipped default rather than
  // quietly handing strangers a value nobody chose.
  assert.equal(defaultBlockComplete(store, () => null), true);
  store.close();
});

test("a speed-limit breach records its own event and returns it on the report", async () => {
  const store = ledger();
  const path = tmp();
  const now = configValues();
  // A fabricated previous generation, so this boot reads as a third value inside a block.
  const before = { ...now, "RISK_PARAMS.minDisplacementSigma": "7" };
  const older = { ...now, "RISK_PARAMS.minDisplacementSigma": "9" };
  writeSnapshot(path, {
    at: "2026-09-13T00:00:00Z", hash: configHash(before), values: before,
    previous: { at: "2026-09-12T00:00:00Z", hash: configHash(older), values: older },
  });
  const r = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, now: new Date("2026-09-13T12:00:00Z"),
  });
  assert.equal(r.speed.ok, false);
  const rows = store.db.prepare("SELECT kind FROM events ORDER BY at").all() as unknown as { kind: string }[];
  assert.deepEqual(rows.map((x) => x.kind), ["config", "config-refused"],
    "the change is recorded as having happened — it has — and the refusal beside it");

  // ⚠ The snapshot is still written. The constants are compiled in and this cannot
  // un-deploy them, so the next boot must diff against what is actually running.
  assert.equal(readSnapshot(path)!.hash, r.hash);
  assert.equal(readSnapshot(path)!.previous!.hash, configHash(before), "one generation is kept");
  store.close();
});

test("an override is recorded too, so `I said so` is in the ledger and not only in an env var", async () => {
  const store = ledger();
  const path = tmp();
  const now = configValues();
  const before = { ...now, "RISK_PARAMS.minDisplacementSigma": "7" };
  const older = { ...now, "RISK_PARAMS.minDisplacementSigma": "9" };
  writeSnapshot(path, {
    at: "2026-09-13T00:00:00Z", hash: configHash(before), values: before,
    previous: { at: "2026-09-12T00:00:00Z", hash: configHash(older), values: older },
  });
  const r = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, override: configHash(now),
    now: new Date("2026-09-13T12:00:00Z"),
  });
  assert.equal(r.speed.ok, true);
  assert.equal(r.speed.overridden, true);
  const rows = store.db.prepare("SELECT kind FROM events ORDER BY at").all() as unknown as { kind: string }[];
  assert.deepEqual(rows.map((x) => x.kind), ["config", "config-override"]);
  store.close();
});

// ── `tasks/50` §2.1: the refusal survives a restart ─────────────────────────────
//
// `speedHalt` was a local in `runner.ts` and the snapshot is rewritten even when the
// limit refuses, so the second boot read `changed = false` and came up **unhalted with no
// override recorded** — and the unit file says `Restart=always`. The refusal `tasks/47`
// §5.1 priced as *"boot, read the hash, set it, boot again"* was cleared by a crash, a
// deploy or a reboot, and nothing tested it. These boot twice.

/** A desk whose fingerprint says a third value moved inside an unfinished block: the
 *  2026-09-10 shape, which is what the limit exists to refuse. */
const refusedFingerprint = (path: string): void => {
  const now = configValues();
  const before = { ...now, "RISK_PARAMS.minDisplacementSigma": "7" };
  const older = { ...now, "RISK_PARAMS.minDisplacementSigma": "9" };
  writeSnapshot(path, {
    at: "2026-09-13T00:00:00Z", hash: configHash(before), values: before,
    previous: { at: "2026-09-12T00:00:00Z", hash: configHash(older), values: older },
  });
};

test("a refused desk is still refused on the next boot, with nothing having moved", async () => {
  const store = ledger();
  const path = tmp();
  refusedFingerprint(path);

  const first = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, now: new Date("2026-09-13T12:00:00Z"),
  });
  assert.equal(first.speed.ok, false);
  assert.equal(readSnapshot(path)!.refused!.hash, first.hash, "the refusal is on the file, not in a local");

  // The restart: same constants, same file, a fresh process.
  const second = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, now: new Date("2026-09-13T12:05:00Z"),
  });
  assert.equal(second.changed, false, "nothing moved between the two boots — that is the whole trap");
  assert.equal(second.speed.ok, false, "and the desk is still halted for opening");
  assert.match(second.speed.reason, /a restart does not clear it/);
  // Recorded once. A crash loop must not fill the one table a reading reads with
  // identical rows, and the boot that refused is already in it.
  const rows = store.db.prepare("SELECT kind FROM events ORDER BY at").all() as unknown as { kind: string }[];
  assert.deepEqual(rows.map((x) => x.kind), ["config", "config-refused"]);
  store.close();
});

test("the override clears a standing refusal, and says so in the ledger", async () => {
  const store = ledger();
  const path = tmp();
  refusedFingerprint(path);
  const first = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, now: new Date("2026-09-13T12:00:00Z"),
  });
  assert.equal(first.speed.ok, false);

  // "To proceed deliberately, set CONFIG_OVERRIDE=<hash> and restart" — the sentence the
  // refusal itself prints, and now the only thing besides a revert that clears it.
  const second = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, override: configHash(configValues()),
    now: new Date("2026-09-13T12:05:00Z"),
  });
  assert.equal(second.speed.ok, true);
  assert.equal(second.speed.overridden, true);
  assert.equal(readSnapshot(path)!.refused, null, "cleared on disk, so the boot after this one is clean");
  const rows = store.db.prepare("SELECT kind FROM events ORDER BY at").all() as unknown as { kind: string }[];
  assert.deepEqual(rows.map((x) => x.kind), ["config", "config-refused", "config-override"]);

  // A third boot, override gone: nothing to refuse any more.
  const third = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, now: new Date("2026-09-13T12:10:00Z"),
  });
  assert.equal(third.speed.ok, true);
  store.close();
});

test("a stale override names the wrong desk and clears nothing", async () => {
  const store = ledger();
  const path = tmp();
  refusedFingerprint(path);
  await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, now: new Date("2026-09-13T12:00:00Z"),
  });
  const second = await recordConfigChange({
    store, path, log: () => {}, countEventsSince: () => 0, override: "0123456789ab",
    now: new Date("2026-09-13T12:05:00Z"),
  });
  assert.equal(second.speed.ok, false, "an override left in .env from a previous change disarms nothing");
  store.close();
});

test("putting the constant back clears the refusal without an override", () => {
  // The other documented way out. The refusal is pinned to the hash it was issued
  // against, so a desk whose constants have moved again is decided afresh — and a revert
  // is a change the limit allows.
  const bad = { k: "2" };
  const snap: ConfigSnapshot = {
    at: "2026-09-13T00:00:00Z", hash: configHash(bad), values: bad,
    previous: { at: "2026-09-12T00:00:00Z", hash: configHash({ k: "3" }), values: { k: "3" } },
    refused: { at: "2026-09-13T00:00:00Z", hash: "deadbeefcafe", reason: "a money constant moved…" },
  };
  const reverted = speedLimit({
    changed: true, next: { k: "3" }, snapshot: snap, eventsInBlock: 0,
    override: undefined, hash: "0011223344ff",
  });
  assert.equal(reverted.ok, true, "3 is the value the last change superseded");
});

// ── `tasks/50` §2.2: the first boot is a change, so the next one is inside its block ──
//
// `speedLimit` passed anything when `previous` was null, and `expectancy` counted the
// first-boot `config` row as one of the two that make a block unscoreable. So the next
// constant change on the live desk would have been **unrefused by the limit and
// unscoreable in the reading** — the worst of both, and the opposite of what `CLAUDE.md`
// and `docs/STATUS.md` say happens.

test("a first boot records itself as its own predecessor", async () => {
  const store = ledger();
  const path = tmp();
  const r = await recordConfigChange({ store, path, log: () => {}, now: new Date("2026-09-13T00:00:00Z") });
  assert.equal(r.first, true);
  const snap = readSnapshot(path)!;
  assert.notEqual(snap.previous, null, "a null here is what left the limit unarmed for one more change");
  assert.equal(snap.previous!.hash, snap.hash, "nothing moved on a first boot; it is its own predecessor");

  // And the next change is therefore inside the first boot's block: it is not a revert to
  // anything, so it is refused until the block completes or somebody says the hash.
  const moved = { ...configValues(), "RISK_PARAMS.minDisplacementSigma": "7" };
  const next = speedLimit({
    changed: true, next: moved, snapshot: snap, eventsInBlock: 0, override: undefined, hash: "aabbccddeeff",
  });
  assert.equal(next.ok, false, "the second change on a fresh box is refused, as the docs say it is");
  assert.equal(speedLimit({
    changed: true, next: moved, snapshot: snap, eventsInBlock: SAMPLE_FLOOR,
    override: undefined, hash: "aabbccddeeff",
  }).ok, true, "unless its block has completed, which is the rule and not an exception to it");
  store.close();
});

test("a fingerprint written before the rule is upgraded in place, with no event", async () => {
  const store = ledger();
  const path = tmp();
  // Exactly the file the box has carried since 2026-09-13: current constants, no
  // predecessor. An unchanged boot writes nothing, so without this it would have stayed
  // unarmed until something moved — which is the one moment it needed to be armed.
  const values = configValues();
  writeSnapshot(path, { at: "2026-09-13T11:56:00Z", hash: configHash(values), values, previous: null });

  const r = await recordConfigChange({ store, path, log: () => {}, now: new Date("2026-09-14T12:00:00Z") });
  assert.equal(r.changed, false, "nothing moved: this is an ordinary restart");
  const events = store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as unknown as { n: number };
  assert.equal(events.n, 0,
    "and it writes no event — the block still holds exactly the one config event it had");
  const snap = readSnapshot(path)!;
  assert.equal(snap.at, "2026-09-13T11:56:00Z", "the recorded instant is not moved by a repair");
  assert.equal(snap.previous!.hash, snap.hash, "but the limit can now refuse the next change");
  store.close();
});

test("a first boot speaks, because it is also how a standing refusal disappears", async () => {
  const store = ledger();
  const said: string[] = [];
  await recordConfigChange({
    store, path: tmp(), log: () => {}, notify: async (m) => { said.push(m); },
    now: new Date("2026-09-14T00:00:00Z"),
  });
  assert.equal(said.length, 1, "the one boot that cannot say what it ran yesterday said nothing until 09-14");
  assert.match(said[0]!, /first boot/);
  assert.match(said[0]!, /refusal recorded before it is gone with it/);
  store.close();
});
