/**
 * The state machine decides what the pet does, so the tests are organised around the
 * rules a player would notice being wrong:
 *
 *  - a TABLE of (state, input) -> what the device is told, which includes the inputs
 *    that must change nothing (a guard phrased as "X never happens" is only a test if
 *    the table also shows X happening where it should);
 *  - whole TURNS replayed in the order the bridge produces them, because most of the
 *    interesting bugs here are about sequences (parallel tools, asks answered while a
 *    tool is still running, a stop followed by a normal turn);
 *  - a seeded FUZZ that holds the invariants the wire format needs, and checks it
 *    actually reached every phase, or "no invalid state" would be vacuously true;
 *  - the CODEC as the caller: the point of sanitising a label is that the encoder
 *    accepts it, so the encoder is run on what comes out.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeBridgeMsg, encodeBridgeMsg, isPrintableAscii } from '../src/protocol.ts';
import { initialState, isTurnRunning, phaseOf, reduce, toStateMsg } from '../src/state.ts';
import type { ActiveTool, BridgeState, StateInput } from '../src/state.ts';
import { LIMITS, PHASES } from '../src/types.ts';
import type { Phase } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fold = (...inputs: StateInput[]): BridgeState => inputs.reduce((s, i) => reduce(s, i), initialState);
const after = (s: BridgeState, ...inputs: StateInput[]): BridgeState => inputs.reduce((acc, i) => reduce(acc, i), s);

const listenStart: StateInput = { k: 'listen_start' };
const listenStop: StateInput = { k: 'listen_stop' };
const listenCancel: StateInput = { k: 'listen_cancel' };
const sttDone: StateInput = { k: 'stt_done' };
const promptSent: StateInput = { k: 'prompt_sent' };
const aborted: StateInput = { k: 'aborted' };
const settle: StateInput = { k: 'settle' };
const toolStart = (id: string, name = 'Bash'): StateInput => ({ k: 'tool_start', id, name });
const toolEnd = (id: string, ok = true): StateInput => ({ k: 'tool_end', id, ok });
const asks = (count: number, label = ''): StateInput => ({ k: 'asks', count, label });
const result = (ok = true, subtype = ok ? 'success' : 'error_during_execution'): StateInput => ({
  k: 'result', ok, text: 'text', subtype,
});
const fatal: StateInput = { k: 'fatal', msg: 'the session died' };
const stopped = result(false, 'interrupted');

/** What the device would be told, minus `seq`, which is the caller's. */
function view(s: BridgeState): { ph: Phase; tl: string; pend: number } {
  const m = toStateMsg(s, 1);
  return { ph: m.ph, tl: m.tl, pend: m.pend };
}

/** The phases the fuzz and the table cover. `speaking` has no input in this reducer. */
const REACHABLE: readonly Phase[] = PHASES.filter((p) => p !== 'speaking');

/** Generous on purpose: what is guarded is a stall, which takes seconds, not milliseconds. */
const BUDGET_MS = 1500;

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

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** Named states to start rows from, built by the same inputs the server will send. */
const AT: Record<string, BridgeState> = {
  idle: initialState,
  listening: fold(listenStart),
  transcribing: fold(listenStart, listenStop),
  thinking: fold(promptSent),
  tool: fold(promptSent, toolStart('t1', 'Bash')),
  asking: fold(promptSent, toolStart('t1', 'Bash'), asks(1, 'Bash')),
  done: fold(promptSent, result()),
  error: fold(promptSent, result(false)),
};

interface Row { from: keyof typeof AT; input: StateInput; ph: Phase; tl?: string; pend?: number }
const row = (from: keyof typeof AT, input: StateInput, ph: Phase, tl?: string, pend?: number): Row => ({ from, input, ph, tl, pend });

const TABLE: readonly Row[] = [
  // The input path: idle -> listening -> transcribing -> thinking.
  row('idle', listenStart, 'listening'),
  row('listening', listenStop, 'transcribing'),
  // A transcript never starts a turn by itself: it is shown, and only a prompt starts one.
  row('transcribing', sttDone, 'idle'),
  row('transcribing', promptSent, 'thinking'),
  row('listening', listenCancel, 'idle'),
  row('transcribing', listenCancel, 'idle'),
  row('idle', promptSent, 'thinking'),
  // A typed prompt while a window is open still starts the turn: the prompt is going out.
  row('listening', promptSent, 'thinking'),
  row('done', promptSent, 'thinking'),
  row('error', promptSent, 'thinking'),
  row('done', listenStart, 'listening'),
  row('error', listenStart, 'listening'),

  // Input that does not belong to the current step is ignored, not obeyed.
  row('idle', listenStop, 'idle'),
  row('idle', listenCancel, 'idle'),
  row('idle', sttDone, 'idle'),
  row('listening', listenStart, 'listening'),
  row('listening', sttDone, 'listening'),
  row('transcribing', listenStart, 'transcribing'),
  row('transcribing', listenStop, 'transcribing'),
  row('done', listenCancel, 'done'),
  row('done', listenStop, 'done'),
  // A turn is running: the microphone is not available, and nothing moves the turn.
  row('thinking', listenStart, 'thinking'),
  row('thinking', listenStop, 'thinking'),
  row('thinking', listenCancel, 'thinking'),
  row('thinking', sttDone, 'thinking'),
  row('thinking', promptSent, 'thinking'),
  row('tool', promptSent, 'tool', 'Bash'),
  row('asking', promptSent, 'asking', 'Bash', 1),
  row('tool', listenStart, 'tool', 'Bash'),
  row('thinking', settle, 'thinking'),
  row('tool', settle, 'tool', 'Bash'),

  // Tools.
  row('thinking', toolStart('t1', 'Edit'), 'tool', 'Edit'),
  row('tool', toolEnd('t1'), 'thinking'),
  row('tool', toolEnd('t1', false), 'thinking'), // a failed tool still stops running
  row('tool', toolEnd('other'), 'tool', 'Bash'),
  row('thinking', toolEnd('t1'), 'thinking'),
  row('tool', { k: 'text', text: 'narration' }, 'tool', 'Bash'),
  row('thinking', { k: 'text', text: 'narration' }, 'thinking'),
  row('thinking', { k: 'session', id: 'abc' }, 'thinking'),
  row('idle', { k: 'text', text: 'narration' }, 'idle'),
  row('idle', { k: 'session', id: 'abc' }, 'idle'),
  // No turn, so no tool: adopting it would leave the pet on `tool` with nothing to clear it.
  row('idle', toolStart('t1'), 'idle'),
  row('listening', toolStart('t1'), 'listening'),
  row('done', toolStart('t1'), 'done'),
  row('error', toolStart('t1'), 'error'),
  row('idle', toolEnd('t1'), 'idle'),

  // Asks override whatever is under them, and give it back.
  row('thinking', asks(1, 'Bash'), 'asking', 'Bash', 1),
  row('tool', asks(1, 'Edit'), 'asking', 'Edit', 1),
  row('tool', asks(3, 'Edit'), 'asking', 'Edit', 3),
  row('asking', asks(0), 'tool', 'Bash', 0),
  row('asking', toolEnd('t1'), 'asking', 'Bash', 1),
  row('asking', asks(2, 'Bash'), 'asking', 'Bash', 2),
  row('asking', asks(1, 'Write'), 'asking', 'Write', 1),
  row('thinking', asks(0), 'thinking'),
  row('idle', asks(0), 'idle'),

  // A terminal event ends the turn and takes the tools with it. It does NOT take the asks: they
  // are what the approval manager has open, an ask can outlive its turn, and the panel must
  // keep showing one that is still answerable.
  row('thinking', result(), 'done'),
  row('thinking', result(false), 'error'),
  row('thinking', fatal, 'error'),
  row('tool', result(), 'done', '', 0),
  row('tool', result(false), 'error', '', 0),
  row('tool', fatal, 'error', '', 0),
  row('asking', result(), 'asking', 'Bash', 1),
  row('asking', result(false), 'asking', 'Bash', 1),
  row('asking', fatal, 'asking', 'Bash', 1),

  // Terminal events with no turn to end change nothing. In particular a repeat must not
  // flip a settled error into a success, and a stray one must not invent a turn.
  row('idle', result(), 'idle'),
  row('idle', result(false), 'idle'),
  row('idle', fatal, 'idle'),
  row('listening', result(), 'listening'),
  row('transcribing', fatal, 'transcribing'),
  row('done', result(), 'done'),
  row('done', result(false), 'done'),
  row('done', fatal, 'done'),
  row('error', result(), 'error'),
  row('error', fatal, 'error'),

  // `done` and `error` rest until the server settles them.
  row('done', settle, 'idle'),
  row('error', settle, 'idle'),
  row('idle', settle, 'idle'),
  row('listening', settle, 'listening'),
  row('done', aborted, 'done'),
  row('idle', aborted, 'idle'),
];

describe('table: what the device is told for each (state, input)', () => {
  for (const r of TABLE) {
    const name = `${r.from} + ${JSON.stringify(r.input)} -> ${r.ph}`;
    it(name, () => {
      const start = AT[r.from]!;
      const got = view(reduce(start, r.input));
      assert.equal(got.ph, r.ph);
      if (r.tl !== undefined) assert.equal(got.tl, r.tl);
      if (r.pend !== undefined) assert.equal(got.pend, r.pend);
    });
  }

  it('starts every named state from the phase its name says (the table is not testing itself)', () => {
    for (const [name, s] of Object.entries(AT)) assert.equal(phaseOf(s), name);
  });

  it('exercises every reachable phase as a destination, or the table proves little', () => {
    const seen = new Set(TABLE.map((r) => r.ph));
    for (const p of REACHABLE) assert.ok(seen.has(p), `no row ends in ${p}`);
  });

  it('puts speaking out of reach: no input produces it', () => {
    // Documented in state.ts; if TTS adds an input, this is the test to update on purpose.
    for (const s of Object.values(AT)) for (const r of TABLE) assert.notEqual(phaseOf(reduce(s, r.input)), 'speaking');
  });
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

describe('tools', () => {
  it('shows the most recently started tool that is still active', () => {
    let s = fold(promptSent, toolStart('a', 'Bash'));
    assert.deepEqual(view(s), { ph: 'tool', tl: 'Bash', pend: 0 });
    s = reduce(s, toolStart('b', 'Edit'));
    assert.equal(view(s).tl, 'Edit');
    s = reduce(s, toolStart('c', 'Grep'));
    assert.equal(view(s).tl, 'Grep');
  });

  it('falls back to the previous ACTIVE tool when one of several ends, and to thinking when none remain', () => {
    let s = fold(promptSent, toolStart('a', 'Bash'), toolStart('b', 'Edit'), toolStart('c', 'Grep'));
    s = reduce(s, toolEnd('c'));
    assert.deepEqual(view(s), { ph: 'tool', tl: 'Edit', pend: 0 });
    s = reduce(s, toolEnd('b'));
    assert.deepEqual(view(s), { ph: 'tool', tl: 'Bash', pend: 0 });
    s = reduce(s, toolEnd('a'));
    assert.deepEqual(view(s), { ph: 'thinking', tl: '', pend: 0 });
  });

  it('skips a tool that already ended when the newest one ends (not "the one before it in start order")', () => {
    // Start order a, b, c; b ends first, so when c ends the answer is a, not b.
    let s = fold(promptSent, toolStart('a', 'Bash'), toolStart('b', 'Edit'), toolStart('c', 'Grep'), toolEnd('b'));
    assert.equal(view(s).tl, 'Grep');
    s = reduce(s, toolEnd('c'));
    assert.deepEqual(view(s), { ph: 'tool', tl: 'Bash', pend: 0 });
  });

  it('keeps the older tool shown when a NEWER tool starts and an OLDER one ends', () => {
    let s = fold(promptSent, toolStart('a', 'Bash'), toolStart('b', 'Edit'), toolEnd('a'));
    assert.equal(view(s).tl, 'Edit');
    s = reduce(s, toolStart('c', 'Grep'));
    assert.equal(view(s).tl, 'Grep');
    s = reduce(s, toolEnd('c'));
    assert.equal(view(s).tl, 'Edit');
  });

  it('ignores a tool_end for an id it never saw, without disturbing the tools that are active', () => {
    const s = fold(promptSent, toolStart('a', 'Bash'), toolStart('b', 'Edit'));
    const after = reduce(s, toolEnd('zzz'));
    assert.equal(after, s);
    assert.deepEqual(view(after), { ph: 'tool', tl: 'Edit', pend: 0 });
  });

  it('ignores a tool_end that arrives twice', () => {
    const s = fold(promptSent, toolStart('a', 'Bash'), toolStart('b', 'Edit'), toolEnd('b'));
    assert.deepEqual(view(reduce(s, toolEnd('b'))), { ph: 'tool', tl: 'Bash', pend: 0 });
  });

  it('records a tool once however often its start is reported, so a single end clears it', () => {
    // A streamed tool_use block followed by the complete message reports the same id twice.
    const s = fold(promptSent, toolStart('a', 'Bash'), toolStart('a', 'Edit'), toolStart('a', 'Bash'));
    assert.equal(s.tools.length, 1);
    assert.equal(view(s).tl, 'Bash', 'the first report names it');
    assert.equal(phaseOf(reduce(s, toolEnd('a'))), 'thinking', 'no ghost entry left to pin the phase on tool');
  });

  it('caps the tools it remembers, dropping the OLDEST, so a tool that never ends cannot grow it forever', () => {
    let s = fold(promptSent);
    for (let n = 0; n < 40; n++) s = reduce(s, toolStart(`t${n}`, `Tool${n}`));
    assert.ok(s.tools.length <= 32, `${s.tools.length} tools remembered`);
    assert.equal(view(s).tl, 'Tool39', 'the newest is still the one shown');
    // The dropped ones are gone, not hidden: ending the kept ones leaves nothing behind.
    for (let n = 39; n >= 8; n--) s = reduce(s, toolEnd(`t${n}`));
    assert.equal(phaseOf(s), 'thinking');
    assert.equal(s.tools.length, 0);
  });

  it('drops every tool at a terminal event, ended or not', () => {
    const s = fold(promptSent, toolStart('a'), toolStart('b'), result());
    assert.equal(s.tools.length, 0);
    assert.equal(phaseOf(reduce(s, promptSent)), 'thinking', 'the next turn starts with none');
  });

  it('a new turn does not inherit tools from one that never ended them', () => {
    const s = fold(promptSent, toolStart('a'), fatal, promptSent);
    assert.deepEqual(view(s), { ph: 'thinking', tl: '', pend: 0 });
  });

  it('ignores a tool_start with an id that cannot be matched later', () => {
    const s = fold(promptSent);
    assert.equal(reduce(s, { k: 'tool_start', id: 7 as unknown as string, name: 'Bash' }), s);
  });
});

// ---------------------------------------------------------------------------
// Hostile names: the reducer is the last thing between a model and the panel
// ---------------------------------------------------------------------------

const HOSTILE_NAMES: readonly string[] = [
  '', ' ', '\n\t ', '\0', '\0\0\0', 'a\nb', '\u202eevil\u202c', '\u200b\u200d',
  'caf\u00e9', 'na\u00efve\u0301', '\u{1F600}', '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}', '\u4e2d\u6587',
  '\ud800', '\udc00', 'cut \ud83d', 'mcp__a_very_long_server_name__a_very_long_tool_name',
  'x'.repeat(100_000), '\u00e9'.repeat(100_000), '"'.repeat(5000),
];

describe('hostile tool and ask labels', () => {
  const labelsOf = (name: string): string[] => [
    view(fold(promptSent, toolStart('a', name))).tl,
    view(fold(promptSent, asks(1, name))).tl,
  ];

  it('never shows a label that is empty, over the limit, or not printable ASCII', () => {
    for (const name of HOSTILE_NAMES) {
      for (const tl of labelsOf(name)) {
        assert.ok(tl.length >= 1 && tl.length <= LIMITS.labelMax, `${JSON.stringify(name.slice(0, 20))} -> ${JSON.stringify(tl)}`);
        assert.ok(isPrintableAscii(tl), `${JSON.stringify(tl)} is not printable ASCII`);
        assert.equal(tl, tl.trim(), 'no stray edge whitespace on a 25-column panel');
      }
    }
  });

  it('turns names into the labels a player would expect', () => {
    assert.equal(labelsOf('Bash')[0], 'Bash');
    assert.equal(labelsOf('caf\u00e9')[0], 'cafe');
    assert.equal(labelsOf('a\nb')[0], 'a b');
    assert.equal(labelsOf('\u{1F600}')[0], '?');
    assert.equal(labelsOf('x'.repeat(100_000))[0], 'x'.repeat(LIMITS.labelMax - 3) + '...');
    assert.equal(labelsOf('Bash'.padEnd(LIMITS.labelMax, '-'))[0], 'Bash'.padEnd(LIMITS.labelMax, '-'), 'exactly at the limit is not truncated');
  });

  it('gives a name with nothing to show a placeholder instead of a blank label', () => {
    for (const name of ['', ' ', '\n\t ', '\0', '\u200b\u200d']) {
      assert.deepEqual(labelsOf(name), ['tool', 'tool'], JSON.stringify(name));
    }
  });

  it('survives values that are not strings at all', () => {
    const odd: unknown[] = [undefined, null, 42, {}, [], { toString() { throw new Error('boom'); } }];
    for (const name of odd) {
      const s = reduce(fold(promptSent), { k: 'tool_start', id: 'a', name } as unknown as StateInput);
      assert.deepEqual(view(s), { ph: 'tool', tl: 'tool', pend: 0 });
      const a = reduce(fold(promptSent), { k: 'asks', count: 1, label: name } as unknown as StateInput);
      assert.deepEqual(view(a), { ph: 'asking', tl: 'tool', pend: 1 });
    }
  });

  it('is linear in the size of the name', () => {
    const t0 = performance.now();
    reduce(fold(promptSent), toolStart('a', 'x'.repeat(1_000_000)));
    reduce(fold(promptSent), asks(1, '\u{1F600}'.repeat(300_000)));
    const ms = performance.now() - t0;
    assert.ok(ms < BUDGET_MS, `took ${Math.round(ms)} ms`);
  });

  it('is accepted by the wire encoder (the caller), and decodes back to the same message', () => {
    for (const name of HOSTILE_NAMES) {
      for (const s of [fold(promptSent, toolStart('a', name)), fold(promptSent, asks(2, name))]) {
        const msg = toStateMsg(s, 9);
        const wire = encodeBridgeMsg(msg); // throws RangeError on any limit or charset violation
        assert.deepEqual(decodeBridgeMsg(wire), { ok: true, msg });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Asks
// ---------------------------------------------------------------------------

describe('asks', () => {
  it('beat a running tool and thinking, name the head ask and count them all', () => {
    const t = fold(promptSent, toolStart('a', 'Grep'), asks(2, 'Edit'));
    assert.deepEqual(view(t), { ph: 'asking', tl: 'Edit', pend: 2 });
    const th = fold(promptSent, asks(1, 'Bash'));
    assert.deepEqual(view(th), { ph: 'asking', tl: 'Bash', pend: 1 });
  });

  it('give back what was underneath, not idle', () => {
    const tool = fold(promptSent, toolStart('a', 'Grep'), asks(1, 'Bash'), asks(0));
    assert.deepEqual(view(tool), { ph: 'tool', tl: 'Grep', pend: 0 });
    const thinking = fold(promptSent, asks(1, 'Bash'), asks(0));
    assert.deepEqual(view(thinking), { ph: 'thinking', tl: '', pend: 0 });
  });

  it('follow the head ask as the queue drains, and report each change', () => {
    let s = fold(promptSent, asks(3, 'Bash'));
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Bash', pend: 3 });
    s = reduce(s, asks(2, 'Edit'));
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Edit', pend: 2 });
    s = reduce(s, asks(2, 'Write')); // same count, different head
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Write', pend: 2 });
    s = reduce(s, asks(1, 'Write')); // same head, fewer waiting
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Write', pend: 1 });
  });

  it('keep asking while the tools under them come and go', () => {
    let s = fold(promptSent, toolStart('a', 'Bash'), asks(1, 'Bash'));
    s = reduce(s, toolEnd('a'));
    assert.equal(phaseOf(s), 'asking', 'the ask is still open even though its tool ended');
    s = reduce(s, toolStart('b', 'Edit'));
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Bash', pend: 1 });
    s = reduce(s, asks(0));
    assert.deepEqual(view(s), { ph: 'tool', tl: 'Edit', pend: 0 });
  });

  it('have no label once none are open', () => {
    const s = fold(promptSent, asks(2, 'Bash'), asks(0, 'Bash'));
    assert.equal(s.askLabel, '');
    assert.equal(s.asks, 0);
    assert.deepEqual(view(s), { ph: 'thinking', tl: '', pend: 0 });
  });

  it('treat a count that is not a count as none (nothing is asked on a guess)', () => {
    for (const bad of [Number.NaN, -1, -0.5, 0.9, Infinity, -Infinity]) {
      const s = reduce(fold(promptSent), asks(bad, 'Bash'));
      assert.deepEqual(view(s), { ph: 'thinking', tl: '', pend: 0 }, String(bad));
    }
    for (const bad of ['3', null, undefined, {}, [2]]) {
      const s = reduce(fold(promptSent), { k: 'asks', count: bad, label: 'Bash' } as unknown as StateInput);
      assert.equal(phaseOf(s), 'thinking', String(bad));
    }
  });

  it('round fractions down and clamp huge counts to what the wire can carry', () => {
    assert.equal(view(reduce(fold(promptSent), asks(2.9, 'Bash'))).pend, 2);
    const huge = toStateMsg(reduce(fold(promptSent), asks(1e15, 'Bash')), 1);
    assert.equal(huge.pend, 2147483647);
    assert.doesNotThrow(() => encodeBridgeMsg(huge));
  });

  it('outlive their turn: a terminal event leaves them as the approval manager reported them', () => {
    // The state's `asks` is a report of what is open, so only an `asks` input changes it. The
    // old rule (a terminal event zeroed it) made the server re-read the manager after every
    // ending, and a caller that forgot told the device `idle, pend 0` with an ask on its screen.
    for (const end of [result(), result(false), fatal, stopped]) {
      const s = fold(promptSent, asks(2, 'Bash'), end);
      assert.equal(s.asks, 2, JSON.stringify(end));
      assert.equal(s.askLabel, 'Bash');
      assert.deepEqual(view(s), { ph: 'asking', tl: 'Bash', pend: 2 });
      // ...and it goes away exactly when the manager says so, resting where the turn left it.
      assert.deepEqual(view(reduce(s, asks(0))), { ph: s.base === 'idle' ? 'idle' : s.base, tl: '', pend: 0 });
    }
  });

  it('a settled turn does not hide an ask that is still open, nor does the next prompt drop it', () => {
    const s = fold(promptSent, asks(1, 'Edit'), result(), settle);
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Edit', pend: 1 });
    assert.deepEqual(view(reduce(s, asks(0))), { ph: 'idle', tl: '', pend: 0 }, 'closed at last: back to rest');
    assert.deepEqual(view(reduce(s, promptSent)), { ph: 'asking', tl: 'Edit', pend: 1 }, 'a new turn is no reason to forget it');
  });

  it('are shown even with no turn running, because an open ask is a fact, and settle back afterwards', () => {
    // The decision: an ask is reported by the approval manager, not by the turn. Hiding
    // it would leave the panel idle while an approval waits for a tap.
    const idle = fold(asks(1, 'Bash'));
    assert.deepEqual(view(idle), { ph: 'asking', tl: 'Bash', pend: 1 });
    assert.deepEqual(view(reduce(idle, asks(0))), { ph: 'idle', tl: '', pend: 0 });
    assert.equal(phaseOf(fold(listenStart, asks(1, 'Bash'), asks(0))), 'listening');
    assert.equal(phaseOf(fold(promptSent, result(), asks(1, 'Bash'), asks(0))), 'done');
  });

  it('do not by themselves start a turn', () => {
    const s = fold(asks(1, 'Bash'));
    assert.equal(isTurnRunning(s), false);
    assert.equal(isTurnRunning(fold(promptSent)), true);
  });
});

// ---------------------------------------------------------------------------
// Terminal events
// ---------------------------------------------------------------------------

describe('terminal events', () => {
  it('reads a result as a success only when ok is a real true', () => {
    // The driver's type says boolean, but this is the line between "done" and "error".
    for (const ok of ['false', 'yes', 1, null, undefined] as unknown[]) {
      const bad = { k: 'result', ok, text: '', subtype: 'success' } as unknown as StateInput;
      assert.equal(phaseOf(fold(promptSent, bad)), 'error', String(ok));
    }
    assert.equal(phaseOf(fold(promptSent, result(true))), 'done');
  });

  it('end the turn once: a second terminal event for the same turn changes nothing', () => {
    const done = fold(promptSent, result());
    assert.equal(reduce(done, result(false)), done);
    assert.equal(reduce(done, fatal), done);
    const failed = fold(promptSent, fatal);
    assert.equal(reduce(failed, result()), failed);
  });
});

// ---------------------------------------------------------------------------
// A user stop
// ---------------------------------------------------------------------------

describe('a user abort', () => {
  it('turns the terminal result that follows into idle, not an error', () => {
    for (const end of [stopped, result(false), result(true), result(false, 'error_during_execution')]) {
      const s = fold(promptSent, aborted, end);
      assert.deepEqual(view(s), { ph: 'idle', tl: '', pend: 0 }, JSON.stringify(end));
    }
  });

  it('is decided by the user, not by the subtype: the same result without an abort is an error', () => {
    // Companion to the test above. If idle came from reading `subtype`, the line above
    // would pass with the flag deleted.
    assert.equal(phaseOf(fold(promptSent, stopped)), 'error');
    assert.equal(phaseOf(fold(promptSent, result(false))), 'error');
  });

  it('keeps showing the turn until its terminal event arrives', () => {
    const s = fold(promptSent, toolStart('a', 'Bash'), asks(1, 'Bash'), aborted);
    assert.deepEqual(view(s), { ph: 'asking', tl: 'Bash', pend: 1 });
    const closed = after(s, asks(0), toolEnd('a', false));
    assert.deepEqual(view(closed), { ph: 'thinking', tl: '', pend: 0 }, 'winding down, the turn has not ended');
    assert.deepEqual(view(reduce(closed, stopped)), { ph: 'idle', tl: '', pend: 0 });
  });

  it('still reports a fatal as an error: the session died, and that is not the user stopping', () => {
    assert.equal(phaseOf(fold(promptSent, aborted, fatal)), 'error');
  });

  it('does not leak into the next turn', () => {
    const ended = fold(promptSent, aborted, stopped);
    assert.equal(ended.aborting, false, 'the terminal event consumes the stop');
    const next = reduce(ended, promptSent);
    assert.equal(next.aborting, false);
    assert.equal(phaseOf(reduce(next, result())), 'done');
    assert.equal(phaseOf(reduce(next, result(false))), 'error');
  });

  it('is ignored when there is no turn to stop, so it cannot swallow the next result', () => {
    // The mechanism-engaged companion for "an abort at rest changes nothing": an abort
    // in each resting phase, then a normal turn that must end `done`.
    for (const rest of [initialState, AT.done!, AT.error!, AT.listening!, AT.transcribing!]) {
      const s = reduce(rest, aborted);
      assert.equal(s, rest, `abort from ${phaseOf(rest)} must change nothing`);
      assert.equal(phaseOf(after(s, promptSent, result())), 'done', `after an abort from ${phaseOf(rest)}`);
    }
  });

  it('does not survive a turn that ended without anyone reading it', () => {
    // Aborted, then the driver dies: the fatal clears the flag, and the next turn is normal.
    assert.equal(phaseOf(fold(promptSent, aborted, fatal, promptSent, result())), 'done');
  });

  it('being sent twice is the same as once', () => {
    const once = fold(promptSent, aborted);
    assert.equal(reduce(once, aborted), once);
  });
});

// ---------------------------------------------------------------------------
// Whole turns, in the order the bridge produces them
// ---------------------------------------------------------------------------

/** Replays inputs and records what the device would have been told after each. */
function replay(steps: ReadonlyArray<readonly [StateInput, Phase, string?, number?]>): void {
  let s = initialState;
  steps.forEach(([input, ph, tl, pend], n) => {
    s = reduce(s, input);
    const got = view(s);
    assert.equal(got.ph, ph, `step ${n} ${JSON.stringify(input)}: phase`);
    if (tl !== undefined) assert.equal(got.tl, tl, `step ${n} ${JSON.stringify(input)}: label`);
    if (pend !== undefined) assert.equal(got.pend, pend, `step ${n} ${JSON.stringify(input)}: pend`);
  });
}

describe('whole turns', () => {
  it('a dictated request that waits for one approval', () => {
    replay([
      [listenStart, 'listening'],
      [listenStop, 'transcribing'],
      [sttDone, 'idle'],                 // the transcript is shown; nothing runs yet
      [promptSent, 'thinking'],          // the player's SEND, as a `say`
      [{ k: 'session', id: 's1' }, 'thinking'],
      [{ k: 'text', text: 'I will run the tests.' }, 'thinking'],
      [toolStart('t1', 'Bash'), 'tool', 'Bash', 0],
      [asks(1, 'Bash'), 'asking', 'Bash', 1],
      [asks(0), 'tool', 'Bash', 0],
      [toolEnd('t1'), 'thinking', '', 0],
      [{ k: 'text', text: 'All green.' }, 'thinking'],
      [result(), 'done', '', 0],
      [settle, 'idle', '', 0],
    ]);
  });

  it('a typed request whose tool is denied still ends in done: refusing is not failing', () => {
    replay([
      [promptSent, 'thinking'],
      [toolStart('t1', 'Bash'), 'tool', 'Bash'],
      [asks(1, 'Bash'), 'asking', 'Bash', 1],
      [asks(0), 'tool', 'Bash', 0],
      [toolEnd('t1', false), 'thinking'],
      [result(), 'done'],
    ]);
  });

  it('two tools that both ask at once, answered one after the other', () => {
    replay([
      [promptSent, 'thinking'],
      [toolStart('a', 'Bash'), 'tool', 'Bash'],
      [toolStart('b', 'Edit'), 'tool', 'Edit'],
      [asks(2, 'Bash'), 'asking', 'Bash', 2],  // the older ask is presented first
      [asks(1, 'Edit'), 'asking', 'Edit', 1],  // Bash answered; Edit is next
      [toolEnd('a'), 'asking', 'Edit', 1],     // Bash finished while Edit is still being asked about
      [asks(0), 'tool', 'Edit', 0],
      [toolEnd('b'), 'thinking', '', 0],
      [result(), 'done'],
    ]);
  });

  it('parallel tools that run with no ask at all', () => {
    replay([
      [promptSent, 'thinking'],
      [toolStart('a', 'Grep'), 'tool', 'Grep'],
      [toolStart('b', 'Read'), 'tool', 'Read'],
      [toolStart('c', 'Glob'), 'tool', 'Glob'],
      [toolEnd('b'), 'tool', 'Glob'],
      [toolEnd('c'), 'tool', 'Grep'],
      [toolEnd('a'), 'thinking', ''],
      [result(), 'done'],
    ]);
  });

  it('sequential tools return to thinking between calls', () => {
    replay([
      [promptSent, 'thinking'],
      [toolStart('a', 'Read'), 'tool', 'Read'],
      [toolEnd('a'), 'thinking'],
      [toolStart('b', 'Edit'), 'tool', 'Edit'],
      [asks(1, 'Edit'), 'asking', 'Edit', 1],
      [asks(0), 'tool', 'Edit'],
      [toolEnd('b'), 'thinking'],
      [result(), 'done'],
    ]);
  });

  it('a turn the user stops while an approval is open, then a normal one', () => {
    replay([
      [promptSent, 'thinking'],
      [toolStart('a', 'Bash'), 'tool', 'Bash'],
      [asks(1, 'Bash'), 'asking', 'Bash', 1],
      [aborted, 'asking', 'Bash', 1],
      [asks(0), 'tool', 'Bash', 0],
      [toolEnd('a', false), 'thinking'],
      [stopped, 'idle', '', 0],
      // The very next turn is unaffected by the stop.
      [promptSent, 'thinking'],
      [toolStart('b', 'Read'), 'tool', 'Read'],
      [toolEnd('b'), 'thinking'],
      [result(), 'done'],
    ]);
  });

  it('a turn that fails, and one after it that fails differently', () => {
    replay([
      [promptSent, 'thinking'],
      [result(false), 'error'],
      [{ k: 'text', text: 'late narration' }, 'error'],   // sticky until something happens
      [result(), 'error'],                                // a repeat does not rewrite history
      [promptSent, 'thinking'],
      [toolStart('a', 'Bash'), 'tool', 'Bash'],
      [fatal, 'error', '', 0],
      [settle, 'idle'],
    ]);
  });

  it('a recording that is cancelled, and one that is heard but empty', () => {
    replay([
      [listenStart, 'listening'],
      [listenCancel, 'idle'],
      [listenStart, 'listening'],
      [listenStop, 'transcribing'],
      [listenCancel, 'idle'], // the transcript was empty: the server cancels
      [listenStart, 'listening'],
    ]);
  });

  it('a second request straight after the first finishes, without settling', () => {
    replay([
      [promptSent, 'thinking'],
      [result(), 'done'],
      [listenStart, 'listening'],
      [listenStop, 'transcribing'],
      [sttDone, 'idle'],
      [promptSent, 'thinking'],
      [result(), 'done'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

describe('purity', () => {
  const noops: ReadonlyArray<readonly [string, BridgeState, StateInput]> = [
    ['session event', AT.thinking!, { k: 'session', id: 'x' }],
    ['text event', AT.tool!, { k: 'text', text: 'hi' }],
    ['duplicate tool_start', AT.tool!, toolStart('t1', 'Other')],
    ['unknown tool_end', AT.tool!, toolEnd('nope')],
    ['the same asks again', AT.asking!, asks(1, 'Bash')],
    ['asks 0 with none open', AT.thinking!, asks(0)],
    ['abort twice', fold(promptSent, aborted), aborted],
    ['stray result at rest', AT.idle!, result()],
    ['stray tool_start at rest', AT.idle!, toolStart('x')],
    ['listen_stop at rest', AT.idle!, listenStop],
    ['prompt_sent during a turn', AT.tool!, promptSent],
    ['settle during a turn', AT.thinking!, settle],
  ];

  for (const [name, s, input] of noops) {
    it(`returns the SAME object for ${name}, so "next === prev" means "send nothing"`, () => {
      assert.equal(reduce(s, input), s);
    });
  }

  it('returns a different object when something did change (the companion that makes the above mean something)', () => {
    for (const [s, input] of [
      [AT.thinking!, toolStart('x')],
      [AT.asking!, asks(2, 'Bash')],
      [AT.idle!, listenStart],
      [AT.done!, settle],
    ] as const) {
      assert.notEqual(reduce(s, input), s);
    }
  });

  it('freezes every state it hands out, tools included, so nobody can edit one by accident', () => {
    const s = fold(promptSent, toolStart('a'), toolStart('b'), asks(1, 'Bash'));
    assert.ok(Object.isFrozen(initialState) && Object.isFrozen(s) && Object.isFrozen(s.tools));
    for (const t of s.tools) assert.ok(Object.isFrozen(t));
    assert.throws(() => { (s as { asks: number }).asks = 5; }, TypeError);
    assert.throws(() => { (s.tools as ActiveTool[]).push({ id: 'z', label: 'z' }); }, TypeError);
    assert.ok(Object.isFrozen(fold(promptSent, result())), 'the terminal state too');
    assert.ok(Object.isFrozen(fold(promptSent, toolStart('a'), toolEnd('a'))), 'and one after a tool ended');
  });

  it('does not modify the state it is given, for any input', () => {
    const inputs: StateInput[] = [
      listenStart, listenStop, listenCancel, sttDone, promptSent, aborted, settle, result(), fatal, stopped,
      toolStart('a'), toolStart('t1'), toolEnd('t1'), toolEnd('q'), asks(0), asks(2, 'X'), { k: 'text', text: 't' },
    ];
    for (const s of Object.values(AT)) {
      const before = JSON.stringify(s);
      for (const i of inputs) reduce(s, i);
      assert.equal(JSON.stringify(s), before);
    }
  });

  it('ignores an input kind it has never heard of, instead of throwing', () => {
    const s = fold(promptSent);
    assert.equal(reduce(s, { k: 'warp_drive' } as unknown as StateInput), s);
  });

  it('is a function of its inputs: the same sequence gives the same states', () => {
    const run = (): string => {
      let s = initialState;
      const seen: string[] = [];
      for (const i of [promptSent, toolStart('a'), asks(1, 'Bash'), asks(0), toolEnd('a'), result()]) {
        s = reduce(s, i);
        seen.push(JSON.stringify(toStateMsg(s, 3)));
      }
      return seen.join('\n');
    };
    assert.equal(run(), run());
  });
});

// ---------------------------------------------------------------------------
// toStateMsg
// ---------------------------------------------------------------------------

describe('toStateMsg', () => {
  it('writes the message in wire order, with the seq the caller supplies', () => {
    const m = toStateMsg(fold(promptSent, toolStart('a', 'Bash'), asks(2, 'Edit')), 17);
    assert.deepEqual(m, { t: 'state', seq: 17, ph: 'asking', tl: 'Edit', pend: 2 });
    assert.deepEqual(Object.keys(m), ['t', 'seq', 'ph', 'tl', 'pend']);
    assert.equal(toStateMsg(initialState, 1).seq, 1);
    assert.equal(toStateMsg(initialState, 2147483647).seq, 2147483647);
  });

  it('leaves tl empty outside tool and asking, and fills it inside them', () => {
    // The state only ever holds a label while a tool or an ask exists, so this rule holds
    // by construction and toStateMsg states it again as the wire format's own rule. The
    // fuzz below checks it over thousands of sequences.
    for (const s of [AT.idle!, AT.listening!, AT.transcribing!, AT.thinking!, AT.done!, AT.error!]) {
      assert.equal(toStateMsg(s, 1).tl, '', phaseOf(s));
    }
    assert.equal(toStateMsg(AT.tool!, 1).tl, 'Bash', 'and the companion: tool does show it');
    assert.equal(toStateMsg(AT.asking!, 1).tl, 'Bash', 'as does asking');
  });

  it('reports the number of open asks as pend, in every phase', () => {
    assert.equal(toStateMsg(fold(asks(2, 'A')), 1).pend, 2);
    assert.equal(toStateMsg(fold(promptSent, toolStart('a'), asks(3, 'A')), 1).pend, 3);
    assert.equal(toStateMsg(fold(promptSent, toolStart('a')), 1).pend, 0);
    assert.equal(toStateMsg(fold(promptSent, asks(1, 'A'), result()), 1).pend, 1, 'an ask outlives the turn that raised it');
  });

  it('is accepted by the wire encoder in every phase', () => {
    for (const s of Object.values(AT)) {
      const msg = toStateMsg(s, 4);
      assert.deepEqual(decodeBridgeMsg(encodeBridgeMsg(msg)), { ok: true, msg });
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

const FUZZ_NAMES: readonly string[] = [
  'Bash', 'Edit', 'Read', 'Grep', '', ' ', 'x'.repeat(5000), '\u{1F600}', 'caf\u00e9', '\0', 'a\nb', '\u202eevil',
  'mcp__server__a_long_tool_name', '\ud800', '"quoted"',
];
const FUZZ_IDS: readonly string[] = ['a', 'b', 'c', 'd', 'e', '', 'x'.repeat(2000)];
const FUZZ_COUNTS: readonly number[] = [0, 0, 1, 1, 2, 3, 7, -1, Number.NaN, 1.5, Infinity, 1e15];

function randomInput(rand: () => number): StateInput {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const r = rand() * 100;
  if (r < 6) return promptSent;
  if (r < 10) return listenStart;
  if (r < 13) return listenStop;
  if (r < 15) return listenCancel;
  if (r < 17) return sttDone;
  if (r < 29) return { k: 'tool_start', id: pick(FUZZ_IDS), name: pick(FUZZ_NAMES) };
  if (r < 39) return { k: 'tool_end', id: pick(FUZZ_IDS), ok: rand() < 0.5 };
  if (r < 49) return { k: 'asks', count: pick(FUZZ_COUNTS), label: pick(FUZZ_NAMES) };
  if (r < 53) return { k: 'result', ok: rand() < 0.5, text: pick(FUZZ_NAMES), subtype: pick(['success', 'interrupted', '']) };
  if (r < 54) return { k: 'fatal', msg: pick(FUZZ_NAMES) };
  if (r < 56) return aborted;
  if (r < 59) return settle;
  if (r < 60) return { k: 'session', id: pick(FUZZ_IDS) };
  if (r < 62) return { k: 'text', text: pick(FUZZ_NAMES) };
  return { k: 'tool_start', id: pick(FUZZ_IDS), name: pick(FUZZ_NAMES) };
}

describe('fuzz: 5000 random inputs from a seeded generator', () => {
  for (const seed of [1, 2, 3, 0xc0ffee, 20260101]) {
    it(`holds every invariant (seed ${seed})`, () => {
      const rand = rng(seed);
      let s = initialState;
      const visited = new Set<Phase>();
      let withLabel = 0;
      let seq = 0;
      for (let n = 0; n < 5000; n++) {
        const input = randomInput(rand);
        const before = JSON.stringify(s);
        const prevPhase = phaseOf(s);
        const prevAsks = s.asks;
        const prevLabel = s.askLabel;
        const next = reduce(s, input);
        assert.equal(JSON.stringify(s), before, `step ${n}: the previous state was modified by ${input.k}`);
        s = next;
        // The one rule about asks: they are a report, and only a report changes them.
        if (input.k !== 'asks') {
          assert.equal(s.asks, prevAsks, `step ${n}: ${input.k} changed the number of open asks`);
          assert.equal(s.askLabel, prevLabel, `step ${n}: ${input.k} changed the label of the open ask`);
        }

        const msg = toStateMsg(s, ++seq);
        const where = `step ${n} (${input.k}) -> ${JSON.stringify({ ph: msg.ph, tl: msg.tl.slice(0, 20), pend: msg.pend })}`;
        visited.add(msg.ph);

        assert.ok(PHASES.includes(msg.ph), where);
        assert.ok(msg.tl.length <= LIMITS.labelMax, where);
        assert.ok(isPrintableAscii(msg.tl), where);
        assert.ok(Number.isInteger(msg.pend) && msg.pend >= 0, where);
        assert.ok(msg.pend <= 2147483647, where);
        assert.ok(s.tools.length <= 32, where);
        if (msg.ph !== 'tool' && msg.ph !== 'asking') assert.equal(msg.tl, '', where);
        else { assert.ok(msg.tl.length >= 1, `${where}: a tool or ask with no label`); withLabel++; }
        // Asks beat everything, so "asking" and "an ask is open" are the same fact.
        assert.equal(msg.ph === 'asking', msg.pend > 0, where);
        // Tools only exist inside a turn.
        if (s.tools.length > 0) assert.equal(s.base, 'thinking', where);
        // A terminal event ends a turn that was visibly running; nothing was open (an open ask
        // would have shown as `asking`), so nothing is open afterwards either.
        if ((input.k === 'result' || input.k === 'fatal') && (prevPhase === 'thinking' || prevPhase === 'tool')) {
          assert.ok(msg.ph === 'done' || msg.ph === 'error' || msg.ph === 'idle', where);
          assert.equal(msg.pend, 0, where);
          assert.equal(s.tools.length, 0, where);
        }
        // What the codec sees must be encodable and must decode to the same message.
        assert.deepEqual(decodeBridgeMsg(encodeBridgeMsg(msg)), { ok: true, msg }, where);
      }
      // The run has to have been somewhere interesting, or "no invalid state" proves nothing.
      for (const p of REACHABLE) assert.ok(visited.has(p), `seed ${seed} never reached ${p}`);
      assert.ok(withLabel > 100, `only ${withLabel} labelled states`);
    });
  }
});
