import assert from "node:assert/strict";
import { test } from "node:test";
import { splitCounts } from "./id-split.ts";

// `tasks/41` §2.3. The whole command is one piece of arithmetic asked of three tables
// keyed three different ways, so the arithmetic is what is tested: how many keys there
// are before, how many after, and — the number the migration is designed around — how
// many rows would land on a key another row already holds.

test("a truncation that collides with nothing moves no rows", () => {
  const c = splitCounts([
    { before: "a|1", after: "a|1" },
    { before: "b|1", after: "b|1" },
  ]);
  assert.deepEqual(c, { rows: 2, before: 2, after: 2, collisions: 0, collapsing: 0 });
});

test("two rows landing on one key is one collision and one row collapsing", () => {
  const c = splitCounts([
    { before: "acct|ref:07a8a1be7f379196|no-direction", after: "acct|ref|no-direction" },
    { before: "acct|ref:ad418704103bb56d|no-direction", after: "acct|ref|no-direction" },
  ]);
  assert.equal(c.collisions, 1);
  assert.equal(c.collapsing, 1, "the UPDATE a plain migration would throw on");
  assert.equal(c.before, 2);
  assert.equal(c.after, 1);
});

// Three epochs of one skip collapse to one row, not to two: `collapsing` counts rows
// that disappear, which is what `before - after` has to equal for the report to add up.
test("collapsing is rows lost, not keys collided", () => {
  const c = splitCounts([
    { before: "k|a", after: "k" },
    { before: "k|b", after: "k" },
    { before: "k|c", after: "k" },
    { before: "j|a", after: "j" },
  ]);
  assert.equal(c.collisions, 1);
  assert.equal(c.collapsing, 2);
  assert.equal(c.before - c.after, c.collapsing);
});

test("an empty ledger is a table with nothing in it, not a crash", () => {
  assert.deepEqual(splitCounts([]), { rows: 0, before: 0, after: 0, collisions: 0, collapsing: 0 });
});
