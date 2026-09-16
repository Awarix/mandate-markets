import "dotenv/config";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stableOutlookKey } from "../mapping/quotient.ts";
import { regimeAt } from "../risk/regimes.ts";
import { Store } from "../store/db.ts";
import { excludeSyntheticSql } from "../store/synthetic.ts";

// **How many of this ledger's events are one outlook counted twice** — `tasks/41` §2.3.
//
//   npm run id-split                                   # the live ledger
//   SIGNALDESK_DB=data/snap-0912.sqlite npm run id-split
//
// `stableOutlookId` strips one `:`-component off Quotient's `outlook_id` and keeps a
// *global epoch tag* that the vendor has rewritten three times in twelve days. Each
// rewrite ends one key and begins another for every series at once, so the executor
// reads a live outlook as retired, and every reading since counts one call as two
// events. The fix is to strip the tag as well; this command is the part of `tasks/41`
// that can run before any of that is decided, because it changes nothing.
//
// It answers two questions that are asked at different moments and share one arithmetic:
//
//  1. **Before the next expectancy reading** — does its `n` move? The block table below
//     counts events exactly as `collapse()` does, keyed on `(signal_ref, hold_to_target)`
//     over closed, settled, non-synthetic intents, and then again on the truncated ref.
//     A reading that quotes an `n` without this has an unknown number of halves in it.
//  2. **Before the migration in §2.1** — what does the truncation actually move? One
//     `UPDATE` per table, except where the truncated ref collides with a row that is
//     already there: `skips` is keyed `(account, signal_ref, reason)` and collides in
//     the hundreds, so it has to collapse like `migrateSkips` rather than throw.
//
// **The guard comes first and it is not decoration.** `stableOutlookKey` truncates to a
// count rather than dropping a component, because the ledger holds two forms — and a
// ref that is already six components long does not key at all, so a migrated ledger is
// recognisable and cannot be truncated a second time, which would take the anchor date
// with it. If any ref does not key, this prints that and scores nothing.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

/** The separator inside a composite key. Not a colon: every part of a `signal_ref` is
 *  already colon-separated, so a colon here could not be told from one of theirs, and
 *  a pipe appears in none of the fields these keys are built from. */
const SEP = "|";

/** What a truncation does to one table's keys.
 *
 *  `before`/`after` are that row's primary key as it stands and as it would stand —
 *  which is the only shape general enough for three tables keyed three different ways.
 *  A *collision* is a post-truncation key that two or more rows would share; the rows
 *  that disappear into another are `collapsing`, and they are the ones a plain `UPDATE`
 *  would throw on. */
export type SplitCounts = {
  rows: number;
  before: number;
  after: number;
  collisions: number;
  collapsing: number;
};

export function splitCounts(pairs: { before: string; after: string }[]): SplitCounts {
  const after = new Map<string, number>();
  for (const p of pairs) after.set(p.after, (after.get(p.after) ?? 0) + 1);
  const collided = [...after.values()].filter((n) => n > 1);
  return {
    rows: pairs.length,
    before: new Set(pairs.map((p) => p.before)).size,
    after: after.size,
    collisions: collided.length,
    collapsing: collided.reduce((a, n) => a + n - 1, 0),
  };
}

/** The stable key, or the ref itself when it does not key. The caller has already
 *  refused a ledger holding any of the latter; this keeps the arithmetic honest in the
 *  line that reports it. */
const keyed = (ref: string): string => stableOutlookKey(ref) ?? ref;

type TripRow = {
  ref: string; hold: number; account: string; coin: string;
  openedAt: Date; net: number; margin: number;
};

function pad(s: string | number, n: number): string { return String(s).padStart(n); }

function main(): void {
  if (!existsSync(LEDGER)) {
    console.log(`no ledger at ${LEDGER} — set SIGNALDESK_DB, or run this on the box`);
    return;
  }
  console.log(`ledger: ${LEDGER}`);
  const store = new Store(LEDGER, { readOnly: true });

  // The guard, before anything is counted off these refs.
  const allRefs = [
    ...(store.db.prepare("SELECT DISTINCT signal_ref AS r FROM signals").all() as { r: string }[]),
    ...(store.db.prepare("SELECT DISTINCT signal_ref AS r FROM intents").all() as { r: string }[]),
    ...(store.db.prepare("SELECT DISTINCT signal_ref AS r FROM skips").all() as { r: string }[]),
  ].map((x) => x.r);
  const unkeyed = [...new Set(allRefs.filter((r) => stableOutlookKey(r) === null))];
  console.log(`\n=== the guard ===`);
  if (unkeyed.length > 0) {
    console.log(`    WARNING ${unkeyed.length} distinct ref(s) do not key, e.g. ${unkeyed[0]}`);
    console.log("      this ledger is already migrated, or holds a shape we do not know.");
    console.log("      NOT scored: truncating a second time would merge every anchor of a series.");
    store.close();
    return;
  }
  // Both forms are printed because the older one is the reason this truncates to a
  // count: 8-component refs predate `stableOutlookId` and still carry their revision
  // hash, and their epoch tag is one component further in.
  const byParts = new Map<number, number>();
  for (const r of new Set(allRefs)) byParts.set(r.split(":").length, (byParts.get(r.split(":").length) ?? 0) + 1);
  console.log(`    ${new Set(allRefs).size} distinct refs, every one keying. ` +
    [...byParts].sort().map(([n, c]) => `${c} in the ${n}-component form`).join(", "));

  // 1. The reading's own population — the same filter `expectancy` reads on, so the `n`
  //    printed here is the `n` printed there: closed, settled net of costs, synthetic
  //    intents excluded.
  const trips = (store.db.prepare(
    `SELECT signal_ref, hold_to_target, account, coin, created_at, net_pnl, margin_usd
     FROM intents WHERE status = 'closed' AND net_pnl IS NOT NULL
       AND ${excludeSyntheticSql("intent_id")} ORDER BY created_at`,
  ).all() as unknown as Record<string, unknown>[]).map((r): TripRow => ({
    ref: String(r.signal_ref),
    hold: Number(r.hold_to_target),
    account: String(r.account),
    coin: String(r.coin),
    openedAt: new Date(String(r.created_at)),
    net: Number(r.net_pnl),
    margin: Number(r.margin_usd),
  }));

  // An event is `(signal_ref, hold_to_target)` and its regime is the earliest trip's,
  // both exactly as `collapse()` has them — a signal straddling a boundary is one event
  // that opened before it.
  type Group = { key: string; trips: TripRow[] };
  const groupBy = (keyOf: (t: TripRow) => string): Group[] => {
    const m = new Map<string, TripRow[]>();
    for (const t of trips) m.set(keyOf(t), [...(m.get(keyOf(t)) ?? []), t]);
    return [...m].map(([key, ts]) => ({ key, trips: ts }));
  };
  const eventKey = (t: TripRow) => `${t.ref}${SEP}${t.hold}`;
  const mergedKey = (t: TripRow) => `${keyed(t.ref)}${SEP}${t.hold}`;
  const blockOf = (g: Group): string => {
    const first = g.trips.reduce((a, b) => (b.openedAt < a.openedAt ? b : a));
    return `${regimeAt(first.openedAt).name}/${first.hold === 1 ? "hold" : "retire"}`;
  };

  const today = groupBy(eventKey);
  const merged = groupBy(mergedKey);
  const countByBlock = (gs: Group[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const g of gs) m.set(blockOf(g), (m.get(blockOf(g)) ?? 0) + 1);
    return m;
  };
  const a = countByBlock(today);
  const b = countByBlock(merged);

  console.log(`\n=== events the reading counts - ${trips.length} settled trips ===`);
  console.log(`    ${"block".padEnd(24)}${"today".padStart(7)}${"merged".padStart(9)}${"delta".padStart(7)}`);
  for (const block of [...new Set([...a.keys(), ...b.keys()])]) {
    const n = a.get(block) ?? 0, m = b.get(block) ?? 0;
    console.log(`    ${block.padEnd(24)}${pad(n, 7)}${pad(m, 9)}${pad(m - n, 7)}`);
  }
  console.log(`    ${"total".padEnd(24)}${pad(today.length, 7)}${pad(merged.length, 9)}${pad(merged.length - today.length, 7)}`);

  // Which ones, and what they held — a count nobody can check is the thing `tasks/41`
  // §2.3 exists to replace.
  const splits = merged
    .map((g) => ({ g, refs: new Set(g.trips.map((t) => t.ref)) }))
    .filter((x) => x.refs.size > 1);
  if (splits.length === 0) console.log("\n    no event in this ledger was split. nothing merges.");
  else {
    console.log(`\n    the ${splits.length} event(s) that merge:`);
    for (const { g, refs } of splits) {
      const stable = g.key.split(SEP)[0]!;
      const tags = [...refs].map((r) => r.slice(stable.length + 1, stable.length + 9)).join(" , ");
      const accounts = new Set(g.trips.map((t) => t.account)).size;
      const net = g.trips.reduce((s, t) => s + t.net, 0);
      console.log(`      ${blockOf(g).padEnd(24)}${stable}`);
      // The net is the **whole merged event's**, both halves and every account — not
      // what the rotation cost. That is a different query and a smaller number: only a
      // position held at the instant of a rotation pays for one.
      console.log(`        ${refs.size} -> 1 across ${tags}   ${g.trips.length} trips, ` +
        `${accounts} accounts, ${net.toFixed(2)} net over the merged event`);
    }
  }

  // 2. What the migration moves.
  const tables: { name: string; pairs: { before: string; after: string }[] }[] = [
    {
      name: "signals",
      pairs: (store.db.prepare("SELECT signal_ref, revision FROM signals").all() as unknown as
        { signal_ref: string; revision: number }[])
        .map((r) => ({
          before: `${r.signal_ref}${SEP}${r.revision}`,
          after: `${keyed(r.signal_ref)}${SEP}${r.revision}`,
        })),
    },
    {
      name: "skips",
      pairs: (store.db.prepare("SELECT account, signal_ref, reason FROM skips").all() as unknown as
        { account: string; signal_ref: string; reason: string }[])
        .map((r) => ({
          before: `${r.account}${SEP}${r.signal_ref}${SEP}${r.reason}`,
          after: `${r.account}${SEP}${keyed(r.signal_ref)}${SEP}${r.reason}`,
        })),
    },
  ];
  console.log(`\n=== what the migration moves ===`);
  console.log(`    ${"table".padEnd(10)}${"rows".padStart(7)}${"keys today".padStart(12)}${"keys after".padStart(12)}` +
    `${"colliding".padStart(11)}${"collapsing".padStart(12)}`);
  for (const t of tables) {
    const c = splitCounts(t.pairs);
    console.log(`    ${t.name.padEnd(10)}${pad(c.rows, 7)}${pad(c.before, 12)}${pad(c.after, 12)}` +
      `${pad(c.collisions, 11)}${pad(c.collapsing, 12)}`);
  }
  // `intents` is keyed on `intent_id`, so its refs cannot collide — what moves there is
  // how many distinct outlooks the column names, which is the whole defect in one line.
  const iRefs = (store.db.prepare("SELECT DISTINCT signal_ref AS r FROM intents").all() as { r: string }[])
    .map((x) => x.r);
  const iRows = (store.db.prepare("SELECT COUNT(*) AS n FROM intents").get() as { n: number }).n;
  console.log(`    ${"intents".padEnd(10)}${pad(iRows, 7)}${pad(new Set(iRefs).size, 12)}` +
    `${pad(new Set(iRefs.map(keyed)).size, 12)}${pad(0, 11)}${pad(0, 12)}   (keyed on intent_id; ` +
    `the two counts are the outlooks the column names)`);

  // 3. The pre-flight. §2.1's migration runs with the book open, so the one thing to
  //    look at first is whether it merges two intents that are open **on one account
  //    right now**. Benign if it does — same coin, same side, and they retire together
  //    afterwards instead of one being read as a stranger — but it is a state to have
  //    seen, not assumed.
  const open = store.db.prepare(
    "SELECT account, signal_ref, coin, status FROM intents WHERE status IN ('pending','open','closing')",
  ).all() as unknown as { account: string; signal_ref: string; coin: string; status: string }[];
  const openPairs = new Map<string, Set<string>>();
  for (const o of open) {
    const k = `${o.account}${SEP}${keyed(o.signal_ref)}`;
    openPairs.set(k, new Set([...(openPairs.get(k) ?? []), o.signal_ref]));
  }
  const openMerging = [...openPairs].filter(([, refs]) => refs.size > 1);
  console.log(`\n=== the pre-flight - ${open.length} open, pending or closing intents ===`);
  if (openMerging.length === 0) console.log("    no account holds two of them that merge under the truncation.");
  else {
    for (const [k, refs] of openMerging) {
      console.log(`    WARNING ${k.split(SEP)[0]} holds ${refs.size} open intents that merge: ${k.split(SEP)[1]}`);
    }
  }

  store.close();
}

if (import.meta.main) main();
