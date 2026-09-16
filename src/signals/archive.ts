import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { PerpsResponse, PerpsSeries, PmResponse, PmSignal } from "./types.ts";

// Reading back what `journal.ts` wrote, in the same directory as the writer.
//
// It lived in `src/scripts/expectancy.ts` until 2026-09-13, which was fine while only
// the analysis scripts read the archive. `src/ops/feed-watch.ts` reads it too, and that
// runs inside the **watchdog** — a process whose whole job is to still be alive when
// something else is not, and which was therefore importing `exec/loop.ts` and the
// Hyperliquid clients through a re-export it never used. Every consumer still gets the
// same function; `expectancy.ts` re-exports it so no caller had to change.

export type Poll = { t: Date; series: PerpsSeries[] };

/** Every poll the recorder archived, oldest first.
 *
 *  A line without a body is an unchanged poll — the recorder writes one rather than
 *  re-storing an identical payload — so the previous body is carried forward. Dropping
 *  those would make the poll timeline look full of holes it does not have, and gaps in
 *  that timeline are what `tasks/02` calls the survivorship trap. */
export function readArchive(root: string): Poll[] {
  const dir = join(root, "quotient", "perps");
  if (!existsSync(dir)) return [];
  const polls: Poll[] = [];
  let last: PerpsSeries[] | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort()) {
    for (const line of gunzipSync(readFileSync(join(dir, file))).toString().trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as { t: string; changed: boolean; body?: PerpsResponse };
      if (row.body) last = row.body.series;
      if (last) polls.push({ t: new Date(row.t), series: last });
    }
  }
  return polls.sort((a, b) => a.t.getTime() - b.t.getTime());
}

export type PmPoll = { t: Date; signals: PmSignal[] };

/** Every `/signals` poll the recorder archived, oldest first — the prediction-market
 *  half of the same journal `readArchive` reads.
 *
 *  Same carry-forward rule and the same reason: a line without a body is an unchanged
 *  poll, and dropping those would put holes in a timeline that does not have them.
 *  The one difference is the body's shape — `/signals` returns `{ signals: [...] }` and
 *  nothing else, where `/signals/perps` carries `as_of`, `contract` and `series_count`
 *  beside its array (`notes/2026-09-02-pm-signals-payload.md` §8). */
export function readPmArchive(root: string): PmPoll[] {
  const dir = join(root, "quotient", "signals");
  if (!existsSync(dir)) return [];
  const polls: PmPoll[] = [];
  let last: PmSignal[] | null = null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jsonl.gz")).sort()) {
    for (const line of gunzipSync(readFileSync(join(dir, file))).toString().trim().split("\n")) {
      if (!line) continue;
      const row = JSON.parse(line) as { t: string; changed: boolean; body?: PmResponse };
      if (row.body) last = row.body.signals;
      if (last) polls.push({ t: new Date(row.t), signals: last });
    }
  }
  return polls.sort((a, b) => a.t.getTime() - b.t.getTime());
}
