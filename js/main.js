// Tacit Explorer: page logic.
// Each panel fetches its own sources, renders what answered, and says plainly
// what did not. No number on this page is invented: if a source is down the
// panel degrades instead of guessing.

import {
  ASSETS, BITCOIN, CHAINS, CONTRACTS, OPCODES, TACIT_API, XNS,
} from './config.js';
import {
  evmTransaction, hasCode, readAsset, readBalance, readBlockNumber, readPool, readSupply,
  xnsName, xnsNames, xnsResolve,
} from './chain.js';
import { esplora, scanBlock } from './bitcoin.js';
import { loadSnapshot, tacit } from './tacit.js';
import { decodeTacitAddress } from './tacit1.js';
import { decodeTransaction } from './envelope.js';
import { fmtChange, fmtUsdPrice, tacPrice } from './price.js';
import {
  $, el, fmtCompact, fmtInt, fmtUnits, fmtUtc, hueOf, norm, short, timeAgo,
} from './util.js';

// ---------------------------------------------------------------- pages

// Each HTML file sets data-page; this module builds the shared chrome, mounts
// that page's sections, and only fetches what the page actually shows.
const PAGE = document.body.dataset.page || 'home';
const PAGES = {
  home: { title: 'Home' },
  blocks: { title: 'Blocks' },
  envelopes: { title: 'Envelopes' },
  pool: { title: 'Pool' },
  bridge: { title: 'Bridge' },
  assets: { title: 'Assets' },
  farms: { title: 'Farms and relay' },
  privacy: { title: 'Privacy' },
  search: { title: 'Search' },
};

const NAV = [
  ['home', 'Home', './'],
  ['blocks', 'Blocks', './blocks.html'],
  ['envelopes', 'Envelopes', './envelopes.html'],
  ['pool', 'Pool', './pool.html'],
  ['bridge', 'Bridge', './bridge.html'],
  ['assets', 'Assets', './assets.html'],
  ['farms', 'Farms and relay', './farms.html'],
  ['privacy', 'Privacy', './privacy.html'],
];

const state = {
  refreshedAt: null,
  snapshot: null,
  snapshotAt: null,
  status: null,
  relay: null,
  poolIndex: null,
  farm: null,
  farmHealth: null,
  economics: null,
  board: null,
  quotes: null,
  bitcoinTip: null,
  recentBlocks: [],
  poolChain: null,
  baseBlock: null,
  ethBlock: null,
  assetChain: {},
  supplies: {},
  sources: {},
  feed: [],
  feedOrigin: null,
  filter: 'all',
  scan: null,
  scanningHeight: null,
  lastEmptyBlock: null,
  openJobs: null,
  price: null,
};

const ASSET_BY_ID = new Map(ASSETS.map((a) => [norm(a.id), a]));
const CONTRACT_BY_ADDR = new Map(CONTRACTS.map((c) => [c.address.toLowerCase(), c]));
const NAME_TO_FAMILY = new Map();
for (const [op, meta] of Object.entries(OPCODES)) NAME_TO_FAMILY.set(meta.name, meta.family);
NAME_TO_FAMILY.set('T_POOL_BRIDGE_BURN', 'bridge');
NAME_TO_FAMILY.set('UNKNOWN', 'unknown');

// ---------------------------------------------------------------- helpers

const assetOf = (assetId) => (assetId ? ASSET_BY_ID.get(norm(assetId)) : null);

function assetLabel(assetId, tickerHint) {
  const asset = assetOf(assetId);
  if (asset) return asset.symbol;
  if (tickerHint) return tickerHint;
  return assetId ? short('0x' + norm(assetId), 6, 4) : 'unknown';
}

function assetChip(assetId, tickerHint) {
  const label = assetLabel(assetId, tickerHint);
  const hue = hueOf(norm(assetId || label));
  const tag = el('span', { class: 'tag', style: `background:hsl(${hue} 62% 62%)` }, [label.slice(0, 2).toUpperCase()]);
  return el('span', { class: 'asset' }, [tag, el('span', {}, [label])]);
}

/** pool in-system units → a human amount, using the asset's unit scale. */
function fmtInSystem(rawUnits, assetId, tickerHint) {
  const asset = assetOf(assetId);
  if (!asset) {
    // The pool has no registry entry for this asset, so its unit scale is not
    // published here. Show the raw u64 and say so instead of inventing a scale.
    return `${String(rawUnits)} units`;
  }
  try {
    const value = BigInt(rawUnits) * BigInt(asset.units);
    return `${fmtUnits(value, asset.decimals)} ${asset.symbol}`;
  } catch { return null; }
}

function fmtWei(value, symbol = 'ETH') {
  try { return `${fmtUnits(value, 18, 8)} ${symbol}`; } catch { return 'n/a'; }
}

const external = (href, text, cls = 'txlink') => el('a', { class: cls, href, target: '_blank', rel: 'noopener' }, [text]);

const txLink = (txid, chain = 'btc') => {
  if (chain === 'btc') {
    return external(`${BITCOIN.explorer}/tx/${txid}`, short(txid, 8, 5));
  }
  return external(`${CHAINS.ethereum.explorer}/tx/${txid}`, short(txid, 8, 5));
};

const unavailable = (message, links = []) => el('div', { class: 'unavailable' }, [
  el('b', {}, ['not available right now']), '. ', message,
  ...(links.length ? [' ', ...links.flatMap((l, i) => (i ? [', ', l] : [l]))] : []),
]);

function statBlock(label, value, hint) {
  return el('div', { class: 'stat' }, [
    el('span', {}, [label]),
    el('b', {}, [value]),
    hint ? el('span', { style: 'text-transform:none;letter-spacing:0;margin-top:2px' }, [hint]) : null,
  ]);
}

function kvList(rows) {
  const dl = el('dl', { class: 'kv' });
  for (const row of rows) {
    if (!row) continue;
    const [label, value, cls] = row;
    dl.appendChild(el('dt', {}, [label]));
    dl.appendChild(el('dd', { class: cls || '' }, [value]));
  }
  return dl;
}

async function track(key, promise) {
  const res = await promise;
  const ok = !!res?.ok;
  state.sources[key] = ok;
  return res;
}

function renderSourceCount() {
  const values = Object.values(state.sources);
  const ok = values.filter(Boolean).length;
  const node = $('#source-count');
  if (node) node.textContent = values.length ? `${ok}/${values.length}` : 'n/a';
  return { ok, total: values.length };
}

function ago(unix) { return `<span class="dim">${timeAgo(unix)}</span>`; }

// ---------------------------------------------------------------- chrome

const SKELETON = (n = 5) => `<div class="skeleton-rows">${'<span></span>'.repeat(n)}</div>`;

const RIBBON_HTML = `
<section class="ribbon" id="ribbon" aria-label="The system at a glance">
  <article class="node node-bitcoin" data-node="bitcoin">
    <header><span class="node-dot"></span> Bitcoin</header>
    <h2>Taproot envelopes</h2>
    <div class="node-metrics" data-metrics>loading</div>
    <footer>blockstream esplora · bitcoin rpc</footer>
  </article>
  <div class="arrow" aria-hidden="true">→</div>
  <article class="node node-reflection" data-node="reflection">
    <header><span class="node-dot"></span> Reflection</header>
    <h2>SP1 proofs</h2>
    <div class="node-metrics" data-metrics>loading</div>
    <footer>api.tacit.finance · pool.attestedReflection*</footer>
  </article>
  <div class="arrow" aria-hidden="true">→</div>
  <article class="node node-eth" data-node="eth">
    <header><span class="node-dot"></span> Ethereum</header>
    <h2>ConfidentialPool</h2>
    <div class="node-metrics" data-metrics>loading</div>
    <footer>eth public rpc · pool events</footer>
  </article>
  <div class="arrow" aria-hidden="true">→</div>
  <article class="node node-evm" data-node="evm">
    <header><span class="node-dot"></span> Base</header>
    <h2>EVM pool</h2>
    <div class="node-metrics" data-metrics>loading</div>
    <footer>base rpc · separate note set</footer>
  </article>
</section>`;

const EXAMPLES_HTML = `
<div class="examples">
  <span>Try</span>
  <button type="button" data-example="53324a143c143cf7cae6fa5c5cfd25d26e312e0b5d898c3b965ee063050133eb">a bridge burn</button>
  <button type="button" data-example="0x000000000Ed1eabD231Be41d93b719056F7febFC">the pool</button>
  <button type="button" data-example="vitalik@eth">an XNS name</button>
  <button type="button" data-example="tacit1qzzs9xyupdmvk43ew87un0hnrmqxcdtq7vjf6mhfuhvrc4mz2ktwqhm0qdk5lnmv6yyy73yd0mccau2em5n66y5a0pyh3xfuhzwmf8g39kctxqngxmx5kxhvt2xqfmf4rufjqgcrgplldjykhww6nnq83gv2kcplcplm0hgggeadk2kqtqtqrk6qpedvat59c6sdeam6ankwjfjgldpjp05v82lv45dajuwype9n88tfdv4d0ta6qyvd9zzzwq58ed9pq75emyyf75">a tacit1 address</button>
</div>`;

const PAGE_BODY = {
  home: `
<section class="hero">
  <h1>The Tacit explorer</h1>
  <p class="lede">
    Assets are issued and moved in Taproot envelopes on Bitcoin. The same confidential notes live in pools on
    Ethereum and Base, and an SP1 proof carries state between them. Everything here is read live, and the line
    between what anyone can see and what stays hidden is drawn on its own page.
  </p>
  ${EXAMPLES_HTML}
</section>
<section class="stats-strip" id="stats">${SKELETON(2)}</section>
${RIBBON_HTML}
<div class="cols cols-main">
  <section class="card" id="blocks">
    <header class="card-head"><h2>Latest blocks</h2><span class="card-tool" id="blocks-badge">n/a</span></header>
    <div class="card-body" id="blocks-body">${SKELETON(6)}</div>
    <footer class="card-foot"><a href="./blocks.html">View all blocks</a><span>click a row to decode it</span></footer>
  </section>
  <section class="card" id="bitcoin">
    <header class="card-head"><h2>Latest envelopes</h2><div class="chips" id="opcode-filters"></div></header>
    <div class="card-body" id="bitcoin-feed">${SKELETON(6)}</div>
    <footer class="card-foot"><span id="feed-foot">n/a</span><a href="./envelopes.html">View all envelopes</a></footer>
  </section>
</div>
<div class="cols cols-thirds" id="quick-links">${SKELETON(3)}</div>
`,

  blocks: `
<section class="hero">
  <h1>Bitcoin blocks</h1>
  <p class="lede">
    The six most recent blocks. Click any row and this page fetches that whole block over JSON-RPC and runs its own
    envelope decoder over all of its transactions, in your browser.
  </p>
</section>
<section class="card" id="blocks">
  <header class="card-head"><h2>Recent blocks</h2><span class="card-tool" id="blocks-badge">n/a</span></header>
  <div class="card-body" id="blocks-body">${SKELETON(6)}</div>
  <footer class="card-foot"><a href="https://mempool.space" target="_blank" rel="noopener">mempool.space</a><span>blockstream esplora</span></footer>
</section>
<section class="verify" id="verify-block">
  <div class="verify-head">
    <div>
      <strong>Decode the latest block</strong>
      <p>One block over JSON-RPC, every transaction decoded here. About 10 MB and a few seconds, and nothing leaves your browser except the block request.</p>
    </div>
    <button class="btn" id="scan-block" type="button">Scan latest block</button>
  </div>
  <div class="verify-out" id="scan-output" hidden></div>
</section>
<section class="card">
  <header class="card-head"><h2>What a decoded block shows</h2><span class="card-tool">decoder notes</span></header>
  <div class="card-body">
    <p>Envelopes ride in the taproot leaf script of the first input: a 32-byte signer key, <code>OP_CHECKSIG</code>, an empty push, <code>OP_IF</code>, then the pushes <code>TACIT</code>, version <code>0x01</code> and the payload, closed by <code>OP_ENDIF</code>. If a block finds nothing, the block was quiet, not broken: Tacit does not fill every block.</p>
  </div>
</section>
`,

  envelopes: `
<section class="hero">
  <h1>Envelopes</h1>
  <p class="lede">
    Every Tacit operation on Bitcoin is a transaction whose first input carries a taproot leaf script starting with
    <code>TACIT</code>. This is the recent index, and each row is decoded from the transaction itself, so the detail
    comes from the chain rather than from a label.
  </p>
</section>
<section class="card" id="bitcoin">
  <header class="card-head"><h2>Recent envelopes</h2><div class="chips" id="opcode-filters"></div></header>
  <div class="card-body" id="bitcoin-feed">${SKELETON(8)}</div>
  <footer class="card-foot"><span id="feed-foot">n/a</span><a href="https://tacitscan.io" target="_blank" rel="noopener">tacitscan</a></footer>
</section>
<section class="card">
  <header class="card-head"><h2>Opcode legend</h2><span class="card-tool">what each kind does</span></header>
  <div class="card-body" id="legend-body">${SKELETON(4)}</div>
</section>
`,

  pool: `
<section class="hero">
  <h1>Confidential pool</h1>
  <p class="lede">
    The public half of the pool on Ethereum: leaves appended, nullifiers spent, deposits wrapped, cross-outs back to
    Bitcoin. A deposit publishes its amount. Everything inside a transfer is a Pedersen commitment, and this page
    cannot open it either.
  </p>
</section>
<section class="card" id="pool">
  <header class="card-head"><h2>Pool activity</h2><span class="card-tool" id="pool-badge">n/a</span></header>
  <div class="card-body" id="pool-body">${SKELETON(6)}</div>
  <footer class="card-foot"><span id="pool-foot">n/a</span><a href="https://etherscan.io/address/${'0x000000000Ed1eabD231Be41d93b719056F7febFC'}" target="_blank" rel="noopener">open the pool on etherscan</a></footer>
</section>
<section class="card">
  <header class="card-head"><h2>What the index is</h2><span class="card-tool">provenance</span></header>
  <div class="card-body" id="pool-meta">${SKELETON(3)}</div>
</section>
`,

  bridge: `
<section class="hero">
  <h1>The bridge</h1>
  <p class="lede">
    Bitcoin activity is folded into the pool by an SP1 reflection program, and the pool stores how far that
    reflection has got. This page checks the pool's attested Bitcoin tip against the real block at that height, and
    shows what is mid-flight in both directions.
  </p>
</section>
<section class="card" id="bridge">
  <header class="card-head"><h2>Header relay and proofs</h2><span class="card-tool" id="bridge-badge">n/a</span></header>
  <div class="card-body" id="bridge-body">${SKELETON(8)}</div>
</section>
<section class="card">
  <header class="card-head"><h2>How to read the check</h2><span class="card-tool">not a proof, a cross-check</span></header>
  <div class="card-body">
    <p>The pool stores Bitcoin block hashes in internal byte order. This page reverses the attested tip and compares it with the block the explorer returns at the same height. Two independent endpoints agreeing on a hash is a strong signal that the reflection is looking at the real chain, but it is a cross-check, not a ZK proof: the proof is verified on-chain by the pool itself.</p>
  </div>
</section>
`,

  assets: `
<section class="hero">
  <h1>Assets</h1>
  <p class="lede">
    The canonical assets the pool keys everything by, their public ERC20 supplies, and the Bitcoin-native pool that
    holds real reserves on Bitcoin. Where a token reads zero, the asset exists only as confidential notes.
  </p>
</section>
<section class="card" id="price-card">
  <header class="card-head"><h2>TAC price</h2><span class="card-tool" id="price-badge">n/a</span></header>
  <div class="card-body" id="price-body">${SKELETON(3)}</div>
</section>
<section class="card" id="assets">
  <header class="card-head"><h2>Canonical set and the Bitcoin AMM</h2><span class="card-tool">supplies read live</span></header>
  <div class="card-body" id="assets-body">${SKELETON(5)}</div>
</section>
`,

  farms: `
<section class="hero">
  <h1>Farms and relay</h1>
  <p class="lede">
    Who proves the settles, what the relay is doing right now, which proven jobs are waiting for any sender to
    submit, and what the TAC launch farms are streaming.
  </p>
</section>
<section class="card" id="relay">
  <header class="card-head"><h2>Relay, provers, farms</h2><span class="card-tool" id="relay-badge">n/a</span></header>
  <div class="card-body" id="relay-body">${SKELETON(8)}</div>
</section>
`,

  privacy: `
<section class="hero">
  <h1>The privacy boundary</h1>
  <p class="lede">
    Tacit hides amounts and owners, not the fact that something happened. This page draws the line with live
    counters next to every claim, because an explorer that overstates privacy is worse than one that hides nothing.
  </p>
</section>
<section class="card" id="privacy">
  <header class="card-head"><h2>What an observer sees, and what stays hidden</h2><span class="card-tool">live counts</span></header>
  <div class="card-body" id="privacy-body">${SKELETON(6)}</div>
</section>
`,

  search: `
<section class="hero" id="search-hero">
  <h1>Search</h1>
  <p class="lede" id="search-lede">Paste a Bitcoin txid, an EVM transaction, an EVM address, a tacit1 address or an XNS name.</p>
</section>
<section id="search-results" class="search-results" aria-live="polite">${SKELETON(3)}</section>
`,
};

const FOOTER_HTML = `
<footer class="site-footer">
  <div>
    <h3>Where the numbers come from</h3>
    <ul class="sources">
      <li><a href="https://api.tacit.finance/reflection/status" target="_blank" rel="noopener">api.tacit.finance</a>: reflected state, pool index, relay, farms</li>
      <li><a href="https://blockstream.info/api/blocks/tip/height" target="_blank" rel="noopener">blockstream.info</a>: Bitcoin tip, headers, transactions</li>
      <li><a href="https://bitcoin-rpc.publicnode.com" target="_blank" rel="noopener">bitcoin-rpc.publicnode.com</a>: whole blocks, for the in-browser decoder</li>
      <li><a href="https://ethereum-rpc.publicnode.com" target="_blank" rel="noopener">ethereum-rpc.publicnode.com</a> and <a href="https://base-rpc.publicnode.com" target="_blank" rel="noopener">base</a>: pool getters, token supplies, XNS</li>
      <li><a href="https://tacitscan.io" target="_blank" rel="noopener">tacitscan.io</a>: envelope index and protocol counters, snapshotted by a scheduled job</li>
      <li><a href="https://dexscreener.com" target="_blank" rel="noopener">dexscreener.com</a>: the TAC price, from its Uniswap pools</li>
      <li><a href="https://xns.name" target="_blank" rel="noopener">xns.name</a>: the name registry at <code>0x6e79…f74b</code></li>
    </ul>
  </div>
  <div>
    <h3>Honest limits</h3>
    <ul class="sources">
      <li>Every number is read live, and each card names where it came from.</li>
      <li>The envelope index is a snapshot, not a live tail. Its age is on the card.</li>
      <li>Nothing here de-anonymises notes. Amounts and owners are not visible to this page either.</li>
      <li>Not affiliated with Tacit. Built from the public spec and live mainnet data.</li>
    </ul>
  </div>
  <div class="footer-meta">
    <span id="last-refreshed">not refreshed yet</span>
    <span>·</span>
    <span>sources <b id="source-count">n/a</b></span>
    <span>·</span>
    <span id="build-stamp">n/a</span>
  </div>
</footer>`;

function mountChrome() {
  const nav = NAV.map(([key, label, href]) => (
    `<a href="${href}"${key === PAGE ? ' class="active" aria-current="page"' : ''}>${label}</a>`
  )).join('');

  document.body.insertAdjacentHTML('afterbegin', `
<div class="util-bar">
  <span class="util-title">Tacit: confidential assets on Bitcoin, Ethereum and Base</span>
  <a class="util-item util-price" href="./assets.html" title="TAC price from its public Uniswap pools"><span>TAC</span> <b id="util-tac">n/a</b></a>
  <span class="util-item">BTC <b id="util-btc">n/a</b></span>
  <span class="util-item">ETH <b id="util-eth">n/a</b></span>
  <span class="util-item">BASE <b id="util-base">n/a</b></span>
  <span class="util-spacer"></span>
  <div class="theme-menu" id="theme-menu">
    <button class="util-button" id="theme-button" type="button" aria-haspopup="menu" aria-expanded="false">
      <span class="theme-dot" aria-hidden="true"></span><span id="theme-label">Dark</span>
    </button>
    <ul class="theme-list" id="theme-list" role="menu" hidden>
      <li><button type="button" role="menuitemradio" data-theme-choice="light">Light</button></li>
      <li><button type="button" role="menuitemradio" data-theme-choice="dim">Dim</button></li>
      <li><button type="button" role="menuitemradio" data-theme-choice="dark">Dark</button></li>
      <li><button type="button" role="menuitemradio" data-theme-choice="auto">Auto (system)</button></li>
    </ul>
  </div>
</div>
<header class="site-head">
  <a class="logo" href="./" aria-label="Tacit Explorer home">
    <span class="logo-mark" aria-hidden="true">◐</span>
    <span class="logo-word">tacit</span>
    <span class="logo-chip">explorer</span>
  </a>
  <form class="search" id="search-form" role="search" autocomplete="off">
    <label class="sr-only" for="search-input">Search by address, transaction, tacit1 address or XNS name</label>
    <input id="search-input" name="q" type="search" spellcheck="false" placeholder="Search by txid, address, tacit1 or name@xns" />
    <button class="btn primary" type="submit">Search</button>
  </form>
  <div class="head-actions">
    <a class="btn ghost" href="https://github.com/src-company/tacit" target="_blank" rel="noopener">Protocol</a>
    <button class="btn ghost icon-only" id="refresh" type="button" title="Re-read every live source" aria-label="Refresh">
      <span aria-hidden="true">↻</span>
    </button>
  </div>
</header>
<nav class="main-nav" aria-label="Sections">${nav}</nav>`);

  document.body.insertAdjacentHTML('beforeend', FOOTER_HTML);
}

function mountPage() {
  const host = document.getElementById('main') || document.body.appendChild(el('main', { id: 'main' }));
  host.innerHTML = PAGE_BODY[PAGE] || PAGE_BODY.home;
}

const THEME_KEY = 'tacit-explorer-theme';
const THEMES = ['light', 'dim', 'dark'];
const THEME_LABEL = { light: 'Light', dim: 'Dim', dark: 'Dark', auto: 'Auto' };

function systemTheme() {
  try { return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; } catch { return 'dark'; }
}
function themePreference() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}
function resolvedTheme(pref = themePreference()) {
  return pref === 'auto' ? systemTheme() : (THEMES.includes(pref) ? pref : 'dark');
}
function applyTheme(pref, { announce = false } = {}) {
  const resolved = resolvedTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', `${resolved} light`);
  const label = $('#theme-label');
  if (label) label.textContent = THEME_LABEL[pref] || THEME_LABEL[resolved];
  const button = $('#theme-button');
  if (button) button.setAttribute('aria-label', `Theme: ${THEME_LABEL[pref] || resolved} (click to change)`);
  for (const item of document.querySelectorAll('[data-theme-choice]')) {
    item.setAttribute('aria-checked', String(item.dataset.themeChoice === pref));
  }
  if (announce) {
    try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  }
}
function initTheme() {
  const pref = themePreference();
  applyTheme(pref);
  try {
    const media = matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', () => { if (themePreference() === 'auto') applyTheme('auto'); });
  } catch { /* no matchMedia */ }
  const button = $('#theme-button');
  const list = $('#theme-list');
  if (!button || !list) return;
  const close = () => { list.hidden = true; button.setAttribute('aria-expanded', 'false'); };
  const open = () => { list.hidden = false; button.setAttribute('aria-expanded', 'true'); };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (list.hidden) open(); else close();
  });
  for (const item of list.querySelectorAll('[data-theme-choice]')) {
    item.addEventListener('click', () => {
      applyTheme(item.dataset.themeChoice, { announce: true });
      close();
    });
  }
  document.addEventListener('click', (event) => { if (!list.hidden && !list.contains(event.target)) close(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') close(); });
}

// ---------------------------------------------------------------- boot

/** Which live sources a page actually needs. Keeps each page's load small. */
const NEEDS = {
  home: { index: true, assets: true, farms: true, extras: false },
  blocks: { index: false, assets: false, farms: false, extras: false },
  envelopes: { index: false, assets: false, farms: false, extras: false },
  pool: { index: true, assets: false, farms: false, extras: false },
  bridge: { index: false, assets: false, farms: false, extras: true },
  assets: { index: false, assets: true, farms: false, extras: false },
  farms: { index: false, assets: false, farms: true, extras: false },
  privacy: { index: true, assets: false, farms: false, extras: false },
  search: { index: false, assets: false, farms: false, extras: false },
};

async function boot() {
  mountChrome();
  mountPage();
  initTheme();
  const needs = NEEDS[PAGE] || NEEDS.home;
  document.title = PAGE === 'home' ? 'Tacit Explorer' : `${PAGES[PAGE]?.title || 'Tacit'} · Tacit Explorer`;
  const stamp = $('#build-stamp');
  if (stamp) stamp.textContent = 'static site';
  buildFilters();
  attachHandlers();
  await refreshAll({ needs });
  if (PAGE === 'search') {
    const query = new URLSearchParams(location.search).get('q') || '';
    if (query) {
      $('#search-input').value = query;
      runLookup(query);
    } else {
      $('#search-lede').textContent = 'Search for a Bitcoin txid, an EVM transaction, an EVM address, a tacit1 address or an XNS name. The box in the header on every page does the same thing.';
      const results = $('#search-results');
      if (results) { results.replaceChildren(); results.hidden = true; }
    }
  }
  if (PAGE === 'blocks') {
    // deep link from the home page or a shared URL: decode that block on arrival
    const wanted = Number(new URLSearchParams(location.search).get('block'));
    if (Number.isFinite(wanted) && wanted > 0) runBlockScan(wanted);
  }
}

async function refreshAll({ needs = NEEDS[PAGE] || NEEDS.home } = {}) {
  const btn = $('#refresh');
  if (btn) btn.disabled = true;
  state.sources = {};
  renderStatsLoading();

  const snapshotPromise = state.snapshot ? Promise.resolve() : loadSnapshot().then((res) => {
    if (res.ok) {
      state.snapshot = res.snapshot;
      state.snapshotAt = res.snapshot.generatedAt || null;
    }
    return res;
  });

  // Live sources, in one batch. Each is tracked for the "sources answering" line.
  const wantFarms = needs.farms || PAGE === 'home';
  const live = [
    track('reflection', tacit.reflectionStatus()),
    track('relay', tacit.relay()),
    track('bitcoin tip', esplora.tipHeight()),
    track('bitcoin blocks', esplora.recentBlocks()),
    track('pool getters', readPool()),
    track('base head', readBlockNumber('base')),
    track('eth head', readBlockNumber('ethereum')),
    track('tac price', tacPrice()),
  ];
  if (wantFarms) {
    live.push(
      track('farms', tacit.farmProgram()),
      track('farm health', tacit.farmHealth()),
      track('relay economics', tacit.relayEconomics()),
      track('prover board', tacit.proverBoard()),
      track('open board', tacit.openJobs(5)),
    );
  }

  const [status, relay, tip, blocksRes, poolChain, baseBlockRes, ethBlockRes, price, ...rest] = await Promise.all(live);

  if (status.ok) state.status = status.data;
  if (relay.ok) state.relay = relay.data;
  if (tip.ok) state.bitcoinTip = tip.height;
  if (blocksRes.ok) state.recentBlocks = blocksRes.blocks.slice(0, 6);
  if (poolChain.ok) state.poolChain = poolChain;
  if (baseBlockRes.ok) state.baseBlock = baseBlockRes.block;
  if (ethBlockRes.ok) state.ethBlock = ethBlockRes.block;
  // tacPrice resolves with { ok, usd, ... } directly; track() only records it.
  state.price = price.ok && price.usd !== undefined ? price : null;

  if (wantFarms) {
    const [farm, farmHealth, economics, board, openJobs] = rest;
    if (farm?.ok) state.farm = farm.data;
    if (farmHealth?.ok) state.farmHealth = farmHealth.data;
    if (economics?.ok) state.economics = economics.data;
    if (board?.ok) state.board = board.data;
    if (openJobs?.ok) state.openJobs = openJobs.data;
  }

  await snapshotPromise;

  // Bitcoin envelope index: the scheduled snapshot is the only cross-origin-free
  // source for tacitscan's index, so prefer it and fall back to a live block scan.
  const snapFeed = state.snapshot?.bitcoin?.feed;
  if (Array.isArray(snapFeed) && snapFeed.length) {
    const { rows, unread } = normalizeSnapshotRows(snapFeed);
    state.sources['envelope index'] = true;
    setFeed(rows, 'index', { unread: unread.length, generatedAt: state.snapshot.generatedAt });
  } else {
    state.sources['envelope index'] = false;
    state.feedOrigin = 'unavailable';
    state.feed = [];
  }

  // Pool event stream: read it live (it is the chain's own index and takes ~10 s),
  // without blocking the rest of the page. The snapshot copy is the fallback.
  if (needs.index) kickPoolIndex();

  // Chain reads for the canonical assets (supplies) + the other chains' pool.
  if (needs.assets) await loadAssets();

  // Cross-check the pool's attested Bitcoin tip against the real block at that
  // height: two independent sources, compared in the browser. Only the pages
  // that show the check pay for it.
  if (PAGE === 'bridge') await checkTip();

  state.refreshedAt = Date.now();
  renderAll();

  btn.disabled = false;
  btn.blur();
}

async function fetchPoolIndex() {
  const known = state.snapshot?.pool?.index?.total;
  if (known) return tacit.poolIndex({ from: Math.max(0, known - 30), limit: 30 });
  // No snapshot to anchor the tail: read the first page and label it honestly.
  const res = await tacit.poolIndex({ from: 0, limit: 30 });
  if (res.ok && res.data) res.data.partial = 'first page';
  return res;
}

/** Read the pool index without blocking first paint, then re-render just that panel. */
let poolIndexInFlight = null;
function kickPoolIndex() {
  if (poolIndexInFlight) return poolIndexInFlight;
  poolIndexInFlight = (async () => {
    renderPool();
    const res = await track('pool index', fetchPoolIndex());
    if (res.ok) {
      state.poolIndex = res.data;
    } else if (state.snapshot?.pool?.index?.entries?.length) {
      // Fall back to the committed copy, clearly labelled as such.
      state.poolIndex = { ...state.snapshot.pool.index, fromSnapshot: true, fallback: res.error };
      state.sources['pool index'] = true;
    }
    renderPool();
    renderPoolMeta();
    renderRibbon();
    renderPrivacy();
    renderStats();
    const counts = renderSourceCount();
    const node = $('#source-count');
    if (node) node.textContent = `${counts.ok}/${counts.total}`;
    poolIndexInFlight = null;
    return res;
  })();
  return poolIndexInFlight;
}

async function loadAssets() {
  // One parallel round-trip: registration reads and token supplies for the whole
  // canonical set, instead of ten sequential eth_calls.
  await Promise.all(ASSETS.flatMap((asset) => {
    const jobs = [readAsset(asset.id).then((res) => {
      state.sources[`asset ${asset.symbol}`] = res.ok;
      if (res.ok) state.assetChain[norm(asset.id)] = res;
      return res;
    })];
    if (asset.token) {
      jobs.push(readSupply(asset.token).then((res) => {
        if (res.ok) state.supplies[norm(asset.id)] = res.supply;
        return res;
      }));
    }
    return jobs;
  }));
  return ASSETS;
}

// ---------------------------------------------------------------- pills + ribbon

function renderStatsLoading() {
  const host = $('#stats');
  if (!host) return;
  host.replaceChildren(el('div', { class: 'skeleton-rows' }, [el('span'), el('span')]));
}

function statCell(label, value, sub, tone, toneSub) {
  return el('div', { class: `stat-cell${tone ? ` tone-${tone}` : ''}` }, [
    el('span', { class: 'stat-label' }, [label]),
    el('span', { class: 'stat-value' }, [value]),
    sub ? el('span', { class: `stat-sub${toneSub ? ` ${toneSub}` : ''}` }, [sub]) : null,
  ]);
}

const money = (value) => {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${fmtInt(Math.round(value))}`;
  return `$${value.toFixed(2)}`;
};

/**
 * The strip under the hero, doing the job Etherscan's price bar does: what the
 * token costs, how big the market is, how much has happened, and how far behind
 * the reflection is right now.
 */
function renderStats() {
  const host = $('#stats');
  if (!host) return;
  const s = state.status;
  const relay = state.relay;
  const price = state.price;
  const totals = state.snapshot?.bitcoin?.totals;
  const counts = state.poolIndex?.counts;
  const lag = s?.lagBlocks;
  const change = price?.change24h;
  const changeTone = typeof change === 'number' ? (change >= 0 ? 'up' : 'down') : null;
  const relayTone = !relay ? 'bad' : relay.state === 'ok' || relay.state === 'busy' ? 'ok' : relay.state === 'down' ? 'bad' : 'warn';
  const cap = price?.fdv ?? (price?.usd && state.supplies[norm(ASSETS[0].id)]
    ? price.usd * Number(state.supplies[norm(ASSETS[0].id)] / 10n ** 18n)
    : null);

  host.replaceChildren(
    statCell('TAC price', price ? fmtUsdPrice(price.usd) : 'n/a',
      price
        ? (fmtChange(change) ? `${fmtChange(change)} 24h` : `vs ${price.quote || 'ETH'} on ${price.dexId}`)
        : 'no public pair',
      null, changeTone),
    statCell('Market cap', cap ? money(cap) : 'n/a',
      price?.volume24h ? `${money(price.volume24h)} 24h volume` : 'at ERC20 supply'),
    statCell('Envelopes', totals?.envelopes ? fmtInt(totals.envelopes) : 'n/a',
      totals?.assets ? `${fmtInt(totals.assets)} assets indexed` : 'indexed by tacitscan'),
    statCell('Pool transactions', state.poolIndex?.total ? fmtInt(state.poolIndex.total) : 'n/a',
      counts ? `${fmtInt(counts.leaves)} leaves, ${fmtInt(counts.nullifiers)} nullifiers` : 'reading the index'),
    statCell('Reflected height', s ? fmtInt(s.attestedHeight) : 'n/a',
      s ? `${lag} block${lag === 1 ? '' : 's'} behind, ${s.confirmations} confirmations` : '',
      s ? (lag <= 2 ? 'ok' : lag <= 6 ? 'warn' : 'bad') : 'bad'),
    statCell('Bitcoin tip', state.bitcoinTip ? fmtInt(state.bitcoinTip) : 'n/a',
      state.recentBlocks[0] ? `latest block ${timeAgo(state.recentBlocks[0].timestamp)}` : '',
      state.bitcoinTip ? 'ok' : 'bad'),
    statCell('Relay', relay ? relay.state : 'n/a',
      relay ? (relay.proving ? 'proving now' : 'idle') : '', relayTone),
  );

  const setUtil = (id, text, tone) => {
    const node = $(id);
    if (!node) return;
    node.textContent = text;
    if (tone) node.className = tone;
  };
  setUtil('#util-tac', price ? fmtUsdPrice(price.usd) : 'n/a', changeTone === 'up' ? 'up' : changeTone === 'down' ? 'down' : '');
  setUtil('#util-btc', state.bitcoinTip ? fmtInt(state.bitcoinTip) : 'n/a');
  setUtil('#util-eth', state.ethBlock ? fmtCompact(state.ethBlock) : 'n/a');
  setUtil('#util-base', state.baseBlock ? fmtCompact(state.baseBlock) : 'n/a');
}

/** Full price card for the assets page: venue, depth, and where it comes from. */
function renderPrice() {
  const host = $('#price-body');
  const badge = $('#price-badge');
  if (!host) return;
  const price = state.price;
  if (!price) {
    if (badge) { badge.textContent = 'unavailable'; badge.className = 'card-tool bad'; }
    host.replaceChildren(unavailable('no public TAC pair answered', [
      external('https://dexscreener.com/search?q=TAC', 'dexscreener'),
    ]));
    return;
  }
  if (badge) {
    badge.textContent = `${price.dexId}${price.labels?.length ? ` ${price.labels.join(' ')}` : ''} · ${price.quote}`;
    badge.className = 'card-tool';
  }
  const changeTone = typeof price.change24h === 'number' ? (price.change24h >= 0 ? 'ok' : 'bad') : '';
  host.replaceChildren(
    el('div', { class: 'price-hero' }, [
      el('div', { class: 'price-now' }, [fmtUsdPrice(price.usd)]),
      fmtChange(price.change24h)
        ? el('div', { class: `price-change ${changeTone}` }, [fmtChange(price.change24h), el('span', {}, [' 24h'])])
        : el('div', { class: 'price-change' }, [el('span', {}, ['no 24h history in this pool'])]),
    ]),
    el('div', { class: 'grid-mini' }, [
      statBlock('market cap', price.fdv ? money(price.fdv) : 'n/a', 'at ERC20 supply'),
      statBlock('24h volume', price.volume24h !== null ? money(price.volume24h) : 'n/a', 'public pools'),
      statBlock('pool depth', price.liquidityUsd !== null ? money(price.liquidityUsd) : 'n/a', 'thin market, size carefully'),
    ]),
    el('p', {}, [
      'Read from the deepest public TAC pool on ',
      price.dexId || 'uniswap',
      price.quote ? ` against ${price.quote}` : '',
      ', through the ',
      external(price.url || 'https://dexscreener.com', 'DexScreener'),
      ' API. TAC is not listed on an oracle, so this is a pool price, not a feed: it moves with the pool, and the pool is small.',
    ]),
  );
}

/** The directory of sections, so the things that matter are not all on one page. */
function renderQuickLinks() {
  const host = $('#quick-links');
  if (!host) return;
  const s = state.status;
  const counts = state.poolIndex?.counts;
  const totals = state.snapshot?.bitcoin?.totals;
  const cards = [
    {
      href: './pool.html',
      title: 'Confidential pool',
      body: 'Leaves appended, nullifiers spent, deposits wrapped. The public half of the shielded set.',
      stat: counts ? `${fmtInt(counts.leaves)} leaves · ${fmtInt(counts.nullifiers)} nullifiers` : 'reading the index',
    },
    {
      href: './bridge.html',
      title: 'Bridge',
      body: 'The reflected Bitcoin tip, checked against the real block, plus burns and mints in flight.',
      stat: s ? `${fmtInt(s.bridgeBurns)} burns · ${fmtInt(s.bridgeMinted)} mints` : 'reflection status',
    },
    {
      href: './assets.html',
      title: 'Assets',
      body: 'TAC, tETH, cBTC, cUSD and wTAC, their live supplies, and the Bitcoin-native AMM.',
      stat: totals?.assets ? `${fmtInt(totals.assets)} assets indexed` : 'canonical set',
    },
    {
      href: './farms.html',
      title: 'Farms and relay',
      body: 'Who proves settles, what the relay is doing, and what the farm is streaming.',
      stat: state.relay ? `relay ${state.relay.state}` : 'relay state',
    },
    {
      href: './privacy.html',
      title: 'Privacy boundary',
      body: 'What an observer can see, what stays hidden, and what still leaks through metadata.',
      stat: 'visible vs hidden',
    },
  ];
  host.replaceChildren(...cards.map((card) => el('a', { class: 'quick-card', href: card.href }, [
    el('h3', {}, [card.title]),
    el('p', {}, [card.body]),
    el('span', { class: 'quick-stat' }, [card.stat]),
  ])));
}

/** Opcode legend for the envelopes page. */
function renderLegend() {
  const host = $('#legend-body');
  if (!host) return;
  const seen = new Set(state.feed.map((row) => row.name));
  const rows = Object.values(OPCODES)
    .filter((meta) => !['amm', 'farm', 'message'].includes(meta.family))
    .slice(0, 14)
    .map((meta) => el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-line' }, [
          el('span', { class: `op ${meta.family}` }, [meta.name.replace('_POOL', '')]),
          el('span', { class: 'row-meta' }, [meta.blurb]),
        ]),
      ]),
      el('div', { class: 'row-tail' }, [el('span', {}, [seen.has(meta.name) ? 'in the index' : ''])]),
    ]));
  host.replaceChildren(
    el('div', { class: 'rows' }, rows),
    el('p', { class: 'panel-note', style: 'margin:10px 14px 12px' }, [
      'Amounts appear only where the operation publishes them: burns, permissionless mints and fixed denominations. Transfers carry commitments.',
    ]),
  );
}

/** Pool provenance card. */
function renderPoolMeta() {
  const host = $('#pool-meta');
  if (!host) return;
  const index = state.poolIndex;
  if (!index) {
    host.replaceChildren(unavailable('the pool index has not answered yet'));
    return;
  }
  const behind = index.headBlock && index.indexedToBlock ? index.headBlock - index.indexedToBlock : null;
  host.replaceChildren(
    kvList([
      ['pool contract', external(`${CHAINS.ethereum.explorer}/address/${CHAINS.ethereum.pool}`, short(CHAINS.ethereum.pool, 8, 6))],
      ['deployed at block', fmtInt(index.deployBlock || CHAINS.ethereum.deployBlock)],
      ['events indexed', index.total ? fmtInt(index.total) : 'n/a'],
      ['indexed to block', fmtInt(index.indexedToBlock)],
      ['chain head when read', fmtInt(index.headBlock)],
      ['indexer lag', behind !== null ? `${fmtInt(behind)} blocks` : 'n/a', behind > 1000 ? 'warn' : ''],
      ['synced', index.synced ? 'yes' : 'no', index.synced ? 'ok' : 'warn'],
    ]),
    el('p', { class: 'panel-note', style: 'margin:6px 14px 12px' }, [
      'Tacit\u2019s indexer ingests continuously and can run behind the head, so this page reads the index live and says how far behind it is rather than pretending the list is current.',
    ]),
  );
}

function metric(label, value, hint) {
  return el('div', { class: 'metric' }, [
    el('span', {}, [label]),
    el('span', {}, [el('b', {}, [value]), hint ? el('em', {}, [' ' + hint]) : null]),
  ]);
}

function renderRibbon() {
  const bitcoinNode = document.querySelector('[data-node="bitcoin"] [data-metrics]');
  if (!bitcoinNode) return;
  const feed = state.feed;
  const counts = feed.reduce((acc, row) => { acc[row.family] = (acc[row.family] || 0) + 1; return acc; }, {});

  bitcoinNode.replaceChildren(
    metric('tip height', state.bitcoinTip ? fmtInt(state.bitcoinTip) : 'n/a'),
    metric('latest block', state.recentBlocks[0] ? fmtInt(state.recentBlocks[0].height) : 'n/a', state.recentBlocks[0] ? timeAgo(state.recentBlocks[0].timestamp) : ''),
    metric('envelopes indexed', feed.length ? fmtInt(feed.length) : 'n/a'),
    metric('transfers', counts.transfer ? fmtInt(counts.transfer) : '0'),
    metric('bridge ops', (counts.bridge || 0) ? fmtInt(counts.bridge) : '0'),
  );

  const reflNode = document.querySelector('[data-node="reflection"] [data-metrics]');
  if (state.status) {
    const s = state.status;
    reflNode.replaceChildren(
      metric('attested height', fmtInt(s.attestedHeight)),
      metric('lag', `${s.lagBlocks} blk`, `· ${s.confirmations} conf`),
      metric('bridge burns', fmtInt(s.bridgeBurns)),
      metric('mints back', fmtInt(s.bridgeMinted)),
      metric('live notes', fmtInt(s.liveNotes)),
    );
  } else {
    reflNode.replaceChildren(unavailable('reflection status did not answer'));
  }

  const ethNode = document.querySelector('[data-node="eth"] [data-metrics]');
  if (state.poolIndex?.counts) {
    const c = state.poolIndex.counts;
    ethNode.replaceChildren(
      metric('note leaves', fmtInt(c.leaves)),
      metric('nullifiers', fmtInt(c.nullifiers)),
      metric('deposits', fmtInt(c.wraps)),
      metric('cross-outs', fmtInt(c.crossOuts)),
      metric('stealth leaves', fmtInt(c.lockLeaves)),
    );
  } else if (state.status) {
    ethNode.replaceChildren(
      metric('live notes', fmtInt(state.status.liveNotes)),
      metric('cross-outs', fmtInt(state.status.foldedCrossoutCount)),
      metric('indexed to', fmtInt(state.poolIndex?.indexedToBlock || 0)),
    );
  } else {
    ethNode.replaceChildren(unavailable('pool index did not answer'));
  }

  const evmNode = document.querySelector('[data-node="evm"] [data-metrics]');
  evmNode.replaceChildren(
    metric('chain head', state.baseBlock ? fmtCompact(state.baseBlock) : 'n/a'),
    metric('pool', short(CHAINS.base.pool, 6, 4)),
    metric('note set', 'separate'),
    metric('circuit', 'Groth16 · on-device'),
  );
}

// ---------------------------------------------------------------- bitcoin feed

function normalizeSnapshotRows(rows) {
  const unread = [];
  const out = [];
  for (const row of rows) {
    const family = NAME_TO_FAMILY.get(row.opcode) || 'unknown';
    if (row.opcode === 'UNKNOWN' && !row.assetId) {
      unread.push(row.txid);
      continue;
    }
    let time = null;
    if (typeof row.blockTime === 'number') time = row.blockTime > 1e12 ? Math.floor(row.blockTime / 1000) : row.blockTime;
    else if (typeof row.blockTime === 'string') {
      const ms = Date.parse(row.blockTime);
      if (!Number.isNaN(ms)) time = Math.floor(ms / 1000);
    } else if (typeof row.firstSeenAt === 'string') {
      const ms = Date.parse(row.firstSeenAt);
      if (!Number.isNaN(ms)) time = Math.floor(ms / 1000);
    }
    out.push({
      txid: row.txid,
      name: row.opcode,
      family,
      assetId: row.assetId,
      ticker: row.ticker || row.displayName || null,
      height: row.blockHeight,
      time,
      status: row.chainStatus,
      detail: null,
      source: 'index',
    });
  }
  return { rows: out, unread };
}

function envelopeRowsToFeed(envelopes, height, time) {
  return envelopes.map(({ txid, env }) => ({
    txid,
    name: env.name,
    family: env.family || NAME_TO_FAMILY.get(env.name) || 'unknown',
    assetId: env.assetId,
    ticker: env.ticker || null,
    height,
    time,
    status: 'confirmed',
    detail: describeEnvelope(env),
    env,
    source: 'scan',
  }));
}

function describeEnvelope(env) {
  // The asset chip beside it already shows the ticker or symbol, so this line
  // only carries what the chip cannot: recipients, output counts, decode state.
  const bits = [];
  if (env.ethRecipient) bits.push(`to ${short(env.ethRecipient, 6, 4)}`);
  if (env.outputCount) bits.push(`${env.outputCount} out`);
  if (env.name === 'T_BRIDGE_NOTE') bits.push('encrypted memo');
  if (env.notDecoded) bits.push(`${env.payloadLength} byte payload`);
  if (env.undecoded) bits.push(`not decoded: ${env.reason}`);
  if (!bits.length && env.payloadLength && !env.assetId) bits.push(`${env.payloadLength} byte payload`);
  return bits.join(' · ');
}

function setFeed(rows, origin, meta = {}) {
  state.feed = rows;
  state.feedOrigin = origin;
  state.feedMeta = meta;
  const families = [...new Set(rows.map((r) => r.family))];
  if (state.filter !== 'all' && !families.includes(state.filter)) state.filter = 'all';
  buildFilters(families);
  renderFeed();
  renderRibbon();
  if (origin === 'index') scheduleFeedEnrichment(rows);
}

// The index says *what kind* of operation each tx is. The decoder says what is
// inside it. Enriching row by row (four at a time) turns the table from a list
// of hashes into an explanation without any server involved.
const decodedCache = new Map(); // txid -> decoded envelope (survives refreshes)
let enrichTimer = null;

function scheduleFeedEnrichment(rows) {
  const queue = rows.filter((r) => !r.detail).slice(0, 24);
  if (queue.length) {
    let cursor = 0;
    const bump = () => {
      clearTimeout(enrichTimer);
      enrichTimer = setTimeout(() => renderFeed(), 120);
    };
    const worker = async () => {
      while (cursor < queue.length) {
        const row = queue[cursor++];
        let env = decodedCache.get(row.txid);
        if (env === undefined) {
          const res = await esplora.tx(row.txid);
          if (!res.ok) { bump(); continue; }
          env = decodeTransaction(res.tx) || null;
          decodedCache.set(row.txid, env);
          const status = res.tx.status || {};
          if (!row.height && status.block_height) row.height = status.block_height;
          if (!row.time && status.block_time) row.time = status.block_time;
        }
        if (env && env.unknown === undefined) {
          row.decoded = env;
          row.detail = describeEnvelope(env);
          row.family = env.family || row.family;
          if (!row.ticker && env.ticker) row.ticker = env.ticker;
          if (!row.assetId && env.assetId) row.assetId = env.assetId;
        }
        bump();
      }
    };
    Promise.all([0, 1, 2].map(worker)).then(() => renderFeed());
  }
}

function buildFilters(families = []) {
  const host = $('#opcode-filters');
  if (!host) return;
  const present = families.length ? families : [...new Set(state.feed.map((r) => r.family))];
  const order = ['all', 'transfer', 'bridge', 'etch', 'mint', 'burn', 'amm', 'farm', 'trade', 'cbtc'];
  const list = ['all', ...order.filter((f) => present.includes(f)), ...present.filter((f) => !order.includes(f))];
  host.replaceChildren(...list.map((family) => el('button', {
    class: 'chip',
    type: 'button',
    'aria-pressed': String(state.filter === family),
    onclick: () => { state.filter = family; buildFilters(); renderFeed(); },
  }, [family === 'all' ? `all ${state.feed.length || ''}`.trim() : family])));
}

function renderFeed() {
  const host = $('#bitcoin-feed');
  const foot = $('#feed-foot');
  if (!host) return;
  const rows = state.feed.filter((r) => state.filter === 'all' || r.family === state.filter);
  if (!state.feed.length) {
    host.replaceChildren(unavailable(
      state.feedOrigin === 'unavailable'
        ? 'the envelope index snapshot is missing and tacitscan cannot be read cross-origin, so try the block decoder below'
        : 'loading the envelope index',
      [external('https://tacitscan.io', 'tacitscan.io')],
    ));
    if (foot) foot.textContent = 'no rows';
    return;
  }

  const limit = PAGE === 'home' ? 8 : 40;
  const shown = Math.min(limit, rows.length);
  const list = el('div', { class: 'rows' }, rows.slice(0, limit).map((row) => {
    const hash = short(row.txid, 12, 8);
    const value = publicValue(row);
    return el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-line' }, [
          el('span', { class: 'row-label' }, ['TX#']),
          el('span', { class: 'row-id' }, [txLinkPlain(row.txid, hash)]),
          el('span', { class: 'row-age' }, [row.time ? timeAgo(row.time) : 'n/a']),
        ]),
        el('div', { class: 'row-line row-meta' }, [
          el('span', { class: `op ${row.family}` }, [row.name.replace('_POOL', '')]),
          assetChip(row.assetId, row.ticker),
          row.detail ? el('span', {}, [row.detail]) : null,
          el('span', { class: 'sep' }, ['·']),
          el('span', {}, [row.height ? `block ${fmtInt(row.height)}` : el('span', { class: 'dim' }, ['mempool'])]),
        ]),
      ]),
      el('div', { class: 'row-tail' }, [
        el('strong', {}, [value ? value.text : (row.height ? fmtInt(row.height) : 'mempool')]),
        el('span', {}, [value ? value.label : 'block']),
      ]),
    ]);
  }));

  host.replaceChildren(list);

  const generatedAt = state.feedMeta?.generatedAt || state.snapshot?.generatedAt;
  const unread = state.feedMeta?.unread || 0;
  const newest = rows.reduce((best, r) => (!best || (r.height || 0) > (best.height || 0) ? r : best), null);
  const behind = newest?.height && state.bitcoinTip ? state.bitcoinTip - newest.height : null;

  if (foot) {
    if (state.feedOrigin === 'index') {
      foot.replaceChildren(
        'index ',
        external('https://tacitscan.io', 'tacitscan'),
        generatedAt ? `, built ${fmtUtc(generatedAt)}` : '',
        shown === rows.length ? ` · ${rows.length} envelopes` : ` · ${shown} of ${rows.length} envelopes`,
        unread ? ` · ${unread} unrecognised omitted` : '',
        behind !== null ? ` · newest is ${fmtInt(behind)} block${behind === 1 ? '' : 's'} behind the tip` : '',
      );
    } else {
      foot.textContent = `decoded in your browser from block ${fmtInt(state.scan?.height)} · ${rows.length} envelope${rows.length === 1 ? '' : 's'}`;
    }
  }
}

/** A transaction link without the underline, for dense rows. */
function txLinkPlain(txid, label) {
  return el('a', { href: `${BITCOIN.explorer}/tx/${txid}`, target: '_blank', rel: 'noopener' }, [label]);
}

/**
 * The amount an operation publishes, if it publishes one. Transfers do not:
 * that is the point of the pool, so the row shows nothing rather than guessing.
 */
function publicValue(row) {
  const env = row.decoded;
  if (!env) return null;
  if (env.burnedAmount !== undefined) {
    const text = fmtInSystem(env.burnedAmount, env.assetId);
    return text ? { text, label: 'burned' } : null;
  }
  if (env.name === 'T_PMINT' && env.amount !== undefined) {
    const text = fmtInSystem(env.amount, env.assetId);
    return text ? { text, label: 'minted' } : null;
  }
  if (env.denomination !== undefined && env.denomination > 0n) {
    const text = fmtInSystem(env.denomination, env.assetId);
    return text ? { text, label: 'denomination' } : null;
  }
  if (env.denomWei !== undefined) {
    return { text: fmtUnits(env.denomWei, 18, 8), label: 'public amount' };
  }
  return null;
}

// ---------------------------------------------------------------- bridge

function renderBridge() {
  const body = $('#bridge-body');
  const badge = $('#bridge-badge');
  if (!body) return;
  const status = state.status;
  const chain = state.poolChain;

  if (!status) {
    body.replaceChildren(unavailable('reflection status did not answer', [external(`${TACIT_API}/reflection/status`, 'the endpoint')]));
    badge.textContent = 'offline';
    badge.className = 'card-tool bad';
    return;
  }

  badge.textContent = `reflected ${fmtInt(status.attestedHeight)} · ${status.lagBlocks} blk behind`;
  badge.className = `card-tool ${status.lagBlocks <= 2 ? 'ok' : status.lagBlocks <= 6 ? 'warn' : 'bad'}`;

  const verify = state.tipCheck;
  const rows = [
    ['attested Bitcoin height', fmtInt(status.attestedHeight)],
    ['Bitcoin tip', state.bitcoinTip ? fmtInt(state.bitcoinTip) : 'n/a'],
    ['lag', `${status.lagBlocks} blocks`, status.lagBlocks <= 2 ? 'ok' : 'warn'],
    ['reflection confirmations', String(status.confirmations)],
    ['bridge burns recorded', fmtInt(status.bridgeBurns)],
    ['burns minted back', fmtInt(status.bridgeMinted)],
    ['burns awaiting bundle', fmtInt(status.burnsAwaitingBundle), status.burnsAwaitingBundle ? 'warn' : 'ok'],
    ['deposit records', fmtInt(status.burnDeposits)],
    ['folded cross-outs', fmtInt(status.foldedCrossoutCount)],
    ['consumed Bitcoin notes', fmtInt(status.consumedCount)],
  ];

  const verifiedRow = verify
    ? verify.ok
      ? el('dd', { class: 'ok' }, ['✓ matches mainnet'])
      : el('dd', { class: 'bad' }, ['✗ mismatch'])
    : el('dd', { class: 'small' }, ['not checked']);

  body.replaceChildren(
    kvList(rows),
    el('div', { class: 'subhead' }, ['proof anchor']),
    kvList([
      ['pool attested tip (little-endian)', el('span', { class: 'mono' }, [chain?.ok ? short('0x' + chain.attestedTipDisplay, 8, 8) : 'n/a'])],
      [el('span', {}, ['same hash at ', external(`${BITCOIN.explorer}/block-height/${status.attestedHeight}`, `height ${fmtInt(status.attestedHeight)}`)]), verifiedRow],
      ['attested digest', el('span', { class: 'mono small' }, [chain?.ok ? short(chain.digest, 8, 6) : 'n/a'])],
      ['on-chain consumed / crossOut', chain?.ok ? `${chain.consumed} / ${chain.crossOuts}` : 'n/a'],
    ]),
    el('p', { class: 'privacy-caveat' }, [
      'The pool stores Bitcoin block hashes in internal byte order, so this page reverses them to compare with ',
      external(`${BITCOIN.explorer}/block-height/${status.attestedHeight}`, 'the block at that height'),
      '. That check runs in your browser every refresh: it is the whole claim of the bridge, read two independent ways.',
    ]),
    renderInflight(),
  );
}

/** Bridge work that is mid-flight: burns recorded on Bitcoin, waiting to be minted. */
function renderInflight() {
  const refl = state.snapshot?.reflection;
  const pending = refl?.pendingDepositRecords || [];
  const wrap = el('div', { class: 'card-sub' });
  wrap.appendChild(el('div', { class: 'subhead' }, ['Bitcoin burn deposits']));
  if (!state.snapshot) {
    wrap.appendChild(el('p', { class: 'dim', style: 'font-size:12.5px' }, ['the reflected-state snapshot is not loaded']));
    return wrap;
  }
  if (!pending.length) {
    wrap.appendChild(el('p', { class: 'dim', style: 'font-size:12.5px' }, ['nothing waiting in the reflected burn set']));
    return wrap;
  }
  wrap.appendChild(el('div', { class: 'table-wrap' }, [el('table', { class: 'grid' }, [
    el('thead', {}, [el('tr', {}, [
      el('th', {}, ['burn tx']), el('th', { class: 'num' }, ['height']), el('th', { class: 'num' }, ['vout']),
    ])]),
    el('tbody', {}, pending.slice(-5).reverse().map((rec) => el('tr', {}, [
      el('td', {}, [rec.burnTxidDisplay ? external(`${BITCOIN.explorer}/tx/${rec.burnTxidDisplay}`, short(rec.burnTxidDisplay, 8, 5)) : 'n/a']),
      el('td', { class: 'num mono' }, [rec.height ? fmtInt(rec.height) : 'n/a']),
      el('td', { class: 'num mono' }, [rec.burnedVout !== undefined ? String(rec.burnedVout) : 'n/a']),
    ]))),
  ])]));
  wrap.appendChild(el('p', { class: 'panel-note', style: 'margin:8px 0 0' }, [
    `${fmtInt(refl?.pendingDeposits ?? pending.length)} burn deposits recorded in reflected state · `,
    `${fmtInt(state.status?.burnsAwaitingBundle || 0)} still waiting on a fresh reflection bundle`,
  ]));
  return wrap;
}

async function checkTip() {
  const status = state.status;
  if (!status || !state.poolChain?.ok) return;
  const want = state.poolChain.attestedTipDisplay;
  const res = await esplora.blockHashAt(status.attestedHeight);
  state.sources['tip check'] = res.ok;
  state.tipCheck = res.ok ? { ok: norm(res.hash) === norm(want), hash: res.hash } : { ok: false };
}

// ---------------------------------------------------------------- pool

const EVENT_LABEL = {
  leaves: 'leaf appended',
  nullifiers: 'nullifier spent',
  wraps: 'deposit wrapped',
  wrap: 'deposit wrapped',
  crossOuts: 'cross-out',
  lockLeaves: 'stealth lock',
  lockNullifiers: 'lock claimed',
};

const eventTone = (type) => (type === 'crossOuts' ? 'bridge' : /wrap|lock/.test(type) ? 'mint' : 'transfer');

function eventDetail(entry) {
  if (entry.type === 'wrap') {
    const amount = entry.amount !== undefined ? fmtUnits(entry.amount, 18, 6) : null;
    return [amount ? `${amount} ` : '', assetLabel(entry.assetId)].join('').trim() || 'n/a';
  }
  if (entry.type === 'leaves') return `${entry.leaves?.length || 1} leaf${(entry.leaves?.length || 1) > 1 ? 's' : ''}`;
  if (entry.type === 'nullifiers') return `${entry.nullifiers?.length || 1} nullifier${(entry.nullifiers?.length || 1) > 1 ? 's' : ''}`;
  if (entry.nullifiers) return `${entry.nullifiers.length} item(s)`;
  if (entry.crossOuts) return `${entry.crossOuts.length} cross-out(s)`;
  if (entry.leaves) return `${entry.leaves.length} item(s)`;
  return 'n/a';
}

function renderPool() {
  const body = $('#pool-body');
  const badge = $('#pool-badge');
  const foot = $('#pool-foot');
  if (!body) return;
  const index = state.poolIndex;
  if (!index?.counts) {
    if (poolIndexInFlight) {
      badge.textContent = 'reading index';
      badge.className = 'card-tool';
      body.replaceChildren(el('div', { class: 'skeleton-rows' }, [el('span'), el('span'), el('span'), el('span'), el('span')]));
      return;
    }
    body.replaceChildren(unavailable('the pool index did not answer', [external(`${TACIT_API}/confidential/index?limit=5`, 'endpoint')]));
    badge.textContent = 'offline';
    badge.className = 'card-tool bad';
    if (foot) foot.textContent = 'no rows';
    return;
  }
  const counts = index.counts;
  const behind = index.headBlock && index.indexedToBlock ? index.headBlock - index.indexedToBlock : 0;
  badge.textContent = `indexed to ${fmtInt(index.indexedToBlock)}`;
  badge.className = `card-tool ${behind === 0 ? 'ok' : 'warn'}`;

  // The indexer ingests out of block order while it catches up, so sort by block
  // (then log index) to read like a feed instead of like an ingest log.
  const entries = (index.entries || []).slice()
    .sort((a, b) => (b.block - a.block) || ((b.logIndex || 0) - (a.logIndex || 0)));
  const rows = entries.map((entry) => {
    const type = entry.type;
    const detail = eventDetail(entry);
    return el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-line' }, [
          el('span', { class: 'row-label' }, ['TX#']),
          el('span', { class: 'row-id' }, [entry.tx ? external(`${CHAINS.ethereum.explorer}/tx/${entry.tx}`, short(entry.tx, 12, 8), 'row-id-link') : 'n/a']),
          el('span', { class: 'row-age' }, [`block ${fmtInt(entry.block)}`]),
        ]),
        el('div', { class: 'row-line row-meta' }, [
          el('span', { class: `op ${eventTone(type)}` }, [EVENT_LABEL[type] || type]),
          el('span', {}, [detail]),
        ]),
      ]),
    ]);
  });

  body.replaceChildren(
    el('div', { class: 'grid-mini' }, [
      statBlock('note leaves', fmtInt(counts.leaves)),
      statBlock('nullifiers', fmtInt(counts.nullifiers)),
      statBlock('deposits', fmtInt(counts.wraps)),
      statBlock('cross-outs', fmtInt(counts.crossOuts)),
    ]),
    entries.length ? el('div', { class: 'rows' }, rows) : unavailable('no events in this window'),
  );

  if (foot) {
    foot.replaceChildren(
      index.fromSnapshot
        ? `snapshot copy${index.fallback ? ` (live index failed: ${index.fallback})` : ' (live index unavailable)'}`
        : 'live index',
      index.total ? ` · ${fmtInt(index.total)} events since block ${fmtInt(index.deployBlock)}` : '',
      behind > 0 ? ` · ${fmtInt(behind)} blocks behind head, so this list runs late` : '',
    );
  }
}

// ---------------------------------------------------------------- assets

function ammSummary() {
  return state.snapshot?.reflection?.amm || null;
}

function renderAssets() {
  const body = $('#assets-body');
  if (!body) return;
  const rows = ASSETS.map((asset) => {
    const chain = state.assetChain[norm(asset.id)];
    const supply = state.supplies[norm(asset.id)];
    const tokenCell = asset.token
      ? external(`${CHAINS.ethereum.explorer}/token/${asset.token}`, short(asset.token, 6, 4))
      : el('span', { class: 'dim' }, ['native']);
    const supplyCell = supply !== undefined
      ? fmtUnits(supply, asset.decimals, 4)
      : el('span', { class: 'dim' }, [asset.token ? 'n/a' : 'note only']);
    return el('tr', { title: asset.origin }, [
      el('td', {}, [assetChip(asset.id)]),
      el('td', {}, [el('span', { class: 'dim mono' }, [short(asset.id, 6, 4)])]),
      el('td', {}, [tokenCell]),
      el('td', { class: 'num mono' }, [supplyCell]),
    ]);
  });

  const amm = ammSummary();
  const ammBlock = amm
    ? el('div', { class: 'card-sub' }, [
      el('div', { class: 'subhead' }, ['Bitcoin-native AMM']),
      kvList([
        ['pool', el('span', { class: 'mono small' }, [short('0x' + norm(amm.poolId), 8, 6)])],
        ['reserve tETH', `${fmtInSystem(amm.reserveA, ASSETS[1].id) || fmtWei(amm.reserveA)}`],
        ['reserve TAC', fmtInSystem(amm.reserveB, ASSETS[0].id) || 'n/a'],
        ['LP shares', amm.totalShares ? fmtInt(amm.totalShares) : 'n/a'],
        ['fee', amm.feeBps !== undefined ? `${amm.feeBps} bps` : 'n/a'],
        ['curve check', amm.c0Backed ? 'x·y ≥ k verified' : 'n/a', amm.c0Backed ? 'ok' : ''],
      ]),
      el('p', { class: 'panel-note', style: 'margin:8px 0 0' }, ['Found directly on Bitcoin with T_LP_ADD (POOL_INIT). No Ethereum contract holds these reserves.']),
    ])
    : el('div', { class: 'card-sub' }, [
      el('div', { class: 'subhead' }, ['Bitcoin-native AMM']),
      el('p', { class: 'dim', style: 'font-size:12.5px' }, [
        'Reserves come from the reflected state snapshot. ',
        el('button', {
          class: 'btn small', type: 'button', onclick: async (e) => {
            e.target.disabled = true;
            e.target.textContent = 'reading 3.5 MB…';
            const res = await tacit.reflectionDump();
            state.sources['reflection dump'] = res.ok;
            if (res.ok) {
              const pool = res.data?.snapshot?.pools?.[0];
              if (pool) {
                state.snapshot = state.snapshot || {};
                state.snapshot.reflection = { ...(state.snapshot.reflection || {}), amm: pool };
              }
            }
            e.target.disabled = false;
            e.target.textContent = 'Read reflected state';
            renderAssets();
          },
        }, ['Read reflected state']),
      ]),
    ]);

  const zeroSupply = ASSETS.filter((a) => a.token && state.supplies[norm(a.id)] !== undefined && state.supplies[norm(a.id)] === 0n).map((a) => a.symbol);
  const supplyNote = zeroSupply.length
    ? `${zeroSupply.join(' and ')} read 0 on the public ERC20, so what exists of ${zeroSupply.length > 1 ? 'them' : 'it'} lives only as confidential notes.`
    : 'Every canonical token with an ERC20 has been minted publicly at least once.';

  body.replaceChildren(
    el('div', { class: 'table-wrap' }, [el('table', { class: 'grid' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', {}, ['asset']), el('th', {}, ['id']), el('th', {}, ['erc20']),
        el('th', { class: 'num' }, ['supply']),
      ])]),
      el('tbody', {}, rows),
    ])]),
    el('p', { class: 'panel-note', style: 'margin:10px 0 0' }, [
      'Supplies are live totalSupply() reads. ',
      supplyNote,
      ' Hover a row for where the asset comes from.',
    ]),
    ammBlock,
  );
}

// ---------------------------------------------------------------- privacy

function renderPrivacy() {
  const body = $('#privacy-body');
  if (!body) return;
  const c = state.poolIndex?.counts || {};
  const s = state.status || {};
  body.replaceChildren(
    el('div', { class: 'privacy-cols' }, [
      el('div', { class: 'priv-col public' }, [
        el('h3', {}, ['visible']),
        el('ul', {}, [
          el('li', {}, ['When: block times of every envelope and settle']),
          el('li', {}, ['Counts: ', el('b', {}, [c.leaves !== undefined ? fmtInt(c.leaves) : 'n/a']), ' leaves, ', el('b', {}, [c.nullifiers !== undefined ? fmtInt(c.nullifiers) : 'n/a']), ' nullifiers']),
          el('li', {}, ['Opcode: which kind of operation it is']),
          el('li', {}, ['Fees, public amounts where the op publishes them (burn, mint, denomination)']),
          el('li', {}, ['Note-tree size and root history']),
          el('li', {}, ['Bridge counters: ', el('b', {}, [fmtInt(s.bridgeBurns || 0)]), ' burns, ', el('b', {}, [fmtInt(s.bridgeMinted || 0)]), ' mints']),
        ]),
      ]),
      el('div', { class: 'priv-col hidden' }, [
        el('h3', {}, ['hidden']),
        el('ul', {}, [
          el('li', {}, ['Amounts inside a transfer (Pedersen commitments)']),
          el('li', {}, ['Who owns a note: an owner hash, not an address']),
          el('li', {}, ['Which inputs and outputs belong to one another']),
          el('li', {}, ['The link between a Bitcoin envelope and an Ethereum note']),
          el('li', {}, ['Anything a wallet holds: the pool publishes no balances']),
          el('li', {}, ['Bridge memo contents (AES-GCM ciphertext to the recipient)']),
        ]),
      ]),
    ]),
    el('p', { class: 'privacy-caveat' }, [
      'What leaks is metadata: timing, counts, fees, and the public side of every wrap and exit. A confident analyst can still cluster activity by cadence and by the public addresses that fund deposits. This page shows exactly what it can see, nothing more, and never pretends a shielded amount is private against a chain that also sees its neighbours.',
    ]),
  );
}

// ---------------------------------------------------------------- relay + farms

function renderRelay() {
  const body = $('#relay-body');
  if (!body) return;
  const badge = $('#relay-badge');
  const relay = state.relay;
  const board = state.board;
  const econ = state.economics;
  const farm = state.farm;

  badge.textContent = relay ? `${relay.state}${relay.proving ? ' · proving' : ''}` : 'offline';
  badge.className = `card-tool ${relay ? (relay.state === 'ok' || relay.state === 'busy' ? 'ok' : relay.state === 'down' ? 'bad' : 'warn') : 'bad'}`;

  const blocks = [];

  blocks.push(el('div', { class: 'subhead' }, ['relay']));
  blocks.push(relay
    ? kvList([
      ['state', `${relay.state}${relay.settling ? ' · settling' : ''}`],
      ['proving', relay.proving ? 'yes' : 'no'],
      ['open board', relay.board ? 'yes' : 'no'],
      ['failed (1h)', String(relay.failing ?? 0), relay.failing ? 'warn' : ''],
      ['heartbeat age', relay.ageSeconds !== undefined ? `${relay.ageSeconds}s` : 'n/a'],
    ])
    : unavailable('relay heartbeat did not answer'));

  if (board) {
    blocks.push(el('div', { class: 'subhead' }, ['provers']));
    blocks.push(kvList([
      ['queued / claimed', `${board.queued} / ${board.claimed}`],
      ['proved (window)', String(board.proved)],
      ['workers', String((board.workers || []).length)],
      ['best worker', (board.workers?.[0]?.name) || 'n/a', 'small'],
    ]));
  }

  // Relayed operations waiting for any sender: proofs already made, fees unpaid.
  const jobs = state.openJobs?.jobs || [];
  blocks.push(el('div', { class: 'subhead' }, ['open board']));
  if (jobs.length) {
    blocks.push(kvList(jobs.slice(0, 5).map((job) => [
      job.type || 'job',
      `${job.feeUsd ? `$${Number(job.feeUsd).toFixed(3)} · ` : ''}${timeAgo(job.openSince)} · ${short(job.jobId, 6, 4)}`,
      'small',
    ])));
    blocks.push(el('p', { class: 'panel-note', style: 'margin:6px 0 0' }, [
      'A job the relay proved but has not sent: any account can settle it and take its fee. ',
      external(`${TACIT_API}/confidential/open?limit=5`, 'endpoint'),
    ]));
  } else {
    blocks.push(el('p', { class: 'dim', style: 'font-size:12.5px;margin:0' }, [
      state.sources['open board'] === false ? 'open board did not answer' : 'empty, nothing waiting for a sender',
    ]));
  }

  if (econ?.ledger?.week) {
    const w = econ.ledger.week;
    blocks.push(el('div', { class: 'subhead' }, ['last 7 days']));
    blocks.push(kvList([
      ['settled', fmtInt(w.settled)],
      ['prove-only', fmtInt(w.proveOnly)],
      ['gas spent', `${w.gasEth?.toFixed(5)} ETH`],
      ['tips', econ.chain?.tips ? `${econ.chain.tips.eth.toFixed(4)} ETH / 30d` : 'n/a'],
      ['buyback', econ.chain?.buyback ? `${econ.chain.buyback.tacBought.toFixed(4)} TAC` : 'n/a'],
    ]));
  }

  if (farm?.epoch) {
    const e = farm.epoch;
    blocks.push(el('div', { class: 'subhead' }, ['TAC farms']));
    blocks.push(kvList([
      ['rate', `${e.ratePerDayTac} TAC / day`],
      ['epoch ends', fmtUtc(e.periodFinish * 1000), 'small'],
      ['treasury', `${fmtInt(Math.round(Number(e.treasuryTac)))} TAC`],
      ...(farm.pools || []).slice(0, 3).map((p) => [p.pair, `${p.tacPerDayForPool} TAC/day · ${p.sharePct}%`, 'small']),
    ]));
  }

  body.replaceChildren(...blocks);
}

// ---------------------------------------------------------------- lookup

function classifyQuery(raw) {
  const q = String(raw || '').trim();
  if (!q) return { kind: 'empty' };
  if (/^tacit1/i.test(q)) return { kind: 'tacit1', value: q.toLowerCase() };
  if (q.includes('@')) return { kind: 'xns', value: q.toLowerCase() };
  const bare = q.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(bare)) {
    // A 32-byte hex string: 0x-prefixed reads as an EVM tx hash, bare as a Bitcoin txid.
    return { kind: /^0x/i.test(q) ? 'evmtx' : 'btctx', value: /^0x/i.test(q) ? q.toLowerCase() : q.toLowerCase() };
  }
  if (/^[0-9a-fA-F]{40}$/.test(bare) && /^0x/i.test(q)) return { kind: 'evmaddr', value: q.toLowerCase() };
  return { kind: 'unknown', value: q };
}

function card(title, children, badgeText) {
  return el('div', { class: 'card' }, [
    el('h3', {}, [title, badgeText ? el('span', { class: 'badge' }, [badgeText]) : null]),
    ...children,
  ]);
}

async function runLookup(raw) {
  const host = $('#search-results');
  const q = String(raw || '').trim();
  if (!q) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  const kind = classifyQuery(q);
  host.hidden = false;
  host.replaceChildren(card('Looking up', [
    el('p', { class: 'mono' }, [short(q, 34, 10)]),
    el('div', { class: 'skeleton-rows' }, [el('span'), el('span')]),
  ]));
  if (typeof host.scrollIntoView === 'function') host.scrollIntoView({ behavior: 'smooth', block: 'start' });

  let node;
  try {
    if (kind.kind === 'btctx') node = await bitcoinTxCard(kind.value);
    else if (kind.kind === 'evmtx') node = await evmTxCard(kind.value);
    else if (kind.kind === 'evmaddr') node = await evmAddressCard(kind.value);
    else if (kind.kind === 'tacit1') node = tacitAddressCard(kind.value);
    else if (kind.kind === 'xns') node = await xnsCard(kind.value);
    else {
      node = card('Not a shape this page knows', [el('p', {}, [
        'Expected a 64-hex Bitcoin txid, a 0x-prefixed 32-byte transaction hash, a 40-hex address, a tacit1 address, or name@namespace.',
      ])]);
    }
  } catch (err) {
    node = card('Lookup failed', [el('p', { class: 'warn' }, [err.message || String(err)])]);
  }

  host.replaceChildren(node, el('p', { class: 'panel-note' }, [
    el('button', {
      class: 'btn small ghost', type: 'button',
      onclick: () => {
        host.hidden = true;
        host.replaceChildren();
        const input = $('#search-input');
        if (input) { input.value = ''; input.focus(); }
        history.replaceState(null, '', './search.html');
      },
    }, ['clear results']),
  ]));
}

async function bitcoinTxCard(txid) {
  const res = await esplora.tx(txid);
  if (!res.ok) {
    return card('Bitcoin transaction', [
      el('p', { class: 'warn' }, [`Could not read ${short(txid, 10, 6)} from the explorer: ${res.error}`]),
    ]);
  }
  const tx = res.tx;
  const decoded = decodeTransaction(tx);
  const confirmed = tx.status?.confirmed;
  const time = tx.status?.block_time;
  const stats = el('div', { class: 'grid-mini' }, [
    statBlock('block', confirmed ? fmtInt(tx.status.block_height) : 'mempool'),
    statBlock('when', time ? timeAgo(time) : 'unconfirmed'),
    statBlock('vsize', fmtInt(tx.weight ? Math.ceil(tx.weight / 4) : tx.size)),
    statBlock('fee', tx.fee !== undefined ? `${fmtInt(tx.fee)} sats` : 'n/a'),
  ]);

  const children = [stats];
  if (decoded && !decoded.unknown) {
    children.push(el('p', {}, ['Tacit envelope: ', el('span', { class: `op ${decoded.family}` }, [decoded.name])]));
    children.push(kvList([
      ['family', decoded.family || 'n/a'],
      decoded.ticker ? ['ticker', decoded.ticker] : null,
      decoded.assetId ? ['asset id', el('span', { class: 'mono small' }, [short(decoded.assetId, 10, 8)])] : null,
      decoded.outputCount ? ['outputs', String(decoded.outputCount)] : null,
      decoded.burnedAmount !== undefined ? ['burned', fmtInSystem(decoded.burnedAmount, decoded.assetId) || String(decoded.burnedAmount)] : null,
      decoded.amount !== undefined ? ['amount', fmtInSystem(decoded.amount, decoded.assetId) || String(decoded.amount)] : null,
      decoded.denomWei !== undefined ? ['denomination', `${fmtUnits(decoded.denomWei, 18, 8)} (public)`] : null,
      decoded.ethRecipient ? ['eth recipient', el('span', { class: 'mono small' }, [decoded.ethRecipient])] : null,
      decoded.notDecoded ? ['fields', 'recognised opcode, fields not decoded here', 'small'] : null,
      decoded.undecoded ? ['fields', `could not decode (${decoded.reason})`, 'warn'] : null,
    ]));
  } else {
    children.push(el('p', {}, ['No Tacit envelope in this transaction, so it is an ordinary Bitcoin transaction.']));
  }
  children.push(el('p', { class: 'dim' }, [
    external(`${BITCOIN.explorer}/tx/${txid}`, 'mempool.space'),
    ' · ',
    external(`https://tacitscan.io/tx/${txid}`, 'tacitscan'),
  ]));
  return card('Bitcoin transaction', children, confirmed ? 'confirmed' : 'mempool');
}

async function evmTxCard(hash) {
  const found = await evmTransaction(hash);
  const keys = Object.keys(found);
  if (!keys.length) {
    return card('EVM transaction', [el('p', { class: 'warn' }, ['Not found on Ethereum or Base mainnet.']),
      el('p', { class: 'dim' }, ['If this is a pool asset id, see the Assets panel; if it is a nullifier, it is spend data, not a transaction.'])]);
  }
  const chainKey = keys[0];
  const { tx, receipt } = found[chainKey];
  const chain = CHAINS[chainKey];
  const ok = receipt?.status === '0x1';

  // XNS: show the people and contracts behind the addresses where a name exists.
  const names = await xnsNames([tx.from, tx.to].filter(Boolean)).catch(() => ({}));
  const withName = (address) => {
    if (!address) return 'contract creation';
    const name = names[String(address).toLowerCase()];
    const known = CONTRACT_BY_ADDR.get(String(address).toLowerCase());
    return el('span', {}, [
      el('span', { class: 'mono small' }, [short(address, 8, 6)]),
      name ? el('span', { class: 'dim' }, [` ${name}`]) : known ? el('span', { class: 'dim' }, [` ${known.name}`]) : null,
    ]);
  };

  return card(`EVM transaction · ${chain.label}`, [
    el('div', { class: 'grid-mini' }, [
      statBlock('block', fmtInt(BigInt(tx.blockNumber || '0x0'))),
      statBlock('status', receipt ? (ok ? 'success' : 'reverted') : 'unknown'),
      statBlock('gas used', receipt ? fmtInt(BigInt(receipt.gasUsed || '0x0')) : 'n/a'),
      statBlock('value', fmtWei(BigInt(tx.value || '0x0'), 'ETH')),
    ]),
    kvList([
      ['from', withName(tx.from)],
      ['to', withName(tx.to)],
      ['selector', el('span', { class: 'mono small' }, [tx.input?.slice(0, 10) || 'n/a'])],
      ['contract', tx.to && CONTRACT_BY_ADDR.has(tx.to.toLowerCase()) ? CONTRACT_BY_ADDR.get(tx.to.toLowerCase()).name : 'n/a', 'small'],
    ]),
    el('p', { class: 'dim' }, [external(`${chain.explorer}/tx/${hash}`, `open on ${new URL(chain.explorer).hostname}`)]),
  ]);
}

async function evmAddressCard(address) {
  const [name, balance, code, contract] = await Promise.all([
    xnsName(address),
    readBalance(address),
    hasCode(address),
    Promise.resolve(CONTRACT_BY_ADDR.get(address.toLowerCase())),
  ]);
  const accountKind = code.ok
    ? code.delegated ? 'EOA · delegated (7702)' : code.hasCode ? 'contract' : 'EOA'
    : 'n/a';
  const children = [];
  const stats = el('div', { class: 'grid-mini' }, [
    statBlock('xns name', name || 'n/a'),
    statBlock('eth balance', balance.ok ? fmtWei(balance.wei, 'ETH') : 'n/a'),
    statBlock('account', accountKind),
  ]);
  children.push(stats);
  if (contract) {
    children.push(kvList([['known as', contract.name], ['role', contract.note, 'small']]));
  }
  children.push(el('p', {}, [
    'This page cannot see what an address holds in the pool: notes are owned by a hash of a seed-derived key, and the pool publishes no balances. ',
    'That is the design, not a limitation of the explorer.',
  ]));
  children.push(el('p', { class: 'dim' }, [
    external(`${CHAINS.ethereum.explorer}/address/${address}`, 'etherscan'),
    ' · ',
    external(`https://xns.name/resolve?name=${encodeURIComponent(name || '')}`, 'xns.name'),
  ]));
  return card('EVM address · Ethereum', children, name || 'no xns name');
}

function tacitAddressCard(address) {
  const decoded = decodeTacitAddress(address);
  if (!decoded.ok) {
    return card('Tacit address', [el('p', { class: 'warn' }, [`Could not decode: ${decoded.error}`])]);
  }
  const lanewise = [];
  if (decoded.lanes.bitcoin) {
    lanewise.push(['Bitcoin spend key', el('span', { class: 'mono small' }, [short(decoded.lanes.bitcoin.spendKey, 12, 10)])]);
    lanewise.push(['Bitcoin scan key', el('span', { class: 'mono small' }, [short(decoded.lanes.bitcoin.scanKey, 12, 10)])]);
  }
  if (decoded.lanes.ethereum) {
    lanewise.push(['Ethereum-side key', el('span', { class: 'mono small' }, [short(decoded.lanes.ethereum.key, 12, 10)])]);
  }
  if (decoded.lanes.pool) {
    lanewise.push(['Pool view key', el('span', { class: 'mono small' }, [short(decoded.lanes.pool.viewKey, 12, 10)])]);
    lanewise.push(['Pool A / N', el('span', { class: 'mono small' }, [`${short(decoded.lanes.pool.a, 6, 4)} / ${short(decoded.lanes.pool.n, 6, 4)}`])]);
  }
  return card('Tacit address', [
    el('div', { class: 'grid-mini' }, [
      statBlock('flags', `0x${decoded.flags.toString(16).padStart(2, '0')}`),
      statBlock('lanes', String(Object.keys(decoded.lanes).length)),
      statBlock('encoded bytes', String(decoded.bytes.length)),
    ]),
    kvList(lanewise),
    el('p', { class: 'warn' }, [decoded.note]),
    decoded.reserved ? el('p', { class: 'dim' }, [`Reserved flag bits set: 0x${decoded.reserved.toString(16)}`]) : null,
  ], 'bech32m');
}

async function xnsCard(name) {
  const resolved = await xnsResolve(name);
  if (!resolved.ok) {
    return card(`XNS · ${name}`, [
      el('p', { class: 'warn' }, [resolved.error || 'not registered']),
      el('p', {}, ['XNS names are permanent, one-time-fee names on Ethereum mainnet. ',
        external(XNS.site, 'Look one up on xns.name'),
        '. A name is not a wallet, just a mapping to an address.']),
    ], 'unregistered');
  }
  const inner = await evmAddressCard(resolved.address);
  return card(`XNS · ${name}`, [
    kvList([['resolves to', el('span', { class: 'mono small' }, [resolved.address])]]),
    inner,
  ], 'registered');
}

// ---------------------------------------------------------------- block scan

async function runBlockScan(height) {
  const btn = $('#scan-block');
  const out = $('#scan-output');
  if (!out) return;
  const target = height || state.bitcoinTip;
  if (!target) return;
  state.scanningHeight = target;
  renderBlocks();
  btn.disabled = true;
  btn.textContent = `fetching block ${fmtInt(target)}…`;
  out.hidden = false;
  out.replaceChildren(el('p', { class: 'dim' }, ['Downloading one full block with witness data over JSON-RPC (about 10 MB).']));
  const started = performance.now();

  const res = await scanBlock(target);
  const elapsed = ((performance.now() - started) / 1000).toFixed(1);
  state.scanningHeight = null;
  renderBlocks();

  if (!res.ok) {
    out.replaceChildren(el('p', { class: 'warn' }, [
      `Could not decode block ${fmtInt(target)}: ${res.error}. The public Bitcoin RPC may be rate-limiting this browser, so try again, or read the envelope index above.`,
    ]));
    btn.disabled = false;
    btn.textContent = 'Scan latest block';
    return;
  }

  state.sources['block scan'] = true;
  state.scan = { ...res, elapsed };
  const byOp = res.envelopes.reduce((acc, e) => {
    const name = e.env.name || 'unknown';
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});

  out.replaceChildren(
    el('div', { class: 'grid-mini' }, [
      statBlock('block', fmtInt(res.height)),
      statBlock('transactions', fmtInt(res.txCount)),
      statBlock('envelopes found', fmtInt(res.envelopes.length)),
      statBlock('decode time', `${elapsed}s`),
    ]),
    el('p', { class: 'dim', style: 'margin:0 0 10px' }, [
      res.envelopes.length
        ? `Opcodes: ${Object.entries(byOp).map(([k, v]) => `${k} x${v}`).join(', ')}.`
        : 'This block carried no Tacit envelopes. Most blocks do not, so a quiet block is the normal case.',
    ]),
    external(`${BITCOIN.explorer}/block/${res.hash}`, 'open the block on mempool.space', 'txlink'),
  );

  if (res.envelopes.length) {
    setFeed(envelopeRowsToFeed(res.envelopes, res.height, res.time), 'scan');
    state.filter = 'all';
    buildFilters();
    renderFeed();
  } else {
    // Keep the index table intact, but say plainly that this block was empty.
    state.lastEmptyBlock = res.height;
  }
  btn.disabled = false;
  btn.textContent = 'Scan latest block';
}

// ---------------------------------------------------------------- wiring

/** Search is a page of its own, the way an explorer works: shareable URLs. */
function goToSearch(query) {
  const value = String(query || '').trim();
  if (!value) return;
  location.href = `./search.html?q=${encodeURIComponent(value)}`;
}

function attachHandlers() {
  const refresh = $('#refresh');
  if (refresh) refresh.addEventListener('click', () => refreshAll());

  const scan = $('#scan-block');
  if (scan) scan.addEventListener('click', () => runBlockScan(state.bitcoinTip));

  const form = $('#search-form');
  if (form) {
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const value = $('#search-input').value;
      if (PAGE === 'search') {
        history.replaceState(null, '', `./search.html?q=${encodeURIComponent(value)}`);
        runLookup(value);
      } else {
        goToSearch(value);
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-example]')) {
    btn.addEventListener('click', () => goToSearch(btn.getAttribute('data-example')));
  }
}

// ---------------------------------------------------------------- blocks

function renderBlocks() {
  const host = $('#blocks-body');
  const badge = $('#blocks-badge');
  if (!host) return;
  const blocks = state.recentBlocks || [];
  if (!blocks.length) {
    badge.textContent = 'offline';
    badge.className = 'card-tool bad';
    host.replaceChildren(unavailable('blockstream did not answer', [
      external(`${BITCOIN.esplora[0]}/blocks`, 'endpoint'),
    ]));
    return;
  }
  badge.textContent = `tip ${fmtInt(blocks[0].height)}`;
  badge.className = 'card-tool ok';

  const rows = blocks.map((block) => {
    const busy = state.scanningHeight === block.height;
    const row = el('div', { class: 'row', tabindex: '0', 'data-busy': String(busy) }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-line' }, [
          el('span', { class: 'row-label' }, ['BLK']),
          el('span', { class: 'row-id' }, [fmtInt(block.height)]),
          el('span', { class: 'row-age' }, [busy ? 'decoding' : timeAgo(block.timestamp)]),
        ]),
        el('div', { class: 'row-line row-meta' }, [
          el('span', {}, [`${fmtInt(block.tx_count)} txns`]),
          el('span', { class: 'sep' }, ['·']),
          el('span', { class: 'dim' }, [block.size ? `${(block.size / 1000).toFixed(0)} kB` : '']),
        ]),
      ]),
      el('span', { class: 'row-action' }, [busy ? '…' : 'decode']),
    ]);
    const go = () => {
      if (busy) return;
      if (PAGE === 'blocks') runBlockScan(block.height);
      else location.href = `./blocks.html?block=${block.height}`;
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go(); }
    });
    return row;
  });

  host.replaceChildren(el('div', { class: 'rows' }, rows));
}

// ---------------------------------------------------------------- render

/** Render whatever this page actually has. Every renderer no-ops without its DOM. */
function renderAll() {
  renderStats();
  renderRibbon();
  renderBlocks();
  renderFeed();
  renderBridge();
  renderPool();
  renderAssets();
  renderPrice();
  renderPrivacy();
  renderRelay();
  renderQuickLinks();
  renderLegend();
  renderPoolMeta();

  const stamp = $('#last-refreshed');
  if (stamp) stamp.textContent = state.refreshedAt ? `refreshed ${fmtUtc(state.refreshedAt)}` : 'not refreshed yet';
  const counts = renderSourceCount();
  const sourceNode = $('#source-count');
  if (sourceNode) sourceNode.textContent = `${counts.ok}/${counts.total}`;
}

// Handy for debugging in a console: the page state, read only.
if (typeof window !== 'undefined') window.__tacitState = state;

// Kick off.
(async () => {
  await boot();
})();












