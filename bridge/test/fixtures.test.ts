/**
 * The golden fixtures. Three separate promises are checked here, because each one
 * fails differently:
 *
 *  1. The committed bytes equal what today's encoders produce. If an encoder
 *     drifts, the firmware (which was tested against the committed bytes) is
 *     silently out of step with the bridge; this is where that turns red.
 *  2. Every valid fixture decodes and re-encodes to the same bytes, in the
 *     direction its manifest entry says, and is refused in the other one.
 *  3. Every invalid fixture is refused, with the right code AND for the reason it
 *     was written to test. Refused for some other reason proves nothing.
 *
 * The decode loops read the committed files from disk, the way the firmware's test
 * will, and not the in-memory ones: a generator that is wrong the same way as the
 * codec must not be able to agree with itself.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildFixtures, FIXTURE_DIR, renderManifest } from '../tools/gen-fixtures.ts';
import type { FixtureEntry } from '../tools/gen-fixtures.ts';
import {
  decodeAudioFrame, decodeBridgeMsg, decodeDeviceMsg, encodeAudioFrame, encodeBridgeMsg, encodeDeviceMsg,
} from '../src/protocol.ts';
import {
  ASK_END_REASONS, BRIDGE_MSG_TYPES, DEVICE_MSG_TYPES, ERR_CODES, FRAME_KIND_MIC, FRAME_KIND_TTS, HELLO_WHYS,
  LIMITS, PHASES, RISKS,
} from '../src/types.ts';

const manifest = JSON.parse(readFileSync(`${FIXTURE_DIR}manifest.json`, 'utf8')) as FixtureEntry[];
const strict = new TextDecoder('utf-8', { fatal: true });
const bytesOf = (e: FixtureEntry): Uint8Array => new Uint8Array(readFileSync(`${FIXTURE_DIR}${e.file}`));
const textOf = (e: FixtureEntry): string => strict.decode(bytesOf(e));
const valid = manifest.filter((e) => e.expect === 'valid');
const invalid = manifest.filter((e) => e.expect === 'invalid');

describe('fixtures on disk match the encoders', () => {
  const regenerated = buildFixtures();

  it('manifest.json is byte-identical to a fresh render', () => {
    assert.equal(readFileSync(`${FIXTURE_DIR}manifest.json`, 'utf8'), renderManifest(regenerated));
  });

  it('every file is byte-identical to what the generator produces now', () => {
    assert.ok(regenerated.length > 100, 'a generator that emitted nothing would make this loop vacuous');
    for (const f of regenerated) {
      assert.deepEqual(new Uint8Array(readFileSync(`${FIXTURE_DIR}${f.entry.file}`)), f.bytes, f.entry.file);
    }
  });

  it('the directory holds the manifest and exactly the files it lists', () => {
    const listed = new Set(manifest.map((e) => e.file));
    assert.equal(listed.size, manifest.length, 'duplicate file in manifest');
    assert.deepEqual(readdirSync(FIXTURE_DIR).sort(), [...listed, 'manifest.json'].sort());
  });

  it('the format stays boring: fixed keys, plain names, no trailing newline in a text frame', () => {
    for (const e of manifest) {
      const keys = Object.keys(e).sort();
      assert.deepEqual(keys, (e.expect === 'invalid' ? ['code', 'dir', 'expect', 'file', 'kind', 'note'] : ['dir', 'expect', 'file', 'kind', 'note']), e.file);
      assert.match(e.file, /^[a-z0-9_-]+\.(txt|bin)$/);
      assert.equal(e.file.endsWith('.txt'), e.kind === 'text', e.file);
      assert.ok(e.dir === 'device' || e.dir === 'bridge');
      assert.ok(e.note.length > 0);
      if (e.expect === 'invalid') assert.equal(e.code, 'bad_msg');
      if (e.expect === 'valid' && e.kind === 'text') {
        // The encoders emit the frame and nothing else; a newline here would be an
        // editor's doing and would make the file not the wire bytes.
        assert.doesNotMatch(textOf(e), /[\r\n]/, e.file);
      }
    }
  });
});

describe('valid fixtures', () => {
  it('there are some of each kind (so the loops below are not vacuous)', () => {
    assert.ok(valid.some((e) => e.kind === 'text' && e.dir === 'device'));
    assert.ok(valid.some((e) => e.kind === 'text' && e.dir === 'bridge'));
    assert.ok(valid.some((e) => e.kind === 'binary' && e.dir === 'device'));
    assert.ok(valid.some((e) => e.kind === 'binary' && e.dir === 'bridge'));
  });

  it('decode, and re-encode to the same bytes', () => {
    for (const e of valid) {
      if (e.kind === 'binary') {
        const r = decodeAudioFrame(bytesOf(e));
        assert.ok(r.ok, e.file);
        assert.deepEqual(encodeAudioFrame(r.msg.kind, r.msg.pcm), bytesOf(e), e.file);
        continue;
      }
      const wire = textOf(e);
      if (e.dir === 'device') {
        const r = decodeDeviceMsg(wire);
        assert.ok(r.ok, `${e.file}: ${r.ok ? '' : r.msg}`);
        assert.equal(encodeDeviceMsg(r.msg), wire, e.file);
      } else {
        const r = decodeBridgeMsg(wire);
        assert.ok(r.ok, `${e.file}: ${r.ok ? '' : r.msg}`);
        assert.equal(encodeBridgeMsg(r.msg), wire, e.file);
      }
    }
  });

  it('are refused by the OTHER direction\'s decoder, so `dir` means something', () => {
    for (const e of valid.filter((x) => x.kind === 'text')) {
      const r = e.dir === 'device' ? decodeBridgeMsg(textOf(e)) : decodeDeviceMsg(textOf(e));
      assert.ok(!r.ok, `${e.file} decoded in the wrong direction`);
      assert.match(r.msg, /unknown type/, e.file);
    }
  });

  it('every frame fits the limit of the direction it travels', () => {
    for (const e of valid.filter((x) => x.kind === 'text')) {
      const max = e.dir === 'device' ? LIMITS.deviceFrameMax : LIMITS.bridgeFrameMax;
      assert.ok(bytesOf(e).length <= max, e.file);
    }
  });

  describe('cover the whole contract (measured from the decoded fixtures, against the enums in types.ts)', () => {
    const seen = {
      deviceTypes: new Set<string>(), bridgeTypes: new Set<string>(),
      phases: new Set<string>(), risks: new Set<string>(), askEnds: new Set<string>(), errs: new Set<string>(),
      whys: new Set<string>(), listen: new Set<string>(),
      helloAck: new Set<boolean>(), askRsp: new Set<boolean>(), result: new Set<boolean>(),
      micLens: new Set<number>(), ttsLens: new Set<number>(),
    };
    for (const e of valid) {
      if (e.kind === 'binary') {
        const r = decodeAudioFrame(bytesOf(e));
        if (r.ok) (r.msg.kind === FRAME_KIND_MIC ? seen.micLens : seen.ttsLens).add(r.msg.pcm.length);
        continue;
      }
      if (e.dir === 'device') {
        const r = decodeDeviceMsg(textOf(e));
        if (!r.ok) continue;
        seen.deviceTypes.add(r.msg.t);
        if (r.msg.t === 'listen') seen.listen.add(r.msg.m);
        if (r.msg.t === 'ask_rsp') seen.askRsp.add(r.msg.ok);
      } else {
        const r = decodeBridgeMsg(textOf(e));
        if (!r.ok) continue;
        const m = r.msg;
        seen.bridgeTypes.add(m.t);
        if (m.t === 'state') seen.phases.add(m.ph);
        if (m.t === 'ask') seen.risks.add(m.risk);
        if (m.t === 'ask_end') seen.askEnds.add(m.why);
        if (m.t === 'err') seen.errs.add(m.code);
        if (m.t === 'result') seen.result.add(m.ok);
        if (m.t === 'hello_ack') {
          seen.helloAck.add(m.ok);
          if (!m.ok) seen.whys.add(m.why);
        }
      }
    }
    const sorted = (s: Set<string | number | boolean>): unknown[] => [...s].sort();

    it('every device message type', () => assert.deepEqual(sorted(seen.deviceTypes), [...DEVICE_MSG_TYPES].sort()));
    it('every bridge message type', () => assert.deepEqual(sorted(seen.bridgeTypes), [...BRIDGE_MSG_TYPES].sort()));
    it('every phase', () => assert.deepEqual(sorted(seen.phases), [...PHASES].sort()));
    it('every risk', () => assert.deepEqual(sorted(seen.risks), [...RISKS].sort()));
    it('every ask_end reason', () => assert.deepEqual(sorted(seen.askEnds), [...ASK_END_REASONS].sort()));
    it('every err code', () => assert.deepEqual(sorted(seen.errs), [...ERR_CODES].sort()));
    it('every hello refusal', () => assert.deepEqual(sorted(seen.whys), [...HELLO_WHYS].sort()));
    it('every listen mode', () => assert.deepEqual(sorted(seen.listen), ['cancel', 'start', 'stop']));
    it('both forms of hello_ack, both verdicts, both result outcomes', () => {
      assert.deepEqual(sorted(seen.helloAck), [false, true]);
      assert.deepEqual(sorted(seen.askRsp), [false, true]);
      assert.deepEqual(sorted(seen.result), [false, true]);
    });
    it('audio at the shortest, a typical and the longest payload, both ways', () => {
      for (const lens of [seen.micLens, seen.ttsLens]) {
        assert.deepEqual(sorted(lens), [2, 640, LIMITS.audioPayloadMax].sort());
      }
    });
  });
});

describe('invalid fixtures', () => {
  const reasons = new Map(buildFixtures().map((f) => [f.entry.file, f.reason]));

  it('there are plenty, in both directions and both kinds', () => {
    assert.ok(invalid.length > 80);
    for (const dir of ['device', 'bridge']) {
      for (const kind of ['text', 'binary']) {
        assert.ok(invalid.some((e) => e.dir === dir && e.kind === kind), `${dir} ${kind}`);
      }
    }
  });

  it('every one is refused, with its code, for the reason it was written to test', () => {
    for (const e of invalid) {
      const want = reasons.get(e.file);
      assert.ok(want, `${e.file} has no recorded reason`);
      const r = e.kind === 'binary'
        ? decodeAudioFrame(bytesOf(e))
        : e.dir === 'device' ? decodeDeviceMsg(textOf(e)) : decodeBridgeMsg(textOf(e));
      assert.equal(r.ok, false, `${e.file} was accepted`);
      if (r.ok) continue;
      assert.equal(r.code, e.code, e.file);
      assert.match(r.msg, want, e.file);
      assert.ok(r.msg.length <= LIMITS.errMax, e.file);
    }
  });

  it('every defect class the protocol promises to refuse has a fixture', () => {
    const names = invalid.map((e) => e.file);
    const classes = [
      'unknown-type', 'missing-key', 'extra-key', 'wrong-type', 'bad-enum', 'non-ascii', 'too-long',
      'oversized-frame', 'bad-id', 'token-short', 'array-json', 'null-json', 'proto-key',
      'odd-length-audio', 'unknown-kind-audio', 'empty-audio', 'duplicate-key', 'number-', 'bad-string', 'trailing-data',
    ];
    for (const c of classes) {
      assert.ok(names.some((n) => n.includes(c)), `no invalid fixture for "${c}"`);
    }
  });

  it('the invalid fixtures are real bytes, not accidentally empty files (bar the three zero-byte frames)', () => {
    const empties = invalid.filter((e) => bytesOf(e).length === 0).map((e) => e.file).sort();
    assert.deepEqual(empties, ['invalid-bridge-empty-audio.bin', 'invalid-device-empty-audio.bin', 'invalid-device-empty-frame.txt']);
  });

  it('the oversized frames are otherwise valid: only their size is wrong', () => {
    // Strip the padding and the same message must decode; that is what makes the
    // size the only defect rather than one of several.
    const dev = textOf(manifest.find((e) => e.file === 'invalid-device-oversized-frame.txt')!);
    assert.equal(Buffer.byteLength(dev), LIMITS.deviceFrameMax + 1);
    assert.ok(decodeDeviceMsg(dev.trimEnd()).ok);
    const brg = textOf(manifest.find((e) => e.file === 'invalid-bridge-oversized-frame.txt')!);
    assert.equal(Buffer.byteLength(brg), LIMITS.bridgeFrameMax + 1);
    assert.ok(decodeBridgeMsg(brg.trimEnd()).ok);
  });

  it('a one-defect fixture really is one defect: undoing just that defect makes it decode', () => {
    // The mechanism check for the reason table above. If the repaired frame did not
    // decode, "refused for the right reason" could be a coincidence of two defects.
    // Each repair is a substitution applied to the committed bytes, and must change
    // them: a replace that matches nothing would otherwise pass for free.
    const repairs: Array<[string, string | RegExp, string]> = [
      ['invalid-device-bad-id-uppercase.txt', '0A1B2C3D', '0a1b2c3d'],
      ['invalid-device-bad-id-short.txt', '"0a1b2c3"', '"0a1b2c3d"'],
      ['invalid-device-bad-id-long.txt', '0a1b2c3d4', '0a1b2c3d'],
      ['invalid-device-bad-id-not-hex.txt', '0a1b2c3g', '0a1b2c3f'],
      ['invalid-device-bad-id-empty.txt', '"id":""', '"id":"0a1b2c3d"'],
      ['invalid-bridge-bad-id-ask_end.txt', '0A1B2C3D', '0a1b2c3d'],
      ['invalid-device-token-short.txt', '"token":"0123456789abcde"', '"token":"0123456789abcdef"'],
      ['invalid-device-token-long.txt', /a{65}/, '0123456789abcdef'],
      ['invalid-device-token-bad-chars-space.txt', '0123456789 abcdef', '0123456789-abcdef'],
      ['invalid-device-token-bad-chars-base64.txt', '0123456789+/abcdef', '0123456789._abcdef'],
      ['invalid-device-extra-key-ping.txt', ',"x":2', ''],
      ['invalid-device-extra-key-ask_rsp.txt', ',"remember":true', ''],
      ['invalid-device-duplicate-key-ask_rsp.txt', '"ok":false,', ''],
      ['invalid-device-duplicate-key-same-value.txt', ',"n":1}', '}'],
      ['invalid-bridge-duplicate-key-state.txt', '"seq":1,', ''],
      ['invalid-device-wrong-type-ping-n-string.txt', '"1"', '1'],
      ['invalid-device-wrong-type-ask_rsp-ok-string.txt', '"true"', 'true'],
      ['invalid-device-wrong-type-say-number.txt', ':5}', ':"x"}'],
      ['invalid-device-nested-object-value.txt', '{"a":1}', '"x"'],
      ['invalid-bridge-wrong-type-result-ok.txt', '"yes"', 'true'],
      ['invalid-bridge-bad-enum-state-ph.txt', 'sleeping', 'idle'],
      ['invalid-bridge-bad-enum-ask-risk.txt', 'extreme', 'high'],
      ['invalid-bridge-bad-enum-ask_end-why.txt', 'cancelled', 'timeout'],
      ['invalid-bridge-bad-enum-err-code.txt', 'oops', 'busy'],
      ['invalid-bridge-bad-enum-hello_ack-why.txt', 'nope', 'token'],
      ['invalid-device-bad-enum-listen.txt', 'pause', 'stop'],
      ['invalid-device-bad-enum-listen-case.txt', 'START', 'start'],
      ['invalid-device-number-negative-zero.txt', '-0', '0'],
      ['invalid-device-number-negative.txt', '-1', '1'],
      ['invalid-device-number-exponent.txt', '1e2', '100'],
      ['invalid-device-number-exponent-huge.txt', '1e999', '999'],
      ['invalid-device-number-fraction.txt', '1.0', '1'],
      ['invalid-device-number-leading-zero.txt', ':01}', ':1}'],
      ['invalid-device-number-plus-sign.txt', '+1', '1'],
      ['invalid-device-number-nan.txt', 'NaN', '1'],
      ['invalid-device-number-too-many-digits.txt', '99999999999999999999', '2147483647'],
      ['invalid-device-number-over-int32.txt', '2147483648', '2147483647'],
      ['invalid-bridge-number-fraction-ttl.txt', '1.5', '2'],
      ['invalid-bridge-number-over-int32-seq.txt', '2147483648', '2147483647'],
      ['invalid-device-non-ascii-raw.txt', '\u00e9', 'e'],
      ['invalid-device-non-ascii-escaped.txt', '\\u00e9', 'e'],
      ['invalid-device-non-ascii-lone-surrogate.txt', '\\ud800', 'x'],
      ['invalid-device-non-ascii-nul.txt', '\\u0000', 'x'],
      ['invalid-device-non-ascii-newline-escape.txt', '\\n', ' '],
      ['invalid-device-non-ascii-del.txt', '\u007f', 'x'],
      ['invalid-device-non-ascii-emoji.txt', '\u{1F600}', ':)'],
      ['invalid-device-bad-string-raw-newline.txt', 'a\nb', 'a b'],
      ['invalid-device-bad-string-bad-escape.txt', '\\x', 'x'],
      ['invalid-device-bad-string-unterminated.txt', 'abc}', 'abc"}'],
      ['invalid-bridge-non-ascii-stt.txt', '\u00e9', 'e'],
      ['invalid-bridge-non-ascii-ask-sum.txt', '\u4e2d', 'x'],
      ['invalid-device-too-long-say.txt', /x{401}/, 'x'],
      ['invalid-device-too-long-hello-dev.txt', /"dev":"x{33}"/, '"dev":"x"'],
      ['invalid-device-too-long-hello-fw.txt', /"fw":"x{17}"/, '"fw":"x"'],
      ['invalid-bridge-too-long-state-tl.txt', /x{17}/, 'x'],
      ['invalid-bridge-too-long-ask-sum.txt', /x{97}/, 'x'],
      ['invalid-bridge-too-long-stt.txt', /x{241}/, 'x'],
      ['invalid-bridge-too-long-result.txt', /x{241}/, 'x'],
      ['invalid-bridge-too-long-err-msg.txt', /x{65}/, 'x'],
      ['invalid-bridge-too-long-hello_ack-sid.txt', /x{65}/, 'x'],
      ['invalid-device-oversized-frame.txt', / +$/, ''],
      ['invalid-bridge-oversized-frame.txt', / +$/, ''],
      ['invalid-device-oversized-frame-multibyte.txt', /\u00e9+/, 'e'],
      ['invalid-device-truncated-json.txt', '"n":1', '"n":1}'],
      ['invalid-device-trailing-data.txt', '}x', '}'],
      ['invalid-device-trailing-comma.txt', ',}', '}'],
      ['invalid-device-two-objects.txt', '}{"t":"abort"}', '}'],
      ['invalid-bridge-hello_ack-ok-with-why.txt', '"why":"token"', '"sid":"x"'],
      ['invalid-bridge-hello_ack-refused-with-sid.txt', '"sid":"x"', '"why":"token"'],
      ['invalid-bridge-extra-key-hello_ack-both.txt', ',"why":"token"', ''],
      ['invalid-bridge-wrong-type-hello_ack-ok.txt', '"true"', 'true'],
    ];
    for (const [file, from, to] of repairs) {
      const e = manifest.find((x) => x.file === file);
      assert.ok(e, `${file} is not in the manifest`);
      const before = textOf(e);
      const after = before.replace(from, to);
      assert.notEqual(after, before, `${file}: the repair matched nothing`);
      const r = e.dir === 'device' ? decodeDeviceMsg(after) : decodeBridgeMsg(after);
      assert.ok(r.ok, `${file} still refused once repaired: ${r.ok ? '' : r.msg}`);
    }
  });

  it('the same, for the binary fixtures', () => {
    const repairs: Array<[string, (b: Uint8Array) => Uint8Array]> = [
      ['odd-length-audio', (b) => b.slice(0, -1)],
      ['unknown-kind-audio-0', (b) => Uint8Array.from([FRAME_KIND_MIC, ...b.slice(1)])],
      ['unknown-kind-audio-3', (b) => Uint8Array.from([FRAME_KIND_TTS, ...b.slice(1)])],
      ['unknown-kind-audio-ff', (b) => Uint8Array.from([FRAME_KIND_MIC, ...b.slice(1)])],
      ['empty-audio-payload', (b) => Uint8Array.from([...b, 0, 0])],
      ['too-big-audio', (b) => b.slice(0, b.length - 2)],
      ['empty-audio', () => Uint8Array.from([FRAME_KIND_MIC, 0, 0])],
    ];
    for (const dir of ['device', 'bridge']) {
      for (const [slug, fix] of repairs) {
        const e = manifest.find((x) => x.file === `invalid-${dir}-${slug}.bin`);
        assert.ok(e, `invalid-${dir}-${slug}.bin is not in the manifest`);
        const before = bytesOf(e);
        const after = fix(before);
        assert.notDeepEqual(after, before);
        assert.ok(decodeAudioFrame(after).ok, `${e.file} still refused once repaired`);
      }
    }
  });
});
