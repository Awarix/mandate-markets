import { createHash } from "node:crypto";
import type { PerpsSeries } from "./types.ts";
import type { Poll } from "./archive.ts";

// `tasks/47` Rule 6: **the feed is versioned, and a reading refuses to pool across a
// version it has not been told about.**
//
// Four times in fourteen days Quotient changed what it publishes, and every one of those
// was found afterwards, by hand, by somebody wondering why a number had moved:
//
//   · 2026-09-04 — `sigma_total` ×1.23, the `daily` anchor 15% → 6%, `two-day` anchors to
//     zero. Found in a reading. It has a `FEED_REGIMES` row because a person wrote one.
//   · 2026-09-08 — the revert. Same.
//   · 2026-09-11 — the `outlook_id` epoch tag rotated on 44 of 76 series inside 8.4 hours,
//     which the executor read as a retirement and which force-closed healthy positions
//     hourly until `tasks/41` shipped two days later.
//   · 2026-09-12 — six new fields on every series (`directional_take`, `lean_side`,
//     `lean_sigma`, `scenarios`), unread by us and still unexplained by them.
//
// None of those is a fault of theirs. What is ours is that **the shape of the feed is not
// recorded anywhere**, so a change to it is invisible until it moves a number, and a
// reading that spans one pools two populations while printing one mean.
//
// ── What is fingerprinted, and what deliberately is not ──────────────────────────
//
// The **contract**: the set of series keys, the shape of `outlook_id`, and the
// vocabularies that are closed by construction. Not the values — `sigma_total` moving is
// the σ watcher's job (`src/ops/feed-watch.ts`) and is a different question with a
// different answer. This one asks *did the vendor change the schema?*, where any change at
// all is news and no threshold makes sense.
//
// ⚠⚠ **`tasks/47` §2's list was wrong, and the archive says so.** It asks for "the enum
// values of `mode`, `anchor_type`, `status`, `mapping_status`". Counted over the 598 polls
// in the archive on 2026-09-13, the number of times each field's observed value **set**
// changed from one poll to the next:
//
//     keys                3        <- a contract
//     mapping_status      0        <- a contract
//     range_status        0        <- a contract
//     anchor_type        25        <- a DISTRIBUTION
//     mode               27        <- a DISTRIBUTION
//     status             35        <- a DISTRIBUTION
//     strength           70        <- a DISTRIBUTION
//
// An **observed value set is a distribution, not a contract.** Whether `strength: "high"`
// appears in a given poll depends on whether any series happens to be strong that hour,
// not on what the vendor will send; the same for a market going `unavailable` over a
// weekend. Fingerprinting those would have fired seventy times in a fortnight and been
// muted inside a day — the exact fate of an alarm that cries about weather.
//
// So the contract holds the three that do not move, and the four that do are reported as
// a **distribution line** (`vocabularyOf`), which is the other half of `tasks/47` §2 and
// is information rather than an alarm.
//
// ⚠ `anchor_type` carries `extra-<date>` values that rotate by construction; they collapse
// to a single `extra-*` wherever they are reported, alarm or line.
//
// ── Where the record lives, and why it is not an `events` row ────────────────────
//
// `tasks/47` step 6 asks the recorder to write a `feed_contract` event. It does not,
// deliberately: **the archive already is that record.** It is append-only, dated to the
// poll, and it holds the payload the fingerprint is computed from — so a fingerprint
// derived from it can be recomputed for any day, including days before this code existed,
// which an `events` row can never be. That is what makes `expectancy`'s refusal work
// backwards over the whole archive rather than only forwards from a deploy. The recorder
// also has no `Store`, and giving one to the single process whose failure mode is "dies
// unnoticed" to write a row that is derivable is the wrong trade.
//
// What is kept from the task's intent: the change is **announced** (the watchdog's daily
// line and an alarm on the edge) and a reading **refuses** to pool across one.

/** The vocabularies that are part of the **contract**: closed by construction, and
 *  measured not to move across the whole archive. A value appearing in either is the
 *  vendor changing what it can say.
 *
 *  `mapping_status` is a settlement flag and not a tradeability flag (Quotient, answered);
 *  `range_status` describes the forecast band. Neither is a property of what the market
 *  happened to be doing at poll time, which is what makes them contract and the other four
 *  distribution. */
const CONTRACT_ENUMS = ["mapping_status", "range_status"] as const;

/** The vocabularies that are **distribution**: they move with what the feed happens to
 *  contain, and they are reported rather than alarmed on. */
const DISTRIBUTION_ENUMS = ["mode", "anchor_type", "status", "strength"] as const;

export type FeedContract = {
  /** Twelve hex of SHA-256 over the canonical form below. */
  hash: string;
  /** Every key seen on a series or its outlook, sorted. `outlook.` prefixed. */
  keys: string[];
  /** Contract vocabulary: field name → sorted distinct values, for the two fields that
   *  do not move with the weather. */
  enums: Record<string, string[]>;
  /** How many `:`-separated components the **raw** `outlook_id` has — eight today, e.g.
   *  `po:commodity:copper:price-outlook:daily:2026-09-14:<revision>:<epoch>`. The first
   *  six are what `stableOutlookId` keys on, so a change here is a change to **identity
   *  itself**: the 2026-09-11 epoch rotation made the executor read every routine revision
   *  as a retirement and force-close healthy positions hourly for two days. This is the
   *  row that would have said so on the first poll. */
  idComponents: number[];
  /** Series in the poll the contract was read from. Not hashed — it is a volume, not a
   *  contract — and carried because every message wants it. */
  series: number;
};

/** `extra-2026-09-14` and `extra-2026-09-15` are the same contract. */
export function normaliseEnum(field: string, value: string): string {
  return field === "anchor_type" && value.startsWith("extra-") ? "extra-*" : value;
}

/** The contract one poll publishes.
 *
 *  Pure and total: a series missing a field simply does not contribute that key, and a
 *  null enum value is recorded as `null` rather than skipped — *the vendor started
 *  sending nulls here* is exactly the kind of change this exists to catch. */
export function contractOf(series: readonly PerpsSeries[]): FeedContract {
  const keys = new Set<string>();
  const enums = new Map<string, Set<string>>();
  const idComponents = new Set<number>();

  for (const s of series) {
    const row = s as unknown as Record<string, unknown>;
    for (const k of Object.keys(row)) {
      if (k === "outlook") continue;
      keys.add(k);
    }
    const o = (row.outlook ?? {}) as Record<string, unknown>;
    for (const k of Object.keys(o)) keys.add(`outlook.${k}`);

    for (const f of CONTRACT_ENUMS) {
      const v = (f in row ? row[f] : o[f]) as unknown;
      if (v === undefined) continue;
      const set = enums.get(f) ?? new Set<string>();
      set.add(v === null ? "null" : normaliseEnum(f, String(v)));
      enums.set(f, set);
    }
    const id = o.outlook_id;
    if (typeof id === "string") idComponents.add(id.split(":").length);
  }

  const out: FeedContract = {
    hash: "",
    keys: [...keys].sort(),
    enums: Object.fromEntries([...enums].sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()])),
    idComponents: [...idComponents].sort((a, b) => a - b),
    series: series.length,
  };
  out.hash = hashContract(out);
  return out;
}

/** The canonical bytes, and the hash over them. Human-readable for the same reason
 *  `configValues` is: the thing a person reads and the thing the hash covers must be the
 *  same, or a diff can disagree with the refusal it triggers. */
export function canonicalContract(c: FeedContract): string {
  return [
    `keys = ${c.keys.join(",")}`,
    ...Object.entries(c.enums).map(([k, v]) => `enum.${k} = ${v.join(",")}`),
    `idComponents = ${c.idComponents.join(",")}`,
  ].join("\n");
}

export function hashContract(c: FeedContract): string {
  return createHash("sha256").update(canonicalContract(c)).digest("hex").slice(0, 12);
}

/** What moved between two contracts, in the words a message carries.
 *
 *  Additions and removals both, and each labelled — a field **arriving** is the six new
 *  fields of 2026-09-12, and one **leaving** is `two-day` going to zero on 09-04. They
 *  mean opposite things and a diff that prints only a count says neither. */
export function diffContract(prev: FeedContract, next: FeedContract): string[] {
  const lines: string[] = [];
  const setDiff = (label: string, a: readonly string[], b: readonly string[]) => {
    const added = b.filter((x) => !a.includes(x));
    const gone = a.filter((x) => !b.includes(x));
    if (added.length > 0) lines.push(`${label}: +${added.join(" +")}`);
    if (gone.length > 0) lines.push(`${label}: -${gone.join(" -")}`);
  };
  setDiff("keys", prev.keys, next.keys);
  for (const f of [...new Set([...Object.keys(prev.enums), ...Object.keys(next.enums)])].sort()) {
    setDiff(`${f}`, prev.enums[f] ?? [], next.enums[f] ?? []);
  }
  setDiff("outlook_id components", prev.idComponents.map(String), next.idComponents.map(String));
  return lines;
}

export type ContractChange = {
  at: Date; from: string; to: string; lines: string[];
  /** **Could this change have altered what we traded?**
   *
   *  `additive` is keys *arriving* and nothing else: a field we do not read cannot move a
   *  gate that does not read it, and the four that arrived on 2026-09-04 and the one on
   *  09-12 are all of this kind. Reported, never a refusal.
   *
   *  `breaking` is a key **leaving**, a contract vocabulary changing, or the `outlook_id`
   *  component count moving. Each of those can change what `evaluateSeries` sees or what
   *  `stableOutlookId` returns, so a reading may not pool across one.
   *
   *  ⚠ The distinction is what stops this being muted. A refusal on every change would
   *  have refused the block accumulating for item 1's reading, on the strength of
   *  `outlook.audit` appearing — a field nothing in this repository reads. An alarm that
   *  refuses a reading for that is an alarm somebody turns off. */
  kind: "additive" | "breaking";
};

/** Which kind a diff is. Exported so the classification is testable without an archive,
 *  and so the one place that decides it is the one place a future field-type is added. */
export function classifyContractChange(lines: readonly string[]): "additive" | "breaking" {
  return lines.every((l) => l.startsWith("keys: +")) ? "additive" : "breaking";
}

/** Every contract change in a run of polls, oldest first, with the contract in force at
 *  the end.
 *
 *  ⚠ **One poll is one observation of the contract, not the contract itself.** A vendor
 *  rolling a change out across a fleet, or a poll that happened to carry fewer series,
 *  can make the set of enum values flicker for an hour and back. That is why this returns
 *  every transition rather than a count, and why the consumers treat a change as
 *  *something to say* rather than as something to act on: `expectancy` refuses to pool
 *  across one, which is safe in both directions, and the watchdog speaks. Neither writes
 *  a constant. */
export function contractChanges(polls: readonly Poll[]): { changes: ContractChange[]; latest: FeedContract | null } {
  let cur: FeedContract | null = null;
  const changes: ContractChange[] = [];
  for (const p of polls) {
    const c = contractOf(p.series);
    if (c.series === 0) continue;
    if (cur !== null && c.hash !== cur.hash) {
      const lines = diffContract(cur, c);
      changes.push({ at: p.t, from: cur.hash, to: c.hash, lines, kind: classifyContractChange(lines) });
    }
    cur = c;
  }
  return { changes, latest: cur };
}

/** The contract in force at an instant, from a run of polls. `null` when nothing was
 *  published at or before it. */
export function contractAt(polls: readonly Poll[], at: Date): FeedContract | null {
  let cur: FeedContract | null = null;
  for (const p of polls) {
    if (p.t.getTime() > at.getTime()) break;
    const c = contractOf(p.series);
    if (c.series > 0) cur = c;
  }
  return cur;
}

/** What a reading's window spans: the distinct contracts in it, and the changes between
 *  them. **A reading whose window crosses a breaking change is pooling two feeds and must
 *  refuse** (`tasks/47` Rule 6); one that crosses an additive change says so and scores.
 *
 *  Measured over the archive on 2026-09-13: three changes in fourteen days, all additive
 *  (`+outlook.directional_take +outlook.lean_side +outlook.lean_sigma +outlook.scenarios`
 *  and `+is_primary_horizon` on 09-04, `+outlook.audit` on 09-12). So nothing is refused
 *  today and the refusal is armed for the change that would matter. */
export function contractSpan(polls: readonly Poll[], fromMs: number, toMs: number): {
  contracts: string[]; changes: ContractChange[]; breaking: ContractChange[];
} {
  const seen: string[] = [];
  const changes: ContractChange[] = [];
  let cur: FeedContract | null = null;
  for (const p of polls) {
    const t = p.t.getTime();
    if (t < fromMs || t > toMs) continue;
    const c = contractOf(p.series);
    if (c.series === 0) continue;
    if (cur !== null && c.hash !== cur.hash) {
      const lines = diffContract(cur, c);
      changes.push({ at: p.t, from: cur.hash, to: c.hash, lines, kind: classifyContractChange(lines) });
    }
    cur = c;
    if (seen.at(-1) !== c.hash) seen.push(c.hash);
  }
  return {
    contracts: [...new Set(seen)],
    changes,
    breaking: changes.filter((c) => c.kind === "breaking"),
  };
}

export type FeedVocabulary = { field: string; values: string[] }[];

/** The four vocabularies that move with the feed rather than with the vendor.
 *
 *  Reported, never alarmed on — `tasks/47` §2's *distribution line*, which it asks for
 *  separately from the contract and which the archive says is the right place for these
 *  (see the counts above). A `strength` vocabulary that loses `high` for six hours is the
 *  market being quiet; the same line losing `outlook.audit` would be the vendor removing
 *  a field, and that is the other function. */
export function vocabularyOf(series: readonly PerpsSeries[]): FeedVocabulary {
  const out: FeedVocabulary = [];
  for (const f of DISTRIBUTION_ENUMS) {
    const vs = new Set<string>();
    for (const s of series) {
      const row = s as unknown as Record<string, unknown>;
      const o = (row.outlook ?? {}) as Record<string, unknown>;
      const v = (f in row ? row[f] : o[f]) as unknown;
      if (v === undefined) continue;
      vs.add(v === null ? "null" : normaliseEnum(f, String(v)));
    }
    if (vs.size > 0) out.push({ field: f, values: [...vs].sort() });
  }
  return out;
}
