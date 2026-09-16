import "dotenv/config";
import { join } from "node:path";
import { liveAllowlist } from "../exec/mode.ts";
import { referralCounts, SLOT_HOLD_HOURS } from "../exec/queue.ts";
import { LIVE_MANDATE } from "../risk/params.ts";
import { Store } from "../store/db.ts";
import { readExecHeartbeat } from "../web/heartbeat.ts";
import { queueListing, toQueueRows } from "../web/queue.ts";
import { WebStore, webStorePath } from "../web/sessions.ts";

// The operator's end of the access queue (`tasks/17`).
//
//   npm run queue -- list
//   npm run queue -- invite 0x…      # front of the queue, for somebody we want on the desk
//   npm run queue -- admit  0x…      # let them into the connect flow now, if a slot is free
//
// **Neither command can arm an account.** `invite` changes an order; `admit` opens the
// connect flow. Both are upstream of every check that decides whether real money moves,
// and the account cap is checked after both, in the executor, against the venue. The
// one way past the cap is `HL_LIVE_ACCOUNT` in the box's `.env` — an environment
// variable and deliberately not a row, because arming an account for real money should
// need someone on the box and not a code path that could write one. `admit` prints
// that instruction rather than pretending to do it.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

function usage(): never {
  console.log("usage: npm run queue -- <list | invite 0x… | admit 0x…>");
  process.exit(1);
}

function address(raw: string | undefined): string {
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    console.error(`not an address: ${raw ?? "(missing)"}`);
    process.exit(1);
  }
  return raw.toLowerCase();
}

const ago = (ms: number) => {
  const h = (Date.now() - ms) / 3600_000;
  return h < 48 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
};

function main(): void {
  const [cmd, arg] = process.argv.slice(2);
  const store = new Store(process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite"));
  const web = new WebStore(webStorePath(DATA_ROOT));
  const beat = readExecHeartbeat(DATA_ROOT);
  const live = beat?.accounts.filter((a) => a.mode === "live") ?? [];
  const held = store.liveAdmissions(new Date().toISOString()).filter((a) => store.account(a.account) === null);

  const summary = () => {
    console.log(beat === null
      ? `desk: no heartbeat — the executor is not reporting. The cap is ${LIVE_MANDATE.maxLiveAccounts}.`
      : `desk: ${live.length} of ${LIVE_MANDATE.maxLiveAccounts} accounts live, ` +
        `${held.length} slot(s) held by admissions that have not connected yet`);
    if (beat !== null && live.length > LIVE_MANDATE.maxLiveAccounts) {
      console.log(`      above the cap — only HL_LIVE_ACCOUNT can do that, and it lists ${liveAllowlist().length}`);
    }
  };

  if (cmd === "list") {
    summary();
    const all = toQueueRows(web.queueEntries());
    const refs = referralCounts(all);
    const waiting = queueListing(store, web);
    console.log(`queue: ${waiting.length} waiting of ${all.length} who have asked\n`);
    waiting.forEach((r, i) => {
      const boosts = [
        r.invitedAt !== null ? "invited" : null,
        r.postedAt !== null ? "posted" : null,
        (refs.get(r.address) ?? 0) > 0 ? `${refs.get(r.address)} referral(s)` : null,
        r.fundedAt !== null ? "funded" : null,
      ].filter((b) => b !== null);
      console.log(
        `${String(i + 1).padStart(3)}. ${r.address}  joined ${ago(r.joinedAt)}` +
        (boosts.length > 0 ? `  [${boosts.join(", ")}]` : ""),
      );
    });
    if (waiting.length === 0) console.log("      (nobody is waiting)");
    return;
  }

  if (cmd === "invite") {
    const a = address(arg);
    web.inviteToQueue(a);
    console.log(`${a} is at the front of the queue.`);
    console.log(
      "That is an order, not an admission: they take the next slot that frees, ahead of " +
      "everyone else. Run `npm run queue -- admit` to let them in now, if there is a slot.",
    );
    return;
  }

  if (cmd === "admit") {
    const a = address(arg);
    summary();
    if (store.account(a) !== null) {
      console.log(`${a} is already connected — there is nothing to admit.`);
      return;
    }
    const used = new Set([...live.map((x) => x.account.toLowerCase()), ...held.map((x) => x.account)]).size;
    if (beat === null) {
      console.log("Refusing: there is no heartbeat, so how many accounts are live is unknown.");
      console.log("Start the executor, or check data/exec-heartbeat.json, and try again.");
      process.exit(1);
    }
    if (used >= LIVE_MANDATE.maxLiveAccounts) {
      // The honest answer, and the one that matters most often: at a full desk an
      // admission would let somebody through the connect flow and then have the
      // executor refuse them live, which is a worse dead end than waiting.
      console.log(`Refusing: ${used} of ${LIVE_MANDATE.maxLiveAccounts} slots are in use.`);
      console.log("Admitting now would walk them through funding an account and then refuse it live.");
      console.log("Two ways forward:");
      console.log(`  · npm run queue -- invite ${a}   — first in line for the next slot`);
      console.log(`  · add ${a} to HL_LIVE_ACCOUNT in the box's .env and restart the executor —`);
      console.log("    that account is then counted but never refused, which is the only way past");
      console.log("    the cap, and it needs someone on the box on purpose.");
      process.exit(1);
    }
    const expires = new Date(Date.now() + SLOT_HOLD_HOURS * 3600_000);
    web.joinQueue(a, null);
    store.admit(a, "operator", expires);
    console.log(`${a} is admitted to the connect flow. The slot is held until ${expires.toISOString()}.`);
    console.log("They still have to fund, choose limits and approve the agent, and every check in");
    console.log("resolveMode still applies — this is entry, not permission to trade.");
    return;
  }

  usage();
}

main();
