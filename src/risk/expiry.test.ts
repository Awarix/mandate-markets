import assert from "node:assert/strict";
import { test } from "node:test";
import { expiryStatus } from "./expiry.ts";
import { RISK_PARAMS } from "./params.ts";

const NOW = Date.parse("2026-08-30T00:00:00Z");
const inDays = (d: number) => NOW + d * 86_400_000;

test("agent expiry warns before it lapses, not after", () => {
  assert.equal(expiryStatus(inDays(30), NOW).firing, false);
  assert.equal(
    expiryStatus(inDays(RISK_PARAMS.agentExpiryWarnDays - 0.1), NOW).firing, true,
    "inside the warn window",
  );
  assert.equal(
    expiryStatus(inDays(RISK_PARAMS.agentExpiryWarnDays + 0.1), NOW).firing, false,
    "outside it",
  );
  assert.equal(Math.round(expiryStatus(inDays(30), NOW).daysLeft ?? 0), 30);
});

// The UI only offers Remove, so a message that just says "re-approve" leaves the user
// looking for a button that does not exist. Both messages have to name the mechanism.
test("both expiry messages say how renewal actually works", () => {
  for (const vu of [NOW + 86_400_000, NOW - 86_400_000]) {
    assert.match(expiryStatus(vu, NOW).message, /approving it again/);
    assert.match(expiryStatus(vu, NOW).message, /no separate extend/);
  }
});

// The failure this exists to prevent: an approval that lapses mid-position leaves us
// able to read state but not to place the order that closes.
test("an expired agent says what is still protecting the position", () => {
  const e = expiryStatus(NOW - 2 * 86_400_000, NOW);
  assert.equal(e.firing, true);
  assert.match(e.message, /stops and targets are still on Hyperliquid and still work/);
});

// The reassurance is not merely present, it is **first**. The frightening reading of
// "expired" is "my leveraged position is unprotected", and that reading is false — so
// the true sentence has to arrive before the alarming one, in a banner somebody may
// only read the first line of.
test("a lapsed approval leads with the reassurance, not with the loss", () => {
  const m = expiryStatus(NOW - 2 * 86_400_000, NOW).message;
  assert.ok(m.startsWith("Your stops and targets are still on Hyperliquid"), m.slice(0, 60));
  assert.ok(m.indexOf("still work") < m.indexOf("expired"), "reassurance precedes the lapse");
});

test("an agent with no recorded expiry does not alert forever", () => {
  const e = expiryStatus(null, Date.now());
  assert.equal(e.firing, false);
  assert.equal(e.daysLeft, null);
  assert.equal(e.state, "unknown");
  assert.equal(e.expiresAt, null);
});

// The desk draws three different things, so it needs three distinguishable answers —
// `firing` alone collapses "renew this fortnight" into "nothing is trading".
test("the three states are distinguishable without re-deriving them from daysLeft", () => {
  assert.equal(expiryStatus(inDays(30), NOW).state, "healthy");
  assert.equal(expiryStatus(inDays(RISK_PARAMS.agentExpiryWarnDays - 0.1), NOW).state, "warning");
  assert.equal(expiryStatus(inDays(-0.1), NOW).state, "lapsed");
});

// The account that prompted `tasks/13` read "0 more days" while having 3.8 hours left,
// because the log rounded. A screen that says "expires today" and one that says
// "expired" are different claims, and the boundary is the sign, not the rounding.
test("hours left is not the same state as lapsed", () => {
  const nearly = expiryStatus(NOW + 3.8 * 3600_000, NOW);
  assert.equal(nearly.state, "warning");
  assert.ok((nearly.daysLeft ?? 0) > 0);
  assert.equal(nearly.expiresAt, new Date(NOW + 3.8 * 3600_000).toISOString());
});
