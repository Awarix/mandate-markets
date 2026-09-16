import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Edge-triggered alerting with a repeat timer.
//
// Without this a 15-minute watchdog sends the same "recorder is down" message 96
// times a day and everyone mutes the channel — which is the same failure as having
// no alerting at all. So: fire once on the transition into a bad state, repeat only
// every `repeatHours`, and fire once more when it clears.

export type AlertRecord = { firing: boolean; lastSentMs: number };
export type AlertState = Record<string, AlertRecord>;

export type Decision = { send: boolean; kind: "onset" | "repeat" | "resolved" | "none" };

/** Pure decision: given the previous record and whether the condition holds now,
 *  should we send, and is it an onset, a repeat, or a recovery? */
export function decide(
  prev: AlertRecord | undefined,
  firing: boolean,
  nowMs: number,
  repeatMs: number,
): Decision {
  const wasFiring = prev?.firing ?? false;
  if (firing && !wasFiring) return { send: true, kind: "onset" };
  if (firing && wasFiring) {
    return nowMs - (prev?.lastSentMs ?? 0) >= repeatMs
      ? { send: true, kind: "repeat" }
      : { send: false, kind: "none" };
  }
  if (!firing && wasFiring) return { send: true, kind: "resolved" };
  return { send: false, kind: "none" };
}

export function loadState(path: string): AlertState {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AlertState;
  } catch {
    return {};
  }
}

export function saveState(path: string, state: AlertState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
}

export function applyDecision(
  state: AlertState,
  key: string,
  firing: boolean,
  d: Decision,
  nowMs: number,
): void {
  const prev = state[key];
  state[key] = {
    firing,
    lastSentMs: d.send ? nowMs : (prev?.lastSentMs ?? 0),
  };
}
