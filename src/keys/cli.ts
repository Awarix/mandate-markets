import "dotenv/config";
import { agentAddress, assertPrivateKey } from "../hl/clients.ts";
import {
  hasKey, keystorePassphrase, keystorePath, listAccountsInKeystore,
  loadKeystore, putKey, removeKey, saveKeystore,
} from "./keystore.ts";

// npm run keys -- list
// npm run keys -- add <master-address>       (key is read from stdin, never argv)
// npm run keys -- remove <master-address>
//
// The key is read from **stdin** on purpose. An argument lands in shell history, in
// `ps` output for every user on the box, and in any journal that logs the command —
// three copies of a secret that was supposed to exist encrypted in one file.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { buf += d; });
    process.stdin.on("end", () => resolve(buf.trim()));
    process.stdin.on("error", reject);
  });
}

function requirePassphrase(): string {
  const p = keystorePassphrase();
  if (p === null) {
    throw new Error(
      "no keystore passphrase available. Set SIGNALDESK_KEYSTORE_PASSPHRASE_FILE to a file " +
      "outside the repository, or run under systemd with " +
      "LoadCredential=keystore-passphrase:/etc/signaldesk/keystore-passphrase.\n" +
      "It is deliberately not read from a plain environment variable: tasks/04 rules out " +
      "`.env` and unit files, and an env var is readable from both plus /proc/<pid>/environ.",
    );
  }
  return p;
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  const path = keystorePath(DATA_ROOT);

  if (cmd === "list") {
    const ks = loadKeystore(path);
    const accounts = listAccountsInKeystore(ks);
    console.log(`keystore: ${path}`);
    if (accounts.length === 0) {
      console.log("  (empty — accounts fall back to HL_AGENT_PRIVATE_KEY in .env)");
      return;
    }
    for (const a of accounts) console.log(`  ${a}`);
    console.log(`\n${accounts.length} key(s). Passphrase available: ${keystorePassphrase() !== null}`);
    return;
  }

  if (cmd === "add") {
    if (!arg || !/^0x[0-9a-fA-F]{40}$/.test(arg)) {
      throw new Error("usage: npm run keys -- add <master-address>   (0x + 40 hex)");
    }
    const master = arg.toLowerCase();
    const passphrase = requirePassphrase();
    if (process.stdin.isTTY) {
      console.error("Paste the agent private key on stdin, then Ctrl-D. It is never taken as an argument.");
    }
    const key = assertPrivateKey(await readStdin(), "the key on stdin");
    const derived = agentAddress(key).toLowerCase();

    // The same refusal `connectAccount` makes, made earlier: an agent wallet is
    // sign-only and cannot withdraw; the master key can move every dollar out. Both
    // place orders happily, so nothing downstream would notice the difference.
    if (derived === master) {
      throw new Error(
        `that key derives to ${derived}, which is the MASTER address itself — it can withdraw ` +
        "funds and breaks the guarantee the product is built on (docs/ACCOUNT-MODEL.md §1). " +
        "Refusing to store it. Use the approved agent's key, and treat this one as exposed.",
      );
    }

    const ks = loadKeystore(path);
    const existed = hasKey(ks, master);
    saveKeystore(path, putKey(ks, master, key, passphrase));
    console.log(`${existed ? "replaced" : "stored"} the agent key for ${master}`);
    console.log(`  agent address: ${derived}`);
    console.log(`  keystore:      ${path} (0600)`);
    console.log("\nConfirm that address is the one approved on Hyperliquid for this master.");
    return;
  }

  if (cmd === "remove") {
    if (!arg) throw new Error("usage: npm run keys -- remove <master-address>");
    const ks = loadKeystore(path);
    if (!hasKey(ks, arg)) throw new Error(`${arg} has no keystore entry`);
    saveKeystore(path, removeKey(ks, arg));
    console.log(`removed the agent key for ${arg.toLowerCase()}`);
    return;
  }

  console.log("usage:\n  npm run keys -- list\n  npm run keys -- add <master-address>    (key on stdin)\n  npm run keys -- remove <master-address>");
}

main().catch((e) => {
  console.error(`[keys] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
