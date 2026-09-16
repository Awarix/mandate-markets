// One decision, pure, because it was got wrong and nothing could have caught it.
//
// While the chain waits for the agent key, it re-reads `/api/connect/status` every few
// seconds and has to answer one question: carry on, stop, or keep waiting. The first
// version asked it like this —
//
//     if (st.step === "active" || st.lastError) return false;
//     if (st.step === "approve" && st.agentAddress) return true;
//
// — and the second line is unreachable in the case that matters. Between minting a key
// and the user approving it, the executor republishes *"agent 0x… is not approved on
// 0x… yet"* on every 60-second loop. That is the state the chain is waiting to **reach**,
// not a refusal, so a working connection read as a broken one and the chain stopped at
// its last step for every new account (`tasks/38` §1.1, found by running it).
//
// The fix is the order plus `awaitingUser`, which is the executor's own `ConnectPending`
// travelling out to the page. **Never match on the message text**: the executor is the
// only thing that knows which of its sentences mean what, and this is it saying so.

/** Just enough of `ConnectStatus` to decide. */
export type ChainStatus = {
  step: "choose" | "minting" | "approve" | "active";
  agentAddress: string | null;
  lastError: string | null;
  awaitingUser: boolean;
};

/** `ready` — the key exists, open the wallet. `stop` — not ours to drive any further.
 *  `wait` — nothing has happened yet, poll again. */
export type ChainVerdict = "ready" | "stop" | "wait";

export function keyWaitVerdict(st: ChainStatus): ChainVerdict {
  // Connected already. Whatever else is true, the chain is over and the screen says so.
  if (st.step === "active") return "stop";
  // Tested before the error below, which is the whole fix.
  if (st.step === "approve" && st.agentAddress !== null) return "ready";
  // A refusal that is not the desk waiting on this person.
  if (st.lastError !== null && !st.awaitingUser) return "stop";
  return "wait";
}
