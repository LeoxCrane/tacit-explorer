// Build data/snapshot.json: the small, static cache of things the browser
// cannot fetch cross-origin directly (tacitscan's envelope index) plus a
// pre-digest of two big/slow Tacit endpoints.
//
// The page is designed to work without this file, but with it the Bitcoin feed
// and the pool event list are instant. Run by .github/workflows/snapshot.yml.
//
//   node tools/snapshot.mjs            # write if changed
//   node tools/snapshot.mjs --force    # always write
//   node tools/snapshot.mjs --check    # exit 1 if a fetch failed

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'snapshot.json');
const API = 'https://api.tacit.finance';
const args = new Set(process.argv.slice(2));

const getJSON = async (url, timeout = 60000) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
};

const failures = [];
const note = (label, res) => {
  if (res.ok) console.log(`ok    ${label}`);
  else {
    console.log(`FAIL  ${label}: ${res.error}`);
    failures.push(`${label}: ${res.error}`);
  }
};

// 1. Envelope index (tacitscan has no CORS; this is why the snapshot exists)
const feed = await getJSON('https://tacitscan.io/api/feed', 30000);
note('tacitscan /api/feed', feed);

// 1b. Protocol counters. tacitscan renders them server side and exposes no JSON
// for them, so read the three numbers straight out of the markup. If the shape
// changes the fields are simply absent, and the page shows n/a rather than a
// number nobody can source.
const totals = { envelopes: null, assets: null, etches: null, indexedTo: null };
try {
  const res = await fetch('https://tacitscan.io/', { headers: { accept: 'text/html' } });
  const html = await res.text();
  const stat = (label) => {
    const re = new RegExp(`class="label">${label}</div><div class="value">([^<]+)<`);
    const m = html.match(re);
    return m ? m[1].trim() : null;
  };
  const split = (value) => (value || '').split('/').map((s) => s.trim());
  totals.envelopes = Number(stat('Envelopes')) || null;
  totals.assets = Number(stat('Assets')) || null;
  const etches = split(stat('CETCH / T_PETCH'));
  totals.etches = Number(etches[0]) || null;
  totals.tpetches = Number(etches[1]) || null;
  totals.indexedTo = Number(stat('Indexed to')) || null;
  console.log(totals.envelopes ? 'ok    tacitscan counters' : 'WARN  tacitscan counters not found in markup');
} catch (err) {
  console.log(`WARN  tacitscan counters: ${err.message}`);
}

// 2. Pool event stream: ask for the total, then the tail
const probe = await getJSON(`${API}/confidential/index?from=0&limit=1`);
note('tacit /confidential/index (probe)', probe);
let poolIndex = null;
if (probe.ok) {
  const total = probe.data.total;
  const from = Math.max(0, total - 40);
  const tail = await getJSON(`${API}/confidential/index?from=${from}&limit=40`);
  note('tacit /confidential/index (tail)', tail);
  if (tail.ok) {
    poolIndex = {
      total: tail.data.total,
      deployBlock: tail.data.deployBlock,
      indexedToBlock: tail.data.indexedToBlock,
      headBlock: tail.data.headBlock,
      synced: tail.data.synced,
      counts: tail.data.counts,
      entries: tail.data.entries,
    };
  }
}

// 3. Reflected state: 3.5 MB on the wire, pre-digested to a few hundred bytes
const dump = await getJSON(`${API}/reflection/dump`, 120000);
note('tacit /reflection/dump', dump);
let reflection = null;
if (dump.ok) {
  const s = dump.data?.snapshot || {};
  const pool = (s.pools || [])[0] || null;
  reflection = {
    height: s.height,
    noteLeaves: (s.noteLeaves || []).length,
    liveTriples: (s.liveTriples || []).length,
    cbtcLockTriples: (s.cbtcLockTriples || []).length,
    pendingDeposits: (s.pendingDepositRecords || []).length,
    pendingDepositRecords: (s.pendingDepositRecords || []).slice(-8).map((r) => ({
      burnTxidDisplay: r.burnTxidDisplay,
      height: r.height,
      burnedVout: r.burnedVout,
    })),
    foldedCrossoutCount: s.foldedCrossoutCount,
    cbtcBackingSats: s.cbtcBackingSats,
    amm: pool
      ? {
        poolId: pool.poolId,
        reserveA: pool.reserveA,
        reserveB: pool.reserveB,
        totalShares: pool.totalShares,
        feeBps: pool.feeBps,
        c0Backed: pool.c0Backed,
      }
      : null,
  };
}

// 4. Status: cheap, and handy as a cross-check on the derived numbers
const status = await getJSON(`${API}/reflection/status`, 20000);
note('tacit /reflection/status', status);

const snapshot = {
  generatedAt: new Date().toISOString(),
  bitcoin: {
    // Keep only the fields the page renders. The index also ships per-asset
    // identicon markup; the page draws its own chips and never injects third-
    // party SVG, so that is dropped here rather than shipped into the DOM.
    feed: feed.ok
      ? feed.data.rows.map((row) => ({
        txid: row.txid,
        opcode: row.opcode,
        assetId: row.assetId,
        ticker: row.ticker,
        displayName: row.displayName,
        blockHeight: row.blockHeight,
        blockTime: row.blockTime,
        chainStatus: row.chainStatus,
        firstSeenAt: row.firstSeenAt,
      }))
      : [],
    totals,
  },
  pool: { index: poolIndex },
  reflection: {
    status: status.ok ? status.data : null,
    ...(reflection || {}),
  },
  failures,
};

// Only rewrite when the *content* changed. Timestamps and chain heights move
// on every run, and a bot that commits noise every half hour is worse than a
// snapshot whose age is visible in its newest row.
const stableKey = (obj) => JSON.stringify({
  feed: (obj?.bitcoin?.feed || []).map((r) => `${r.txid}:${r.opcode}:${r.assetId}`),
  amm: obj?.reflection?.amm || null,
  deposits: (obj?.reflection?.pendingDepositRecords || []).map((r) => r.burnTxidDisplay),
  // Pool events are deliberately *not* in the key: the pool indexer ingests
  // continuously, so its sliding window changes on almost every run. The page
  // reads the pool index live and treats the snapshot copy as a fallback, so
  // those entries ride along with the next real envelope instead of pulling a
  // commit every half hour.
});

let previous = null;
try { previous = JSON.parse(await fs.readFile(OUT, 'utf8')); } catch { /* first run */ }

const changed = !previous || stableKey(previous) !== stableKey(snapshot);
if (!changed && !args.has('--force')) {
  console.log('no new envelopes, events, AMM moves or deposits, leaving data/snapshot.json as it is');
} else {
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(snapshot, null, 2) + '\n');
  const bytes = (await fs.stat(OUT)).size;
  console.log(`wrote data/snapshot.json (${(bytes / 1024).toFixed(1)} kB, ${snapshot.bitcoin.feed.length} envelopes, ${poolIndex?.entries?.length ?? 0} pool events)`);
}

if (failures.length && args.has('--check')) process.exit(1);
