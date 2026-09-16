import "dotenv/config";
import { abstractionPlan, reachAgrees, readReach } from "../hl/abstraction.ts";
import { agentAddress, isTestnet, makeInfoClient } from "../hl/clients.ts";
import { checkCollateral } from "../hl/state.ts";
import { Universe } from "../hl/universe.ts";
import { loadSettings } from "../exec/settings.ts";
import { resolveAgentKey } from "../exec/accounts.ts";
import { keystorePath, keystorePassphrase, loadKeystore } from "../keys/keystore.ts";
import { canBeRefusedForSlot, resolveMode } from "../exec/mode.ts";
import { checkCapConsistency, correlatedStopOfMandate } from "../risk/halt.ts";
import { BUILDER_FEE, LIVE_MANDATE, minFundedForLiveUsd, RISK_PARAMS } from "../risk/params.ts";
import { bookShape } from "../risk/ledger.ts";
import { builderFor, builderRail, tenthsBpToFraction, tenthsBpToPercent } from "../hl/approve-builder-fee.ts";

// Everything the connect flow checks, printed, without starting a loop.
// Run this before every deploy and before ever flipping DRY_RUN.
//
//   npm run preflight

async function main(): Promise<void> {
  const master = (process.env.HL_MASTER_ADDRESS ?? "") as `0x${string}`;
  if (!master) throw new Error("HL_MASTER_ADDRESS missing");
  // Resolve the key exactly the way the runner will — keystore first, then the legacy
  // `.env` path — so preflight can never report "no key" about an account that has one
  // in the keystore, or vice versa.
  let agentKey = "";
  let keySource = "none";
  try {
    const r = resolveAgentKey(master, loadKeystore(keystorePath()), keystorePassphrase());
    agentKey = r.key;
    keySource = r.source;
  } catch (e) {
    keySource = e instanceof Error ? e.message.split("\n")[0]! : String(e);
  }

  // First line, deliberately: a testnet `.env` reads as an empty account on every
  // check below, which looks exactly like "not funded yet" and is not. Cost an hour
  // on 2026-08-30 — the dev Mac defaults to testnet, the VPS to mainnet.
  console.log(`network:   ${isTestnet() ? "TESTNET ⚠  (HYPERLIQUID_TESTNET=true)" : "MAINNET"}`);
  console.log(`account:   ${master}`);

  const { settings, source } = loadSettings(master);
  console.log(`settings:  ${JSON.stringify(settings)}  (${source})`);
  for (const w of checkCapConsistency(settings)) console.log(`  WARNING: ${w}`);

  const info = makeInfoClient();
  const universe = await Universe.load(info);
  console.log(`universe:  ${universe.size} markets across ${universe.dexes.length} dexes`);

  const minCollateral = minFundedForLiveUsd(settings);
  const c = await checkCollateral(info, master, minCollateral);
  console.log(`collateral:${c.ok ? " OK " : " FAIL "} ${c.message}`);
  console.log(`           perp $${c.perpEquityUsd.toFixed(2)} · spot $${c.spotUsdc.toFixed(2)} · abstraction ${c.abstraction}`);
  console.log(`           minimum for a legal $${RISK_PARAMS.minOrderNotionalUsd} order at ` +
    `${(settings.perSignalPct * 100).toFixed(0)}%/${settings.leverage}x: $${minCollateral.toFixed(2)}`);

  // What the venue says this account can put behind an order on each book we trade —
  // the question `checkCollateral` cannot answer, and the one that was wrong for 28
  // minutes on 2026-09-10 while everything above printed OK. Read only: preflight
  // reports, and `connectAccount` is what actually sets the mode.
  const reach = await readReach(info, master, universe.probes());
  const agree = reachAgrees(reach);
  console.log(`reachable: ${agree ? "OK  " : "FAIL"} ${reach.map((r) => `${r.dex === "" ? "core" : r.dex} $${r.availableUsd.toFixed(2)} (${r.coin})`).join(" · ")}`);
  if (!agree) {
    console.log("           the books disagree, so collateral is stranded on one of them and orders " +
      "would be rejected for insufficient margin. Connecting sets unified margin, which fixes it.");
  } else if (abstractionPlan(c.abstraction).act === "unify") {
    console.log(`           abstraction is "${c.abstraction}" — connecting would set unifiedAccount (agent-signed, free)`);
  }

  // Printed after the collateral read, because it depends on it: what the account
  // holds *is* what would be traded, so an underfunded account reads PAPER here and
  // the reason says so.
  const { mode, why, baseCapitalUsd } = resolveMode(master, c.usableUsd);
  console.log(`mode:      ${mode.toUpperCase()} — ${why}`);
  // In paper `baseCapitalUsd` is null, and printing $0.00 for every derived bound tells
  // an operator nothing. What they are running this for is "what would live do", so the
  // figures below are worked off what the account holds. The line above stays the
  // authority on what actually happens.
  const wouldTrade = baseCapitalUsd ?? c.usableUsd;
  console.log(`           held $${c.usableUsd.toFixed(2)} · would trade $${wouldTrade.toFixed(2)} ` +
    `(${LIVE_MANDATE.purpose}) · no per-account ceiling since ` +
    `${LIVE_MANDATE.perAccountCeilingRemovedAt} — the deposit is the size`);
  // The position count is derived from this account's own per-position size since
  // `tasks/21`, so preflight prints the number rather than a constant an operator would
  // have to divide for themselves.
  const shape = bookShape(wouldTrade, settings);
  console.log(`           bounded instead by ${(RISK_PARAMS.maxDeployedPct * 100).toFixed(0)}% deployed ` +
    `($${shape.deployedAtFullUsd.toFixed(2)} over ${shape.positions} positions of ` +
    `$${shape.marginPerPositionUsd.toFixed(2)}, reserve $${shape.reserveUsd.toFixed(2)}), ` +
    `and a halt at ${(RISK_PARAMS.dailyLossPct * 100).toFixed(0)}% of the day's equity ` +
    `($${(wouldTrade * RISK_PARAMS.dailyLossPct).toFixed(2)})`);
  console.log(`           a correlated stop of a full book costs ` +
    `${(correlatedStopOfMandate(settings) * 100).toFixed(0)}% of the mandate ` +
    `($${(wouldTrade * correlatedStopOfMandate(settings)).toFixed(2)}) — tasks/21 §4`);
  // The aggregate cap this account is measured against, and whether it is measured at
  // all. Printed because it is the one check preflight cannot answer for itself: it
  // reads a single account and cannot see how many others the runner has already
  // armed, so it reports the rule rather than the verdict.
  console.log(`           at most ${LIVE_MANDATE.maxLiveAccounts} accounts trade live at once, ` +
    `ours included (decided ${LIVE_MANDATE.accountCapDecidedAt}, narrowed ${LIVE_MANDATE.accountCapNarrowedAt}); ` +
    (canBeRefusedForSlot(master)
      ? "this address is not in HL_LIVE_ACCOUNT, so it is refused live once the cap is full"
      : "this address is in HL_LIVE_ACCOUNT, so it is counted but never refused"));

  if (agentKey) {
    const addr = agentAddress(agentKey);
    const agents = await info.extraAgents({ user: master });
    const approved = agents.find((a) => a.address.toLowerCase() === addr.toLowerCase());
    console.log(`agent:     ${addr} ${approved ? `APPROVED as "${approved.name}"` : "NOT APPROVED on this master"} [key from ${keySource}]`);
    if (addr.toLowerCase() === master.toLowerCase()) {
      console.log("           🔴 THIS IS THE MASTER WALLET'S KEY, NOT AN AGENT KEY.");
      console.log("           It can withdraw funds. An agent key cannot — that difference is the");
      console.log("           product (ACCOUNT-MODEL §1). The runner refuses to start with it.");
    }
    if (!approved) {
      console.log(`           approved on this master: ${agents.length === 0 ? "(none)" : agents.map((a) => `"${a.name}" ${a.address}`).join(", ")}`);
    }
    if (approved?.validUntil) {
      console.log(`           valid until ${new Date(approved.validUntil).toISOString()} ` +
        `(${((approved.validUntil - Date.now()) / 86_400_000).toFixed(0)} days)`);
    }
  } else {
    console.log(`agent:     no key resolved — ${keySource} (fine for paper mode)`);
  }

  // The builder fee, in the two units it exists in and the one that says what it costs.
  // Printed here for the same reason the network is printed on the first line: this is
  // the screen somebody checks before believing anything, and "am I charging this
  // account?" is answerable from the venue in one call.
  const rail = builderRail();
  if (!rail) {
    console.log("fee:       none — HL_BUILDER_ADDRESS is unset, so no order carries a builder code");
  } else {
    const approvedMax = await info.maxBuilderFee({ user: master, builder: rail.b });
    const charging = builderFor(rail, approvedMax) !== undefined;
    console.log(`fee:       ${charging ? "CHARGING" : "not charged"} ` +
      `${tenthsBpToPercent(rail.f)} per side (f=${rail.f}) to ${rail.b}`);
    console.log(`           this account approved a maximum of f=${approvedMax}` +
      (charging ? "" : ` — below our f=${rail.f}, so its orders go out with NO builder field and fill normally`));
    // The honest unit. A fee on notional at this desk's turnover is a fee on the
    // account, and the per-trade number does not show that.
    const frac = tenthsBpToFraction(rail.f);
    console.log(`           at 4,000x-12,000x turnover that is ` +
      `${(frac * 4000 * 100).toFixed(0)}%-${(frac * 12000 * 100).toFixed(0)}% of the account a year ` +
      "(ours to know; the site states the rate and stops there)");

    // Whether the BUILDER can legally collect, which is a fact about our own address
    // and not about this account. The venue: "The builder must have at least 100 USDC
    // in perps account value and must use standard as the account abstraction mode."
    //
    // It is checked here because the failure is silent and delayed. Nothing breaks while
    // nobody has approved — `builderFor` returns undefined and no order carries the code
    // — so a non-compliant address looks perfectly fine right up until the **first
    // person signs**, at which point every order on their account is rejected. That is
    // the one account that just agreed to pay us.
    const bs = await info.clearinghouseState({ user: rail.b });
    const bAbs = await info.userAbstraction({ user: rail.b });
    const bPerp = Number(bs.marginSummary.accountValue);
    const okEquity = bPerp >= BUILDER_FEE.builderMinPerpEquityUsd;
    // The docs say the builder must "use standard as the account abstraction mode", and
    // "standard" is not a value this API ever returns. It is the UI's name: Hyperliquid's
    // account-abstraction-modes page lists exactly three live modes — unified account,
    // portfolio margin, and **"Manual / Standard (recommended for market makers, high
    // volume automated users, and deployers/builders)"** — and says on the same page that
    // "builder code addresses must be in standard mode to accrue builder fees".
    //
    // Which API value is that? The *setter* answers it, not the reader: `userSetAbstraction`
    // (and `agentSetAbstraction`, whose `"i" | "u" | "p"` are documented as exactly these)
    // accepts `disabled | unifiedAccount | portfolioMargin` and nothing else. Three
    // settable values, three live modes, so `disabled` IS Manual/Standard — it is the only
    // way to choose that mode deliberately.
    //
    // `default` is therefore a read-only state: an account that has never set a mode. It
    // behaves as standard and is accepted here too. (Probed 2026-09-09: an address that
    // has never touched Hyperliquid reads `default`; our builder wallet read `disabled`
    // after its owner picked Manual in the UI.)
    //
    // This check previously required `default` alone, on the guess that it was what the
    // docs' "standard" meant. That guess rejected the one value a builder can actually be
    // set to. notes/2026-09-09-builder-fee-built.md §4.
    const okMode = bAbs === "disabled" || bAbs === "default";
    console.log(`builder:   ${rail.b} — perp $${bPerp.toFixed(2)}, abstraction ${bAbs} ` +
      `(rate decided ${BUILDER_FEE.decidedAt}, required of connections from ` +
      `${BUILDER_FEE.requiredForConnectionsFrom.slice(0, 10)})`);
    if (okEquity && okMode) {
      console.log("           OK — eligible to collect builder fees");
    } else {
      console.log("           🔴 NOT ELIGIBLE. The venue rejects every order carrying this");
      console.log("           builder code, on every account that approved it, at once.");
      if (!okEquity) {
        console.log(`           · needs >= $${BUILDER_FEE.builderMinPerpEquityUsd} of PERP account value, has $${bPerp.toFixed(2)}`);
        console.log("             (spot USDC does not count here, even on a unified account)");
      }
      if (!okMode) {
        console.log(`           · needs 'standard' abstraction mode, is '${bAbs}'`);
      }
      console.log("           Nothing is broken while no account has approved — the code is");
      console.log("           attached to nobody. It breaks for the FIRST person who signs.");
    }
  }

  // A clean start is what makes the accounting sound: a non-empty account is rejected.
  let positions = 0;
  let orders = 0;
  for (const dex of universe.dexes) {
    const arg = dex === "" ? { user: master } : { user: master, dex };
    positions += (await info.clearinghouseState(arg)).assetPositions.filter((p) => Number(p.position.szi) !== 0).length;
    orders += (await info.frontendOpenOrders(arg)).length;
  }
  console.log(`account:   ${positions} open position(s), ${orders} resting order(s) — ` +
    `${positions + orders === 0 ? "clean" : "NOT CLEAN, connect would be rejected"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
