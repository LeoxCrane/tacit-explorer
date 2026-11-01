// TAC's public price.
//
// TAC has no oracle of its own. It trades on Uniswap v4 against USDC and ETH,
// and DexScreener indexes those pools with CORS open, so the browser can read
// the same numbers the market sees. The pool is thin, so liquidity is shown
// next to the price instead of hidden behind it.

import { fetchJSON } from './net.js';

export const TAC_TOKEN = '0xA1313eb9f3A445606D9583bcAc3ebeB56a858279';

let cache = { at: 0, value: null };

export async function tacPrice({ maxAgeMs = 45000 } = {}) {
  if (cache.value && Date.now() - cache.at < maxAgeMs) return cache.value;
  const res = await fetchJSON(`https://api.dexscreener.com/latest/dex/tokens/${TAC_TOKEN}`, { timeout: 12000 });
  if (!res.ok) return { ok: false, error: res.error };

  const pairs = (res.data?.pairs || []).filter((p) => p.priceUsd && Number(p.priceUsd) > 0);
  if (!pairs.length) return { ok: false, error: 'no public TAC pair found' };

  // deepest pool wins: it is the price a real swap would actually meet
  const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
  const value = {
    ok: true,
    usd: Number(best.priceUsd),
    change24h: typeof best.priceChange?.h24 === 'number' ? best.priceChange.h24 : null,
    liquidityUsd: best.liquidity?.usd ?? null,
    volume24h: best.volume?.h24 ?? null,
    fdv: best.fdv ?? null,
    dexId: best.dexId || 'uniswap',
    quote: best.quoteToken?.symbol || '',
    pair: best.pairAddress,
    labels: best.labels || [],
    url: best.url || null,
    pairs: pairs.length,
    at: Date.now(),
  };
  cache = { at: Date.now(), value };
  return value;
}

export function fmtUsdPrice(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 0.01) return `$${value.toFixed(4)}`;
  if (value >= 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toPrecision(3)}`;
}

export function fmtChange(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

// BTC and ETH in dollars, for the header. CoinGecko first, Coinbase as a fallback:
// both answer with CORS open, and neither needs a key.
let majorsCache = { at: 0, value: null };

export async function majorPrices({ maxAgeMs = 60000 } = {}) {
  if (majorsCache.value && Date.now() - majorsCache.at < maxAgeMs) return majorsCache.value;

  try {
    const cg = await fetchJSON(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd',
      { timeout: 10000 },
    );
    const btc = Number(cg.data?.bitcoin?.usd);
    const eth = Number(cg.data?.ethereum?.usd);
    if (cg.ok && btc > 0 && eth > 0) {
      const value = { ok: true, btc, eth, source: 'coingecko' };
      majorsCache = { at: Date.now(), value };
      return value;
    }
  } catch { /* fall through to Coinbase */ }

  try {
    const [b, e] = await Promise.all([
      fetchJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot', { timeout: 10000 }),
      fetchJSON('https://api.coinbase.com/v2/prices/ETH-USD/spot', { timeout: 10000 }),
    ]);
    const btc = Number(b.data?.data?.amount);
    const eth = Number(e.data?.data?.amount);
    if (b.ok && e.ok && btc > 0 && eth > 0) {
      const value = { ok: true, btc, eth, source: 'coinbase' };
      majorsCache = { at: Date.now(), value };
      return value;
    }
  } catch { /* both sources down */ }

  return { ok: false, error: 'no price source answered' };
}
