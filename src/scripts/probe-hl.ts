import "dotenv/config";
import { makeInfoClient } from "../hl/clients.ts";
import { Universe } from "../hl/universe.ts";
import { bandDepth } from "../risk/capacity.ts";
import { liqDistanceFrac, maxStopPct } from "../risk/sizing.ts";
import { RISK_PARAMS } from "../risk/params.ts";

// Verify, don't assume. Every claim in the docs that came from a vendor's
// documentation has been wrong at least once, so this prints the live truth for the
// markets Quotient actually references, alongside the clamps we would apply.
//
//   npm run probe:hl
//   npm run probe:hl -- BTC xyz:NVDA xyz:HOOD

const DEFAULT_SYMBOLS = [
  "BTC", "ETH", "xyz:AAPL", "xyz:CL", "xyz:COPPER", "xyz:GOLD", "xyz:HOOD", "xyz:INTC",
  "xyz:META", "xyz:NATGAS", "xyz:NVDA", "xyz:ORCL", "xyz:PLATINUM", "xyz:PLTR",
  "xyz:SILVER", "xyz:TSLA",
];

async function main(): Promise<void> {
  const info = makeInfoClient();
  const universe = await Universe.load(info);
  console.log(`universe: ${universe.size} markets, dexes: ${universe.dexes.map((d) => d || "(main)").join(", ")}\n`);

  const symbols = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SYMBOLS;
  const marks = new Map<string, number>();
  for (const dex of universe.dexes) {
    for (const [c, px] of Object.entries(await info.allMids(dex === "" ? {} : { dex }))) marks.set(c, Number(px));
  }

  const head = ["symbol", "assetId", "dex", "szDec", "maxLev", "mark", "liq@5x", "liq@10x", "liq@20x", "maxStop@10x"];
  console.log(head.map((h, i) => h.padEnd(i === 0 ? 14 : 10)).join(""));
  for (const s of symbols) {
    const m = universe.resolve(s);
    if (!m) { console.log(`${s.padEnd(14)}UNRESOLVED — a signal naming this would be rejected`); continue; }
    const cells = [
      s, String(m.assetId), m.dex || "(main)", String(m.szDecimals), `${m.maxLeverage}x`,
      (marks.get(s) ?? NaN).toPrecision(6),
      ...[5, 10, 20].map((L) => (L > m.maxLeverage ? "n/a" : `${(liqDistanceFrac(L, m.maxLeverage) * 100).toFixed(2)}%`)),
      `${(maxStopPct(Math.min(10, m.maxLeverage), m.maxLeverage, RISK_PARAMS.liqBufferFrac) * 100).toFixed(2)}%`,
    ];
    console.log(cells.map((c, i) => c.padEnd(i === 0 ? 14 : 10)).join(""));
  }
  console.log(`\nliqBufferFrac=${RISK_PARAMS.liqBufferFrac} — the stop fires at most that far toward liquidation.`);

  // ── Depth and volume (tasks/07 §3.2) ──────────────────────────────────────
  //
  // "Measure, then pick floors, then gate." This is the measuring, and it is the step
  // the task says must happen before any gate is written, because picking a floor
  // first is how you get a constant nobody can defend.
  //
  // The band is `RISK_PARAMS.slippageBps`, so what is measured here is the same band
  // the order would actually be priced into. **The exit side is the one that binds**
  // — a long has to sell into the bids to leave, and a stop that cannot fill on a 10x
  // isolated position is the failure venue-side stops exist to prevent.
  const bps = RISK_PARAMS.slippageBps;
  console.log(`\n── depth within ${bps}bps of the touch, and 24h volume ──`);

  // `dayNtlVlm` per asset, per dex. `metaAndAssetCtxs({dex})` works on a HIP-3 dex —
  // confirmed live 2026-09-02, along with `l2Book` on a fully-qualified name, which
  // `tasks/07` flagged as unverified and as the thing the whole HIP-3 half rests on.
  const vol = new Map<string, number>();
  for (const dex of universe.dexes) {
    const [meta, ctxs] = await info.metaAndAssetCtxs(dex === "" ? undefined as never : { dex } as never);
    meta.universe.forEach((u, i) => {
      const v = Number(ctxs[i]?.dayNtlVlm ?? NaN);
      if (Number.isFinite(v)) vol.set(u.name, v);
    });
  }

  const part = RISK_PARAMS.capacity.maxParticipationPct;
  const cols = ["symbol", "24h vol $", "bid depth", "ask depth", "bid $", "ask $",
    `$ at ${(part * 100).toFixed(0)}% part.`];
  console.log(cols.map((h, i) => h.padStart(i === 0 ? 0 : 14).padEnd(i === 0 ? 14 : 0)).join(""));
  for (const s of symbols) {
    const m = universe.resolve(s);
    if (!m) continue;
    const book = await info.l2Book({ coin: s });
    const [bids, asks] = book?.levels ?? [[], []];
    const bid = bandDepth(bids ?? [], "bids", bps);
    const ask = bandDepth(asks ?? [], "asks", bps);
    const thin = Math.min(bid.notionalUsd, ask.notionalUsd);
    const cells = [
      s,
      Math.round(vol.get(s) ?? 0).toLocaleString("en-US"),
      bid.sz.toPrecision(4), ask.sz.toPrecision(4),
      `$${Math.round(bid.notionalUsd).toLocaleString("en-US")}`,
      `$${Math.round(ask.notionalUsd).toLocaleString("en-US")}`,
      `$${Math.round(thin * RISK_PARAMS.capacity.maxParticipationPct).toLocaleString("en-US")}`,
    ];
    console.log(cells.map((c, i) => c.padStart(i === 0 ? 0 : 14).padEnd(i === 0 ? 14 : 0)).join(""));
  }
  console.log(
    `\n\`$ at ${(part * 100).toFixed(0)}% part.\` is the largest notional one order could take under ` +
    "RISK_PARAMS.capacity.\nA row under $" +
    RISK_PARAMS.capacity.minVolume24hUsd.toLocaleString("en-US") +
    " of 24h volume is refused outright, whatever its book looks like.",
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
