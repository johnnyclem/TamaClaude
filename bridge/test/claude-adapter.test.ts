/**
 * Adapter tests, driven with hand-built messages in the SDK's own shapes.
 *
 * The builders below are typed against the SDK where the typings let them be (stream
 * events, user messages) so a renamed field in a future SDK is a compile error here, not
 * a silent no-op. Messages with dozens of required bookkeeping fields (init, assistant,
 * result) go through `sdk()`, the one unavoidable cast.
 *
 * The rules under test are the adapter's guarantees: tools are balanced, narration is
 * only ever log text, a cut-off stream cannot strand a tool, and a subagent cannot end
 * the user's turn. The property test at the bottom checks the balance rule over
 * thousands of generated sequences instead of the handful written out by hand.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from '../src/drivers/claude-adapter.ts';
import type { DriverEvent } from '../src/types.ts';

const SID = 'sess-1';
const UUID0 = '00000000-0000-4000-8000-000000000000';

/**
 * The only cast in this file's builders. SDKMessage variants carry usage tables, cost
 * counters and other fields the adapter never reads; spelling them all out would bury
 * the part each test is about. What a test passes is exactly the subset of the real
 * shape that the adapter looks at.
 */
function sdk(partial: Record<string, unknown>): SDKMessage {
  return { uuid: UUID0, session_id: SID, ...partial } as unknown as SDKMessage;
}

type StreamEvent = Extract<SDKMessage, { type: 'stream_event' }>['event'];

function stream(event: StreamEvent, parent: string | null = null): SDKMessage {
  return { type: 'stream_event', event, parent_tool_use_id: parent, uuid: UUID0, session_id: SID };
}

const init = (id = SID): SDKMessage => sdk({ type: 'system', subtype: 'init', session_id: id });

const messageStart = (parent: string | null = null): SDKMessage =>
  stream(
    // BetaMessage has a dozen required fields the adapter ignores.
    { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } } as unknown as StreamEvent,
    parent,
  );
const messageStop = (parent: string | null = null): SDKMessage => stream({ type: 'message_stop' }, parent);
const blockStop = (index: number, parent: string | null = null): SDKMessage =>
  stream({ type: 'content_block_stop', index }, parent);

const toolBlockStart = (index: number, id: string, name = 'Bash', parent: string | null = null): SDKMessage =>
  stream({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} } }, parent);

const textBlockStart = (index: number): SDKMessage =>
  stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '', citations: null } });

const textDelta = (index: number, text: string): SDKMessage =>
  stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
const jsonDelta = (index: number, partial: string): SDKMessage =>
  stream({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partial } });
const thinkingDelta = (index: number, thinking: string): SDKMessage =>
  stream({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking, estimated_tokens: null } });

function assistant(content: unknown[], extra: Record<string, unknown> = {}): SDKMessage {
  return sdk({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content },
    parent_tool_use_id: null,
    ...extra,
  });
}
const assistantText = (text: string, extra: Record<string, unknown> = {}): SDKMessage =>
  assistant([{ type: 'text', text }], extra);
const assistantTool = (id: string, name = 'Bash', extra: Record<string, unknown> = {}): SDKMessage =>
  assistant([{ type: 'tool_use', id, name, input: {} }], extra);

function toolResults(...results: { id: string; isError?: boolean }[]): SDKMessage {
  const msg: SDKUserMessage = {
    type: 'user',
    message: {
      role: 'user',
      content: results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: 'output',
        ...(r.isError === undefined ? {} : { is_error: r.isError }),
      })),
    },
    parent_tool_use_id: null,
  };
  return msg;
}

const resultOk = (text: string, extra: Record<string, unknown> = {}): SDKMessage =>
  sdk({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra });
const resultErr = (subtype: string, extra: Record<string, unknown> = {}): SDKMessage =>
  sdk({ type: 'result', subtype, is_error: true, errors: ['boom'], ...extra });

function feed(a: ClaudeAdapter, ...msgs: SDKMessage[]): DriverEvent[] {
  return msgs.flatMap((m) => a.map(m));
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

test('init becomes a session event, once per distinct id', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(init('abc')), [{ k: 'session', id: 'abc' }]);
  assert.deepEqual(a.map(init('abc')), [], 'the CLI repeats init every turn; the same id is not news');
  assert.deepEqual(a.map(init('def')), [{ k: 'session', id: 'def' }]);
});

test('a tool_use block start becomes tool_start with the real id and name', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(toolBlockStart(0, 'toolu_1', 'Read')), [{ k: 'tool_start', id: 'toolu_1', name: 'Read' }]);
  assert.equal(a.openToolCount, 1);
});

test('block starts that are not client-side tool calls announce nothing', () => {
  const a = new ClaudeAdapter();
  const events = feed(
    a,
    textBlockStart(0),
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    // A server-side tool is run by the API and never gets a tool_result from us, so announcing
    // it would leave it open for the rest of the turn.
    stream({
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {} },
    } as unknown as StreamEvent),
    stream({
      type: 'content_block_start',
      index: 3,
      content_block: { type: 'mcp_tool_use', id: 'mcptoolu_1', name: 'x', server_name: 's', input: {} },
    } as unknown as StreamEvent),
  );
  assert.deepEqual(events, []);
  assert.equal(a.openToolCount, 0);
});

test('a tool_result block becomes tool_end, ok unless it is an error', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), toolBlockStart(1, 't2'), toolBlockStart(2, 't3'));
  assert.deepEqual(a.map(toolResults({ id: 't1' })), [{ k: 'tool_end', id: 't1', ok: true }]);
  assert.deepEqual(a.map(toolResults({ id: 't2', isError: true })), [{ k: 'tool_end', id: 't2', ok: false }]);
  assert.deepEqual(a.map(toolResults({ id: 't3', isError: false })), [{ k: 'tool_end', id: 't3', ok: true }]);
  assert.equal(a.openToolCount, 0);
});

test('one user message with several tool_results ends each tool, in order', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), toolBlockStart(1, 't2'));
  assert.deepEqual(a.map(toolResults({ id: 't2' }, { id: 't1', isError: true })), [
    { k: 'tool_end', id: 't2', ok: true },
    { k: 'tool_end', id: 't1', ok: false },
  ]);
});

test('a tool_result for a tool that is not open ends nothing', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(toolResults({ id: 'never-started' })), []);
  feed(a, toolBlockStart(0, 't1'));
  a.map(toolResults({ id: 't1' }));
  assert.deepEqual(a.map(toolResults({ id: 't1' })), [], 'a duplicate result must not end the tool twice');
});

test('a complete assistant text block becomes a text event', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(assistantText('I will read the file.')), [{ k: 'text', text: 'I will read the file.' }]);
  assert.deepEqual(a.map(assistantText('   \n')), [], 'whitespace is not narration');
  assert.deepEqual(a.map(assistant([{ type: 'thinking', thinking: 'hmm', signature: 'x' }])), []);
});

test('a result becomes the terminal event', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(resultOk('All done.')), [{ k: 'result', ok: true, text: 'All done.', subtype: 'success' }]);
  // A "success" result can still carry an API error as its text.
  assert.deepEqual(a.map(resultOk('API Error: overloaded', { is_error: true })), [
    { k: 'result', ok: false, text: 'API Error: overloaded', subtype: 'success' },
  ]);
});

test('every error result is a failed terminal with no text, including subtypes added later', () => {
  for (const subtype of [
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
    'error_from_the_future',
  ]) {
    const a = new ClaudeAdapter();
    assert.deepEqual(a.map(resultErr(subtype)), [{ k: 'result', ok: false, text: '', subtype }], subtype);
  }
});

// ---------------------------------------------------------------------------
// Narration
// ---------------------------------------------------------------------------

test('narration deltas are never events; the complete block is logged exactly once', () => {
  const a = new ClaudeAdapter();
  const deltas = feed(
    a,
    messageStart(),
    textBlockStart(0),
    textDelta(0, 'Let me '),
    textDelta(0, 'look at that.'),
    thinkingDelta(0, 'private'),
    blockStop(0),
  );
  assert.deepEqual(deltas, [], 'streaming text must not become anything');
  // Companion: the same narration, complete, is what reaches the log. Without this the
  // assertion above would also pass for an adapter that dropped all text.
  assert.deepEqual(a.map(assistantText('Let me look at that.')), [{ k: 'text', text: 'Let me look at that.' }]);
});

test('input_json deltas of a tool call are not events', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, toolBlockStart(0, 't1'), jsonDelta(0, '{"command":'), jsonDelta(0, '"ls"}'));
  assert.deepEqual(events, [{ k: 'tool_start', id: 't1', name: 'Bash' }]);
});

test('a whole turn with partial messages reads as a short, ordered story', () => {
  const a = new ClaudeAdapter();
  const events = feed(
    a,
    init(),
    messageStart(),
    textBlockStart(0),
    textDelta(0, 'Checking.'),
    blockStop(0),
    assistantText('Checking.'),
    toolBlockStart(1, 'toolu_1', 'Read'),
    jsonDelta(1, '{"file_path":"/a"}'),
    blockStop(1),
    assistantTool('toolu_1', 'Read'),
    stream({ type: 'message_stop' }),
    toolResults({ id: 'toolu_1' }),
    messageStart(),
    textBlockStart(0),
    textDelta(0, 'It is fine.'),
    blockStop(0),
    assistantText('It is fine.'),
    messageStop(),
    resultOk('It is fine.'),
  );
  assert.deepEqual(events, [
    { k: 'session', id: SID },
    { k: 'text', text: 'Checking.' },
    { k: 'tool_start', id: 'toolu_1', name: 'Read' },
    { k: 'tool_end', id: 'toolu_1', ok: true },
    { k: 'text', text: 'It is fine.' },
    { k: 'result', ok: true, text: 'It is fine.', subtype: 'success' },
  ]);
});

// ---------------------------------------------------------------------------
// Tools that are cut off, repeated or never announced by a stream event
// ---------------------------------------------------------------------------

test('a tool block still streaming when its message stops is closed as failed', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, messageStart(), toolBlockStart(0, 't1'), jsonDelta(0, '{"comm'), messageStop());
  assert.deepEqual(events, [
    { k: 'tool_start', id: 't1', name: 'Bash' },
    { k: 'tool_end', id: 't1', ok: false },
  ]);
  assert.equal(a.openToolCount, 0);
  assert.deepEqual(a.map(toolResults({ id: 't1' })), [], 'the closed tool must not be ended a second time');
});

test('a tool block that finished streaming stays open past message_stop until its result', () => {
  // The companion to the test above: without it, "close at message_stop" would pass for an
  // adapter that closed EVERY tool at message_stop, which would show a running tool as done.
  const a = new ClaudeAdapter();
  const events = feed(a, messageStart(), toolBlockStart(0, 't1'), blockStop(0), messageStop());
  assert.deepEqual(events, [{ k: 'tool_start', id: 't1', name: 'Bash' }]);
  assert.equal(a.openToolCount, 1);
  assert.deepEqual(a.map(toolResults({ id: 't1' })), [{ k: 'tool_end', id: 't1', ok: true }]);
});

test('only the cut-off block is closed when its sibling finished', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, toolBlockStart(0, 'done'), blockStop(0), toolBlockStart(1, 'cut'), messageStop());
  assert.deepEqual(events, [
    { k: 'tool_start', id: 'done', name: 'Bash' },
    { k: 'tool_start', id: 'cut', name: 'Bash' },
    { k: 'tool_end', id: 'cut', ok: false },
  ]);
  assert.equal(a.openToolCount, 1);
});

test('a new message_start closes blocks of an abandoned stream', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, toolBlockStart(0, 't1'), messageStart());
  assert.deepEqual(events, [
    { k: 'tool_start', id: 't1', name: 'Bash' },
    { k: 'tool_end', id: 't1', ok: false },
  ]);
});

test('the complete assistant block proves its stream finished, even without content_block_stop', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, toolBlockStart(0, 't1'), assistantTool('t1'), messageStop());
  assert.deepEqual(events, [{ k: 'tool_start', id: 't1', name: 'Bash' }], 'the tool is real and must stay open');
  assert.equal(a.openToolCount, 1);
});

test('without partial messages the complete assistant block announces the tool', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(assistantTool('t1', 'Edit')), [{ k: 'tool_start', id: 't1', name: 'Edit' }]);
  assert.deepEqual(a.map(toolResults({ id: 't1' })), [{ k: 'tool_end', id: 't1', ok: true }]);
});

test('with partial messages the complete assistant block does not announce the tool again', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, toolBlockStart(0, 't1'), blockStop(0), assistantTool('t1'));
  assert.deepEqual(events, [{ k: 'tool_start', id: 't1', name: 'Bash' }]);
});

test('an assistant message truncated by an interrupt closes the tools it names', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), blockStop(0));
  assert.deepEqual(a.map(assistantTool('t1', 'Bash', { aborted: true })), [{ k: 'tool_end', id: 't1', ok: false }]);
  assert.equal(a.openToolCount, 0);
  // And an aborted tool_use that was never announced is not announced now.
  assert.deepEqual(a.map(assistantTool('t2', 'Bash', { aborted: true })), []);
});

test('a result closes any tool still open before it reports the end of the turn', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), blockStop(0), toolBlockStart(1, 't2'), blockStop(1));
  assert.deepEqual(a.map(resultErr('error_during_execution')), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'tool_end', id: 't2', ok: false },
    { k: 'result', ok: false, text: '', subtype: 'error_during_execution' },
  ]);
  assert.equal(a.openToolCount, 0);
});

test('abandon() ends everything open as failed, once', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), toolBlockStart(1, 't2'));
  assert.deepEqual(a.abandon(), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'tool_end', id: 't2', ok: false },
  ]);
  assert.deepEqual(a.abandon(), []);
});

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

test('a result carrying a parent_tool_use_id is not a terminal event', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(resultOk('subagent says hi', { parent_tool_use_id: 'toolu_agent' })), []);
  assert.deepEqual(a.map(resultErr('error_max_turns', { parent_tool_use_id: 'toolu_agent' })), []);
  // Companion: the same message without a parent IS a terminal, so the guard is what made
  // the difference and not some other reason the adapter ignores results.
  assert.equal(a.map(resultOk('main says hi', { parent_tool_use_id: null })).length, 1);
  assert.equal(a.map(resultOk('main says hi')).length, 1);
});

test('a subagent result does not close the tools the main thread has open', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 'agent_call'), blockStop(0));
  a.map(resultOk('x', { parent_tool_use_id: 'agent_call' }));
  assert.equal(a.openToolCount, 1);
});

test('subagent tool activity is forwarded, but its narration is not', () => {
  const a = new ClaudeAdapter();
  const events = feed(
    a,
    toolBlockStart(0, 'agent_call', 'Agent'),
    blockStop(0),
    toolBlockStart(0, 'inner_1', 'Grep', 'agent_call'),
    blockStop(0, 'agent_call'),
    assistantText('subagent thinking out loud', { parent_tool_use_id: 'agent_call' }),
    toolResults({ id: 'inner_1' }),
  );
  assert.deepEqual(events, [
    { k: 'tool_start', id: 'agent_call', name: 'Agent' },
    { k: 'tool_start', id: 'inner_1', name: 'Grep' },
    { k: 'tool_end', id: 'inner_1', ok: true },
  ]);
});

test('a subagent stream ending does not close a block the main thread is still streaming', () => {
  const a = new ClaudeAdapter();
  const events = feed(a, toolBlockStart(0, 'main_tool'), toolBlockStart(0, 'sub_tool', 'Read', 'agent_call'), messageStop('agent_call'));
  assert.deepEqual(events, [
    { k: 'tool_start', id: 'main_tool', name: 'Bash' },
    { k: 'tool_start', id: 'sub_tool', name: 'Read' },
    { k: 'tool_end', id: 'sub_tool', ok: false },
  ]);
  assert.equal(a.openToolCount, 1, 'index 0 exists in both contexts; they must not collide');
});

test('a subagent block with the same index cannot hide a cut-off main-thread block', () => {
  // Index 0 exists in both streams. If they shared one table, the subagent's start would
  // overwrite the main thread's entry and its stop would delete it, and the main thread's
  // cut-off tool would never be closed.
  const a = new ClaudeAdapter();
  const events = feed(
    a,
    toolBlockStart(0, 'main_cut_off'),
    toolBlockStart(0, 'sub_tool', 'Read', 'agent_call'),
    blockStop(0, 'agent_call'),
    messageStop(),
  );
  assert.deepEqual(events, [
    { k: 'tool_start', id: 'main_cut_off', name: 'Bash' },
    { k: 'tool_start', id: 'sub_tool', name: 'Read' },
    { k: 'tool_end', id: 'main_cut_off', ok: false },
  ]);
  assert.equal(a.openToolCount, 1, 'the subagent tool finished streaming and is still running');
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

test('message types the adapter does not know are ignored', () => {
  const a = new ClaudeAdapter();
  const ignored: unknown[] = [
    { type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', elapsed_time_seconds: 3 },
    { type: 'system', subtype: 'status', status: 'requesting' },
    { type: 'system', subtype: 'notification', key: 'k', text: 't', priority: 'low' },
    { type: 'system', subtype: 'a_subtype_from_the_future' },
    { type: 'rate_limit_event' },
    { type: 'a_type_from_the_future', payload: { deep: [1, 2, 3] } },
    { type: 'conversation_reset', new_conversation_id: UUID0 },
  ];
  for (const m of ignored) assert.deepEqual(a.map(sdk(m as Record<string, unknown>)), [], JSON.stringify(m));
});

test('malformed messages are ignored rather than thrown on', () => {
  const a = new ClaudeAdapter();
  const junk: unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { type: 'stream_event' },
    { type: 'stream_event', event: null },
    { type: 'stream_event', event: { type: 'content_block_start' } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: null } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use' } } },
    { type: 'assistant' },
    { type: 'assistant', message: null },
    { type: 'assistant', message: { content: 'not an array' } },
    { type: 'assistant', message: { content: [null, 7, { type: 'tool_use' }, { type: 'text', text: 9 }] } },
    { type: 'user', message: { role: 'user', content: 'a plain prompt' } },
    { type: 'user', message: { role: 'user', content: [null, { type: 'tool_result' }] } },
    { type: 'system', subtype: 'init' },
  ];
  for (const m of junk) {
    assert.doesNotThrow(() => a.map(m as SDKMessage), JSON.stringify(m));
    assert.deepEqual(a.map(m as SDKMessage), [], JSON.stringify(m));
  }
});

test('a result with no usable fields is still a terminal event', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(sdk({ type: 'result' })), [{ k: 'result', ok: false, text: '', subtype: 'unknown' }]);
  assert.deepEqual(a.map(sdk({ type: 'result', subtype: 'success' })), [
    { k: 'result', ok: true, text: '', subtype: 'success' },
  ]);
});

test('history echoed on resume is not this turn', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), blockStop(0));
  const replay = sdk({
    type: 'user',
    isReplay: true,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'old' }] },
    parent_tool_use_id: null,
  });
  assert.deepEqual(a.map(replay), []);
  assert.equal(a.openToolCount, 1);
});

// ---------------------------------------------------------------------------
// The balance rule, over generated sequences
// ---------------------------------------------------------------------------

/** A small deterministic generator, so a failing sequence can be replayed from its seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test('over generated message sequences tools stay balanced and ids are never reused open', () => {
  let results = 0;
  let starts = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = lcg(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const a = new ClaudeAdapter();
    const open = new Set<string>();
    const ids = ['a', 'b', 'c', 'd'];
    const parents = [null, null, null, 'agent'];
    for (let step = 0; step < 60; step++) {
      const id = pick(ids);
      const parent = pick(parents);
      const msg = pick<SDKMessage>([
        toolBlockStart(Math.floor(rnd() * 3), id, 'Bash', parent),
        blockStop(Math.floor(rnd() * 3), parent),
        messageStart(parent),
        messageStop(parent),
        assistantTool(id, 'Bash', { parent_tool_use_id: parent, aborted: rnd() < 0.2 ? true : undefined }),
        assistantText('hi', { parent_tool_use_id: parent }),
        toolResults({ id, isError: rnd() < 0.3 }),
        resultOk('done', { parent_tool_use_id: parent }),
        resultErr('error_during_execution'),
        init(pick(['s1', 's2'])),
        textDelta(0, 'x'),
      ]);
      for (const ev of a.map(msg)) {
        if (ev.k === 'tool_start') {
          assert.ok(!open.has(ev.id), `seed ${seed}: ${ev.id} started while open`);
          open.add(ev.id);
          starts++;
        } else if (ev.k === 'tool_end') {
          assert.ok(open.has(ev.id), `seed ${seed}: ${ev.id} ended while not open`);
          open.delete(ev.id);
        } else if (ev.k === 'result') {
          results++;
          assert.equal(open.size, 0, `seed ${seed}: a result left ${[...open]} dangling`);
        }
      }
      assert.equal(a.openToolCount, open.size, `seed ${seed}: the adapter's own count drifted`);
    }
    for (const ev of a.abandon()) open.delete((ev as { id: string }).id);
    assert.equal(open.size, 0);
  }
  // The generator must actually have exercised the rule it claims to check.
  assert.ok(starts > 1000, `only ${starts} tool starts generated`);
  assert.ok(results > 100, `only ${results} results generated`);
});
