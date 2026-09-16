// Hyperliquid's referral code, which is a **discount for the user** first and a share
// for us second — and which most people cannot take, because their wallet already spent
// the slot before they ever reached us.
//
// Everything here was measured on 2026-09-10 (`notes/2026-09-10-hl-onboarding-rails.md`
// §4, `notes/2026-09-10-builder-fee-and-referral-together.md`):
//
//  - **The discount is real and it is 4% of Hyperliquid's own fee**, confirmed from live
//    fills: core perps `0.0432%` taker against `0.045%`, HIP-3 `xyz:` markets `0.00864%`
//    against `0.009%`. Their own UI renders the undiscounted rate struck through.
//  - **A builder code does not kill it.** The docs' "builder codes override referral
//    codes for that order" means the referrer is *diluted, not zeroed*: they take 10% of
//    what is left after the builder's cut. Measured on fills carrying both.
//  - **It is worth 3.1–5.8% of an account per year** at the settings our own accounts
//    run, against the builder fee's 35–67%.
//  - **An account can be referred once, ever, and wallets take the slot at connect
//    time.** MetaMask asks for it on its own connect step ("This is permanent"), and
//    Rabby does the same. So for most arrivals the slot is already spent and
//    `setReferrer` would fail — which is why this is **detection, not action**.
//
// **We set it, on an explicit click, and that click is the whole of the argument.**
// `setReferrer` is an L1 action our agent can sign with no user interaction at all —
// Hyperliquid's own frontend signs it that way. Until 2026-09-10 this file refused to,
// on the grounds that the agent is described to users as "can place orders and cannot
// withdraw" and a code that pays us is neither: margin mode is *how the account trades*,
// a referral code is *who gets paid*.
//
// That argument is against doing it **silently**, and it survives intact. What changed is
// that nothing here is silent any more (`tasks/37` §7.5): the code sits in an editable
// box the user can overwrite with anybody's, beside a button that applies it and another
// that skips it, and it is `null` in the request unless somebody pressed the first one.
// The authority is the click; the agent is only the transport. An offer that cannot be
// declined would not be one, which is why the skip is load-bearing rather than polite.
//
// Two facts make declining genuinely free, and both are why this can be a step rather
// than a gate: a code changes nothing about how the account is traded, and **the slot is
// spent once either way** — so somebody who skips keeps the option, and somebody who
// applies a friend's code gets their 4% while we get nothing, which is the honest shape
// of an offer rather than a toll.
//
// ⚠ **Never overwrite a code that exists.** An account can be referred once, ever;
// `applyReferral` re-reads the venue and does nothing at all if the slot is spent, no
// matter what a request asks for.

/** Ours, `stage: ready` on `0xacc00006…`, with referrals already attached. Nothing to
 *  create, and nothing about this is per-account. */
export const REFERRAL_CODE = "OPINION";

/** What the code is worth to the person who applies it, in their own units. */
export const REFERRAL_DISCOUNT_PCT = 4;
/** What it is worth to us.
 *
 *  ⚠ **Not stated on the connect screen, by the owner's decision on 2026-09-10.** The
 *  sentence that used to be there — *"We are paid 10% of the fee you pay them"* — was
 *  wrong in the expensive direction: the user pays Hyperliquid **4% less** than they
 *  would with no code, and our share comes out of what Hyperliquid keeps, so nobody is
 *  worse off than the status quo and the sentence claimed otherwise. The owner's reason
 *  for removing it rather than rewording it is that a referral paying its referrer is
 *  how referrals are known to work, and explaining it at length reads as greed rather
 *  than as candour. Kept here because the number is still ours to know, and `tasks/37`
 *  §7.6 carries the argument for both halves. */
export const REFERRAL_SHARE_PCT = 10;

/** Hyperliquid accepts 1–20 characters; codes are alphanumeric.
 *
 *  Validated in both tiers on purpose, and this is the only definition. The string
 *  reaches us from a box a stranger types into and leaves as a **signed L1 action**, so
 *  it gets the treatment `src/web/cards.ts` gives a share card's parameters: a bounded
 *  shape checked against a whitelist, never a sanitiser applied to whatever arrived. */
export function isValidReferralCode(code: string): boolean {
  return /^[A-Za-z0-9]{1,20}$/.test(code);
}

export const REFERRAL_LINK = `https://app.hyperliquid.xyz/join/${REFERRAL_CODE}`;

export type ReferralState =
  /** No code, ever — the only state we say anything at all in. */
  | { state: "none"; code: null }
  /** Referred by someone else. **Say nothing.** They already have their 4%, they cannot
   *  change it, and nagging them about a slot that is permanently spent would be worse
   *  than silence. */
  | { state: "theirs"; code: string }
  /** Referred by us. Nothing to ask for; confirm quietly if anywhere. */
  | { state: "ours"; code: string };

/** Which of the three states an address is in, from `info.referral()`. Pure, so the
 *  rule that decides whether a screen speaks at all is one function and is tested. */
export function referralState(referredBy: { code: string } | null): ReferralState {
  if (referredBy === null) return { state: "none", code: null };
  return referredBy.code.toUpperCase() === REFERRAL_CODE
    ? { state: "ours", code: referredBy.code }
    : { state: "theirs", code: referredBy.code };
}

export type ReferralOutcome =
  /** The venue's answer afterwards. `changed` is false when the slot was already spent
   *  — which is not a failure and never an error: it is the ordinary case. */
  | { ok: true; changed: boolean; state: ReferralState }
  | { ok: false; why: string };

/** Apply a referral code the user asked for, once, to an account that has none.
 *
 *  Returns rather than throws, for the reason `ensureTradeable` does: `src/hl/` must
 *  never import from `src/exec/`, and the caller decides how loud a failure is. Here
 *  the answer is **not at all** — a code that did not apply costs its owner 4% of the
 *  venue's fee and nothing else, so it must never stand between a funded account and
 *  being traded. `connectAccount` logs the outcome and carries on.
 *
 *  Called after the agent approval, because the agent signs it, and after funding,
 *  because Hyperliquid refuses an address that has never deposited with
 *  `Must deposit before performing actions`. */
export async function applyReferral(a: {
  info: { referral(args: { user: `0x${string}` }): Promise<{ referredBy: { code: string } | null }> };
  exchange: { setReferrer(args: { code: string }): Promise<unknown> };
  master: `0x${string}`;
  code: string;
  log: (msg: string) => void;
}): Promise<ReferralOutcome> {
  if (!isValidReferralCode(a.code)) {
    return { ok: false, why: `"${a.code}" is not a referral code Hyperliquid would accept` };
  }
  // Re-read rather than trust the request. The row may be minutes old, the wallet may
  // have claimed the slot in between, and the venue is authoritative for facts.
  let before: ReferralState;
  try {
    before = referralState((await a.info.referral({ user: a.master })).referredBy);
  } catch (e) {
    return { ok: false, why: `could not read this account's referral state: ${msg(e)}` };
  }
  if (before.state !== "none") {
    a.log(`${a.master} already referred by ${before.code} — leaving it alone (a code is permanent)`);
    return { ok: true, changed: false, state: before };
  }

  try {
    await a.exchange.setReferrer({ code: a.code });
  } catch (e) {
    return { ok: false, why: `Hyperliquid refused the code "${a.code}": ${msg(e)}` };
  }
  // Read it back for the same reason `ensureTradeable` does: the request returning is
  // not the venue agreeing, and this is a thing that can only be done once.
  try {
    const after = referralState((await a.info.referral({ user: a.master })).referredBy);
    if (after.state === "none") {
      return { ok: false, why: `Hyperliquid still reports no referral code after accepting "${a.code}"` };
    }
    a.log(`${a.master} referral code ${after.code} applied (${REFERRAL_DISCOUNT_PCT}% off the venue's fee, permanently)`);
    return { ok: true, changed: true, state: after };
  } catch (e) {
    return { ok: false, why: `set the code but could not read it back: ${msg(e)}` };
  }
}

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
