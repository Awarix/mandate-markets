import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SYNTHETIC_INTENTS, excludeSyntheticSql, isSyntheticIntent, syntheticNote } from "./synthetic.ts";

// The `tasks/21` §10 runs put six real trades on a real account against signals that
// were not Quotient's, and the 2026-09-10 fee test put three more on the test wallet.
// `tasks/02` decides whether the feed makes money; counting them would answer that
// question with our own test data, and against a floor of ~30 events they are a large
// share of the sample.
//
// The count is pinned deliberately. An operator test is a rare, deliberate act, so a
// list that grew without anyone editing this file would mean something wrote it that
// should not have.

test("every excluded id is a plain uuid, and the list is the nine operator-test trades", () => {
  assert.equal(SYNTHETIC_INTENTS.length, 9);
  for (const s of SYNTHETIC_INTENTS) {
    assert.match(s.intentId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(s.why.length > 0, "each exclusion carries its reason");
  }
  const ids = SYNTHETIC_INTENTS.map((s) => s.intentId);
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
});

test("isSyntheticIntent recognises them and nothing else", () => {
  assert.equal(isSyntheticIntent("a798eb40-21b0-4ba4-86a8-b44d836df063"), true);
  assert.equal(isSyntheticIntent("888abe34-cb52-40f9-a60c-80ae2853fef4"), true);
  assert.equal(isSyntheticIntent("00000000-0000-4000-8000-000000000000"), false);
});

test("the SQL fragment removes exactly those rows and keeps every other one", () => {
  const dir = mkdtempSync(join(tmpdir(), "synthetic-"));
  try {
    const db = new DatabaseSync(join(dir, "t.sqlite"));
    db.exec("CREATE TABLE intents (intent_id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    const ins = db.prepare("INSERT INTO intents (intent_id, status) VALUES (?, 'closed')");
    for (const s of SYNTHETIC_INTENTS) ins.run(s.intentId);
    // Two genuine closed trades that must survive.
    ins.run("11111111-1111-4111-8111-111111111111");
    ins.run("22222222-2222-4222-8222-222222222222");

    const all = db.prepare("SELECT COUNT(*) AS n FROM intents").get() as { n: number };
    assert.equal(all.n, SYNTHETIC_INTENTS.length + 2);

    const kept = db.prepare(
      `SELECT intent_id FROM intents WHERE status = 'closed' AND ${excludeSyntheticSql()}`,
    ).all() as { intent_id: string }[];
    assert.deepEqual(
      kept.map((r) => r.intent_id).sort(),
      ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"],
      "every operator-test trade is gone and the real ones are untouched",
    );

    // The qualified form the joined queries in exit-policy and stop-sweep use.
    const q = db.prepare(
      `SELECT COUNT(*) AS n FROM intents i WHERE ${excludeSyntheticSql("i.intent_id")}`,
    ).get() as { n: number };
    assert.equal(q.n, 2, "the column can be qualified for a joined query");
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a reading says out loud what it left out", () => {
  const note = syntheticNote();
  assert.match(note, /excluding 9 operator-test intent/);
  assert.match(note, /tasks\/21/, "and points at the argument for it");
  assert.match(note, /2026-09-10/, "including the run that is not tasks/21's");
});
