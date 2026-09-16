// Funding a Hyperliquid account without leaving this page.
//
// The addresses, the ABI encoding and the amount parsing are in `src/hl/deposit.ts`,
// which this imports rather than copies: it is bundled into the page *and* read by the
// server's tests, so there is exactly one place where a destination address exists and
// it is pinned to viem byte for byte. What is here is the part that needs a wallet.
//
// Three rules, and they are the whole of why this is safe to build:
//
//  - **The destination is a constant and it is on screen.** Every address in the
//    transaction comes from version control, none from an API response or a URL, and
//    the contract being called is shown with an Arbiscan link before the wallet opens.
//    Same rule as the share cards (`src/web/cards.ts`), for the same reason: this is
//    the one screen where a substituted string costs somebody their deposit.
//  - **Declining costs nothing.** Both prompts are the user's to refuse and neither
//    leaves anything half-done: the authorisation signature alone moves no money, and
//    without the transaction it expires an hour later unused.
//  - **The manual route stays.** Depositing on Hyperliquid's own domain is a genuine
//    trust anchor, and this never becomes the only way in.
//
// ⚠ **EIP-3009 needs an ordinary EOA.** A smart-contract wallet cannot be a Hyperliquid
// master at all and is refused at sign-in (`tasks/11`); an EOA that has delegated under
// EIP-7702 has code, which is the case Hyperliquid's own frontend branches on, and we
// send it to the manual route rather than build a second rail for it.

import {
  ARBITRUM_CHAIN_HEX, ARBITRUM_CHAIN_ID, ARBISCAN, CCTP_DESTINATION_DOMAIN, CCTP_EXTENSION,
  CCTP_FEE_USD, CCTP_FORWARDER, CCTP_MAX_FEE_UNITS, CCTP_MIN_FINALITY_THRESHOLD,
  balanceOfCalldata, encodeBatchDepositForBurnWithAuth, hookDataFor, MIN_DEPOSIT_USD,
  RECEIVE_WITH_AUTHORIZATION_TYPES, USDC_ARBITRUM, USDC_DECIMALS, USDC_E_ARBITRUM,
  USDC_EIP712_DOMAIN, usdcToUsd, usdcUnits,
} from "../../src/hl/deposit.ts";
import { esc, money } from "./dom.ts";
import {
  ethBalance, ethCall, gasPrice, hasCode, sendTransaction, signTypedData, switchToChain,
  type Eip1193Provider,
} from "./wallet.ts";

export { CCTP_FEE_USD, MIN_DEPOSIT_USD, usdcToUsd, usdcUnits };

/** Arbitrum One, for `wallet_addEthereumChain` on a wallet that has never seen it. The
 *  RPC is Arbitrum's own published endpoint and is a constant here for the same reason
 *  every other address is. */
const ARBITRUM = {
  chainId: ARBITRUM_CHAIN_HEX,
  chainName: "Arbitrum One",
  rpcUrls: ["https://arb1.arbitrum.io/rpc"],
  blockExplorerUrls: [ARBISCAN],
};

/** An upper bound on the gas this call burns, multiplied by the live gas price rather
 *  than guessed at in ether.
 *
 *  A fixed floor was the first version and it was wrong within the hour: 0.0001 ETH
 *  refused a wallet holding 0.0000398 ETH, which at Arbitrum's 0.02 gwei is around ten
 *  times what this transaction costs. Its only job is to catch the account holding USDC
 *  and no ETH — which cannot deposit and gets no useful error from the wallet when it
 *  tries — so it must not also catch the account that can. */
const GAS_UNITS = 600_000n;

export type WalletFunds = {
  /** Native USDC, in USDC units. */
  usdc: bigint;
  /** Bridged USDC.e. Read only so we can name it: it is a different token, and sending
   *  it into this path loses it. */
  usdce: bigint;
  weiForGas: bigint;
  /** What one unit of gas costs on Arbitrum right now. */
  gasPriceWei: bigint;
  hasCode: boolean;
};

export async function readWalletFunds(p: Eip1193Provider, address: string): Promise<WalletFunds> {
  await switchToChain(p, ARBITRUM);
  const data = balanceOfCalldata(address);
  const [usdc, usdce, wei, price, code] = await Promise.all([
    ethCall(p, USDC_ARBITRUM, data),
    ethCall(p, USDC_E_ARBITRUM, data),
    ethBalance(p, address),
    gasPrice(p),
    hasCode(p, address),
  ]);
  return {
    usdc: usdc === "0x" ? 0n : BigInt(usdc),
    usdce: usdce === "0x" ? 0n : BigInt(usdce),
    weiForGas: wei,
    gasPriceWei: price,
    hasCode: code,
  };
}

/** What is wrong with depositing this amount from this wallet, in one sentence, or null.
 *
 *  Pure and exported so the page can say it *before* the button is pressed and refuse to
 *  build a transaction after it — one rule, checked in both places, rather than a hint
 *  that drifts from a guard. */
export function refuseDeposit(i: {
  amount: string;
  funds: WalletFunds | null;
  /** `minFundedForLiveUsd` at the limits currently on screen. */
  floorUsd: number;
}): string | null {
  let units: bigint;
  try { units = usdcUnits(i.amount); } catch (e) { return (e as Error).message; }
  const usd = usdcToUsd(units);
  if (usd < MIN_DEPOSIT_USD) {
    return `Hyperliquid's minimum deposit is $${MIN_DEPOSIT_USD.toFixed(2)}.`;
  }
  // The floor is ours, and it is the number that decides whether the account trades at
  // all: under it every signal is skipped as below-minimum-notional and the account sits
  // there looking perfectly connected.
  if (usd < i.floorUsd) {
    return `At the limits below, this account needs at least ${money(i.floorUsd)} to place a single order. `
      + "Deposit more, or raise the size or the leverage.";
  }
  if (i.funds) {
    if (i.funds.hasCode) {
      return "This wallet has code on it — a smart-contract wallet, or an account that has delegated "
        + "to one. The deposit here needs an ordinary wallet signature, so use Hyperliquid's own "
        + "deposit page instead.";
    }
    if (units > i.funds.usdc) {
      return i.funds.usdce > 0n && i.funds.usdce >= units
        ? `That is more native USDC than this wallet holds. It does hold ${money(usdcToUsd(i.funds.usdce))} of `
          + "bridged USDC.e, which is a different token — Hyperliquid does not take it, and sending it "
          + "here would lose it. Swap it for native USDC first."
        : `This wallet holds ${money(usdcToUsd(i.funds.usdc))} of USDC on Arbitrum.`;
    }
    if (i.funds.gasPriceWei > 0n && i.funds.weiForGas < GAS_UNITS * i.funds.gasPriceWei) {
      return "Not enough ETH on Arbitrum to pay for the transaction. A fraction of a cent is enough.";
    }
  }
  return null;
}

/** The destination, decoded, for the panel above the button. Every value is a constant
 *  from `src/hl/deposit.ts`; nothing here is interpolated from a response. */
export function depositDecoded(): string {
  // Two rows and no prose. The amount is in the box directly above this and repeating it
  // here was the line that made the card read as a wall of text; what is left is the
  // only thing a person cannot check for themselves — where the money is going.
  return '<dl class="dec">'
    + '<dt>To</dt><dd class="mono"><a href="' + ARBISCAN + "/address/" + CCTP_EXTENSION
    + '" target="_blank" rel="noopener noreferrer">' + CCTP_EXTENSION.slice(0, 10) + "…"
    + CCTP_EXTENSION.slice(-4) + "</a> · Hyperliquid's deposit contract</dd>"
    + "<dt>Fee</dt><dd>" + money(CCTP_FEE_USD) + " to Hyperliquid</dd>"
    + "</dl>";
}

export type DepositResult = { ok: true; hash: string } | { ok: false };

/** Sign the authorisation, then send the transaction that uses it.
 *
 *  Two prompts, and the first one is the one worth explaining: it authorises this exact
 *  amount to move to this exact contract, once, within the hour. On its own it does
 *  nothing at all — the transaction is what spends it — which is why declining either
 *  half leaves the wallet exactly as it was.
 *
 *  `onStep` renders progress. The caller owns the surrounding copy; this owns the
 *  sequence, because the sequence is where getting it wrong costs money. */
export async function runDeposit(a: {
  provider: Eip1193Provider;
  address: string;
  amount: string;
  onStep: (line: string) => void;
}): Promise<DepositResult> {
  const units = usdcUnits(a.amount);

  await switchToChain(a.provider, ARBITRUM);

  const now = Math.floor(Date.now() / 1000);
  const validAfter = now - 60;            // clock skew between a wallet and a node
  const validBefore = now + 3600;
  const nonce = randomBytes32();

  a.onStep("Authorising the transfer — check your wallet…");
  const signature = await signTypedData(a.provider, a.address, {
    domain: {
      ...USDC_EIP712_DOMAIN, chainId: ARBITRUM_CHAIN_ID, verifyingContract: USDC_ARBITRUM,
    },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" }, { name: "version", type: "string" },
        { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" },
      ],
      ...RECEIVE_WITH_AUTHORIZATION_TYPES,
    },
    primaryType: "ReceiveWithAuthorization",
    message: {
      from: a.address, to: CCTP_EXTENSION, value: units.toString(),
      validAfter: String(validAfter), validBefore: String(validBefore), nonce,
    },
  });

  const data = encodeBatchDepositForBurnWithAuth(
    {
      amount: units, authValidAfter: BigInt(validAfter), authValidBefore: BigInt(validBefore),
      authNonce: nonce,
      // The wallet returns 65 bytes as r ‖ s ‖ v; the contract wants them apart.
      r: "0x" + signature.slice(2, 66),
      s: "0x" + signature.slice(66, 130),
      v: parseInt(signature.slice(130, 132), 16),
    },
    {
      amount: units, destinationDomain: CCTP_DESTINATION_DOMAIN,
      mintRecipient: CCTP_FORWARDER, destinationCaller: CCTP_FORWARDER,
      maxFee: CCTP_MAX_FEE_UNITS, minFinalityThreshold: CCTP_MIN_FINALITY_THRESHOLD,
      hookData: hookDataFor(a.address),
    },
  );

  // Run it before asking anyone to send it. `eth_call` executes the same transaction
  // against the current state and returns the revert instead of costing gas — so an
  // encoding this page got wrong, an authorisation the token will not accept or a
  // balance that moved between the two prompts stops here, with a reason, rather than
  // as a failed transaction somebody has already confirmed and paid for.
  a.onStep("Checking the transaction will go through…");
  try {
    await ethCall(a.provider, CCTP_EXTENSION, data, a.address);
  } catch (e) {
    const why = (e as { data?: { message?: string }; message?: string });
    throw new Error(
      "Hyperliquid's deposit contract rejected this before it was sent, so nothing has moved and "
      + "nothing was spent: " + (why.data?.message ?? why.message ?? "no reason given")
      + ". You can deposit on Hyperliquid's own site instead.",
    );
  }

  a.onStep("Sending the deposit — check your wallet…");
  const hash = await sendTransaction(a.provider, { from: a.address, to: CCTP_EXTENSION, data });
  return { ok: true, hash };
}

export function txLink(hash: string): string {
  return '<a class="mono" href="' + ARBISCAN + "/tx/" + esc(hash)
    + '" target="_blank" rel="noopener noreferrer">' + esc(hash.slice(0, 10)) + "…</a>";
}

function randomBytes32(): string {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return "0x" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** USDC units as dollars, for a balance line. Six decimals is more than anybody wants
 *  to read on a screen about a deposit. */
export function fmtUsdc(units: bigint): string {
  return money(Number(units) / 10 ** USDC_DECIMALS);
}
