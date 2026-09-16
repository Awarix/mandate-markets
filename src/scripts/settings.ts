import "dotenv/config";
import { join } from "node:path";
import {
  isPinned, OPERATOR_CHANGE, ourAccounts, settingsFilePath, settingsScope, validate,
} from "../exec/settings.ts";
import { checkCapConsistency, haltDistance } from "../risk/halt.ts";
import { dayKey } from "../risk/ledger.ts";
import { DEFAULT_USER_SETTINGS, minFundedForLiveUsd, type UserSettings } from "../risk/params.ts";
import { Store } from "../store/db.ts";

// Changing one account's limits from the box, without taking the limits away.
//
//   npm run settings -- list
//   npm run settings -- set 0x… --stop 1       # per cent of the price, as the site says it
//   npm run settings -- set 0x… --stop 1 --everyone   # past today's budget, on purpose
//
// **Why this exists.** There were two ways to move a connected account's stop and both
// were wrong for this. The desk's Apply button (`tasks/18`) needs the owner signed in.
// A file in `accounts/` needs nobody — but it **overrides the connection row at every
// connect**, so it does not change the owner's setting, it replaces the owner: the
// change queue then refuses their Apply with *"your limits are pinned by an operator's
// file"*. On 2026-09-10 ten accounts were moved to a 1% stop by writing ten files, and
// **nine of them belonged to other people**, who lost control of their own limits as a
// side effect of a number being changed for them. This writes the row the desk writes,
// through the same `applySettings`, so the owner keeps the button.
//
// **It never places, cancels or resizes an order.** Every intent freezes its own terms at
// open — leverage, margin, stop, target and exit policy are columns on its row, and the
// desired order set is derived from that row — so an open position keeps what it opened
// with and the next one opens on the new limits (`src/exec/change-queue.ts`).
//
// **The executor reads the row at connect, not every loop.** So a change here is in force
// for the next process, and the running one keeps what it connected with until it
// restarts or the account reconnects. That is printed rather than left to be discovered.
//
// **And it moves ours first** (`tasks/47` Rule 4). The day's budget is the number of
// accounts we pin with a file, and past it this refuses without `--everyone` — see
// `settingsScope`, which carries the argument and the 2026-09-10 night it comes from.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

function usage(): never {
  console.log("usage: npm run settings -- <list | set 0x… --stop <percent> [--everyone]>");
  process.exit(1);
}

function address(raw: string | undefined): string {
  if (!raw || !/^0x[0-9a-fA-F]{40}$/.test(raw)) {
    console.error(`not an address: ${raw ?? "(missing)"}`);
    process.exit(1);
  }
  return raw.toLowerCase();
}

function parsed(row: { settings: string }): UserSettings {
  return validate({ ...DEFAULT_USER_SETTINGS, ...(JSON.parse(row.settings) as Partial<UserSettings>) });
}

const describe = (s: UserSettings) =>
  `${s.leverage}x · stop ${s.stopLoss ? `${(s.stopPct * 100).toFixed(1)}%` : "off"} · ` +
  `${(s.perSignalPct * 100).toFixed(0)}% per position` + (s.holdToTarget ? " · holds to target" : "");

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const dbPath = process.env.SIGNALDESK_DB ?? join(DATA_ROOT, "signaldesk.sqlite");

  if (cmd === "list") {
    const store = new Store(dbPath, { readOnly: true });
    const rows = store.db.prepare("SELECT * FROM accounts ORDER BY account")
      .all() as { account: string; settings: string; mode: string; base_capital: number; halted: number }[];
    console.log(`${rows.length} account(s) in ${dbPath}\n`);
    for (const r of rows) {
      const pin = isPinned(r.account) ? `  PINNED by ${settingsFilePath(r.account)}` : "";
      console.log(
        `${r.account}  ${r.mode}${r.halted === 1 ? " HALTED" : ""}  $${r.base_capital.toFixed(2)}\n` +
        `    ${describe(parsed(r))}${pin}`,
      );
    }
    console.log(
      "\nA PINNED account takes its limits from that file at connect and its owner cannot change " +
      "them from\nthe desk. Delete the file to hand control back; `set` refuses one rather than " +
      "writing a row the file\nwould overrule.",
    );
    return;
  }

  if (cmd !== "set") usage();
  const everyone = rest.includes("--everyone");
  const args = rest.filter((a) => a !== "--everyone");
  const master = address(args[0]);
  const flag = args[1];
  const value = Number(args[2]);
  if (flag !== "--stop" || !Number.isFinite(value)) usage();

  const store = new Store(dbPath);
  const row = store.account(master);
  if (row === null) {
    console.error(
      `${master} has no account row, so there are no limits in force to change. An account gets one ` +
      "when the executor completes every connect-time check; until then what it asked for lives on " +
      "its connections row and it will connect on that.",
    );
    process.exit(1);
  }
  // A file in `accounts/` wins at connect and in the change queue, so writing the row
  // under one would look applied here, read applied on the desk, and be overruled by the
  // file on the next restart. Refuse and say which file.
  if (isPinned(master)) {
    console.error(
      `${master} is pinned by ${settingsFilePath(master)}, which overrides this row at every connect. ` +
      "Edit that file, or delete it to hand the account's limits back to its owner. Nothing was changed.",
    );
    process.exit(1);
  }

  const before = parsed(row);
  // `validate` refuses rather than clamps, and its message names the range. Printed as a
  // sentence rather than thrown as a stack trace: a typo in a percentage is the ordinary
  // way to use this wrong, and the operator's next move is to retype it.
  let next: UserSettings;
  try {
    next = validate({ ...before, stopPct: value / 100 });
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}. The site offers 1% to 8%. Nothing was changed.`);
    process.exit(1);
  }
  if (next.stopPct === before.stopPct) {
    console.log(`${master} is already on a ${(value).toFixed(1)}% stop. Nothing to do.`);
    return;
  }
  // The floor the change queue refuses on, for the same reason: below it every signal is
  // skipped as `below-min-notional` and the account trades nothing while looking connected.
  const floor = minFundedForLiveUsd(next);
  if (floor > row.base_capital) {
    console.error(
      `those limits need a mandate of at least $${floor.toFixed(2)} for one position to clear ` +
      `Hyperliquid's minimum order, and this account's is $${row.base_capital.toFixed(2)}. Nothing was changed.`,
    );
    process.exit(1);
  }
  for (const w of checkCapConsistency(next)) console.log(`CONFIG WARNING: ${w}`);

  // Last, after every refusal that is about this account alone. The budget is about the
  // *shape* of the day and there is no point spending a slot on a change that was going
  // to be refused for its own reasons anyway.
  const now = new Date();
  const changedToday = (store.db.prepare(
    "SELECT DISTINCT account FROM events WHERE kind = 'settings' AND substr(at, 1, 10) = ? " +
    "AND instr(detail, ?) > 0",
  ).all(dayKey(now), OPERATOR_CHANGE) as unknown as { account: string }[]).map((r) => r.account);
  const scope = settingsScope({ master, everyone, ourAccounts: ourAccounts(), changedToday });
  if (!scope.ok) {
    console.error(scope.reason);
    process.exit(1);
  }

  store.applySettings(master, next, now, scope.why);
  const h = haltDistance(next, row.base_capital, row.day_start_equity);
  console.log(
    `${master}: ${describe(before)}\n` +
    `        → ${describe(next)}\n` +
    `A stop-out now costs $${h.stopOut.usd.toFixed(2)} of a $${row.base_capital.toFixed(2)} mandate, ` +
    `${h.stopsToHalt.toFixed(1)} of them to the daily halt.\n` +
    `${store.openCount(master)} open position(s) keep the terms they opened with; no order was placed ` +
    "or cancelled.\nThe owner can still change this from the desk. Restart the executor for it to read " +
    "the new row.\n" +
    `${changedToday.length + (changedToday.includes(master) ? 0 : 1)} account(s) changed from the box ` +
    `today, of a budget of ${Math.max(1, ourAccounts().length)}` +
    (everyone ? " — passed with --everyone, which is on the event row." : "."),
  );
}

main();
