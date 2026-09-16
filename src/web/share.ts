import type { InfoClient } from "@nktkas/hyperliquid";
import { readAccountView } from "../hl/state.ts";
import type { Universe } from "../hl/universe.ts";
import type { Store } from "../store/db.ts";
import {
  accountCard, type AccountParams, type CardModel, DOLLARS_DEFAULT, DOLLARS_NOTE,
  marketCode, positionCard, type PositionParams, query, reasonCode, shareText, type SignedKind,
  tradeCard, type TradeParams,
} from "./cards.ts";

// From the ledger row to a link that renders as a picture (`tasks/16` §5).
//
// This is the only place a card's numbers are *decided*. The image route never reads
// the ledger: it redraws exactly what the signature covers, so a card URL is a pure
// function of the figures in it and can be cached for a year. That split is also what
// keeps the ledger out of a route strangers fetch — `/share/*.png` touches no database
// at all, and this route is behind a session that has proved it owns the account.
//
// The sentence is composed here rather than in the page, so **the Quotient citation
// cannot be edited out of the default** by anything short of a change to `cards.ts`.
// The person can still edit it in X's composer; that is theirs.
//
// **Both spellings are issued at once.** The share dialog's dollars checkbox does not
// call back for a new signature — it swaps between two links the server signed
// together, which is one round trip instead of one per click, and it means the "off"
// link genuinely has no amount in it rather than an amount the page agreed not to
// draw.

export type ShareLink = {
  /** Where the person posts: the landing path, which serves the page with the card's
   *  tags in its head. */
  url: string;
  /** The picture itself, for the preview in the dialog and for Copy image. */
  image: string;
  /** The default post text, without a trailing colon — X and Telegram take the link
   *  in a field of their own. The sheet and the clipboard get `text + ": " + url`. */
  text: string;
  /** The same sentence with both accounts tagged, **for X's composer only**. Telegram
   *  would resolve an `@name` against its own directory and send the reader to somebody
   *  we have never met; the clipboard and the OS sheet would carry a mention of nobody.
   *  So the handles travel in their own field and `xIntent` is the only caller. */
  xText: string;
};

/** What `POST /api/share/*` answers with: one card, in both spellings, plus what the
 *  dialog should say and start at. */
export type ShareOffer = {
  kind: CardModel["kind"];
  title: string;
  /** Beside the checkbox — what the dollars give away on *this* card. */
  dollarsNote: string;
  /** Whether the checkbox starts ticked. */
  dollarsDefault: boolean;
  withDollars: ShareLink;
  withoutDollars: ShareLink;
};

export type ShareResult = { ok: true; offer: ShareOffer } | { ok: false; status: number; error: string };

const TITLES: Record<SignedKind, string> = {
  position: "Share this position",
  trade: "Share this trade",
  account: "Share this week",
};

/** Sign one card twice — with the dollar fields and without them — and describe both.
 *
 *  `base` is everything common to the two. `dollars` is the pair that exists only on
 *  the `d = 1` spelling, and it is *omitted* from the other rather than zeroed, because
 *  a zero would still be an amount in the URL. */
function offer(
  secret: string, kind: SignedKind, origin: string,
  base: Record<string, number>, dollars: { p: number; g?: number },
  model: (p: never) => CardModel,
): ShareOffer {
  const link = (params: Record<string, number>): ShareLink => {
    const q = query(secret, kind, params);
    return {
      url: new URL(`/s/${kind}?${q}`, origin).href,
      image: new URL(`/share/${kind}.png?${q}`, origin).href,
      text: shareText(model(params as never)),
      xText: shareText(model(params as never), "x"),
    };
  };
  const on: Record<string, number> = { ...base, d: 1, p: dollars.p };
  if (dollars.g !== undefined) on.g = dollars.g;
  return {
    kind,
    title: TITLES[kind],
    dollarsNote: DOLLARS_NOTE[kind],
    dollarsDefault: DOLLARS_DEFAULT[kind],
    withDollars: link(on),
    withoutDollars: link({ ...base, d: 0 }),
  };
}

/** The result as basis points of its own denominator, rounded to an integer.
 *
 *  Zero denominator is zero rather than a refusal: a position with no margin recorded
 *  is a broken row, not a card worth failing a share over, and `+0.00%` beside a
 *  headline that says why it closed is still true. */
const bps = (n: number, denom: number) => (denom === 0 ? 0 : Math.round((n / denom) * 10_000));

type TradeShareRow = {
  account: string; coin: string; side: string; leverage: number; margin_usd: number;
  status: string; closed_at: string | null; close_reason: string | null;
  net_pnl: number | null; created_at: string; displacement_sigma: number | null;
  entry_px: number | null; ref_px: number; exit_px: number | null;
};

/** A price as the signed integer the card carries: ×10⁴, so four decimals survive and
 *  anything under $10,000,000 fits the bound. */
const px = (n: number) => Math.max(0, Math.round(n * 10_000));

/** Everything both trade paths need from the intent, joined to the forecast's own sigma
 *  the same way `closedTradesPage` does — a **left** join, because a trade whose signal
 *  row was pruned has no sigma to report and the card says nothing rather than `0.00`. */
function intentRow(store: Store, intentId: string): TradeShareRow | undefined {
  return store.db.prepare(
    "SELECT i.account, i.coin, i.side, i.leverage, i.margin_usd, i.status, i.closed_at, " +
    "i.close_reason, i.net_pnl, i.created_at, i.entry_px, i.ref_px, s.displacement_sigma, " +
    // The price it actually left at, size-weighted across the closing fills — the
    // venue's own rows, never the armed trigger price. Same subquery `closedTradesPage`
    // uses, so the card and the history row cannot print different exits.
    "x.exit_px FROM intents i " +
    "LEFT JOIN signals s ON s.signal_ref = i.signal_ref AND s.revision = i.signal_revision " +
    "LEFT JOIN (SELECT intent_id, SUM(px * sz) / SUM(sz) AS exit_px FROM fills " +
    "           WHERE intent_id IS NOT NULL AND (dir LIKE 'Close%' OR dir LIKE 'Liquidat%') " +
    "           GROUP BY intent_id) x ON x.intent_id = i.intent_id " +
    "WHERE i.intent_id = ?",
  ).get(intentId) as TradeShareRow | undefined;
}

/** One answer for "no such trade" and "not yours": the id is a UUID we issued, and a
 *  route that distinguishes the two turns a session into an oracle for whether an
 *  intent exists on somebody else's account. */
const NOT_YOURS = { ok: false, status: 404, error: "That position is not on this account." } as const;

const sigmaOf = (s: number | null) => (s === null ? 0 : Math.round(Math.abs(s) * 100));

export function shareTrade(
  store: Store, address: string, intentId: string, secret: string | null, origin: string,
): ShareResult {
  if (!secret) return { ok: false, status: 503, error: "Sharing is not configured on this server." };
  const row = intentRow(store, intentId);
  if (!row || row.account !== address.toLowerCase()) return NOT_YOURS;
  if (row.status !== "closed" || row.closed_at === null) {
    return {
      ok: false, status: 409,
      error: "That position has not closed yet — share it as an open position instead.",
    };
  }
  // Settled from the venue's own fills, never the ledger's estimate. Until the fills
  // are in, the honest figure does not exist yet — and it is the one figure a closed
  // card is entirely about, so there is nothing to draw.
  if (row.net_pnl === null) {
    return {
      ok: false, status: 409,
      error: "This trade has not settled against Hyperliquid's own fills yet, so the result " +
        "net of fees and funding is not known. Try again once it has.",
    };
  }
  const m = marketCode(row.coin);
  if (m === null) return { ok: false, status: 409, error: unmapped(row.coin) };
  const r = reasonCode(row.close_reason);
  if (r === null) return { ok: false, status: 409, error: "We cannot say why that trade closed, so there is no card to draw." };

  // Both prices have to exist for the card to say what it now says. The exit comes
  // from the venue's fills and lands with `net_pnl`, so this is the same wait, not a
  // second one — but it is checked rather than assumed, because a card claiming a
  // trade ran "$0.00 » $0.00" would be worse than one that cannot be drawn yet.
  if (row.entry_px === null || row.exit_px === null) {
    return {
      ok: false, status: 409,
      error: "The prices this trade opened and closed at are not settled from Hyperliquid's " +
        "own fills yet. Try again once they are.",
    };
  }

  const held = (Date.parse(row.closed_at) - Date.parse(row.created_at)) / 60_000;
  const base = {
    m, s: row.side === "long" ? 1 : 0, l: Math.round(row.leverage), r,
    a: px(row.entry_px), b: px(row.exit_px),
    y: bps(row.net_pnl, row.margin_usd),
    h: Math.max(0, Math.round(held)),
    // Magnitude only. The sign of the displacement is the direction the forecast
    // pointed, which the Long/Short in the eyebrow already says, and beside a
    // profit-signed percentage it reads as a contradiction.
    x: sigmaOf(row.displacement_sigma),
    t: Math.floor(Date.parse(row.closed_at) / 1000),
  };
  return {
    ok: true,
    offer: offer(secret, "trade", origin, base,
      { p: Math.round(row.net_pnl * 100), g: Math.round(row.margin_usd * 100) },
      (p) => tradeCard(p as TradeParams)),
  };
}

const unmapped = (coin: string) =>
  `${coin} is not on the card's market table yet, so it cannot be shared. Nothing on a ` +
  "card is a name taken from the link, which is what that table is for.";

/** An open position, marked against the venue **now**.
 *
 *  The venue read is the reason this takes `venue` where the closed path does not: an
 *  open position's P&L is a fact Hyperliquid owns and our ledger only planned, and
 *  `docs/ARCHITECTURE.md` is explicit that the venue is authoritative for it. Reading
 *  it here rather than trusting the desk payload the browser already has is the same
 *  rule as everywhere else: the server signs what the server saw. */
export async function sharePosition(
  store: Store, address: string, intentId: string, secret: string | null, origin: string,
  venue: { info: InfoClient; universe: Universe } | null, now = new Date(),
): Promise<ShareResult> {
  if (!secret) return { ok: false, status: 503, error: "Sharing is not configured on this server." };
  if (!venue) return { ok: false, status: 503, error: "Cannot reach Hyperliquid just now, so the position's value is unknown." };
  const row = intentRow(store, intentId);
  if (!row || row.account !== address.toLowerCase()) return NOT_YOURS;
  if (row.status === "closed") {
    return { ok: false, status: 409, error: "That position has closed — share it from the closed trades below." };
  }
  const m = marketCode(row.coin);
  if (m === null) return { ok: false, status: 409, error: unmapped(row.coin) };

  const view = await readAccountView(venue.info, address.toLowerCase() as `0x${string}`, venue.universe);
  const live = view.positions.find((p) => p.coin === row.coin && p.szi !== 0);
  if (!live) {
    return {
      ok: false, status: 409,
      error: "That position has not filled yet, so there is no value to show. It will be " +
        "shareable once it is open on Hyperliquid.",
    };
  }

  const open = (now.getTime() - Date.parse(row.created_at)) / 60_000;
  const mark = view.marks.get(row.coin) ?? live.entryPx;
  const base = {
    m, s: row.side === "long" ? 1 : 0, l: Math.round(live.leverage),
    // The venue's entry and the venue's current mark — not the intent's plan. An open
    // card is a snapshot of what Hyperliquid says right now, which is the whole reason
    // this route reads it.
    a: px(live.entryPx), b: px(mark),
    y: bps(live.unrealizedPnl, live.marginUsed),
    h: Math.max(0, Math.round(open)),
    x: sigmaOf(row.displacement_sigma),
    t: Math.floor(now.getTime() / 1000),
  };
  return {
    ok: true,
    offer: offer(secret, "position", origin, base,
      { p: Math.round(live.unrealizedPnl * 100), g: Math.round(live.marginUsed * 100) },
      (p) => positionCard(p as PositionParams)),
  };
}

type WeekCounts = { n: number; w: number; o: number; e: number; p: number };

/** The account's own seven days, counted from the ledger.
 *
 *  `COALESCE(net_pnl, realized_pnl)` is `realisedSince`'s rule and this must agree
 *  with it: the desk and the card are two answers to one question and a reader will
 *  hold them side by side. Where the venue's rows are in, that is the settled figure;
 *  where they are not, it is the estimate, and the card is drawn from the same total
 *  the screen shows. */
export function shareAccount(
  store: Store, address: string, secret: string | null, origin: string, now = new Date(),
): ShareResult {
  if (!secret) return { ok: false, status: 503, error: "Sharing is not configured on this server." };
  const account = address.toLowerCase();
  const row = store.account(account);
  if (!row) return { ok: false, status: 409, error: "This account is not connected." };

  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const c = store.db.prepare(
    "SELECT COUNT(*) AS n, " +
    "SUM(close_reason = 'target') AS w, SUM(close_reason = 'stop') AS o, " +
    "SUM(close_reason NOT IN ('target','stop') OR close_reason IS NULL) AS e, " +
    "COALESCE(SUM(COALESCE(net_pnl, realized_pnl)), 0) AS p FROM intents " +
    "WHERE account = ? AND status = 'closed' AND closed_at >= ?",
  ).get(account, since) as WeekCounts;

  if (c.n === 0) {
    return {
      ok: false, status: 409,
      error: "Nothing has closed on this account in the last seven days, so there is no week to show.",
    };
  }

  const badLimits = { ok: false, status: 409, error: "We could not read this account's limits, so the card would state the wrong terms." } as const;
  let s: { leverage?: unknown; stopLoss?: unknown; stopPct?: unknown; perSignalPct?: unknown };
  try {
    s = JSON.parse(row.settings) as typeof s;
  } catch {
    return badLimits;
  }
  if (typeof s.leverage !== "number" || typeof s.perSignalPct !== "number") return badLimits;
  const stopOn = s.stopLoss !== false && typeof s.stopPct === "number";

  const base = {
    // Of the mandate — the same denominator the desk's seven-day figure uses, so the
    // card and the screen cannot disagree about the percentage.
    y: bps(c.p, row.base_capital),
    n: c.n, w: Number(c.w ?? 0), o: Number(c.o ?? 0), e: Number(c.e ?? 0),
    l: Math.round(s.leverage),
    q: stopOn ? Math.round((s.stopPct as number) * 10_000) : 0,
    z: Math.round(s.perSignalPct * 10_000),
    t: Math.floor(now.getTime() / 1000),
  };
  return {
    ok: true,
    // No `g`: the account card's denominator is the mandate, and carrying it would put
    // the balance in the URL of a link whose one job is to leave it out.
    offer: offer(secret, "account", origin, base, { p: Math.round(c.p * 100) },
      (p) => accountCard(p as AccountParams)),
  };
}
