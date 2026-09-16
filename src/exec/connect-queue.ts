import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { DEFAULT_USER_SETTINGS, type UserSettings } from "../risk/params.ts";
import { accountKey, type Store } from "../store/db.ts";
import { getKey, hasKey, type Keystore, putKey, saveKeystore } from "../keys/keystore.ts";
import { liveAllowlist } from "./mode.ts";
import { admissionState } from "./queue.ts";
import { isValidReferralCode } from "../hl/referral.ts";
import { validate } from "./settings.ts";

// The executor's half of the connect flow.
//
// **The agent keypair is generated here, in the executor, and never anywhere else.**
// The web tier is the process exposed to the internet; it holds no keys and needs no
// keystore passphrase, so compromising it cannot yield a signing key for anybody's
// account. It can only write a row saying "this address would like to connect", in
// its own database, which this reads read-only.
//
// It also means no private key ever crosses the network. The design this replaces
// asked the user to paste an API wallet key into a web form — which works, and puts
// a signing secret in a browser field, in a request body, and in whatever logs sit
// between. Here the secret is born on the machine that will use it and never leaves.
// What the user approves on Hyperliquid is a public address.

export type PendingRequest = {
  address: string;
  settings: UserSettings;
  /** The Hyperliquid referral code this person asked for, or null if they skipped
   *  (`tasks/37` §7.5). Carried to the ledger so `connectAccount` — the one moment the
   *  agent exists and the account is funded — can sign it. */
  referralCode: string | null;
};

/** **Whichever request is newer wins**, per address.
 *
 *  Neither request row expires, and the executor opens this database read-only, so
 *  nothing on this side can retire either one. Without a precedence rule an address
 *  that has ever connected *and* ever unlinked satisfies both queries forever, and the
 *  two loops then fight over it once a minute: `serviceConnectRequests` re-arms the
 *  connections row, `releaseUnlinked` sees a row that is no longer "disconnected" and
 *  releases it again, round and round. That was live on 2026-08-31 — three release/
 *  re-arm pairs in three minutes, one per loop, writing a transaction and an event each
 *  time, for an account whose owner had asked exactly once to be let go.
 *
 *  Comparing timestamps rather than deleting the loser's row is deliberate: it is
 *  self-healing. An account already stuck in the fight leaves it on the next loop with
 *  no repair step, and no write to a database this process is not allowed to write to.
 *  `>=` favours the unlink on an exact tie, because letting go is the safer way to
 *  resolve a tie we cannot otherwise order. */
const SUPERSEDED = {
  connect:
    "SELECT c.address AS address, c.settings AS settings, c.referral_code AS referral_code " +
    "FROM connection_requests c " +
    "LEFT JOIN unlink_requests u ON u.address = c.address " +
    "WHERE u.address IS NULL OR u.requested_at < c.requested_at " +
    "ORDER BY c.requested_at",
  unlink:
    "SELECT u.address AS address FROM unlink_requests u " +
    "LEFT JOIN connection_requests c ON c.address = u.address " +
    "WHERE c.address IS NULL OR u.requested_at >= c.requested_at " +
    "ORDER BY u.requested_at",
} as const;

/** Both queries join both tables, so both must exist before either runs. A web tier
 *  deployed before unlink existed has only `connection_requests`, and the executor is
 *  routinely newer than it — the two deploy separately. Returning nothing is the right
 *  answer there: no unlink can have been requested by a build that cannot request one. */
function hasBothTables(db: DatabaseSync): boolean {
  return (db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' " +
    "AND name IN ('connection_requests', 'unlink_requests')",
  ).get() as { n: number }).n === 2;
}

/** Read what the web tier has been asked for. Read-only: this process must not be
 *  able to invent a request on the user's behalf any more than the web tier can
 *  grant itself a connection. */
export function readConnectRequests(path: string): PendingRequest[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasBothTables(db)) return [];
    const rows = db.prepare(SUPERSEDED.connect).all() as
      { address: string; settings: string; referral_code: string | null }[];
    return rows.flatMap((r) => {
      try {
        const parsed = JSON.parse(r.settings) as Partial<UserSettings>;
        // Checked here as well as at the door it came through. The web tier validates
        // what it writes, but this process must not sign a string on the strength of
        // another process having promised it was safe — the same rule the keystore and
        // the allowlist are built on.
        const code = r.referral_code !== null && isValidReferralCode(r.referral_code) ? r.referral_code : null;
        return [{
          address: accountKey(r.address),
          settings: validate({ ...DEFAULT_USER_SETTINGS, ...parsed }),
          referralCode: code,
        }];
      } catch {
        // A request we cannot read is not a reason to stop servicing the others.
        return [];
      }
    });
  } finally {
    db.close();
  }
}

/** Addresses that have asked to be let go. Read-only, for the same reason
 *  `readConnectRequests` is: the web tier must not be able to invent one of these on a
 *  user's behalf, and this process must not be able to grant itself a connection. */
export function readUnlinkRequests(path: string): string[] {
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (!hasBothTables(db)) return [];
    return (db.prepare(SUPERSEDED.unlink).all() as { address: string }[])
      .map((r) => accountKey(r.address));
  } finally {
    db.close();
  }
}

/** Mint and seal an agent key for every request that does not have one yet, and
 *  record the agent address for the user to approve.
 *
 *  Idempotent: an account that already has a keystore entry keeps it. Minting a
 *  second key for the same account would be actively harmful — Hyperliquid tracks
 *  nonces per signer, and the old key would still be approved and still signing.
 *
 *  Returns the keystore, which `putKey` rebuilds rather than mutating, so the caller
 *  must take the value back. */
export function serviceConnectRequests(deps: {
  store: Store;
  keystore: Keystore;
  passphrase: string | null;
  keystoreFile: string;
  requestsDb: string;
  log: (m: string) => void;
  env?: NodeJS.ProcessEnv;
  now?: number;
}): Keystore {
  let keystore = deps.keystore;
  const requests = readConnectRequests(deps.requestsDb);
  if (requests.length === 0) return keystore;
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const allowlisted = liveAllowlist(env);

  for (const req of requests) {
    const existing = deps.store.connection(req.address);

    // Settings may change while the user is still deciding; once the executor
    // connects the account they are frozen into its row and this stops mattering.
    if (existing?.status === "active") continue;

    // The access queue (`tasks/17`). The web tier refuses to record a request from an
    // address that has not been admitted, and this is the same check on the granting
    // side — the process that actually mints the key. Two gates rather than one
    // because they answer to different failures: the web's is the screen a person
    // reads, and this one is what makes a written row insufficient. A key minted for
    // somebody who cannot connect is a key we hold for no reason, and an
    // "approve this agent" screen that leads nowhere.
    const gate = admissionState({
      pinned: allowlisted.includes(req.address),
      hasAccountRow: deps.store.account(req.address) !== null,
      connectionStatus: existing?.status ?? null,
      admissionExpiresAt: deps.store.admission(req.address)?.expires_at ?? null,
      now,
    });
    if (!gate.admitted) continue;

    // We already hold a key for this address. The key is never re-minted — Hyperliquid
    // tracks nonces per signer and the old agent is still approved — but the *row* is
    // still written, every time, and both reasons are load-bearing:
    //
    //   1. An account that was unlinked has status "disconnected", which
    //      `connectableAccounts()` deliberately excludes. Leaving it there means the
    //      runner never looks at the address again, so pressing Connect does nothing,
    //      forever. Unlink was a one-way door until this line.
    //   2. The settings in the row are the ones the executor freezes at connect. This
    //      branch used to skip the write, so changing your limits before approving the
    //      agent silently kept the old ones — which the comment above claims it does
    //      not do.
    //
    // Both were found on 2026-08-31, the second only because the first was.
    if (hasKey(keystore, req.address)) {
      let agentAddress = existing?.agent_address ?? null;
      if (agentAddress === null) {
        if (deps.passphrase === null) continue;      // cannot derive the address to show
        const key = getKey(keystore, req.address, deps.passphrase);
        if (key === null) continue;
        agentAddress = privateKeyToAccount(key as `0x${string}`).address;
      }
      const returning = existing !== null && existing.status !== "awaiting_approval";
      deps.store.upsertConnection({
        account: req.address,
        status: "awaiting_approval",
        agentAddress,
        settings: req.settings,
        referralCode: req.referralCode,
      });
      if (returning) {
        // Deliberately does NOT claim the agent is still approved. It said that until
        // 2026-09-01, and it is false in the one case that matters: an account coming
        // back *because* its approval lapsed would be told there was nothing to do.
        // `connectAccount` re-reads `extraAgents` and holds the account at
        // `awaiting_approval` until the address is genuinely there, so the screen is
        // right either way — but the log is what an operator reads first.
        //
        // The 2026-09-01 wording replaced one wrong belief with another. It said
        // Hyperliquid prunes an API wallet when its approval expires, and it does not —
        // or not promptly: a lapsed entry was still listed **40 minutes after** expiry
        // on 2026-09-02. That stale row is exactly what makes a re-approval fail, so
        // the remedy is remove-then-approve, not approve-again.
        deps.log(
          `${req.address} asked to connect again (was ${existing!.status}); reusing agent ` +
          `${agentAddress} — the key is unchanged, and the same address can be approved ` +
          "again. Remove the existing entry on Hyperliquid first: it refuses a " +
          "re-approval of an address it still holds with \"Extra agent already used.\" " +
          "(verified 2026-09-02, notes/2026-09-02-agent-approval-verification.md)",
        );
      }
      continue;
    }

    if (deps.passphrase === null) {
      deps.store.upsertConnection({
        account: req.address,
        status: "awaiting_approval",
        agentAddress: null,
        settings: req.settings,
        referralCode: req.referralCode,
        lastError: "We cannot create your agent key right now. This is our problem, not " +
          "yours — the operator has been told.",
      });
      deps.log(
        `ALERT ${req.address} asked to connect but no keystore passphrase is available, so no ` +
        "agent key can be sealed. systemd should pass one with " +
        "LoadCredential=keystore-passphrase:<file>.",
      );
      continue;
    }

    // Born here, sealed immediately, never logged and never returned to anyone. The
    // only thing that leaves this function is the public address derived from it.
    const priv = generatePrivateKey();
    const agent = privateKeyToAccount(priv).address;
    keystore = putKey(keystore, req.address, priv, deps.passphrase);
    saveKeystore(deps.keystoreFile, keystore);

    deps.store.upsertConnection({
      account: req.address,
      status: "awaiting_approval",
      agentAddress: agent,
      settings: req.settings,
      referralCode: req.referralCode,
      lastError: null,
    });
    deps.log(`${req.address} agent key sealed; awaiting approval of ${agent} on Hyperliquid`);
  }

  return keystore;
}
