import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { QuotientClient, type EndpointName } from "../signals/client.ts";

// One-shot capture of a real response, so types.ts and the mapper are designed
// against reality instead of the published summary. Costs $0.01 per endpoint.
//
//   npx tsx src/scripts/probe-quotient.ts perps
//   npx tsx src/scripts/probe-quotient.ts signals status=actionable

async function main() {
  const [endpoint = "perps", ...rest] = process.argv.slice(2);
  const params = Object.fromEntries(
    rest.map((kv) => kv.split("=") as [string, string]),
  );

  const client = new QuotientClient(process.env.QUOTIENT_API_KEY ?? "", process.env.QUOTIENT_BASE_URL);
  const raw = await client.get(endpoint as EndpointName, params);

  mkdirSync("data/probe", { recursive: true });
  const path = `data/probe/${endpoint}-${raw.receivedAt.replace(/[:.]/g, "-")}.json`;
  writeFileSync(path, JSON.stringify(raw.body, null, 2));

  console.log(`saved ${path}`);
  console.log(`top-level keys: ${Object.keys(raw.body as object).join(", ")}`);
  console.log(JSON.stringify(raw.body, null, 2).slice(0, 3000));
}

main().catch((e) => { console.error(e); process.exit(1); });
