// Did the person decline, or did something break?
//
// It matters because the two need opposite treatment: a decline is not an error and
// must show nothing, while a failure has to say what went wrong. The page used to test
// `e.code === 4001` alone, which is what EIP-1193 specifies and not what every wallet
// sends — some use ethers' `ACTION_REJECTED`, some bury the provider error one or two
// levels down under `cause`/`error`/`data`, and some only say so in the message.
//
// Guessing wrong in the "declined" direction swallows a real failure silently. Guessing
// wrong the other way shows an error dialog to somebody who just pressed Cancel. The
// second is the one users actually hit, so the predicate is deliberately generous —
// but it only ever suppresses a message, never a state change.
//
// Pure, and separate from wallet.ts, because wallet.ts touches `window` at import time
// and this has a unit test.

const REJECTION_CODES: readonly unknown[] = [4001, "ACTION_REJECTED"];
const REJECTION_TEXT = ["user rejected", "user denied", "user cancel", "rejected by user", "request rejected"];

export function isUserRejection(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  // Depth-limited: a cause chain that loops, or is absurdly deep, is not a rejection.
  for (let i = 0; i < 5; i++) {
    if (typeof cur !== "object" || cur === null || seen.has(cur)) return false;
    seen.add(cur);
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown; error?: unknown; data?: unknown };
    if (REJECTION_CODES.includes(o.code)) return true;
    if (typeof o.message === "string") {
      const m = o.message.toLowerCase();
      if (REJECTION_TEXT.some((t) => m.includes(t))) return true;
    }
    cur = o.cause ?? o.error ?? o.data;
  }
  return false;
}
