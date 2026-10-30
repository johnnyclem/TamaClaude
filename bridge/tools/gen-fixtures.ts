/**
 * Generates fixtures/: the exact bytes of every wire frame, plus manifest.json.
 *
 *   node tools/gen-fixtures.ts
 *
 * VALID fixtures are produced by the real encoders and never typed by hand, so a
 * drifting encoder shows up as a diff here (and as a failure in
 * test/fixtures.test.ts, which regenerates everything in memory and compares). The
 * firmware's own test reads the same directory; that is what makes this a contract
 * between two code bases rather than a description of one.
 *
 * INVALID fixtures are literal strings on purpose. They exist to prove that a
 * decoder refuses specific bytes, so they must not depend on an encoder that, by
 * design, would refuse to produce them. Each carries the reason it must be refused
 * for. That is not written to disk (the manifest stays boring: just a code), but
 * the test checks it, because an invalid fixture rejected for the WRONG reason
 * proves nothing about the guard it was written for.
 *
 * Format, for whoever reads this from C++:
 *   - kind "text": the file is one WebSocket text frame, byte for byte, with no
 *     trailing newline. "binary": one binary frame.
 *   - dir "device": the frame was sent by the device (decode it as a bridge would).
 *     dir "bridge": sent by the bridge (decode it as the device would).
 *   - expect "invalid": the decoder must refuse it, and the bridge's code is `code`.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encodeAudioFrame, encodeBridgeMsg, encodeDeviceMsg } from '../src/protocol.ts';
import {
  ASK_END_REASONS, ERR_CODES, FRAME_KIND_MIC, FRAME_KIND_TTS, HELLO_WHYS, LIMITS, PHASES, RISKS,
} from '../src/types.ts';
import type { BridgeMsg, DeviceMsg } from '../src/types.ts';

export const FIXTURE_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));

export interface FixtureEntry {
  file: string;
  dir: 'device' | 'bridge';
  kind: 'text' | 'binary';
  expect: 'valid' | 'invalid';
  /** Present only when invalid. */
  code?: 'bad_msg';
  /**
   * Present, and `false`, only on a valid frame the bridge ACCEPTS but would never itself write
   * (whitespace, reordered keys, an escape the encoder does not use). Re-encoding it gives
   * different bytes by design, so the "decode and re-encode to the same bytes" rule does not
   * apply to it; decoding it must still give the message `note` describes.
   */
  canonical?: false;
  note: string;
}

export interface Fixture {
  entry: FixtureEntry;
  bytes: Uint8Array;
  /** Invalid text/binary only, and never written to disk: what the refusal must say. */
  reason?: RegExp;
}

const INT_MAX = 2147483647;
const utf8 = new TextEncoder();

/** Deterministic and never all-zero, so a byte-order or length bug cannot hide in silence. */
function pcm(len: number): Uint8Array {
  return Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
}

/** `n` characters cycling through all of printable ASCII, quote and backslash included. */
function printable(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(0x20 + (i % 95));
  return s;
}

const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-';
function tokenOf(n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += TOKEN_ALPHABET[(i * 7) % TOKEN_ALPHABET.length];
  return s;
}

function plain(n: number, ch = 'x'): string {
  return ch.repeat(n);
}

export function buildFixtures(): Fixture[] {
  const out: Fixture[] = [];

  const validText = (dir: 'device' | 'bridge', file: string, wire: string, note: string): void => {
    out.push({ entry: { file: `${file}.txt`, dir, kind: 'text', expect: 'valid', note }, bytes: utf8.encode(wire) });
  };
  /** A frame the grammar admits and the encoder would never write: typed by hand, on purpose. */
  const loose = (file: string, wire: string, note: string): void => {
    out.push({ entry: { file: `device-${file}.txt`, dir: 'device', kind: 'text', expect: 'valid', canonical: false, note }, bytes: utf8.encode(wire) });
  };
  const dev = (name: string, m: DeviceMsg, note: string): void => validText('device', `device-${name}`, encodeDeviceMsg(m), note);
  const brg = (name: string, m: BridgeMsg, note: string): void => validText('bridge', `bridge-${name}`, encodeBridgeMsg(m), note);
  const validAudio = (dir: 'device' | 'bridge', name: string, kind: number, len: number, note: string): void => {
    out.push({
      entry: { file: `${dir}-${name}.bin`, dir, kind: 'binary', expect: 'valid', note },
      bytes: encodeAudioFrame(kind, pcm(len)),
    });
  };

  // ---- valid: device -> bridge -------------------------------------------------

  const hello = { t: 'hello', v: 1, token: tokenOf(40), dev: 'tamaclaude-a1b2', fw: '0.1.0', rate: 16000, bits: 16, ch: 1 } as const;
  dev('hello-typical', hello, 'A normal hello: protocol 1, 16 kHz 16-bit mono');
  dev('hello-token-min', { ...hello, token: tokenOf(LIMITS.tokenMin), dev: '', fw: '' }, 'Shortest token (16), empty dev and fw');
  dev('hello-token-charset', { ...hello, token: 'aZ09._~-aZ09._~-' }, 'Token using every allowed punctuation character');
  dev('hello-max', {
    t: 'hello', v: INT_MAX, token: tokenOf(LIMITS.tokenMax), dev: plain(LIMITS.devMax, 'd'), fw: plain(LIMITS.fwMax, 'f'),
    rate: INT_MAX, bits: INT_MAX, ch: INT_MAX,
  }, 'Every field at its maximum; numbers are shape-checked only, the server rejects the values');
  dev('hello-worst-case', {
    t: 'hello', v: INT_MAX, token: plain(LIMITS.tokenMax, 'a'), dev: '"'.repeat(LIMITS.devMax), fw: '"'.repeat(LIMITS.fwMax),
    rate: INT_MAX, bits: INT_MAX, ch: INT_MAX,
  }, 'dev and fw are all quotes, so every character escapes: the largest hello frame');

  dev('say-typical', { t: 'say', text: 'run the tests and tell me what failed' }, 'A typed prompt');
  dev('say-empty', { t: 'say', text: '' }, 'Empty text is valid on the wire; whether it does anything is the server\'s business');
  dev('say-escapes', { t: 'say', text: 'say "hi" and keep C:\\temp' }, 'Quote and backslash, the only characters JSON escapes in ASCII');
  dev('say-max', { t: 'say', text: printable(LIMITS.sayMax) }, 'All of printable ASCII, 400 characters');
  dev('say-worst-case', { t: 'say', text: '"'.repeat(LIMITS.sayMax) }, 'Every character escapes, so this is the largest say frame');

  for (const m of ['start', 'stop', 'cancel'] as const) dev(`listen-${m}`, { t: 'listen', m }, `Push-to-talk: ${m}`);
  dev('ask_rsp-allow', { t: 'ask_rsp', id: '0a1b2c3d', ok: true }, 'The only message that can approve a tool call');
  dev('ask_rsp-deny', { t: 'ask_rsp', id: 'ffffffff', ok: false }, 'A tap on DENY');
  dev('abort', { t: 'abort' }, 'The only message with no fields');
  dev('ping-0', { t: 'ping', n: 0 }, 'Application ping');
  dev('ping-max', { t: 'ping', n: INT_MAX }, 'Largest counter');

  // Valid, accepted by the bridge, and NOT what an encoder writes. A firmware never has to
  // produce these; another implementation of the bridge has to accept them.
  loose('ping-noncanonical-whitespace', ' \t{ "t" : "ping" ,\r\n\t"n" : 7 }\t ', 'Whitespace (space, tab, CR, LF) before, between and after the tokens, none of it at the very end of the file: a ping with n 7');
  loose('ask_rsp-noncanonical-order', '{"ok":false,"id":"0a1b2c3d","t":"ask_rsp"}', 'Keys in another order, t not first: an ask_rsp denying 0a1b2c3d');
  loose('say-noncanonical-escapes', '{"t":"say","text":"A\\/B \\u0041\\u00200 \\"q\\" \\\\"}', 'The escapes \\/ and \\uXXXX for printable ASCII: the text A/B A 0 "q" \\');
  loose('listen-noncanonical-escaped-key', '{"\\u0074":"listen","\\u006d":"stop"}', 'Key names written with \\u escapes: a listen stop');

  validAudio('device', 'audio-mic-min', FRAME_KIND_MIC, 2, 'One sample, the shortest legal frame');
  validAudio('device', 'audio-mic-20ms', FRAME_KIND_MIC, 640, '20 ms at 16 kHz s16le');
  validAudio('device', 'audio-mic-max', FRAME_KIND_MIC, LIMITS.audioPayloadMax, '40 ms, the largest legal payload');

  // ---- valid: bridge -> device -------------------------------------------------

  brg('hello_ack-ok', { t: 'hello_ack', v: 1, ok: true, sid: 'c0ffee00-1234-4abc-8def-0123456789ab' }, 'Accepted; sid is the session id');
  brg('hello_ack-ok-sid-max', { t: 'hello_ack', v: 1, ok: true, sid: plain(64, 's') }, 'Longest sid');
  brg('hello_ack-ok-worst-case', { t: 'hello_ack', v: INT_MAX, ok: true, sid: '"'.repeat(64) }, 'Largest v and a sid of all quotes: the largest hello_ack frame');
  for (const why of HELLO_WHYS) brg(`hello_ack-refused-${why}`, { t: 'hello_ack', v: 1, ok: false, why }, `Refused: ${why}`);

  for (const ph of PHASES) {
    const labelled = ph === 'tool' || ph === 'asking';
    brg(`state-${ph}`, { t: 'state', seq: 1, ph, tl: labelled ? 'Bash' : '', pend: ph === 'asking' ? 1 : 0 }, `Phase ${ph}`);
  }
  brg('state-max', { t: 'state', seq: INT_MAX, ph: 'tool', tl: plain(LIMITS.labelMax, 'L'), pend: INT_MAX }, 'Largest counters, longest label');
  brg('state-worst-case', { t: 'state', seq: INT_MAX, ph: 'transcribing', tl: '"'.repeat(LIMITS.labelMax), pend: INT_MAX }, 'The longest phase name and a label of all quotes (a receiver ignores tl outside tool and asking): the largest state frame');

  brg('stt-typical', { t: 'stt', text: 'run the unit tests' }, 'A transcript');
  brg('stt-worst-case', { t: 'stt', text: '\\'.repeat(LIMITS.sttMax) }, 'Every character escapes');

  for (const risk of RISKS) {
    brg(`ask-${risk}`, { t: 'ask', id: '0a1b2c3d', tl: 'Bash', risk, sum: 'npm test', ttl: 60 }, `An ask of risk ${risk}`);
  }
  brg('ask-escapes', { t: 'ask', id: '0a1b2c3d', tl: 'Bash', risk: 'high', sum: 'rm "my dir" \\ x', ttl: 60 }, 'Quote and backslash in the summary');
  brg('ask-ttl-0', { t: 'ask', id: '00000000', tl: 'Write', risk: 'med', sum: 'a.txt', ttl: 0 }, 'Zero is valid on the wire, though the bridge rounds up and sends at least 1');
  brg('ask-max', {
    t: 'ask', id: 'abcdef01', tl: plain(LIMITS.labelMax, 'T'), risk: 'high', sum: printable(LIMITS.summaryMax), ttl: INT_MAX,
  }, 'Every field at its maximum');
  brg('ask-worst-case', {
    t: 'ask', id: 'abcdef01', tl: '"'.repeat(LIMITS.labelMax), risk: 'high', sum: '"'.repeat(LIMITS.summaryMax), ttl: INT_MAX,
  }, 'Every string character escapes: the largest ask frame');

  for (const why of ASK_END_REASONS) brg(`ask_end-${why}`, { t: 'ask_end', id: '0a1b2c3d', why }, `Ask ended: ${why}`);

  brg('result-ok', { t: 'result', ok: true, text: 'Tests pass. I fixed the off by one in the parser.' }, 'A finished turn');
  brg('result-fail', { t: 'result', ok: false, text: 'I could not finish: the build is broken.' }, 'A turn that ended badly');
  brg('result-empty', { t: 'result', ok: true, text: '' }, 'Empty text is valid on the wire');
  brg('result-worst-case', { t: 'result', ok: false, text: '\\'.repeat(LIMITS.resultMax) }, 'ok false is the longer spelling, and every character escapes: the largest result frame');

  for (const code of ERR_CODES) brg(`err-${code}`, { t: 'err', code, msg: `example for ${code}` }, `Error code ${code}`);
  brg('err-worst-case', { t: 'err', code: 'stt_unavailable', msg: '"'.repeat(LIMITS.errMax) }, 'The longest code and a msg of all quotes: the largest err frame');

  brg('pong-0', { t: 'pong', n: 0 }, 'Reply to ping');
  brg('pong-max', { t: 'pong', n: INT_MAX }, 'Largest counter');

  validAudio('bridge', 'audio-tts-min', FRAME_KIND_TTS, 2, 'One sample, the shortest legal frame');
  validAudio('bridge', 'audio-tts-20ms', FRAME_KIND_TTS, 640, '20 ms at 16 kHz s16le');
  validAudio('bridge', 'audio-tts-max', FRAME_KIND_TTS, LIMITS.audioPayloadMax, '40 ms, the largest legal payload');

  // ---- invalid -----------------------------------------------------------------
  // Every one of these is a SINGLE defect on top of an otherwise valid frame, so the
  // refusal can only be about that defect. Keep it that way when adding more.

  const bad = (dir: 'device' | 'bridge', slug: string, raw: string, reason: RegExp, note: string): void => {
    out.push({
      entry: { file: `invalid-${dir}-${slug}.txt`, dir, kind: 'text', expect: 'invalid', code: 'bad_msg', note },
      bytes: utf8.encode(raw),
      reason,
    });
  };
  const badBin = (dir: 'device' | 'bridge', slug: string, bytes: number[], reason: RegExp, note: string): void => {
    out.push({
      entry: { file: `invalid-${dir}-${slug}.bin`, dir, kind: 'binary', expect: 'invalid', code: 'bad_msg', note },
      bytes: Uint8Array.from(bytes),
      reason,
    });
  };

  const TOKEN = '0123456789abcdef';
  const helloWith = (token: string): string =>
    `{"t":"hello","v":1,"token":"${token}","dev":"d","fw":"f","rate":16000,"bits":16,"ch":1}`;
  const D = 'device';
  const B = 'bridge';

  // not an object, or not JSON
  bad(D, 'array-json', '[{"t":"abort"}]', /not a json object/, 'A JSON array holding a valid message');
  bad(D, 'null-json', 'null', /not a json object/, 'JSON null');
  bad(D, 'string-json', '"abort"', /not a json object/, 'A bare JSON string');
  bad(D, 'number-json', '42', /not a json object/, 'A bare JSON number');
  bad(D, 'empty-frame', '', /not a json object/, 'A zero-byte text frame');
  bad(D, 'not-json', 'abort', /not a json object/, 'Plain text');
  bad(D, 'truncated-json', '{"t":"ping","n":1', /bad json/, 'Cut off before the closing brace');
  bad(D, 'trailing-data', '{"t":"abort"}x', /trailing data/, 'Bytes after the object');
  bad(D, 'two-objects', '{"t":"abort"}{"t":"abort"}', /trailing data/, 'Two messages in one frame');
  bad(D, 'trailing-comma', '{"t":"ping","n":1,}', /bad json/, 'Trailing comma');
  bad(B, 'array-json', '[{"t":"pong","n":1}]', /not a json object/, 'A JSON array holding a valid message');
  bad(B, 'null-json', 'null', /not a json object/, 'JSON null');

  // type
  bad(D, 'unknown-type', '{"t":"launch","n":1}', /unknown type/, 'A type that does not exist');
  bad(D, 'unknown-type-bridge-msg', '{"t":"pong","n":1}', /unknown type/, 'A bridge message sent by a device');
  bad(D, 'unknown-type-empty', '{"t":"","n":1}', /unknown type/, 'Empty type');
  bad(D, 'missing-type', '{"n":1}', /missing key: t/, 'No t at all');
  bad(D, 'wrong-type-t', '{"t":5}', /t: not a string/, 't is a number');
  bad(B, 'unknown-type', '{"t":"stream","n":1}', /unknown type/, 'A type that does not exist');
  bad(B, 'unknown-type-device-msg', '{"t":"ping","n":1}', /unknown type/, 'A device message sent by the bridge');

  // keys
  bad(D, 'missing-key-say', '{"t":"say"}', /missing key: text/, 'say without text');
  bad(D, 'missing-key-hello-ch', '{"t":"hello","v":1,"token":"0123456789abcdef","dev":"d","fw":"f","rate":16000,"bits":16}', /missing key: ch/, 'hello without ch');
  bad(D, 'missing-key-ask_rsp-ok', '{"t":"ask_rsp","id":"0a1b2c3d"}', /missing key: ok/, 'An answer with no verdict must not default to either');
  bad(D, 'extra-key-ping', '{"t":"ping","n":1,"x":2}', /extra key/, 'One key too many');
  bad(D, 'extra-key-abort', '{"t":"abort","reason":"x"}', /extra key/, 'abort takes no fields');
  bad(D, 'extra-key-ask_rsp', '{"t":"ask_rsp","id":"0a1b2c3d","ok":true,"remember":true}', /extra key/, 'An approval carrying a field the protocol does not define');
  bad(B, 'missing-key-state-pend', '{"t":"state","seq":1,"ph":"idle","tl":""}', /missing key: pend/, 'state without pend');
  bad(B, 'extra-key-state', '{"t":"state","seq":1,"ph":"idle","tl":"","pend":0,"x":1}', /extra key/, 'One key too many');
  bad(B, 'missing-key-ask-ttl', '{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"low","sum":"x"}', /missing key: ttl/, 'ask without ttl');
  bad(B, 'hello_ack-ok-with-why', '{"t":"hello_ack","v":1,"ok":true,"why":"token"}', /missing key: sid/, 'Accepted form carrying the refused form\'s key');
  bad(B, 'hello_ack-refused-with-sid', '{"t":"hello_ack","v":1,"ok":false,"sid":"x"}', /missing key: why/, 'Refused form carrying the accepted form\'s key');
  bad(B, 'extra-key-hello_ack-both', '{"t":"hello_ack","v":1,"ok":true,"sid":"x","why":"token"}', /extra key/, 'Both forms\' keys at once');
  bad(B, 'wrong-type-hello_ack-ok', '{"t":"hello_ack","v":1,"ok":"true","sid":"x"}', /hello_ack.ok: not a boolean/, 'ok must be a real boolean, not a truthy string');
  bad(B, 'missing-key-hello_ack-ok', '{"t":"hello_ack","v":1,"sid":"x"}', /hello_ack.ok: not a boolean/, 'No discriminator');

  // prototype pollution shapes and duplicate keys
  bad(D, 'proto-key-nested', '{"__proto__":{"t":"abort"},"t":"abort"}', /nested value/, '__proto__ holding an object');
  bad(D, 'proto-key-scalar', '{"t":"abort","__proto__":1}', /extra key/, '__proto__ as an ordinary extra key');
  bad(D, 'proto-key-constructor', '{"t":"ping","n":1,"constructor":1}', /extra key/, 'constructor as an extra key');
  bad(B, 'proto-key-scalar', '{"t":"pong","n":1,"__proto__":null}', /extra key/, '__proto__ as an ordinary extra key');
  bad(D, 'duplicate-key-ask_rsp', '{"t":"ask_rsp","id":"0a1b2c3d","ok":false,"ok":true}', /duplicate key/, 'A deny followed by an allow: parsers disagree about which wins');
  bad(D, 'duplicate-key-same-value', '{"t":"ping","n":1,"n":1}', /duplicate key/, 'Duplicates are refused even when they agree');
  bad(D, 'duplicate-key-t', '{"t":"abort","t":"abort"}', /duplicate key/, 'Duplicate type');
  bad(B, 'duplicate-key-state', '{"t":"state","seq":1,"seq":2,"ph":"idle","tl":"","pend":0}', /duplicate key/, 'Duplicate seq');

  // value types
  bad(D, 'wrong-type-ping-n-string', '{"t":"ping","n":"1"}', /ping.n: not a number/, 'A number sent as a string');
  bad(D, 'wrong-type-ask_rsp-ok-string', '{"t":"ask_rsp","id":"0a1b2c3d","ok":"true"}', /ask_rsp.ok: not a boolean/, 'A verdict sent as a string');
  bad(D, 'wrong-type-ask_rsp-ok-number', '{"t":"ask_rsp","id":"0a1b2c3d","ok":1}', /ask_rsp.ok: not a boolean/, 'A verdict sent as 1');
  bad(D, 'wrong-type-say-number', '{"t":"say","text":5}', /say.text: not a string/, 'text is a number');
  bad(D, 'wrong-type-say-null', '{"t":"say","text":null}', /say.text: not a string/, 'text is null');
  bad(D, 'nested-object-value', '{"t":"say","text":{"a":1}}', /nested value/, 'An object where a string belongs');
  bad(D, 'nested-array-value', '{"t":"say","text":["a"]}', /nested value/, 'An array where a string belongs');
  bad(B, 'wrong-type-result-ok', '{"t":"result","ok":"yes","text":"x"}', /result.ok: not a boolean/, 'ok is a string');
  bad(B, 'wrong-type-ask-ttl-string', '{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"low","sum":"x","ttl":"60"}', /ask.ttl: not a number/, 'ttl is a string');

  // numbers
  bad(D, 'number-negative-zero', '{"t":"ping","n":-0}', /bad number/, '-0 prints as 0 in most languages; refused rather than repaired');
  bad(D, 'number-negative', '{"t":"ping","n":-1}', /bad number/, 'Negative');
  bad(D, 'number-exponent-huge', '{"t":"ping","n":1e999}', /bad number/, 'Exponent form that overflows a double');
  bad(D, 'number-exponent', '{"t":"ping","n":1e2}', /bad number/, 'An integer written with an exponent');
  bad(D, 'number-fraction', '{"t":"ping","n":1.0}', /bad number/, 'An integer written with a fraction');
  bad(D, 'number-leading-zero', '{"t":"ping","n":01}', /bad number/, 'Leading zero (octal in some parsers)');
  bad(D, 'number-plus-sign', '{"t":"ping","n":+1}', /bad number/, 'Explicit plus sign');
  bad(D, 'number-nan', '{"t":"ping","n":NaN}', /bad number/, 'NaN is not JSON');
  bad(D, 'number-too-many-digits', '{"t":"ping","n":99999999999999999999}', /bad number/, 'More digits than a double holds exactly');
  bad(D, 'number-over-int32', '{"t":"ping","n":2147483648}', /ping.n: out of range/, 'One past the int32 maximum');
  bad(B, 'number-fraction-ttl', '{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"low","sum":"x","ttl":1.5}', /bad number/, 'Fractional ttl');
  bad(B, 'number-over-int32-seq', '{"t":"state","seq":2147483648,"ph":"idle","tl":"","pend":0}', /state.seq: out of range/, 'seq one past the int32 maximum');

  // enums
  bad(D, 'bad-enum-listen', '{"t":"listen","m":"pause"}', /listen.m: not an allowed value/, 'Unknown listen mode');
  bad(D, 'bad-enum-listen-case', '{"t":"listen","m":"START"}', /listen.m: not an allowed value/, 'Enums are case sensitive');
  bad(B, 'bad-enum-state-ph', '{"t":"state","seq":1,"ph":"sleeping","tl":"","pend":0}', /state.ph: not an allowed value/, 'Unknown phase');
  bad(B, 'bad-enum-ask-risk', '{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"extreme","sum":"x","ttl":60}', /ask.risk: not an allowed value/, 'Unknown risk');
  bad(B, 'bad-enum-ask_end-why', '{"t":"ask_end","id":"0a1b2c3d","why":"cancelled"}', /ask_end.why: not an allowed value/, 'Unknown ask_end reason');
  bad(B, 'bad-enum-err-code', '{"t":"err","code":"oops","msg":"x"}', /err.code: not an allowed value/, 'Unknown error code');
  bad(B, 'bad-enum-hello_ack-why', '{"t":"hello_ack","v":1,"ok":false,"why":"nope"}', /hello_ack.why: not an allowed value/, 'Unknown refusal reason');

  // non-ASCII and unprintable text
  bad(D, 'non-ascii-raw', '{"t":"say","text":"caf\u00e9"}', /say.text: not printable ascii/, 'A raw UTF-8 e-acute inside a string');
  bad(D, 'non-ascii-escaped', '{"t":"say","text":"caf\\u00e9"}', /say.text: not printable ascii/, 'The same character written as a JSON escape (the frame itself is pure ASCII)');
  bad(D, 'non-ascii-lone-surrogate', '{"t":"say","text":"a\\ud800b"}', /say.text: not printable ascii/, 'A lone surrogate escape');
  bad(D, 'non-ascii-nul', '{"t":"say","text":"a\\u0000b"}', /say.text: not printable ascii/, 'An escaped NUL, which would end a C string early');
  bad(D, 'non-ascii-newline-escape', '{"t":"say","text":"a\\nb"}', /say.text: not printable ascii/, 'An escaped newline');
  bad(D, 'non-ascii-del', '{"t":"say","text":"a\u007fb"}', /say.text: not printable ascii/, 'A raw DEL (0x7f), legal JSON but not printable');
  bad(D, 'non-ascii-emoji', '{"t":"say","text":"ok \u{1F600}"}', /say.text: not printable ascii/, 'An emoji, which is four UTF-8 bytes');
  bad(D, 'bad-string-raw-newline', '{"t":"say","text":"a\nb"}', /bad string/, 'A raw newline inside a string is not legal JSON');
  bad(D, 'bad-string-bad-escape', '{"t":"say","text":"a\\xb"}', /bad string/, '\\x is not a JSON escape');
  bad(D, 'bad-string-unterminated', '{"t":"say","text":"abc}', /bad string/, 'String never closes');
  bad(B, 'non-ascii-stt', '{"t":"stt","text":"caf\u00e9"}', /stt.text: not printable ascii/, 'A raw UTF-8 e-acute');
  bad(B, 'non-ascii-ask-sum', '{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"low","sum":"rm \u4e2d","ttl":60}', /ask.sum: not printable ascii/, 'CJK in the summary');

  // lengths
  const say = (text: string): string => `{"t":"say","text":"${text}"}`;
  bad(D, 'too-long-say', say(plain(LIMITS.sayMax + 1)), /say.text: too long/, 'One character past the cap');
  bad(D, 'too-long-hello-dev', `{"t":"hello","v":1,"token":"${TOKEN}","dev":"${plain(LIMITS.devMax + 1)}","fw":"f","rate":16000,"bits":16,"ch":1}`, /hello.dev: too long/, 'dev one past the cap');
  bad(D, 'too-long-hello-fw', `{"t":"hello","v":1,"token":"${TOKEN}","dev":"d","fw":"${plain(LIMITS.fwMax + 1)}","rate":16000,"bits":16,"ch":1}`, /hello.fw: too long/, 'fw one past the cap');
  bad(B, 'too-long-state-tl', `{"t":"state","seq":1,"ph":"tool","tl":"${plain(LIMITS.labelMax + 1)}","pend":0}`, /state.tl: too long/, 'Label one past the cap');
  bad(B, 'too-long-ask-sum', `{"t":"ask","id":"0a1b2c3d","tl":"Bash","risk":"low","sum":"${plain(LIMITS.summaryMax + 1)}","ttl":60}`, /ask.sum: too long/, 'Summary one past the cap');
  bad(B, 'too-long-stt', `{"t":"stt","text":"${plain(LIMITS.sttMax + 1)}"}`, /stt.text: too long/, 'Transcript one past the cap');
  bad(B, 'too-long-result', `{"t":"result","ok":true,"text":"${plain(LIMITS.resultMax + 1)}"}`, /result.text: too long/, 'Result one past the cap');
  bad(B, 'too-long-err-msg', `{"t":"err","code":"internal","msg":"${plain(LIMITS.errMax + 1)}"}`, /err.msg: too long/, 'Message one past the cap');
  bad(B, 'too-long-hello_ack-sid', `{"t":"hello_ack","v":1,"ok":true,"sid":"${plain(65)}"}`, /hello_ack.sid: too long/, 'sid one past the cap');

  // frame size: otherwise valid JSON, padded with legal whitespace so size is the only defect
  const pad = (body: string, total: number): string => body + ' '.repeat(total - body.length);
  bad(D, 'oversized-frame', pad('{"t":"say","text":"hi"}', LIMITS.deviceFrameMax + 1), /frame too big/, 'A valid say padded to one byte over the device frame limit');
  bad(D, 'oversized-frame-multibyte', `{"t":"say","text":"${'\u00e9'.repeat(LIMITS.deviceFrameMax / 2)}"}`, /frame too big/, 'Fewer characters than the limit but more bytes: the limit is in bytes');
  bad(B, 'oversized-frame', pad('{"t":"pong","n":1}', LIMITS.bridgeFrameMax + 1), /frame too big/, 'A valid pong padded to one byte over the bridge frame limit');

  // ids
  const rsp = (id: string): string => `{"t":"ask_rsp","id":"${id}","ok":true}`;
  bad(D, 'bad-id-uppercase', rsp('0A1B2C3D'), /ask_rsp.id: bad characters/, 'Ids are lowercase hex');
  bad(D, 'bad-id-short', rsp('0a1b2c3'), /ask_rsp.id: too short/, 'Seven characters');
  bad(D, 'bad-id-long', rsp('0a1b2c3d4'), /ask_rsp.id: too long/, 'Nine characters');
  bad(D, 'bad-id-not-hex', rsp('0a1b2c3g'), /ask_rsp.id: bad characters/, 'g is not a hex digit');
  bad(D, 'bad-id-empty', rsp(''), /ask_rsp.id: too short/, 'Empty id');
  bad(D, 'bad-id-number', '{"t":"ask_rsp","id":12345678,"ok":true}', /ask_rsp.id: not a string/, 'An id that is a JSON number');
  bad(B, 'bad-id-ask', '{"t":"ask","id":"XYZ","tl":"Bash","risk":"low","sum":"x","ttl":60}', /ask.id: too short/, 'A bad id in an ask');
  bad(B, 'bad-id-ask_end', '{"t":"ask_end","id":"0A1B2C3D","why":"answered"}', /ask_end.id: bad characters/, 'Uppercase id in ask_end');

  // tokens
  bad(D, 'token-short', helloWith(TOKEN.slice(0, LIMITS.tokenMin - 1)), /hello.token: too short/, 'Fifteen characters');
  bad(D, 'token-empty', helloWith(''), /hello.token: too short/, 'Empty token');
  bad(D, 'token-long', helloWith(plain(LIMITS.tokenMax + 1, 'a')), /hello.token: too long/, 'Sixty-five characters');
  bad(D, 'token-bad-chars-space', helloWith('0123456789 abcdef'), /hello.token: bad characters/, 'A space');
  bad(D, 'token-bad-chars-base64', helloWith('0123456789+/abcdef'), /hello.token: bad characters/, 'Plain base64 punctuation; only the URL-safe alphabet is allowed');
  bad(D, 'token-bad-chars-quote-escape', helloWith('0123456789\\"abcdef'), /hello.token: bad characters/, 'An escaped quote');
  bad(D, 'wrong-type-hello-v', '{"t":"hello","v":"1","token":"0123456789abcdef","dev":"d","fw":"f","rate":16000,"bits":16,"ch":1}', /hello.v: not a number/, 'v as a string');

  // audio, both directions
  for (const dir of [D, B] as const) {
    const kind = dir === D ? FRAME_KIND_MIC : FRAME_KIND_TTS;
    badBin(dir, 'odd-length-audio', [kind, 1, 2, 3], /audio: odd length/, 'Three payload bytes: a torn s16 sample');
    badBin(dir, 'unknown-kind-audio-0', [0x00, 1, 2], /audio: unknown kind/, 'Kind 0x00');
    badBin(dir, 'unknown-kind-audio-3', [0x03, 1, 2], /audio: unknown kind/, 'Kind 0x03');
    badBin(dir, 'unknown-kind-audio-ff', [0xff, 1, 2], /audio: unknown kind/, 'Kind 0xff');
    badBin(dir, 'empty-audio', [], /audio: empty frame/, 'A zero-byte binary frame');
    badBin(dir, 'empty-audio-payload', [kind], /audio: no payload/, 'A kind byte and no samples');
    badBin(dir, 'too-big-audio', [kind, ...pcm(LIMITS.audioPayloadMax + 2)], /audio: payload too big/, 'An even payload, but past the 40 ms cap');
  }

  const names = new Set<string>();
  for (const f of out) {
    if (names.has(f.entry.file)) throw new Error(`duplicate fixture name ${f.entry.file}`);
    names.add(f.entry.file);
  }
  return out;
}

/** manifest.json exactly as it is committed: stable key order, two-space indent, final newline. */
export function renderManifest(fixtures: readonly Fixture[]): string {
  return `${JSON.stringify(fixtures.map((f) => f.entry), null, 2)}\n`;
}

export function writeFixtures(dir: string = FIXTURE_DIR): void {
  mkdirSync(dir, { recursive: true });
  const fixtures = buildFixtures();
  const keep = new Set<string>(['manifest.json']);
  for (const f of fixtures) {
    writeFileSync(`${dir}/${f.entry.file}`, f.bytes);
    keep.add(f.entry.file);
  }
  writeFileSync(`${dir}/manifest.json`, renderManifest(fixtures));
  // A renamed or dropped fixture must not linger and keep passing against nothing.
  for (const name of readdirSync(dir)) {
    if (!keep.has(name) && /\.(txt|bin|json)$/.test(name)) rmSync(`${dir}/${name}`);
  }
}

if (import.meta.main) {
  writeFixtures();
  console.log(`wrote ${buildFixtures().length} fixtures to ${FIXTURE_DIR}`);
}
