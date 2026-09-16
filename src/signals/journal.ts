import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

// Append-only archive of every poll.
//
// Two kinds of line, both keyed by the same content hash:
//   {t, endpoint, hash, changed:true,  body}  — content differs from the last poll
//   {t, endpoint, hash, changed:false}        — identical to the last poll
//
// So the timeline of *when we looked* is complete, and a payload identical to the
// previous one is not duplicated.
//
// In practice the dedupe almost never fires on /signals/perps: the envelope carries
// `as_of`, and every series embeds live Hyperliquid reference prices, so the content
// differs on essentially every poll. That is why the file is **gzipped**. Each line is
// compressed as its own gzip member and appended; concatenated members are valid gzip,
// so `gunzip -c data/quotient/perps/*.jsonl.gz` yields plain JSONL (use `gunzip -c`
// rather than `zcat` — macOS ships the BSD one, which wants a `.Z` extension and fails
// on `.gz`). ~580 KB of payload
// becomes ~40 KB on disk, which turns ~28 MB/day into ~2 MB/day. Lossless — we still
// store the raw body, never a parsed projection.

export type JournalLine = {
  t: string;
  endpoint: string;
  hash: string;
  changed: boolean;
  body?: unknown;
};

/** Stable hash of a JSON value — key order independent, so key reordering by the
 *  API doesn't read as a content change. */
export function contentHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const entries = Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${stableStringify(x)}`).join(",")}}`;
}

/** data/quotient/<endpoint>/<YYYY-MM-DD>.jsonl.gz — daily files, UTC.
 *  Read with `gunzip -c`, then parse as JSONL. */
export function journalPath(root: string, endpoint: string, at: Date): string {
  return join(root, "quotient", endpoint, `${at.toISOString().slice(0, 10)}.jsonl.gz`);
}

export function buildLine(endpoint: string, body: unknown, lastHash: string | undefined, at: Date): JournalLine {
  const hash = contentHash(body);
  const changed = hash !== lastHash;
  return changed
    ? { t: at.toISOString(), endpoint, hash, changed: true, body }
    : { t: at.toISOString(), endpoint, hash, changed: false };
}

export class Journal {
  private lastHash = new Map<string, string>();

  constructor(private readonly root: string) {}

  /** Appends one line. Returns true if the payload changed since the last poll. */
  write(endpoint: string, body: unknown, at = new Date()): boolean {
    const line = buildLine(endpoint, body, this.lastHash.get(endpoint), at);
    this.lastHash.set(endpoint, line.hash);
    const path = journalPath(this.root, endpoint, at);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, gzipSync(JSON.stringify(line) + "\n"));
    return line.changed;
  }
}
