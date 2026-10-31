// Bitcoin reads: tip + blocks + transactions.
// Preferred path for whole blocks is a public Bitcoin Core JSON-RPC node
// (getblock verbosity 2 returns witnesses, which the envelope decoder needs).
// Esplora (blockstream / mempool.space) covers tip, headers and single txs.

import { BITCOIN } from './config.js';
import { decodeTransaction } from './envelope.js';

async function fetchText(urls, { timeout = 15000 } = {}) {
  const errors = [];
  for (const base of urls) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(base, { signal: ctl.signal, credentials: 'omit', mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return { ok: true, text: (await res.text()).trim(), url: base };
    } catch (err) {
      errors.push(`${new URL(base).host}: ${err.name === 'AbortError' ? 'timeout' : err.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, error: errors.join(' · ') };
}

async function fetchJson(url, { timeout = 20000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', mode: 'cors', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Try every configured esplora host before giving up. */
async function firstJson(urls, { timeout = 20000 } = {}) {
  const errors = [];
  for (const url of urls) {
    const r = await fetchJson(url, { timeout });
    if (r.ok) return r;
    errors.push(`${new URL(url).host}: ${r.error}`);
  }
  return { ok: false, error: errors.join(' · ') };
}

export const esplora = {
  async tipHeight() {
    const r = await fetchText(BITCOIN.esplora.map((b) => `${b}/blocks/tip/height`));
    return r.ok ? { ok: true, height: Number(r.text) } : r;
  },
  async blockHashAt(height) {
    const r = await fetchText(BITCOIN.esplora.map((b) => `${b}/block-height/${height}`));
    return r.ok ? { ok: true, hash: r.text } : r;
  },
  async block(hash) {
    const r = await firstJson(BITCOIN.esplora.map((b) => `${b}/block/${hash}`));
    return r.ok ? { ok: true, block: r.data } : r;
  },
  async recentBlocks() {
    const r = await firstJson(BITCOIN.esplora.map((b) => `${b}/blocks`));
    return r.ok ? { ok: true, blocks: r.data } : r;
  },
  async tx(txid) {
    const r = await firstJson(BITCOIN.esplora.map((b) => `${b}/tx/${txid}`));
    return r.ok ? { ok: true, tx: r.data } : r;
  },
  async addressTxs(address) {
    const r = await firstJson(BITCOIN.esplora.map((b) => `${b}/address/${address}`));
    return r.ok ? { ok: true, address: r.data } : r;
  },
};

export function makeBitcoinRpc() {
  let good = 0;
  async function request(method, params = [], { timeout = 90000 } = {}) {
    const order = [...BITCOIN.rpc.slice(good), ...BITCOIN.rpc.slice(0, good)];
    let lastError = '';
    for (const url of order) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const res = await fetch(url, {
          method: 'POST',
          signal: ctl.signal,
          credentials: 'omit',
          mode: 'cors',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error.message || 'rpc error');
        good = BITCOIN.rpc.indexOf(url);
        return { ok: true, result: json.result };
      } catch (err) {
        lastError = `${new URL(url).host}: ${err.name === 'AbortError' ? 'timeout' : err.message}`;
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: lastError };
  }
  return { request };
}

export const btc = makeBitcoinRpc();

/**
 * Fetch one block with full witness data and decode every Tacit envelope in it.
 * cost: ~10 MB and a few seconds per block on the public node.
 */
export async function scanBlock(hashOrHeight, { signal } = {}) {
  let hash = hashOrHeight;
  if (typeof hashOrHeight === 'number') {
    const h = await btc.request('getblockhash', [hashOrHeight]);
    if (!h.ok) return { ok: false, error: h.error };
    hash = h.result;
  }
  const res = await btc.request('getblock', [hash, 2]);
  if (!res.ok) return { ok: false, error: res.error, hash };
  if (signal?.aborted) return { ok: false, error: 'aborted', hash };
  const block = res.result;
  const envelopes = [];
  for (const tx of block.tx || []) {
    const env = decodeTransaction(tx);
    if (env) {
      envelopes.push({
        txid: tx.txid,
        height: block.height,
        time: block.time,
        vsize: tx.vsize,
        env,
      });
    }
  }
  return {
    ok: true,
    hash: block.hash,
    height: block.height,
    time: block.time,
    txCount: (block.tx || []).length,
    size: block.size,
    weight: block.weight,
    envelopes,
  };
}
