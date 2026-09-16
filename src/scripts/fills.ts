import "dotenv/config";
import { join } from "node:path";
import { isTestnet, makeInfoClient } from "../hl/clients.ts";
import { Universe } from "../hl/universe.ts";
import { ingestAccount, settleClosed } from "../exec/fills.ts";
import {
  entrySlipLines, feeReconciliationLines, reconcileEntrySlip, reconcileFeeSchedule,
  type EntryFill, type FeeFill,
} from "./backtest.ts";
import { excludeSyntheticSql, syntheticNote } from "../store/synthetic.ts";
import { Store } from "../store/db.ts";

// What every closed trade actually cost, printed.
//
//   npm run fills                 # ingest, then print the table
//   npm run fills -- --no-ingest  # print what the ledger already holds
//
// This is the tool `tasks/08` is checked with and the input `tasks/02` reads. It runs
// the same `ingestAccount` the executor runs, against the same ledger, so what it
// prints is what the desk would show — there is no second implementation of the
// arithmetic here to disagree with the first.
//
// **The network line matters.** A testnet query against a mainnet-funded account
// returns no fills at all, which reads exactly like "nothing has traded yet".

const DATA_ROOT = process.env.DATA_ROOT ?? "data";
const LEDGER = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

function usd(n: number | null, width = 9): string {
  return (n === null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(4)).padStart(width);
}

async function main(): Promise<void> {
  console.log(`network: ${isTestnet() ? "TESTNET" : "MAINNET"}   ledger: ${LEDGER}`);
  const store = new Store(LEDGER);
  const ingest = !process.argv.includes("--no-ingest");
  const info = makeInfoClient();
  const universe = ingest ? await Universe.load(info) : null;

  const accounts = (store.db.prepare("SELECT DISTINCT account FROM intents ORDER BY account")
    .all() as { account: string }[]).map((r) => r.account);

  let gross = 0, fees = 0, funding = 0, net = 0, estimate = 0, settled = 0, unsettled = 0;

  for (const account of accounts) {
    const row = store.account(account);
    const mode = row?.mode ?? "(not connected)";
    console.log(`\n═══ ${account}  mode=${mode} ═══`);

    // A paper account has no venue fills. Ingesting one would flag every simulated
    // trip as an unattributable mystery, so it is skipped and said so.
    if (ingest && universe && mode === "live") {
      const r = await ingestAccount({
        info, store, universe, master: account,
        log: (m) => console.log(`    ${m}`), notify: async () => undefined,
      });
      console.log(
        `    ingested ${r.fills} fill(s), ${r.funding} funding row(s), settled ${r.settled}` +
        (r.backfill ? " — first pass, backfill" : "") +
        (r.newForeign > 0 ? `  ⚠ ${r.newForeign} FOREIGN` : ""),
      );
    } else if (ingest && mode !== "live") {
      console.log("    not live — no venue fills to ingest");
    }
    // Settling is pure ledger work and runs for every account, so a trip we cannot
    // attribute carries a reason rather than an empty column.
    settleClosed(store, account);

    for (const i of store.closedIntents(account)) {
      const f = store.fillsFor(i.intent_id);
      const est = i.realized_pnl;
      if (i.net_pnl === null) unsettled++; else settled++;
      if (i.net_pnl !== null) {
        gross += i.net_pnl + (i.fee_usd ?? 0) - (i.funding_usd ?? 0);
        fees += i.fee_usd ?? 0;
        funding += i.funding_usd ?? 0;
        net += i.net_pnl;
        if (est !== null) estimate += est;
      }
      console.log(
        `  ${i.intent_id.slice(0, 8)} ${i.coin.padEnd(13)} ${i.side.padEnd(5)} ` +
        `${String(f.length).padStart(2)} fill(s)  fee=${usd(i.fee_usd, 8)} fund=${usd(i.funding_usd, 9)} ` +
        `net=${usd(i.net_pnl)}  est=${usd(est, 8)}  Δ=${usd(i.net_pnl === null || est === null ? null : i.net_pnl - est, 8)}` +
        (i.pnl_note ? `\n            ↳ ${i.pnl_note}` : ""),
      );
    }

    const foreign = store.db.prepare(
      "SELECT COUNT(*) AS n FROM fills WHERE account = ? AND attribution = 'foreign'",
    ).get(account.toLowerCase()) as { n: number };
    const scope = store.db.prepare(
      "SELECT COUNT(*) AS n FROM fills WHERE account = ? AND attribution = 'out-of-scope'",
    ).get(account.toLowerCase()) as { n: number };
    if (foreign.n || scope.n) {
      console.log(`    fills that are not ours: ${foreign.n} foreign, ${scope.n} out of scope (spot / another dex)`);
    }
  }

  // `tasks/46` §3.4. The two constants that decide every fee figure `npm run backtest`
  // prints — `TAKER_NATIVE` and `HIP3_FEE_SCALE` — were reconciled against nothing, and
  // the 0.2× behind the second was measured once, on 2026-09-02. The venue publishes no
  // `deployerFeeScale`, so the only place it can be re-measured is here, against the
  // receipts the ledger already holds. This is the whole ledger's fills, not one
  // account's: the schedule is a property of the venue.
  const taker = store.db.prepare(
    "SELECT coin, px, sz, fee, fee_token, crossed FROM fills WHERE crossed = 1",
  ).all() as FeeFill[];
  console.log("");
  for (const line of feeReconciliationLines(reconcileFeeSchedule(taker))) console.log(line);

  // `tasks/50` §1.1, and the same argument one line down: `MEASURED_ENTRY_SLIP_BPS` is
  // what every return figure `npm run backtest` prints is charged twice, and the only
  // place it can be re-measured is here. The mark each intent was planned on and the price
  // it filled at are both on the row, so this needs no venue call at all.
  //
  // Operator-test intents are excluded — a nine-minute horizon against a constructed
  // target is not a signal outcome, and it is not a fill the desk's own sizing produced
  // either.
  const entries = store.db.prepare(
    `SELECT side, ref_px, entry_px FROM intents
     WHERE entry_px IS NOT NULL AND ref_px > 0 AND ${excludeSyntheticSql()}`,
  ).all() as EntryFill[];
  console.log("");
  for (const line of entrySlipLines(reconcileEntrySlip(entries))) console.log(line);
  console.log(`       ${syntheticNote()}`);

  console.log(
    `\n═══ total across ${accounts.length} account(s), ${settled} settled / ${unsettled} unsettled ═══\n` +
    `  gross  ${usd(gross)}\n` +
    `  fees   ${usd(-fees)}\n` +
    `  funding${usd(funding)}\n` +
    `  net    ${usd(net)}\n` +
    `  ledger estimate for the same trips ${usd(estimate)}  (off by ${usd(net - estimate)})`,
  );
  store.close();
}

main().catch((e) => {
  console.error("[fills] failed:", e);
  process.exit(1);
});
