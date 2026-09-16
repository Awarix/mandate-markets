# Mandate Markets

Non-custodial infrastructure for automated trading on **Hyperliquid** — and, next,
**Polymarket**. You connect an account you already own and approve a key that can trade
it but can **never withdraw from it**. You pick three numbers once — leverage, stop size,
and how much of the account one position may use — and the desk does the rest, 24/7.

Live on Hyperliquid mainnet since **30 August 2026**, trading real money in accounts that
are not ours. The product is at **https://mandate.markets**.

Today the forecasts come from [Quotient](https://quotient.social). The execution, sizing
and risk layer is provider-agnostic on purpose: a second forecast or strategy provider is
a new file in `src/mapping/`, not a change to the executor.

## What it actually does, per signal

1. Map the forecast to an exact venue market. **Unknown mapping → reject.** Never fuzzy-match.
2. Check the account's real state on the venue — positions, margin, free collateral. Never cached across a decision.
3. Size from a mandate the user agreed to, on **isolated margin**, and clamp the stop to a safe fraction of the distance to liquidation.
4. Send the entry alone as **IOC**, read what actually filled, and only then rest **reduce-only stop and take-profit triggers on the venue** for exactly the size that exists. Venue-side, so the protection survives our process dying.
5. Tag every order with our own client order id. Anything on the account we did not create **halts that account**.
6. Exit when the forecast turns neutral, a level is hit, or the horizon expires.

Every bound on the downside is a fraction in version control rather than a judgement
call: isolated margin per position, a position count that follows the position size
(`floor(1 / perSignalPct)`), at most the mandate less a 1% reserve deployed at once, and a
halt for the day after a 10% loss. The same fractions bind on $50 and on $50,000.

**We are not the forecaster, and we do not claim the signals make money.** That is measured
from the live ledger, and the sample is still too small to say. What we sell is the
execution and the risk control.

## Reading order

1. `src/exec/loop.ts` — `tick()` is the whole state machine, and it is a pure function of its inputs.
2. `src/risk/params.ts` — every number that affects money, each one carrying the argument for its value.
3. `src/broker.ts` and `src/hl/` — the venue seam, and the Hyperliquid adapter behind it.
4. `src/mapping/quotient.ts` — the only file that knows the forecast provider's field names.
5. `src/store/` — the intent ledger: which signal opened which position, and what the plan was.

## Design notes worth knowing

- **Two sources of truth, deliberately split.** The venue is authoritative for *facts*
  (positions, fills, margin). The SQLite ledger is authoritative for *intent* — which
  signal opened which position and what the plan was.
- **One tick is a pure function.** `src/exec/loop.ts:tick()` takes account truth plus
  signals and returns a desired order set; it diffs against what is resting and emits only
  the delta. Every step is idempotent, so a cold start after a kill mid-position re-derives
  the same state.
- **Paper and live run the same loop.** `src/exec/paper.ts` is a simulated book marked
  against live prices. Its P&L is a correctness signal, not a return — it models no fees,
  funding, queue position or partial fills. Returns are only ever measured from real fills.
- **A second venue is a new stack, not a second `Broker`.** `Broker` is perp-shaped;
  Polymarket gets `src/pm/` alongside `src/hl/`.

## Running it

```sh
npm install
npm run typecheck        # clean
npm test                 # node:test, ~2s
```

The executor needs an `.env` (venue network, keystore passphrase path, and the safety
switches that gate a live order). It is not published; `DRY_RUN` defaults to true, so
nothing here can place an order on its own.

## About this repository

This is a **public mirror** of the working repository, trimmed for publication. It is the
whole product, not a hackathon slice.

Not published here:

- `fixtures/` — captured Quotient and Polymarket payloads. They are another company's data
  and ours to read, not to redistribute.
- `accounts/` — real users' wallet addresses. Every address surviving in a code comment or
  a doc has been replaced by a valid synthetic one of the same shape, so no on-chain account
  is identifiable from this repo.
- `deploy/`, `.env.example` — the server configuration, the operator runbook, and the environment contract.
- `docs/` — the product and architecture write-ups.
- `notes/` and `tasks/` — 121 findings notes and 53 task files that are the project's
  internal record, including live P&L.

Markdown and code comments still *cite* those paths, so some references point at files you
will not find here. Two consequences are visible when you run the suite:

- Eight test files read a committed capture from `fixtures/` and cannot load without it.
  **850 of 859 remaining tests pass**; `npm run typecheck` is clean.
- `src/risk/regimes.test.ts` asserts that **every feed-regime boundary cites a findings note
  that still exists on disk** — a guard against a constant somebody just typed. Without
  `notes/`, it fails here. In the working repository the full suite is 1012 tests, green.

If you are judging this and want the complete tree, ask on Telegram: **@ixarix**.
