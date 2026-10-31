// Small dependency-free helpers: DOM, hex, numbers, time.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

export const setText = (node, value) => { if (node) node.textContent = value === null || value === undefined ? 'n/a' : String(value); };

export const norm = (hex) => String(hex || '').toLowerCase().replace(/^0x/, '');

export const isHex = (s, bytes) => {
  const n = norm(s);
  return n.length === bytes * 2 && /^[0-9a-f]+$/.test(n);
};

export function hexToBytes(hex) {
  const n = norm(hex);
  if (n.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(n.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(n.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export const bytesToHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

export function short(hex, head = 6, tail = 4) {
  const s = String(hex || '');
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export const fmtInt = (n) => {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return 'n/a';
  return Number(n).toLocaleString('en-US');
};

export function fmtCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 'n/a';
  if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  return fmtInt(v);
}

export function fmtUnits(value, decimals = 18, maxFrac = 6) {
  if (value === null || value === undefined) return 'n/a';
  let v;
  try { v = BigInt(value); } catch { return 'n/a'; }
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '').slice(0, maxFrac);
  const wholeStr = whole.toLocaleString('en-US');
  return fracStr ? `${wholeStr}.${fracStr}` : wholeStr;
}

export function fmtSats(sats) {
  const s = Number(sats);
  if (!Number.isFinite(s)) return 'n/a';
  return `${fmtInt(s)} sats`;
}

/** Accepts unix seconds, unix milliseconds, ISO strings and Dates. */
function toMs(when) {
  if (when === null || when === undefined || when === '') return null;
  if (when instanceof Date) return when.getTime();
  if (typeof when === 'string') {
    const parsed = Date.parse(when);
    return Number.isNaN(parsed) ? null : parsed;
  }
  const n = Number(when);
  if (!Number.isFinite(n) || n === 0) return null;
  return n < 1e12 ? n * 1000 : n;
}

export function timeAgo(when, now = Date.now()) {
  const ms = toMs(when);
  if (ms === null) return 'n/a';
  const diff = Math.max(0, now - ms);
  const s = Math.round(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtUtc(when) {
  const ms = toMs(when);
  if (ms === null) return 'n/a';
  const d = new Date(ms);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error('clipboard unavailable'));
}

// Deterministic pastel per string, used for asset chips so the same asset always looks the same.
export function hueOf(str) {
  let h = 0;
  for (let i = 0; i < String(str).length; i++) h = (h * 31 + String(str).charCodeAt(i)) >>> 0;
  return h % 360;
}

export const pct = (num, den) => (den ? (100 * num) / den : 0);

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
