import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getKey, hasKey, keystorePassphrase, listAccountsInKeystore, loadKeystore,
  openKey, putKey, removeKey, saveKeystore, sealKey, EMPTY_KEYSTORE,
} from "./keystore.ts";

// A real agent key shape: 0x + 64 hex. Never a live one.
const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PASS = "correct horse battery staple";
const ACCT = "0xacc00001C53162712f3d8D10764B5E7b17D1C08A";

const tmp = () => mkdtempSync(join(tmpdir(), "signaldesk-keys-"));

test("a sealed key comes back exactly, and nothing plaintext is left in the record", () => {
  const sealed = sealKey(PASS, KEY);
  assert.equal(openKey(PASS, sealed), KEY);
  assert.ok(!JSON.stringify(sealed).includes(KEY.slice(2, 20)), "ciphertext must not contain the key");
});

test("two seals of the same key differ — salt and IV are per entry", () => {
  const a = sealKey(PASS, KEY);
  const b = sealKey(PASS, KEY);
  assert.notEqual(a.ctB64, b.ctB64);
  assert.notEqual(a.saltB64, b.saltB64);
  assert.notEqual(a.ivB64, b.ivB64);
});

test("the wrong passphrase fails closed rather than returning garbage", () => {
  const sealed = sealKey(PASS, KEY);
  assert.throws(() => openKey("not the passphrase", sealed), /wrong passphrase/);
});

// A key that has been altered on disk must never sign an order, and GCM is what
// makes that detectable at all.
test("a tampered ciphertext is refused, not silently decrypted", () => {
  const sealed = sealKey(PASS, KEY);
  const buf = Buffer.from(sealed.ctB64, "base64");
  buf[0] = buf[0]! ^ 0xff;
  assert.throws(() => openKey(PASS, { ...sealed, ctB64: buf.toString("base64") }), /modified|wrong passphrase/);
});

test("an empty passphrase is refused at seal time", () => {
  assert.throws(() => sealKey("", KEY), /empty passphrase/);
});

test("accounts are keyed case-insensitively — an address is not two accounts", () => {
  const ks = putKey({ ...EMPTY_KEYSTORE, entries: {} }, ACCT, KEY, PASS);
  assert.ok(hasKey(ks, ACCT.toLowerCase()));
  assert.ok(hasKey(ks, ACCT.toUpperCase().replace("0X", "0x")));
  assert.equal(getKey(ks, ACCT.toLowerCase(), PASS), KEY);
  assert.equal(listAccountsInKeystore(ks).length, 1);
});

test("removing one entry leaves the others readable", () => {
  const other = "0x1111111111111111111111111111111111111111";
  let ks = putKey({ ...EMPTY_KEYSTORE, entries: {} }, ACCT, KEY, PASS);
  ks = putKey(ks, other, KEY, PASS);
  ks = removeKey(ks, ACCT);
  assert.equal(hasKey(ks, ACCT), false);
  assert.equal(getKey(ks, other, PASS), KEY);
});

test("getKey on an unknown account is null, not a throw", () => {
  assert.equal(getKey({ ...EMPTY_KEYSTORE, entries: {} }, ACCT, PASS), null);
});

test("a keystore round-trips through disk and is written 0600", () => {
  const dir = tmp();
  try {
    const path = join(dir, "keystore.json");
    saveKeystore(path, putKey({ ...EMPTY_KEYSTORE, entries: {} }, ACCT, KEY, PASS));
    assert.equal(statSync(path).mode & 0o777, 0o600, "a world-readable keystore is an offline attack anyone can start");
    assert.equal(getKey(loadKeystore(path), ACCT, PASS), KEY);
    assert.ok(!readFileSync(path, "utf8").includes(KEY), "the key must not be on disk in the clear");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a missing keystore file reads as empty rather than throwing", () => {
  assert.deepEqual(loadKeystore(join(tmpdir(), "signaldesk-does-not-exist.json")).entries, {});
});

test("an unknown keystore version is refused", () => {
  const dir = tmp();
  try {
    const path = join(dir, "ks.json");
    writeFileSync(path, JSON.stringify({ version: 2, entries: {} }));
    assert.throws(() => loadKeystore(path), /unsupported version/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// tasks/04 rules out .env and unit files, so a plain env var is not an accepted
// source — it is readable from both, plus /proc/<pid>/environ.
test("the passphrase comes from a credential file, never from a bare env var", () => {
  const dir = tmp();
  try {
    const f = join(dir, "pass");
    writeFileSync(f, `${PASS}\n`);
    assert.equal(keystorePassphrase({ SIGNALDESK_KEYSTORE_PASSPHRASE_FILE: f } as NodeJS.ProcessEnv), PASS);
    assert.equal(keystorePassphrase({ SIGNALDESK_KEYSTORE_PASSPHRASE: PASS } as NodeJS.ProcessEnv), null);
    assert.equal(keystorePassphrase({ CREDENTIALS_DIRECTORY: dir } as NodeJS.ProcessEnv), null, "wrong filename in the credentials dir");
    writeFileSync(join(dir, "keystore-passphrase"), PASS);
    assert.equal(keystorePassphrase({ CREDENTIALS_DIRECTORY: dir } as NodeJS.ProcessEnv), PASS);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
