import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// Credit meter. Quotient is pay-per-call ($0.01 for /signals and /signals/perps),
// so an unattended poll loop is a standing bill. This is the hard stop: it counts
// spend per UTC month and refuses further calls past the cap. Without it a tightened
// poll interval or a retry storm silently drains the prepaid balance.

export type MeterState = { month: string; calls: number; usd: number };

export function monthKey(at = new Date()): string {
  return at.toISOString().slice(0, 7);
}

/** Adds a call's cost, rolling the counter over at a month boundary. */
export function applyCall(state: MeterState, usd: number, at = new Date()): MeterState {
  const m = monthKey(at);
  if (state.month !== m) return { month: m, calls: 1, usd };
  return { month: m, calls: state.calls + 1, usd: round2(state.usd + usd) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class CreditMeter {
  private state: MeterState;

  constructor(private readonly path: string, private readonly capUsd: number) {
    this.state = this.load();
  }

  private load(): MeterState {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as MeterState;
    } catch {
      return { month: monthKey(), calls: 0, usd: 0 };
    }
  }

  /** True when this month's spend is at or over the cap. */
  get exhausted(): boolean {
    return monthKey() === this.state.month && this.state.usd >= this.capUsd;
  }

  get snapshot(): Readonly<MeterState> {
    return this.state;
  }

  record(usd: number): void {
    this.state = applyCall(this.state, usd);
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state));
  }
}
