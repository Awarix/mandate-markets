import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readFeedCost } from "./heartbeat.ts";

function root(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "feed-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("month-to-date spend and the last poll, as the two writers leave them", (t) => {
  const dir = root({
    "credit-meter.json": JSON.stringify({ month: "2026-09", calls: 119, usd: 1.19 }),
    "heartbeat.json": JSON.stringify({
      t: "2026-09-02T15:15:52.835Z", endpoint: "perps", ok: true, credits: 7660, spentUsd: 1.17,
    }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // `deepEqual`, not a field-by-field check, because the property this file is holding
  // is what is **absent**: the fixture above carries `credits: 7660` exactly as the
  // recorder writes it, and the answer must not mention it (`tasks/22`).
  assert.deepEqual(readFeedCost(dir), {
    month: "2026-09",
    monthCalls: 119,
    monthUsd: 1.19,
    lastPollAt: "2026-09-02T15:15:52.835Z",
  });
});

// The reason it is gone, restated as a test rather than only as a comment: this object
// goes out on `DeskPayload`, so anything on it is readable by every stranger who has
// connected a wallet. Our prepaid balance at Quotient is not their business, and the
// operator reads it from the file and the watchdog instead.
test("our supplier balance is not in the payload, whatever the recorder wrote", (t) => {
  const dir = root({
    "credit-meter.json": JSON.stringify({ month: "2026-09", calls: 119, usd: 1.19 }),
    "heartbeat.json": JSON.stringify({ t: "2026-09-02T15:15:52.835Z", credits: 7660 }),
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cost = readFeedCost(dir) as Record<string, unknown>;
  for (const key of Object.keys(cost)) {
    assert.ok(!/credit|balance/i.test(key), `${key} looks like our balance and must not be on the desk`);
  }
  assert.ok(!JSON.stringify(cost).includes("7660"), "the credit figure must not reach the payload by any name");
});

// Both files belong to other processes. A desk that will not render because the
// recorder has not started yet would be a screen broken by something it only reports.
test("the two halves fail independently, and neither breaks the desk", (t) => {
  const onlyMeter = root({ "credit-meter.json": JSON.stringify({ month: "2026-09", calls: 4, usd: 0.04 }) });
  const onlyBeat = root({ "heartbeat.json": JSON.stringify({ t: "2026-09-02T15:00:00Z", credits: 500 }) });
  t.after(() => { rmSync(onlyMeter, { recursive: true, force: true }); rmSync(onlyBeat, { recursive: true, force: true }); });

  const a = readFeedCost(onlyMeter);
  assert.equal(a.monthUsd, 0.04);
  assert.equal(a.lastPollAt, null, "no recorder heartbeat means no poll time to report");

  const b = readFeedCost(onlyBeat);
  assert.equal(b.lastPollAt, "2026-09-02T15:00:00Z");
  assert.equal(b.monthUsd, null, "no meter means no spend to report");
});

test("nothing on disk is silence, not a failure", (t) => {
  const dir = root({});
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readFeedCost(dir), {
    month: null, monthCalls: null, monthUsd: null, lastPollAt: null,
  });
});

// These are files, and a half-written or hand-edited one must not take a page down.
test("malformed or wrongly-typed fields are dropped, not coerced", (t) => {
  const broken = root({ "credit-meter.json": "{not json", "heartbeat.json": '{"credits":"lots","t":42}' });
  t.after(() => rmSync(broken, { recursive: true, force: true }));
  const f = readFeedCost(broken);
  assert.equal(f.monthUsd, null, "unparseable JSON is no answer at all");
  assert.equal(f.lastPollAt, null, "a numeric timestamp is not the ISO string we promise");
});
