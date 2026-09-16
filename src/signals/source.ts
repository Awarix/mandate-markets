import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { ENDPOINTS, QuotientClient } from "./client.ts";
import type { CreditMeter } from "./meter.ts";
import type { PerpsResponse, PerpsSeries } from "./types.ts";

// Where the executor gets its signals. Two implementations, one interface.
//
// A file source is not a convenience: **the Quotient API host is unreachable from the
// dev Mac** (Render's app edge times out locally while resolving fine from the VPS),
// so without one the execution core could not be exercised at all outside production.
// It also replays the archive, which is how a lifecycle bug found in week three gets
// reproduced deterministically instead of waited for.

export type Snapshot = {
  /** When this *content* was observed — the poll that produced these `series`. */
  at: Date;
  /** When the vendor was last successfully reached, which is **not** the same thing
   *  and is what staleness means.
   *
   *  They separate the moment the payload stops changing. Quotient republishes an
   *  identical body and the recorder archives a `changed:false` line for it, so `at`
   *  can be hours old on a feed that is answering every poll perfectly. Reading
   *  `staleFeedSec` off `at` would then refuse new positions on a healthy feed, and
   *  reading it off our own clock — what `runner.ts` did until 2026-09-07 — refuses
   *  nothing ever. `governor.ts` phrases the skip as *"last successful poll N min
   *  ago"*, and this is that number. */
  polledAt: Date;
  series: PerpsSeries[];
  source: string;
};

export interface SignalSource {
  readonly name: string;
  fetch(): Promise<Snapshot>;
}

/** Polls Quotient. Costs $0.01 a call and respects the same monthly cap the recorder
 *  does — an execution loop polling every 60s would be $432/mo on its own, so the
 *  runner shares the recorder's archive rather than double-polling in production. */
export class LiveQuotientSource implements SignalSource {
  readonly name = "quotient:live";
  constructor(private readonly client: QuotientClient, private readonly meter?: CreditMeter) {}

  async fetch(): Promise<Snapshot> {
    if (this.meter?.exhausted) throw new Error("monthly Quotient credit cap reached");
    const raw = await this.client.perps();
    this.meter?.record(ENDPOINTS.perps.usd);
    const body = raw.body as PerpsResponse;
    // Polling live, the two coincide: this content is what the call we just made
    // returned. They only diverge when something else did the polling for us.
    const at = new Date(raw.receivedAt);
    return { at, polledAt: at, series: body.series, source: this.name };
  }
}

/** Reads the newest archived payload the recorder wrote. This is the production
 *  pairing: the recorder owns the API budget, the executor reads its archive, and
 *  neither has to know about the other beyond a directory. */
export class ArchiveSource implements SignalSource {
  readonly name = "quotient:archive";
  constructor(private readonly root = "data") {}

  async fetch(): Promise<Snapshot> {
    const dir = join(this.root, "quotient", "perps");
    const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort();
    const newest = files.at(-1);
    if (newest === undefined) throw new Error(`no archive under ${dir}`);
    // Each line is its own gzip member; concatenated members are valid gzip.
    const lines = gunzipSync(readFileSync(join(dir, newest))).toString().trim().split("\n");

    // The recorder appends a line for every poll that **succeeded** — with a body when
    // the content changed, without one when it did not — and appends nothing at all
    // when the call failed (`recorder.ts`: the journal write is inside the try, the
    // failure path only touches the heartbeat). So the newest line's `t` is exactly
    // "when we last reached Quotient", whatever it says, and that is `polledAt`.
    //
    // The newest line carrying a *body* is a different and older instant — the last
    // time the content moved. That is `at`. Deriving staleness from it would ground
    // the account whenever Quotient republished the same payload for an hour.
    const last = JSON.parse(lines.at(-1)!) as { t: string };
    const polledAt = new Date(last.t);

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = JSON.parse(lines[i]!) as { t: string; changed: boolean; body?: PerpsResponse };
      if (line.changed && line.body) {
        return { at: new Date(line.t), polledAt, series: line.body.series, source: `${this.name}:${newest}` };
      }
    }
    // Only reachable when the newest daily file holds nothing but unchanged polls,
    // which needs the payload to be static across a UTC midnight. Left as a throw:
    // the caller treats it as a failed poll and keeps the previous snapshot, whose
    // own `polledAt` then ages until the gate below fires — which is the right
    // outcome, reached for a slightly wrong reason. Scanning back into the previous
    // day's file would fix it properly and is not this change.
    throw new Error(`no payload with a body in ${newest}`);
  }
}

/** A single captured payload, replayed forever. For local development against a
 *  known-good snapshot; the timestamps in it are fixed, so the horizon gate will
 *  reject everything unless the clock is overridden. */
export class FileSource implements SignalSource {
  readonly name = "quotient:file";
  constructor(private readonly path: string) {}

  async fetch(): Promise<Snapshot> {
    const body = JSON.parse(readFileSync(this.path, "utf8")) as PerpsResponse;
    // `polledAt` is now, not the capture's `as_of`. Reading a file we own succeeded
    // this instant; what is stale here is the *content*, which `at` says and which the
    // horizon gate already refuses without a clock override. Dating the poll to the
    // capture would add a second, redundant refusal to every local replay.
    return {
      at: new Date(body.as_of), polledAt: new Date(),
      series: body.series, source: `${this.name}:${this.path}`,
    };
  }
}
