import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDecision, decide, loadState, saveState, type AlertState } from "./alert-state.ts";
import { alarmMessage, dailyLine, readFeedWatch, resolvedMessage } from "./feed-watch.ts";
import { readArchive, type Poll } from "../signals/archive.ts";
import { contractChanges } from "../signals/contract.ts";
import { haltBurst } from "./desk-watch.ts";
import { DESK_WATCH } from "../risk/params.ts";
import type { DeskBook } from "./heartbeat.ts";
import { notify, notifyConfigured } from "./notify.ts";

// External watchdog. Run by a systemd timer, NOT by the recorder — a process that
// has died cannot alert about itself. This is the specific gap that let
// OutcomeMaker's flow-logger die unnoticed for weeks.
//
// Checks four things and alerts on the edges:
//   stale       — recorder heartbeat older than staleAfterSec (dead, hung, or halted)
//   credits     — prepaid balance below a warning floor (top up before it stops)
//   exec-stale  — executor heartbeat older than execStaleAfterSec
//   exec-halted — the executor halted an account and needs a human
//   feed-sigma  — Quotient's sigma_total outside its band for FEED_SIGMA_WATCH.sustainedDays
//                 (`tasks/43` §2), plus one informational line a day whatever it reads
//   halt-burst  — DESK_WATCH.haltCount accounts halted inside haltWindowMin, which is the
//                 2026-09-10 shape (three in six minutes, all holding the same book)
//   book        — one line a day on what the desk is holding, and whether it is holding
//                 one book several times. Reports; the owner's decision was no cap
//   feed-contract — the SHAPE of the feed rather than its numbers (`tasks/47` Rule 6):
//                 keys, the two closed vocabularies, and the outlook_id component count.
//                 One line a day, and an alarm only on a change that could move the gate
//
// The executor checks are skipped entirely when `exec-heartbeat.json` has never
// existed, so a recorder-only box does not alert forever about something it was
// never running.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

function num(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const POLL_SEC = num("QUOTIENT_POLL_SEC", 1800);
const CONFIG = {
  // 2.5 poll intervals: tolerant of one slow poll, not of a dead process.
  staleAfterSec: num("WATCHDOG_STALE_AFTER_SEC", Math.round(POLL_SEC * 2.5)),
  creditsWarn: num("WATCHDOG_CREDITS_WARN", 1000), // 1000 credits = $1
  repeatHours: num("WATCHDOG_REPEAT_HOURS", 12),
  // The exec loop runs every 60s, so five minutes is three missed loops: tolerant of
  // one slow venue read, not of a dead process.
  execStaleAfterSec: num("WATCHDOG_EXEC_STALE_AFTER_SEC", 300),
};

type Heartbeat = { t: string; ok?: boolean; credits?: number | null; error?: string };

/** What `src/exec/runner.ts` writes each loop. */
type ExecHeartbeat = {
  t: string; mode: string; loops: number;
  halted: boolean; haltReason: string | null;
  equityUsd: number; baseCapital: number; dayStartEquity: number;
  openIntents: number; positions: number; restingOrders: number;
  foreignOrders: number; foreignPositions: number;
  /** Additive, and optional here on purpose: the watchdog deploys separately from the
   *  executor and may read a heartbeat written before these existed. Absent means *the
   *  executor is older than this check*, which must read as "nothing to say" and never as
   *  a desk with no book and no halts. */
  accountCount?: number;
  recentHalts?: number;
  haltWindowMin?: number;
  book?: DeskBook;
};

function readJson<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(DATA_ROOT, name), "utf8")) as T;
  } catch {
    return null;
  }
}

function fmtAge(ms: number): string {
  const m = Math.floor(ms / 60000);
  return m < 120 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

async function check(
  state: AlertState,
  key: string,
  firing: boolean,
  onsetMsg: string,
  resolvedMsg: string,
  nowMs: number,
): Promise<void> {
  const d = decide(state[key], firing, nowMs, CONFIG.repeatHours * 3600_000);
  if (d.send) {
    const prefix = d.kind === "resolved" ? "✅ RESOLVED" : d.kind === "repeat" ? "🔴 STILL" : "🔴 ALERT";
    await notify(`${prefix} · SignalDesk\n${d.kind === "resolved" ? resolvedMsg : onsetMsg}`);
    console.log(`[watchdog] ${d.kind} ${key}`);
  }
  applyDecision(state, key, firing, d, nowMs);
}

async function main(): Promise<void> {
  if (!notifyConfigured()) {
    console.log("[watchdog] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID unset — nothing to alert to");
    return;
  }
  if (process.argv.includes("--test")) {
    const ok = await notify("✅ SignalDesk watchdog — test message. Alerting is wired.");
    console.log(`[watchdog] test send: ${ok ? "delivered" : "FAILED"}`);
    process.exit(ok ? 0 : 1);
  }
  const statePath = join(DATA_ROOT, "watchdog-state.json");
  const state = loadState(statePath);
  const now = Date.now();
  const hb = readJson<Heartbeat>("heartbeat.json");

  const ageMs = hb ? now - Date.parse(hb.t) : Infinity;
  const stale = !hb || ageMs > CONFIG.staleAfterSec * 1000;
  await check(
    state,
    "stale",
    stale,
    hb
      ? `Recorder silent for ${fmtAge(ageMs)} (limit ${fmtAge(CONFIG.staleAfterSec * 1000)}).\nLast: ${hb.t}${hb.error ? `\nError: ${hb.error}` : ""}\n\nssh root@<vps-host> "journalctl -u signaldesk-recorder -n 30"`
      : `No heartbeat file at ${DATA_ROOT}/heartbeat.json — recorder has never run, or the data dir is gone.`,
    `Recorder is reporting again (last poll ${fmtAge(ageMs)} ago).`,
    now,
  );

  const credits = hb?.credits ?? null;
  const low = credits !== null && credits < CONFIG.creditsWarn;
  await check(
    state,
    "credits",
    low,
    `Quotient balance low: ${credits} credits ≈ $${((credits ?? 0) / 1000).toFixed(2)}.\nAt ${POLL_SEC}s that is ~${(((credits ?? 0) / ((86400 / POLL_SEC) * 10))).toFixed(1)} days left.\nTop up at quotient.social, then restart the recorder.`,
    `Quotient balance back above ${CONFIG.creditsWarn} credits.`,
    now,
  );

  // ── Executor (Phase 1) ────────────────────────────────────────────────────
  const ex = readJson<ExecHeartbeat>("exec-heartbeat.json");
  if (ex) {
    const exAgeMs = now - Date.parse(ex.t);
    await check(
      state,
      "exec-stale",
      exAgeMs > CONFIG.execStaleAfterSec * 1000,
      `Executor silent for ${fmtAge(exAgeMs)} (limit ${fmtAge(CONFIG.execStaleAfterSec * 1000)}).\n` +
      `Last loop ${ex.loops} at ${ex.t}, ${ex.positions} position(s) and ${ex.restingOrders} resting order(s) left on the venue.\n\n` +
      `ssh root@<vps-host> "journalctl -u signaldesk-exec -n 50"`,
      `Executor is reporting again (last loop ${fmtAge(exAgeMs)} ago).`,
      now,
    );

    // ── The two the owner added on 2026-09-12 (`DESK_WATCH`) ──────────────────
    //
    // Both come off the heartbeat rather than being computed here: the executor owns the
    // ledger, and a rolling window read on this timer would miss a burst that opened and
    // closed between two runs — which is the shape of the thing (three accounts in six
    // minutes). Skipped entirely when the field is absent, so a lagging watchdog reading
    // an older executor says nothing rather than saying zero.
    if (ex.recentHalts !== undefined) {
      const burst = haltBurst({
        halts: ex.recentHalts,
        windowMin: ex.haltWindowMin ?? 30,
        accounts: ex.accountCount ?? 0,
      });
      await check(
        state, "halt-burst", burst.firing, burst.message,
        "Halts are no longer arriving together.", now,
      );
    }

    // A halt is not self-clearing: it means a second actor touched the account, or
    // the daily loss cap tripped. Both need a person.
    await check(
      state,
      "exec-halted",
      ex.halted,
      `Account ${ex.mode.toUpperCase()} HALTED — no new positions.\n${ex.haltReason ?? "(no reason recorded)"}\n` +
      (ex.foreignPositions || ex.foreignOrders
        ? `Not ours on this account: ${ex.foreignPositions} position(s), ${ex.foreignOrders} order(s).\n`
        : "") +
      `Equity $${ex.equityUsd.toFixed(2)} vs $${ex.dayStartEquity.toFixed(2)} at the day's open.\n` +
      `Existing venue-side stops stay live. Clear the halt only after checking the account.`,
      `Account halt cleared — the executor is opening positions again.`,
      now,
    );
  }

  // ── The gate's own denominator (`tasks/43` §2) ────────────────────────────
  //
  // **Once a UTC day, and that is the statistic's own cadence**: a per-pair median over
  // a day of polls does not change between two 15-minute runs, and reading the whole
  // archive to learn that would cost a gzip pass over every day of it, 96 times a day.
  // The line's own `lastSentMs` is the "have I spoken today" flag — no new state shape.
  //
  // Wrapped, because a watcher that can take the watchdog down is worse than no watcher:
  // the three checks above are what keeps a dead recorder from going unnoticed.
  const feedDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  // Read once, lazily, and shared by both feed checks: `readArchive` is a gzip pass over
  // every day of the archive and neither check is worth two of them.
  let archive: Poll[] | null = null;
  const polls = (): Poll[] => (archive ??= readArchive(DATA_ROOT));
  const spokeToday = feedDay(state["feed-line"]?.lastSentMs ?? 0) === feedDay(now);
  let feedLog = "feed: already said today";
  if (!spokeToday) {
    try {
      const w = readFeedWatch(DATA_ROOT, now);
      await notify(`SignalDesk · ${dailyLine(w)}`);
      state["feed-line"] = { firing: false, lastSentMs: now };
      // Unscored is its own edge, so a watcher that has quietly stopped being able to
      // answer says so once rather than printing a reassuring line built on nothing.
      await check(
        state, "feed-unscored", w.refusal !== null,
        `The feed-sigma watcher cannot score: ${w.refusal}.\nnpm run feed-sigma on the box for the detail.`,
        "The feed-sigma watcher is scoring again.",
        now,
      );
      if (w.refusal === null) {
        await check(state, "feed-sigma", w.firing, alarmMessage(w), resolvedMessage(w), now);
      }
      feedLog = w.refusal === null
        ? `feed ${w.latest?.day}=${w.latest?.ratio.toFixed(2)}x run=${w.run} firing=${w.firing}`
        : `feed not scored: ${w.refusal}`;

      // ── The feed's contract (`tasks/47` Rule 6) ─────────────────────────────
      //
      // The other half of the same daily line, and a different question: the σ watcher
      // asks whether the numbers moved, this asks whether the **shape** did. Four vendor
      // changes in fourteen days were each found afterwards by somebody wondering why a
      // number had moved; the 2026-09-11 one force-closed healthy positions hourly for two
      // days before anybody looked.
      //
      // ⚠ **Only a change alarms, and only a breaking one is loud.** Measured over the
      // whole archive, the contract moved three times in fourteen days and all three were
      // keys *arriving* — the kind that cannot alter what a gate reads. An alarm that
      // fired on those would be muted before it ever met the change that matters.
      const cc = contractChanges(polls());
      const latestChange = cc.changes.at(-1);
      const changedToday = latestChange !== undefined
        && feedDay(latestChange.at.getTime()) === feedDay(now);
      await notify(
        `SignalDesk · feed contract ${cc.latest?.hash ?? "?"} — ` +
        `${cc.latest?.keys.length ?? 0} keys, outlook_id ${cc.latest?.idComponents.join("/") ?? "?"} components` +
        (changedToday ? `\n⚠ changed today: ${latestChange!.lines.join("; ")}` : ", unchanged today"),
      );
      await check(
        state, "feed-contract-breaking",
        changedToday && latestChange!.kind === "breaking",
        `The feed's CONTRACT changed in a way that can move the gate:\n${latestChange?.lines.join("\n")}\n\n` +
        "A key leaving, a contract vocabulary moving or outlook_id changing shape can each change\n" +
        "what evaluateSeries sees or what stableOutlookId returns. `npm run expectancy` refuses to\n" +
        "score a block that spans this. Add a FEED_REGIMES row in the commit that responds to it.",
        "The feed's contract is stable again.",
        now,
      );
      feedLog += ` | contract ${cc.latest?.hash} changes=${cc.changes.length}`;

      // ── The desk's own book, once a day ───────────────────────────────────
      //
      // Reports, bounds nothing — the owner's decision of 2026-09-12 was **no
      // concentration cap**, because accounts run different settings and one position is
      // a different share of every book. What it answers is the question the 09-10
      // screenshot raised and no count could: *is the desk holding one book fifteen
      // times?* `identicalPairs` is the number that says so; at the 09-10 peak, four
      // accounts with the same four positions is six pairs.
      const book = readJson<ExecHeartbeat>("exec-heartbeat.json")?.book;
      if (book) {
        await notify(
          `SignalDesk · ${book.line}` +
          (book.identicalPairs > 0
            ? `\n⚠ ${book.identicalPairs} pair(s) hold an identical book — one call, several accounts.`
            : "") +
          (book.topShare >= DESK_WATCH.concentrationWarn && book.top !== null
            ? `\n⚠ ${book.top.key} is ${(book.topShare * 100).toFixed(0)}% of everything open.`
            : ""),
        );
        feedLog += ` | ${book.line}`;
      }
    } catch (e) {
      feedLog = `feed check failed: ${e instanceof Error ? e.message : String(e)}`;
      console.error(`[watchdog] ${feedLog}`);
    }
  }

  saveState(statePath, state);
  console.log(
    `[watchdog] stale=${stale} credits=${credits ?? "?"} age=${hb ? fmtAge(ageMs) : "n/a"}` +
    (ex ? ` | exec loops=${ex.loops} halted=${ex.halted} age=${fmtAge(now - Date.parse(ex.t))}` : " | exec: not deployed here") +
    ` | ${feedLog}`,
  );
}

main().catch((e) => {
  console.error("[watchdog] fatal:", e);
  process.exit(1);
});
