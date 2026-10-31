// tacit1… addresses: bech32m over [version][flags][lanes].
// A tacit1 address carries public keys, never balances. Decoding one tells you
// which lanes (Bitcoin, Ethereum-side, pool) the address is payable on, and
// nothing about what it owns.

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;

const polymod = (values) => {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GENERATOR[i];
  }
  return chk;
};

const hrpExpand = (hrp) => {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
};

function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from !== 0) return null;
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return out;
}

function decodeBech32(address) {
  if (typeof address !== 'string') return { ok: false, error: 'not a string' };
  const lower = address.toLowerCase();
  if (address !== lower && address !== address.toUpperCase()) return { ok: false, error: 'mixed case' };
  const pos = lower.lastIndexOf('1');
  // Tacit addresses are longer than the generic 90-char bech32 cap: the pool
  // lane alone is 97 bytes, and a 0x07 address runs to 329 characters.
  if (pos < 1 || pos + 7 > lower.length || lower.length > 512) return { ok: false, error: 'bad separator' };
  const hrp = lower.slice(0, pos);
  const data = [];
  for (const ch of lower.slice(pos + 1)) {
    const idx = CHARSET.indexOf(ch);
    if (idx === -1) return { ok: false, error: `bad character "${ch}"` };
    data.push(idx);
  }
  const checksum = data.slice(-6);
  const payload = data.slice(0, -6);
  const constant = polymod([...hrpExpand(hrp), ...data]);
  const kind = constant === BECH32M_CONST ? 'bech32m' : constant === 1 ? 'bech32' : null;
  if (!kind) return { ok: false, error: 'checksum mismatch' };
  const bytes = convertBits(payload, 5, 8, false);
  if (!bytes) return { ok: false, error: 'invalid padding' };
  return { ok: true, hrp, kind, checksum, bytes: new Uint8Array(bytes) };
}

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * Decode a tacit1 address into its version, flags and lane keys (SPEC: Tacit
 * address format). Lane lengths are fixed by their own definition; reserved
 * flag bits are reported but not interpreted.
 */
export function decodeTacitAddress(address) {
  const parsed = decodeBech32(String(address || '').trim());
  if (!parsed.ok) return parsed;
  if (parsed.hrp !== 'tacit') return { ok: false, error: `not a tacit address (hrp "${parsed.hrp}")` };
  if (parsed.kind !== 'bech32m') return { ok: false, error: 'tacit addresses use bech32m' };
  const bytes = parsed.bytes;
  if (bytes.length < 2) return { ok: false, error: 'too short' };
  const version = bytes[0];
  const flags = bytes[1];
  if (version !== 0x00) return { ok: false, error: `unsupported version 0x${version.toString(16)}` };
  const lanes = {};
  const known = [0x01, 0x02, 0x04, 0x80];
  const reserved = flags & ~(0x01 | 0x02 | 0x04 | 0x80);
  let off = 2;
  const take = (n) => {
    if (off + n > bytes.length) throw new Error('lane data truncated');
    const slice = bytes.slice(off, off + n);
    off += n;
    return slice;
  };
  try {
    for (const bit of [0x01, 0x02, 0x04, 0x80]) {
      if (!(flags & bit)) continue;
      if (bit === 0x01) lanes.bitcoin = { spendKey: hex(take(33)), scanKey: hex(take(33)) };
      else if (bit === 0x02) lanes.ethereum = { key: hex(take(33)) };
      else if (bit === 0x04) lanes.pool = { viewKey: hex(take(33)), a: hex(take(32)), n: hex(take(32)) };
      else if (bit === 0x80) lanes.ethereum = lanes.ethereum || { key: lanes.bitcoin?.spendKey, shared: true };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  return {
    ok: true,
    hrp: parsed.hrp,
    version,
    flags,
    flagBits: known.filter((b) => flags & b).map((b) => `0x${b.toString(16).padStart(2, '0')}`),
    reserved,
    lanes,
    bytes,
    trailing: bytes.length - off,
    note:
      'Addresses carry keys, not balances. Nothing here says what a wallet holds, only which lanes it can be paid on.',
  };
}

/** Render a tacit1 hex key as the 33-byte compressed point it is. */
export const keyHex = (hexKey) => (hexKey ? '0x' + hexKey : '');
