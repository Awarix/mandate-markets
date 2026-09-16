import assert from "node:assert/strict";
import { test } from "node:test";
import type { InfoClient } from "@nktkas/hyperliquid";
import { Universe } from "./universe.ts";

// Shaped after the real mainnet response (2026-08-30): index 0 is null for the main
// perp dex, `xyz` is index 1, and a HIP-3 dex's universe names are already fully
// qualified ("xyz:NVDA"), matching Quotient's `resolution_reference.symbol` verbatim.
function fakeInfo(dexNames: string[], calls?: string[]): InfoClient {
  return {
    perpDexs: async () => [null, ...dexNames.map((name) => ({ name }))],
    meta: async (p?: { dex?: string }) => {
      calls?.push(p?.dex ?? "");
      if (p?.dex === "xyz") {
        return {
          universe: [
            { name: "xyz:XYZ100", szDecimals: 4, maxLeverage: 30, marginTableId: 30 },
            { name: "xyz:TSLA", szDecimals: 3, maxLeverage: 20, marginTableId: 20 },
            { name: "xyz:NVDA", szDecimals: 3, maxLeverage: 20, marginTableId: 20 },
          ],
          marginTables: [], collateralToken: 0,
        };
      }
      if (p?.dex === undefined || p.dex === "") {
        return {
          universe: [
            { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
            { name: "ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 55 },
            { name: "DEAD", szDecimals: 2, maxLeverage: 3, marginTableId: 50, isDelisted: true },
          ],
          marginTables: [], collateralToken: 0,
        };
      }
      return { universe: [{ name: `${p.dex}:JUNK`, szDecimals: 2, maxLeverage: 5, marginTableId: 50 }], marginTables: [], collateralToken: 0 };
    },
  } as unknown as InfoClient;
}

test("asset ids follow the documented scheme, verified against live values", () => {
  return Universe.load(fakeInfo(["xyz"]), ["", "xyz"]).then((u) => {
    assert.equal(u.resolve("BTC")!.assetId, 0);
    assert.equal(u.resolve("ETH")!.assetId, 1);
    // 100_000 + dexIndex(1) * 10_000 + index. Live: xyz:NVDA = 110002.
    assert.equal(u.resolve("xyz:XYZ100")!.assetId, 110000);
    assert.equal(u.resolve("xyz:NVDA")!.assetId, 110002);
  });
});

test("a HIP-3 symbol resolves under the name Quotient states, with no assembly", async () => {
  const u = await Universe.load(fakeInfo(["xyz"]), ["", "xyz"]);
  const m = u.resolve("xyz:NVDA")!;
  assert.equal(m.coin, "xyz:NVDA");
  assert.equal(m.dex, "xyz");
  assert.equal(m.szDecimals, 3);
  assert.equal(m.maxLeverage, 20);
});

// The rule that cost OutcomeMaker $192 when it was absent.
test("resolution is exact — no substring, no prefix, no nearest match", async () => {
  const u = await Universe.load(fakeInfo(["xyz"]), ["", "xyz"]);
  for (const bad of ["NVDA", "xyz:NVD", "BT", "btc", "xyz:NVDA ", "TSLA"]) {
    assert.equal(u.resolve(bad), null, `${bad} must not resolve`);
  }
});

test("a delisted market does not resolve", async () => {
  const u = await Universe.load(fakeInfo(["xyz"]), ["", "xyz"]);
  assert.equal(u.resolve("DEAD"), null);
});

// Mainnet has 11 perp dexes and testnet has 257; each is four HTTP calls per loop.
test("only the configured dexes are fetched, however many the venue has", async () => {
  const calls: string[] = [];
  const many = Array.from({ length: 256 }, (_, i) => (i === 64 ? "xyz" : `d${i}`));
  const u = await Universe.load(fakeInfo(many, calls), ["", "xyz"]);
  assert.equal(calls.length, 2, `fetched ${calls.length} metas from a 257-dex venue`);
  assert.deepEqual(u.dexes, ["", "xyz"]);
  assert.equal(u.resolve("d0:JUNK"), null, "an unlisted dex's markets are simply unknown to us");
  // The index still comes from the venue's own ordering, not our list's.
  assert.equal(u.resolve("xyz:XYZ100")!.assetId, 100_000 + 65 * 10_000);
});

test("a configured dex that does not exist is a startup failure, not a silent gap", async () => {
  await assert.rejects(
    () => Universe.load(fakeInfo(["xyz"]), ["", "nope"]),
    /does not exist on this network/,
  );
});
