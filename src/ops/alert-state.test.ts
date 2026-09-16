import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDecision, decide, type AlertState } from "./alert-state.ts";

const HOUR = 3600_000;

test("fires once on onset, not again immediately", () => {
  assert.deepEqual(decide(undefined, true, 0, 12 * HOUR), { send: true, kind: "onset" });
  assert.deepEqual(
    decide({ firing: true, lastSentMs: 0 }, true, 5 * HOUR, 12 * HOUR),
    { send: false, kind: "none" },
  );
});

test("repeats only after repeatMs — a 15-min timer must not send 96 alerts a day", () => {
  const prev = { firing: true, lastSentMs: 0 };
  assert.equal(decide(prev, true, 11.9 * HOUR, 12 * HOUR).send, false);
  assert.deepEqual(decide(prev, true, 12 * HOUR, 12 * HOUR), { send: true, kind: "repeat" });
});

test("sends a recovery message when the condition clears", () => {
  assert.deepEqual(
    decide({ firing: true, lastSentMs: 0 }, false, HOUR, 12 * HOUR),
    { send: true, kind: "resolved" },
  );
});

test("stays quiet while healthy", () => {
  assert.deepEqual(decide(undefined, false, 0, 12 * HOUR), { send: false, kind: "none" });
  assert.deepEqual(
    decide({ firing: false, lastSentMs: 5 }, false, 99 * HOUR, 12 * HOUR),
    { send: false, kind: "none" },
  );
});

test("applyDecision keeps lastSentMs when nothing was sent", () => {
  const s: AlertState = {};
  applyDecision(s, "k", true, { send: true, kind: "onset" }, 100);
  assert.deepEqual(s["k"], { firing: true, lastSentMs: 100 });
  applyDecision(s, "k", true, { send: false, kind: "none" }, 200);
  assert.deepEqual(s["k"], { firing: true, lastSentMs: 100 }, "a silent check must not reset the repeat timer");
});
