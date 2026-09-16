import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { HaltKind, LivePosition, Skip, TradeIntent } from "../types.ts";
// The one exception to "only `mapping/quotient.ts` knows Quotient's shapes", and it is
// narrow on purpose: this is not a field name, it is the shape of an id **this table
// already stores**, and the migration below has to agree with the executor about it
// exactly. Two copies of that rule is one copy that drifts, in the column that decides
// whether an open position is still being called.
import { stableOutlookKey } from "../mapping/quotient.ts";

// The intent ledger. **Our database is authoritative for intent** — which signal
// opened which position, what the plan was, what we are still waiting on. Hyperliquid
// stays authoritative for facts.
//
// OutcomeMaker had no intent store at all: everything was re-derived from exchange
// state each loop, so "why is this position open" was unanswerable and P&L attribution
// needed forensic scripts written weeks after the money was gone. Recording intent
// from day one is the cheapest thing in this repo and the one whose absence cost the
// most.
//
// `node:sqlite` ships with Node 24, so this adds no dependency. Run with
// `--disable-warning=ExperimentalWarning` (the npm scripts do).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signals (
  signal_ref     TEXT NOT NULL,
  revision       INTEGER NOT NULL,
  first_seen_at  TEXT NOT NULL,
  coin           TEXT,
  side           TEXT,
  mode           TEXT,
  strength       TEXT,
  displacement_sigma REAL,
  target_px      REAL,
  horizon_at     TEXT,
  raw            TEXT NOT NULL,
  PRIMARY KEY (signal_ref, revision)
);

CREATE TABLE IF NOT EXISTS intents (
  intent_id      TEXT PRIMARY KEY,
  account        TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  provider       TEXT NOT NULL,
  signal_ref     TEXT NOT NULL,
  signal_revision INTEGER NOT NULL,
  coin           TEXT NOT NULL,
  side           TEXT NOT NULL,
  leverage       INTEGER NOT NULL,
  margin_usd     REAL NOT NULL,
  size_abs       REAL NOT NULL,
  ref_px         REAL NOT NULL,
  target_px      REAL,
  stop_px        REAL,
  horizon_at     TEXT NOT NULL,
  -- The exit policy this position opened under, frozen like its leverage and its stop.
  -- 0 closes when Quotient goes neutral on the call; 1 holds to target, stop or horizon.
  -- Existing rows migrate to 0, which is what every trade in the ledger was run under.
  hold_to_target INTEGER NOT NULL DEFAULT 0,
  -- When Quotient first stopped calling a direction here, under either policy. NULL
  -- means it never did. Under hold_to_target the close reason cannot carry this, so
  -- without the column the two exit policies stop being comparable on live trades.
  withdrawn_at   TEXT,
  -- When Quotient first published the OPPOSITE side on this outlook while we held it.
  -- NULL means it never did. Separate from withdrawn_at on purpose: a neutral turn and
  -- a reversal are different facts about the forecast, and pooling them would make the
  -- rarer one unfindable (tasks/44 section 3.1). Under the default policy the position
  -- closes as 'flipped' and this is stamped on the way out; under hold_to_target the
  -- position stays and this column plus a 'side-flipped' skip row are the only record.
  flipped_at     TEXT,
  -- When this position's exit landed nearer its stop than its target, on a trigger we
  -- did not place. NULL means it did not, or that nothing has decided yet. This is NOT
  -- an attribution and must never be read as one: close_reason is where the exit is
  -- named, from the venue's own fill rows, and settleLedger's objection stands -- a
  -- wick that touched both levels cannot be told apart from the mark alone. This
  -- column answers the only question blockReentryAfterStop actually asks, which is
  -- whether the price was on the losing side when we left, and it answers it inside
  -- the tick that closes rather than whenever the fill ingest next runs (tasks/51
  -- section 5a).
  stopped_at     TEXT,
  rationale      TEXT NOT NULL,
  status         TEXT NOT NULL,          -- pending | open | closing | closed | failed
  entry_px       REAL,
  filled_sz      REAL NOT NULL DEFAULT 0,
  closed_at      TEXT,
  close_reason   TEXT,
  -- The ESTIMATE. Kept, deliberately, rather than being replaced by net_pnl below:
  -- the difference between the two is how wrong the estimate is, which is a number
  -- tasks/07 wants and which nobody could produce once the estimate was gone.
  realized_pnl   REAL,
  -- Settled from fills and funding once the venue's own rows are in. NULL until
  -- then; pnl_note says why when it stays NULL.
  fee_usd        REAL,
  funding_usd    REAL,
  net_pnl        REAL,
  pnl_note       TEXT,
  -- The price path this trade lived through, summarised once and kept (tasks/31 section 5).
  -- Not a fact about the trade: a fact about the candles, computed after it closed, so
  -- nothing in the decision path may read these -- same rule as fills and funding.
  --
  -- They exist because the evidence was decaying. candleSnapshot caps at ~5000 rows, so
  -- 1m candles reach 3.5 days and a trade older than that becomes unreplayable:
  -- exit-policy's sample shrank 12 -> 9 on an unchanged ledger. Summarising at close
  -- turns a decaying question into an accumulating one.
  cf_at              TEXT,   -- when the summary was computed; NULL means not yet
  cf_interval        TEXT,   -- the candles it rests on: 1m, or 5m for an old backfill
  -- Worst price seen against the position over the window it was actually held. The
  -- maximum adverse excursion, in price; stop-sweep's drawdown table is this column.
  cf_mae_px          REAL,
  -- The same, but only up to and including the first candle that touched the target.
  -- This is the one that reproduces replay's first-touch rule for *any* stop level: a
  -- stop fires first exactly when it sits at or inside this price. Equal to cf_mae_px
  -- whenever the target was never touched, which is the usual case.
  cf_mae_to_target_px REAL
);
CREATE INDEX IF NOT EXISTS intents_open ON intents (account, status);
CREATE INDEX IF NOT EXISTS intents_signal ON intents (signal_ref);

CREATE TABLE IF NOT EXISTS orders (
  cloid          TEXT PRIMARY KEY,
  intent_id      TEXT NOT NULL,
  role           TEXT NOT NULL,          -- entry | tp | sl | close
  coin           TEXT NOT NULL,
  is_buy         INTEGER NOT NULL,
  px             REAL NOT NULL,
  trigger_px     REAL,
  sz             REAL NOT NULL,
  reduce_only    INTEGER NOT NULL,
  placed_at      TEXT NOT NULL,
  oid            INTEGER,
  status         TEXT NOT NULL,          -- placed | filled | cancelled | rejected
  detail         TEXT
);
CREATE INDEX IF NOT EXISTS orders_intent ON orders (intent_id, status);

-- Every skip records its reason. A user seeing "3 signals skipped: no budget"
-- understands the caps are working; a user seeing nothing assumes we are broken.
--
-- **One row per decision, not one row per tick.** This was an append-only log written
-- once per signal per 60s loop, with nothing deduping it and no retention anywhere.
-- On the live ledger that was 13,584 rows covering 74 distinct signals: the desk told
-- one account it had skipped 6,363 signals when the number was 73, and ranked reasons
-- by how *long* each persisted rather than by how many signals each stopped. A signal
-- sitting below the sigma gate for a day contributed 1,440 rows and buried the one
-- refused for no budget. Collapsed to this shape those 13,584 rows become **174**.
--
-- The key is (account, signal_ref, reason) and deliberately NOT (…, revision, …),
-- which is what tasks/10 specified. Measured over 72h of archive, the vendor publishes
-- 14.5 revisions per outlook, so keying on revision would have written 4,010 rows per
-- account per three days — the same growth rate as the per-tick log it replaces, once
-- the two previously-suppressed reasons are added. It would also show a person 14 rows
-- saying "the move was too small" about one forecast, which is the vendor's
-- republication cadence and not a unit anybody thinks in. The revision *range* is kept
-- on the row instead, so "refused across revisions 213-227" is still answerable, and a
-- reason that CHANGES between revisions still gets its own row, which is the case
-- worth seeing.
CREATE TABLE IF NOT EXISTS skips (
  account        TEXT NOT NULL,
  signal_ref     TEXT NOT NULL,
  reason         TEXT NOT NULL,
  coin           TEXT,
  first_at       TEXT NOT NULL,
  last_at        TEXT NOT NULL,
  -- 0 on rows collapsed from the pre-2026-09-02 log, which had no revision column.
  first_revision INTEGER NOT NULL,
  last_revision  INTEGER NOT NULL,
  seen_count     INTEGER NOT NULL,
  -- From the latest sighting: a detail that quotes a live sigma or a free-collateral
  -- figure is only interesting as of the last time we looked.
  detail         TEXT NOT NULL,
  PRIMARY KEY (account, signal_ref, reason)
);
CREATE INDEX IF NOT EXISTS skips_last ON skips (account, last_at);

-- What a trade actually cost. **intents.realized_pnl is an estimate and this is not.**
--
-- The estimate is (exit price - entry price) x size with the exit's *armed* price
-- standing in for the price it filled at, and no fees and no funding at all
-- (src/exec/loop.ts logs it as P&L ~). Measured against these tables on the live
-- ledger 2026-09-02, it was out by $3.35 across 18 closed intents -- and out in the
-- *pessimistic* direction, which was the opposite of what tasks/08 predicted. The
-- reason is that the dominant error is not the missing costs: a forced close is an
-- IOC placed a slippage band away from the mark, so the estimate charges 30bps of
-- notional that was never paid, while the fee it omits is 0.864bps on an xyz:
-- market. The wrong term was 35x the missing one.
--
-- Rows here are the venue's own. tid is Hyperliquid's unique id for one partial
-- fill, which is what makes ingestion idempotent across restarts and re-fetches.
CREATE TABLE IF NOT EXISTS fills (
  account        TEXT NOT NULL,
  tid            INTEGER NOT NULL,
  time           INTEGER NOT NULL,      -- ms since epoch, the venue's clock
  coin           TEXT NOT NULL,
  side           TEXT NOT NULL,         -- B | A, as HL spells it
  dir            TEXT NOT NULL,         -- Open Long | Close Short | ...
  px             REAL NOT NULL,
  sz             REAL NOT NULL,
  -- Gross, and carried by the CLOSING leg only: an opening fill reports 0.0.
  -- Verified against 49 live fills, 2026-09-02.
  closed_pnl     REAL NOT NULL,
  -- Positive means charged. The SDK types a negative as a rebate; no live fill has
  -- produced one, maker fills included, so it is subtracted either way and a negative
  -- would simply add back.
  fee            REAL NOT NULL,
  fee_token      TEXT NOT NULL,
  crossed        INTEGER NOT NULL,      -- 1 = we took liquidity
  oid            INTEGER,
  cloid          TEXT,
  hash           TEXT,
  intent_id      TEXT,                  -- NULL unless attribution found one
  -- cloid | oid | liquidation | foreign | out-of-scope. foreign is a fill on a market
  -- we manage that carries none of our tags: a second actor. out-of-scope is a market
  -- outside RISK_PARAMS.tradedDexes -- spot, another HIP-3 dex -- which we never
  -- claimed to watch and must not halt on.
  attribution    TEXT NOT NULL,
  -- The venue's own liquidation object, verbatim, as JSON; NULL on every ordinary
  -- fill. Hyperliquid puts it on the closing fill it generated itself:
  --   {"liquidatedUser":"0xdaa2…","markPx":"6.6372","method":"market"}
  --
  -- We ingested past this field until 2026-09-13, and three separate wrong answers came
  -- out of the one fill it was on (notes/2026-09-10-liquidation-and-the-stop-that-did-
  -- not-fill.md). It carries no cloid, so attribution read 'foreign' and the account
  -- halted saying it had a second actor -- there was none. close_reason recorded
  -- 'retired', so the worst outcome this system can produce counted as an ordinary
  -- exit. And nothing attributed the fill to an intent, so net_pnl stayed NULL on a
  -- -$15.75 trip whose estimate said -$11.36: the board was ~$16 wrong on that account
  -- and 'npm run expectancy' could not see the trade at all.
  --
  -- Stored as the venue served it rather than as a flag, because the method and the
  -- mark are the evidence that it was a liquidation and not our own close. The venue
  -- is authoritative for facts and we already had this fact; we simply did not keep it.
  liquidation    TEXT,
  PRIMARY KEY (account, tid)
);
CREATE INDEX IF NOT EXISTS fills_intent ON fills (intent_id);
CREATE INDEX IF NOT EXISTS fills_account_time ON fills (account, time);

-- Funding, which is charged hourly against an open position and is therefore not
-- attributable to any fill. Its own row type for exactly that reason.
--
-- usdc is signed from the account's side: positive is received, negative is paid.
-- Verified 2026-09-02 -- a short in a positive funding regime showed +0.001244 on a
-- $99.51 notional at a 0.0000125 hourly rate, and the long alongside it showed the
-- matching negative.
CREATE TABLE IF NOT EXISTS funding (
  account        TEXT NOT NULL,
  time           INTEGER NOT NULL,
  coin           TEXT NOT NULL,
  usdc           REAL NOT NULL,
  szi            REAL NOT NULL,
  funding_rate   REAL NOT NULL,
  intent_id      TEXT,
  PRIMARY KEY (account, coin, time)
);
CREATE INDEX IF NOT EXISTS funding_intent ON funding (intent_id);

-- How far each stream has been ingested, per account. A restart resumes rather than
-- refetching, and -- more importantly -- the first ingest of an account is a
-- *backfill*, which must never halt it for foreign fills that predate us watching.
CREATE TABLE IF NOT EXISTS ingest_watermark (
  account     TEXT NOT NULL,
  stream      TEXT NOT NULL,            -- fills | funding
  last_time   INTEGER NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (account, stream)
);

CREATE TABLE IF NOT EXISTS events (
  at             TEXT NOT NULL,
  account        TEXT NOT NULL,
  kind           TEXT NOT NULL,
  detail         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_at ON events (at);

CREATE TABLE IF NOT EXISTS accounts (
  account          TEXT PRIMARY KEY,
  connected_at     TEXT NOT NULL,
  -- The mandate. What the account held when it connected, in full; re-read from the
  -- venue at the owner's request when nothing is open, and never while anything is
  -- (applyMandate). Frozen under every open position.
  base_capital     REAL NOT NULL,
  -- Frozen into each position at open (the intent row carries its own terms) and
  -- changeable between positions (applySettings).
  settings         TEXT NOT NULL,
  mode             TEXT NOT NULL,        -- live | paper
  halted           INTEGER NOT NULL DEFAULT 0,
  halt_reason      TEXT,
  -- WHICH KIND of halt, so that nothing has to substring-match the reason to find out.
  -- daily-loss | foreign-position | foreign-order | liquidation | operator.
  --
  -- tasks/30 section 1: the desk offers the owner a Clear button for a daily-loss halt
  -- and deliberately not for the others, and branching on prose would be the exact
  -- fuzzy-matching CLAUDE.md refuses everywhere else -- the rule that exists because a
  -- substring match bought the wrong market and cost $192.
  --
  -- NULL means a halt that fired before this column existed. It is NOT backfilled from
  -- the reason text: guessing a kind out of a sentence is the thing the column removes.
  -- An untyped halt is operator-only on the desk, and tick() writes the kind in on the
  -- next loop where the same condition still holds.
  halt_kind        TEXT,
  day              TEXT,
  day_start_equity REAL,
  -- When the settings and the mandate last changed. A request from the web that is
  -- older than this is spent: the executor cannot delete a request, so the comparison
  -- is what makes each one apply exactly once (src/exec/change-queue.ts). Seeded from
  -- connected_at on rows that predate the columns.
  settings_at      TEXT,
  mandate_at       TEXT
);

-- What a disconnect must NOT reset.
--
-- disconnectAccount deletes the account row, and that is deliberate: reconnecting is
-- the documented way to re-freeze baseCapital at a new deposit (ACCOUNT-MODEL.md §2),
-- so the row has to be rebuilt from scratch. But the row also carried the day's risk
-- state, and deleting that made unlink-then-reconnect a way to clear a halt and rebase
-- the daily-loss baseline -- a two-minute, self-service bypass of the only cap that
-- stops a bad day compounding. governor.ts calls those halts "sticky", meaning they
-- outlive the condition that caused them; stickiness lived in a row the user could
-- delete.
--
-- So capital and settings reset on reconnect, and this does not. An unlink is a pause
-- in management, not a reset of risk.
CREATE TABLE IF NOT EXISTS account_risk_state (
  account          TEXT PRIMARY KEY,
  saved_at         TEXT NOT NULL,
  halted           INTEGER NOT NULL,
  halt_reason      TEXT,
  -- Carried for the same reason the reason is: an unlink pauses management, it does
  -- not clear a halt, and it must not launder a foreign-actor halt into an untyped one
  -- that the desk would then offer a Clear button for.
  halt_kind        TEXT,
  -- The UTC day the baseline belongs to. rollDay resets the baseline when this is not
  -- today, so carrying it across a same-day reconnect is what stops the rebase, and
  -- carrying it across a day boundary costs nothing.
  day              TEXT,
  day_start_equity REAL
);

-- Accounts joining through the web tier. Written ONLY by the executor: the web
-- process opens this database read-only, so it can ask for a connection but cannot
-- grant itself one. Its half of the conversation is connection_requests in
-- data/web.sqlite, which the executor reads read-only in turn -- each process writes
-- exactly one database and reads the other's.
CREATE TABLE IF NOT EXISTS connections (
  account        TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  -- awaiting_approval: we hold a sealed agent key and the user has not approved it
  -- on Hyperliquid yet. active: the executor has connected it.
  status         TEXT NOT NULL,
  agent_address  TEXT,
  settings       TEXT NOT NULL,
  -- Why the last connect attempt failed, in the user's terms. Shown on their screen.
  last_error     TEXT,
  -- The Hyperliquid referral code this account's owner asked us to apply, or NULL if
  -- they skipped (tasks/37 §7.5). Copied here from the web tier's request because the
  -- agent that signs setReferrer is only known to this process, and connectAccount is
  -- the one moment both the agent and the funding exist. Never a code we chose: it is
  -- null unless somebody pressed a button, and applyReferral re-reads the venue and
  -- refuses to overwrite a slot that is already spent.
  referral_code  TEXT
);
-- Who has been let into the connect flow (tasks/17). Written ONLY by the executor,
-- like connections: the web tier records that somebody asked for access, and this is
-- the answer. It is a grant of *entry*, never of live trading — an admitted account
-- still has to pass every check in resolveMode, and the account cap still binds it.
--
-- expires_at is what stops an admission holding a slot forever. Somebody admitted and
-- never seen again would otherwise keep a place that the person behind them could
-- have used, and the queue would drain into a set of held-open doors.
CREATE TABLE IF NOT EXISTS admissions (
  account     TEXT PRIMARY KEY,
  admitted_at TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  -- queue: the front of the queue when a slot was free. operator: someone on the box.
  reason      TEXT NOT NULL
);

-- Paper mode's simulated book. Kept in the same database precisely so that a forced
-- restart mid-position is a real test of restart-safety rather than a fresh start.
CREATE TABLE IF NOT EXISTS paper_positions (
  account    TEXT NOT NULL,
  coin       TEXT NOT NULL,
  szi        REAL NOT NULL,
  entry_px   REAL NOT NULL,
  margin_used REAL NOT NULL,
  leverage   INTEGER NOT NULL,
  opened_at  TEXT NOT NULL,
  PRIMARY KEY (account, coin)
);
CREATE TABLE IF NOT EXISTS paper_orders (
  cloid      TEXT PRIMARY KEY,
  account    TEXT NOT NULL,
  coin       TEXT NOT NULL,
  is_buy     INTEGER NOT NULL,
  sz         REAL NOT NULL,
  px         REAL NOT NULL,
  trigger_px REAL,
  -- 1 = fires when the mark FALLS to the trigger, 0 = when it rises. Decided from
  -- the mark at placement, which is how HL itself arms a trigger.
  fire_below INTEGER NOT NULL DEFAULT 0,
  reduce_only INTEGER NOT NULL,
  oid        INTEGER NOT NULL,
  placed_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS paper_orders_account ON paper_orders (account);
-- Isolated leverage per market, as updateLeverage sets it on the real venue. It has
-- to be recorded before the entry fills, because it decides the margin the position
-- posts, and that number feeds the free-collateral check the next signal must pass.
CREATE TABLE IF NOT EXISTS paper_leverage (
  account    TEXT NOT NULL,
  coin       TEXT NOT NULL,
  leverage   INTEGER NOT NULL,
  PRIMARY KEY (account, coin)
);
CREATE TABLE IF NOT EXISTS paper_cash (
  account    TEXT PRIMARY KEY,
  equity     REAL NOT NULL
);
`;

/** The paper book was global before 2026-08-31: `paper_cash` was a single row
 *  (`id = 1`) and the other three were keyed by `coin` alone, so two paper accounts in
 *  one ledger would have shared one simulated book. This rebuilds those tables with an
 *  `account` column.
 *
 *  SQLite cannot alter a primary key in place, so each table is renamed, recreated
 *  from `SCHEMA` above, copied across, and dropped — inside one transaction.
 *
 *  Existing rows are attributed to the ledger's single account. With more than one
 *  account **and** rows to move it refuses: a global book cannot be split after the
 *  fact, and guessing which account owned a position is exactly the kind of quiet
 *  wrong answer this project does not make. That case cannot arise from any released
 *  version — multi-account paper never worked — but it is checked rather than
 *  assumed. */
function migratePaperBook(db: DatabaseSync, log: (m: string) => void): void {
  const cols = db.prepare("PRAGMA table_info(paper_cash)").all() as { name: string }[];
  if (cols.length === 0) return;                       // fresh file; SCHEMA built it right
  if (cols.some((c) => c.name === "account")) return;  // already migrated

  const count = (t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const rows = count("paper_cash") + count("paper_positions") + count("paper_orders") + count("paper_leverage");
  const hasAccounts = (db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'accounts'",
  ).get() as { n: number }).n > 0;
  const accounts = hasAccounts
    ? (db.prepare("SELECT account FROM accounts ORDER BY connected_at").all() as { account: string }[])
      .map((r) => r.account)
    : [];

  if (rows > 0 && accounts.length !== 1) {
    throw new Error(
      `cannot migrate the paper book: it holds ${rows} rows from when it was global, ` +
      `and this ledger has ${accounts.length} accounts, so there is no way to tell which ` +
      "account they belong to. Archive the ledger (mv signaldesk.sqlite* elsewhere) and " +
      "start clean, or delete the paper_* rows if the simulated state is not worth keeping.",
    );
  }
  const owner = accounts[0] ?? null;

  db.exec("BEGIN");
  try {
    for (const t of ["paper_cash", "paper_positions", "paper_orders", "paper_leverage"]) {
      db.exec(`ALTER TABLE ${t} RENAME TO ${t}_old`);
    }
    db.exec(SCHEMA);
    if (owner !== null && rows > 0) {
      db.prepare("INSERT INTO paper_cash (account, equity) SELECT ?, equity FROM paper_cash_old").run(owner);
      db.prepare(
        "INSERT INTO paper_positions (account, coin, szi, entry_px, margin_used, leverage, opened_at) " +
        "SELECT ?, coin, szi, entry_px, margin_used, leverage, opened_at FROM paper_positions_old",
      ).run(owner);
      db.prepare(
        "INSERT INTO paper_orders (cloid, account, coin, is_buy, sz, px, trigger_px, fire_below, reduce_only, oid, placed_at) " +
        "SELECT cloid, ?, coin, is_buy, sz, px, trigger_px, fire_below, reduce_only, oid, placed_at FROM paper_orders_old",
      ).run(owner);
      db.prepare("INSERT INTO paper_leverage (account, coin, leverage) SELECT ?, coin, leverage FROM paper_leverage_old")
        .run(owner);
    }
    for (const t of ["paper_cash", "paper_positions", "paper_orders", "paper_leverage"]) {
      db.exec(`DROP TABLE ${t}_old`);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  log(`migrated the paper book to per-account keys${owner ? ` (${rows} rows → ${owner})` : " (empty)"}`);
}

/** Collapse the old append-only skip log into one row per decision.
 *
 *  `skips` was `(at, account, signal_ref, coin, reason, detail)` with no key and no
 *  dedupe, written once per signal per 60s loop. SQLite cannot add a primary key in
 *  place, so — like `migratePaperBook` — the table is renamed, rebuilt from `SCHEMA`,
 *  and copied across grouped, inside one transaction.
 *
 *  The collapse is `MIN(at)`, `MAX(at)`, `COUNT(*)` exactly as `tasks/10` specifies.
 *  `coin` and `detail` come from the row with the greatest `at`: SQLite guarantees
 *  that bare columns in a `MAX()` query are taken from the row that produced the
 *  maximum, which is the one whose detail is worth keeping. Revisions become 0 —
 *  the old log had no revision column, and inventing one would be a fabrication in
 *  the file this project keeps clean of them.
 *
 *  Tested against a copy of the live ledger before it ever ran against one:
 *  13,584 rows in, 174 out. */
function migrateSkips(db: DatabaseSync, log: (m: string) => void): void {
  const cols = db.prepare("PRAGMA table_info(skips)").all() as { name: string }[];
  if (cols.length === 0) return;                        // fresh file; SCHEMA built it right
  if (cols.some((c) => c.name === "first_at")) return;   // already collapsed

  const before = (db.prepare("SELECT COUNT(*) AS n FROM skips").get() as { n: number }).n;
  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE skips RENAME TO skips_old");
    db.exec(SCHEMA);
    db.exec(
      `INSERT INTO skips (account, signal_ref, reason, coin, first_at, last_at,
                          first_revision, last_revision, seen_count, detail)
       SELECT o.account, o.signal_ref, o.reason, o.coin,
              (SELECT MIN(p.at) FROM skips_old p
                WHERE p.account = o.account AND p.signal_ref = o.signal_ref AND p.reason = o.reason),
              MAX(o.at), 0, 0, COUNT(*), o.detail
       FROM skips_old o
       GROUP BY o.account, o.signal_ref, o.reason`,
    );
    db.exec("DROP TABLE skips_old");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const after = (db.prepare("SELECT COUNT(*) AS n FROM skips").get() as { n: number }).n;
  log(`collapsed ${before} skip rows into ${after} decisions`);
}

/** `tasks/41` — drop the vendor's epoch tag from every stored `signal_ref`.
 *
 *  `stableOutlookId` used to strip one `:`-component off `outlook_id` and keep the one
 *  before it, which is a **global epoch tag** the vendor rewrote on 2026-08-31, 09-02 and
 *  09-11 — each time for every series at once. An open intent's stored ref then matched
 *  nothing in the feed and the executor read a live outlook as retired: twelve WTI
 *  positions closed and reopened for −$3.13 on the third rewrite.
 *
 *  **Deploying the fix without this migration runs that bug once more, deliberately**:
 *  every open intent's ref would be in the old form and the first tick would retire the
 *  whole book. So the two land together, and this runs in the constructor — a read-write
 *  open, which is the executor's own process, before its first tick.
 *
 *  Three properties it needs and one it must not have:
 *
 *  - **It truncates to a component count, not to "the last component."** The ledger holds
 *    two forms: seven components for everything `stableOutlookId` wrote, and eight for 15
 *    rows written on 2026-08-30 before it existed, which still carry their revision hash.
 *    Both tails are sixteen lowercase hex. `stableOutlookKey` counts, so both land on the
 *    same key.
 *  - **It must be impossible to run twice.** There is no migrations table here; every
 *    migration in this file detects its own need from the data. A six-component ref does
 *    not key, so `stableOutlookKey` returns null for an already-migrated row and this
 *    does nothing. A second truncation would take the **anchor date** with it and merge
 *    every anchor of a series into one key, which is the one way this can do real damage.
 *  - **Two tables collide and must collapse rather than throw.** `skips` is keyed
 *    `(account, signal_ref, reason)` and collapsed 789 rows into 787 keys on the live
 *    ledger; `signals` is keyed `(signal_ref, revision)` and collapsed one — the same
 *    outlook, the same revision 8, recorded raw at 17:56:14Z and stripped at 18:53:28Z on
 *    2026-08-30. `intents` is keyed on `intent_id` and cannot collide.
 *  - **It must not invent anything.** A collapsed row keeps the earliest sighting's
 *    timestamp and the latest sighting's detail, exactly as `migrateSkips` does, because
 *    that is what those columns already mean.
 *
 *  Grouped in JS rather than in SQL because SQLite cannot split a string on a separator
 *  and the alternative is six nested `instr` calls that no longer resemble the rule the
 *  executor applies. The tables are small — hundreds of rows, and thousands in `skips`. */
function migrateOutlookKeys(db: DatabaseSync, log: (m: string) => void): void {
  type SignalRow = {
    signal_ref: string; revision: number; first_seen_at: string; coin: string | null;
    side: string | null; mode: string | null; strength: string | null;
    displacement_sigma: number | null; target_px: number | null; horizon_at: string | null; raw: string;
  };
  type SkipRow = {
    account: string; signal_ref: string; reason: string; coin: string | null;
    first_at: string; last_at: string; first_revision: number; last_revision: number;
    seen_count: number; detail: string;
  };
  type IntentRef = { intent_id: string; signal_ref: string };

  const signals = db.prepare(
    "SELECT signal_ref, revision, first_seen_at, coin, side, mode, strength, " +
    "displacement_sigma, target_px, horizon_at, raw FROM signals",
  ).all() as unknown as SignalRow[];
  const skips = db.prepare(
    "SELECT account, signal_ref, reason, coin, first_at, last_at, first_revision, " +
    "last_revision, seen_count, detail FROM skips",
  ).all() as unknown as SkipRow[];
  const intents = db.prepare("SELECT intent_id, signal_ref FROM intents").all() as unknown as IntentRef[];

  const staleIntents = intents.filter((r) => stableOutlookKey(r.signal_ref) !== null);
  const staleSignals = signals.filter((r) => stableOutlookKey(r.signal_ref) !== null);
  const staleSkips = skips.filter((r) => stableOutlookKey(r.signal_ref) !== null);
  if (staleIntents.length + staleSignals.length + staleSkips.length === 0) return;

  // Every row is rewritten, not only the stale ones: a ledger holding both forms would
  // key one outlook two ways, which is the defect itself. `keyed` leaves an
  // already-migrated row alone because `stableOutlookKey` returns null for it.
  const keyed = (ref: string): string => stableOutlookKey(ref) ?? ref;

  const signalsOut = new Map<string, SignalRow>();
  for (const r of signals) {
    const row = { ...r, signal_ref: keyed(r.signal_ref) };
    const k = `${row.signal_ref}\u0001${row.revision}`;
    const prev = signalsOut.get(k);
    // The first time we saw this revision, whole: every column from that one sighting.
    if (!prev || row.first_seen_at < prev.first_seen_at) signalsOut.set(k, row);
  }

  const skipsOut = new Map<string, SkipRow>();
  for (const r of skips) {
    const row = { ...r, signal_ref: keyed(r.signal_ref) };
    const k = `${row.account}\u0001${row.signal_ref}\u0001${row.reason}`;
    const prev = skipsOut.get(k);
    if (!prev) { skipsOut.set(k, row); continue; }
    // Same collapse `migrateSkips` uses: the window widens, the counts add, and the
    // detail comes from the latest sighting because it quotes a live figure.
    const first = row.first_at < prev.first_at ? row : prev;
    const last = row.last_at >= prev.last_at ? row : prev;
    skipsOut.set(k, {
      ...last,
      first_at: first.first_at,
      first_revision: first.first_revision,
      seen_count: prev.seen_count + row.seen_count,
    });
  }

  db.exec("BEGIN");
  try {
    const setIntent = db.prepare("UPDATE intents SET signal_ref = ? WHERE intent_id = ?");
    for (const r of staleIntents) setIntent.run(keyed(r.signal_ref), r.intent_id);

    db.exec("DELETE FROM signals");
    const insSignal = db.prepare(
      "INSERT INTO signals (signal_ref, revision, first_seen_at, coin, side, mode, strength, " +
      "displacement_sigma, target_px, horizon_at, raw) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of signalsOut.values()) {
      insSignal.run(r.signal_ref, r.revision, r.first_seen_at, r.coin, r.side, r.mode,
        r.strength, r.displacement_sigma, r.target_px, r.horizon_at, r.raw);
    }

    db.exec("DELETE FROM skips");
    const insSkip = db.prepare(
      "INSERT INTO skips (account, signal_ref, reason, coin, first_at, last_at, " +
      "first_revision, last_revision, seen_count, detail) VALUES (?,?,?,?,?,?,?,?,?,?)",
    );
    for (const r of skipsOut.values()) {
      insSkip.run(r.account, r.signal_ref, r.reason, r.coin, r.first_at, r.last_at,
        r.first_revision, r.last_revision, r.seen_count, r.detail);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  log(
    `dropped the vendor epoch tag from ${staleIntents.length} intent, ${staleSignals.length} signal ` +
    `and ${staleSkips.length} skip row(s): ${signals.length} signals -> ${signalsOut.size}, ` +
    `${skips.length} skips -> ${skipsOut.size} (tasks/41)`,
  );
}

/** The one canonical spelling of an account key: lowercase.
 *
 *  An EVM address is hex, and its case carries only an EIP-55 checksum — so the same
 *  account can arrive spelled two ways and did. `listAccounts()` lowercases; older
 *  rows were written checksummed. Because every query but `account()` matched
 *  exactly, the executor found the account and **none of its intents**, and its own
 *  open position read as a foreign one. That is a live halt caused entirely by
 *  spelling. Normalising here, at the only door into the ledger, is what makes it
 *  impossible rather than merely fixed. */
export function accountKey(account: string): string {
  return account.toLowerCase();
}

/** Bring an existing ledger to the canonical spelling.
 *
 *  Runs before anything reads: rows written checksummed, and rows written lowercase
 *  after `listAccounts()` started normalising, were already accumulating side by side
 *  in `skips` and `events` on the live box. */
function normaliseAccountKeys(db: DatabaseSync, log: (m: string) => void): void {
  const tables = ["accounts", "intents", "skips", "events", "connections",
    "account_risk_state", "fills", "funding", "ingest_watermark",
    "paper_cash", "paper_positions", "paper_orders", "paper_leverage"];
  const present = tables.filter((t) => (db.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(t) as { n: number }).n > 0);

  let mixed = 0;
  for (const t of present) {
    mixed += (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE account <> lower(account)`).get() as { n: number }).n;
  }
  if (mixed === 0) return;

  // `accounts` and the paper tables key on the account, so lowercasing could collide
  // with a row that is already lowercase. That would mean two rows for one account
  // with two frozen baseCapitals — refuse rather than silently merge them.
  for (const t of ["accounts", "account_risk_state", "paper_cash", "paper_positions", "paper_leverage"]) {
    if (!present.includes(t)) continue;
    const clash = (db.prepare(
      `SELECT COUNT(*) AS n FROM ${t} a JOIN ${t} b
       ON lower(a.account) = lower(b.account) AND a.account <> b.account`,
    ).get() as { n: number }).n;
    if (clash > 0) {
      throw new Error(
        `cannot normalise account keys: ${t} holds the same account spelled two ways, ` +
        "which means two rows with two frozen baseCapitals. Merging them is a decision, " +
        "not a migration — inspect the table and pick one before starting.",
      );
    }
  }

  db.exec("BEGIN");
  try {
    for (const t of present) db.exec(`UPDATE ${t} SET account = lower(account) WHERE account <> lower(account)`);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  log(`normalised ${mixed} row(s) to lowercase account keys across ${present.length} tables`);
}

/** Columns the current schema declares that an existing table does not have.
 *
 *  `SCHEMA` is all `CREATE TABLE IF NOT EXISTS`, which migrates a *missing* table and
 *  is silent about a table that exists with fewer columns. `intents` gained four when
 *  `tasks/08` arrived, and the live ledger already had nineteen rows in it — so this
 *  is the second migration shape this file needs, alongside the two table rebuilds
 *  above. It is deliberately additive only: a column is added with its declared type
 *  and no default, so every existing row reads NULL, which is exactly what "we have
 *  not settled this one yet" means.
 *
 *  `ALTER TABLE ADD COLUMN` is a metadata-only change in SQLite, so this costs nothing
 *  on a large table and needs no transaction of its own. */
function addMissingColumns(db: DatabaseSync, table: string, columns: Record<string, string>, log: (m: string) => void): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
  if (present.size === 0) return;                     // table does not exist yet; SCHEMA will build it
  for (const [name, decl] of Object.entries(columns)) {
    if (present.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${decl}`);
    log(`added ${table}.${name}`);
  }
}

export type AccountRow = {
  account: string;
  connected_at: string;
  base_capital: number;
  settings: string;
  mode: string;
  halted: number;
  halt_reason: string | null;
  halt_kind: HaltKind | null;
  day: string | null;
  day_start_equity: number | null;
  settings_at: string | null;
  mandate_at: string | null;
};


export class Store {
  readonly db: DatabaseSync;

  /** `readOnly` opens the ledger for a reader that must not be able to change it —
   *  the public web tier. SQLite enforces it at the handle, so it is a guarantee
   *  rather than a convention, and the schema is deliberately not applied: a reader
   *  has no business creating or migrating the tables it reads. */
  constructor(path: string, opts: { readOnly?: boolean; log?: (m: string) => void } = {}) {
    if (opts.readOnly) {
      this.db = new DatabaseSync(path, { readOnly: true });
      return;
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Before SCHEMA, not after: SCHEMA creates an index on `paper_orders(account)`,
    // which cannot exist on a pre-migration table. The migration renames the old
    // tables away and runs SCHEMA itself against the clean slate.
    const log = opts.log ?? ((m: string) => console.log(`[store] ${m}`));
    migratePaperBook(this.db, log);
    migrateSkips(this.db, log);
    this.db.exec(SCHEMA);
    addMissingColumns(this.db, "intents", {
      fee_usd: "REAL", funding_usd: "REAL", net_pnl: "REAL", pnl_note: "TEXT",
      // The one column here with a default rather than a NULL. NULL means "not settled
      // yet" for the four above; for an exit policy it would mean "we do not know how
      // this position exits", which is not a state the reconcile loop can be in. Every
      // row that predates the column was traded on the withdrawal exit, so 0 is a fact
      // about them rather than a fallback.
      hold_to_target: "INTEGER NOT NULL DEFAULT 0",
      // NULL here is right and means what it says: no row written before this column
      // existed can be known to have been withdrawn, and the ones that were closed for
      // it already say so in `close_reason`.
      withdrawn_at: "TEXT",
      // `tasks/44`. NULL means the same as `withdrawn_at`'s: no row written before this
      // column existed can be known to have flipped, and three flips in twelve days is
      // rare enough that backfilling from the archive would be guesswork either way.
      flipped_at: "TEXT",
      // `tasks/51` §5a. NULL on a row that predates the column means only "nothing
      // decided", and it is deliberately **not** backfilled: `stoppedOutToday` reads
      // this column beside `close_reason`, so every historical stop is already covered
      // by the reason the ingest wrote, and a backfill computed from `realized_pnl`
      // would put a derived number where a measured one exists.
      stopped_at: "TEXT",
      // `tasks/31` §5. NULL means "not summarised yet" — the same sense as the four
      // settlement columns above, and what the backfill selects on.
      cf_at: "TEXT", cf_interval: "TEXT",
      cf_mae_px: "REAL", cf_mae_to_target_px: "REAL",
    }, log);
    // NULL means "not a liquidation", which is what every row written before the
    // column existed means too — with one known exception, the 2026-09-10 `xyz:COPPER`
    // fill on `0xacc00006…`. It is not backfilled: the venue is authoritative and the
    // next ingest pass re-reads `userFillsByTime` from the watermark, so the row is
    // corrected by the same code path that would have written it correctly, or not at
    // all. Inventing it here from an address and a timestamp would be the fabrication
    // this ledger exists not to hold.
    addMissingColumns(this.db, "fills", { liquidation: "TEXT" }, log);
    addMissingColumns(this.db, "accounts", { settings_at: "TEXT", mandate_at: "TEXT", halt_kind: "TEXT" }, log);
    addMissingColumns(this.db, "account_risk_state", { halt_kind: "TEXT" }, log);
    addMissingColumns(this.db, "connections", { referral_code: "TEXT" }, log);
    // After `SCHEMA`, because it rewrites rows in three tables that must all exist, and
    // before anything reads a `signal_ref` — the executor's first tick is what would
    // otherwise retire the whole book against the old keys (`tasks/41`).
    migrateOutlookKeys(this.db, log);
    // A row from before tasks/18 has never had either changed, so both date from the
    // connect — which is also what makes an older request spent rather than pending.
    this.db.exec(
      "UPDATE accounts SET settings_at = COALESCE(settings_at, connected_at), " +
      "mandate_at = COALESCE(mandate_at, connected_at) WHERE settings_at IS NULL OR mandate_at IS NULL",
    );
    normaliseAccountKeys(this.db, log);
  }

  close(): void {
    this.db.close();
  }

  /** Tables the current schema defines that this ledger does not have.
   *
   *  **For read-only openers, which is the whole point.** A read-write open runs
   *  `SCHEMA` — every statement in it is `CREATE TABLE IF NOT EXISTS` — so the
   *  executor migrates the file it opens and can never see this. A reader deliberately
   *  does not (see the constructor), so it is the only process that can be handed a
   *  ledger written by older code, and nothing told it: the file opens fine, the
   *  process starts, and then every query against a missing table throws at request
   *  time. That is what `data/signaldesk-snapshot.sqlite` did to the web tier — booted
   *  clean, logged the ledger path, listened, and answered every API call with a 500.
   *
   *  The list is derived from `SCHEMA` rather than written out, so a table added there
   *  is covered here without anyone remembering to. Being stricter than "the tables
   *  this caller happens to read today" is deliberate: a ledger missing *any* of them
   *  predates the current code, and the fix is the same trivial one either way. */
  missingTables(): string[] {
    const defined = [...SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1]!);
    const present = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[])
        .map((r) => r.name),
    );
    return defined.filter((t) => !present.has(t));
  }

  /** Columns the current schema declares that this ledger's tables do not have,
   *  as `table.column`.
   *
   *  The sibling of `missingTables()`, and needed for the same reason at one level
   *  down: `SCHEMA` is `CREATE TABLE IF NOT EXISTS`, which is silent about a table
   *  that exists with fewer columns than it now declares. A read-write open runs
   *  `addMissingColumns` and can never see this; a **read-only** opener — the public
   *  web tier — runs neither, so it is the only process that can be handed a table
   *  missing a column it is about to select, and be told nothing until the request. */
  missingColumns(): string[] {
    const missing: string[] = [];
    for (const m of SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \(([\s\S]*?)\n\);/g)) {
      const table = m[1]!;
      const declared = [...m[2]!.matchAll(/^\s{2}(\w+)\s+(?:TEXT|REAL|INTEGER)\b/gm)].map((c) => c[1]!);
      const present = new Set(
        (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
      );
      if (present.size === 0) continue;      // the whole table is missing; missingTables() says so
      for (const c of declared) if (!present.has(c)) missing.push(`${table}.${c}`);
    }
    return missing;
  }

  // ── accounts ──────────────────────────────────────────────────────────────

  /** `baseCapital` is frozen at connect and stays frozen under every open position.
   *  Reconnecting with a different amount means a new row; so does `applyMandate`,
   *  which re-reads it at the owner's request once nothing is open (`tasks/18`) —
   *  the one case the fixed-base model's argument never covered. */
  connectAccount(account: string, baseCapital: number, settings: unknown, mode: string, at = new Date()): AccountRow {
    account = accountKey(account);
    const existing = this.account(account);
    if (existing) {
      // Reusing a row across a mode change would carry the *other* mode's frozen
      // base capital into this one — and paper defaults to a flat $1,000 while live
      // sizes off what the account actually holds, so on a small account that is a
      // silent multiple on real money, written into a row that still says "paper".
      // (It was a fixed 10x while the live ceiling was $100; with the ceiling gone the
      // factor is whatever $1,000 is of their deposit, which can be far worse.)
      // Refuse; the live run starts from its own ledger.
      if (existing.mode !== mode) {
        throw new Error(
          `ledger already has ${account} connected in ${existing.mode} mode with ` +
          `baseCapital $${existing.base_capital} (since ${existing.connected_at}). ` +
          `Refusing to run it in ${mode}: baseCapital is frozen at connect, so this run ` +
          `would size off the ${existing.mode} figure, not the $${baseCapital} it should. ` +
          "Archive the old ledger (mv signaldesk.sqlite* elsewhere) and start clean, or " +
          "point SIGNALDESK_DB at a different file.",
        );
      }
      return existing;
    }
    // Risk state this account carried out of its last disconnect, if any. Capital and
    // settings are deliberately re-frozen from the arguments — that is what
    // reconnecting is *for* — but a halt and the day's loss baseline are not the
    // user's to reset by unlinking. See `account_risk_state`.
    const carried = this.db.prepare(
      "SELECT halted, halt_reason, halt_kind, day, day_start_equity FROM account_risk_state WHERE account = ?",
    ).get(account) as { halted: number; halt_reason: string | null; halt_kind: HaltKind | null; day: string | null; day_start_equity: number | null } | undefined;

    this.db.prepare(
      `INSERT INTO accounts (account, connected_at, base_capital, settings, mode, day, day_start_equity, halted, halt_reason,
                             halt_kind, settings_at, mandate_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    // `day_start_equity` is seeded NULL for a genuinely new account, not from
    // `baseCapital`, so the first tick sets it from the venue via `rollDay`. Seeding it
    // from baseCapital made the daily-loss cap measure a *fixed* number against live
    // equity, which is wrong in both directions: with $100 base and $0 perp equity it
    // read a 100% loss and halted instantly; with equity above base it could never
    // reach the threshold and the cap was dead. It also made `rollDay`'s null-branch
    // unreachable. A *carried* baseline is passed through instead, and `rollDay` still
    // resets it once `day` is no longer today.
    ).run(
      account, at.toISOString(), baseCapital, JSON.stringify(settings), mode,
      carried?.day ?? at.toISOString().slice(0, 10),
      carried?.day_start_equity ?? null,
      carried?.halted ?? 0,
      carried?.halt_reason ?? null,
      carried?.halt_kind ?? null,
      at.toISOString(), at.toISOString(),
    );
    if (carried?.halted === 1) {
      this.recordEvent(
        account, "halt",
        `still halted after reconnecting — an unlink pauses management, it does not clear a halt: ${carried.halt_reason ?? "(no reason recorded)"}`,
        at,
      );
    }
    return this.account(account)!;
  }

  /** Case-insensitive on purpose. An EVM address is hex and its case carries only an
   *  EIP-55 checksum, so two rows differing only in case are always the same account —
   *  but `connectAccount` looks the row up through here before deciding to INSERT, so
   *  an exact match would have written a **second row with a second frozen
   *  baseCapital** the first time a caller passed a different casing. That was live:
   *  the ledger held `0x4Fe5…C08A` while `listAccounts()` lowercases, so the next
   *  restart would have re-frozen capital against a duplicate row. */
  account(account: string): AccountRow | null {
    account = accountKey(account);
    return (this.db.prepare("SELECT * FROM accounts WHERE account = ? COLLATE NOCASE")
      .get(account) as AccountRow | undefined) ?? null;
  }

  // ── admissions (tasks/17) ─────────────────────────────────────────────────

  /** Let an address into the connect flow. `expiresAt` is when the held slot goes
   *  back to the queue if the account has not connected by then. */
  admit(account: string, reason: "queue" | "operator", expiresAt: Date, at = new Date()): void {
    this.db.prepare(
      `INSERT INTO admissions (account, admitted_at, expires_at, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET admitted_at = excluded.admitted_at,
         expires_at = excluded.expires_at, reason = excluded.reason`,
    ).run(accountKey(account), at.toISOString(), expiresAt.toISOString(), reason);
  }

  admission(account: string): AdmissionRow | null {
    return (this.db.prepare("SELECT * FROM admissions WHERE account = ?")
      .get(accountKey(account)) as AdmissionRow | undefined) ?? null;
  }

  /** Every admission that has not expired. What the caller does with it is count the
   *  slots being held by people who have not connected yet — see `src/exec/queue.ts`. */
  liveAdmissions(nowIso: string): AdmissionRow[] {
    return this.db.prepare("SELECT * FROM admissions WHERE expires_at > ? ORDER BY admitted_at")
      .all(nowIso) as AdmissionRow[];
  }

  setHalt(account: string, halted: boolean, reason: string | null, kind: HaltKind | null = null): void {
    account = accountKey(account);
    this.db.prepare("UPDATE accounts SET halted = ?, halt_reason = ?, halt_kind = ? WHERE account = ?")
      .run(halted ? 1 : 0, reason, kind, account);
  }

  /** Put a kind on a halt that predates the column, when the condition that would have
   *  written it is still true.
   *
   *  ⚠ Not a backfill from the reason text, which would be the guess `halt_kind` exists
   *  to remove. `tick()` re-derives `haltCheck` every loop; this records what that check
   *  says about an account that is **already** halted, and it writes no event and sends
   *  no alert, because nothing happened — the halt is the one that was already there.
   *  An account whose condition has since gone stays untyped, and untyped is
   *  operator-only on the desk, which is the safe direction. */
  typeExistingHalt(account: string, kind: HaltKind): boolean {
    const r = this.db.prepare(
      "UPDATE accounts SET halt_kind = ? WHERE account = ? AND halted = 1 AND halt_kind IS NULL",
    ).run(kind, accountKey(account));
    return Number(r.changes) > 0;
  }

  /** Clear a halt. **The one line that makes this a feature rather than the exploit
   *  `notes/2026-08-31-halt-survives-unlink.md` closed:**
   *
   *  > Clear `halted`. Never touch `day_start_equity` or `day`.
   *
   *  With the baseline untouched the clear is safe by construction rather than by
   *  policy. If the account is still more than `dailyLossPct` below the day's real
   *  opening equity, `haltCheck` re-halts it on the very next tick and `preTradeCheck`
   *  refuses every signal in between — so the button can only "work" when the condition
   *  has genuinely gone. It cannot buy a second loss budget, because the budget is
   *  measured from a number it does not touch.
   *
   *  `events` held a `halt` row and nothing for the clear, because every clear so far
   *  went round `recordEvent` as a hand `UPDATE` — so the ledger recorded that accounts
   *  stopped and never that they started again. `actor` is on the row because *who
   *  un-halted this, and when* is a question people will actually ask once a button
   *  exists. */
  clearHalt(account: string, actor: "owner" | "operator", looked: string, at = new Date()): AccountRow | null {
    account = accountKey(account);
    const row = this.account(account);
    if (!row || row.halted !== 1) return null;
    this.db.exec("BEGIN");
    try {
      // Named columns, and `day` and `day_start_equity` are deliberately absent.
      this.db.prepare("UPDATE accounts SET halted = 0, halt_reason = NULL, halt_kind = NULL WHERE account = ?")
        .run(account);
      this.recordEvent(account, "unhalt",
        `halt cleared by the ${actor}: ${row.halt_reason ?? "(no reason recorded)"} ` +
        `[${row.halt_kind ?? "untyped"}]. ${looked} The day's baseline is untouched — ` +
        `day ${row.day ?? "unset"}, opening equity ` +
        `${row.day_start_equity === null ? "unset" : `$${row.day_start_equity.toFixed(2)}`} — so the ` +
        "next tick re-halts if the condition is still there", at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.account(account);
  }

  /** What closed on this account on one UTC day, worst first, with what each cost.
   *
   *  `tasks/30` §2: the halt banner says *why* in the abstract and never says what the
   *  day looked like. On 2026-09-08 the answer was two positions at −38.1% and −35.6% of
   *  their margin against 17 winners — a **65% hit rate that still reached the cap** —
   *  and no screen said so, which is exactly the shape of day where the setting and not
   *  the signals is the thing to look at.
   *
   *  `net_pnl` where the venue's rows are in and the estimate where they are not, the
   *  same fallback `realisedToday` uses, because a banner that omits the trip that has
   *  not settled yet omits the most recent one. */
  stoppedOn(account: string, day: string): { coin: string; side: string; close_reason: string | null; net_pnl: number | null; margin_usd: number }[] {
    return this.db.prepare(
      "SELECT coin, side, close_reason, COALESCE(net_pnl, realized_pnl) AS net_pnl, margin_usd " +
      "FROM intents WHERE account = ? AND status = 'closed' AND substr(closed_at, 1, 10) = ? " +
      "ORDER BY COALESCE(net_pnl, realized_pnl) ASC",
    ).all(accountKey(account), day) as unknown as
      { coin: string; side: string; close_reason: string | null; net_pnl: number | null; margin_usd: number }[];
  }

  /** When this account's last un-halt **decision** was recorded — cleared or refused.
   *
   *  What makes a clear request from the desk spend exactly once, the same way
   *  `settings_at` spends a limits change. A refusal counts, and that is the point: a
   *  press at 23:00Z that the executor refuses must not sit in the queue and apply
   *  itself at midnight. Releasing on the day roll is `tasks/30` §4 and a risk decision
   *  nobody has taken; arriving at it by leaving a request live would be taking it by
   *  accident. */
  lastHaltDecisionAt(account: string): string | null {
    const r = this.db.prepare(
      "SELECT MAX(at) AS at FROM events WHERE account = ? AND kind IN ('unhalt', 'unhalt-refused')",
    ).get(accountKey(account)) as { at: string | null };
    return r.at;
  }

  /** When the halt in force fired, from the `events` row that recorded it. Null when
   *  nothing is halted, or when the halt predates the event being written. */
  haltedAt(account: string): string | null {
    account = accountKey(account);
    const r = this.db.prepare(
      "SELECT at FROM events WHERE account = ? AND kind = 'halt' " +
      "AND at > COALESCE((SELECT MAX(at) FROM events WHERE account = ? AND kind = 'unhalt'), '') " +
      "ORDER BY at LIMIT 1",
    ).get(account, account) as { at: string } | undefined;
    return r?.at ?? null;
  }

  /** Change the three limits on a connected account (`tasks/18` §3). **Touches no
   *  intent and no order**: every open position's terms are columns on its own row.
   *  The connections row is updated too, so an unlink-and-reconnect later starts
   *  from what the person last chose rather than what they chose months ago.
   *
   *  `why` is on the event row because the ledger is the only place that records who
   *  moved somebody's stop, and there are now two callers: the desk's own button, which
   *  is the owner asking, and `npm run settings`, which is us. Defaulted so the button's
   *  wording is unchanged, and stated for the operator rather than left to read as the
   *  owner's request. */
  applySettings(account: string, settings: unknown, at = new Date(), why = "at the owner's request"): AccountRow {
    account = accountKey(account);
    const row = this.account(account);
    if (!row) throw new Error(`unknown account ${account}`);
    const next = JSON.stringify(settings);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE accounts SET settings = ?, settings_at = ? WHERE account = ?")
        .run(next, at.toISOString(), account);
      this.db.prepare("UPDATE connections SET settings = ?, updated_at = ? WHERE account = ?")
        .run(next, at.toISOString(), account);
      this.recordEvent(account, "settings",
        `limits changed ${why}: ${row.settings} → ${next}; ` +
        `${this.openCount(account)} open position(s) keep the terms they opened with`, at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.account(account)!;
  }

  /** Bring the account row in line with the settings actually in force, and return it
   *  when something moved.
   *
   *  `connectAccount` writes the settings once, when the row is created, and returns an
   *  existing row untouched — which is right for `baseCapital` and wrong for these. An
   *  operator's `accounts/<address>.json` is read at every connect and outranks the row,
   *  so editing that file changed what was **traded** and nothing that was **shown**: the
   *  desk and the leaderboard both read this column. On 2026-09-10 ten accounts were moved
   *  to a 1% stop by file and every one of them went on advertising 3%, on a board other
   *  owners read specifically to compare settings.
   *
   *  **The connections row is deliberately not touched**, which is the difference between
   *  this and `applySettings`. That row is what its owner last chose, and deleting the
   *  file has to hand *that* back rather than leave them starting from an operator's
   *  numbers. */
  syncAccountSettings(account: string, settings: unknown, at = new Date()): AccountRow | null {
    account = accountKey(account);
    const row = this.account(account);
    if (!row) return null;
    const next = JSON.stringify(settings);
    if (next === row.settings) return null;
    this.db.prepare("UPDATE accounts SET settings = ?, settings_at = ? WHERE account = ?")
      .run(next, at.toISOString(), account);
    this.recordEvent(account, "settings",
      `the desk's copy of the limits in force was stale and has been corrected: ${row.settings} → ` +
      `${next}. What the account is traded on did not change here; this is the row catching up`, at);
    return this.account(account)!;
  }

  /** Re-freeze the mandate at what the account holds (`tasks/18` §4). The caller has
   *  checked that nothing is open and re-read the venue; this writes the new base, the
   *  corrected day baseline (§4.4 — equity less today's realised result, so the deposit
   *  is not read as a day's profit and the morning's losses are not forgiven), and for
   *  a paper account re-seeds the simulated cash, whose equity *is* its base. */
  applyMandate(account: string, baseCapital: number, dayStartEquity: number, at = new Date()): AccountRow {
    account = accountKey(account);
    const row = this.account(account);
    if (!row) throw new Error(`unknown account ${account}`);
    const iso = at.toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE accounts SET base_capital = ?, mandate_at = ?, day = ?, day_start_equity = ? WHERE account = ?")
        .run(baseCapital, iso, iso.slice(0, 10), dayStartEquity, account);
      if (row.mode === "paper") {
        this.db.prepare("UPDATE paper_cash SET equity = ? WHERE account = ?").run(baseCapital, account);
      }
      this.recordEvent(account, "mandate",
        `mandate re-read at the owner's request with nothing open: $${row.base_capital.toFixed(2)} → ` +
        `$${baseCapital.toFixed(2)}; day baseline ${row.day_start_equity === null ? "unset" : `$${row.day_start_equity.toFixed(2)}`} → ` +
        `$${dayStartEquity.toFixed(2)}`, at);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.account(account)!;
  }

  /** Today's realised trading result: settled net where the venue's rows are in, the
   *  estimate where they are not yet. What a rebase subtracts from equity so the day's
   *  losses stay counted (`applyMandate`).
   *
   *  ⚠ **It is a mixed figure and says so here rather than anywhere a reader sees it.**
   *  `tasks/46` §4 offered two fixes — use `net_pnl` alone and report *"N unsettled"*, or
   *  label it as mixed — and this is the second. The first is not free: this number is
   *  the rebase baseline, so dropping the unsettled trips would forgive the most recent
   *  loss on every account that rebases before its fills land, which is the failure
   *  `notes/2026-08-31-halt-survives-unlink.md` closed. The gap is real and measured —
   *  −$1.80 settled against +$1.55 estimated on the first 18 closed trips — and
   *  `npm run fills` is where it is broken out, trip by trip, with the settled and
   *  unsettled counts beside it. `web/desk.ts`'s `realisedSince` follows the same rule
   *  deliberately: the desk and the rebase are two answers to one question. */
  realisedToday(account: string, day: string): number {
    const r = this.db.prepare(
      "SELECT COALESCE(SUM(COALESCE(net_pnl, realized_pnl)), 0) AS p FROM intents " +
      "WHERE account = ? AND status = 'closed' AND closed_at >= ?",
    ).get(accountKey(account), `${day}T00:00:00.000Z`) as { p: number };
    return r.p;
  }

  /** The simulated cash of a paper account, or null when it has no book yet. */
  paperEquity(account: string): number | null {
    const r = this.db.prepare("SELECT equity FROM paper_cash WHERE account = ?")
      .get(accountKey(account)) as { equity: number } | undefined;
    return r?.equity ?? null;
  }

  /** Roll the daily-loss baseline at the UTC boundary. Returns the day in force. */
  rollDay(account: string, equityNow: number, at = new Date()): { day: string; dayStartEquity: number } {
    account = accountKey(account);
    const day = at.toISOString().slice(0, 10);
    const row = this.account(account);
    if (!row) throw new Error(`unknown account ${account}`);
    if (row.day !== day || row.day_start_equity === null) {
      this.db.prepare("UPDATE accounts SET day = ?, day_start_equity = ? WHERE account = ?").run(day, equityNow, account);
      return { day, dayStartEquity: equityNow };
    }
    return { day, dayStartEquity: row.day_start_equity };
  }

  // ── signals ───────────────────────────────────────────────────────────────

  /** Idempotent per (outlook, revision), so re-seeing a signal is free and the
   *  archive of what we acted on is a change log, not a snapshot sequence. */
  recordSignal(row: {
    signalRef: string; revision: number; coin: string | null; side: string | null;
    mode: string; strength: string | null; displacementSigma: number | null;
    targetPx: number | null; horizonAt: string | null; raw: unknown;
  }, at = new Date()): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO signals
       (signal_ref, revision, first_seen_at, coin, side, mode, strength, displacement_sigma, target_px, horizon_at, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.signalRef, row.revision, at.toISOString(), row.coin, row.side, row.mode, row.strength,
      row.displacementSigma, row.targetPx, row.horizonAt, JSON.stringify(row.raw),
    );
  }

  // ── intents ───────────────────────────────────────────────────────────────

  insertIntent(account: string, i: TradeIntent): void {
    account = accountKey(account);
    this.db.prepare(
      `INSERT INTO intents (intent_id, account, created_at, provider, signal_ref, signal_revision, coin, side,
        leverage, margin_usd, size_abs, ref_px, target_px, stop_px, horizon_at, hold_to_target, rationale, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    ).run(
      i.intentId, account, i.createdAt, i.provider, i.signalRef, i.signalRevision, i.coin, i.side,
      i.leverage, i.marginUsd, i.sizeAbs, i.refPx, i.exit.targetPx, i.exit.stopPx, i.exit.horizonAt,
      i.exit.holdToTarget ? 1 : 0, i.rationale,
    );
  }

  /** Record that the forecast behind this position left the feed.
   *
   *  First writer wins. The signal stays missing from every later snapshot, so an
   *  unguarded update would rewrite the stamp once a loop and lose the thing it is
   *  for — *when* the withdrawal happened, against the entry and the eventual exit. */
  markWithdrawn(intentId: string, at = new Date()): void {
    this.db.prepare("UPDATE intents SET withdrawn_at = ? WHERE intent_id = ? AND withdrawn_at IS NULL")
      .run(at.toISOString(), intentId);
  }

  /** Record that the forecast behind this position published the other side.
   *
   *  First writer wins, for the same reason `markWithdrawn` does and one more: under
   *  `hold_to_target` the position is **kept**, so the flipped call stays in the feed
   *  and an unguarded update would rewrite the stamp once a loop for the rest of the
   *  position's life. The stamp is worth having only if it dates the first reversal. */
  markFlipped(intentId: string, at = new Date()): void {
    this.db.prepare("UPDATE intents SET flipped_at = ? WHERE intent_id = ? AND flipped_at IS NULL")
      .run(at.toISOString(), intentId);
  }

  /** Record that this position left with the price on the stop's side of its own book.
   *
   *  First writer wins, like the two above, though a closed intent is settled once so
   *  there is nothing here for a second writer to do. */
  markStoppedOut(intentId: string, at = new Date()): void {
    this.db.prepare("UPDATE intents SET stopped_at = ? WHERE intent_id = ? AND stopped_at IS NULL")
      .run(at.toISOString(), intentId);
  }

  /** Everything not yet finished — what the reconcile loop has to make true. */
  liveIntents(account: string): IntentRow[] {
    account = accountKey(account);
    return this.db.prepare(
      "SELECT * FROM intents WHERE account = ? AND status IN ('pending','open','closing') ORDER BY created_at",
    ).all(account) as unknown as IntentRow[];
  }

  intent(intentId: string): IntentRow | null {
    return (this.db.prepare("SELECT * FROM intents WHERE intent_id = ?").get(intentId) as IntentRow | undefined) ?? null;
  }

  /** True when this signal already has an intent that is not finished — the guard
   *  against opening the same outlook twice as it is re-published each poll. */
  hasLiveIntentFor(account: string, signalRef: string): boolean {
    account = accountKey(account);
    const r = this.db.prepare(
      "SELECT 1 FROM intents WHERE account = ? AND signal_ref = ? AND status IN ('pending','open','closing') LIMIT 1",
    ).get(account, signalRef);
    return r !== undefined;
  }

  hasLiveIntentOn(account: string, coin: string): boolean {
    account = accountKey(account);
    const r = this.db.prepare(
      "SELECT 1 FROM intents WHERE account = ? AND coin = ? AND status IN ('pending','open','closing') LIMIT 1",
    ).get(account, coin);
    return r !== undefined;
  }

  /** True when a stop has already fired on this account, market **and side** earlier in
   *  the same UTC day — the `tasks/42` guard.
   *
   *  `hasLiveIntentFor` and `hasLiveIntentOn` both ask whether an intent is still
   *  running, so a *closed* one constrained nothing and a stopped-out position reopened
   *  on the next tick. This is the only query here that reads a finished intent to
   *  decide a new one, which is why it is deliberately narrow: one account, one market,
   *  one side, one day.
   *
   *  The day is matched on the leading `YYYY-MM-DD` of `closed_at`, which is always
   *  `toISOString()` output, and it is the same boundary `rollDay` uses — so the block
   *  releases when the daily-loss baseline rebases and there is no second clock.
   *
   *  `status = 'closed'` rather than `close_reason = 'stop'` alone: `markClosing` writes
   *  the reason before the fill lands, and an intent in `closing` is still live, so
   *  `hasLiveIntentOn` is what refuses it. Counting it here as well would be the same
   *  refusal twice under the wrong name. */
  stoppedOutToday(account: string, coin: string, side: string, at = new Date()): boolean {
    account = accountKey(account);
    // **Two sources and they answer at different times, which is the whole point.**
    // `close_reason = 'stop'` is the venue's own attribution and arrives with the fill
    // ingest — authoritative, and on 2026-09-14 it arrived after the decision that
    // needed it 22 times out of 22. `stopped_at` is stamped inside the tick that
    // closes, from where the price was against this position's own two triggers, so it
    // is here before the next tick can ask. Neither subsumes the other: the reason
    // covers every row written before the column existed, and the stamp covers the
    // minutes before the reason lands (`tasks/51` §5a).
    const r = this.db.prepare(
      "SELECT 1 FROM intents WHERE account = ? AND coin = ? AND side = ? AND status = 'closed' " +
      "AND (close_reason = 'stop' OR stopped_at IS NOT NULL) AND substr(closed_at, 1, 10) = ? LIMIT 1",
    ).get(account, coin, side, at.toISOString().slice(0, 10));
    return r !== undefined;
  }

  /** When we last closed a position on this outlook, for this account — or null.
   *
   *  The companion to `stoppedOutToday`, and the second query here that reads a finished
   *  intent to decide a new one. It answers *how old is the forecast in hand, measured
   *  against what we already know*: an exit is a price fact we observed on the venue, so
   *  a snapshot the vendor observed before it cannot have priced the move we just took.
   *
   *  **Keyed on the outlook and not on the market.** `ref_median` is per-outlook, so it
   *  is this outlook's reference that is stale relative to our fill; a different call on
   *  the same coin carries its own. Side is deliberately not in the key and would be
   *  redundant if it were — a side change needs a new revision, which carries a newer
   *  `observed_at` and clears the guard on its own.
   *
   *  `status = 'closed'` only. An intent in `closing` has not established a price yet,
   *  and `hasLiveIntentFor` refuses a new one on that outlook regardless.
   *
   *  `notes/2026-09-16-the-snapshot-that-predates-the-fill.md` is the measurement. */
  lastCloseAt(account: string, signalRef: string): string | null {
    account = accountKey(account);
    const r = this.db.prepare(
      "SELECT MAX(closed_at) AS at FROM intents WHERE account = ? AND signal_ref = ? " +
      "AND status = 'closed' AND closed_at IS NOT NULL",
    ).get(account, signalRef) as unknown as { at: string | null } | undefined;
    return r?.at ?? null;
  }

  markFilled(intentId: string, entryPx: number, filledSz: number): void {
    this.db.prepare("UPDATE intents SET status = 'open', entry_px = ?, filled_sz = ? WHERE intent_id = ?")
      .run(entryPx, filledSz, intentId);
  }

  updateFilled(intentId: string, filledSz: number): void {
    this.db.prepare("UPDATE intents SET filled_sz = ? WHERE intent_id = ?").run(filledSz, intentId);
  }

  markClosing(intentId: string, reason: string): void {
    this.db.prepare("UPDATE intents SET status = 'closing', close_reason = ? WHERE intent_id = ?").run(reason, intentId);
  }

  markClosed(intentId: string, reason: string, realizedPnl: number | null, at = new Date()): void {
    this.db.prepare(
      "UPDATE intents SET status = 'closed', closed_at = ?, close_reason = COALESCE(close_reason, ?), realized_pnl = ? WHERE intent_id = ?",
    ).run(at.toISOString(), reason, realizedPnl, intentId);
  }

  markFailed(intentId: string, detail: string, at = new Date()): void {
    this.db.prepare("UPDATE intents SET status = 'failed', closed_at = ?, close_reason = ? WHERE intent_id = ?")
      .run(at.toISOString(), detail, intentId);
  }

  // ── orders ────────────────────────────────────────────────────────────────

  recordOrder(o: {
    cloid: string; intentId: string; role: string; coin: string; isBuy: boolean;
    px: number; triggerPx: number | null; sz: number; reduceOnly: boolean;
    oid: number | null; status: string; detail: string | null;
  }, at = new Date()): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO orders (cloid, intent_id, role, coin, is_buy, px, trigger_px, sz, reduce_only, placed_at, oid, status, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(o.cloid, o.intentId, o.role, o.coin, o.isBuy ? 1 : 0, o.px, o.triggerPx, o.sz, o.reduceOnly ? 1 : 0,
      at.toISOString(), o.oid, o.status, o.detail);
  }

  setOrderStatus(cloid: string, status: string, detail?: string): void {
    this.db.prepare("UPDATE orders SET status = ?, detail = COALESCE(?, detail) WHERE cloid = ?")
      .run(status, detail ?? null, cloid);
  }

  ordersFor(intentId: string): OrderRow[] {
    return this.db.prepare("SELECT * FROM orders WHERE intent_id = ?").all(intentId) as unknown as OrderRow[];
  }

  // ── skips and events ──────────────────────────────────────────────────────

  /** One row per (account, signal, reason), upserted.
   *
   *  `seen_count` counts sightings, `first_at`/`last_at` bracket them, and the
   *  revision range records which published forecasts the decision spanned. A
   *  migrated row starts at revision 0 — "unknown" — so the first real sighting
   *  replaces it rather than dragging the range back to zero forever. */
  recordSkip(account: string, s: Skip): void {
    account = accountKey(account);
    this.db.prepare(
      `INSERT INTO skips (account, signal_ref, reason, coin, first_at, last_at,
                          first_revision, last_revision, seen_count, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(account, signal_ref, reason) DO UPDATE SET
         last_at        = excluded.last_at,
         last_revision  = MAX(skips.last_revision, excluded.last_revision),
         first_revision = CASE WHEN skips.first_revision = 0 THEN excluded.first_revision
                               ELSE MIN(skips.first_revision, excluded.first_revision) END,
         seen_count     = skips.seen_count + 1,
         coin           = COALESCE(excluded.coin, skips.coin),
         detail         = excluded.detail`,
    ).run(account, s.signalRef, s.reason, s.coin, s.at, s.at, s.revision, s.revision, s.detail);
  }

  /** Drop decisions older than a cutoff.
   *
   *  There was no retention anywhere in `src/` before 2026-09-02 — no DELETE, no
   *  prune, no vacuum — in the file the public web tier reads on every request. The
   *  collapse above turns ~5,400 rows a day into a few hundred, which makes unbounded
   *  growth survivable rather than acceptable; this makes the answer explicit instead
   *  of leaving it undecided a second time. Keyed on `last_at`, so a decision that is
   *  still being re-made every loop is never pruned out from under a live signal. */
  pruneSkips(beforeIso: string): number {
    return Number(this.db.prepare("DELETE FROM skips WHERE last_at < ?").run(beforeIso).changes);
  }

  recordEvent(account: string, kind: string, detail: string, at = new Date()): void {
    account = accountKey(account);
    this.db.prepare("INSERT INTO events (at, account, kind, detail) VALUES (?, ?, ?, ?)")
      .run(at.toISOString(), account, kind, detail);
  }

  /** What we saw and what we did about it, newest first.
   *
   *  **Taken and skipped in one list**, because the interesting comparison is between
   *  them: a screen that only shows refusals cannot answer "and what did you take
   *  instead". Skipped rows come from `skips`, taken rows from `intents`, and they are
   *  merged on the recency of the last thing that happened to each.
   *
   *  This replaced `recentSkips`, which had no caller outside its own test — it was
   *  written for this screen and had been waiting for it. */
  signalHistory(account: string, sinceIso: string, limit = 200): SignalHistoryRow[] {
    account = accountKey(account);
    const skipped = this.db.prepare(
      `SELECT 'skipped' AS outcome, signal_ref, coin, reason, detail, first_at, last_at,
              first_revision, last_revision, seen_count,
              NULL AS intent_id, NULL AS side, NULL AS status, NULL AS close_reason,
              NULL AS net_pnl, NULL AS pnl_note, NULL AS rationale
       FROM skips WHERE account = ? AND last_at >= ?`,
    ).all(account, sinceIso) as unknown as SignalHistoryRow[];
    const taken = this.db.prepare(
      `SELECT 'taken' AS outcome, signal_ref, coin, NULL AS reason, NULL AS detail,
              created_at AS first_at, COALESCE(closed_at, created_at) AS last_at,
              signal_revision AS first_revision, signal_revision AS last_revision,
              1 AS seen_count,
              intent_id, side, status, close_reason, net_pnl, pnl_note, rationale
       FROM intents WHERE account = ? AND COALESCE(closed_at, created_at) >= ?`,
    ).all(account, sinceIso) as unknown as SignalHistoryRow[];
    return [...skipped, ...taken]
      .sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0))
      .slice(0, limit);
  }

  // ── fills and funding: what a trade actually cost ─────────────────────────
  //
  // Written only by the executor. The web tier opens this database read-only, which
  // is why the ingester lives in `src/exec/fills.ts` and not behind an endpoint.

  /** Idempotent on the venue's own `tid`. Returns true when the row was new, which is
   *  what the ingester counts and what decides whether a foreign fill is *news*. */
  /** `INSERT OR IGNORE`, so re-reading the watermark boundary is free — but a row that
   *  already exists is then never corrected, and one class of row needs correcting:
   *  every fill ingested before `fills.liquidation` existed was stored with the field
   *  dropped, mis-attributed as `foreign`, and attached to no intent.
   *
   *  So an ignored insert still repairs **a liquidation, and only a liquidation**: the
   *  venue's object, the attribution and the intent it closed. The narrowness is the
   *  point. Every other column on an existing row is the same venue fact it always was,
   *  and re-writing `intent_id` in general would let a later, worse guess overwrite an
   *  earlier exact one. A liquidation is the one row where the stored answer is known
   *  to have been wrong — it had no cloid to match on, so nothing was ever matched.
   *
   *  Returns whether a row was **inserted**, which is what the foreign-fill counter
   *  keys on. A repair is not news. */
  insertFill(f: FillRow): boolean {
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO fills
       (account, tid, time, coin, side, dir, px, sz, closed_pnl, fee, fee_token, crossed, oid, cloid, hash, intent_id, attribution, liquidation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      accountKey(f.account), f.tid, f.time, f.coin, f.side, f.dir, f.px, f.sz, f.closed_pnl,
      f.fee, f.fee_token, f.crossed, f.oid, f.cloid, f.hash, f.intent_id, f.attribution,
      f.liquidation,
    );
    if (r.changes > 0) return true;
    if (f.liquidation !== null) {
      this.db.prepare(
        "UPDATE fills SET liquidation = ?, attribution = ?, intent_id = COALESCE(intent_id, ?) " +
        "WHERE account = ? AND tid = ? AND liquidation IS NULL",
      ).run(f.liquidation, f.attribution, f.intent_id, accountKey(f.account), f.tid);
    }
    return false;
  }

  /** The intent that held `coin` on this account at `timeMs`, or null.
   *
   *  For a fill the venue generated itself: a liquidation carries no cloid, so
   *  `attributeFill` has nothing of ours to match on and the position it closed would
   *  otherwise settle to NULL — which is what left a -$15.75 trip reading its own
   *  -$11.36 estimate and nothing else.
   *
   *  The window is the intent's first fill to its close, which is the same window
   *  `attributeFunding` matches on and is unambiguous for the same reason:
   *  `hasLiveIntentOn` refuses a second live intent on a coin we already hold, so at
   *  most one intent is ever open on a market at a time. A still-open intent has no
   *  `closed_at` and its window runs to now.
   *
   *  ⚠ Deliberately **not** matched by size or price. A liquidation closes whatever the
   *  position happens to be, and matching on the number would fail exactly when a
   *  partial fill had already moved it — the case where the answer matters most. */
  intentHoldingAt(account: string, coin: string, timeMs: number): string | null {
    const r = this.db.prepare(
      `SELECT i.intent_id AS id FROM intents i
        WHERE i.account = ? AND i.coin = ?
          AND (SELECT MIN(f.time) FROM fills f WHERE f.intent_id = i.intent_id) <= ?
          AND (i.closed_at IS NULL OR i.closed_at >= ?)
        ORDER BY i.created_at DESC LIMIT 1`,
    ).get(accountKey(account), coin, timeMs, new Date(timeMs).toISOString()) as { id: string } | undefined;
    return r?.id ?? null;
  }

  /** Funding is charged once per coin per hour, so (account, coin, time) is its
   *  natural key — the venue gives it no id of its own. */
  insertFunding(f: FundingRow): boolean {
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO funding (account, time, coin, usdc, szi, funding_rate, intent_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(accountKey(f.account), f.time, f.coin, f.usdc, f.szi, f.funding_rate, f.intent_id);
    return r.changes > 0;
  }

  /** How far a stream has been ingested. Null means never — which the ingester reads
   *  as "this is a backfill", and a backfill does not halt the account for fills that
   *  predate our watching it.
   *
   *  `fills-liquidation-rescan` is not a stream in the same sense: nothing reads its
   *  value, only whether the row exists. It rides here because "how far this account has
   *  been ingested, per kind of pass" is exactly what this table is, and a one-off
   *  repair that has to run once per account is the same fact in a different tense. */
  watermark(account: string, stream: WatermarkStream): number | null {
    const r = this.db.prepare("SELECT last_time FROM ingest_watermark WHERE account = ? AND stream = ?")
      .get(accountKey(account), stream) as { last_time: number } | undefined;
    return r?.last_time ?? null;
  }

  setWatermark(account: string, stream: WatermarkStream, lastTime: number, at = new Date()): void {
    this.db.prepare(
      `INSERT INTO ingest_watermark (account, stream, last_time, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account, stream) DO UPDATE SET last_time = excluded.last_time, updated_at = excluded.updated_at`,
    ).run(accountKey(account), stream, lastTime, at.toISOString());
  }

  fillsFor(intentId: string): FillRow[] {
    return this.db.prepare("SELECT * FROM fills WHERE intent_id = ? ORDER BY time").all(intentId) as unknown as FillRow[];
  }

  fundingFor(intentId: string): FundingRow[] {
    return this.db.prepare("SELECT * FROM funding WHERE intent_id = ? ORDER BY time").all(intentId) as unknown as FundingRow[];
  }

  /** Every fill of ours on one coin, ordered — the window an intent held it for. */
  fillWindow(account: string, intentId: string): { first: number; last: number } | null {
    const r = this.db.prepare(
      "SELECT MIN(time) AS first, MAX(time) AS last FROM fills WHERE account = ? AND intent_id = ?",
    ).get(accountKey(account), intentId) as { first: number | null; last: number | null };
    return r.first === null || r.last === null ? null : { first: r.first, last: r.last };
  }

  /** The three lookups fill attribution needs, built once per ingest pass.
   *
   *  Ordered by how much they survive. `cloid` is the exact order we placed, and the
   *  tag is on the venue rather than only here. The **prefix** map is built from
   *  `intents` alone, so it still works for a fill whose `orders` row was never
   *  written — the process dying between placing and recording is a real window.
   *  `oid` is last: it exists only in our database, so a fill matched by it tells us
   *  nothing we did not already know. */
  attributionMaps(): {
    cloidToIntent: Map<string, string>;
    prefixToIntent: Map<string, string>;
    oidToIntent: Map<number, string>;
  } {
    const orders = this.db.prepare("SELECT cloid, oid, intent_id FROM orders")
      .all() as unknown as { cloid: string; oid: number | null; intent_id: string }[];
    const intents = this.db.prepare("SELECT intent_id FROM intents")
      .all() as unknown as { intent_id: string }[];
    return {
      cloidToIntent: new Map(orders.map((o) => [o.cloid.toLowerCase(), o.intent_id])),
      prefixToIntent: new Map(intents.map((i) => [i.intent_id.replace(/-/g, "").slice(0, 16), i.intent_id])),
      oidToIntent: new Map(
        orders.filter((o) => o.oid !== null).map((o) => [o.oid as number, o.intent_id]),
      ),
    };
  }

  /** Closed intents on one account, oldest first. The settler walks these. */
  closedIntents(account: string): IntentRow[] {
    return this.db.prepare(
      "SELECT * FROM intents WHERE account = ? AND status = 'closed' ORDER BY closed_at",
    ).all(accountKey(account)) as unknown as IntentRow[];
  }

  /** One page of closed trades, newest first.
   *
   *  The cursor is `(closed_at, intent_id)` rather than `closed_at` alone. Two intents
   *  can close in the same millisecond — the live ledger has an ETH and a BTC intent
   *  closing at `21:52:04`, and three accounts close the *same* signal within four
   *  seconds of each other — so a `closed_at < ?` cursor would drop a row whenever a
   *  tie straddled a page boundary. Silently, and only sometimes, which is the worst
   *  shape a paging bug can have. */
  /** Closed trades, with the two facts about the *forecast* that the intent does not
   *  carry: how far the move was in sigmas, and how strongly it was held.
   *
   *  A **left** join, and the nulls are real. `signals` is written by the executor that
   *  saw the forecast, so a trade opened before that table existed — or by another
   *  process, or whose revision has since been pruned — has an intent and no row to
   *  join. The screen shows a dash there rather than inventing a zero: `0.00σ` is a
   *  claim about the forecast, and "we no longer hold that" is the truth. */
  closedTradesPage(account: string, before: { at: string; id: string } | null, limit: number): ClosedTradeRow[] {
    account = accountKey(account);
    const sql =
      "SELECT i.*, s.displacement_sigma, s.strength, x.exit_px FROM intents i " +
      "LEFT JOIN signals s ON s.signal_ref = i.signal_ref AND s.revision = i.signal_revision " +
      // The price it actually left at, size-weighted across however many fills closed
      // it — the venue's own rows, not the armed trigger price. `realized_pnl` uses the
      // armed price and is the estimate this deliberately does not repeat.
      // `Liquidat%` is included for the same reason `fills.ts` counts it as a close:
      // a liquidation is an exit, and omitting it would leave the row blank on the one
      // trade whose exit price matters most.
      "LEFT JOIN (SELECT intent_id, SUM(px * sz) / SUM(sz) AS exit_px FROM fills " +
      "           WHERE intent_id IS NOT NULL AND (dir LIKE 'Close%' OR dir LIKE 'Liquidat%') " +
      "           GROUP BY intent_id) x ON x.intent_id = i.intent_id " +
      "WHERE i.account = ? AND i.status = 'closed' AND i.closed_at IS NOT NULL";
    const order = " ORDER BY i.closed_at DESC, i.intent_id DESC LIMIT ?";
    return (before === null
      ? this.db.prepare(`${sql}${order}`).all(account, limit)
      : this.db.prepare(
        `${sql} AND (i.closed_at < ? OR (i.closed_at = ? AND i.intent_id < ?))${order}`,
      ).all(account, before.at, before.at, before.id, limit)
    ) as unknown as ClosedTradeRow[];
  }

  /** Correct why a trade closed, from the venue's own fills.
   *
   *  Separate from `settlePnl` because it is written on a different schedule: the
   *  money settles once and stays settled, while the reason can be corrected on a
   *  later pass for an intent whose figures have not moved. See `exitFromFills`. */
  setCloseReason(intentId: string, reason: string): void {
    this.db.prepare("UPDATE intents SET close_reason = ? WHERE intent_id = ?").run(reason, intentId);
  }

  /** The settled figures, written **alongside** `realized_pnl` and never over it. */
  settlePnl(intentId: string, s: { feeUsd: number | null; fundingUsd: number | null; netPnl: number | null; note: string | null }): void {
    this.db.prepare(
      "UPDATE intents SET fee_usd = ?, funding_usd = ?, net_pnl = ?, pnl_note = ? WHERE intent_id = ?",
    ).run(s.feeUsd, s.fundingUsd, s.netPnl, s.note, intentId);
  }

  // ── margin accounting ─────────────────────────────────────────────────────

  /** Margin we believe is committed to open intents. Used only for the *pre*-trade
   *  budget question; the live view is what actually gates the order. */
  deployedMargin(account: string): number {
    account = accountKey(account);
    const r = this.db.prepare(
      "SELECT COALESCE(SUM(margin_usd), 0) AS m FROM intents WHERE account = ? AND status IN ('pending','open','closing')",
    ).get(account) as { m: number };
    return r.m;
  }

  // ── connections (the web connect flow) ────────────────────────────────────

  connection(account: string): ConnectionRow | null {
    return (this.db.prepare("SELECT * FROM connections WHERE account = ?")
      .get(accountKey(account)) as ConnectionRow | undefined) ?? null;
  }

  allConnections(): ConnectionRow[] {
    return this.db.prepare("SELECT * FROM connections ORDER BY created_at").all() as unknown as ConnectionRow[];
  }

  /** Addresses the executor should try to manage. Includes accounts still awaiting
   *  their agent approval: connecting them fails with a message the user can act on,
   *  which is more useful than silently ignoring them until something changes. */
  connectableAccounts(): string[] {
    return (this.db.prepare(
      "SELECT account FROM connections WHERE status IN ('awaiting_approval','active') ORDER BY account",
    ).all() as { account: string }[]).map((r) => r.account);
  }

  upsertConnection(o: {
    account: string; status: string; agentAddress: string | null; settings: unknown;
    lastError?: string | null; referralCode?: string | null; at?: Date;
  }): ConnectionRow {
    const at = (o.at ?? new Date()).toISOString();
    const account = accountKey(o.account);
    this.db.prepare(
      `INSERT INTO connections (account, created_at, updated_at, status, agent_address, settings, last_error, referral_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account) DO UPDATE SET updated_at = excluded.updated_at, status = excluded.status,
         agent_address = COALESCE(excluded.agent_address, connections.agent_address),
         settings = excluded.settings, last_error = excluded.last_error,
         -- COALESCE, so a later write that does not carry a code cannot erase one the
         -- owner already chose. Only a fresh request with a code replaces it.
         referral_code = COALESCE(excluded.referral_code, connections.referral_code)`,
    ).run(account, at, at, o.status, o.agentAddress, JSON.stringify(o.settings), o.lastError ?? null,
      o.referralCode ?? null);
    return this.connection(account)!;
  }

  /** Stop managing an account, because its owner asked. **This closes nothing on the
   *  venue** — open positions stay open with their reduce-only stops resting, which is
   *  precisely what unlinking rather than closing means. The caller cancels our
   *  exposure-*opening* orders first; the stops are deliberately left behind, for the
   *  same reason SIGTERM leaves them (`docs/ACCOUNT-MODEL.md` §2).
   *
   *  What ends here is our *claim* on those positions. Every live intent is closed with
   *  reason `disconnect` — the CloseReason reserved for exactly this and never used
   *  until now — with a null `realized_pnl`, because we genuinely do not know it: the
   *  position was still open when we let go. Recording a number there would be a
   *  fabrication, and this ledger is the one place that must not contain any.
   *
   *  The `accounts` row goes, so the desk stops presenting positions we no longer
   *  manage as though we did, and so a later reconnect is not blocked by a frozen
   *  `baseCapital` from a mandate the user has ended. Intents, skips and events stay:
   *  they are history, and history does not become untrue because someone left. */
  disconnectAccount(account: string, at = new Date()): { released: number } {
    account = accountKey(account);
    const live = this.liveIntents(account);
    this.db.exec("BEGIN");
    try {
      for (const i of live) {
        this.db.prepare(
          "UPDATE intents SET status = 'closed', closed_at = ?, close_reason = 'disconnect', " +
          "realized_pnl = NULL WHERE intent_id = ?",
        ).run(at.toISOString(), i.intent_id);
      }
      // Before the row goes: preserve what a reconnect must not be able to reset.
      const row = this.account(account);
      if (row) {
        this.db.prepare(
          `INSERT INTO account_risk_state (account, saved_at, halted, halt_reason, halt_kind, day, day_start_equity)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(account) DO UPDATE SET
             saved_at = excluded.saved_at, halted = excluded.halted,
             halt_reason = excluded.halt_reason, halt_kind = excluded.halt_kind,
             day = excluded.day, day_start_equity = excluded.day_start_equity`,
        ).run(account, at.toISOString(), row.halted, row.halt_reason, row.halt_kind, row.day, row.day_start_equity);
      }
      this.db.prepare("DELETE FROM accounts WHERE account = ?").run(account);
      this.db.prepare("UPDATE connections SET status = 'disconnected', last_error = NULL, updated_at = ? WHERE account = ?")
        .run(at.toISOString(), account);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.recordEvent(account, "unlinked",
      `stopped managing at the owner's request; released ${live.length} open intent(s) — ` +
      "any position stays open on the venue with its reduce-only stop resting", at);
    return { released: live.length };
  }

  /** The channel the desk reads a refusal from, without touching the status: a change
   *  request that could not be applied is not a connection that failed. */
  setConnectionError(account: string, lastError: string | null, at = new Date()): void {
    this.db.prepare("UPDATE connections SET last_error = ?, updated_at = ? WHERE account = ?")
      .run(lastError, at.toISOString(), accountKey(account));
  }

  setConnectionStatus(account: string, status: string, lastError: string | null, at = new Date()): void {
    this.db.prepare("UPDATE connections SET status = ?, last_error = ?, updated_at = ? WHERE account = ?")
      .run(status, lastError, at.toISOString(), accountKey(account));
  }

  openCount(account: string): number {
    account = accountKey(account);
    const r = this.db.prepare(
      "SELECT COUNT(*) AS n FROM intents WHERE account = ? AND status IN ('pending','open','closing')",
    ).get(account) as { n: number };
    return r.n;
  }
}

export type SignalHistoryRow = {
  outcome: "skipped" | "taken";
  signal_ref: string;
  coin: string | null;
  reason: string | null;
  detail: string | null;
  first_at: string;
  last_at: string;
  first_revision: number;
  last_revision: number;
  seen_count: number;
  intent_id: string | null;
  side: string | null;
  status: string | null;
  close_reason: string | null;
  net_pnl: number | null;
  pnl_note: string | null;
  rationale: string | null;
};

/** How long a skip decision is kept. Long enough to answer "why did nothing happen
 *  last month", short enough that the file the web tier reads on every request does
 *  not grow forever. */
export const SKIP_RETENTION_DAYS = 90;

export type AdmissionRow = {
  account: string; admitted_at: string; expires_at: string; reason: string;
};

export type ConnectionRow = {
  account: string;
  created_at: string;
  updated_at: string;
  status: string;
  agent_address: string | null;
  settings: string;
  last_error: string | null;
  referral_code: string | null;
};

export type IntentRow = {
  intent_id: string; account: string; created_at: string; provider: string;
  signal_ref: string; signal_revision: number; coin: string; side: "long" | "short";
  leverage: number; margin_usd: number; size_abs: number; ref_px: number;
  target_px: number | null; stop_px: number | null; horizon_at: string;
  /** 0 | 1 — the exit policy frozen at open. See `ExitPlan.holdToTarget`. */
  hold_to_target: number;
  /** When the forecast left the feed, or null if it never did. */
  withdrawn_at: string | null;
  /** When the forecast published the other side, or null if it never did. */
  flipped_at: string | null;
  /** When this position left on a trigger of ours with the price nearer the stop than
   *  the target, or null. Read by `stoppedOutToday`; never an attribution. */
  stopped_at: string | null;
  rationale: string; status: string; entry_px: number | null; filled_sz: number;
  closed_at: string | null; close_reason: string | null; realized_pnl: number | null;
  fee_usd: number | null; funding_usd: number | null; net_pnl: number | null; pnl_note: string | null;
};

/** An intent joined to the forecast it came from. Both extras are nullable because the
 *  join is a left one — see `closedTradesPage`. */
export type ClosedTradeRow = IntentRow & {
  displacement_sigma: number | null;
  strength: string | null;
  /** Size-weighted average of the closing fills. Null until they are ingested — the
   *  same "not settled yet" as `net_pnl`, and never the armed trigger price. */
  exit_px: number | null;
};

export type { HaltKind };

export type WatermarkStream = "fills" | "funding" | "fills-liquidation-rescan";

export type FillRow = {
  account: string; tid: number; time: number; coin: string; side: string; dir: string;
  px: number; sz: number; closed_pnl: number; fee: number; fee_token: string;
  crossed: number; oid: number | null; cloid: string | null; hash: string | null;
  intent_id: string | null; attribution: string;
  /** The venue's own `liquidation` object as JSON, or null on an ordinary fill. */
  liquidation: string | null;
};

export type FundingRow = {
  account: string; time: number; coin: string; usdc: number; szi: number;
  funding_rate: number; intent_id: string | null;
};

export type OrderRow = {
  cloid: string; intent_id: string; role: string; coin: string; is_buy: number;
  px: number; trigger_px: number | null; sz: number; reduce_only: number;
  placed_at: string; oid: number | null; status: string; detail: string | null;
};

/** Reconstruct what an intent believes about a position, for the restart path. */
export function positionFor(view: LivePosition[], coin: string): LivePosition | null {
  return view.find((p) => p.coin === coin && p.szi !== 0) ?? null;
}
