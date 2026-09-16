import { join } from "node:path";
import type { ExchangeClient, InfoClient } from "@nktkas/hyperliquid";
import type { Broker } from "../broker.ts";
import { ensureTradeable } from "../hl/abstraction.ts";
import { LiveBroker } from "../hl/broker.ts";
import { builderFor, builderRail, feeIsRequired, feeStatus, type FeeStatus } from "../hl/approve-builder-fee.ts";
import { agentAddress, makeExchangeClient } from "../hl/clients.ts";
import { applyReferral } from "../hl/referral.ts";
import { checkCollateral } from "../hl/state.ts";
import type { Universe } from "../hl/universe.ts";
import { getKey, hasKey, keystorePassphrase, loadKeystore, type Keystore } from "../keys/keystore.ts";
import { expiryStatus } from "../risk/expiry.ts";
import { checkCapConsistency } from "../risk/halt.ts";
import { minFundedForLiveUsd, type UserSettings } from "../risk/params.ts";
import type { Store } from "../store/db.ts";
import { resolveMode } from "./mode.ts";
import { PaperBroker } from "./paper.ts";
import { loadSettings, ourAccounts } from "./settings.ts";

// Phase 4 — which accounts we manage, whose key signs for each, and the connect-time
// checks every one of them has to pass. `runner.ts` is process wiring on top of this.
//
// The ledger was already per-account (every table keyed by `account`) and `tick()`
// already takes one `master` and is a pure function of its inputs. So multi-account
// is not a rewrite: it is this file, plus a runner that loops.

export type AgentInfo = { name: string; address: string; validUntil: number | null };

/** The account cannot be connected **yet**, for a reason the person who owns it can
 *  fix: it is not funded, it holds more than the funding limit, its agent is not
 *  approved, or every live slot is taken.
 *
 *  Distinct from an ordinary throw because nobody needs waking. The runner logs it
 *  once, records `message` where the connect screen reads it, and retries next loop —
 *  no ALERT, no page. What it must never do is fall back to a simulated book: an
 *  unfunded account that gets a $1,000 paper balance has been told it is connected
 *  when it is not, and its frozen `baseCapital` then blocks the live connection it
 *  asked for. */
export class ConnectPending extends Error {
  readonly pending = true;
  constructor(message: string) {
    super(message);
    this.name = "ConnectPending";
  }
}

/** True for the errors above, wherever they are caught. */
export function isPending(e: unknown): boolean {
  return e instanceof ConnectPending || (typeof e === "object" && e !== null && "pending" in e);
}

export type ManagedAccount = {
  master: `0x${string}`;
  mode: "live" | "paper";
  why: string;
  /** Frozen into each position at open; replaced here between positions when the
   *  owner asks (`src/exec/change-queue.ts`). Nothing in flight reads it. */
  settings: UserSettings;
  settingsSource: string;
  /** Frozen at connect and under every open position. Re-read from the venue only at
   *  the owner's request and only when nothing is open (`tasks/18` §4). */
  baseCapital: number;
  broker: Broker;
  keySource: string;
  agent: AgentInfo | null;
  /** What this account is being charged, read from the venue at connect. `tasks/14`
   *  §2.4: a fee somebody consented to and cannot see is the worst version of this,
   *  so it is carried here for the desk rather than derived where it is displayed. */
  fee: FeeStatus;
  /** Whether we were already trading this account live when this connect ran — read
   *  before the `accounts` row is rewritten, which is the only moment the answer is
   *  still available. Carried so `warnIfOverCap` can say *why* each account is above
   *  the cap without re-reading a row its own success has since overwritten
   *  (`tasks/34`). */
  incumbent: boolean;
};

/** Which accounts this process manages.
 *
 *  `HL_MASTER_ADDRESS` still wins when it is set, and that is deliberate rather than
 *  legacy clutter: it is what the live Phase 2 deploy runs on, and a refactor that
 *  silently widens a running live process from one account to several is exactly the
 *  kind of change that should never be a side effect. Unset it to manage every
 *  account with a settings file. */
export function listAccounts(env: NodeJS.ProcessEnv = process.env, dir = "accounts"): string[] {
  const pinned = (env.HL_MASTER_ADDRESS ?? "").trim();
  if (pinned) return [pinned.toLowerCase()];
  return ourAccounts(dir);
}

/** Every address this process should manage: the ones with a settings file, plus the
 *  ones that asked to connect through the web. `HL_MASTER_ADDRESS` still wins outright
 *  when it is set, for the same reason as before — widening a funded process from one
 *  account to several must never be a side effect of some other change. */
export function managedAddresses(store: Store | null, env: NodeJS.ProcessEnv = process.env, dir = "accounts"): string[] {
  const pinned = (env.HL_MASTER_ADDRESS ?? "").trim();
  if (pinned) return [pinned.toLowerCase()];
  const fromFiles = listAccounts(env, dir);
  const fromDb = store ? store.connectableAccounts() : [];
  return [...new Set([...fromFiles, ...fromDb])].sort();
}

export type KeyResolution = { key: string; source: string };

/** The signing key for one account: keystore first, `.env` only for the single
 *  account it names.
 *
 *  The `.env` path is kept because the live account is running on it right now, and
 *  breaking a funded deploy to satisfy a file layout is the wrong order. It is not
 *  the destination: `tasks/04` rules out `.env`, and `npm run keys add` moves an
 *  account over without downtime. */
export function resolveAgentKey(
  master: string,
  ks: Keystore,
  passphrase: string | null,
  env: NodeJS.ProcessEnv = process.env,
): KeyResolution {
  if (hasKey(ks, master)) {
    if (passphrase === null) {
      throw new Error(
        `${master} has a keystore entry but no passphrase is available. systemd should pass ` +
        "one with LoadCredential=keystore-passphrase:<file>; locally, set " +
        "SIGNALDESK_KEYSTORE_PASSPHRASE_FILE to a file outside the repo.",
      );
    }
    const key = getKey(ks, master, passphrase);
    if (key === null) throw new Error(`${master}: keystore entry vanished mid-read`);
    return { key, source: "keystore" };
  }

  const envMaster = (env.HL_MASTER_ADDRESS ?? "").toLowerCase();
  const envKey = env.HL_AGENT_PRIVATE_KEY ?? "";
  if (envKey && envMaster === master.toLowerCase()) {
    return { key: envKey, source: ".env (legacy single-account path — migrate with `npm run keys add`)" };
  }

  throw new Error(
    `no agent key for ${master}. Add one with:  npm run keys -- add ${master}\n` +
    "(one key per account — HL tracks nonces per signer, so a key shared between " +
    "accounts drops orders.)",
  );
}

export type ConnectDeps = {
  info: InfoClient;
  universe: Universe;
  store: Store;
  marks: () => Map<string, number>;
  log: (msg: string) => void;
  keystore: Keystore;
  passphrase: string | null;
  env?: NodeJS.ProcessEnv;
  /** How many accounts are already live — all of them, ours included since
   *  `tasks/17`. The aggregate cap is checked against this before arming, so it has to
   *  come from the caller: one account cannot see the others. Allowlisted accounts are
   *  counted here and exempt from the refusal, not the other way round
   *  (`canBeRefusedForSlot`). */
  liveSlotsUsed?: number;
  /** Test seam. Live, the exchange client is built from the account's own agent key
   *  and nothing else; a unit test needs one that neither signs nor reaches the venue. */
  exchangeFor?: (agentKey: string) => ExchangeClient;
};

/** Every connect-time check for one account, in the order that fails most usefully.
 *  Throws rather than degrading: an account we cannot fully verify is one we do not
 *  trade. The caller decides whether that kills the process or just skips the
 *  account — with several accounts it must be the latter. */
export async function connectAccount(masterRaw: string, d: ConnectDeps): Promise<ManagedAccount> {
  const env = d.env ?? process.env;
  const master = masterRaw as `0x${string}`;

  const conn = d.store.connection(master);
  let chosen: Partial<UserSettings> | null = null;
  if (conn) {
    try { chosen = JSON.parse(conn.settings) as Partial<UserSettings>; } catch { chosen = null; }
  }
  const { settings, source: settingsSource } = loadSettings(master, "accounts", chosen);
  for (const w of checkCapConsistency(settings)) d.log(`${master} CONFIG WARNING: ${w}`);

  // The smallest base capital that can produce a legal order, for *these* settings.
  // This is the only funding threshold left: the per-account ceiling that used to cap
  // the other end was removed on 2026-08-31 (see `LIVE_MANDATE`), so an account is
  // traded at whatever it holds, provided one signal of it clears HL's minimum.
  const collateral = await checkCollateral(d.info, master, minFundedForLiveUsd(settings));
  d.log(`${master} collateral: ${collateral.message} [abstraction=${collateral.abstraction}]`);

  // Were we already trading this account live? The `accounts` row's own mode answers
  // it, and it is the right source precisely because nothing on the refusal path
  // rewrites it: `blocked` throws below *before* `store.connectAccount`, so a restart
  // that refuses an account leaves the row saying what it last armed as. The
  // `connections` status cannot do this job — the runner downgrades it to
  // `awaiting_approval` on every pending connect, so one bad restart would erase the
  // incumbency that should have prevented it.
  //
  // Exempts the account from the slot refusal and from nothing else (`tasks/34`).
  const incumbent = d.store.account(master)?.mode === "live";

  const { mode, why, baseCapitalUsd, blocked } = resolveMode(
    master, collateral.usableUsd, env, d.liveSlotsUsed ?? 0, settings.mode, incumbent,
  );

  // Live was asked for and refused. Leave the account **pending** rather than writing
  // a paper row: no ledger row means nothing is frozen, so funding the account later
  // simply works, and the connect screen keeps showing the agent address and the
  // reason instead of a balance that is not theirs.
  if (blocked) throw new ConnectPending(why);

  let baseCapital = Number(env.SIGNALDESK_BASE_CAPITAL ?? 0);
  let agent: AgentInfo | null = null;
  let keySource = "none (paper)";
  let agentKey = "";
  // Built once for the account and used twice: to put it into unified margin below, and
  // to sign its orders afterwards. One client per account because HL tracks nonces per
  // signer (`src/hl/clients.ts`), so two clients on one key is the same hazard as one
  // key on two accounts.
  let exchange: ExchangeClient | null = null;

  // What this account is charged, if anything. Read from the venue beside the other
  // connect-time facts, because it **is** a venue fact: the approval is held by
  // Hyperliquid per (user, builder) pair and nothing we deploy can create one.
  //
  // Unset `HL_BUILDER_ADDRESS` — how this ships — and the whole block is one branch
  // and no round trip. `builderRail()` throws on a malformed address rather than
  // quietly trading without one, and that throw is deliberately *not* caught: it is a
  // configuration error on the box, identical for every account, and skipping accounts
  // one at a time would report it four times as four unrelated failures.
  const rail = builderRail(env);
  let approvedMax: number | null = null;
  // **Whether the read failed, which is not the same fact as what it returned.** Both
  // produce `approvedMax === null` and therefore `fee.state === "unapproved"`, and
  // collapsing them is what dropped a live account on 2026-09-11: six accounts took a
  // `429 Too Many Requests` on loop 1 of a cold start and `0xacc00008…` logged **WAS
  // LIVE AND IS NO LONGER MANAGED** for a reason that was false — it *had* approved the
  // fee. A rate limit and a refusal to sign were the same state to the gate below.
  let feeReadFailed = false;
  if (rail && mode === "live") {
    try {
      approvedMax = await d.info.maxBuilderFee({ user: master, builder: rail.b });
    } catch (e) {
      // Failing closed on the **charge**: the order goes out with no builder field and
      // fills. We are not paid for it, which is the cheap half of this trade — the
      // expensive half would be attaching a code the account may not have approved,
      // which HL rejects, which is the account not trading.
      feeReadFailed = true;
      d.log(`${master} could not read the builder approval, so no fee is charged this run: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const fee = feeStatus(rail, approvedMax);

  // The fee gate (`tasks/33`), and it is here rather than in the web tier because this
  // is the process that signs orders: the connect screen can ask for the signature, but
  // only a refusal to arm actually requires it, and "a POST does not read markup".
  //
  // **Pending, not paper.** Same reason `blocked` throws above: dropping to a simulated
  // book would tell somebody they are connected when they are not, freeze a
  // `baseCapital` that is not theirs, and block the live connection they wanted. The
  // connect screen already renders whatever reason lands here, beside every other one.
  //
  // Only for the new cohort, and only while the rail is on — `feeIsRequired` is false
  // for every account that connected before `BUILDER_FEE.requiredForConnectionsFrom`
  // and false for every account anywhere when `HL_BUILDER_ADDRESS` is unset, so this
  // branch does not exist on a box without the rail.
  //
  // **A read we could not make is not evidence of a missing signature**, so it does not
  // reach the refusal at all. That is the same posture `feeIsRequired` already states
  // one layer down for an unknown connection date — *"failing open costs a fee, failing
  // closed refuses to trade an account whose owner did everything right, and the second
  // is not a trade this project makes for revenue"* — applied to the read as well as to
  // the date. The cost of failing open here is one run's fee on one account, recovered
  // at the next connect, when the read succeeds and the gate binds normally.
  if (mode === "live" && feeIsRequired(rail, conn?.created_at) && fee.state !== "charging") {
    if (feeReadFailed) {
      d.log(
        `${master} NOTE the fee gate is not being applied this run: Hyperliquid did not answer ` +
        "the builder-approval read, which is our fault and not this account's. It arms with no " +
        "builder field and pays nothing; the gate binds again on the next connect.",
      );
    } else {
      throw new ConnectPending(
        `this account has not approved the desk's fee of ${fee.state === "off" ? "" : fee.percent + " "}` +
        "per order, which accounts connecting from 2026-09-11 approve before they arm. " +
        "It is one signature from the wallet that owns this account, on the connect screen. " +
        "Nothing is charged until an order fills, and Hyperliquid collects it — we never " +
        "move your money.",
      );
    }
  }

  if (mode === "live") {
    const resolved = resolveAgentKey(master, d.keystore, d.passphrase, env);
    agentKey = resolved.key;
    keySource = resolved.source;
    if (!collateral.ok) throw new ConnectPending(collateral.message);
    baseCapital = baseCapitalUsd ?? 0;

    const agents = await d.info.extraAgents({ user: master });
    const addr = agentAddress(agentKey).toLowerCase();
    // The master's own key is not an agent key, and the difference is the product.
    // An agent wallet is sign-only and *cannot* withdraw; the master key can move
    // every dollar in the account. Both would place orders happily, so nothing
    // downstream would notice — this has to be caught here, by name.
    if (addr === master.toLowerCase()) {
      throw new Error(
        `the key for ${master} holds the MASTER wallet, not an agent key. ` +
        "That key can withdraw funds, which breaks the one guarantee this product makes " +
        "(docs/ACCOUNT-MODEL.md §1: we can trade the account and can never move money out). " +
        "Refusing to run. Use the approved agent's key instead, and treat the master key as " +
        "exposed wherever it has been copied.",
      );
    }
    const approved = agents.find((a) => a.address.toLowerCase() === addr);
    if (!approved) {
      // Pending, not an alert: this is the step the user is standing on. The connect
      // screen is showing them this exact address to approve on Hyperliquid.
      throw new ConnectPending(
        `agent ${addr} is not approved on ${master} yet — approve it on Hyperliquid. ` +
        `Approved right now: ${agents.length === 0 ? "(none)" : agents.map((a) => `${a.name} ${a.address}`).join(", ")}`,
      );
    }
    agent = { name: approved.name, address: addr, validUntil: approved.validUntil ?? null };
    const e = expiryStatus(agent.validUntil, Date.now());
    d.log(`${master} agent "${agent.name}" approved, ${e.daysLeft === null ? "no expiry recorded" : `valid ${e.daysLeft.toFixed(0)} more days`}`);

    // The money has to be somewhere our orders can draw on, and until 2026-09-10
    // nothing checked. An account funded by the ordinary bridge holds its dollars in
    // the *core* perp wallet on a `default` abstraction, where the HIP-3 `xyz:` markets
    // we trade cannot reach them: five entries rejected `Insufficient margin` over 28
    // minutes on an account this function had already declared healthy.
    //
    // Here, and not earlier, because it is signed by the agent — which is approved one
    // line above — and not later, because `store.connectAccount` on the next line
    // freezes `baseCapital` against an account that must by then be tradeable.
    // `ensureTradeable` reads the mode back from the venue and probes every dex in
    // scope; a refusal is `pending` like the others, so funding, approving or fixing the
    // mode later simply works and nothing was written in the meantime.
    exchange = d.exchangeFor ? d.exchangeFor(agentKey) : makeExchangeClient(agentKey);
    const reachable = await ensureTradeable({
      info: d.info, exchange, master, abstraction: collateral.abstraction,
      probes: d.universe.probes(), log: d.log,
    });
    if (!reachable.ok) throw new ConnectPending(reachable.reason);

    // The referral code, if this person asked for one (`tasks/37` §7.5). Here because
    // this is the only moment both of its preconditions hold: the agent that signs it
    // was approved a few lines above, and Hyperliquid refuses `setReferrer` on an
    // address that has never deposited.
    //
    // **A failure is logged and nothing else.** A code that did not apply costs its
    // owner 4% of the venue's fee and costs us our share; an account that would not
    // trade because of it would be a far worse outcome than either, so this can never
    // be a `ConnectPending`. It is also idempotent by construction — `applyReferral`
    // re-reads the venue and leaves a spent slot alone — so a reconnect does not
    // re-ask, and the row staying set is not a second attempt at anything.
    const wanted = conn?.referral_code ?? null;
    if (wanted !== null) {
      const outcome = await applyReferral({
        info: d.info, exchange, master, code: wanted, log: d.log,
      });
      if (!outcome.ok) d.log(`${master} referral code not applied: ${outcome.why}`);
    }
  } else if (baseCapital <= 0) {
    baseCapital = 1000;
  }

  const row = d.store.connectAccount(master, baseCapital, settings, mode);
  // `connectAccount` returns an existing row untouched, so the column the desk and the
  // leaderboard read can be older than the settings this process is about to trade on —
  // an operator's file outranks the row and is re-read here at every connect. Correct it,
  // and say so: a number shown to other owners quietly disagreeing with the one in force
  // is worse than either value.
  const synced = d.store.syncAccountSettings(master, settings);
  if (synced) {
    d.log(
      `${master} the desk was showing stale limits and now shows what is in force: ` +
      `${row.settings} → ${synced.settings} (from ${settingsSource}). Nothing about the account changed.`,
    );
  }
  // The user's screen is waiting on this. Only reached once every connect-time check
  // above has passed, so "active" means genuinely tradeable, not merely requested.
  if (conn && conn.status !== "active") d.store.setConnectionStatus(master, "active", null);
  const frozen = row.base_capital;

  const broker: Broker = mode === "live"
    ? new LiveBroker(d.info, exchange!, master, d.universe, builderFor(rail, approvedMax))
    : new PaperBroker(d.store, d.marks, frozen, master);

  d.log(
    `${master} mode=${mode} — ${why}\n` +
    `        baseCapital=$${frozen.toFixed(2)} (frozen at ${row.connected_at}) key=${keySource}\n` +
    `        settings ${JSON.stringify(settings)} from ${settingsSource}\n` +
    `        per signal: $${(frozen * settings.perSignalPct).toFixed(2)} margin at ${settings.leverage}x; ` +
    `a stop-out costs ${(settings.stopPct * settings.leverage * 100).toFixed(0)}% of that ` +
    `($${(frozen * settings.perSignalPct * settings.stopPct * settings.leverage).toFixed(2)})`,
  );
  if (row.halted === 1) d.log(`${master} ACCOUNT IS HALTED: ${row.halt_reason}`);
  if (fee.state === "charging") {
    d.log(`${master} builder fee ${fee.percent} (f=${fee.tenthsBp}) — approved up to f=${fee.approvedMaxTenthsBp}`);
  } else if (fee.state === "unapproved") {
    d.log(`${master} no builder fee: this account has not approved one, so its orders carry no builder code`);
  }

  return { master, mode, why, settings, settingsSource, baseCapital: frozen, broker, keySource, agent, fee, incumbent };
}

/** Re-read what this account's owner has approved, and move both what the desk says
 *  and what the orders carry.
 *
 *  Called on the same hourly pass that re-checks the agent approval (`runner.ts`), and
 *  for the same reason its comment gives: frozen at connect this would be wrong in both
 *  directions. The two directions are not equally cheap, though. An owner who approves
 *  and is not noticed simply is not charged. An owner who **revokes** and is not
 *  noticed has every subsequent order rejected by Hyperliquid, because it carries a
 *  builder code they no longer permit — which is the account not trading, arriving one
 *  revocation at a time.
 *
 *  A read that fails changes nothing. A transient network error is not evidence that
 *  somebody's terms changed, and flipping a fee on or off on one is worse than being an
 *  hour late. */
export async function refreshFee(
  a: ManagedAccount,
  info: Pick<InfoClient, "maxBuilderFee">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (a.mode !== "live") return;
  const rail = builderRail(env);
  if (!rail) return;
  let approved: number;
  try {
    approved = await info.maxBuilderFee({ user: a.master, builder: rail.b });
  } catch {
    return;
  }
  a.fee = feeStatus(rail, approved);
  // The display and the orders move together or not at all: two writes from one read,
  // so the desk cannot describe a fee the orders are not carrying.
  if (a.broker instanceof LiveBroker) a.broker.setBuilder(builderFor(rail, approved));
}

/** Load the keystore once for the process. Missing file is not an error — the `.env`
 *  path still works, and a paper-only box needs no keys at all. */
export function openKeystore(path: string): { keystore: Keystore; passphrase: string | null } {
  return { keystore: loadKeystore(path), passphrase: keystorePassphrase() };
}

export const ACCOUNTS_DIR = "accounts";
export const keystoreFileFor = (dataRoot: string) => join(dataRoot, "keystore.json");
