// Client for Tacit's public relay API (api.tacit.finance).
// Only CORS-open routes are used from the browser: /confidential/*,
// /reflection/*, /farm/*, /relay/*, /prover/*.

import { TACIT_API } from './config.js';
import { fetchJSON } from './net.js';

const get = (path, opts) => fetchJSON(`${TACIT_API}${path}`, opts);

export const tacit = {
  reflectionStatus: () => get('/reflection/status', { timeout: 15000 }),
  relay: () => get('/confidential/relay', { timeout: 15000 }),
  relayEconomics: () => get('/relay/economics', { timeout: 20000 }),
  proverBoard: () => get('/prover/board', { timeout: 15000 }),
  farmProgram: () => get('/farm/program?network=mainnet', { timeout: 20000 }),
  farmHealth: () => get('/farm/health', { timeout: 20000 }),
  openJobs: (limit = 5) => get(`/confidential/open?limit=${limit}`, { timeout: 20000 }),
  /** The pool's public event stream. Slow on Tacit's side (5 to 15 seconds), so it is cached. */
  poolIndex: ({ from = 0, limit = 40 } = {}) =>
    get(`/confidential/index?from=${from}&limit=${limit}`, { timeout: 60000 }),
  /** Full reflected state: ~3.5 MB, only fetched on demand. */
  reflectionDump: () => get('/reflection/dump', { timeout: 90000 }),
  quote: (asset = 'cETH') => get(`/confidential/quote?asset=${asset}`, { timeout: 20000 }),
};

/** Snapshot written by the scheduled GitHub Action (data/snapshot.json). */
export async function loadSnapshot() {
  // Resolve against the page URL so this works from a GitHub Pages subpath
  // (and from any base directory) instead of assuming a site root.
  let url = 'data/snapshot.json';
  for (const base of [globalThis.location?.href, document.baseURI]) {
    try { if (base && base.startsWith('http')) { url = new URL('data/snapshot.json', base).href; break; } } catch { /* next */ }
  }
  const r = await fetchJSON(url, { timeout: 15000 });
  return r.ok ? { ok: true, snapshot: r.data, url } : { ok: false, error: r.error };
}
