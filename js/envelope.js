// Tacit envelope decoder: pure functions over bytes.
//
// Envelopes ride in the taproot leaf script of vin[0], script-path spent:
//   PUSH32 <signer x-only> OP_CHECKSIG <empty push> OP_IF
//     "TACIT"  0x01 (version)  <payload…>            ← all pushes
//   OP_ENDIF
// The payload is `opcode(1) || fields…`. Layouts below follow SPEC §5 and the
// amendments (see the tags on each decoder). Anything this file does not
// understand is reported as a recognised-but-undecoded opcode rather than
// guessed at.

import { OPCODES, POOL_BRIDGE_BURN } from './config.js';
import { bytesToHex, hexToBytes } from './util.js';

const MAGIC = new TextEncoder().encode('TACIT');
const VERSION = 0x01;

class Cursor {
  constructor(bytes, off = 1) { this.bytes = bytes; this.off = off; }
  left() { return this.bytes.length - this.off; }
  take(n) {
    if (!Number.isSafeInteger(n) || n < 0 || this.off + n > this.bytes.length) throw new Error('truncated payload');
    const out = this.bytes.slice(this.off, this.off + n);
    this.off += n;
    return out;
  }
  hex(n = 32) { return bytesToHex(this.take(n)); }
  u8() { return this.take(1)[0]; }
  u16le() { const b = this.take(2); return b[0] | (b[1] << 8); }
  u32le() { const b = this.take(4); return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0; }
  u64le() {
    const b = this.take(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
  u256be() {
    const b = this.take(32);
    let v = 0n;
    for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(b[i]);
    return v;
  }
  utf8(n) { return new TextDecoder('utf-8', { fatal: false }).decode(this.take(n)); }
  utf8Strict(n) { return new TextDecoder('utf-8', { fatal: true }).decode(this.take(n)); }
  need(cond, message) { if (!cond) throw new Error(message); }
  end() { if (this.off !== this.bytes.length) throw new Error(`trailing bytes (${this.bytes.length - this.off})`); }
}

function readPush(bytes, off) {
  const op = bytes[off];
  if (op === undefined) throw new Error('eof');
  if (op === 0x00) return { kind: 'push', data: new Uint8Array(0), next: off + 1 };
  if (op <= 0x4b) {
    const start = off + 1;
    if (start + op > bytes.length) throw new Error('eof push');
    return { kind: 'push', data: bytes.slice(start, start + op), next: start + op };
  }
  if (op === 0x4c || op === 0x4d || op === 0x4e) {
    const width = op === 0x4c ? 1 : op === 0x4d ? 2 : 4;
    let len = 0;
    for (let i = 0; i < width; i++) len |= bytes[off + 1 + i] << (8 * i);
    const start = off + 1 + width;
    if (start + len > bytes.length) throw new Error('eof pushdata');
    return { kind: 'push', data: bytes.slice(start, start + len), next: start + len };
  }
  return { kind: 'op', opcode: op, next: off + 1 };
}

export function parseScript(bytes) {
  const ops = [];
  let off = 0;
  while (off < bytes.length) {
    const op = readPush(bytes, off);
    ops.push(op);
    off = op.next;
  }
  return ops;
}

const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Pull the payload out of the taproot leaf script that carries envelopes.
 * Returns null when the script is not a Tacit envelope frame at all.
 */
export function extractPayload(scriptBytes) {
  let ops;
  try { ops = parseScript(scriptBytes); } catch { return null; }
  if (scriptBytes[0] !== 0x20 || ops.length < 8) return null;
  const [signer, checksig, empty, branch] = ops;
  if (signer?.kind !== 'push' || signer.data.length !== 32) return null;
  if (checksig?.kind !== 'op' || checksig.opcode !== 0xac) return null;
  if (empty?.kind !== 'push' || empty.data.length !== 0) return null;
  if (branch?.kind !== 'op' || branch.opcode !== 0x63) return null;
  const last = ops[ops.length - 1];
  if (last?.kind !== 'op' || last.opcode !== 0x68) return null;
  const inner = ops.slice(4, -1);
  if (!inner.length || inner.some((op) => op.kind !== 'push')) return null;
  if (!eqBytes(inner[0].data, MAGIC)) return null;
  if (inner[1]?.data.length !== 1 || inner[1].data[0] !== VERSION) return null;
  const payloadParts = inner.slice(2).map((op) => op.data);
  const total = payloadParts.reduce((n, p) => n + p.length, 0);
  const payload = new Uint8Array(total);
  let at = 0;
  for (const part of payloadParts) { payload.set(part, at); at += part.length; }
  return payload;
}

/** Witness array → envelope, or null when the tx carries none. */
export function decodeWitness(witness) {
  if (!witness || witness.length < 2) return null;
  let script;
  try { script = hexToBytes(witness[1]); } catch { return null; }
  const payload = extractPayload(script);
  if (!payload) return null;
  return decodePayload(payload);
}

export function decodeTransaction(tx) {
  const witness = tx?.vin?.[0]?.txinwitness || tx?.vin?.[0]?.witness;
  const decoded = decodeWitness(witness);
  if (!decoded) return null;
  return decoded.ok ? decoded.envelope : { unknown: true, reason: decoded.reason, rawPayloadHex: bytesToHex(decoded.rawPayload || new Uint8Array()) };
}

/** Core: payload bytes → { ok, envelope } | { ok:false, reason }. */
export function decodePayload(payload) {
  if (!payload.length) return { ok: false, reason: 'empty payload' };
  const op = payload[0];
  const meta = OPCODES[op];
  const isPoolBridgeBurn = op === POOL_BRIDGE_BURN.op && payload.length === POOL_BRIDGE_BURN.len;
  const name = isPoolBridgeBurn ? POOL_BRIDGE_BURN.name : meta?.name || `OP_0x${op.toString(16).padStart(2, '0')}`;
  // 0x2b is T_DROP in the classic table, but the pool's own 161-byte bridge burn
  // shares the opcode; the length disambiguates, and the family follows.
  const family = isPoolBridgeBurn ? 'bridge' : meta?.family || 'unknown';
  const c = new Cursor(payload);
  const base = { opcode: op, name, family, blurb: isPoolBridgeBurn ? 'pool bridge burn' : meta?.blurb || '' };

  try {
    const decoded = decodeFields(op, c, payload, isPoolBridgeBurn);
    if (c.off !== payload.length) throw new Error(`trailing bytes (${payload.length - c.off})`);
    return { ok: true, envelope: { ...base, ...decoded, payloadLength: payload.length } };
  } catch (err) {
    return {
      ok: false,
      reason: err.message,
      envelope: { ...base, undecoded: true, payloadLength: payload.length, rawPayloadHex: bytesToHex(payload) },
    };
  }
}

function decodeFields(op, c, payload, isPoolBridgeBurn) {
  // --- etches -----------------------------------------------------------
  if (op === 0x21) { // CETCH
    const tickerLen = c.u8();
    c.need(tickerLen >= 1 && tickerLen <= 16, `bad ticker_len=${tickerLen}`);
    const ticker = c.utf8(tickerLen);
    const decimals = c.u8();
    c.need(decimals <= 8, `bad decimals=${decimals}`);
    const commitmentC = c.hex(33);
    const amountCt = c.hex(8);
    const rangeproof = c.take(c.u16le());
    const mintAuthority = c.hex(32);
    const imgLen = c.u16le();
    const imageUri = c.utf8(imgLen);
    return { ticker, decimals, commitmentC, amountCt, rangeproofLen: rangeproof.length, mintAuthority, imageUri };
  }

  if (op === 0x27) { // T_PETCH, fair launch
    const tickerLen = c.u8();
    c.need(tickerLen >= 1 && tickerLen <= 16, `bad ticker_len=${tickerLen}`);
    const ticker = c.utf8Strict(tickerLen);
    const decimals = c.u8();
    const capAmount = c.u64le();
    const mintLimit = c.u64le();
    const mintStartHeight = c.u32le();
    const mintEndHeight = c.u32le();
    const imgLen = c.u16le();
    const imageUri = c.utf8Strict(imgLen);
    return { ticker, decimals, capAmount, mintLimit, mintStartHeight, mintEndHeight, imageUri };
  }

  // --- confidential transfers ------------------------------------------
  if (op === 0x23 || op === 0x22) { // CXFER / T_CXFER_BPP
    const assetId = c.hex(32);
    const kernelSig = c.hex(64);
    const n = c.u8();
    c.need([1, 2, 4, 8].includes(n), `bad N=${n}`);
    const outputs = [];
    for (let i = 0; i < n; i++) outputs.push({ vout: i, commitmentC: c.hex(33), encryptedAmount: c.hex(8) });
    const rangeproofLen = c.take(c.u16le()).length;
    return { assetId, kernelSig, outputCount: n, outputs, rangeproofLen };
  }

  if (op === 0x26) { // T_AXFER
    const assetId = c.hex(32);
    const assetInputCount = c.u8();
    const kernelSig = c.hex(64);
    const n = c.u8();
    c.need([1, 2, 4, 8].includes(n), `bad N=${n}`);
    const outputs = [];
    for (let i = 0; i < n; i++) outputs.push({ vout: i, commitmentC: c.hex(33), encryptedAmount: c.hex(8) });
    const rangeproofLen = c.take(c.u16le()).length;
    return { assetId, assetInputCount, kernelSig, outputCount: n, outputs, rangeproofLen };
  }

  if (op === 0x37) { // T_AXFER_VAR
    const assetId = c.hex(32);
    const assetInputCount = c.u8();
    const kernelSig = c.hex(64);
    const n = c.u8();
    const outputs = [];
    for (let i = 0; i < n; i++) outputs.push({ vout: i, commitmentC: c.hex(33), encryptedAmount: c.hex(8) });
    const rangeproofLen = c.take(c.u16le()).length;
    return { assetId, assetInputCount, kernelSig, outputCount: n, outputs, rangeproofLen };
  }

  // --- supply ----------------------------------------------------------
  if (op === 0x24) { // T_MINT
    const assetId = c.hex(32);
    const etchTxid = c.hex(32);
    const commitmentC = c.hex(33);
    c.hex(8);
    const rangeproofLen = c.take(c.u16le()).length;
    const issuerSig = c.hex(64);
    return { assetId, etchTxid, commitmentC, rangeproofLen, issuerSig };
  }

  if (op === 0x25) { // T_BURN: amount is public
    const assetId = c.hex(32);
    const burnedAmount = c.u64le();
    const kernelSig = c.hex(64);
    const n = c.u8();
    c.need([0, 1, 2, 4, 8].includes(n), `bad N=${n}`);
    const outputs = [];
    for (let i = 0; i < n; i++) outputs.push({ vout: i, commitmentC: c.hex(33), encryptedAmount: c.hex(8) });
    if (n > 0) c.take(c.u16le());
    return { assetId, burnedAmount, kernelSig, outputCount: n, outputs };
  }

  if (op === 0x28) { // T_PMINT: amount and blinding are public
    c.need(payload.length === 138, `T_PMINT payload must be 138 bytes`);
    const assetId = c.hex(32);
    const etchTxid = c.hex(32);
    const commitmentC = c.hex(33);
    const amount = c.u64le();
    const blinding = c.hex(32);
    return { assetId, etchTxid, commitmentC, amount, blinding };
  }

  // --- money in / out of the pool --------------------------------------
  if (op === 0x29) { // T_DEPOSIT
    const assetId = c.hex(32);
    const denomination = c.u64le();
    if (denomination === 0n) {
      const poolDenom = c.u64le();
      const vkCid = c.utf8(c.u8());
      const ceremonyCid = c.utf8(c.u8());
      c.hex(64);
      return { assetId, denomination, isPoolInit: true, poolDenom, vkCid, ceremonyCid };
    }
    c.hex(32);
    c.hex(64);
    return { assetId, denomination };
  }

  if (op === 0x2a) { // T_WITHDRAW
    const assetId = c.hex(32);
    const denomination = c.u64le();
    const merkleRoot = c.hex(32);
    const nullifierHash = c.hex(32);
    c.hex(33);
    const rLeaf = c.hex(32);
    const bindHash = c.hex(32);
    const proofLen = c.take(c.u16le()).length;
    return { assetId, denomination, merkleRoot, nullifierHash, rLeaf, bindHash, proofLen };
  }

  // --- drops ------------------------------------------------------------
  if (isPoolBridgeBurn) { // T_POOL_BRIDGE_BURN: the pool's own 161-byte bridge burn
    const assetId = c.hex(32);
    const poolRoot = c.hex(32);
    const nullifier = c.hex(32);
    const destinationCommitment = c.hex(32);
    const targetChainBinding = c.hex(32);
    return { assetId, poolRoot, nullifier, destinationCommitment, targetChainBinding };
  }

  if (op === 0x2b) { // T_DROP
    const assetId = c.hex(32);
    const capAmount = c.u64le();
    const perClaim = c.u64le();
    if (perClaim === 0n) {
      const reclaimDropId = c.hex(32);
      c.hex(64);
      c.hex(32);
      return { assetId, capAmount, perClaim, isReclaim: true, reclaimDropId };
    }
    c.hex(32);
    c.u32le();
    const tickerLen = c.u8();
    const ticker = tickerLen ? c.utf8Strict(tickerLen) : '';
    const decimals = c.u8();
    c.u8();
    c.hex(64);
    return { assetId, capAmount, perClaim, ticker, decimals };
  }

  if (op === 0x2c) { // T_DCLAIM
    const assetId = c.hex(32);
    const dropRevealTxid = c.hex(32);
    c.hex(33);
    const amount = c.u64le();
    c.hex(32);
    c.take(c.u16le());
    return { assetId, dropRevealTxid, amount };
  }

  // --- swaps / AMM / farms ---------------------------------------------
  if (op === 0x39 || op === 0x3c || op === 0x3d) {
    if (op === 0x39) c.hex(32); // target chain binding
    const assetId = c.hex(32);
    if (op !== 0x39) c.u8();
    c.hex(64);
    const n = c.u8();
    for (let i = 0; i < n; i++) { c.hex(33); c.hex(8); }
    c.take(c.u16le());
    return { assetId, outputCount: n };
  }

  // --- bridge -----------------------------------------------------------
  if (op === 0x60 || op === 0x61 || op === 0x62) {
    const networkTag = c.u8();
    const assetId = c.hex(32);
    const denomWei = c.u256be();
    if (op === 0x60) {
      const ethRoot = c.hex(32);
      c.hex(32); c.hex(33); c.hex(32); c.hex(32); c.hex(32);
      c.take(c.u16le());
      return { networkTag, assetId, denomWei, ethRoot };
    }
    if (op === 0x61) {
      const merkleRoot = c.hex(32);
      c.hex(32); c.hex(33); c.hex(32);
      const ethRecipient = '0x' + c.hex(20);
      const burnNonce = c.hex(32);
      const bindHash = c.hex(32);
      c.take(c.u16le());
      return { networkTag, assetId, denomWei, merkleRoot, ethRecipient, burnNonce, bindHash };
    }
    c.hex(32); c.hex(32); c.hex(33); c.hex(32); c.hex(32);
    c.take(c.u16le());
    c.hex(33); c.hex(32); c.hex(33); c.hex(64);
    return { networkTag, assetId, denomWei };
  }

  if (op === 0x63) { // T_BRIDGE_NOTE: encrypted memo, opaque by design
    const ephemeralPubkey = c.hex(33);
    const ciphertext = c.hex(89);
    return { ephemeralPubkey, ciphertext, encrypted: true };
  }

  if (op === 0x67) { // T_SETTLE
    c.hex(32);
    const lockVout = c.u32le();
    const valueSats = c.u64le();
    c.hex(64);
    return { lockVout, valueSats };
  }

  if (op === 0x68) { // T_BTC_CALL
    c.hex(20); c.hex(20); c.hex(32); c.hex(33); c.hex(32); c.hex(64);
    return {};
  }

  if (op === 0x69) { // T_ETH_CALL
    const messageId = c.hex(32);
    const namespace = c.hex(32);
    const sender = '0x' + c.hex(20);
    const chain = c.take(2);
    const destChain = (chain[0] << 8) | chain[1];
    const payloadHash = c.hex(32);
    const len = c.u16le();
    const message = c.hex(len);
    return { messageId, namespace, sender, destChain, payloadHash, message };
  }

  // Recognised shapes we deliberately do not decode field-by-field.
  return { notDecoded: true };
}

/** Value-bearing fields, if the op published any. Returns null when hidden. */
export function publicAmount(env) {
  if (!env) return null;
  if (env.burnedAmount !== undefined) return { units: env.burnedAmount, label: 'burned' };
  if (env.name === 'T_PMINT' && env.amount !== undefined) return { units: env.amount, label: 'minted' };
  if (env.denomination !== undefined && env.denomination > 0n) return { units: env.denomination, label: 'denomination' };
  if (env.denomWei !== undefined) return { satsOrWei: env.denomWei, label: 'denom' };
  if (env.capAmount !== undefined) return { units: env.capAmount, label: 'cap' };
  return null;
}

/** One-line human description used by the feed. */
export function describe(env) {
  if (!env) return 'undecodable';
  if (env.unknown) return `unrecognised envelope: ${env.reason}`;
  const bits = [];
  if (env.ticker) bits.push(`${env.ticker}${env.decimals !== undefined ? ` · ${env.decimals}dp` : ''}`);
  if (env.outputCount) bits.push(`${env.outputCount} output${env.outputCount > 1 ? 's' : ''}`);
  if (env.assetInputCount) bits.push(`${env.assetInputCount} input${env.assetInputCount > 1 ? 's' : ''}`);
  if (env.name === 'T_BRIDGE_NOTE') bits.push('encrypted memo');
  if (env.notDecoded) bits.push(`${env.payloadLength}B payload`);
  if (env.undecoded) bits.push(env.reason || 'not decoded');
  return bits.join(' · ');
}
