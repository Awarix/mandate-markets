import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Agent keys, encrypted at rest — `tasks/04`, Phase 4.
//
// **One agent key per HL account.** Hyperliquid tracks nonces per *signer*, so
// sharing one key across accounts causes dropped orders. That is a correctness
// requirement, not a security preference, and it is why `hl/clients.ts` builds a
// client per account rather than a module singleton.
//
// An agent key cannot withdraw — that is the product's whole guarantee
// (`docs/ACCOUNT-MODEL.md` §1). But it *can* trade the account, so a leaked one can
// lose the money without ever moving it. Encrypted at rest, and never in a `.env` or
// a systemd unit, is the standard `tasks/04` sets.
//
// `node:crypto` rather than a dependency, for the same reason the ledger is
// `node:sqlite`: scrypt and AES-256-GCM are in the platform, and a key-handling
// library we have not audited is a worse trade than the sixty lines below.

/** scrypt at N=16384 costs ~16MB and ~50ms per entry — unnoticeable for a handful of
 *  accounts at startup, and expensive enough to matter against an offline guesser. */
const KDF = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;

/** Self-contained: each entry carries its own salt and IV, so entries can be added
 *  and removed without touching the others' ciphertext. */
export type SealedKey = { saltB64: string; ivB64: string; tagB64: string; ctB64: string };
export type Keystore = { version: 1; entries: Record<string, SealedKey> };

export const EMPTY_KEYSTORE: Keystore = { version: 1, entries: {} };

export function sealKey(passphrase: string, plaintext: string): SealedKey {
  if (passphrase.length === 0) throw new Error("keystore: refusing to seal with an empty passphrase");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, KEY_LEN, KDF);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return {
    saltB64: salt.toString("base64"),
    ivB64: iv.toString("base64"),
    tagB64: c.getAuthTag().toString("base64"),
    ctB64: ct.toString("base64"),
  };
}

/** Throws on a wrong passphrase *or* a modified file — GCM does not distinguish, and
 *  neither should we: both mean this key cannot be trusted to sign an order. */
export function openKey(passphrase: string, s: SealedKey): string {
  const key = scryptSync(passphrase, Buffer.from(s.saltB64, "base64"), KEY_LEN, KDF);
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(s.ivB64, "base64"));
  d.setAuthTag(Buffer.from(s.tagB64, "base64"));
  try {
    return Buffer.concat([d.update(Buffer.from(s.ctB64, "base64")), d.final()]).toString("utf8");
  } catch {
    throw new Error(
      "keystore: wrong passphrase, or the entry has been modified since it was written " +
      "(AES-GCM tag mismatch — the two are indistinguishable by design).",
    );
  }
}

const norm = (account: string) => account.toLowerCase();

export function loadKeystore(path: string): Keystore {
  if (!existsSync(path)) return { ...EMPTY_KEYSTORE, entries: {} };
  const ks = JSON.parse(readFileSync(path, "utf8")) as Keystore;
  if (ks.version !== 1) throw new Error(`keystore: unsupported version ${ks.version} in ${path}`);
  return ks;
}

export function saveKeystore(path: string, ks: Keystore): void {
  mkdirSync(dirname(path), { recursive: true });
  // 0600: the passphrase is the real protection, but a keystore world-readable by
  // every process on the box is an offline attack anyone can start.
  writeFileSync(path, JSON.stringify(ks, null, 2), { mode: 0o600 });
}

export function putKey(ks: Keystore, account: string, agentPrivateKey: string, passphrase: string): Keystore {
  return { ...ks, entries: { ...ks.entries, [norm(account)]: sealKey(passphrase, agentPrivateKey.trim()) } };
}

export function removeKey(ks: Keystore, account: string): Keystore {
  const entries = { ...ks.entries };
  delete entries[norm(account)];
  return { ...ks, entries };
}

export function hasKey(ks: Keystore, account: string): boolean {
  return norm(account) in ks.entries;
}

export function getKey(ks: Keystore, account: string, passphrase: string): string | null {
  const e = ks.entries[norm(account)];
  return e === undefined ? null : openKey(passphrase, e);
}

export function listAccountsInKeystore(ks: Keystore): string[] {
  return Object.keys(ks.entries).sort();
}

export function keystorePath(dataRoot = process.env.DATA_ROOT ?? "data"): string {
  return process.env.SIGNALDESK_KEYSTORE ?? join(dataRoot, "keystore.json");
}

/** Where the passphrase may come from — deliberately **not** a plain environment
 *  variable, because `tasks/04` rules out `.env` and a unit file, and an env var is
 *  reachable from both plus `/proc/<pid>/environ`.
 *
 *  systemd's `LoadCredential=` is the intended path: it drops the secret in a
 *  root-only tmpfs directory named by `$CREDENTIALS_DIRECTORY`, so the unit file
 *  holds a *path*, never the secret. The file fallback is for the dev Mac; point it
 *  somewhere outside the repository. */
export function keystorePassphrase(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromCreds = env.CREDENTIALS_DIRECTORY ? join(env.CREDENTIALS_DIRECTORY, "keystore-passphrase") : null;
  for (const p of [fromCreds, env.SIGNALDESK_KEYSTORE_PASSPHRASE_FILE ?? null]) {
    if (p !== null && existsSync(p)) {
      const s = readFileSync(p, "utf8").trim();
      if (s.length > 0) return s;
    }
  }
  return null;
}
