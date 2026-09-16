// The browser wallet.
//
// **`window.ethereum` is whichever wallet injected last.** With MetaMask and Phantom
// and Rabby installed it is one of them, arbitrarily; Brave's built-in wallet takes it
// over by default. That is not cosmetic here: the address the wallet returns becomes
// the account we manage, and `baseCapital` is frozen at connect against whatever
// signed. Someone with two wallets could connect an account they never funded.
//
// So discovery is EIP-6963, which asks every wallet to announce itself and lets the
// person choose. `window.ethereum` remains the fallback for a wallet too old to
// announce — it is still the right provider when it is the only one there.

import { isUserRejection } from "./rejection.ts";

export { isUserRejection };

/** The EIP-1193 surface we use. Deliberately not the whole interface. */
export type Eip1193Provider = {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
};

/** EIP-6963's `EIP6963ProviderInfo`. `icon` is a data: URI by the spec — which the
 *  page's CSP allows under `img-src 'self' data:` and nothing else, so a wallet that
 *  announces an http icon simply will not render one. */
export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type Wallet = { info: WalletInfo; provider: Eip1193Provider };

declare global {
  interface Window { ethereum?: Eip1193Provider }
}

const announced = new Map<string, Wallet>();

function onAnnounce(e: Event): void {
  const d = (e as CustomEvent<Wallet>).detail;
  // Anything can dispatch this event, so treat the payload as untrusted: keep only
  // what is shaped like a provider, and key on the uuid the announcer chose so a
  // wallet announcing twice does not appear twice.
  if (!d || typeof d !== "object") return;
  if (!d.info || typeof d.info.uuid !== "string" || typeof d.info.name !== "string") return;
  if (!d.provider || typeof d.provider.request !== "function") return;
  announced.set(d.info.uuid, d);
}

window.addEventListener("eip6963:announceProvider", onAnnounce);
requestProviders();

function requestProviders(): void {
  window.dispatchEvent(new CustomEvent("eip6963:requestProvider"));
}

/** Every wallet that will admit to existing.
 *
 *  Announcements are dispatched synchronously in response to the request, so the ones
 *  already injected have answered before this resolves. The short wait is for a wallet
 *  that injected after page load; we also request once at import, so by the time
 *  anybody clicks sign in this is usually already populated. */
export async function discoverWallets(): Promise<Wallet[]> {
  requestProviders();
  await new Promise((r) => setTimeout(r, 120));
  const found = [...announced.values()];
  if (found.length > 0) return found.sort((a, b) => a.info.name.localeCompare(b.info.name));
  // Pre-6963 wallet, or a browser where only the legacy injection happened.
  const legacy = window.ethereum;
  return legacy
    ? [{ info: { uuid: "legacy", name: "Browser wallet", icon: "", rdns: "" }, provider: legacy }]
    : [];
}

export async function requestAddress(p: Eip1193Provider): Promise<string> {
  const accounts = await p.request({ method: "eth_requestAccounts" }) as unknown;
  const first = Array.isArray(accounts) ? accounts[0] : null;
  if (typeof first !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(first)) {
    throw new Error("That wallet did not return an account. Unlock it and try again.");
  }
  return first;
}

export async function personalSign(p: Eip1193Provider, message: string, address: string): Promise<string> {
  const sig = await p.request({ method: "personal_sign", params: [message, address] }) as unknown;
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]+$/.test(sig)) {
    throw new Error("That wallet returned a signature we could not read.");
  }
  return sig;
}

/** Which chain the wallet is on.
 *
 *  Hyperliquid's own client builds `signatureChainId` from exactly this and signs over
 *  it, so we do the same. The effect is that a wallet is never asked to sign typed data
 *  naming a chain it is not connected to — which is the disagreement that would
 *  otherwise have to be tested wallet by wallet. */
export async function chainIdOf(p: Eip1193Provider): Promise<number> {
  const raw = await p.request({ method: "eth_chainId" }) as unknown;
  const n = typeof raw === "string" ? parseInt(raw, 16) : typeof raw === "number" ? raw : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error("That wallet did not say which chain it is on.");
  }
  return n;
}

/** Put the wallet on a chain, or say plainly that it would not go.
 *
 *  Two methods, because a wallet that has never seen a chain answers 4902 to the first
 *  and needs the second. Only ever called with a chain named in `src/hl/deposit.ts` —
 *  nothing here takes an RPC or a currency from anywhere but version control, because
 *  `wallet_addEthereumChain` is a request to trust an endpoint and a page that took one
 *  from a parameter would be handing wallets somebody else's RPC. */
export async function switchToChain(
  p: Eip1193Provider,
  chain: { chainId: string; chainName: string; rpcUrls: string[]; blockExplorerUrls: string[] },
): Promise<void> {
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.chainId }] });
    return;
  } catch (e) {
    const code = (e as { code?: number }).code;
    // 4902 is "unrecognised chain". Anything else — including the user declining — is
    // theirs to answer, not something to paper over by adding a network.
    if (code !== 4902) throw e;
  }
  await p.request({
    method: "wallet_addEthereumChain",
    params: [{
      chainId: chain.chainId, chainName: chain.chainName,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: chain.rpcUrls, blockExplorerUrls: chain.blockExplorerUrls,
    }],
  });
  await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chain.chainId }] });
}

/** A read, through the wallet's own RPC.
 *
 *  The page cannot call an Arbitrum node itself — its CSP is `connect-src 'self'` — but
 *  an `eth_call` through the injected provider never touches the page's network stack.
 *  So the token balance is read where the money is, with no RPC of ours in the middle
 *  and no server route to keep in sync. */
export async function ethCall(p: Eip1193Provider, to: string, data: string, from?: string): Promise<string> {
  const call = from === undefined ? { to, data } : { to, data, from };
  const out = await p.request({ method: "eth_call", params: [call, "latest"] }) as unknown;
  if (typeof out !== "string" || !/^0x[0-9a-fA-F]*$/.test(out)) {
    throw new Error("That wallet returned something we could not read from the chain.");
  }
  return out;
}

export async function ethBalance(p: Eip1193Provider, address: string): Promise<bigint> {
  const out = await p.request({ method: "eth_getBalance", params: [address, "latest"] }) as unknown;
  return typeof out === "string" ? BigInt(out) : 0n;
}

/** What a unit of gas costs right now, so "enough for the transaction" can be a
 *  calculation rather than a constant somebody guessed. Arbitrum's is measured in
 *  hundredths of a gwei and moves. */
export async function gasPrice(p: Eip1193Provider): Promise<bigint> {
  const out = await p.request({ method: "eth_gasPrice" }) as unknown;
  return typeof out === "string" ? BigInt(out) : 0n;
}

/** Whether this address has code — a smart-contract wallet, or an EOA that has
 *  delegated under EIP-7702 (`0xef0100…`). Both need a different deposit path than the
 *  one we build, and saying so beats a transaction that reverts. */
export async function hasCode(p: Eip1193Provider, address: string): Promise<boolean> {
  const out = await p.request({ method: "eth_getCode", params: [address, "latest"] }) as unknown;
  return typeof out === "string" && out.length > 2;
}

/** The one call that moves money. Returns the transaction hash. */
export async function sendTransaction(
  p: Eip1193Provider, tx: { from: string; to: string; data: string },
): Promise<string> {
  const hash = await p.request({ method: "eth_sendTransaction", params: [{ ...tx, value: "0x0" }] }) as unknown;
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("That wallet did not return a transaction hash.");
  }
  return hash;
}

/** EIP-712. The payload goes as a **JSON string**, not an object: wallets disagree
 *  about accepting an object, and every one of them accepts the string. */
export async function signTypedData(
  p: Eip1193Provider, address: string, typedData: unknown,
): Promise<string> {
  const sig = await p.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(typedData)],
  }) as unknown;
  // 65 bytes. A shorter answer is a wallet we do not understand rather than one we
  // should guess at — the server splits this into r, s and v and would mis-slice it.
  if (typeof sig !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sig)) {
    throw new Error("That wallet returned a signature we could not read.");
  }
  return sig;
}
