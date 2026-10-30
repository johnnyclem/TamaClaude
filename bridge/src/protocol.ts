/**
 * The wire codec: the only code in the bridge that turns bytes into messages and
 * messages into bytes. PROTOCOL.md is the human spec; types.ts is the contract this
 * implements; fixtures/ holds the bytes both are tested against.
 *
 * Two deliberately different attitudes live here:
 *
 *  - ENCODERS are paranoid about the bridge itself. An invalid outbound message is a
 *    bridge bug, and repairing it silently would hide the bug while putting a
 *    surprising frame on a handheld with a 1 KB receive buffer. So they throw
 *    RangeError and never sanitize (callers use text.ts for that).
 *  - DECODERS are paranoid about the network. Whatever arrives is hostile until proven
 *    otherwise, so they never throw, never recurse and never build an object out of
 *    attacker-chosen keys. They accept exactly the encoders' output set and nothing
 *    more: a frame the decoder accepts can always be re-encoded.
 *
 * Why a hand-written scanner instead of JSON.parse: JSON.parse keeps the LAST of a
 * duplicated key, so `{"t":"ask_rsp","id":"...","ok":false,"ok":true}` would be read
 * by this side as one thing and by a firmware parser that keeps the FIRST as another.
 * An approval path cannot have two readings, so duplicates are an error here, and
 * that needs a parser that sees every key. Messages are flat by contract, so the
 * scanner is small and has no recursion to blow the stack.
 *
 * Every field is described once, in the layout tables below, and both directions are
 * driven from them, so encoder and decoder cannot drift apart. The cost of that is
 * that a wrong table entry is wrong both ways; test/protocol.test.ts therefore pins
 * the wire bytes with hand-typed literals, not with round trips.
 */

import {
  ASK_END_REASONS,
  ERR_CODES,
  FRAME_KIND_MIC,
  FRAME_KIND_TTS,
  HELLO_WHYS,
  LIMITS,
  PHASES,
  RISKS,
} from './types.ts';
import type { BridgeMsg, DecodeResult, DeviceMsg } from './types.ts';

/** Every number on the wire is a non-negative decimal integer that fits an int32. */
const INT_MAX = 2147483647;

/**
 * The session id in `hello_ack` has no entry in LIMITS (it is a UUID in practice, 36
 * characters). The frame budget needs a cap, so it is pinned here until LIMITS grows
 * one; PROTOCOL.md states the same number.
 */
const SID_MAX = 64;

/** types.ts declares `ListenMsg.m` inline, so there is no exported array to import. */
const LISTEN_MODES: readonly string[] = ['start', 'stop', 'cancel'];

/** The characters a hello token may use: the unreserved set of RFC 3986. */
const TOKEN_CHARS = /^[A-Za-z0-9._~-]*$/;
const LOWER_HEX = /^[0-9a-f]*$/;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const CANONICAL_INT = /^(?:0|[1-9][0-9]*)$/;

export function isPrintableAscii(s: string): boolean {
  // The typeof guard is for callers holding an `unknown` that crossed a JSON parse.
  return typeof s === 'string' && PRINTABLE_ASCII.test(s);
}

// ---------------------------------------------------------------------------
// Layouts: one entry per message type, listing its fields IN WIRE ORDER (the order
// of the interfaces in types.ts). `t` is implicit and always first. Limits are read
// through functions, at call time, so a test can lower one and watch a guard fire.
// ---------------------------------------------------------------------------

interface IntField { key: string; kind: 'int' }
interface BoolField { key: string; kind: 'bool' }
interface EnumField { key: string; kind: 'enum'; values: ReadonlySet<string> }
interface StrField {
  key: string;
  kind: 'str';
  min: () => number;
  max: () => number;
  /** Narrower than printable ASCII (tokens, ids); null means any printable ASCII. */
  charset: RegExp | null;
}
type Field = IntField | BoolField | EnumField | StrField;

/** A fixed field list, or a chooser for the one type whose shape depends on a value. */
type Layout = readonly Field[] | ((get: (key: string) => unknown) => readonly Field[] | string);
type LayoutTable = ReadonlyMap<string, Layout>;

const int = (key: string): Field => ({ key, kind: 'int' });
const bool = (key: string): Field => ({ key, kind: 'bool' });
const oneOf = (key: string, values: readonly string[]): Field => ({ key, kind: 'enum', values: new Set(values) });
const text = (key: string, max: () => number): Field => ({ key, kind: 'str', min: () => 0, max, charset: null });
const id = (key: string): Field => ({
  key, kind: 'str', min: () => LIMITS.idLen, max: () => LIMITS.idLen, charset: LOWER_HEX,
});

const HELLO_ACK_OK: readonly Field[] = [int('v'), bool('ok'), text('sid', () => SID_MAX)];
const HELLO_ACK_REFUSED: readonly Field[] = [int('v'), bool('ok'), oneOf('why', HELLO_WHYS)];

const DEVICE_LAYOUTS: LayoutTable = new Map<string, Layout>([
  ['hello', [
    int('v'),
    { key: 'token', kind: 'str', min: () => LIMITS.tokenMin, max: () => LIMITS.tokenMax, charset: TOKEN_CHARS },
    text('dev', () => LIMITS.devMax),
    text('fw', () => LIMITS.fwMax),
    int('rate'),
    int('bits'),
    int('ch'),
  ]],
  ['say', [text('text', () => LIMITS.sayMax)]],
  ['listen', [oneOf('m', LISTEN_MODES)]],
  ['ask_rsp', [id('id'), bool('ok')]],
  ['abort', []],
  ['ping', [int('n')]],
]);

const BRIDGE_LAYOUTS: LayoutTable = new Map<string, Layout>([
  // The only type with two shapes. The discriminator must be a real boolean: a
  // truthy string would otherwise pick a shape by accident.
  ['hello_ack', (get) => {
    const ok = get('ok');
    if (ok === true) return HELLO_ACK_OK;
    if (ok === false) return HELLO_ACK_REFUSED;
    return 'hello_ack.ok: not a boolean';
  }],
  ['state', [int('seq'), oneOf('ph', PHASES), text('tl', () => LIMITS.labelMax), int('pend')]],
  ['stt', [text('text', () => LIMITS.sttMax)]],
  ['ask', [id('id'), text('tl', () => LIMITS.labelMax), oneOf('risk', RISKS), text('sum', () => LIMITS.summaryMax), int('ttl')]],
  ['ask_end', [id('id'), oneOf('why', ASK_END_REASONS)]],
  ['result', [bool('ok'), text('text', () => LIMITS.resultMax)]],
  ['err', [oneOf('code', ERR_CODES), text('msg', () => LIMITS.errMax)]],
  ['pong', [int('n')]],
]);

/**
 * Why a value is not acceptable for a field, or null when it is. Shared by both
 * directions so "valid" means one thing. Reasons are fixed strings: they must never
 * echo the offending value, which is attacker-chosen on the decode side and
 * model-chosen on the encode side.
 */
function checkField(f: Field, v: unknown): string | null {
  switch (f.kind) {
    case 'int':
      if (typeof v !== 'number') return 'not a number';
      // -0 passes isInteger and prints as "0": accepting it would repair it silently.
      if (!Number.isInteger(v) || Object.is(v, -0)) return 'not an integer';
      if (v < 0 || v > INT_MAX) return 'out of range';
      return null;
    case 'bool':
      return typeof v === 'boolean' ? null : 'not a boolean';
    case 'enum':
      if (typeof v !== 'string') return 'not a string';
      return f.values.has(v) ? null : 'not an allowed value';
    case 'str': {
      if (typeof v !== 'string') return 'not a string';
      // Length first: it is O(1), so a hostile 10 MB string is refused unscanned.
      if (v.length > f.max()) return 'too long';
      if (v.length < f.min()) return 'too short';
      if (!PRINTABLE_ASCII.test(v)) return 'not printable ascii';
      if (f.charset !== null && !f.charset.test(v)) return 'bad characters';
      return null;
    }
  }
}

/** The fields of `t`, or a full failure reason when the type or its discriminator is unusable. */
function fieldsFor(layouts: LayoutTable, t: string, get: (key: string) => unknown): readonly Field[] | string {
  const layout = layouts.get(t);
  if (layout === undefined) return 'unknown type';
  return typeof layout === 'function' ? layout(get) : layout;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function encodeText(m: unknown, layouts: LayoutTable, frameMax: number): string {
  if (typeof m !== 'object' || m === null || Array.isArray(m)) throw new RangeError('encode: not an object');
  const rec = m as Record<string, unknown>; // narrowed from `object` only to index it; every value is checked below
  const t = rec['t'];
  if (typeof t !== 'string') throw new RangeError('encode: t is not a string');
  const fields = fieldsFor(layouts, t, (k) => rec[k]);
  // `t` is not echoed: for an unknown type it is whatever the caller made up.
  if (typeof fields === 'string') throw new RangeError(`encode: ${fields}`);

  const names = Object.keys(rec);
  for (const f of fields) {
    if (!names.includes(f.key)) throw new RangeError(`encode ${t}: missing key ${f.key}`);
  }
  // A caller that adds a field has either a typo or a protocol change nobody decided.
  if (names.length !== fields.length + 1) throw new RangeError(`encode ${t}: unexpected key`);

  let out = `{"t":${JSON.stringify(t)}`;
  for (const f of fields) {
    const v = rec[f.key];
    const bad = checkField(f, v);
    if (bad !== null) throw new RangeError(`encode ${t}.${f.key}: ${bad}`);
    // Printable ASCII means JSON.stringify can only ever emit the two escapes `\"` and `\\`.
    out += `,"${f.key}":${f.kind === 'int' || f.kind === 'bool' ? String(v) : JSON.stringify(v)}`;
  }
  out += '}';
  if (Buffer.byteLength(out, 'utf8') > frameMax) throw new RangeError(`encode ${t}: frame too big`);
  return out;
}

export function encodeBridgeMsg(m: BridgeMsg): string {
  return encodeText(m, BRIDGE_LAYOUTS, LIMITS.bridgeFrameMax);
}

export function encodeDeviceMsg(m: DeviceMsg): string {
  return encodeText(m, DEVICE_LAYOUTS, LIMITS.deviceFrameMax);
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

type Scalar = string | number | boolean | null;

const fail = (msg: string): { ok: false; code: 'bad_msg'; msg: string } => ({ ok: false, code: 'bad_msg', msg });

/**
 * Scan one flat JSON object. Returns its members, or a short reason. A Map, not an
 * object: a key called `__proto__` is then just a key (and an unknown one), and there
 * is no prototype for it to reach.
 *
 * Accepted: RFC 8259 whitespace between tokens, every string escape, and numbers only
 * in canonical non-negative integer form (no sign, fraction, exponent or leading
 * zero), which also disposes of `-0`, `1e999` and `1.0` without special cases.
 * Refused: nested objects and arrays (they are refused where they start, so nothing
 * recurses), duplicate keys, trailing bytes.
 */
function scanFlatObject(src: string): Map<string, Scalar> | string {
  const n = src.length;
  let i = 0;

  const skipWs = (): void => {
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else return;
    }
  };

  /** Reads the string at `i` (which must be a quote). Null means malformed. */
  const readString = (): string | null => {
    i++;
    let out = '';
    let run = i;
    while (i < n) {
      const c = src.charCodeAt(i);
      if (c === 0x22) {
        out += src.slice(run, i);
        i++;
        return out;
      }
      if (c < 0x20) return null; // a raw control character is not legal JSON
      if (c !== 0x5c) {
        i++;
        continue;
      }
      out += src.slice(run, i);
      i++;
      const e = src.charCodeAt(i);
      i++;
      switch (e) {
        case 0x22: out += '"'; break;
        case 0x5c: out += '\\'; break;
        case 0x2f: out += '/'; break;
        case 0x62: out += '\b'; break;
        case 0x66: out += '\f'; break;
        case 0x6e: out += '\n'; break;
        case 0x72: out += '\r'; break;
        case 0x74: out += '\t'; break;
        case 0x75: {
          const hex = src.slice(i, i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
          break;
        }
        default: return null;
      }
      run = i;
    }
    return null; // unterminated
  };

  skipWs();
  if (src.charCodeAt(i) !== 0x7b) return 'not a json object';
  i++;
  const members = new Map<string, Scalar>();
  skipWs();
  if (src.charCodeAt(i) === 0x7d) {
    i++;
  } else {
    for (;;) {
      skipWs();
      if (src.charCodeAt(i) !== 0x22) return 'bad json';
      const key = readString();
      if (key === null) return 'bad string';
      if (members.has(key)) return 'duplicate key';
      skipWs();
      if (src.charCodeAt(i) !== 0x3a) return 'bad json';
      i++;
      skipWs();

      const c = src.charCodeAt(i);
      let value: Scalar;
      if (c === 0x22) {
        const s = readString();
        if (s === null) return 'bad string';
        value = s;
      } else if (c === 0x7b || c === 0x5b) {
        return 'nested value';
      } else if (src.startsWith('true', i)) {
        value = true;
        i += 4;
      } else if (src.startsWith('false', i)) {
        value = false;
        i += 5;
      } else if (src.startsWith('null', i)) {
        value = null;
        i += 4;
      } else {
        const start = i;
        while (i < n && /[0-9+\-.eE]/.test(src[i] ?? '')) i++;
        const tok = src.slice(start, i);
        // 15 digits is the most a double holds exactly; INT_MAX is 10, so anything
        // longer is out of range anyway and need not be converted.
        if (!CANONICAL_INT.test(tok) || tok.length > 15) return 'bad number';
        value = Number(tok);
      }
      members.set(key, value);

      skipWs();
      const d = src.charCodeAt(i);
      i++;
      if (d === 0x2c) continue;
      if (d === 0x7d) break;
      return 'bad json';
    }
  }
  skipWs();
  return i === n ? members : 'trailing data';
}

function decodeText(raw: unknown, layouts: LayoutTable, frameMax: number): DecodeResult<Record<string, unknown>> {
  if (typeof raw !== 'string') return fail('not text');
  // Bytes, not characters: the limit is the firmware's receive buffer.
  if (Buffer.byteLength(raw, 'utf8') > frameMax) return fail('frame too big');

  const members = scanFlatObject(raw);
  if (typeof members === 'string') return fail(members);

  const t = members.get('t');
  if (t === undefined) return fail('missing key: t');
  if (typeof t !== 'string') return fail('t: not a string');
  const fields = fieldsFor(layouts, t, (k) => members.get(k));
  if (typeof fields === 'string') return fail(fields);

  for (const f of fields) {
    if (!members.has(f.key)) return fail(`missing key: ${f.key}`);
  }
  // `t` plus every field is present, so any surplus is an unknown key. Its name is
  // not echoed: it is attacker-chosen.
  if (members.size !== fields.length + 1) return fail('extra key');

  // Built from the layout, never from the input's own keys.
  const msg: Record<string, unknown> = { t };
  for (const f of fields) {
    const v = members.get(f.key);
    const bad = checkField(f, v);
    if (bad !== null) return fail(`${t}.${f.key}: ${bad}`);
    msg[f.key] = v;
  }
  return { ok: true, msg };
}

export function decodeBridgeMsg(raw: string): DecodeResult<BridgeMsg> {
  const r = decodeText(raw, BRIDGE_LAYOUTS, LIMITS.bridgeFrameMax);
  // The cast is the one place TypeScript is told what it cannot see: decodeText
  // checked every field against the layout that mirrors BridgeMsg.
  return r.ok ? { ok: true, msg: r.msg as unknown as BridgeMsg } : r;
}

export function decodeDeviceMsg(raw: string): DecodeResult<DeviceMsg> {
  const r = decodeText(raw, DEVICE_LAYOUTS, LIMITS.deviceFrameMax);
  return r.ok ? { ok: true, msg: r.msg as unknown as DeviceMsg } : r;
}

// ---------------------------------------------------------------------------
// Binary audio frames: [kind:u8][s16le mono PCM ...]
// ---------------------------------------------------------------------------

/** Why this kind and payload length cannot be a frame, or null. Shared by both directions. */
function checkAudio(kind: unknown, payloadLen: number): string | null {
  if (kind !== FRAME_KIND_MIC && kind !== FRAME_KIND_TTS) return 'unknown kind';
  if (payloadLen === 0) return 'no payload';
  // Samples are s16: an odd byte count means a torn sample, and playing it would
  // shift every later sample by a byte into static.
  if (payloadLen % 2 !== 0) return 'odd length';
  if (payloadLen > LIMITS.audioPayloadMax) return 'payload too big';
  return null;
}

export function encodeAudioFrame(kind: number, pcm: Uint8Array): Uint8Array {
  if (!(pcm instanceof Uint8Array)) throw new RangeError('encode audio: pcm is not bytes');
  const bad = checkAudio(kind, pcm.length);
  if (bad !== null) throw new RangeError(`encode audio: ${bad}`);
  const frame = new Uint8Array(1 + pcm.length); // a copy: the caller's buffer may be reused
  frame[0] = kind;
  frame.set(pcm, 1);
  return frame;
}

export function decodeAudioFrame(frame: Uint8Array): DecodeResult<{ kind: number; pcm: Uint8Array }> {
  if (!(frame instanceof Uint8Array)) return fail('audio: not bytes');
  const kind = frame[0];
  if (kind === undefined) return fail('audio: empty frame');
  const bad = checkAudio(kind, frame.length - 1);
  if (bad !== null) return fail(`audio: ${bad}`);
  // Copied, not a view: the transport may hand over a slice of a pooled buffer that
  // it reuses once this call returns.
  const pcm = new Uint8Array(frame.length - 1);
  pcm.set(frame.subarray(1));
  return { ok: true, msg: { kind, pcm } };
}
