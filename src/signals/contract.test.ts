import assert from "node:assert/strict";
import { test } from "node:test";
import type { PerpsSeries } from "./types.ts";
import type { Poll } from "./archive.ts";
import {
  canonicalContract, classifyContractChange, contractOf, contractSpan, contractChanges,
  diffContract, normaliseEnum, vocabularyOf,
} from "./contract.ts";

// `tasks/47` Rule 6. What is worth pinning is the **classification** — which observations
// are contract and which are weather — because that is the decision, and getting it wrong
// in either direction breaks the mechanism: too wide and it fires seventy times a
// fortnight and is muted, too narrow and it misses the change that force-closed healthy
// positions hourly for two days.

const S = (o: Partial<PerpsSeries["outlook"]> & Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  symbol: "xyz:CL",
  mapping_status: "verified",
  asset_class: "commodity",
  anchor_type: "daily",
  mode: "signal",
  ...extra,
  outlook: {
    outlook_id: "po:commodity:copper:price-outlook:daily:2026-09-14:revhash:epochtag",
    side: "long",
    status: "active",
    strength: "medium",
    range_status: "inside",
    displacement_sigma: 1.2,
    sigma_total: 0.01,
    ...o,
  },
} as unknown as PerpsSeries);

const poll = (t: string, series: PerpsSeries[]): Poll => ({ t: new Date(t), series });

test("the key set is the contract, and a field arriving is one change", () => {
  const a = contractOf([S()]);
  const b = contractOf([S({ audit: { by: "them" } })]);
  assert.notEqual(a.hash, b.hash);
  assert.deepEqual(diffContract(a, b), ["keys: +outlook.audit"]);
  assert.ok(b.keys.includes("outlook.audit"));
});

// The measurement that rewrote this file. Over 598 archived polls the observed value SET
// of `strength` changed 70 times, `status` 35, `mode` 27, `anchor_type` 25 — and the key
// set 3. An observed value set is a distribution: whether "high" appears this hour depends
// on the market, not on the vendor.
test("weather is not contract: strength, status, mode and anchor_type do not move the hash", () => {
  const calm = contractOf([S({ strength: "medium", status: "active" }, { mode: "signal", anchor_type: "daily" })]);
  const wild = contractOf([S({ strength: "high", status: "unavailable" }, { mode: "coverage", anchor_type: "weekly" })]);
  assert.equal(calm.hash, wild.hash,
    "a strong call on an unavailable market in a coverage poll is the same CONTRACT as a quiet one");
  // And they are still reported, as a distribution line rather than as an alarm.
  const v = vocabularyOf([S({ strength: "high" })]);
  assert.deepEqual(v.find((x) => x.field === "strength")?.values, ["high"]);
});

test("the two closed vocabularies ARE contract, because they do not move with the market", () => {
  // Measured at 0 changes across the whole archive. A value appearing in either is the
  // vendor changing what it is able to say.
  const a = contractOf([S({}, { mapping_status: "verified" })]);
  const b = contractOf([S({}, { mapping_status: "provisional" })]);
  assert.notEqual(a.hash, b.hash);
  assert.deepEqual(diffContract(a, b), ["mapping_status: +provisional", "mapping_status: -verified"]);
});

test("extra-<date> anchors collapse, or this would fire every day and be muted in a week", () => {
  assert.equal(normaliseEnum("anchor_type", "extra-2026-09-14"), "extra-*");
  assert.equal(normaliseEnum("anchor_type", "extra-2026-09-15"), "extra-*");
  assert.equal(normaliseEnum("anchor_type", "daily"), "daily");
  assert.equal(normaliseEnum("mode", "extra-thing"), "extra-thing", "only anchor_type rotates by date");
});

test("outlook_id's component count is contract, because it IS identity", () => {
  const eight = contractOf([S()]);
  const seven = contractOf([S({ outlook_id: "po:commodity:copper:price-outlook:daily:2026-09-14:revhash" })]);
  assert.deepEqual(eight.idComponents, [8]);
  assert.deepEqual(seven.idComponents, [7]);
  assert.notEqual(eight.hash, seven.hash);
  assert.equal(classifyContractChange(diffContract(eight, seven)), "breaking",
    "stableOutlookId keys on the component count; a change here changes what an outlook IS");
});

test("a null where a value was is a change, not a skip", () => {
  const a = contractOf([S({}, { mapping_status: "verified" })]);
  const b = contractOf([S({}, { mapping_status: null })]);
  assert.notEqual(a.hash, b.hash);
  assert.ok(b.enums.mapping_status?.includes("null"));
});

// The distinction that keeps the refusal usable. All three changes in the real archive are
// additive; a refusal on every change would have refused the block being accumulated for
// item 1's reading over `outlook.audit` appearing, which nothing in this repository reads.
test("additive is keys arriving and nothing else; everything else is breaking", () => {
  assert.equal(classifyContractChange(["keys: +outlook.audit"]), "additive");
  assert.equal(classifyContractChange(["keys: +a", "keys: +b"]), "additive");
  assert.equal(classifyContractChange(["keys: -outlook.sigma_total"]), "breaking", "a key LEAVING");
  assert.equal(classifyContractChange(["keys: +a", "keys: -b"]), "breaking", "one removal is enough");
  assert.equal(classifyContractChange(["mapping_status: +provisional"]), "breaking");
  assert.equal(classifyContractChange(["outlook_id components: +7"]), "breaking");
  assert.equal(classifyContractChange([]), "additive", "no lines is no change");
});

test("the hash covers exactly the bytes a person is shown", () => {
  const c = contractOf([S()]);
  assert.ok(canonicalContract(c).includes("keys = "));
  assert.ok(canonicalContract(c).includes("idComponents = 8"));
  // Series count is a volume, not a contract: two polls of different size are one feed.
  assert.equal(contractOf([S(), S()]).hash, contractOf([S()]).hash);
  assert.equal(contractOf([S(), S()]).series, 2);
});

test("an empty poll is not a contract change — the vendor served nothing, it did not change", () => {
  const { changes, latest } = contractChanges([
    poll("2026-09-01T00:00:00Z", [S()]),
    poll("2026-09-01T01:00:00Z", []),
    poll("2026-09-01T02:00:00Z", [S()]),
  ]);
  assert.equal(changes.length, 0);
  assert.equal(latest?.series, 1);
});

test("a span reports its contracts, its changes, and which of them refuse a reading", () => {
  const polls = [
    poll("2026-09-01T00:00:00Z", [S()]),
    poll("2026-09-02T00:00:00Z", [S({ audit: {} })]),                                 // additive
    poll("2026-09-03T00:00:00Z", [S({ audit: {}, outlook_id: "a:b:c" })]),            // breaking
  ];
  const all = contractSpan(polls, 0, Date.parse("2026-09-04T00:00:00Z"));
  assert.equal(all.contracts.length, 3);
  assert.equal(all.changes.length, 2);
  assert.equal(all.breaking.length, 1);
  assert.equal(all.breaking[0]!.at.toISOString(), "2026-09-03T00:00:00.000Z");

  // A window that stops before the breaking change spans an additive one and scores.
  const early = contractSpan(polls, 0, Date.parse("2026-09-02T12:00:00Z"));
  assert.equal(early.changes.length, 1);
  assert.equal(early.breaking.length, 0);

  // A window inside one contract spans nothing at all, which is the unit Rule 6 asks for.
  const one = contractSpan(polls, 0, Date.parse("2026-09-01T12:00:00Z"));
  assert.deepEqual(one.changes, []);
  assert.equal(one.contracts.length, 1);
});
