import assert from "node:assert/strict";
import { test } from "node:test";
import { correlatedStopOfMandate, haltDistance } from "../../src/risk/halt.ts";
import { DEFAULT_USER_SETTINGS, maxConcurrentSignals, minFundedForLiveUsd, RISK_PARAMS } from "../../src/risk/params.ts";
import { bookShape } from "../../src/risk/ledger.ts";
import { SITE_OFFERS } from "../../src/web/discovery.ts";
import { designPage } from "../../src/web/page.ts";
import { limitsMath, limitsNote } from "./limits.ts";
import { seedForNewConnect } from "../../src/web/connect.ts";

/** What the page's sliders must start on: the value a new connection's omitted fields
 *  would fall back to. `blockComplete: false` is the conservative arm — the one that can
 *  differ from the shipped default — so pinning the markup here catches the divergence
 *  in whichever direction it happens. */
const SEED = seedForNewConnect({ blockComplete: false });

const near = (a: number, b: number, msg?: string) => assert.ok(Math.abs(a - b) < 1e-9, msg ?? `${a} ≠ ${b}`);

// The connect screen keeps its own copy of the multiplication because it recomputes on
// every slider drag. This is what stops that copy drifting from the server's: the
// sentence somebody reads before connecting and the one the desk shows them afterwards
// come out of the same arithmetic.
test("the connect screen's stop-out and halt count are the server's, at the defaults", () => {
  const d = DEFAULT_USER_SETTINGS;
  const page = limitsMath({
    baseUsd: 100, perPct: d.perSignalPct * 100, leverage: d.leverage, stopPct: d.stopPct * 100,
    stopOn: d.stopLoss, clampPct: 6.2, dailyLossPct: RISK_PARAMS.dailyLossPct,
    minNotionalUsd: RISK_PARAMS.minOrderNotionalUsd, reserveFrac: RISK_PARAMS.reserveFrac,
  });
  const server = haltDistance(d, 100, null);
  near(page.lossUsd, server.stopOut.usd);
  near(page.stopsToHalt, server.stopsToHalt);
  near(page.floorUsd, minFundedForLiveUsd(d));
  // $9.90, not $10: sizing runs off the mandate less the 1% reserve (`tasks/21` §6).
  near(page.marginUsd, 9.90);
  near(page.notionalUsd, 99);
});

// The pair `tasks/21` added, pinned the same way. The count and the correlated stop are
// on the card, so a copy that drifts would put a false number in front of an owner
// deciding how much of their mandate to expose.
test("the connect screen's position count and correlated stop are the server's", () => {
  // Read from the constant, never typed as a literal: this test exists to stop the
  // page's copy of the arithmetic drifting from the server's, and a hardcoded stop
  // percentage here is the drift it is supposed to catch. It was `stopPct: 3` until the
  // default moved to 1% on 2026-09-10, at which point it was comparing two different
  // settings and calling the difference a bug in the page.
  const d = DEFAULT_USER_SETTINGS;
  const page = (perPct: number) => limitsMath({
    baseUsd: 1000, perPct, leverage: d.leverage, stopPct: d.stopPct * 100, stopOn: d.stopLoss, clampPct: 6.2,
    dailyLossPct: RISK_PARAMS.dailyLossPct, minNotionalUsd: RISK_PARAMS.minOrderNotionalUsd,
    reserveFrac: RISK_PARAMS.reserveFrac,
  });
  for (const perPct of [5, 10, 15, 20, 25]) {
    const s = { ...DEFAULT_USER_SETTINGS, perSignalPct: perPct / 100 };
    assert.equal(page(perPct).positions, maxConcurrentSignals(s), `${perPct}%: position count`);
    near(page(perPct).correlatedStopOfMandate, correlatedStopOfMandate(s), `${perPct}%: correlated stop`);
    near(page(perPct).deployedUsd, bookShape(1000, s).deployedAtFullUsd, `${perPct}%: deployed`);
  }
  // `tasks/21` §4's headline, restated at each default the desk has run: **20% of the
  // mandate at the 2% stop** against a 10% halt, where at 1% it was 10% and at 3% it was
  // 30%. The figure is `stopPct × leverage`, so it tracks the default exactly.
  // ⚠ This used to end *"and at 2.0× the halt `checkCapConsistency` warns at the shipped
  // defaults again"* — it does not. The rounded 20 here is before the 1% reserve; the
  // check compares **19.8%** against a strict `> 20%` and stays silent
  // (`src/risk/ledger.test.ts` asserts it, `tasks/46` §4).
  assert.equal(Math.round(page(10).correlatedStopOfMandate * 100), 20);
});

test("and with the stop off, where one position's whole margin is the day's allowance", () => {
  const d = { ...DEFAULT_USER_SETTINGS, stopLoss: false };
  const page = limitsMath({
    baseUsd: 100, perPct: 10, leverage: 10, stopPct: 3, stopOn: false, clampPct: 6.2,
    dailyLossPct: RISK_PARAMS.dailyLossPct, minNotionalUsd: RISK_PARAMS.minOrderNotionalUsd,
    reserveFrac: RISK_PARAMS.reserveFrac,
  });
  const server = haltDistance(d, 100, null);
  near(page.lossUsd, server.stopOut.usd);
  near(page.stopsToHalt, server.stopsToHalt);
  // It was exactly 1 until `tasks/21`: a stopless position at 10% lost the whole 10% a
  // day is allowed. Off the budget it loses 9.9%, so it now takes 1.01 of them and a
  // single one no longer *quite* pauses the account. The card rounds to "about 1.0",
  // which is true; the assertion carries the exact figure so the drift is visible if
  // the reserve ever moves.
  near(page.stopsToHalt, 1 / (1 - RISK_PARAMS.reserveFrac));
});

// ── which warning the card shows (`tasks/30` §3) ──────────────────────────────────
//
// The thresholds are shared so the connect screen and the desk cannot disagree about
// which sentence an owner reads. They disagreed with the *arithmetic* until now: both
// files branched on `stopsToHalt < 2` and rendered "Two bad days would pause you", so
// an owner at 0.63 — one stopped position — was told two days. The account that hit
// the daily-loss cap on 2026-09-08 read that sentence at 06:01:47Z, at the moment it
// chose 0.63 (`notes/2026-09-09-daily-loss-halt-first-fire.md` §3.2).

test("one stopped position and two bad days are different sentences, and the boundary is 1", () => {
  const at = (stopsToHalt: number) => limitsNote({ underFloor: false, stopsToHalt, stopOn: true });
  // Exactly at a boundary belongs to the *looser* sentence: 1.0 stopped positions does
  // not pause on one, and 2.0 is not "two bad days would".
  assert.equal(at(0.63), "one-pauses");
  assert.equal(at(0.999), "one-pauses");
  assert.equal(at(1), "two-pause");
  assert.equal(at(1.999), "two-pause");
  assert.equal(at(2), "ok");
});

// Under the floor nothing trades at all, which beats every warning about trading badly
// — including the new one, and including with the stop off.
test("under the floor still comes first, and the no-stop warning still comes last", () => {
  assert.equal(limitsNote({ underFloor: true, stopsToHalt: 0.4, stopOn: true }), "under-floor");
  assert.equal(limitsNote({ underFloor: true, stopsToHalt: 40, stopOn: false }), "under-floor");
  // A stopless position loses its whole margin, so `stopsToHalt` falls under 1 at every
  // size above ~10% — the loud sentence is the halt, not the missing stop.
  assert.equal(limitsNote({ underFloor: false, stopsToHalt: 0.4, stopOn: false }), "one-pauses");
  assert.equal(limitsNote({ underFloor: false, stopsToHalt: 40, stopOn: false }), "no-stop");
});

// The count the incident note put a number on, recomputed here from the server's own
// arithmetic rather than from the note's table — so the copy branch is pinned to the
// thing it describes. The grid is the one §3.1 counted (whole-percent stops, 5% size
// steps); the sliders are finer than that, so 120 is a sample of the offered space and
// not its size.
// ⚠ **160 and 43 since 2026-09-12, not 120 and 26.** Adding 18× (item 25) adds 40 cells
// to the offered grid and **17 of them pause on a single stopped position** — every 18×
// row from a 3% stop upward at 15% per signal or more. That is a real widening of the
// warned region and it is recorded rather than waved at.
//
// Two things keep it honest. The owner is *told*: every one of the 17 renders
// "one-pauses", which the assertion below checks cell by cell. And most of those stops
// cannot actually arm — `clampStopPct` caps 18× at 2.14% on a 20×-max asset and 3.01% on
// a 40×-max one — so an 8%/18× cell is counting a slider position, not a trade. That was
// already true of 20×, where 8% arms 1.75%, and it is why the grid is a sample of the
// offered space rather than a risk measurement.
test("43 of the 160 offered combinations get the single-position sentence", () => {
  let below1 = 0, total = 0;
  for (const leverage of SITE_OFFERS.leverage) {
    for (let stopPct = 1; stopPct <= 8; stopPct++) {
      for (let perPct = 5; perPct <= 25; perPct += 5) {
        total++;
        const s = { ...DEFAULT_USER_SETTINGS, leverage, stopPct: stopPct / 100, perSignalPct: perPct / 100 };
        const n = haltDistance(s, 100, null).stopsToHalt;
        const note = limitsNote({ underFloor: false, stopsToHalt: n, stopOn: true });
        if (n < 1) {
          below1++;
          assert.equal(note, "one-pauses", `${leverage}x ${stopPct}% ${perPct}%: ${n} pauses on one`);
        } else {
          assert.notEqual(note, "one-pauses", `${leverage}x ${stopPct}% ${perPct}%: ${n} does not`);
        }
      }
    }
  }
  assert.equal(total, 8 * 5 * SITE_OFFERS.leverage.length, "whole-percent stops x 5% size steps x each offered leverage");
  assert.equal(total, 160);
  assert.equal(below1, 43, "26 of 120 before 18x was offered; the 17 new ones are all 18x");
  // The default is nowhere near it, which is the other half of why this shipped unnoticed.
  assert.equal(limitsNote({
    underFloor: false, stopsToHalt: haltDistance(DEFAULT_USER_SETTINGS, 100, null).stopsToHalt, stopOn: true,
  }), "ok");
});

// ── the controls a new owner is handed ────────────────────────────────────────────
//
// The connect screen's sliders start somewhere, and where they start is what most
// accounts will be traded on: the page posts every setting explicitly, so a slider left
// alone is a choice the server stores as one. That makes the markup a copy of
// `DEFAULT_USER_SETTINGS` — and on 2026-09-10 it was the copy that did not move. The
// default stop went 3% → 1% in `src/risk/params.ts`, nine tests were re-derived against
// the constant, and `design/views/connect.html` still shipped `value="3"`, so every
// account connecting after that change would have been armed at the old default while
// every surface that quotes a default said 1%.
//
// Reading it out of the assembled page is the only place a browser's starting position
// and a server's constant can be compared at all.

test("the connect screen's limits start on the shipped defaults, and offer what the site offers", () => {
  const page = designPage();
  const attr = (id: string, name: string) => {
    const tag = new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(page)?.[0];
    assert.ok(tag, `no <input id="${id}"> in the assembled page`);
    return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  };

  // The stop: where it starts, and the range around it. `min`/`max` are the same offer
  // `parseSettings` enforces server-side, so a slider that outran them would refuse.
  //
  // ⚠ **The starting value is pinned to the SEED, not to the shipped default**
  // (`tasks/47` Rule 4, first part). A new connection's omitted fields fall back to
  // `DEFAULT_USER_SETTINGS_LAST_TESTED` while the shipped default is still inside its own
  // first block — but the page posts every slider explicitly, so a page still showing the
  // new default would hand a stranger the untested value through the markup while the
  // server-side seed sat there doing nothing. The two are equal today and this is the
  // tripwire for the day they are not.
  assert.equal(Number(attr("sp", "value")), SEED.stopPct * 100);
  assert.equal(Number(attr("sp", "min")), SITE_OFFERS.stopPct.min * 100);
  assert.equal(Number(attr("sp", "max")), SITE_OFFERS.stopPct.max * 100);
  // The figure printed beside it, which is what somebody actually reads before the first
  // slider drag repaints it.
  assert.match(page, new RegExp(`id="sv"[^>]*>${(SEED.stopPct * 100).toFixed(1)}%<`));

  assert.equal(Number(attr("ps", "value")), SEED.perSignalPct * 100);
  assert.equal(Number(attr("ps", "min")), SITE_OFFERS.perSignalPct.min * 100);
  assert.equal(Number(attr("ps", "max")), SITE_OFFERS.perSignalPct.max * 100);
  assert.match(page, new RegExp(`id="pv"[^>]*>${(SEED.perSignalPct * 100).toFixed(0)}%<`));

  // Leverage is a button per offered value, with the default the pressed one.
  const seg = /<div class="seg" id="lev"[\s\S]*?<\/div>/.exec(page)?.[0] ?? "";
  assert.deepEqual(
    [...seg.matchAll(/data-l="(\d+)"/g)].map((m) => Number(m[1])),
    [...SITE_OFFERS.leverage],
  );
  assert.match(seg, new RegExp(`data-l="${DEFAULT_USER_SETTINGS.leverage}" aria-pressed="true"`));

  // The stop is on by default, and the exit policy is the one being measured.
  assert.match(page, /<input type="checkbox" id="stopon" checked>/);
  assert.equal(DEFAULT_USER_SETTINGS.stopLoss, true);
  assert.equal(DEFAULT_USER_SETTINGS.holdToTarget, false);
  assert.match(page, /<button data-h="0" aria-pressed="true">/);
});
