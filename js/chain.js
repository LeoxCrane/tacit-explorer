// EVM reads: the pool's own attested state, canonical token supplies, XNS names.
// Everything here is a plain eth_call against a public RPC, no signer, no wallet.

import { CHAINS, POOL_SELECTORS, XNS } from './config.js';
import {
  decodeAddressWord, decodeStringResult, encodeAddress, encodeString,
  hexToBigInt, makeRpc, reverseBytes, splitWords,
} from './net.js';

export const eth = makeRpc(CHAINS.ethereum.rpc, 'ethereum');
export const base = makeRpc(CHAINS.base.rpc, 'base');

const poolCall = async (selector, arg) => {
  const data = selector + (arg || '');
  const res = await eth.call(CHAINS.ethereum.pool, data);
  return res;
};

/** The pool's on-chain view of how far Bitcoin is reflected. */
export async function readPool() {
  const [tip, digest, consumed, crossOuts] = await Promise.all([
    poolCall(POOL_SELECTORS.attestedReflectionTip),
    poolCall(POOL_SELECTORS.attestedReflectionDigest),
    poolCall(POOL_SELECTORS.attestedBitcoinConsumedCount),
    poolCall(POOL_SELECTORS.attestedCrossOutCount),
  ]);
  const fail = [tip, digest, consumed, crossOuts].find((r) => !r.ok);
  if (fail) return { ok: false, error: fail.error };
  const tipHex = tip.result;
  return {
    ok: true,
    attestedTipBytes: tipHex,
    // Bitcoin block hashes are stored in internal (little-endian) byte order.
    attestedTipDisplay: reverseBytes(tipHex),
    digest: digest.result,
    consumed: hexToBigInt(consumed.result),
    crossOuts: hexToBigInt(crossOuts.result),
  };
}

/** Read one asset's pool registration. */
export async function readAsset(assetId) {
  const res = await poolCall(POOL_SELECTORS.assets, encodeAddress('0x' + String(assetId).replace(/^0x/, '')));
  if (!res.ok) return { ok: false, error: res.error };
  const w = splitWords(res.result);
  if (w.length < 6) return { ok: false, error: 'short result' };
  return {
    ok: true,
    registered: BigInt('0x' + w[0]) === 1n,
    underlying: decodeAddressWord(w[1]),
    unitScale: BigInt('0x' + w[2]),
    crossChainLink: '0x' + w[3],
    poolMinted: BigInt('0x' + w[4]) === 1n,
    decimals: Number(BigInt('0x' + w[5])),
  };
}

export async function readSupply(tokenAddress) {
  if (!tokenAddress) return { ok: false, error: 'native asset (no ERC20)' };
  const res = await eth.call(tokenAddress, POOL_SELECTORS.totalSupply);
  if (!res.ok) return { ok: false, error: res.error };
  return { ok: true, supply: hexToBigInt(res.result) };
}

export async function readBlockNumber(chain = 'ethereum') {
  const client = chain === 'base' ? base : eth;
  const res = await client.request('eth_blockNumber', []);
  return res.ok ? { ok: true, block: hexToBigInt(res.result) } : res;
}

export async function readBalance(address, chain = 'ethereum') {
  const client = chain === 'base' ? base : eth;
  const res = await client.request('eth_getBalance', [address, 'latest']);
  return res.ok ? { ok: true, wei: hexToBigInt(res.result) } : res;
}

export async function hasCode(address, chain = 'ethereum') {
  const client = chain === 'base' ? base : eth;
  const res = await client.request('eth_getCode', [address, 'latest']);
  if (!res.ok) return res;
  const code = res.result || '0x';
  // EIP-7702 delegation designator: 0xef0100 || address: an EOA that has
  // delegated its code, not a deployed contract.
  const delegated = code.startsWith('0xef0100') && code.length === 2 + 6 + 40;
  return { ok: true, hasCode: code !== '0x', code, delegated };
}

export async function evmTransaction(hash) {
  const out = {};
  for (const key of ['ethereum', 'base']) {
    const client = key === 'ethereum' ? eth : base;
    const tx = await client.request('eth_getTransactionByHash', [hash]);
    if (tx.ok && tx.result) {
      const receipt = await client.request('eth_getTransactionReceipt', [hash]);
      out[key] = { tx: tx.result, receipt: receipt.ok ? receipt.result : null };
    }
  }
  return out;
}

// ---- XNS names ----------------------------------------------------------

const nameCache = new Map();
const reverseCache = new Map();

/** address → `label@namespace` ('' when unnamed). */
export async function xnsName(address) {
  const key = String(address).toLowerCase();
  if (reverseCache.has(key)) return reverseCache.get(key);
  const res = await eth.call(XNS.address, XNS.sel.getName + encodeAddress(key));
  const value = res.ok ? decodeStringResult(res.result) : '';
  if (res.ok) reverseCache.set(key, value);
  return value;
}

/** `label@namespace` → { address, name } */
export async function xnsResolve(name) {
  const key = String(name).trim().toLowerCase();
  if (!key.includes('@')) return { ok: false, error: 'names look like alice@xns' };
  if (nameCache.has(key)) return nameCache.get(key);
  const res = await eth.call(XNS.address, XNS.sel.getAddress + encodeString(key));
  if (!res.ok) return { ok: false, error: res.error };
  const address = decodeAddressWord(splitWords(res.result)[0] || '');
  const out = address === '0x0000000000000000000000000000000000000000'
    ? { ok: false, error: 'that name is not registered', address: null, name: key }
    : { ok: true, address, name: key };
  nameCache.set(key, out);
  return out;
}

/** Attach XNS names to a list of addresses (bounded, cached). */
export async function xnsNames(addresses, limit = 8) {
  const unique = [...new Set(addresses.map((a) => String(a).toLowerCase()))].slice(0, limit);
  const pairs = await Promise.all(unique.map(async (a) => [a, await xnsName(a)]));
  return Object.fromEntries(pairs.filter(([, name]) => name));
}
