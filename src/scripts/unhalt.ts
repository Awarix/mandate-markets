import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canClearHalt, haltDistance } from "../risk/halt.ts";
import { DEFAULT_USER_SETTINGS, RISK_PARAMS, type UserSettings } from "../risk/params.ts";
import { validate } from "../exec/settings.ts";
import { Store, type AccountRow } from "../store/db.ts";

// Clearing a halt from the box, with a record (`tasks/30` §1).
//
//   npm run unhalt -- list
//   npm run unhalt -- 0x…            # looks, refuses if it would re-halt, then clears
//
// **Every clear until now has been a hand `UPDATE`** (`docs/LOG.md`, five on 09-11
// alone), which goes round `recordEvent` — so the ledger records that accounts stopped
// and never that they started again, and *who un-halted this, and when* was
// unanswerable. That is the first reason this exists.
//
// The second is the rule the log records being learned three times: **a daily-loss halt
// does not clear before 00:00Z.** `rollDay` rebaselines `day_start_equity` at the UTC
// boundary, so the condition is gone by construction after it and is not gone before it.
// Cleared early at 2026-09-10 22:23Z, two accounts re-halted at 14.4% and 15.2% and a
// third opened three losers in 35 minutes. `canClearHalt` is the rule; this is the
// operator's end of it.
//
// **It never touches `day` or `day_start_equity`.** That is what makes a clear unable to
// buy a second loss budget, and it is enforced in `Store.clearHalt`, not here.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

function usage(): never {
  console.log("usage: npm run unhalt -- <list | 0x…>");
  process.exit(1);
}

/** The executor's own per-account read, from the file it writes once a loop. The look
 *  this tool does before it clears anything — and it is deliberately **not** a venue
 *  call: this process holds no key, and a second read of Hyperliquid would be a second
 *  answer to a question the executor has already answered. */
type Beat = {
  account: string; equityUsd?: number; freeUsd?: number; dayStartEquity?: number;
  positions?: number; restingOrders?: number; openIntents?: number;
  foreignPositions?: number; foreignOrders?: number; halted?: boolean;
};

function heartbeat(): { ageSeconds: number | null; accounts: Beat[] } {
  const path = join(DATA_ROOT, "exec-heartbeat.json");
  if (!existsSync(path)) return { ageSeconds: null, accounts: [] };
  try {
    const b = JSON.parse(readFileSync(path, "utf8")) as { t?: string; accounts?: Beat[] };
    const t = typeof b.t === "string" ? Date.parse(b.t) : NaN;
    return {
      ageSeconds: Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 1000)) : null,
      accounts: Array.isArray(b.accounts) ? b.accounts.filter((a) => typeof a?.account === "string") : [],
    };
  } catch {
    return { ageSeconds: null, accounts: [] };
  }
}

const beatFor = (accounts: Beat[], addr: string): Beat | null =>
  accounts.find((a) => a.account.toLowerCase() === addr.toLowerCase()) ?? null;

function settingsOf(row: AccountRow): UserSettings {
  try {
    return validate({ ...DEFAULT_USER_SETTINGS, ...(JSON.parse(row.settings) as Partial<UserSettings>) });
  } catch {
    return DEFAULT_USER_SETTINGS;
  }
}

/** §2: say why it halted, in the units it happened in. The account row has the day's
 *  baseline and the halt level; the ledger has what stopped today and what each cost.
 *  On 2026-09-08 that was two positions at −38.1% and −35.6% of their margin against 17
 *  winners — a 65% hit rate that still reached the cap — and no screen said so. */
function describe(store: Store, row: AccountRow, beat: Beat | null, now: Date): string[] {
  const out: string[] = [];
  const s = settingsOf(row);
  const h = haltDistance(s, row.base_capital, row.day_start_equity);
  const at = store.haltedAt(row.account);
  out.push(`  ${row.halt_kind ?? "untyped"}  ${at ? `fired ${at}` : "no halt event recorded"}`);
  out.push(`  ${row.halt_reason ?? "(no reason recorded)"}`);
  out.push(
    `  day ${row.day ?? "unset"}, opening equity ` +
    `${row.day_start_equity === null ? "unset" : `$${row.day_start_equity.toFixed(2)}`}` +
    (h.haltAtUsd === null ? "" : `, pauses at −$${h.haltAtUsd.toFixed(2)} (−${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}%)`),
  );
  if (beat) {
    const loss = row.day_start_equity && beat.equityUsd !== undefined
      ? (row.day_start_equity - beat.equityUsd) / row.day_start_equity : null;
    out.push(
      `  now $${(beat.equityUsd ?? 0).toFixed(2)}` +
      (loss === null ? "" : ` (${loss >= 0 ? "−" : "+"}${Math.abs(loss * 100).toFixed(1)}% on the day)`) +
      ` · ${beat.positions ?? 0} position(s), ${beat.restingOrders ?? 0} resting, ` +
      `${beat.openIntents ?? 0} open intent(s), ${beat.foreignPositions ?? 0} foreign`,
    );
  } else {
    out.push("  ⚠ nothing in the heartbeat for this account — the executor is not reporting it");
  }
  out.push(
    `  one stopped position costs $${h.stopOut.usd.toFixed(2)} of a $${row.base_capital.toFixed(2)} ` +
    `mandate, ${h.stopsToHalt.toFixed(1)} of them to the halt`,
  );
  const day = (row.day ?? now.toISOString()).slice(0, 10);
  const closed = store.stoppedOn(row.account, day);
  const losers = closed.filter((t) => (t.net_pnl ?? 0) < 0).length;
  if (closed.length > 0) {
    out.push(`  ${closed.length} trip(s) closed on ${day}, ${losers} of them down. Worst first:`);
    for (const t of closed.slice(0, 5)) {
      out.push(
        `    ${t.coin} ${t.side} on ${t.close_reason ?? "?"} for ` +
        `${t.net_pnl === null ? "an unsettled result" : `$${t.net_pnl.toFixed(2)}`}` +
        (t.margin_usd > 0 && t.net_pnl !== null
          ? ` (${(t.net_pnl / t.margin_usd * 100).toFixed(1)}% of its margin)` : ""),
      );
    }
  }
  return out;
}

function main(): void {
  const [cmd, ...extra] = process.argv.slice(2);
  if (!cmd || extra.length > 0) usage();
  const dbPath = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");
  const now = new Date();
  const hb = heartbeat();

  if (cmd === "list") {
    const store = new Store(dbPath, { readOnly: true });
    const rows = store.db.prepare("SELECT * FROM accounts WHERE halted = 1 ORDER BY account")
      .all() as unknown as AccountRow[];
    console.log(
      `${rows.length} halted account(s) in ${dbPath}` +
      `${hb.ageSeconds === null ? " · no heartbeat" : ` · heartbeat ${hb.ageSeconds}s old`}\n`,
    );
    for (const row of rows) {
      const beat = beatFor(hb.accounts, row.account);
      console.log(`${row.account}  ${row.mode}`);
      for (const line of describe(store, row, beat, now)) console.log(line);
      const v = canClearHalt({
        actor: "operator", kind: row.halt_kind, haltedAt: store.haltedAt(row.account),
        day: row.day, dayStartEquity: row.day_start_equity,
        equityUsd: beat?.equityUsd ?? null, now,
      });
      console.log(v.ok ? `  → clearable now. ${v.note}` : `  → NOT clearable. ${v.reason}`);
      console.log("");
    }
    if (rows.length === 0) console.log("Nothing is halted.");
    store.close();
    return;
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(cmd)) usage();
  const master = cmd.toLowerCase();
  const store = new Store(dbPath);
  const row = store.account(master);
  if (row === null) {
    console.error(`${master} has no account row, so there is no halt to clear.`);
    process.exit(1);
  }
  if (row.halted !== 1) {
    console.log(`${master} is not halted. Nothing to do.`);
    return;
  }

  const beat = beatFor(hb.accounts, master);
  console.log(`${master}  ${row.mode}`);
  for (const line of describe(store, row, beat, now)) console.log(line);

  const verdict = canClearHalt({
    actor: "operator", kind: row.halt_kind, haltedAt: store.haltedAt(master),
    day: row.day, dayStartEquity: row.day_start_equity,
    equityUsd: beat?.equityUsd ?? null, now,
  });
  if (!verdict.ok) {
    console.error(`\nNOT CLEARED. ${verdict.reason}`);
    process.exit(1);
  }

  // The `looked` note goes on the event row, so the ledger records what was in front of
  // whoever cleared it rather than only that they did.
  store.clearHalt(master, "operator", verdict.note, now);
  console.log(
    `\nCLEARED. ${verdict.note}\n` +
    "`day` and `day_start_equity` are untouched, so the next tick re-halts if the condition is " +
    "still there.\nAn `unhalt` event is on the ledger with what was looked at. The executor reads " +
    "`halted` every tick, so this is in force on the next loop without a restart.",
  );
  store.close();
}

main();
