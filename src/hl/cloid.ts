import { randomBytes } from "node:crypto";
import type { OrderRole } from "../types.ts";

// Every order we place carries a client order id we can recognise. The `cloid` does
// three jobs, and the third is the one that matters most:
//
//  1. cancel-by-cloid, so we never need `cancelAll` — forbidden on an account that
//     is not ours (OutcomeMaker's `cancelAllForCoin` would have nuked a user's own
//     orders on a shared master);
//  2. tie a resting order back to the intent that asked for it, and to its role in
//     that intent's exit plan;
//  3. **detection**. Each loop we diff the account's orders and positions against
//     our ledger. Anything without our magic byte is someone else's, which halts the
//     account (docs/ACCOUNT-MODEL.md §1). Because the tag lives on the venue, this
//     survives losing our database entirely.
//
// Layout, 16 bytes / 32 hex as HL requires:
//   [0]      magic 0x5D
//   [1]      version
//   [2]      role
//   [3..10]  first 8 bytes of the intent's UUID
//   [11..15] random, so a re-placed order after a cancel is a distinct id

const MAGIC = 0x5d;
const VERSION = 0x01;

const ROLE_CODES: Record<OrderRole, number> = { entry: 1, tp: 2, sl: 3, close: 4 };
const CODE_ROLES = new Map<number, OrderRole>(
  Object.entries(ROLE_CODES).map(([r, c]) => [c, r as OrderRole]),
);

export type CloidParts = { role: OrderRole; intentPrefix: string };

export function makeCloid(intentId: string, role: OrderRole): `0x${string}` {
  const hex = intentId.replace(/-/g, "");
  if (hex.length < 16) throw new Error(`intentId too short to tag: ${intentId}`);
  const buf = Buffer.alloc(16);
  buf[0] = MAGIC;
  buf[1] = VERSION;
  buf[2] = ROLE_CODES[role];
  Buffer.from(hex.slice(0, 16), "hex").copy(buf, 3);
  randomBytes(5).copy(buf, 11);
  return `0x${buf.toString("hex")}`;
}

/** Null when the order is not ours — which is the halt condition, not an error. */
export function parseCloid(cloid: string | null | undefined): CloidParts | null {
  if (!cloid) return null;
  const hex = /^0x/i.test(cloid) ? cloid.slice(2) : cloid;
  if (hex.length !== 32 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const buf = Buffer.from(hex, "hex");
  if (buf[0] !== MAGIC || buf[1] !== VERSION) return null;
  const role = CODE_ROLES.get(buf[2]!);
  if (!role) return null;
  return { role, intentPrefix: buf.subarray(3, 11).toString("hex") };
}

export function isOurs(cloid: string | null | undefined): boolean {
  return parseCloid(cloid) !== null;
}

/** The key an intent's orders are found by, without consulting the database. */
export function intentPrefix(intentId: string): string {
  return intentId.replace(/-/g, "").slice(0, 16);
}
