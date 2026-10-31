// Network layer: JSON fetches with timeouts, rotating RPC clients, in-memory cache.
// Every call returns a result object instead of throwing, so panels can render
// honestly ("unavailable: <reason>") instead of blanking out.

const cache = new Map();

export async function fetchJSON(url, { timeout = 20000, headers = {}, signal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const onAbort = () => ctl.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: 'application/json', ...headers },
      // no credentials: this page never authenticates to anything
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return { ok: true, data: JSON.parse(text), status: res.status };
  } catch (err) {
    const reason = err.name === 'AbortError' ? `timeout after ${timeout}ms` : err.message || 'network error';
    return { ok: false, error: reason };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Try a list of URLs in order; returns the first success plus which endpoint answered. */
export async function fetchFirst(urls, opts = {}) {
  const errors = [];
  for (const url of urls) {
    const r = await fetchJSON(url, opts);
    if (r.ok) return { ...r, url };
    errors.push(`${new URL(url).host}: ${r.error}`);
  }
  return { ok: false, error: errors.join(' · ') };
}

export function cached(key, ttlMs, producer) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value);
  return Promise.resolve(producer()).then((value) => {
    cache.set(key, { at: Date.now(), value });
    return value;
  });
}

export const clearCache = (prefix) => {
  for (const k of [...cache.keys()]) if (!prefix || k.startsWith(prefix)) cache.delete(k);
};

/** Minimal JSON-RPC client that rotates across endpoints on failure. */
export function makeRpc(urls, label = 'rpc') {
  let cursor = 0;
  const ordered = () => {
    const out = [];
    for (let i = 0; i < urls.length; i++) out.push(urls[(cursor + i) % urls.length]);
    return out;
  };
  let lastGood = 0;

  async function request(method, params = [], { timeout = 20000 } = {}) {
    const order = lastGood ? [urls[lastGood], ...ordered().filter((u) => u !== urls[lastGood])] : ordered();
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
        if (json.error) throw new Error(json.error.message || `rpc error ${json.error.code}`);
        lastGood = urls.indexOf(url);
        cursor = lastGood;
        return { ok: true, result: json.result, url };
      } catch (err) {
        lastError = `${new URL(url).host}: ${err.name === 'AbortError' ? 'timeout' : err.message}`;
      } finally {
        clearTimeout(timer);
      }
    }
    return { ok: false, error: lastError || `${label} unreachable` };
  }

  return {
    request,
    call: (to, data) => request('eth_call', [{ to, data }, 'latest']),
  };
}

// ---- ABI-ish decoding helpers -------------------------------------------

export const hexToBigInt = (hex) => (hex && hex !== '0x' ? BigInt(hex) : 0n);

export function splitWords(hex) {
  const body = String(hex || '').replace(/^0x/, '');
  const words = [];
  for (let i = 0; i + 64 <= body.length; i += 64) words.push(body.slice(i, i + 64));
  return words;
}

export function decodeAddressWord(word) {
  return '0x' + String(word).slice(-40);
}

export function decodeStringResult(hex) {
  const words = splitWords(hex);
  if (!words.length) return '';
  const len = Number(BigInt('0x' + words[1]));
  const data = words.slice(2).join('').slice(0, len * 2);
  const bytes = data.match(/.{1,2}/g) || [];
  return new TextDecoder().decode(new Uint8Array(bytes.map((b) => parseInt(b, 16))));
}

export function encodeAddress(address) {
  return String(address).toLowerCase().replace(/^0x/, '').padStart(64, '0');
}

export function encodeString(value) {
  const bytes = new TextEncoder().encode(value);
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  const padded = hex.padEnd(Math.max(64, Math.ceil(hex.length / 64) * 64), '0');
  const len = bytes.length.toString(16).padStart(64, '0');
  return (32).toString(16).padStart(64, '0') + len + padded;
}

export function reverseBytes(hex) {
  const n = String(hex).replace(/^0x/, '');
  const pairs = n.match(/.{1,2}/g) || [];
  return pairs.reverse().join('');
}
