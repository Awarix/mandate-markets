import type { PerpsResponse, PmResponse } from "./types.ts";

const DEFAULT_BASE = "https://quotient-api-gateway.onrender.com/api/v1";

export class QuotientError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`quotient ${status}: ${body.slice(0, 300)}`);
  }
}

/** Endpoints we poll, with their published credit price in USD. */
export const ENDPOINTS = {
  perps: { path: "/signals/perps", usd: 0.01 },
  signals: { path: "/signals", usd: 0.01 },
} as const;

export type EndpointName = keyof typeof ENDPOINTS;

export type RawFetch = {
  endpoint: EndpointName;
  url: string;
  status: number;
  receivedAt: string;
  /** Response body verbatim. Never a parsed projection — see types.ts. */
  body: unknown;
  /** `x-billing-credits-remaining`. Authoritative prepaid balance, in credits
   *  (1000 credits = $1). Beats our local tally: it survives restarts and counts
   *  spend from outside this process. Null if the header is absent. */
  creditsRemaining: number | null;
};

/** Parses the credit-balance header. Returns null when absent or unparseable. */
export function parseCreditsRemaining(headers: Headers): number | null {
  const raw = headers.get("x-billing-credits-remaining");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export const CREDITS_PER_USD = 1000;

export class QuotientClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = DEFAULT_BASE,
    /** 60s, not the 20s this was until 2026-09-06. `/signals/perps` is computed per
     *  request — no CDN cache, `cf-cache-status: DYNAMIC` — and its latency has been
     *  climbing: median 11.6s on 09-01, 18.8s on 09-06, measured from the gap between
     *  archived polls. At 20s the p90 was already inside the timeout and ~13% of polls
     *  were being hung up on mid-flight, which reads as an outage and is not one. An
     *  aborted request is **not billed** (verified against
     *  `x-billing-credits-remaining`), so the old value bought nothing and lost the
     *  poll. `notes/2026-09-06-quotient-perps-latency.md`. */
    private readonly timeoutMs = 60_000,
  ) {
    if (!apiKey) throw new Error("QUOTIENT_API_KEY missing");
  }

  /** Raw GET. Returns the body verbatim; throws QuotientError on non-2xx. */
  async get(endpoint: EndpointName, params: Record<string, string> = {}): Promise<RawFetch> {
    const url = new URL(this.baseUrl + ENDPOINTS[endpoint].path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

    const res = await fetch(url, {
      headers: { "x-quotient-api-key": this.apiKey, accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new QuotientError(res.status, text);

    return {
      endpoint,
      url: url.toString(),
      status: res.status,
      receivedAt: new Date().toISOString(),
      body: JSON.parse(text) as unknown,
      creditsRemaining: parseCreditsRemaining(res.headers),
    };
  }

  perps(params?: Record<string, string>) {
    return this.get("perps", params) as Promise<RawFetch & { body: PerpsResponse }>;
  }

  signals(params?: Record<string, string>) {
    return this.get("signals", params) as Promise<RawFetch & { body: PmResponse }>;
  }
}
