import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CREDITS_PER_USD, ENDPOINTS, type EndpointName, QuotientClient, QuotientError } from "./client.ts";
import { Journal } from "./journal.ts";
import { CreditMeter } from "./meter.ts";
import { notify } from "../ops/notify.ts";

// Phase 0, task 01. Records the Quotient signal stream to disk. No Hyperliquid code,
// no trading, no capital. Ships first because no historical-signal endpoint exists —
// the archive only builds forward, so every day this is not running is backtest data
// permanently lost.

const DATA_ROOT = process.env.DATA_ROOT ?? "data";

const CONFIG = {
  pollSec: num("QUOTIENT_POLL_SEC", 900),
  /** `/signals` is prediction-market forecasts on multi-day windows (`window_days`),
   *  not perp outlooks on 30-minute-to-5-day horizons. Polling it at perp cadence
   *  would triple the bill to observe a feed that has not moved. Separate interval,
   *  defaulted an hour apart. */
  signalsPollSec: num("QUOTIENT_SIGNALS_POLL_SEC", 3600),
  monthlyCapUsd: num("QUOTIENT_MONTHLY_CREDIT_CAP_USD", 50),
  // Both endpoints by default. `/signals` is the Polymarket-bound half of the feed
  // (docs/ARCHITECTURE.md §1) and there is still no history endpoint, so every day it
  // is not recorded is a day of that dataset permanently lost — the same argument
  // that made the perps recorder the first thing shipped. Opt *out* with
  // QUOTIENT_RECORD_SIGNALS=false.
  endpoints: (process.env.QUOTIENT_RECORD_SIGNALS === "false"
    ? ["perps"]
    : ["perps", "signals"]) as EndpointName[],
  // Loud after this many consecutive failures on one endpoint. The previous project's
  // flow-logger died silently for weeks; nothing watched it.
  alertAfterFailures: num("QUOTIENT_ALERT_AFTER_FAILURES", 2),
  // Stop before the prepaid balance actually hits zero, so we halt on our own
  // terms rather than on a 402 mid-poll. 1000 credits = $1.
  minCreditsFloor: num("QUOTIENT_MIN_CREDITS_FLOOR", 200),
  /** Floor on the per-endpoint backoff cap — see the failure path, which raises this
   *  to the endpoint's own interval when that is longer. */
  maxBackoffSec: 900,
};

function num(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Each endpoint runs on its own clock and its own failure streak. A `/signals`
 *  outage must not back off `perps`, which is the feed we actually trade. */
function pollSecFor(endpoint: EndpointName): number {
  return endpoint === "signals" ? CONFIG.signalsPollSec : CONFIG.pollSec;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string): void {
  console.log(`[recorder] ${new Date().toISOString()} ${msg}`);
}

/** Liveness marker for the watchdog. Absence or staleness is the alert condition. */
function heartbeat(path: string, detail: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ t: new Date().toISOString(), ...detail }));
}

async function main(): Promise<void> {
  const client = new QuotientClient(
    process.env.QUOTIENT_API_KEY ?? "",
    process.env.QUOTIENT_BASE_URL,
  );
  const journal = new Journal(DATA_ROOT);
  const meter = new CreditMeter(join(DATA_ROOT, "credit-meter.json"), CONFIG.monthlyCapUsd);
  const hbPath = join(DATA_ROOT, "heartbeat.json");

  let stopping = false;
  const stop = (sig: string) => {
    log(`${sig} — finishing current poll, then exiting`);
    stopping = true;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(
    `start endpoints=[${CONFIG.endpoints.join(",")}] every ${CONFIG.pollSec}s ` +
    `(≈ $${estMonthlyUsd().toFixed(2)}/mo) cap=$${CONFIG.monthlyCapUsd} ` +
    `spent=$${meter.snapshot.usd.toFixed(2)} root=${DATA_ROOT}`,
  );

  const failures = new Map<EndpointName, number>();
  // When each endpoint may next be polled. Zero means "now" — every endpoint fires on
  // the first pass, then settles onto its own cadence.
  const dueAt = new Map<EndpointName, number>(CONFIG.endpoints.map((e) => [e, 0]));
  let credits: number | null = null;
  let loggedRunway = false;

  while (!stopping) {
    if (meter.exhausted) {
      const m = `HALT: monthly credit cap $${CONFIG.monthlyCapUsd} reached (spent $${meter.snapshot.usd.toFixed(2)}). Raise QUOTIENT_MONTHLY_CREDIT_CAP_USD to resume.`;
      log(m);
      await notify(`🔴 ALERT · SignalDesk recorder\n${m}`);
      break;
    }

    for (const endpoint of CONFIG.endpoints) {
      if ((dueAt.get(endpoint) ?? 0) > Date.now()) continue;
      try {
        const raw = await client.get(endpoint);
        meter.record(ENDPOINTS[endpoint].usd);
        const changed = journal.write(endpoint, raw.body, new Date(raw.receivedAt));
        failures.set(endpoint, 0);
        dueAt.set(endpoint, Date.now() + pollSecFor(endpoint) * 1000);
        credits = raw.creditsRemaining ?? credits;
        if (!loggedRunway && credits !== null) {
          const perDay = CONFIG.endpoints.reduce((s, e) => s + (86400 / pollSecFor(e)) * (ENDPOINTS[e].usd * CREDITS_PER_USD), 0);
          log(`balance ${credits} credits ≈ $${(credits / CREDITS_PER_USD).toFixed(2)} — ~${perDay.toFixed(0)} credits/day across [${CONFIG.endpoints.map((e) => `${e}@${pollSecFor(e)}s`).join(", ")}] ⇒ ~${(credits / perDay).toFixed(1)} days of runway`);
          loggedRunway = true;
        }
        if (changed) log(`${endpoint}: CHANGED, archived`);
        heartbeat(hbPath, {
          endpoint, ok: true, changed, credits,
          spentUsd: meter.snapshot.usd, calls: meter.snapshot.calls,
        });
        if (credits !== null && credits < CONFIG.minCreditsFloor) {
          const m = `HALT: ${credits} credits left (floor ${CONFIG.minCreditsFloor}) ≈ $${(credits / CREDITS_PER_USD).toFixed(2)}. Top up, then restart.`;
          log(m);
          await notify(`🔴 ALERT · SignalDesk recorder\n${m}`);
          return;
        }
      } catch (e) {
        const n = (failures.get(endpoint) ?? 0) + 1;
        failures.set(endpoint, n);
        // Backoff is per endpoint, on its own interval: a `/signals` outage must not
        // slow `perps`, which is the half of the feed we actually trade.
        //
        // The cap is `max(maxBackoffSec, this endpoint's interval)`, not `maxBackoffSec`
        // flat. `maxBackoffSec` was written when every endpoint polled at 300s, where
        // 900 meant "at most 3 intervals". Applied flat to an endpoint that polls
        // hourly it would invert the meaning: a failing `/signals` would retry every
        // 900s, *more* often than a healthy one.
        const capSec = Math.max(CONFIG.maxBackoffSec, pollSecFor(endpoint));
        const backoffSec = Math.min(capSec, pollSecFor(endpoint) * 2 ** Math.min(n, 5));
        dueAt.set(endpoint, Date.now() + backoffSec * 1000);
        const detail = e instanceof QuotientError ? e.message : e instanceof Error ? e.message : String(e);
        // A 4xx is a config problem (bad key, no credit) and will not fix itself.
        const fatal = e instanceof QuotientError && e.status >= 400 && e.status < 500 && e.status !== 429;
        log(`${n >= CONFIG.alertAfterFailures ? "ALERT " : ""}${endpoint} failed (${n}x): ${detail}`);
        heartbeat(hbPath, { endpoint, ok: false, credits, failures: n, error: detail });
        // Notify once at the threshold, not on every subsequent failure — the
        // external watchdog owns the ongoing "still down" reminders.
        if (n === CONFIG.alertAfterFailures) {
          await notify(`🔴 ALERT · SignalDesk recorder\n${endpoint} failed ${n}x\n${detail}`);
        }
        if (fatal) {
          const m = `HALT: ${e instanceof QuotientError ? e.status : ""} is not retryable — fix the key or credit balance.`;
          log(m);
          await notify(`🔴 ALERT · SignalDesk recorder\n${m}\n${detail}`);
          return;
        }
      }
    }

    // Sleep until the soonest endpoint comes due, so the loop wakes on the shortest
    // cadence in play rather than on a single shared interval. At least a second, so
    // a past-due clock cannot spin.
    const soonest = Math.min(...dueAt.values());
    const waitSec = Math.max(1, Math.min(CONFIG.maxBackoffSec, Math.ceil((soonest - Date.now()) / 1000)));
    for (let i = 0; i < waitSec && !stopping; i++) await sleep(1000);
  }

  log(`stopped cleanly — ${meter.snapshot.calls} calls, $${meter.snapshot.usd.toFixed(2)} this month`);
}

function estMonthlyUsd(): number {
  const month = 30 * 24 * 3600;
  return CONFIG.endpoints.reduce((s, e) => s + ENDPOINTS[e].usd * (month / pollSecFor(e)), 0);
}

main().catch((e) => {
  console.error("[recorder] fatal:", e);
  process.exit(1);
});
