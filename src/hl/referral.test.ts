import assert from "node:assert/strict";
import { test } from "node:test";
import { applyReferral, isValidReferralCode, REFERRAL_CODE, REFERRAL_LINK, referralState } from "./referral.ts";

// Three states, and the one that matters most is the middle one: most arrivals are
// already referred by their own wallet, permanently, and the right behaviour there is
// to say nothing at all.

test("no code is the only state we speak in", () => {
  assert.deepEqual(referralState(null), { state: "none", code: null });
});

test("someone else's code is theirs, and stays theirs", () => {
  // A live depositor sampled at random on 2026-09-10. The slot is spent; `setReferrer`
  // would fail, and asking them to change it would be asking for the impossible.
  assert.equal(referralState({ code: "RABBYWALLET" }).state, "theirs");
  assert.equal(referralState({ code: "METAMASK" }).state, "theirs");
});

test("our own code is recognised however the venue cases it", () => {
  assert.equal(referralState({ code: REFERRAL_CODE }).state, "ours");
  assert.equal(referralState({ code: REFERRAL_CODE.toLowerCase() }).state, "ours");
});

// The link goes to Hyperliquid's own domain, deliberately: applying it there is the
// same trust anchor the manual agent-approval route is kept for, and it is the reason
// we do not have our agent sign `setReferrer`.
test("the link is Hyperliquid's own join page", () => {
  assert.equal(REFERRAL_LINK, "https://app.hyperliquid.xyz/join/OPINION");
});

// ── applyReferral (tasks/37 §7.5) ───────────────────────────────────────────
//
// The rule that matters is the one that cannot be undone: a code is permanent, so an
// account that already has one is never touched, whatever the request says.

type Called = { code: string }[];

function fakes(referredBy: { code: string } | null, after?: { code: string } | null) {
  const calls: Called = [];
  let state = referredBy;
  return {
    calls,
    info: {
      referral: async () => {
        const r = { referredBy: state };
        if (after !== undefined) state = after;      // what the venue says the second time
        return r;
      },
    },
    exchange: { setReferrer: async (a: { code: string }) => { calls.push(a); } },
  };
}

test("an account with somebody else's code is left alone, and nothing is signed", async () => {
  const f = fakes({ code: "RABBYWALLET" });
  const out = await applyReferral({
    info: f.info, exchange: f.exchange, master: "0xaf38", code: "OPINION", log: () => {},
  });
  assert.deepEqual(out, { ok: true, changed: false, state: { state: "theirs", code: "RABBYWALLET" } });
  assert.equal(f.calls.length, 0, "must not attempt to overwrite a permanent code");
});

test("an account with our code is also left alone", async () => {
  const f = fakes({ code: "OPINION" });
  const out = await applyReferral({
    info: f.info, exchange: f.exchange, master: "0xaf38", code: "OPINION", log: () => {},
  });
  assert.equal(out.ok && out.changed, false);
  assert.equal(f.calls.length, 0);
});

test("an unreferred account is set, and the venue is read back to prove it", async () => {
  const f = fakes(null, { code: "OPINION" });
  const out = await applyReferral({
    info: f.info, exchange: f.exchange, master: "0xaf38", code: "OPINION", log: () => {},
  });
  assert.deepEqual(out, { ok: true, changed: true, state: { state: "ours", code: "OPINION" } });
  assert.deepEqual(f.calls, [{ code: "OPINION" }]);
});

test("a code the venue accepted but did not record is a failure, not a success", async () => {
  const f = fakes(null, null);
  const out = await applyReferral({
    info: f.info, exchange: f.exchange, master: "0xaf38", code: "OPINION", log: () => {},
  });
  assert.equal(out.ok, false);
});

test("a code that is not a code never reaches the venue", async () => {
  for (const bad of ["", "with space", "toolongtoolongtoolong1", "semi;colon", "../etc", "<script>"]) {
    const f = fakes(null);
    const out = await applyReferral({
      info: f.info, exchange: f.exchange, master: "0xaf38", code: bad, log: () => {},
    });
    assert.equal(out.ok, false, `${bad} must be refused`);
    assert.equal(f.calls.length, 0, `${bad} must not be signed`);
  }
});

test("the shape Hyperliquid accepts, and nothing else", () => {
  for (const ok of ["OPINION", "a", "A1b2C3", "12345678901234567890"]) {
    assert.equal(isValidReferralCode(ok), true, ok);
  }
  for (const no of ["", "123456789012345678901", "has space", "dash-ed", "under_score", "é"]) {
    assert.equal(isValidReferralCode(no), false, no);
  }
});
