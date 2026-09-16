import "dotenv/config";
import { join } from "node:path";
import { isTestnet, makeInfoClient } from "../hl/clients.ts";
import { Universe } from "../hl/universe.ts";
import { keystorePath } from "../keys/keystore.ts";
import { applyDecision, decide, loadState, saveState } from "../ops/alert-state.ts";
import { countEventsSince, recordConfigChange } from "../ops/config-event.ts";
import { globalHalt } from "../ops/halt.ts";
import { aggregateAccounts, writeHeartbeat, type AccountHeartbeat } from "../ops/heartbeat.ts";
import { notify } from "../ops/notify.ts";
import { DESK_WATCH, LIVE_MANDATE, RISK_PARAMS } from "../risk/params.ts";
import { haltsInWindow } from "../ops/desk-watch.ts";
import { dayKey } from "../risk/ledger.ts";
import { QuotientClient } from "../signals/client.ts";
import { CreditMeter } from "../signals/meter.ts";
import { ArchiveSource, FileSource, LiveQuotientSource, type SignalSource, type Snapshot } from "../signals/source.ts";
import { SKIP_RETENTION_DAYS, Store } from "../store/db.ts";
import { expiryStatus } from "../risk/expiry.ts";
import { checkCollateral } from "../hl/state.ts";
import { ACCOUNTS_DIR, connectAccount, isPending, managedAddresses, openKeystore, refreshFee, type ManagedAccount } from "./accounts.ts";
import { serviceChangeRequests } from "./change-queue.ts";
import { readUnlinkRequests, serviceConnectRequests } from "./connect-queue.ts";
import { serviceQueue } from "./queue.ts";
import { isPinned } from "./settings.ts";
import { ingestAccount, shouldIngestFills } from "./fills.ts";
import { ingestCounterfactuals } from "./counterfactual.ts";
import type { Candle } from "../scripts/exit-policy.ts";
import { cancelOurRestingOrders, tick, type LoopDeps } from "./loop.ts";
import { canBeRefusedForSlot, liveAllowlist } from "./mode.ts";

// Phase 4 — execution core, N accounts. Process wiring only: the behaviour is in
// `loop.ts` (one account's state machine, already a pure function of its inputs) and
// `accounts.ts` (who we manage, whose key signs, and the connect-time checks).
//
//   npm run exec            # signals from the recorder's archive
//   SIGNAL_SOURCE=file npm run exec
//
// The rule this file exists to enforce: **one account must never affect another.** A
// connect failure skips that account and the rest still run; a tick that throws is
// caught, counted and reported, and the next account is still ticked in the same
// loop; the signal poll and the mark refresh happen once and are shared.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const EXPIRY_CHECK_MS = 3600_000;
const PRUNE_CHECK_MS = 86_400_000;
const ERROR_ALERT_AFTER = 3;

function log(msg: string): void {
  console.log(`[exec] ${new Date().toISOString()} ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildSource(): SignalSource {
  const which = process.env.SIGNAL_SOURCE ?? "archive";
  if (which === "live") {
    return new LiveQuotientSource(
      new QuotientClient(process.env.QUOTIENT_API_KEY ?? "", process.env.QUOTIENT_BASE_URL),
      new CreditMeter(join(DATA_ROOT, "credit-meter.json"), Number(process.env.QUOTIENT_MONTHLY_CREDIT_CAP_USD ?? 50)),
    );
  }
  if (which === "file") return new FileSource(process.env.SIGNAL_FILE ?? "data/probe/perps-live.json");
  return new ArchiveSource(DATA_ROOT);
}

/** Edge-triggered alerting, same contract the watchdog uses: fire on the transition,
 *  repeat at most every 12h, and say so when it clears. Without this a per-account
 *  fault sends one message per loop and the channel gets muted, which is the same as
 *  having no alerting at all. */
async function edgeAlert(key: string, firing: boolean, onset: string, resolved: string): Promise<void> {
  const path = join(DATA_ROOT, "exec-alert-state.json");
  const state = loadState(path);
  const now = Date.now();
  const d = decide(state[key], firing, now, 12 * 3600_000);
  if (d.send) {
    const prefix = d.kind === "resolved" ? "✅ RESOLVED" : d.kind === "repeat" ? "🔴 STILL" : "🔴 ALERT";
    await notify(`${prefix} · SignalDesk\n${d.kind === "resolved" ? resolved : onset}`);
  }
  applyDecision(state, key, firing, d, now);
  saveState(path, state);
}

type AccountState = {
  managed: ManagedAccount;
  consecutiveErrors: number;
  lastBeat: AccountHeartbeat | null;
  lastExpiryCheckMs: number;
  /** 0 rather than `Date.now()`, so the first pass runs immediately: it is the
   *  backfill that gives an account a watermark, and until it has one every fill is
   *  history rather than news. */
  lastIngestMs: number;
};

async function main(): Promise<void> {
  const store = new Store(process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite"));
  const info = makeInfoClient();
  const universe = await Universe.load(info);
  log(`universe: ${universe.size} markets across ${universe.dexes.length} dexes (${universe.dexes.map((d) => d || "main").join(", ")})`);

  // Before any account connects, so the instant on the row is the instant the desk
  // began trading on the new value (`tasks/47` Rule 1). Nothing is written on a restart
  // that moved no constant, which is nearly every restart.
  //
  // ⚠ **`speedHalt` is the one thing here that changes behaviour.** `tasks/47` Rule 4
  // refuses a second change inside one block, and the task's word for what that does is
  // *"fails a boot check"*. It does not exit: on a restart the SIGTERM handler leaves the
  // reduce-only exits resting and cancels everything else, so a desk that will not come
  // back up keeps its stops and loses the signal-change exit, the horizon close,
  // foreign-actor detection and the daily-loss halt — `docs/STATUS.md` item 20's failure,
  // induced deliberately, to protect a property of the analysis. Instead the breach arms
  // the global halt, which already means exactly the right thing: nothing opens, every
  // exit stays managed, and `tick()` reads it before `considerSignals` rather than after.
  let speedHalt: { halted: boolean; reason: string } = { halted: false, reason: "" };
  try {
    const r = await recordConfigChange({
      store, path: join(DATA_ROOT, "config-fingerprint.json"), log, notify,
      countEventsSince: countEventsSince(store),
      override: process.env.CONFIG_OVERRIDE,
    });
    if (!r.speed.ok) speedHalt = { halted: true, reason: `speed limit: ${r.speed.reason}` };
  } catch (e) {
    // Never fatal. Not recording a change is bad — the block becomes unattributable and
    // `npm run expectancy` cannot say so — but refusing to manage fourteen accounts
    // because a bookkeeping file could not be written is worse, and it is the failure
    // this whole file is arranged around. ⚠ A throw here therefore also leaves the speed
    // limit unarmed: it is a check on a change we could not read, and guessing that a
    // change happened would halt every account on an I/O error.
    log(`ALERT could not record the config fingerprint: ${e instanceof Error ? e.message : String(e)}`);
  }

  const addresses = managedAddresses(store);
  const { keystore: initialKeystore, passphrase } = openKeystore(keystorePath(DATA_ROOT));
  // `putKey` rebuilds the keystore rather than mutating it, so this has to be a
  // binding the connect queue can replace.
  let keystore = initialKeystore;

  let latestMarks = new Map<string, number>();
  const marks = () => latestMarks;

  // Connect-time failures are per-account. With one account this is the same as
  // throwing; with several, refusing to start everything because one user's agent
  // approval lapsed would be the multi-account version of a shared failure domain.
  const states: AccountState[] = [];
  // What the aggregate live cap is measured against: **every** account live in this
  // process, ours included (`tasks/17`). It counted only the self-service ones until
  // 2026-09-05, which made `maxLiveAccounts` describe fewer accounts than we trade —
  // and the number exists to bound how many one bug of ours reaches in a tick, which
  // our own account is not exempt from. What the allowlist still buys is exemption
  // from the *refusal* (`canBeRefusedForSlot`), so an allowlisted account can push
  // this past the cap; `warnIfOverCap` below says so out loud rather than letting a
  // cap quietly stop binding. Among the accounts that can be refused, order in
  // `managedAddresses()` decides who gets the last slot; it is sorted, which makes
  // that at least deterministic.
  const liveSlotsUsed = () => states.filter((s) => s.managed.mode === "live").length;

  // Said once per crossing, not once per loop. Two things can hold the count above the
  // cap and both are operator acts, so this is a record of a decision's effect rather
  // than an alert about a fault: naming an address in `HL_LIVE_ACCOUNT`, and — since
  // `tasks/34` — incumbents, who are no longer dropped for a slot. An account can only
  // *become* an incumbent through a free slot, so incumbency alone cannot walk the
  // number up; it can only fail to walk it back down after the cap was passed or
  // lowered. Naming both is the point: "only HL_LIVE_ACCOUNT can do this" was true
  // until 2026-09-10 and stopped being true here.
  let overCapSaid = false;
  const warnIfOverCap = () => {
    const used = liveSlotsUsed();
    const over = used > LIVE_MANDATE.maxLiveAccounts;
    if (over && !overCapSaid) {
      const live = states.filter((s) => s.managed.mode === "live");
      const pinned = live.filter((s) => !canBeRefusedForSlot(s.managed.master)).map((s) => s.managed.master);
      const kept = live.filter((s) => canBeRefusedForSlot(s.managed.master) && s.managed.incumbent)
        .map((s) => s.managed.master);
      log(
        `NOTE ${used} accounts are live, above LIVE_MANDATE.maxLiveAccounts ` +
        `(${LIVE_MANDATE.maxLiveAccounts}). HL_LIVE_ACCOUNT pins ${pinned.length}` +
        `${pinned.length ? `: ${pinned.join(", ")}` : ""}. ` +
        `${kept.length} already-live account(s) were kept rather than dropped for a slot` +
        `${kept.length ? `: ${kept.join(", ")}` : ""} (tasks/34). ` +
        "Nothing self-service was admitted past the cap.",
      );
    }
    overCapSaid = over;
  };

  // Errors from an account that has asked to connect but is not approved yet are
  // expected once a minute, forever, until the user acts. Log them when they change,
  // never on repeat, and put the current one on the user's screen instead. Shared by
  // both connect loops — startup and the runtime pickup — so an account that is
  // pending at boot does not re-log the identical line a second later.
  const lastConnectError = new Map<string, string>();

  /** `tasks/34`: *this address has never armed* and *this address was live and is no
   *  longer managed* printed the same sentence, and only the second one leaves
   *  somebody's open position carrying nothing but its resting venue-side stops. The
   *  `accounts` row still says what the account last armed as — every `ConnectPending`
   *  throws before `store.connectAccount` rewrites it — so telling them apart is one
   *  read, and it works for every refusal reason, not only the slot. */
  const pendingLine = (addr: string, msg: string): string =>
    store.account(addr)?.mode === "live"
      ? `${addr} WAS LIVE AND IS NO LONGER MANAGED. Its venue-side stops and targets are ` +
        `still resting; nothing else is — no signal-change exit, no horizon close, no ` +
        `daily-loss halt, no foreign-actor detection. Reason: ${msg}`
      : `${addr} not connected yet: ${msg}`;

  // Paced, not fired off together. A cold start with fifteen addresses is around a
  // hundred `info` calls in a second or two, and this box has taken a Hyperliquid 429
  // storm on loop 1 seven times — once leaving a live account unmanaged for two loops.
  // `RISK_PARAMS.connectPaceMs` carries the argument and the cost.
  let paced = false;
  const pace = async () => {
    if (paced) await sleep(RISK_PARAMS.connectPaceMs);
    paced = true;
  };

  for (const addr of addresses) {
    await pace();
    try {
      const managed = await connectAccount(addr, {
        info, universe, store, marks, log, keystore, passphrase,
        liveSlotsUsed: liveSlotsUsed(),
      });
      states.push({ managed, consecutiveErrors: 0, lastBeat: null, lastExpiryCheckMs: Date.now(), lastIngestMs: 0 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // An account waiting on its owner — unfunded, agent not approved, no free slot —
      // is an expected state, not an incident. Record it where the connect screen reads
      // it and move on; waking someone for every stranger who has not funded yet is how
      // an alert channel stops being read.
      if (isPending(e)) {
        log(pendingLine(addr, msg));
        if (store.connection(addr)) store.setConnectionStatus(addr, "awaiting_approval", msg);
        lastConnectError.set(addr, msg);
        continue;
      }
      log(`ALERT ${addr} did not connect and is NOT being managed: ${msg}`);
      await edgeAlert(`connect:${addr}`, true, `${addr} failed to connect and is not being managed.\n${msg}`, "");
    }
  }
  // Starting with nothing is no longer a fatal error: an account can arrive at
  // runtime by connecting through the web. It is still worth saying loudly, because
  // with `HL_MASTER_ADDRESS` set it means the one account we were pinned to failed
  // its checks, and that is not a quiet condition.
  if (states.length === 0) {
    log("WARNING no account connected yet — the loop will run and pick one up when it appears");
  }

  // A restart is the other moment the live count can be above the cap: the accounts
  // come back in the order `managedAddresses()` lists them, and an allowlisted one is
  // never refused.
  warnIfOverCap();

  const many = states.length > 1;
  log(`managing ${states.length} account(s) on ${isTestnet() ? "TESTNET" : "MAINNET"}: ${states.map((s) => `${s.managed.master} (${s.managed.mode})`).join(", ")}`);

  // 24h notional per market, for the capacity floor. Refreshed on the same slow cycle
  // as the fill ingest rather than every loop: it is a 24-hour number, and
  // `metaAndAssetCtxs` is one more call per dex on top of the four the loop already
  // makes. Confirmed live 2026-09-02 that it works on a HIP-3 dex, which `tasks/07`
  // flagged as unverified.
  const volume = new Map<string, number>();
  let volumeAtMs = 0;
  const refreshVolume = async () => {
    if (Date.now() - volumeAtMs < RISK_PARAMS.fillIngestSec * 1000) return;
    for (const dex of universe.dexes) {
      const [meta, ctxs] = await info.metaAndAssetCtxs(dex === "" ? undefined as never : { dex } as never);
      meta.universe.forEach((u, i) => {
        const v = Number(ctxs[i]?.dayNtlVlm ?? NaN);
        if (Number.isFinite(v)) volume.set(u.name, v);
      });
    }
    volumeAtMs = Date.now();
  };

  // Null on any failure, and `preTradeCheck` refuses on null. A book we cannot see is
  // one we cannot promise to get back out of, and the alternative — opening anyway —
  // is the failure this check was added to prevent.
  const readDepth = async (coin: string) => {
    try {
      await refreshVolume();
      const book = await info.l2Book({ coin });
      const [bids, asks] = book?.levels ?? [[], []];
      const v = volume.get(coin);
      if (v === undefined) return null;
      return { book: { bids: bids ?? [], asks: asks ?? [] }, volume24hUsd: v };
    } catch (e) {
      log(`${coin} depth read failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };

  const refreshAllMarks = async () => {
    for (const dex of universe.dexes) {
      const mids = await info.allMids(dex === "" ? {} : { dex });
      for (const [coin, px] of Object.entries(mids)) {
        const n = Number(px);
        if (Number.isFinite(n)) latestMarks.set(coin, n);
      }
    }
  };

  const source = buildSource();
  log(`signal source: ${source.name}`);

  let stopping = false;
  const stop = (sig: string) => { log(`${sig} — cancelling our resting orders, then exiting`); stopping = true; };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // Let go of accounts whose owners asked to be let go. Runs **before** admitting new
  // ones, so an address that unlinked and reconnected in the same minute is released
  // and then re-admitted, rather than admitted and then released.
  //
  // **Nothing is closed on the venue.** `cancelOurRestingOrders` pulls only the orders
  // that could open or increase exposure and leaves every reduce-only exit resting —
  // the same rule SIGTERM follows, for the same reason: a position left without its
  // stop is the failure venue-side stops exist to prevent. The position stays open and
  // protected; what stops is us managing it. The user is told exactly that before they
  // press the button, including the part that bites — nothing will close it when the
  // outlook expires, so it is theirs to close now.
  // An unlink for an account pinned by `accounts/<address>.json` is ignored, and said
  // once. `managedAddresses` lists that account from the file whatever the request
  // says, so honouring the unlink releases it for one second and re-admits it on the
  // same loop — then again on the next, because a serviced unlink row is never
  // deleted here. Seven such cycles ran on our own live account on 2026-09-04
  // (`notes/2026-09-04-pinned-account-unlink-loop.md`). The web tier now refuses the
  // request; this is what makes a row that already exists harmless.
  const unlinkIgnored = new Set<string>();
  const releaseUnlinked = async () => {
    for (const addr of readUnlinkRequests(join(DATA_ROOT, "web.sqlite"))) {
      if (isPinned(addr, ACCOUNTS_DIR)) {
        if (!unlinkIgnored.has(addr)) {
          unlinkIgnored.add(addr);
          log(`${addr} unlink request ignored: the account is pinned by accounts/${addr}.json — remove the file to stop managing it`);
        }
        continue;
      }
      const i = states.findIndex((s) => s.managed.master.toLowerCase() === addr);
      if (i === -1) {
        // Not managed by this process: either already released, or it never connected.
        // Still worth recording, so a request made while the desk was down is not lost.
        const conn = store.connection(addr);
        if (store.account(addr) !== null || (conn && conn.status !== "disconnected")) {
          const { released } = store.disconnectAccount(addr);
          log(`${addr} unlinked (was not being managed here); released ${released} intent(s)`);
        }
        continue;
      }
      const st = states[i]!;
      try {
        const cancelled = await cancelOurRestingOrders({
          broker: st.managed.broker, universe, store, master: st.managed.master, log,
        });
        const { released } = store.disconnectAccount(st.managed.master);
        states.splice(i, 1);
        lastConnectError.delete(addr);
        log(
          `${addr} unlinked at the owner's request: cancelled ${cancelled} exposure-opening ` +
          `order(s), released ${released} open intent(s), left every reduce-only stop resting ` +
          "on the venue. No position was closed.",
        );
      } catch (e) {
        // Leave it managed and try again next loop. Half-releasing an account — orders
        // pulled, ledger still claiming it — is worse than not releasing it yet.
        log(`ALERT ${addr} unlink failed, still managed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };

  const admitNewAccounts = async () => {
    await releaseUnlinked();
    // The access queue (`tasks/17`), before the connect requests it feeds. Admission
    // is entry to the connect flow and never permission to trade: everything that
    // decides whether an account may be armed is still `connectAccount` below, and the
    // account cap is still checked there, against the same count this passes in.
    try {
      serviceQueue({
        store,
        queueDb: join(DATA_ROOT, "web.sqlite"),
        liveAccounts: states.filter((s) => s.managed.mode === "live").map((s) => s.managed.master),
        pinned: liveAllowlist(),
        log,
      });
    } catch (e) {
      // A queue we cannot read is not a reason to stop managing the accounts we
      // already have. Nobody new gets in this loop; everyone in already stays in.
      log(`servicing the access queue failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    keystore = serviceConnectRequests({
      store, keystore, passphrase,
      keystoreFile: keystorePath(DATA_ROOT),
      requestsDb: join(DATA_ROOT, "web.sqlite"),
      log,
    });
    // The same pacing on the retry path, and it is the one that runs every minute: the
    // addresses that are allowlisted but have never connected re-run their checks on
    // every loop, so the burst is not confined to a cold start.
    let pacedThisLoop = false;
    for (const addr of managedAddresses(store)) {
      if (states.some((s) => s.managed.master.toLowerCase() === addr)) continue;
      if (pacedThisLoop) await sleep(RISK_PARAMS.connectPaceMs);
      pacedThisLoop = true;
      try {
        const managed = await connectAccount(addr, {
          info, universe, store, marks, log, keystore, passphrase,
          liveSlotsUsed: liveSlotsUsed(),
        });
        states.push({ managed, consecutiveErrors: 0, lastBeat: null, lastExpiryCheckMs: Date.now(), lastIngestMs: 0 });
        lastConnectError.delete(addr);
        log(`${addr} joined this process: mode=${managed.mode}`);
        warnIfOverCap();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (lastConnectError.get(addr) !== msg) {
          lastConnectError.set(addr, msg);
          log(pendingLine(addr, msg));
        }
        if (store.connection(addr)) store.setConnectionStatus(addr, "awaiting_approval", msg);
      }
    }
  };

  let snapshot: Snapshot | null = null;
  let lastPollMs = 0;
  const pollEveryMs = Number(process.env.SIGNAL_POLL_SEC ?? RISK_PARAMS.loopIntervalSec) * 1000;
  const hbPath = join(DATA_ROOT, "exec-heartbeat.json");
  let loops = 0;
  // 0, so the first loop after a restart prunes. A process that restarts more often
  // than once a day would otherwise never reach the check at all.
  let lastPruneMs = 0;
  let lastCounterfactualMs = 0;

  while (!stopping) {
    loops++;
    // Admitting accounts is deliberately inside the loop: `listAccounts()` used to run
    // once before it, so an account that connected while the process was up stayed
    // invisible until someone restarted it.
    try {
      await admitNewAccounts();
    } catch (e) {
      log(`admitting new accounts failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Limits and mandate changes asked for from the desk (`tasks/18`). After the
    // unlinks and the admissions, so a change lands on the account as it is now; the
    // `ManagedAccount` fields are replaced in place and the deps below read them.
    try {
      await serviceChangeRequests({
        store, requestsDb: join(DATA_ROOT, "web.sqlite"),
        accounts: states.map((s) => s.managed),
        readCollateral: (master, minUsd) => checkCollateral(info, master, minUsd),
        // The equity this process read on the previous tick, for the halt-clear check.
        // Not a fresh venue call: `tick()` has already asked, and asking twice in one
        // loop is two answers to one question. Null before an account's first tick,
        // which `canClearHalt` reports rather than assuming.
        equityUsd: (master) =>
          states.find((s) => s.managed.master.toLowerCase() === master.toLowerCase())?.lastBeat?.equityUsd ?? null,
        log,
      });
    } catch (e) {
      log(`servicing change requests failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    let fresh = false;
    if (Date.now() - lastPollMs >= pollEveryMs) {
      try {
        snapshot = await source.fetch();
        lastPollMs = Date.now();
        fresh = true;
      } catch (e) {
        log(`signal fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Marks are venue truth and identical for every account, so they are refreshed
    // once per loop and shared. `tick()` asks for them itself, so this memoises
    // rather than changing the loop's contract.
    let refreshedThisLoop = false;
    const refreshMarks = async () => {
      if (refreshedThisLoop) return;
      await refreshAllMarks();
      refreshedThisLoop = true;
    };

    // How long since **Quotient** was last reached, which is the source's own fact and
    // never our clock.
    //
    // This read `Date.now() - lastPollMs` until 2026-09-07, and `lastPollMs` is when
    // *we* last called `source.fetch()`. In production `SIGNAL_SOURCE=archive`, and
    // that call reads a file the recorder writes — so it succeeds every loop whatever
    // is happening upstream, `lastPollMs` was always seconds old, and `staleFeedSec`
    // could not fire at all. Found during a Quotient outage that had frozen the
    // archive for over five hours while this reported a feed age of zero.
    const feedAgeSec = snapshot === null ? Infinity : (Date.now() - snapshot.polledAt.getTime()) / 1000;
    // The operator's file, or the speed limit armed at boot. The file is re-read every
    // loop so removing it resumes without a restart; the speed limit cannot change while
    // the process runs, because the constants it measures are compiled in — clearing it
    // is `CONFIG_OVERRIDE` and a restart, or putting the constant back.
    const fileHalt = globalHalt();
    const halt = speedHalt.halted ? speedHalt : fileHalt;
    const beats: AccountHeartbeat[] = [];

    for (const st of states) {
      const a = st.managed;
      const prefixed = many ? (m: string) => log(`${a.master} ${m}`) : log;
      // Carried out of the `try` because the ingest below runs whether or not the tick
      // threw: a loop that failed after settling a close still owes the venue read.
      let closedThisTick = false;
      try {
        const deps: LoopDeps = {
          store, master: a.master, universe, settings: a.settings, baseCapital: a.baseCapital,
          broker: a.broker, refreshMarks, readDepth, snapshot, fresh, feedAgeSec,
          globalHalt: halt, agentValidUntil: a.agent?.validUntil ?? null,
          now: new Date(), log: prefixed, notify,
        };
        const r = await tick(deps);
        closedThisTick = r.closed > 0;

        if (r.opened || r.placed || r.cancelled || r.closed) {
          prefixed(`loop ${loops}: opened=${r.opened} placed=${r.placed} cancelled=${r.cancelled} closed=${r.closed}`);
        }

        const beat: AccountHeartbeat = {
          account: a.master, mode: a.mode, halted: r.halted, haltReason: r.haltReason,
          equityUsd: round2(r.view.equityUsd), freeUsd: round2(r.view.freeUsd),
          baseCapital: a.baseCapital, deployedUsd: round2(store.deployedMargin(a.master)),
          dayStartEquity: round2(r.allocation.dayStartEquity),
          openIntents: store.openCount(a.master),
          positions: r.view.positions.filter((p) => p.szi !== 0).length,
          restingOrders: r.view.orders.length,
          foreignOrders: r.foreignOrders, foreignPositions: r.foreignPositions,
          // Derived from the approval we already hold rather than carried from the
          // previous beat. `connectAccount` reads `validUntil` before the first tick
          // and the hourly check writes the venue's answer back onto it, so this is
          // populated from the very first heartbeat instead of staying null until the
          // expiry timer first fires — which was an hour after **every** restart, and
          // exactly the window in which somebody looks.
          agentDaysLeft: expiryStatus(a.agent?.validUntil ?? null, Date.now()).daysLeft,
          // Frozen at connect, like the broker's copy of it — the two must agree, or
          // the desk describes a fee the orders are not carrying.
          fee: a.fee,
          error: null, consecutiveErrors: 0,
          // What this account is holding, for the desk-wide book line (`DESK_WATCH`).
          // From the venue's own view, not from the ledger: the question is what is
          // actually at risk, and a position we did not open counts for that.
          book: r.view.positions.filter((p) => p.szi !== 0)
            .map((p) => ({ coin: p.coin, side: p.szi > 0 ? "long" as const : "short" as const })),
        };
        beats.push(beat);
        st.lastBeat = beat;
        if (st.consecutiveErrors >= ERROR_ALERT_AFTER) {
          await edgeAlert(`acct-error:${a.master}`, false, "", `${a.master} is ticking again after ${st.consecutiveErrors} failed loop(s).`);
        }
        st.consecutiveErrors = 0;
      } catch (e) {
        st.consecutiveErrors++;
        const msg = e instanceof Error ? e.stack ?? e.message : String(e);
        prefixed(`loop error (${st.consecutiveErrors} in a row): ${msg}`);
        // Carry the last known figures so the aggregate stays readable, and mark the
        // account as erroring rather than silently dropping it from the totals.
        const carried: AccountHeartbeat = st.lastBeat
          ? { ...st.lastBeat, error: e instanceof Error ? e.message : String(e), consecutiveErrors: st.consecutiveErrors }
          : {
              account: a.master, mode: a.mode, halted: false, haltReason: null,
              equityUsd: 0, freeUsd: 0, baseCapital: a.baseCapital, deployedUsd: 0, dayStartEquity: 0,
              openIntents: 0, positions: 0, restingOrders: 0, foreignOrders: 0, foreignPositions: 0,
              agentDaysLeft: expiryStatus(a.agent?.validUntil ?? null, Date.now()).daysLeft,
              fee: a.fee,
              error: e instanceof Error ? e.message : String(e), consecutiveErrors: st.consecutiveErrors,
            };
        beats.push(carried);
        if (st.consecutiveErrors === ERROR_ALERT_AFTER) {
          await edgeAlert(
            `acct-error:${a.master}`, true,
            `${a.master} has failed ${st.consecutiveErrors} loops in a row and is not being managed right now.\n` +
            `Venue-side stops and targets are untouched and still working.\n${msg}`,
            "",
          );
        }
      }

      // What the trades actually cost. Two `info` calls per live account on a slow
      // cycle, settled after the fact — nothing in the decision path reads any of it,
      // which is why it sits outside `tick()` rather than inside it. A paper account
      // has no venue fills, so ingesting one would flag every simulated trip as an
      // unattributable mystery.
      //
      // **Except after a close, and that exception is the whole of `tasks/51`.** One
      // thing in the decision path does read a column this ingest writes, and it is
      // `blockReentryAfterStop`.
      if (shouldIngestFills(a.mode, closedThisTick, Date.now() - st.lastIngestMs)) {
        st.lastIngestMs = Date.now();
        try {
          const ing = await ingestAccount({
            info, store, universe, master: a.master, log: prefixed, notify,
          });
          if (ing.fills || ing.funding || ing.settled || ing.rescanned) {
            prefixed(
              `ingested ${ing.fills} fill(s), ${ing.funding} funding row(s), settled ${ing.settled} intent(s)` +
              (ing.backfill ? " (first pass — backfill, nothing halted on)" : "") +
              // Said once per account, ever. The pass that re-reads the whole fill
              // history to pick up `fills.liquidation` on rows ingested before the
              // column existed — so a liquidation recorded as `retired` with no settled
              // result becomes a liquidation with one.
              (ing.rescanned ? " (re-read the full history once for liquidations)" : ""),
            );
          }
        } catch (e) {
          // Never fatal to the tick. This is bookkeeping about trades that already
          // happened; failing it must not stop the account being managed.
          prefixed(`fill ingest failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // An account that has not approved the fee re-reads it **every loop**, not
      // hourly (`tasks/33` §3). Observed live on 2026-09-10: after a real signature the
      // executor still read `fee: {state: 'unapproved'}` and took a restart to notice.
      // At an hour's granularity that cost revenue and nothing else; once the approval
      // moves into the connect flow the signature lands seconds either side of
      // `connectAccount`'s own read, which is exactly the window that goes unnoticed —
      // a required fee that silently does not apply for the first hour of every account
      // is worse than an optional one that works.
      //
      // Self-healing rather than a cross-process signal, which is the reason to prefer
      // it: the web tier cannot call the executor, so anything push-based needs a
      // delivery guarantee and this needs none. It costs one info call per loop per
      // *unapproved* live account and stops the moment one approves — and no call at
      // all while `HL_BUILDER_ADDRESS` is unset, because `refreshFee` returns before
      // the round trip.
      if (a.mode === "live" && a.fee.state === "unapproved") await refreshFee(a, info);

      // Agent expiry is a first-class event, tracked continuously rather than only at
      // connect: an approval that lapses mid-position leaves us able to read state but
      // not to close. Hourly, because it is a network call per live account.
      if (a.mode === "live" && Date.now() - st.lastExpiryCheckMs >= EXPIRY_CHECK_MS) {
        st.lastExpiryCheckMs = Date.now();
        // The builder approval rides on the same pass in the other direction — this is
        // the one that catches a **revocation**, which the per-loop check above cannot
        // see because it only runs while the state is already `unapproved`. Same cost
        // of one info call per live account, and no round trip while the rail is off.
        // Separate from the expiry try/catch below because a fee we cannot read must
        // never be able to stop us reading the approval that decides whether we can
        // close a position.
        await refreshFee(a, info);
        try {
          const agents = await info.extraAgents({ user: a.master });
          const mine = agents.find((x) => x.address.toLowerCase() === a.agent?.address);
          // Write the venue's answer back onto the account, because the governor reads
          // it every tick to refuse signals that would outlive the approval. Frozen at
          // connect it would be wrong in both directions: a user who re-approves would
          // stay blocked until a restart, and one whose approval was removed would keep
          // opening positions against an expiry that no longer exists.
          if (a.agent) a.agent.validUntil = mine?.validUntil ?? null;
          const e = expiryStatus(mine?.validUntil ?? null, Date.now());
          await edgeAlert(
            `agent-expiry:${a.master}`, e.firing,
            `${a.master}: ${e.message}`,
            `${a.master}: the agent approval is healthy again (${e.daysLeft?.toFixed(0) ?? "?"} days left).`,
          );
        } catch (e) {
          prefixed(`agent expiry check failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Summarise the price path of trades that have closed, before the candles age out
    // of reach (`tasks/31` §5). Once per loop rather than per account: the backlog is a
    // property of the ledger, not of who traded. Bounded and paced on purpose — the
    // unpaced version of this, one fetch per closed trade, is what killed four of five
    // `stop-sweep` runs, and it must not be able to do that to the executor.
    if (Date.now() - lastCounterfactualMs >= RISK_PARAMS.counterfactualSec * 1000) {
      lastCounterfactualMs = Date.now();
      try {
        const cf = await ingestCounterfactuals({
          store, now: new Date(), log,
          candles: (coin, interval, startTime, endTime) =>
            info.candleSnapshot({ coin, interval, startTime, endTime }) as unknown as Promise<Candle[]>,
        });
        if (cf.done || cf.failed) {
          log(`summarised ${cf.done} closed trade path(s)` +
            (cf.empty ? `, ${cf.empty} with no candles left` : "") +
            (cf.failed ? `, ${cf.failed} failed` : "") +
            (cf.remaining ? `, ${cf.remaining} still to do` : ""));
        }
      } catch (e) {
        // Same rule as the fill ingest: this is bookkeeping about trades that are over.
        log(`counterfactual pass failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Retention, once a day. There was none anywhere in `src/` before 2026-09-02 —
    // no DELETE, no prune, no vacuum — in the file the public web tier reads on every
    // request. `tasks/10` asked for a decision either way rather than a second
    // silence; this is it.
    if (Date.now() - lastPruneMs >= PRUNE_CHECK_MS) {
      lastPruneMs = Date.now();
      const cutoff = new Date(Date.now() - SKIP_RETENTION_DAYS * 86_400_000).toISOString();
      const dropped = store.pruneSkips(cutoff);
      if (dropped > 0) log(`pruned ${dropped} skip decision(s) last seen before ${cutoff.slice(0, 10)}`);
    }

    writeHeartbeat(hbPath, {
      loops,
      day: dayKey(),
      signalSource: snapshot?.source ?? null,
      feedAgeSec: Math.round(feedAgeSec),
      // **N halts in M minutes** (`DESK_WATCH`, `tasks/47` §0). Counted here rather than
      // in the watchdog because the ledger is this process's, and because a rolling window
      // read on the watchdog's own timer would miss a burst that opened and closed between
      // two of its runs — which is exactly the shape of the event: three accounts halted
      // within six minutes on 2026-09-10.
      //
      // Distinct accounts, not rows: one account halting, being cleared and halting again
      // is a different story and has its own alert.
      recentHalts: haltsInWindow(store, DESK_WATCH.haltWindowMin, Date.now()),
      haltWindowMin: DESK_WATCH.haltWindowMin,
      // The speed limit's halt is desk-wide and is not on any account row, so it reaches
      // the watchdog here or nowhere (`tasks/50` §2.1). The operator's own halt file is
      // deliberately not passed: they put it there.
      ...aggregateAccounts(beats, speedHalt),
    });

    for (let i = 0; i < RISK_PARAMS.loopIntervalSec && !stopping; i++) await sleep(1000);
  }

  // Shutdown is per-account too: one account's cancel failing must not leave the
  // others' exposure-opening orders resting.
  for (const st of states) {
    try {
      await cancelOurRestingOrders({
        broker: st.managed.broker, universe, store, master: st.managed.master,
        log: states.length > 1 ? (m: string) => log(`${st.managed.master} ${m}`) : log,
      });
    } catch (e) {
      log(`${st.managed.master} shutdown cancel failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  store.close();
  log("stopped cleanly");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  console.error("[exec] fatal:", e);
  process.exit(1);
});
