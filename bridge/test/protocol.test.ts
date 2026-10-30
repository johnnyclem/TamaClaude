/**
 * The wire codec. Read this file as the list of promises PROTOCOL.md makes.
 *
 * Two habits run through it, both from this repository's CLAUDE.md:
 *
 *  - Wire bytes are pinned with literals typed by hand in this file. The encoders and
 *    decoders are driven from one table, so a round trip alone would agree with
 *    itself even if the table were wrong ("a test that proves the transcription").
 *  - A rule phrased as "X is refused" is paired with the case where X's neighbour is
 *    accepted, otherwise the test passes when the guard is simply missing. Each
 *    refusal also pins its REASON, so a hostile input that trips two guards cannot
 *    keep the test green after one of them is deleted.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  decodeAudioFrame, decodeBridgeMsg, decodeDeviceMsg, encodeAudioFrame, encodeBridgeMsg, encodeDeviceMsg,
  isPrintableAscii,
} from '../src/protocol.ts';
import {
  ASK_END_REASONS, BRIDGE_MSG_TYPES, DEVICE_MSG_TYPES, ERR_CODES, FRAME_KIND_MIC, FRAME_KIND_TTS, HELLO_WHYS,
  LIMITS, PHASES, PROTOCOL_VERSION, RISKS,
} from '../src/types.ts';
import type { BridgeMsg, DecodeResult, DeviceMsg } from '../src/types.ts';

type Dir = 'device' | 'bridge';

const enc = (dir: Dir, m: unknown): string =>
  dir === 'device' ? encodeDeviceMsg(m as DeviceMsg) : encodeBridgeMsg(m as BridgeMsg);
const dec = (dir: Dir, raw: unknown): DecodeResult<DeviceMsg | BridgeMsg> =>
  dir === 'device' ? decodeDeviceMsg(raw as string) : decodeBridgeMsg(raw as string);

/** Asserts a refusal: code, a reason matching `re`, and a reason that is itself fit for the wire. */
function refused(r: DecodeResult<unknown>, re: RegExp, label = ''): void {
  assert.equal(r.ok, false, `${label}: was accepted`);
  if (r.ok) return;
  assert.equal(r.code, 'bad_msg', label);
  assert.match(r.msg, re, label);
  assert.ok(r.msg.length <= LIMITS.errMax, `${label}: reason is ${r.msg.length} chars`);
  assert.ok(isPrintableAscii(r.msg), `${label}: reason is not printable ASCII`);
}

/** Runs `fn` with one limit lowered, always restoring it. LIMITS is read at call time on purpose. */
function withLimit<T>(key: keyof typeof LIMITS, value: number, fn: () => T): T {
  const limits = LIMITS as unknown as Record<string, number>;
  const saved = limits[key];
  limits[key] = value;
  try {
    return fn();
  } finally {
    limits[key] = saved!;
  }
}

/**
 * Timing assertions only separate "linear" from "quadratic or worse", which is
 * seconds to minutes on these inputs, so the budget is generous enough not to flake
 * when the machine is busy running other suites.
 */
const BUDGET_MS = 1500;
const INT_MAX = 2147483647;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

// ---------------------------------------------------------------------------
// Samples with hand-typed wire literals. These, not the codec, say what the bytes are.
// ---------------------------------------------------------------------------

const HELLO: DeviceMsg = { t: 'hello', v: 1, token: '0123456789abcdef', dev: 'dev', fw: '1.0', rate: 16000, bits: 16, ch: 1 };

const DEVICE_SAMPLES: Array<{ msg: DeviceMsg; wire: string }> = [
  { msg: HELLO, wire: '{"t":"hello","v":1,"token":"0123456789abcdef","dev":"dev","fw":"1.0","rate":16000,"bits":16,"ch":1}' },
  { msg: { t: 'say', text: 'hi' }, wire: '{"t":"say","text":"hi"}' },
  { msg: { t: 'listen', m: 'start' }, wire: '{"t":"listen","m":"start"}' },
  { msg: { t: 'listen', m: 'stop' }, wire: '{"t":"listen","m":"stop"}' },
  { msg: { t: 'listen', m: 'cancel' }, wire: '{"t":"listen","m":"cancel"}' },
  { msg: { t: 'ask_rsp', id: '0a1b2c3d', ok: true }, wire: '{"t":"ask_rsp","id":"0a1b2c3d","ok":true}' },
  { msg: { t: 'ask_rsp', id: '0a1b2c3d', ok: false }, wire: '{"t":"ask_rsp","id":"0a1b2c3d","ok":false}' },
  { msg: { t: 'abort' }, wire: '{"t":"abort"}' },
  { msg: { t: 'ping', n: 7 }, wire: '{"t":"ping","n":7}' },
];

const BRIDGE_SAMPLES: Array<{ msg: BridgeMsg; wire: string }> = [
  { msg: { t: 'hello_ack', v: 1, ok: true, sid: 'abc-123' }, wire: '{"t":"hello_ack","v":1,"ok":true,"sid":"abc-123"}' },
  { msg: { t: 'hello_ack', v: 1, ok: false, why: 'token' }, wire: '{"t":"hello_ack","v":1,"ok":false,"why":"token"}' },
  { msg: { t: 'state', seq: 3, ph: 'tool', tl: 'Bash', pend: 0 }, wire: '{"t":"state","seq":3,"ph":"tool","tl":"Bash","pend":0}' },
  { msg: { t: 'stt', text: 'run tests' }, wire: '{"t":"stt","text":"run tests"}' },
  { msg: { t: 'ask', id: '0a1b2c3d', tl: 'Bash', risk: 'high', sum: 'rm -rf build', ttl: 60 }, wire: '{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"high","sum":"rm -rf build","ttl":60}' },
  { msg: { t: 'ask_end', id: '0a1b2c3d', why: 'answered' }, wire: '{"t":"ask_end","id":"0a1b2c3d","why":"answered"}' },
  { msg: { t: 'result', ok: true, text: 'done' }, wire: '{"t":"result","ok":true,"text":"done"}' },
  { msg: { t: 'err', code: 'busy', msg: 'a turn is running' }, wire: '{"t":"err","code":"busy","msg":"a turn is running"}' },
  { msg: { t: 'pong', n: 7 }, wire: '{"t":"pong","n":7}' },
];

const ALL: Array<{ dir: Dir; msg: DeviceMsg | BridgeMsg; wire: string }> = [
  ...DEVICE_SAMPLES.map((s) => ({ dir: 'device' as const, ...s })),
  ...BRIDGE_SAMPLES.map((s) => ({ dir: 'bridge' as const, ...s })),
];

describe('the samples themselves', () => {
  it('cover every message type in types.ts, so a new type cannot slip past these tests', () => {
    assert.deepEqual([...new Set(DEVICE_SAMPLES.map((s) => s.msg.t))].sort(), [...DEVICE_MSG_TYPES].sort());
    assert.deepEqual([...new Set(BRIDGE_SAMPLES.map((s) => s.msg.t))].sort(), [...BRIDGE_MSG_TYPES].sort());
  });
});

// ---------------------------------------------------------------------------
describe('isPrintableAscii', () => {
  it('is true for exactly 0x20..0x7e, checked for every UTF-16 code unit', () => {
    for (let c = 0; c < 0x10000; c++) {
      assert.equal(isPrintableAscii(String.fromCharCode(c)), c >= 0x20 && c <= 0x7e, `U+${c.toString(16)}`);
    }
  });

  it('judges a whole string by its worst character, wherever it sits', () => {
    assert.equal(isPrintableAscii(''), true); // vacuously: nothing in it is unprintable
    assert.equal(isPrintableAscii('abc XYZ ~!"\\'), true);
    for (const bad of ['\n', '\t', '\0', '\x7f', '\x80', '\u00e9', '\u{1F600}', '\ud800']) {
      assert.equal(isPrintableAscii(bad + 'abc'), false, 'leading');
      assert.equal(isPrintableAscii('abc' + bad), false, 'trailing');
      assert.equal(isPrintableAscii('ab' + bad + 'c'), false, 'middle');
    }
  });

  it('does not treat a trailing newline as end of input', () => {
    assert.equal(isPrintableAscii('abc\n'), false);
  });

  it('is false for anything that is not a string', () => {
    for (const v of [undefined, null, 5, {}, [], ['a'], Buffer.from('a'), true]) {
      assert.equal(isPrintableAscii(v as unknown as string), false);
    }
  });

  it('takes a long string in one pass', () => {
    const t0 = performance.now();
    assert.equal(isPrintableAscii('a'.repeat(5_000_000)), true);
    assert.ok(performance.now() - t0 < BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
describe('encoders: the exact bytes', () => {
  it('produce the hand-typed wire literal for every sample, keys in the order of types.ts', () => {
    for (const s of DEVICE_SAMPLES) assert.equal(encodeDeviceMsg(s.msg), s.wire);
    for (const s of BRIDGE_SAMPLES) assert.equal(encodeBridgeMsg(s.msg), s.wire);
  });

  it('do not depend on the order the caller built the object in', () => {
    const shuffled = { ch: 1, bits: 16, rate: 16000, fw: '1.0', dev: 'dev', token: '0123456789abcdef', v: 1, t: 'hello' };
    assert.equal(encodeDeviceMsg(shuffled as unknown as DeviceMsg), DEVICE_SAMPLES[0]!.wire);
    const ask = { ttl: 60, sum: 'rm -rf build', risk: 'high', tl: 'Bash', id: '0a1b2c3d', t: 'ask' };
    assert.equal(encodeBridgeMsg(ask as unknown as BridgeMsg), BRIDGE_SAMPLES[4]!.wire);
  });

  it('are compact: no whitespace outside strings', () => {
    for (const s of ALL) assert.doesNotMatch(s.wire.replace(/"(?:[^"\\]|\\.)*"/g, '""'), /\s/);
  });

  it('escape the quote and the backslash, and nothing else', () => {
    assert.equal(encodeDeviceMsg({ t: 'say', text: 'a"b\\c' }), '{"t":"say","text":"a\\"b\\\\c"}');
    // Every printable character: the only backslashes in the output are the two escapes
    // the firmware has to understand, and the frame still parses to the same text.
    let all = '';
    for (let c = 0x20; c <= 0x7e; c++) all += String.fromCharCode(c);
    const wire = encodeDeviceMsg({ t: 'say', text: all });
    assert.doesNotMatch(wire.replace(/\\["\\]/g, ''), /\\/);
    assert.equal((JSON.parse(wire) as { text: string }).text, all);
  });

  it('write numbers as plain digits, including the largest', () => {
    assert.equal(encodeDeviceMsg({ t: 'ping', n: INT_MAX }), '{"t":"ping","n":2147483647}');
    assert.equal(encodeDeviceMsg({ t: 'ping', n: 0 }), '{"t":"ping","n":0}');
  });

  it('write booleans as true and false', () => {
    assert.equal(encodeBridgeMsg({ t: 'result', ok: false, text: '' }), '{"t":"result","ok":false,"text":""}');
  });
});

// ---------------------------------------------------------------------------
describe('encoders: refuse what the contract forbids (RangeError)', () => {
  /** Asserts the base encodes (so a refusal below is about the patch alone), then that each patch is refused. */
  function refuseEach(dir: Dir, base: unknown, patches: Array<[string, Record<string, unknown>]>): void {
    assert.doesNotThrow(() => enc(dir, base), 'the base message must be valid');
    for (const [label, patch] of patches) {
      assert.throws(() => enc(dir, { ...(base as object), ...patch }), RangeError, label);
    }
  }

  const BAD_INTS: Array<[string, unknown]> = [
    ['negative', -1], ['fraction', 1.5], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity],
    ['one past int32', INT_MAX + 1], ['-0', -0], ['string', '1'], ['true', true], ['null', null],
    ['undefined', undefined], ['bigint', 1n], ['array', [1]], ['object', {}], ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ];
  const INT_FIELDS: Array<[Dir, object, string]> = [
    ['device', HELLO, 'v'], ['device', HELLO, 'rate'], ['device', HELLO, 'bits'], ['device', HELLO, 'ch'],
    ['device', { t: 'ping', n: 1 }, 'n'],
    ['bridge', { t: 'hello_ack', v: 1, ok: true, sid: 'x' }, 'v'],
    ['bridge', { t: 'hello_ack', v: 1, ok: false, why: 'token' }, 'v'],
    ['bridge', BRIDGE_SAMPLES[2]!.msg, 'seq'], ['bridge', BRIDGE_SAMPLES[2]!.msg, 'pend'],
    ['bridge', BRIDGE_SAMPLES[4]!.msg, 'ttl'], ['bridge', { t: 'pong', n: 1 }, 'n'],
  ];

  it('integers: negative, fractional, non-finite, beyond int32, -0 and every non-number', () => {
    for (const [dir, base, key] of INT_FIELDS) {
      refuseEach(dir, base, BAD_INTS.map(([label, v]) => [`${key} ${label}`, { [key]: v }]));
      // The neighbours of the refused values are accepted: both ends of the range.
      assert.doesNotThrow(() => enc(dir, { ...base, [key]: 0 }), `${key}=0`);
      assert.doesNotThrow(() => enc(dir, { ...base, [key]: INT_MAX }), `${key}=INT_MAX`);
    }
  });

  const BAD_BOOLS: Array<[string, unknown]> = [
    ['"true"', 'true'], ['1', 1], ['0', 0], ['null', null], ['undefined', undefined], ['object', {}], ['""', ''],
  ];
  it('booleans: only true and false', () => {
    const fields: Array<[Dir, object, string]> = [
      ['device', { t: 'ask_rsp', id: '0a1b2c3d', ok: true }, 'ok'],
      ['bridge', { t: 'result', ok: true, text: 'x' }, 'ok'],
    ];
    for (const [dir, base, key] of fields) {
      refuseEach(dir, base, BAD_BOOLS.map(([label, v]) => [`${key} ${label}`, { [key]: v }]));
      assert.doesNotThrow(() => enc(dir, { ...base, [key]: false }));
    }
  });

  const ENUM_FIELDS: Array<[Dir, object, string, readonly string[]]> = [
    ['device', { t: 'listen', m: 'start' }, 'm', ['start', 'stop', 'cancel']],
    ['bridge', BRIDGE_SAMPLES[2]!.msg, 'ph', PHASES],
    ['bridge', BRIDGE_SAMPLES[4]!.msg, 'risk', RISKS],
    ['bridge', BRIDGE_SAMPLES[5]!.msg, 'why', ASK_END_REASONS],
    ['bridge', BRIDGE_SAMPLES[7]!.msg, 'code', ERR_CODES],
    ['bridge', BRIDGE_SAMPLES[1]!.msg, 'why', HELLO_WHYS],
  ];
  it('enums: every member accepted, anything else (case, padding, type) refused', () => {
    for (const [dir, base, key, values] of ENUM_FIELDS) {
      for (const v of values) assert.doesNotThrow(() => enc(dir, { ...base, [key]: v }), `${key}=${v}`);
      const first = values[0]!;
      refuseEach(dir, base, [
        ['unknown', { [key]: 'bogus' }], ['empty', { [key]: '' }], ['upper-case', { [key]: first.toUpperCase() }],
        ['padded', { [key]: ` ${first}` }], ['number', { [key]: 0 }], ['null', { [key]: null }],
        ['undefined', { [key]: undefined }], ['array', { [key]: [first] }],
        ['inherited name', { [key]: 'constructor' }], ['proto name', { [key]: '__proto__' }],
      ]);
    }
  });

  // [direction, valid base, key, min length, max length, a filler character valid for the field]
  const STRING_FIELDS: Array<[Dir, object, string, number, number, string]> = [
    ['device', HELLO, 'token', LIMITS.tokenMin, LIMITS.tokenMax, 'a'],
    ['device', HELLO, 'dev', 0, LIMITS.devMax, 'x'],
    ['device', HELLO, 'fw', 0, LIMITS.fwMax, 'x'],
    ['device', { t: 'say', text: 'x' }, 'text', 0, LIMITS.sayMax, 'x'],
    ['device', { t: 'ask_rsp', id: '0a1b2c3d', ok: true }, 'id', LIMITS.idLen, LIMITS.idLen, '0'],
    ['bridge', { t: 'hello_ack', v: 1, ok: true, sid: 'x' }, 'sid', 0, 64, 'x'],
    ['bridge', BRIDGE_SAMPLES[2]!.msg, 'tl', 0, LIMITS.labelMax, 'x'],
    ['bridge', { t: 'stt', text: 'x' }, 'text', 0, LIMITS.sttMax, 'x'],
    ['bridge', BRIDGE_SAMPLES[4]!.msg, 'id', LIMITS.idLen, LIMITS.idLen, '0'],
    ['bridge', BRIDGE_SAMPLES[4]!.msg, 'tl', 0, LIMITS.labelMax, 'x'],
    ['bridge', BRIDGE_SAMPLES[4]!.msg, 'sum', 0, LIMITS.summaryMax, 'x'],
    ['bridge', BRIDGE_SAMPLES[5]!.msg, 'id', LIMITS.idLen, LIMITS.idLen, '0'],
    ['bridge', BRIDGE_SAMPLES[6]!.msg, 'text', 0, LIMITS.resultMax, 'x'],
    ['bridge', BRIDGE_SAMPLES[7]!.msg, 'msg', 0, LIMITS.errMax, 'x'],
  ];

  it('strings: the cap is inclusive, one over is refused, and so is one under a minimum', () => {
    for (const [dir, base, key, min, max, fill] of STRING_FIELDS) {
      assert.doesNotThrow(() => enc(dir, { ...base, [key]: fill.repeat(max) }), `${key} at max`);
      assert.doesNotThrow(() => enc(dir, { ...base, [key]: fill.repeat(min) }), `${key} at min`);
      assert.throws(() => enc(dir, { ...base, [key]: fill.repeat(max + 1) }), RangeError, `${key} over max`);
      if (min > 0) assert.throws(() => enc(dir, { ...base, [key]: fill.repeat(min - 1) }), RangeError, `${key} under min`);
      for (const v of [undefined, null, 5, true, {}, ['x'], Buffer.from('x')]) {
        assert.throws(() => enc(dir, { ...base, [key]: v }), RangeError, `${key} type`);
      }
    }
  });

  it('strings: anything outside printable ASCII is refused, wherever it sits', () => {
    const unprintable = ['\u00e9', '\u00a0', '\0', '\n', '\r', '\t', '\x1f', '\x7f', '\x80', '\u200b', '\u202e', '\u2028', '\u{1F600}', '\ud800', '\udc00'];
    for (const [dir, base, key, , max, fill] of STRING_FIELDS) {
      for (const bad of unprintable) {
        const s = fill.repeat(Math.min(max, 3));
        for (const v of [bad + s.slice(1), s.slice(0, 1) + bad + s.slice(1, -1) || bad, s.slice(0, -1) + bad]) {
          if (v.length > max) continue;
          assert.throws(() => enc(dir, { ...base, [key]: v }), RangeError, `${key} ${JSON.stringify(v)}`);
        }
      }
    }
    // The companion: the same shapes with printable characters in the same places pass.
    assert.doesNotThrow(() => encodeDeviceMsg({ t: 'say', text: '~ ' }));
  });

  it('the length check does not scan: a huge string is refused at once', () => {
    const t0 = performance.now();
    assert.throws(() => encodeDeviceMsg({ t: 'say', text: '\u00e9'.repeat(20_000_000) }), RangeError);
    assert.ok(performance.now() - t0 < BUDGET_MS);
  });

  it('tokens: only the unreserved characters, A-Z a-z 0-9 . _ ~ -', () => {
    const allowed = /[A-Za-z0-9._~-]/;
    for (let c = 0x20; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      const token = `0123456789abcde${ch}`; // 16 characters with the probe last
      if (allowed.test(ch)) assert.doesNotThrow(() => encodeDeviceMsg({ ...HELLO, token } as DeviceMsg), ch);
      else assert.throws(() => encodeDeviceMsg({ ...HELLO, token } as DeviceMsg), RangeError, ch);
    }
  });

  it('ids: exactly eight lowercase hex digits', () => {
    for (let c = 0x20; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      const id = `0a1b2c3${ch}`;
      const msg = { t: 'ask_rsp', id, ok: true } as DeviceMsg;
      if (/[0-9a-f]/.test(ch)) assert.doesNotThrow(() => encodeDeviceMsg(msg), ch);
      else assert.throws(() => encodeDeviceMsg(msg), RangeError, ch);
    }
    for (const id of ['', '0a1b2c3', '0a1b2c3d4', '0A1B2C3D', '0a1b 2c3']) {
      assert.throws(() => encodeDeviceMsg({ t: 'ask_rsp', id, ok: true }), RangeError, id);
    }
  });

  it('structure: not an object, unknown or missing type', () => {
    for (const v of [null, undefined, 5, 'x', true, [], [DEVICE_SAMPLES[1]!.msg], () => 1]) {
      assert.throws(() => encodeDeviceMsg(v as unknown as DeviceMsg), RangeError);
      assert.throws(() => encodeBridgeMsg(v as unknown as BridgeMsg), RangeError);
    }
    for (const t of ['nope', '', 'HELLO', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 5, null, undefined]) {
      assert.throws(() => encodeDeviceMsg({ t } as unknown as DeviceMsg), RangeError, String(t));
      assert.throws(() => encodeBridgeMsg({ t } as unknown as BridgeMsg), RangeError, String(t));
    }
    // A message of the other direction is just an unknown type to this encoder.
    assert.throws(() => encodeDeviceMsg(BRIDGE_SAMPLES[8]!.msg as unknown as DeviceMsg), RangeError);
    assert.throws(() => encodeBridgeMsg(DEVICE_SAMPLES[8]!.msg as unknown as BridgeMsg), RangeError);
  });

  it('structure: a missing key and an extra key are both refused, for every type', () => {
    for (const { dir, msg } of ALL) {
      const rec = msg as unknown as Record<string, unknown>;
      assert.doesNotThrow(() => enc(dir, rec));
      for (const key of Object.keys(rec).filter((k) => k !== 't')) {
        const { [key]: _gone, ...without } = rec;
        // The reason names the key: "missing key text" is a bug found, "text: not a string" is a puzzle.
        // The one exception is the hello_ack discriminator, which has to be read before any key can be required.
        const named = (e: unknown): boolean =>
          e instanceof RangeError && (e.message.includes(`missing key ${key}`) || (msg.t === 'hello_ack' && key === 'ok' && e.message.includes('hello_ack.ok')));
        assert.throws(() => enc(dir, without), named, `${msg.t} without ${key}`);
        // And a message with the wrong key swapped in for the right one is still short a key.
        assert.throws(() => enc(dir, { ...without, other: 1 }), named, `${msg.t} ${key} replaced`);
      }
      assert.throws(() => enc(dir, { ...rec, extra: 1 }), RangeError, `${msg.t} with extra`);
      assert.throws(() => enc(dir, { ...rec, __proto__x: 1 }), RangeError, `${msg.t} with __proto__x`);
    }
    // Even an extra key whose value is undefined is a key.
    assert.throws(() => encodeDeviceMsg({ t: 'abort', x: undefined } as unknown as DeviceMsg), RangeError);
  });

  it('hello_ack: each form takes its own key and the discriminator must be a real boolean', () => {
    assert.throws(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, ok: true, why: 'token' } as unknown as BridgeMsg), RangeError);
    assert.throws(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, ok: false, sid: 'x' } as unknown as BridgeMsg), RangeError);
    assert.throws(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, ok: true, sid: 'x', why: 'token' } as unknown as BridgeMsg), RangeError);
    assert.throws(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, sid: 'x' } as unknown as BridgeMsg), RangeError);
    for (const ok of ['true', 1, null, undefined, 'false', 0]) {
      assert.throws(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, ok, sid: 'x' } as unknown as BridgeMsg), RangeError, String(ok));
    }
    assert.doesNotThrow(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, ok: true, sid: '' }));
    for (const why of HELLO_WHYS) assert.doesNotThrow(() => encodeBridgeMsg({ t: 'hello_ack', v: 1, ok: false, why }));
  });

  it('the error never repeats the offending value (it can be model output)', () => {
    const marker = 'SECRETMARKER';
    const cases: Array<() => unknown> = [
      () => encodeDeviceMsg({ t: 'say', text: marker + 'x'.repeat(LIMITS.sayMax) }),
      () => encodeDeviceMsg({ t: 'say', text: marker + '\u00e9' }),
      () => encodeBridgeMsg({ t: 'state', seq: 1, ph: marker as never, tl: '', pend: 0 }),
      () => encodeBridgeMsg({ t: marker, a: 1 } as unknown as BridgeMsg),
      () => encodeBridgeMsg({ t: 'pong', n: 1, [marker]: 1 } as unknown as BridgeMsg),
    ];
    for (const run of cases) {
      assert.throws(run, (e: unknown) => {
        assert.ok(e instanceof RangeError);
        assert.doesNotMatch(e.message, new RegExp(marker));
        assert.ok(e.message.length < 80, e.message);
        return true;
      });
    }
  });

  it('a frame over the direction\'s limit is refused, and each direction uses its own limit', () => {
    const state: BridgeMsg = BRIDGE_SAMPLES[2]!.msg;
    const say: DeviceMsg = { t: 'say', text: 'hello there' };
    const need = (s: string): number => bytes(s);
    assert.doesNotThrow(() => withLimit('bridgeFrameMax', need(encodeBridgeMsg(state)), () => encodeBridgeMsg(state)), 'exactly at the limit');
    assert.throws(() => withLimit('bridgeFrameMax', need(encodeBridgeMsg(state)) - 1, () => encodeBridgeMsg(state)), RangeError, 'one byte over');
    assert.doesNotThrow(() => withLimit('deviceFrameMax', need(encodeDeviceMsg(say)), () => encodeDeviceMsg(say)), 'exactly at the limit');
    assert.throws(() => withLimit('deviceFrameMax', need(encodeDeviceMsg(say)) - 1, () => encodeDeviceMsg(say)), RangeError, 'one byte over');
    // Swapped limits would pass both of the above: lowering the OTHER limit must not matter.
    assert.doesNotThrow(() => withLimit('deviceFrameMax', 1, () => encodeBridgeMsg(state)));
    assert.doesNotThrow(() => withLimit('bridgeFrameMax', 1, () => encodeDeviceMsg(say)));
  });

  it('the largest message the limits allow still fits the frame (so the guard above guards nothing reachable today)', () => {
    const worst = [
      encodeDeviceMsg({ t: 'say', text: '"'.repeat(LIMITS.sayMax) }),
      encodeDeviceMsg({ t: 'hello', v: INT_MAX, token: 'a'.repeat(LIMITS.tokenMax), dev: '"'.repeat(LIMITS.devMax), fw: '"'.repeat(LIMITS.fwMax), rate: INT_MAX, bits: INT_MAX, ch: INT_MAX }),
    ];
    for (const w of worst) assert.ok(bytes(w) <= LIMITS.deviceFrameMax);
    const bridgeWorst = [
      encodeBridgeMsg({ t: 'ask', id: 'ffffffff', tl: '"'.repeat(LIMITS.labelMax), risk: 'high', sum: '"'.repeat(LIMITS.summaryMax), ttl: INT_MAX }),
      encodeBridgeMsg({ t: 'result', ok: false, text: '"'.repeat(LIMITS.resultMax) }),
      encodeBridgeMsg({ t: 'stt', text: '"'.repeat(LIMITS.sttMax) }),
    ];
    for (const w of bridgeWorst) assert.ok(bytes(w) <= LIMITS.bridgeFrameMax);
  });
});

// ---------------------------------------------------------------------------
describe('decoders: accept', () => {
  it('decode every sample to the message it came from, with keys in wire order', () => {
    for (const { dir, msg, wire } of ALL) {
      const r = dec(dir, wire);
      assert.ok(r.ok, wire);
      if (!r.ok) continue;
      assert.deepEqual(r.msg, msg);
      assert.deepEqual(Object.keys(r.msg), Object.keys(msg), 'decoded keys follow the layout, not the input');
    }
  });

  it('read RFC 8259 whitespace between tokens', () => {
    for (const { dir, msg, wire } of ALL) {
      const pretty = JSON.stringify(JSON.parse(wire), null, 2);
      assert.deepEqual(dec(dir, pretty), { ok: true, msg }, pretty);
      assert.deepEqual(dec(dir, ` \t\r\n${wire} \t\r\n`), { ok: true, msg });
    }
  });

  it('do not care what order the keys arrive in', () => {
    for (const { dir, msg, wire } of ALL) {
      const entries = Object.entries(JSON.parse(wire) as Record<string, unknown>).reverse();
      const reversed = JSON.stringify(Object.fromEntries(entries));
      const r = dec(dir, reversed);
      assert.deepEqual(r, { ok: true, msg }, reversed);
      // The result is built from the layout, so its keys come out in wire order regardless.
      if (r.ok) assert.deepEqual(Object.keys(r.msg), Object.keys(msg), reversed);
    }
  });

  it('understand every JSON string escape, and keep the result if it is printable', () => {
    const r = decodeDeviceMsg('{"t":"say","text":"\\u0041\\u007e\\/\\"\\\\ \\u0020"}');
    assert.deepEqual(r, { ok: true, msg: { t: 'say', text: 'A~/"\\  ' } });
    const hex = decodeDeviceMsg('{"t":"ask_rsp","id":"0a1b2c3d","ok":true}'.replace('0a1b2c3d', '\\u0030a1b2c3d'));
    assert.deepEqual(hex, { ok: true, msg: { t: 'ask_rsp', id: '0a1b2c3d', ok: true } });
    const upper = decodeDeviceMsg('{"t":"say","text":"\\u004A\\u004a"}');
    assert.deepEqual(upper, { ok: true, msg: { t: 'say', text: 'JJ' } });
  });

  it('keep a field whose VALUE is a name that is special to JavaScript (only keys are dangerous)', () => {
    for (const text of ['__proto__', 'constructor', 'toString', 'prototype', 'hasOwnProperty']) {
      assert.deepEqual(decodeDeviceMsg(`{"t":"say","text":"${text}"}`), { ok: true, msg: { t: 'say', text } });
    }
    const r = decodeDeviceMsg('{"t":"hello","v":1,"token":"0123456789abcdef","dev":"__proto__","fw":"constructor","rate":16000,"bits":16,"ch":1}');
    assert.ok(r.ok);
    if (r.ok && r.msg.t === 'hello') assert.deepEqual([r.msg.dev, r.msg.fw], ['__proto__', 'constructor']);
  });

  it('return plain objects that nobody else shares', () => {
    const a = decodeDeviceMsg('{"t":"abort"}');
    const b = decodeDeviceMsg('{"t":"abort"}');
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.msg, b.msg);
    assert.equal(Object.getPrototypeOf(a.msg), Object.prototype);
  });

  it('take a frame of exactly the limit and refuse one byte more, in each direction', () => {
    const cases: Array<[Dir, string, number]> = [
      ['device', '{"t":"say","text":"hi"}', LIMITS.deviceFrameMax],
      ['bridge', '{"t":"pong","n":1}', LIMITS.bridgeFrameMax],
    ];
    for (const [dir, body, limit] of cases) {
      const atLimit = body + ' '.repeat(limit - bytes(body));
      assert.equal(bytes(atLimit), limit);
      assert.ok(dec(dir, atLimit).ok, `${dir} at limit`);
      refused(dec(dir, atLimit + ' '), /frame too big/, `${dir} one over`);
    }
    // Each direction answers to its own limit.
    withLimit('deviceFrameMax', 10, () => assert.ok(decodeBridgeMsg('{"t":"pong","n":1}').ok));
    withLimit('bridgeFrameMax', 10, () => assert.ok(decodeDeviceMsg('{"t":"say","text":"hi"}').ok));
    withLimit('deviceFrameMax', 10, () => refused(decodeDeviceMsg('{"t":"say","text":"hi"}'), /frame too big/));
    withLimit('bridgeFrameMax', 10, () => refused(decodeBridgeMsg('{"t":"pong","n":1}'), /frame too big/));
  });

  it('measure the limit in UTF-8 bytes, not characters', () => {
    // 400 two-byte characters is 400 characters, under the limit, but 800 bytes of text
    // plus the envelope; 600 of them crosses the limit while still being 600 characters.
    const small = `{"t":"say","text":"${'\u00e9'.repeat(300)}"}`;
    assert.ok(small.length < LIMITS.deviceFrameMax && bytes(small) < LIMITS.deviceFrameMax);
    refused(decodeDeviceMsg(small), /say.text: not printable ascii/, 'under the limit: refused for its content');
    const big = `{"t":"say","text":"${'\u00e9'.repeat(600)}"}`;
    assert.ok(big.length < LIMITS.deviceFrameMax && bytes(big) > LIMITS.deviceFrameMax);
    refused(decodeDeviceMsg(big), /frame too big/, 'under the limit in characters, over it in bytes');
  });
});

// ---------------------------------------------------------------------------
describe('decoders: refuse', () => {
  it('anything that is not a string, without throwing', () => {
    const hostile = [undefined, null, 5, 1n, true, {}, [], ['{"t":"abort"}'], Buffer.from('{"t":"abort"}'), new Uint8Array(3), Symbol('s'), () => 1, new String('{"t":"abort"}')];
    for (const v of hostile) {
      refused(dec('device', v), /not text/, String(typeof v));
      refused(dec('bridge', v), /not text/, String(typeof v));
    }
  });

  it('JSON that is not an object', () => {
    for (const raw of ['', ' ', 'null', 'true', 'false', '0', '-0', '1e999', '"{}"', '[]', '[{"t":"abort"}]', '[[[[]]]]', 'abort', '}', 'undefined', 'NaN', '\u0000', '\ufeff{"t":"abort"}']) {
      refused(decodeDeviceMsg(raw), /not a json object/, JSON.stringify(raw));
    }
  });

  it('broken or unusual object syntax', () => {
    const cases: Array<[string, RegExp]> = [
      ['{', /bad json/],
      ['{"t":"abort"', /bad json/],
      ['{"t":"abort",}', /bad json/],
      ['{,"t":"abort"}', /bad json/],
      ['{"t""abort"}', /bad json/],
      ['{"t":"abort" "x":1}', /bad json/],
      ['{t:"abort"}', /bad json/],
      ["{'t':'abort'}", /bad json/],
      ['{"t":"abort"}}', /trailing data/],
      ['{"t":"abort"} {', /trailing data/],
      ['{"t":"abort"}\u0000', /trailing data/],
      ['{"t":"abort"} // note', /trailing data/],
      ['{"t":"ab\\ort"}', /bad string/],
      ['{"t":"abo\\u00zzrt"}', /bad string/],
      ['{"t":"abo\\u12"}', /bad string/],
      ['{"t":"abort}', /bad string/],
      ['{"t":"abo\nrt"}', /bad string/],
      ['{"t":"abo\trt"}', /bad string/],
      ['{"t":"abort","k', /bad string/],
    ];
    for (const [raw, re] of cases) refused(decodeDeviceMsg(raw), re, raw);
  });

  it('nested values, however deep, without recursing', () => {
    const t0 = performance.now();
    refused(decodeDeviceMsg('{"t":"say","text":{}}'), /nested value/);
    refused(decodeDeviceMsg('{"t":"say","text":[]}'), /nested value/);
    refused(decodeDeviceMsg(`{"t":"say","text":${'['.repeat(500)}}`), /nested value/);
    refused(decodeDeviceMsg(`{"a":${'{"a":'.repeat(150)}`), /nested value/);
    // Beyond the frame limit the size guard answers first; the point is that neither path overflows the stack.
    refused(decodeDeviceMsg('['.repeat(1_000_000)), /frame too big/);
    refused(decodeDeviceMsg(`{"t":"say","text":${'['.repeat(1_000_000)}`), /frame too big/);
    assert.ok(performance.now() - t0 < BUDGET_MS);
  });

  it('a huge input is refused without being read', () => {
    const t0 = performance.now();
    refused(decodeDeviceMsg('x'.repeat(20_000_000)), /frame too big/);
    refused(decodeBridgeMsg(' '.repeat(20_000_000) + '{"t":"pong","n":1}'), /frame too big/);
    refused(decodeDeviceMsg('{"t":"say","text":"' + 'a'.repeat(20_000_000) + '"}'), /frame too big/);
    assert.ok(performance.now() - t0 < BUDGET_MS);
  });

  it('duplicate keys, even when the values agree, and even for t', () => {
    const cases = [
      '{"t":"ask_rsp","id":"0a1b2c3d","ok":false,"ok":true}',
      '{"t":"ask_rsp","id":"0a1b2c3d","ok":true,"ok":false}',
      '{"t":"ping","n":1,"n":1}',
      '{"t":"abort","t":"abort"}',
      '{"t":"ping","n":1,"\\u006e":2}', // the same key spelled with an escape
    ];
    for (const raw of cases) refused(decodeDeviceMsg(raw), /duplicate key/, raw);
    // And the neighbour: the same message once is fine.
    assert.ok(decodeDeviceMsg('{"t":"ask_rsp","id":"0a1b2c3d","ok":false}').ok);
  });

  it('unknown types, including names JavaScript objects carry', () => {
    for (const t of ['nope', '', 'HELLO', 'hello ', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      refused(decodeDeviceMsg(`{"t":"${t}"}`), /unknown type/, t);
      refused(decodeBridgeMsg(`{"t":"${t}"}`), /unknown type/, t);
    }
    refused(decodeDeviceMsg('{"x":1}'), /missing key: t/);
    refused(decodeDeviceMsg('{}'), /missing key: t/);
    for (const t of ['5', 'null', 'true', '["hello"]'.slice(0, 0) + '{}', '[]']) {
      refused(decodeDeviceMsg(`{"t":${t}}`), /t: not a string|nested value/, t);
    }
    refused(decodeDeviceMsg('{"t":"pong","n":1}'), /unknown type/, 'a bridge type from a device');
    refused(decodeBridgeMsg('{"t":"ping","n":1}'), /unknown type/, 'a device type from the bridge');
  });

  it('a missing key, for every field of every type', () => {
    for (const { dir, msg } of ALL) {
      for (const key of Object.keys(msg).filter((k) => k !== 't')) {
        const copy = { ...(msg as unknown as Record<string, unknown>) };
        delete copy[key];
        refused(dec(dir, JSON.stringify(copy)), /missing key|hello_ack.ok/, `${msg.t} without ${key}`);
      }
    }
  });

  it('an extra key, for every type, including the ones JavaScript treats specially', () => {
    for (const { dir, msg } of ALL) {
      for (const key of ['x', 'T', 'constructor', 'prototype', 'toString', '', ' ']) {
        const raw = JSON.stringify({ ...(msg as unknown as object), [key]: 1 });
        refused(dec(dir, raw), /extra key/, `${msg.t} + ${JSON.stringify(key)}`);
      }
      // __proto__ cannot be added with spread (it would set the prototype), so write it out.
      const raw = DEVICE_SAMPLES.concat(BRIDGE_SAMPLES as never).find((s) => s.msg === msg)!.wire;
      refused(dec(dir, `${raw.slice(0, -1)},"__proto__":1}`), /extra key/, `${msg.t} + __proto__`);
    }
  });

  it('__proto__ cannot reach any object, as a key or as a nested value', () => {
    const deviceAttacks = [
      '{"__proto__":{"polluted":true},"t":"abort"}',
      '{"t":"abort","__proto__":{"polluted":true}}',
      '{"t":"say","text":"hi","__proto__":{"text":"evil"}}',
      '{"t":"say","text":"hi","__proto__":"x"}',
      '{"t":"say","text":"hi","constructor":{"prototype":{"polluted":true}}}',
      '{"__proto__":1,"t":"abort"}',
    ];
    const bridgeAttacks = [
      '{"t":"hello_ack","v":1,"ok":true,"sid":"x","__proto__":null}',
      '{"t":"pong","n":1,"__proto__":{"polluted":true}}',
      '{"__proto__":{"t":"pong"},"t":"pong","n":1}',
    ];
    for (const raw of deviceAttacks) refused(decodeDeviceMsg(raw), /nested value|extra key/, raw);
    for (const raw of bridgeAttacks) refused(decodeBridgeMsg(raw), /nested value|extra key/, raw);
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
    assert.equal(Object.getPrototypeOf(Object.prototype), null);
    // A member NAMED __proto__ did not become a field of a decoded message either.
    const ok = decodeDeviceMsg('{"t":"say","text":"hi"}');
    assert.ok(ok.ok);
    if (ok.ok) assert.equal(Object.hasOwn(ok.msg, '__proto__'), false);
  });

  it('numbers: only canonical non-negative decimal integers up to int32', () => {
    const bad = ['-0', '-1', '1.0', '1.5', '1e2', '1E2', '1e999', '-1e999', '+1', '01', '00', '0x10', '1_000', '.5', '5.', '1e', 'NaN', 'Infinity', '-Infinity', '99999999999999999999', '1' + '0'.repeat(400), ''];
    for (const n of bad) {
      refused(decodeDeviceMsg(`{"t":"ping","n":${n}}`), /bad number|bad json/, n.slice(0, 20));
    }
    refused(decodeDeviceMsg(`{"t":"ping","n":${INT_MAX + 1}}`), /ping.n: out of range/);
    refused(decodeDeviceMsg('{"t":"ping","n":4294967296}'), /ping.n: out of range/);
    refused(decodeDeviceMsg('{"t":"ping","n":999999999999999}'), /ping.n: out of range/);
    // The edges that ARE valid.
    assert.deepEqual(decodeDeviceMsg('{"t":"ping","n":0}'), { ok: true, msg: { t: 'ping', n: 0 } });
    assert.deepEqual(decodeDeviceMsg(`{"t":"ping","n":${INT_MAX}}`), { ok: true, msg: { t: 'ping', n: INT_MAX } });
  });

  it('values of the wrong JSON type, for every field of every type', () => {
    const wrong: Array<[string, unknown]> = [['null', null], ['true', true], ['false', false], ['number', 5], ['array', ['x']], ['object', { a: 1 }]];
    for (const { dir, msg } of ALL) {
      for (const key of Object.keys(msg).filter((k) => k !== 't')) {
        const original = (msg as unknown as Record<string, unknown>)[key];
        for (const [label, v] of wrong) {
          if (typeof v === typeof original && !Array.isArray(v) && v !== null && typeof v !== 'object') continue; // same JSON type: not a type error
          const raw = JSON.stringify({ ...(msg as unknown as object), [key]: v });
          refused(dec(dir, raw), /not a (number|string|boolean)|nested value/, `${msg.t}.${key} = ${label}`);
        }
      }
    }
  });

  it('strings: caps, minimums, charsets and printable ASCII, on the wire as well as in the encoder', () => {
    for (const [dir, base, key, min, max, fill] of [
      ['device', HELLO, 'token', LIMITS.tokenMin, LIMITS.tokenMax, 'a'],
      ['device', HELLO, 'dev', 0, LIMITS.devMax, 'x'],
      ['device', HELLO, 'fw', 0, LIMITS.fwMax, 'x'],
      ['device', { t: 'say', text: 'x' }, 'text', 0, LIMITS.sayMax, 'x'],
      ['device', { t: 'ask_rsp', id: '0a1b2c3d', ok: true }, 'id', LIMITS.idLen, LIMITS.idLen, '0'],
      ['bridge', { t: 'hello_ack', v: 1, ok: true, sid: 'x' }, 'sid', 0, 64, 'x'],
      ['bridge', BRIDGE_SAMPLES[2]!.msg, 'tl', 0, LIMITS.labelMax, 'x'],
      ['bridge', { t: 'stt', text: 'x' }, 'text', 0, LIMITS.sttMax, 'x'],
      ['bridge', BRIDGE_SAMPLES[4]!.msg, 'sum', 0, LIMITS.summaryMax, 'x'],
      ['bridge', BRIDGE_SAMPLES[5]!.msg, 'id', LIMITS.idLen, LIMITS.idLen, '0'],
      ['bridge', BRIDGE_SAMPLES[6]!.msg, 'text', 0, LIMITS.resultMax, 'x'],
      ['bridge', BRIDGE_SAMPLES[7]!.msg, 'msg', 0, LIMITS.errMax, 'x'],
    ] as Array<[Dir, object, string, number, number, string]>) {
      const wire = (v: string): string => JSON.stringify({ ...base, [key]: v });
      assert.ok(dec(dir, wire(fill.repeat(max))).ok, `${key} at max`);
      assert.ok(dec(dir, wire(fill.repeat(min))).ok, `${key} at min`);
      refused(dec(dir, wire(fill.repeat(max + 1))), /too long/, `${key} over max`);
      if (min > 0) refused(dec(dir, wire(fill.repeat(min - 1))), /too short/, `${key} under min`);
      for (const bad of ['\u00e9', '\0', '\n', '\x1f', '\x7f', '\x80', '\u200b', '\u202e', '\u{1F600}', '\ud800']) {
        // Padded up to the minimum so only the character is wrong, and no longer than the cap.
        const probe = fill.repeat(Math.max(min, bad.length) - bad.length) + bad;
        refused(dec(dir, wire(probe)), /not printable ascii/, `${key} ${JSON.stringify(bad)}`);
      }
    }
  });

  it('a lone surrogate that is really in the string (not an escape) is refused, not thrown on', () => {
    refused(decodeDeviceMsg('{"t":"say","text":"a\ud800b"}'), /not printable ascii/);
    refused(decodeDeviceMsg('{"t":"say","text":"a\udc00b"}'), /not printable ascii/);
    refused(decodeDeviceMsg('\ud800'), /not a json object/);
    refused(decodeDeviceMsg('{"t":"say","text":"\ud83d"}'), /not printable ascii/);
  });

  it('tokens: only the unreserved characters', () => {
    const allowed = /[A-Za-z0-9._~-]/;
    for (let c = 0x20; c <= 0x7e; c++) {
      const ch = String.fromCharCode(c);
      const raw = JSON.stringify({ ...HELLO, token: `0123456789abcde${ch}` });
      if (allowed.test(ch)) assert.ok(decodeDeviceMsg(raw).ok, ch);
      else refused(decodeDeviceMsg(raw), /bad characters/, ch);
    }
  });

  it('ids: eight lowercase hex digits, in every message that carries one', () => {
    const carriers: Array<[Dir, object]> = [
      ['device', { t: 'ask_rsp', id: '0a1b2c3d', ok: true }],
      ['bridge', BRIDGE_SAMPLES[4]!.msg],
      ['bridge', BRIDGE_SAMPLES[5]!.msg],
    ];
    for (const [dir, base] of carriers) {
      for (let c = 0x20; c <= 0x7e; c++) {
        const ch = String.fromCharCode(c);
        const raw = JSON.stringify({ ...base, id: `0a1b2c3${ch}` });
        if (/[0-9a-f]/.test(ch)) assert.ok(dec(dir, raw).ok, ch);
        else refused(dec(dir, raw), /bad characters/, ch);
      }
      for (const id of ['', '0a1b2c3', '0a1b2c3d4']) {
        refused(dec(dir, JSON.stringify({ ...base, id })), /too (short|long)/, id);
      }
    }
  });

  it('enums: exact members only', () => {
    const fields: Array<[Dir, object, string, readonly string[]]> = [
      ['device', { t: 'listen', m: 'start' }, 'm', ['start', 'stop', 'cancel']],
      ['bridge', BRIDGE_SAMPLES[2]!.msg, 'ph', PHASES],
      ['bridge', BRIDGE_SAMPLES[4]!.msg, 'risk', RISKS],
      ['bridge', BRIDGE_SAMPLES[5]!.msg, 'why', ASK_END_REASONS],
      ['bridge', BRIDGE_SAMPLES[7]!.msg, 'code', ERR_CODES],
      ['bridge', BRIDGE_SAMPLES[1]!.msg, 'why', HELLO_WHYS],
    ];
    for (const [dir, base, key, values] of fields) {
      for (const v of values) assert.ok(dec(dir, JSON.stringify({ ...base, [key]: v })).ok, `${key}=${v}`);
      for (const v of ['bogus', '', values[0]!.toUpperCase(), ` ${values[0]}`, `${values[0]} `, 'constructor', '__proto__', 'toString']) {
        refused(dec(dir, JSON.stringify({ ...base, [key]: v })), /not an allowed value/, `${key}=${v}`);
      }
    }
  });

  it('hello_ack: the discriminator picks the shape, and must be a boolean', () => {
    refused(decodeBridgeMsg('{"t":"hello_ack","v":1,"ok":true,"why":"token"}'), /missing key: sid/);
    refused(decodeBridgeMsg('{"t":"hello_ack","v":1,"ok":false,"sid":"x"}'), /missing key: why/);
    refused(decodeBridgeMsg('{"t":"hello_ack","v":1,"ok":true,"sid":"x","why":"token"}'), /extra key/);
    refused(decodeBridgeMsg('{"t":"hello_ack","v":1,"ok":false,"sid":"x","why":"token"}'), /extra key/);
    for (const ok of ['"true"', '1', '0', 'null', '"false"']) {
      refused(decodeBridgeMsg(`{"t":"hello_ack","v":1,"ok":${ok},"sid":"x"}`), /hello_ack.ok: not a boolean/, ok);
    }
    refused(decodeBridgeMsg('{"t":"hello_ack","v":1,"sid":"x"}'), /hello_ack.ok: not a boolean/);
    assert.ok(decodeBridgeMsg('{"t":"hello_ack","v":1,"ok":true,"sid":""}').ok, 'an empty sid is shape-valid');
  });

  it('every failure reason is short printable ASCII and never repeats hostile input', () => {
    const marker = 'SECRETMARKER';
    const raws = [
      `{"t":"say","text":"${marker}\u00e9"}`,
      `{"t":"say","text":"${marker}","${marker}":1}`,
      `{"t":"${marker}"}`,
      `{"t":"listen","m":"${marker}"}`,
      `{"t":"ping","n":${marker}}`,
      `{"${marker}":1,"${marker}":2}`,
      `{"t":"say","text":"${marker}${'x'.repeat(500)}"}`,
      `${marker}`,
    ];
    for (const raw of raws) {
      const r = decodeDeviceMsg(raw);
      assert.equal(r.ok, false, raw);
      if (r.ok) continue;
      assert.doesNotMatch(r.msg, new RegExp(marker), raw);
      assert.ok(r.msg.length <= LIMITS.errMax && isPrintableAscii(r.msg), r.msg);
    }
  });
});

// ---------------------------------------------------------------------------
describe('decoders and encoders agree', () => {
  /** Tiny deterministic PRNG so a failure is reproducible from its seed. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * The invariant behind the whole file: whatever a decoder accepts, the matching
   * encoder accepts too, and the bytes then decode to the same message. If it ever
   * broke, one side would be stricter than the other and a peer could send us a
   * message we could not send back (or the reverse). It also pins that an accepted
   * frame is pure 7-bit ASCII, which is what lets a firmware parser skip UTF-8.
   */
  function checkInvariant(dir: Dir, raw: string): 'accepted' | 'refused' {
    let r: DecodeResult<DeviceMsg | BridgeMsg>;
    try {
      r = dec(dir, raw);
    } catch (e) {
      assert.fail(`decoder threw on ${JSON.stringify(raw.slice(0, 80))}: ${String(e)}`);
    }
    if (!r.ok) {
      assert.equal(r.code, 'bad_msg');
      assert.ok(r.msg.length <= LIMITS.errMax && isPrintableAscii(r.msg), `bad reason ${JSON.stringify(r.msg)}`);
      return 'refused';
    }
    assert.match(raw, /^[\x00-\x7f]*$/, 'accepted a frame containing non-ASCII bytes');
    assert.equal(Object.keys(r.msg)[0], 't');
    const again = enc(dir, r.msg);
    assert.deepEqual(dec(dir, again), r, `re-decode of ${again}`);
    return 'accepted';
  }

  it('whatever the decoder accepts, the encoder re-encodes identically (mutating every sample)', () => {
    const rand = rng(1);
    let accepted = 0;
    let refusedCount = 0;
    const junk = ['"', '\\', '{', '}', '[', ']', ',', ':', ' ', '\n', '0', '9', '-', 'e', 'x', '\u00e9', '\ud800', '\u0000', '"t"', 'null', '__proto__'];
    for (const { dir, wire } of ALL) {
      for (let pos = 0; pos <= wire.length; pos++) {
        // delete one character, and insert one of several nasty ones at each position
        for (const variant of [wire.slice(0, pos) + wire.slice(pos + 1), ...Array.from({ length: 3 }, () => wire.slice(0, pos) + junk[Math.floor(rand() * junk.length)]! + wire.slice(pos))]) {
          if (checkInvariant(dir, variant) === 'accepted') accepted++;
          else refusedCount++;
        }
      }
    }
    // The loop must have exercised BOTH outcomes, or "accepted implies re-encodable" is vacuous.
    assert.ok(accepted > 20, `only ${accepted} mutants were accepted`);
    assert.ok(refusedCount > 1000, `only ${refusedCount} mutants were refused`);
  });

  it('survives random token soup in both directions', () => {
    const rand = rng(2);
    const tokens = ['{', '}', '[', ']', '"', '\\', '"t"', '"ping"', '"say"', '"text"', '"n"', '"ok"', '"id"', '"hello_ack"', '"state"', '"seq"', ':', ',', ' ', '\n', '\t', '1', '0', '-', '+', '.', 'e', 'E', '9', '99999999999', 'true', 'false', 'null', 'NaN', '\\u00', '\\u0041', '\\ud800', '\\n', '\u00e9', '\u0000', '\ud800', '__proto__', '"constructor"', '{"t":"ping","n":', '{"t":"say","text":"', '{"t":"abort"}', '{"t":"ping","n":1}', '{"t":"pong","n":1}'];
    let accepted = 0;
    for (let i = 0; i < 20000; i++) {
      let raw = '';
      const n = 1 + Math.floor(rand() * 30);
      for (let k = 0; k < n; k++) raw += tokens[Math.floor(rand() * tokens.length)]!;
      for (const dir of ['device', 'bridge'] as const) if (checkInvariant(dir, raw) === 'accepted') accepted++;
    }
    assert.ok(accepted > 0, 'the soup never produced a valid frame, so it never reached the deeper checks');
  });

  it('round-trips random printable text through both directions (escaping is lossless)', () => {
    const rand = rng(3);
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const n = Math.floor(rand() * (LIMITS.summaryMax + 1));
      for (let k = 0; k < n; k++) text += String.fromCharCode(0x20 + Math.floor(rand() * 95));
      const wire = encodeBridgeMsg({ t: 'ask', id: '0a1b2c3d', tl: 'Bash', risk: 'low', sum: text, ttl: 1 });
      const back = decodeBridgeMsg(wire);
      assert.ok(back.ok && back.msg.t === 'ask' && back.msg.sum === text, JSON.stringify(text));
      // and the scanner agrees with the platform parser on what the frame means
      assert.equal((JSON.parse(wire) as { sum: string }).sum, text);
    }
  });

  it('mutating every field of every sample with hostile values never throws, and accepted results re-encode', () => {
    const values: unknown[] = [null, true, false, 0, -1, 1.5, INT_MAX, INT_MAX + 1, 1e21, '', 'x', '0a1b2c3d', 'start', 'idle', '\u00e9', '"', '\\', 'a'.repeat(500), [], {}, [1], { a: 1 }];
    for (const { dir, msg } of ALL) {
      for (const key of Object.keys(msg).filter((k) => k !== 't')) {
        for (const v of values) {
          checkInvariant(dir, JSON.stringify({ ...(msg as unknown as object), [key]: v }));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
describe('audio frames', () => {
  const pcm = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 0xff);

  it('encode as [kind][pcm], byte for byte', () => {
    assert.deepEqual(encodeAudioFrame(FRAME_KIND_MIC, Uint8Array.from([0x34, 0x12])), Uint8Array.from([0x01, 0x34, 0x12]));
    assert.deepEqual(encodeAudioFrame(FRAME_KIND_TTS, Uint8Array.from([0xff, 0x7f, 0x00, 0x80])), Uint8Array.from([0x02, 0xff, 0x7f, 0x00, 0x80]));
    assert.equal(FRAME_KIND_MIC, 1);
    assert.equal(FRAME_KIND_TTS, 2);
  });

  it('round-trip at 2 bytes, a typical 20 ms frame and the maximum', () => {
    for (const kind of [FRAME_KIND_MIC, FRAME_KIND_TTS]) {
      for (const len of [2, 4, 320, 640, 1278, LIMITS.audioPayloadMax]) {
        const frame = encodeAudioFrame(kind, pcm(len));
        assert.equal(frame.length, len + 1);
        const r = decodeAudioFrame(frame);
        assert.ok(r.ok);
        if (r.ok) {
          assert.equal(r.msg.kind, kind);
          assert.deepEqual(r.msg.pcm, pcm(len));
        }
      }
    }
  });

  it('encoder: refuses an unknown kind, no samples, a torn sample, too much, and non-bytes', () => {
    assert.doesNotThrow(() => encodeAudioFrame(FRAME_KIND_MIC, pcm(2)));
    for (const kind of [0, 3, 4, 0x80, 0xff, -1, 1.5, NaN, 256, 257, '1' as unknown as number, undefined as unknown as number]) {
      assert.throws(() => encodeAudioFrame(kind, pcm(2)), RangeError, `kind ${String(kind)}`);
    }
    assert.throws(() => encodeAudioFrame(FRAME_KIND_MIC, new Uint8Array(0)), RangeError, 'empty');
    for (const len of [1, 3, 639, LIMITS.audioPayloadMax - 1]) {
      assert.throws(() => encodeAudioFrame(FRAME_KIND_MIC, pcm(len)), RangeError, `odd ${len}`);
    }
    for (const len of [LIMITS.audioPayloadMax + 1, LIMITS.audioPayloadMax + 2, 4096]) {
      assert.throws(() => encodeAudioFrame(FRAME_KIND_MIC, pcm(len)), RangeError, `len ${len}`);
    }
    for (const v of [null, undefined, 'ab', [1, 2], new ArrayBuffer(2), new Uint16Array(1), {}]) {
      assert.throws(() => encodeAudioFrame(FRAME_KIND_MIC, v as unknown as Uint8Array), RangeError);
    }
  });

  it('encoder: accepts a Buffer and a subarray view, and copies rather than aliases', () => {
    assert.deepEqual(encodeAudioFrame(FRAME_KIND_TTS, Buffer.from([1, 2, 3, 4])), Uint8Array.from([2, 1, 2, 3, 4]));
    const pool = Uint8Array.from([9, 9, 1, 2, 3, 4, 9, 9]);
    const view = pool.subarray(2, 6);
    const frame = encodeAudioFrame(FRAME_KIND_MIC, view);
    assert.deepEqual(frame, Uint8Array.from([1, 1, 2, 3, 4]));
    pool.fill(0); // the transport reuses its buffer; the frame must not change
    assert.deepEqual(frame, Uint8Array.from([1, 1, 2, 3, 4]));
  });

  it('decoder: refuses empty, kind only, unknown kind, odd, and oversized frames, each for its own reason', () => {
    refused(decodeAudioFrame(new Uint8Array(0)), /audio: empty frame/);
    refused(decodeAudioFrame(Uint8Array.from([FRAME_KIND_MIC])), /audio: no payload/);
    refused(decodeAudioFrame(Uint8Array.from([FRAME_KIND_TTS])), /audio: no payload/);
    for (const kind of [0x00, 0x03, 0x04, 0x7f, 0x80, 0xff, 0x11, 0x21]) {
      refused(decodeAudioFrame(Uint8Array.from([kind, 1, 2])), /audio: unknown kind/, `kind ${kind}`);
    }
    for (const len of [1, 3, 639, LIMITS.audioPayloadMax - 1]) {
      refused(decodeAudioFrame(Uint8Array.from([FRAME_KIND_MIC, ...pcm(len)])), /audio: odd length/, `odd ${len}`);
    }
    for (const len of [LIMITS.audioPayloadMax + 2, 2000, 65536]) {
      refused(decodeAudioFrame(Uint8Array.from([FRAME_KIND_MIC, ...pcm(len)])), /audio: payload too big/, `len ${len}`);
    }
    // The neighbours: the shortest and the longest frame are fine.
    assert.ok(decodeAudioFrame(Uint8Array.from([FRAME_KIND_MIC, 0, 0])).ok);
    assert.ok(decodeAudioFrame(Uint8Array.from([FRAME_KIND_MIC, ...pcm(LIMITS.audioPayloadMax)])).ok);
  });

  it('decoder: kind is checked before length (a text-looking frame is not mistaken for audio)', () => {
    // '{' is 0x7b, a kind that does not exist; even length and in range otherwise.
    refused(decodeAudioFrame(Buffer.from('{"t":"abort"}x')), /audio: unknown kind/);
  });

  it('decoder: non-binary input is refused, not thrown on', () => {
    for (const v of [undefined, null, 'abc', 5, [1, 2, 3], {}, new ArrayBuffer(4), new Uint16Array(2), new DataView(new ArrayBuffer(4))]) {
      refused(decodeAudioFrame(v as unknown as Uint8Array), /audio: not bytes/);
    }
  });

  it('decoder: reads a Buffer taken from the middle of a pool (non-zero byteOffset)', () => {
    const pool = Buffer.from([7, 7, 7, FRAME_KIND_MIC, 0x10, 0x20, 0x30, 0x40, 7, 7]);
    const frame = pool.subarray(3, 8);
    assert.notEqual(frame.byteOffset, 0);
    const r = decodeAudioFrame(frame);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.msg.kind, FRAME_KIND_MIC);
      assert.deepEqual([...r.msg.pcm], [0x10, 0x20, 0x30, 0x40]);
    }
  });

  it('decoder: the pcm is a copy, so a reused transport buffer cannot change it', () => {
    const frame = Uint8Array.from([FRAME_KIND_MIC, 1, 2, 3, 4]);
    const r = decodeAudioFrame(frame);
    assert.ok(r.ok);
    frame.fill(0xee);
    if (r.ok) assert.deepEqual([...r.msg.pcm], [1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// PROTOCOL.md is what the firmware is written from, so the numbers in it are held to
// the code, not to someone remembering to update both.
// ---------------------------------------------------------------------------

const DOC = readFileSync(new URL('../PROTOCOL.md', import.meta.url), 'utf8');

/** The text between a heading and the next heading of the same or higher level. */
function section(title: string): string {
  const start = DOC.indexOf(`\n## ${title}\n`);
  assert.ok(start >= 0, `PROTOCOL.md has no "## ${title}" section`);
  const rest = DOC.slice(start + 1);
  const next = rest.slice(3).search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next + 3);
}

/** Rows of the first markdown table after `marker`, as arrays of trimmed cells with backticks removed. */
function tableAfter(text: string, marker: string): string[][] {
  const at = text.indexOf(marker);
  assert.ok(at >= 0, `no "${marker}" in the section`);
  const rows: string[][] = [];
  let seenTable = false;
  for (const line of text.slice(at).split('\n').slice(1)) {
    if (line.trim().startsWith('|')) {
      seenTable = true;
      if (/^\|[\s:|-]+\|$/.test(line.trim())) continue;
      rows.push(line.trim().slice(1, -1).split('|').map((c) => c.trim().replace(/`/g, '')));
    } else if (seenTable) {
      break;
    }
  }
  return rows.slice(1); // drop the header row
}

describe('PROTOCOL.md agrees with the code', () => {
  it('states the protocol version', () => {
    assert.match(DOC, new RegExp(`protocol version \\*\\*${PROTOCOL_VERSION}\\*\\*`, 'i'));
  });

  it('the limits table is LIMITS, row for row', () => {
    const rows = tableAfter(section('Limits'), 'LIMITS_TABLE');
    const doc = new Map(rows.map((r) => [r[0]!, r[1]!]));
    const expected: Array<[string, number]> = [
      ['deviceFrameMax', LIMITS.deviceFrameMax], ['bridgeFrameMax', LIMITS.bridgeFrameMax],
      ['tokenMin', LIMITS.tokenMin], ['tokenMax', LIMITS.tokenMax], ['devMax', LIMITS.devMax], ['fwMax', LIMITS.fwMax],
      ['labelMax', LIMITS.labelMax], ['idLen', LIMITS.idLen], ['sayMax', LIMITS.sayMax], ['sttMax', LIMITS.sttMax],
      ['resultMax', LIMITS.resultMax], ['summaryMax', LIMITS.summaryMax], ['errMax', LIMITS.errMax],
      ['audioPayloadMax', LIMITS.audioPayloadMax], ['utteranceMaxBytes', LIMITS.utteranceMaxBytes],
      ['sidMax', 64], ['intMax', INT_MAX],
    ];
    assert.equal(doc.size, expected.length, 'the table lists a different number of limits than the code has');
    for (const [name, value] of expected) assert.equal(doc.get(name), String(value), name);
    // Every LIMITS entry is documented (a new limit must not be forgotten).
    for (const name of Object.keys(LIMITS)) assert.ok(doc.has(name), `${name} is missing from the table`);
  });

  it('the worst-case frame table is what the encoders actually produce', () => {
    const q = (n: number): string => '"'.repeat(n);
    const worst: Record<string, string> = {
      hello: encodeDeviceMsg({ t: 'hello', v: INT_MAX, token: 'a'.repeat(LIMITS.tokenMax), dev: q(LIMITS.devMax), fw: q(LIMITS.fwMax), rate: INT_MAX, bits: INT_MAX, ch: INT_MAX }),
      say: encodeDeviceMsg({ t: 'say', text: q(LIMITS.sayMax) }),
      listen: encodeDeviceMsg({ t: 'listen', m: 'cancel' }),
      ask_rsp: encodeDeviceMsg({ t: 'ask_rsp', id: 'ffffffff', ok: false }),
      abort: encodeDeviceMsg({ t: 'abort' }),
      ping: encodeDeviceMsg({ t: 'ping', n: INT_MAX }),
      hello_ack: encodeBridgeMsg({ t: 'hello_ack', v: INT_MAX, ok: true, sid: q(64) }),
      state: encodeBridgeMsg({ t: 'state', seq: INT_MAX, ph: 'transcribing', tl: q(LIMITS.labelMax), pend: INT_MAX }),
      stt: encodeBridgeMsg({ t: 'stt', text: q(LIMITS.sttMax) }),
      ask: encodeBridgeMsg({ t: 'ask', id: 'ffffffff', tl: q(LIMITS.labelMax), risk: 'high', sum: q(LIMITS.summaryMax), ttl: INT_MAX }),
      ask_end: encodeBridgeMsg({ t: 'ask_end', id: 'ffffffff', why: 'disconnect' }),
      result: encodeBridgeMsg({ t: 'result', ok: false, text: q(LIMITS.resultMax) }),
      err: encodeBridgeMsg({ t: 'err', code: 'stt_unavailable', msg: q(LIMITS.errMax) }),
      pong: encodeBridgeMsg({ t: 'pong', n: INT_MAX }),
    };
    const rows = tableAfter(section('Size budgets'), 'WORST_CASE_TABLE');
    const doc = new Map(rows.map((r) => [r[0]!, r[1]!]));
    assert.equal(doc.size, Object.keys(worst).length);
    for (const [type, wire] of Object.entries(worst)) assert.equal(doc.get(type), String(bytes(wire)), type);
    for (const t of [...DEVICE_MSG_TYPES, ...BRIDGE_MSG_TYPES]) assert.ok(doc.has(t), `${t} missing from the budget table`);
    // The point of the table: the firmware's buffers are big enough for the worst frame.
    assert.ok(Math.max(...Object.values(worst).map(bytes)) <= LIMITS.bridgeFrameMax);
    assert.match(section('Size budgets'), new RegExp(`largest binary frame is ${1 + LIMITS.audioPayloadMax} bytes`));
  });

  it('every message type, enum value and error code is named in the doc', () => {
    for (const name of [...DEVICE_MSG_TYPES, ...BRIDGE_MSG_TYPES, ...PHASES, ...RISKS, ...ASK_END_REASONS, ...ERR_CODES, ...HELLO_WHYS, 'start', 'stop', 'cancel']) {
      assert.ok(DOC.includes(`\`${name}\``), `${name} is never mentioned in backticks`);
    }
  });

  it('every message has a field table whose keys are the keys the encoder writes, in order', () => {
    const all = [...DEVICE_SAMPLES, ...BRIDGE_SAMPLES].map((s) => s.msg as unknown as Record<string, unknown>);
    const sections: Array<[string, string]> = [['Device to bridge', 'device'], ['Bridge to device', 'bridge']];
    for (const [title] of sections) {
      const body = section(title);
      for (const heading of body.split('\n### ').slice(1)) {
        const name = heading.split('\n')[0]!.replace(/`/g, '').trim();
        const type = name.split(/[ (]/)[0]!;
        const forms = all.filter((m) => m['t'] === type);
        assert.ok(forms.length > 0, `doc documents "${type}", which has no sample`);
        const keys = tableAfter(heading, '\n|').map((r) => r[0]!).filter((k) => k !== 't');
        const documented = new Set(keys);
        for (const form of forms) {
          for (const key of Object.keys(form).filter((k) => k !== 't')) assert.ok(documented.has(key), `${type}.${key} is not in the doc`);
        }
        for (const key of keys) assert.ok(forms.some((f) => key in f), `the doc lists ${type}.${key}, which the code does not have`);
      }
    }
  });

  it('the worked transcript is real: each line decodes in its direction and re-encodes to the same bytes', () => {
    const block = /```transcript\n([\s\S]*?)```/.exec(DOC);
    assert.ok(block, 'no ```transcript block');
    const lines = block![1]!.split('\n').filter((l) => /^(D>|B>)/.test(l));
    assert.ok(lines.length >= 12, 'the transcript is too short to be a worked example');
    const seen = new Set<string>();
    for (const line of lines) {
      const dir: Dir = line.startsWith('D>') ? 'device' : 'bridge';
      const wire = line.slice(2).trim();
      const r = dec(dir, wire);
      assert.ok(r.ok, `${line}: ${r.ok ? '' : r.msg}`);
      if (!r.ok) continue;
      assert.equal(enc(dir, r.msg), wire, 'the transcript line is not what the encoder writes');
      seen.add(r.msg.t);
    }
    // It walks the whole conversation, not a corner of it.
    for (const t of ['hello', 'hello_ack', 'state', 'say', 'ask', 'ask_rsp', 'ask_end', 'result', 'ping', 'pong', 'listen', 'stt']) {
      assert.ok(seen.has(t), `the transcript never shows ${t}`);
    }
  });
});
