import type { InfoClient } from "@nktkas/hyperliquid";
import type { Market } from "../mapping/intent.ts";
import { RISK_PARAMS } from "../risk/params.ts";

// Resolves a Hyperliquid symbol to everything an order needs: asset id, which dex it
// lives on, its lot size and its max leverage. Read from live `meta` and the perp-dex
// list, never hardcoded — OutcomeMaker hardcoded its asset-id scheme as a regex and
// could not have traded anything else.
//
// Asset id scheme (verified live 2026-08-30):
//   native perp   asset = index in meta.universe            (BTC = 0)
//   HIP-3 perp    asset = 100_000 + dexIndex*10_000 + index (xyz = dex 1, xyz:NVDA = 110002)
//
// Two things the docs do not say, both found by probing:
//
//  * In a HIP-3 dex's `meta`, `universe[].name` is **already fully qualified**
//    ("xyz:NVDA"), so it matches Quotient's `resolution_reference.symbol` verbatim.
//    No string assembly, and therefore no chance of assembling it wrong.
//  * `meta({dex})` returns a `marginTables` array that does **not** contain the ids
//    its own universe entries reference. Every HIP-3 table is single-tier anyway, so
//    `universe[].maxLeverage` is the base-tier number the maintenance rate needs.
//
// The dex list is a **hard scope**, not an optimisation: mainnet has 11 perp dexes
// and testnet has 257, and each one is four HTTP calls per loop. See
// `RISK_PARAMS.tradedDexes` for what that costs us and why it is still right.

export type UniverseEntry = Market & { marginTableId: number; isDelisted: boolean };

export class Universe {
  private readonly byCoin = new Map<string, UniverseEntry>();
  private loadedAt = 0;

  private constructor(
    private readonly info: InfoClient,
    private readonly wanted: readonly string[],
    private readonly ttlMs: number,
  ) {}

  static async load(
    info: InfoClient,
    wanted: readonly string[] = RISK_PARAMS.tradedDexes,
    ttlMs = 3_600_000,
  ): Promise<Universe> {
    const u = new Universe(info, wanted, ttlMs);
    await u.reload();
    return u;
  }

  async reload(): Promise<void> {
    // `perpDexs` gives each dex the index it has in the asset-id scheme. Index 0 is
    // null: the main perp dex, addressed with an empty dex name.
    const dexs = await this.info.perpDexs();
    const wanted = new Set(this.wanted);
    const targets: { dex: string; index: number }[] = [];
    dexs.forEach((d, index) => {
      const dex = d === null ? "" : d.name;
      if (wanted.has(dex)) targets.push({ dex, index });
    });
    for (const dex of wanted) {
      if (!targets.some((t) => t.dex === dex)) {
        throw new Error(`configured dex "${dex}" does not exist on this network — check RISK_PARAMS.tradedDexes`);
      }
    }

    const metas = await Promise.all(targets.map((t) => this.info.meta(t.dex === "" ? {} : { dex: t.dex })));

    const next = new Map<string, UniverseEntry>();
    targets.forEach((t, n) => {
      const base = t.index === 0 ? 0 : 100_000 + t.index * 10_000;
      metas[n]!.universe.forEach((m, i) => {
        next.set(m.name, {
          coin: m.name,
          assetId: base + i,
          dex: t.dex,
          szDecimals: m.szDecimals,
          maxLeverage: m.maxLeverage,
          marginTableId: m.marginTableId,
          isDelisted: m.isDelisted === true,
        });
      });
    });

    this.byCoin.clear();
    for (const [k, v] of next) this.byCoin.set(k, v);
    this.loadedAt = Date.now();
  }

  get stale(): boolean {
    return Date.now() - this.loadedAt > this.ttlMs;
  }

  get size(): number {
    return this.byCoin.size;
  }

  /** Validate, never infer. An exact lookup, or nothing — no substring match, no
   *  nearest neighbour, no fallback. OutcomeMaker lost $192 to a substring match
   *  that bought a CPI market instead of a BTC one. */
  resolve(symbol: string): UniverseEntry | null {
    const m = this.byCoin.get(symbol);
    if (!m || m.isDelisted) return null;
    return m;
  }

  /** Every distinct dex we would have to read state from, given a set of coins. */
  dexesFor(coins: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const c of coins) {
      const m = this.byCoin.get(c);
      if (m) out.add(m.dex);
    }
    return [...out];
  }

  /** The dexes we read every loop. Bounded by configuration, never by the venue. */
  get dexes(): readonly string[] {
    return this.wanted;
  }

  /** One live market on each dex we trade.
   *
   *  `activeAssetData` — the only call that answers "what can this account put behind
   *  an order *here*" — is per asset, and the question `src/hl/abstraction.ts` asks is
   *  per book. So it needs a market to ask about, and it must not be a symbol written
   *  down here: dex membership is read from live `meta` everywhere else in this file,
   *  and a hardcoded `BTC` would be one more thing to be wrong when a venue delists it.
   *
   *  First by name, so two runs probe the same market and a log line is comparable
   *  against the one before it. A dex with nothing listed is left out rather than
   *  guessed at. */
  probes(): { dex: string; coin: string }[] {
    const out: { dex: string; coin: string }[] = [];
    for (const dex of this.wanted) {
      const coins = [...this.byCoin.values()]
        .filter((m) => m.dex === dex && !m.isDelisted)
        .map((m) => m.coin)
        .sort();
      if (coins[0] !== undefined) out.push({ dex, coin: coins[0] });
    }
    return out;
  }
}
