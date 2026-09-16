import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The operator's global kill switch: a file. Every account stops opening the moment
// it exists, without a deploy, a restart or a database write. Existing venue-side
// stops are untouched — they are on the exchange and outlive us by design.
//
// The user's own kill switch is better than any of ours: revoking the agent on
// Hyperliquid makes us instantly unable to do anything. That is documented as step
// one of "something is wrong", and everything here is only for our side.

export function haltFilePath(): string {
  return process.env.SIGNALDESK_HALT_FILE ?? "data/HALT";
}

export function globalHalt(): { halted: boolean; reason: string } {
  const path = haltFilePath();
  if (!existsSync(path)) return { halted: false, reason: "" };
  let reason = "halt file present";
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text) reason = text;
  } catch { /* an unreadable halt file still halts */ }
  return { halted: true, reason };
}

export function setGlobalHalt(reason: string): void {
  const path = haltFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${new Date().toISOString()} ${reason}\n`);
}

export function clearGlobalHalt(): void {
  rmSync(haltFilePath(), { force: true });
}
