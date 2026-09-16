import "dotenv/config";
import { join } from "node:path";
import { isTestnet, makeInfoClient } from "../hl/clients.ts";
import { Store } from "../store/db.ts";
import { ingestCounterfactuals } from "../exec/counterfactual.ts";
import type { Candle } from "./exit-policy.ts";

// Drain the backlog of closed trades whose price path has not been summarised yet.
//
//   npm run counterfactuals              # everything outstanding, paced
//   npm run counterfactuals -- --limit 50
//
// The executor does five of these every five minutes on its own (`tasks/31` §5), which
// keeps up with the desk forever but takes a day to clear a backlog that already exists.
// This is the same function with the limit raised — **not the rate**. The pause between
// calls is what stops it becoming the unpaced loop that killed four of five `stop-sweep`
// runs at 207 intents, which is the whole reason any of this was written.
//
// It is safe to run while the executor is running: both open the same WAL ledger, the
// updates are per-row, and `cf_at IS NULL` means whichever gets there first wins and the
// other simply finds less to do.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

async function main(): Promise<void> {
  console.log(`network: ${isTestnet() ? "TESTNET" : "MAINNET"}   ledger: ${LEDGER}`);
  if (isTestnet()) {
    console.log("\n  Refusing to summarise a mainnet ledger against testnet candles — the universe is");
    console.log("  different and the prices are fiction. Re-run with HYPERLIQUID_TESTNET=false.\n");
    process.exitCode = 1;
    return;
  }

  const argv = process.argv.slice(2);
  const at = argv.indexOf("--limit");
  const limit = at >= 0 ? Number(argv[at + 1]) : 10_000;
  if (!Number.isFinite(limit) || limit < 1) {
    console.log("  --limit takes a positive number of trades.");
    process.exitCode = 1;
    return;
  }

  const store = new Store(LEDGER, { log: (m) => console.log(`[store] ${m}`) });
  const info = makeInfoClient(false);

  const out = await ingestCounterfactuals({
    store, now: new Date(), limit, pauseMs: 250,
    log: (m) => console.log(`  ${m}`),
    candles: (coin, interval, startTime, endTime) =>
      info.candleSnapshot({ coin, interval, startTime, endTime }) as unknown as Promise<Candle[]>,
  });

  console.log(
    `\n  summarised ${out.done} trade(s)` +
    (out.empty ? `, ${out.empty} of them with no candles left to read` : "") +
    (out.failed ? `, ${out.failed} failed and stay pending` : "") +
    `\n  ${out.remaining} still outstanding.\n`,
  );

  // Which interval each answer rests on, because a 5m summary is exact about *how far*
  // a trade went against us and coarser about *when* — and a reader of `stop-sweep`
  // should be able to see how much of the table is which.
  for (const r of store.db.prepare(
    "SELECT cf_interval AS i, COUNT(*) AS n, SUM(CASE WHEN cf_mae_px IS NULL THEN 1 ELSE 0 END) AS blank " +
    "FROM intents WHERE cf_at IS NOT NULL GROUP BY cf_interval ORDER BY cf_interval",
  ).all() as unknown as { i: string; n: number; blank: number }[]) {
    console.log(`  ${r.i}: ${r.n} trade(s)${r.blank ? `, ${r.blank} with no candles` : ""}`);
  }
  console.log("");
  store.close();
}

if (import.meta.main) await main();
