import "dotenv/config";
import { createHmac } from "node:crypto";

// Does our Polymarket Builder API key authenticate against the relayer, and is it
// allowlisted for session-signer management? Read-only by construction: both POST
// bodies are empty, so the best outcome is a validation error and nothing can be
// authorized or revoked. Prints status codes and response bodies; never a secret.
//
//   npm run probe:pm-builder
//
// How to read it (notes/2026-09-14-polymarket-the-profile-the-rates-and-the-rollout.md §4–§5):
//   probe 3 → 401 "invalid authorization"   the key or the secret is wrong
//   probe 3 → 403 "not allowed"             the key authenticated but is not allowlisted
//                                           for session-signer routes (measured 2026-09-14)
//   probe 3 → 400                            allowlisted: the empty body was refused on its
//                                           merits — re-run after Polymarket's reply
//
// There is no endpoint that returns a builder's tier, allowlist or quota
// (api-spec/relayer-openapi.yaml, read 2026-09-14), which is why this is indirect.

const RELAYER = "https://relayer-v2.polymarket.com";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set — see .env.example, the Polymarket block`);
  return v;
}

/** The Builder signature: urlsafe-base64(HMAC-SHA256(base64decode(secret), ts+method+path+body)). */
function builderSignature(secret: string, ts: string, method: string, path: string, body: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64"))
    .update(ts + method + path + body)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

async function show(label: string, res: Response): Promise<void> {
  const text = await res.text();
  console.log(`\n[${label}] HTTP ${res.status}\n${text.slice(0, 600)}`);
}

async function main(): Promise<void> {
  const key = need("POLYMARKET_API_KEY");
  const secret = need("POLYMARKET_SECRET");
  const passphrase = need("POLYMARKET_PASSPHRASE");
  const address = need("POLYMARKET_API_ADDRESS");
  const code = need("POLYMARKET_BUILDER_CODE");
  console.log(
    `builder address ${address}, builder code ${code.slice(0, 10)}…, ` +
    `secret decodes to ${Buffer.from(secret, "base64").length} bytes`,
  );

  // 1. No auth: does the builder address resolve to a deposit wallet and a nonce?
  await show(
    "1 GET /v1/account/transactions/params (no auth)",
    await fetch(`${RELAYER}/v1/account/transactions/params?address=${address}&type=WALLET`),
  );

  const body = "{}";
  const json = { "Content-Type": "application/json" };
  const authPath = "/v1/session-signers/authorizations";

  // 2. No auth: the baseline for what "not authorized" looks like.
  await show(
    "2 POST authorizations (no auth, empty body)",
    await fetch(RELAYER + authPath, { method: "POST", headers: json, body }),
  );

  // 3. Our Builder key, empty body. Nothing here can authorize a signer.
  const ts = String(Math.floor(Date.now() / 1000));
  const signed = (path: string, idem: string) => ({
    ...json,
    POLY_BUILDER_API_KEY: key,
    POLY_BUILDER_TIMESTAMP: ts,
    POLY_BUILDER_PASSPHRASE: passphrase,
    POLY_BUILDER_SIGNATURE: builderSignature(secret, ts, "POST", path, body),
    "Idempotency-Key": idem,
  });
  await show(
    "3 POST authorizations (builder auth, empty body)",
    await fetch(RELAYER + authPath, { method: "POST", headers: signed(authPath, `probe-a-${ts}`), body }),
  );

  // 4. Revocations, for symmetry.
  const revokePath = "/v1/session-signers/revocations";
  await show(
    "4 POST revocations (builder auth, empty body)",
    await fetch(RELAYER + revokePath, { method: "POST", headers: signed(revokePath, `probe-r-${ts}`), body }),
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
