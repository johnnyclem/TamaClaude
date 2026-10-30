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
import { ClaudeAdapter, GIVE_UP } from '../src/drivers/claude-adapter.ts';
import type { AdapterEvent } from '../src/drivers/claude-adapter.ts';
import { summarizeForDevice } from '../src/text.ts';
import { LIMITS } from '../src/types.ts';
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

function feed(a: ClaudeAdapter, ...msgs: SDKMessage[]): AdapterEvent[] {
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

test('every error result is a failed terminal carrying the CLI\'s own sentence, including subtypes added later', () => {
  for (const subtype of [
    'error_during_execution',
    'error_max_turns',
    'error_max_budget_usd',
    'error_max_structured_output_retries',
    'error_from_the_future',
  ]) {
    const a = new ClaudeAdapter();
    assert.deepEqual(a.map(resultErr(subtype)), [{ k: 'result', ok: false, text: 'boom', subtype }], subtype);
  }
});

test('the CLI\'s internal diagnostics are not a message for a person, and an empty list is no text', () => {
  const a = new ClaudeAdapter();
  const diag = '[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null';
  assert.deepEqual(a.map(resultErr('error_during_execution', { errors: [diag] })), [
    { k: 'result', ok: false, text: '', subtype: 'error_during_execution' },
  ]);
  assert.deepEqual(a.map(resultErr('error_during_execution', { errors: [diag, 'Reached the limit'] })), [
    { k: 'result', ok: false, text: 'Reached the limit', subtype: 'error_during_execution' },
  ]);
  assert.deepEqual(a.map(resultErr('error_during_execution', { errors: [] })), [
    { k: 'result', ok: false, text: '', subtype: 'error_during_execution' },
  ]);
  assert.deepEqual(a.map(resultErr('error_during_execution', { errors: [42, null, '  '] })), [
    { k: 'result', ok: false, text: '', subtype: 'error_during_execution' },
  ]);
  const long = a.map(resultErr('error_during_execution', { errors: ['x'.repeat(5000)] }))[0] as { text: string };
  assert.ok(long.text.length <= 300, 'a runaway error cannot flood the server');
});

test('a result the API marked as an error keeps the CLI\'s sentence and is not ok', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(
    a.map(resultOk('Invalid API key. Fix external API key', { is_error: true, terminal_reason: 'api_error' })),
    [{ k: 'result', ok: false, text: 'Invalid API key. Fix external API key', subtype: 'success' }],
  );
});

test('a stop is reported as interrupted whoever asked for it: the CLI calls it an error', () => {
  const diag = ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'];
  for (const reason of ['aborted_streaming', 'aborted_tools']) {
    const a = new ClaudeAdapter();
    assert.deepEqual(
      a.map(resultErr('error_during_execution', { terminal_reason: reason, errors: diag })),
      [{ k: 'result', ok: false, text: '', subtype: 'interrupted' }],
      reason,
    );
  }
  // Companions: the same subtype with any other reason is an ordinary failure, so the mapping
  // is driven by the reason and not by the subtype.
  for (const reason of ['api_error', 'max_turns', 'completed', undefined]) {
    const a = new ClaudeAdapter();
    const out = a.map(resultErr('error_during_execution', { terminal_reason: reason }))[0] as { subtype: string };
    assert.equal(out.subtype, 'error_during_execution', String(reason));
  }
  // And it still closes what was open before it reports.
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 't1'), blockStop(0));
  assert.deepEqual(a.map(resultErr('error_during_execution', { terminal_reason: 'aborted_tools' })), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'result', ok: false, text: '', subtype: 'interrupted' },
  ]);
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
    { k: 'result', ok: false, text: 'boom', subtype: 'error_during_execution' },
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
// Whose turn is it? (M18, D7)
// ---------------------------------------------------------------------------

const MINE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

/** What the real CLI adds to the frames of a turn it ran for a prompt. */
const stamped = (msg: SDKMessage, ...uuids: string[]): SDKMessage =>
  ({ ...(msg as object), user_message_uuid: uuids[uuids.length - 1], user_message_uuids: uuids }) as unknown as SDKMessage;

function bound(): ClaudeAdapter {
  const a = new ClaudeAdapter();
  a.begin(MINE);
  return a;
}

test('an adapter nobody has told about a prompt passes everything through, as before', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(assistantText('hi')), [{ k: 'text', text: 'hi' }]);
  assert.deepEqual(a.map(resultOk('done')), [{ k: 'result', ok: true, text: 'done', subtype: 'success' }]);
});

test('the frames of the turn we asked for are stamped, and their tools and result are ours', () => {
  const a = bound();
  const out = feed(
    a,
    stamped(messageStart(), MINE),
    toolBlockStart(0, 't1'),
    blockStop(0),
    stamped(assistantTool('t1'), MINE),
    toolResults({ id: 't1' }),
    messageStart(),
    stamped(assistantText('Done.'), MINE),
    stamped(resultOk('Done.'), MINE),
  );
  assert.deepEqual(out, [
    { k: 'tool_start', id: 't1', name: 'Bash' },
    { k: 'tool_end', id: 't1', ok: true },
    { k: 'text', text: 'Done.' },
    { k: 'result', ok: true, text: 'Done.', subtype: 'success' },
  ]);
});

test('a turn that starts on its own is invisible: no tools, no text, and its result is foreign', () => {
  const a = bound();
  const out = feed(a, messageStart(), toolBlockStart(0, 'bg1'), blockStop(0), assistantText('the job finished'), toolResults({ id: 'bg1' }));
  assert.deepEqual(out, [], 'an unstamped first frame is not ours');
  assert.equal(a.openToolCount, 0, 'a tool of a turn nobody asked for is never announced, so it can never dangle');
  assert.deepEqual(a.map(resultOk('the job finished')), [{ k: 'foreign_result' }]);
});

test('a frame stamped with another prompt\'s uuid is not ours, and a list that includes ours is', () => {
  const a = bound();
  assert.deepEqual(feed(a, stamped(assistantText('not mine'), OTHER)), []);
  assert.deepEqual(a.map(stamped(resultOk('not mine'), OTHER)), [{ k: 'foreign_result' }]);
  // Several prompts folded into one turn: ours is anywhere in the list.
  assert.deepEqual(a.map(stamped(assistantText('mine'), OTHER, MINE)), [{ k: 'text', text: 'mine' }]);
  assert.deepEqual(a.map(stamped(resultOk('mine'), OTHER, MINE)), [{ k: 'result', ok: true, text: 'mine', subtype: 'success' }]);
});

test('the single-uuid field alone is enough when the list is absent (older CLIs)', () => {
  const a = bound();
  const only = { ...(assistantText('hi') as object), user_message_uuid: MINE } as unknown as SDKMessage;
  assert.deepEqual(a.map(only), [{ k: 'text', text: 'hi' }]);
});

test('a foreign turn running when our prompt is sent does not swallow ours', () => {
  const a = new ClaudeAdapter();
  a.begin(OTHER);
  feed(a, stamped(resultOk('an earlier prompt'), OTHER)); // idle now; the adapter is judging
  // A notification turn starts on its own, and only THEN is the next prompt pushed behind it.
  assert.deepEqual(feed(a, assistantText('NOTIFICATION')), []);
  a.begin(MINE);
  assert.deepEqual(feed(a, resultOk('NOTIFICATION-TURN: done')), [{ k: 'foreign_result' }], 'its result is not our answer');
  // Then our own turn.
  assert.deepEqual(feed(a, stamped(assistantText('real answer'), MINE), stamped(resultOk('real answer'), MINE)), [
    { k: 'text', text: 'real answer' },
    { k: 'result', ok: true, text: 'real answer', subtype: 'success' },
  ]);
});

test('after our result nothing is awaited: late frames and a second result are foreign', () => {
  const a = bound();
  feed(a, stamped(assistantText('x'), MINE), stamped(resultOk('x'), MINE));
  assert.deepEqual(feed(a, stamped(assistantText('late'), MINE)), [], 'the old uuid no longer names anything in flight');
  assert.deepEqual(a.map(stamped(resultOk('again'), MINE)), [{ k: 'foreign_result' }]);
  // A new prompt re-arms it.
  a.begin(OTHER);
  assert.deepEqual(a.map(stamped(resultOk('new'), OTHER)), [{ k: 'result', ok: true, text: 'new', subtype: 'success' }]);
});

test('a result with no stamp is ours only when the turn so far was ours', () => {
  const a = bound();
  feed(a, stamped(messageStart(), MINE));
  assert.deepEqual(a.map(resultOk('done')), [{ k: 'result', ok: true, text: 'done', subtype: 'success' }]);
  // Companion: the same result with no frame before it at all is foreign.
  const b = bound();
  assert.deepEqual(b.map(resultOk('done')), [{ k: 'foreign_result' }]);
});

test('a zeroed error (the turn never ran) is ours even with no frame and no stamp', () => {
  const a = bound();
  assert.deepEqual(a.map(resultErr('error_during_execution', { errors: ['Claude Code requires X'], num_turns: 0 })), [
    { k: 'result', ok: false, text: 'Claude Code requires X', subtype: 'error_during_execution' },
  ]);
  const b = bound();
  assert.deepEqual(b.map(resultErr('error_during_execution', { errors: ['x'], startup_failure_reason: 'node_too_old' })), [
    { k: 'result', ok: false, text: 'x', subtype: 'error_during_execution' },
  ]);
  // Companion: an ordinary error that did run turns is foreign when nothing says it is ours.
  const c = bound();
  assert.deepEqual(c.map(resultErr('error_during_execution', { num_turns: 3 })), [{ k: 'foreign_result' }]);
});

test('a foreign result does not end tools that belong to our turn', () => {
  const a = bound();
  feed(a, stamped(messageStart(), MINE), toolBlockStart(0, 't1'), blockStop(0));
  assert.equal(a.openToolCount, 1);
  assert.deepEqual(a.map(stamped(resultOk('other'), OTHER)), [{ k: 'foreign_result' }]);
  assert.equal(a.openToolCount, 1, 'our tool is still running');
});

test('a tool result never opens a turn on its own', () => {
  const a = bound();
  assert.deepEqual(feed(a, toolResults({ id: 'nope' })), []);
  // And it did not poison the state: our stamped frame still opens our turn.
  assert.deepEqual(feed(a, stamped(assistantText('hi'), MINE)), [{ k: 'text', text: 'hi' }]);
});

test('a stray tool result between turns does not turn the next signal into someone else\'s', () => {
  // Echoed history, a late result: it opens nothing, so the state stays "no turn yet" and the
  // zeroed failure that follows (a stale session id) is still recognised as ours.
  const a = bound();
  assert.deepEqual(feed(a, toolResults({ id: 'old' })), []);
  assert.deepEqual(a.map(staleResult()), [{ k: 'resume_failed' }]);
  const b = bound();
  feed(b, toolResults({ id: 'old' }));
  assert.deepEqual(b.map(resultErr('error_during_execution', { errors: ['Claude Code requires X'], num_turns: 0 })), [
    { k: 'result', ok: false, text: 'Claude Code requires X', subtype: 'error_during_execution' },
  ]);
});

test('begin() forgets a turn of ours that never reported its result', () => {
  const a = bound();
  feed(a, stamped(messageStart(), MINE)); // turn open, result never came
  a.begin(OTHER);
  assert.deepEqual(feed(a, assistantText('unstamped')), [], 'the old turn is not inherited by the new prompt');
});

// ---------------------------------------------------------------------------
// Signals only the driver can act on
// ---------------------------------------------------------------------------

const staleResult = (): SDKMessage =>
  resultErr('error_during_execution', {
    errors: ['No conversation found with session ID: dead'],
    num_turns: 0,
  });

test('a missing transcript is a resume_failed signal, not a result', () => {
  const a = bound();
  assert.deepEqual(a.map(staleResult()), [{ k: 'resume_failed' }]);
});

test('the stale-resume signal needs all of it: the words, the subtype, nothing seen, a prompt awaited', () => {
  // Wrong subtype.
  const a = bound();
  assert.deepEqual(a.map(resultErr('error_max_turns', { errors: ['No conversation found with session ID: x'] })), [{ k: 'foreign_result' }]);
  // Frames already seen: the session was found.
  const b = bound();
  feed(b, stamped(messageStart(), MINE));
  const out = b.map(staleResult());
  assert.ok(!out.some((e) => e.k === 'resume_failed'), 'a session that has produced frames was found');
  // Nothing awaited.
  const c = new ClaudeAdapter();
  c.begin(MINE);
  c.map(stamped(resultOk('x'), MINE));
  assert.ok(!c.map(staleResult()).some((e) => e.k === 'resume_failed'));
  // Other words.
  const d = bound();
  assert.ok(!d.map(resultErr('error_during_execution', { errors: ['Something else'], num_turns: 0 })).some((e) => e.k === 'resume_failed'));
});

test('an unadvised adapter maps a stale-resume result as the plain error it is', () => {
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(staleResult()), [
    { k: 'result', ok: false, text: 'No conversation found with session ID: dead', subtype: 'error_during_execution' },
  ]);
});

test('an api_retry becomes a signal, and only errors retrying cannot fix carry a sentence', () => {
  const retry = (error: string, status: number | null, attempt = 1): SDKMessage =>
    sdk({ type: 'system', subtype: 'api_retry', attempt, max_retries: 10, retry_delay_ms: 600, error_status: status, error });
  const a = new ClaudeAdapter();
  assert.deepEqual(a.map(retry('authentication_failed', 401)), [
    { k: 'api_retry', error: 'authentication_failed', status: 401, attempt: 1, max: 10, giveUp: 'Claude API error 401: the API key was rejected. Check the key the bridge was started with.' },
  ]);
  assert.deepEqual(a.map(retry('overloaded', 529, 3)), [
    { k: 'api_retry', error: 'overloaded', status: 529, attempt: 3, max: 10, giveUp: undefined },
  ]);
  // A connection error has no status; the sentence must not say "null".
  const out = a.map(retry('billing_error', null))[0] as { giveUp: string };
  assert.ok(!/null|undefined/.test(out.giveUp) && out.giveUp.startsWith('Claude API error: '), out.giveUp);
  for (const code of ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'invalid_request', 'model_not_found', 'cloud_credential_error']) {
    const g = (a.map(retry(code, 400))[0] as { giveUp: string | undefined }).giveUp;
    assert.ok(g !== undefined && /^[\x20-\x7e]+$/.test(g) && g.length <= 90, `${code}: ${g}`);
  }
  // Malformed notices are tolerated.
  assert.deepEqual(a.map(sdk({ type: 'system', subtype: 'api_retry' })), [
    { k: 'api_retry', error: 'unknown', status: null, attempt: 0, max: 0, giveUp: undefined },
  ]);
});

// ---------------------------------------------------------------------------
// Bound mode over generated sequences
// ---------------------------------------------------------------------------

test('bound: whatever the interleaving, tools balance and only our stamped results are reported', () => {
  let ours = 0;
  let reported = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const rnd = lcg(seed * 7919);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const a = new ClaudeAdapter();
    a.begin(MINE);
    const open = new Set<string>();
    for (let step = 0; step < 60; step++) {
      const id = pick(['a', 'b', 'c']);
      const stamp = pick<string[] | undefined>([[MINE], [OTHER], [OTHER, MINE], undefined, undefined]);
      const base = pick<SDKMessage>([
        messageStart(),
        toolBlockStart(0, id),
        blockStop(0),
        assistantTool(id),
        assistantText('hi'),
        toolResults({ id }),
        resultOk('done'),
        resultErr('error_during_execution'),
      ]);
      const msg = stamp !== undefined && ((base as { type: string }).type !== 'user') ? stamped(base, ...stamp) : base;
      const isResult = (msg as { type: string }).type === 'result';
      const isOurs = stamp?.includes(MINE) === true;
      for (const ev of a.map(msg)) {
        if (ev.k === 'tool_start') open.add(ev.id);
        else if (ev.k === 'tool_end') {
          assert.ok(open.has(ev.id), `seed ${seed}: ${ev.id} ended while not open`);
          open.delete(ev.id);
        } else if (ev.k === 'result') {
          reported++;
          assert.equal(open.size, 0, `seed ${seed}: a result left ${[...open]} dangling`);
          if (isResult && stamp !== undefined) assert.ok(isOurs, `seed ${seed}: a result stamped ${JSON.stringify(stamp)} was reported as ours`);
          a.begin(MINE); // the next prompt
        }
      }
      if (isResult && isOurs) ours++;
      assert.equal(a.openToolCount, open.size, `seed ${seed}: the adapter's own count drifted`);
    }
  }
  assert.ok(ours > 50 && reported > 50, `generator too weak: ${ours} ours, ${reported} reported`);
});

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

// ---------------------------------------------------------------------------
// Running tools, for the driver's silence watchdog (D15)
// ---------------------------------------------------------------------------

test('a tool is RUNNING only once its input has finished streaming and until its result: that is when quiet is legitimate', () => {
  const a = new ClaudeAdapter();
  assert.equal(a.runningToolCount, 0);
  feed(a, toolBlockStart(0, 't1'));
  assert.equal(a.openToolCount, 1);
  assert.equal(a.runningToolCount, 0, 'still streaming its input: a model that went silent here is the stall the watchdog exists for');
  feed(a, blockStop(0));
  assert.equal(a.runningToolCount, 1, 'the block finished, the tool is running');
  feed(a, toolResults({ id: 't1' }));
  assert.equal(a.runningToolCount, 0);
  assert.equal(a.openToolCount, 0);
});

test('the complete assistant block alone also means running, and a cut-off stream strands nothing as running', () => {
  const a = new ClaudeAdapter();
  // Without partial messages the complete block is the only announcement.
  feed(a, assistantTool('t1'));
  assert.equal(a.runningToolCount, 1);
  // A second tool, streaming when the message is abandoned.
  feed(a, toolBlockStart(1, 't2'));
  assert.equal(a.runningToolCount, 1, 't2 is still streaming');
  a.abandon();
  assert.equal(a.runningToolCount, 0);
  assert.equal(a.openToolCount, 0);
});

test('a subagent\'s running tool counts, and the two contexts do not hide each other\'s streaming blocks', () => {
  const a = new ClaudeAdapter();
  feed(a, toolBlockStart(0, 'main-1'), toolBlockStart(0, 'sub-1', 'Bash', 'agent-1'));
  assert.equal(a.runningToolCount, 0);
  feed(a, blockStop(0, 'agent-1'));
  assert.equal(a.runningToolCount, 1, 'the subagent\'s block finished; the main thread\'s did not');
  feed(a, blockStop(0));
  assert.equal(a.runningToolCount, 2);
});

test('running never exceeds open and never goes negative, over the generated sequences\' own shapes', () => {
  const a = new ClaudeAdapter();
  const steps: SDKMessage[] = [
    toolBlockStart(0, 'a'), toolBlockStart(1, 'b'), blockStop(0), toolResults({ id: 'a' }), blockStop(1),
    toolResults({ id: 'zzz' }), toolBlockStart(2, 'c'), messageStop(), toolResults({ id: 'b' }),
  ];
  for (const m of steps) {
    a.map(m);
    assert.ok(a.runningToolCount >= 0 && a.runningToolCount <= a.openToolCount, `${a.runningToolCount} running of ${a.openToolCount} open`);
  }
});

// ---------------------------------------------------------------------------
// The one sentence a person gets for a rejected key (K6)
// ---------------------------------------------------------------------------

test('every give-up sentence reaches the device exactly as written: the text sanitiser leaves it alone', () => {
  // `Check ANTHROPIC_API_KEY.` was mangled on the wire into `ANTHROPICAPIKEY`: text.ts reads
  // underscores as markdown. The sentences are driver-authored, so the rule is checked on all of them.
  assert.ok(GIVE_UP.size >= 8);
  for (const [code, phrase] of GIVE_UP) {
    const a = new ClaudeAdapter();
    const ev = a.map(sdk({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 401, error: code }))[0] as { giveUp: string };
    assert.equal(ev.giveUp, `Claude API error 401: ${phrase}`, code);
    assert.equal(summarizeForDevice(ev.giveUp, LIMITS.resultMax), ev.giveUp, `${code}: the wire text differs from the written text`);
    assert.match(ev.giveUp, /^[\x20-\x7e]+$/, code);
    assert.doesNotMatch(phrase, /[_*`#~\\]/, `${code}: a character the markdown reader would eat`);
  }
});

test('the sanitiser check can fail: a sentence with markup in it does not survive it', () => {
  // Emphasis and code ticks are markup under any reading of text.ts, so this stays a real companion whatever it
  // decides about an underscore inside a word (it once deleted them, which is what the sentences above were
  // written to avoid, and keeps them now).
  const marked = 'Claude API error 401: the API key was **rejected**. Check `the key`.';
  assert.notEqual(summarizeForDevice(marked, LIMITS.resultMax), marked);
  // And the plain wording passes through, so the difference above is the markup's doing.
  const plain = 'Claude API error 401: the API key was rejected. Check the key.';
  assert.equal(summarizeForDevice(plain, LIMITS.resultMax), plain);
});

test('an error CODE that is also an Object.prototype name is not a give-up (the table is looked up as data)', () => {
  // The code comes from the CLI. A plain-object table would answer `constructor` with a function,
  // and the "sentence" would be that function's source.
  for (const code of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    const a = new ClaudeAdapter();
    const ev = a.map(sdk({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, error_status: 400, error: code }))[0] as { giveUp: unknown; error: string };
    assert.equal(ev.error, code);
    assert.equal(ev.giveUp, undefined, code);
  }
  // Companion: a real code still has its sentence, so the loop above is not vacuous.
  assert.ok(GIVE_UP.has('authentication_failed'));
});

// ---------------------------------------------------------------------------
// Exactly one terminal, with a watchdog in front of the adapter (D15)
// ---------------------------------------------------------------------------

test('a result stamped for a prompt that was given up on is foreign once a newer prompt is awaited', () => {
  // What the driver relies on after a stall: it begins the next prompt on a NEW adapter, but a
  // reused adapter must hold the same line, or a late result would end the wrong turn.
  const a = new ClaudeAdapter();
  a.begin(OTHER);
  feed(a, stamped(messageStart(), OTHER)); // the stalled turn started
  a.begin(MINE); // the user spoke again
  const late = feed(a, stamped(resultOk('late answer to the old prompt'), OTHER));
  assert.deepEqual(late, [{ k: 'foreign_result' }], 'not terminal, not a result');
  const real = feed(a, stamped(messageStart(), MINE), stamped(resultOk('answer'), MINE));
  assert.deepEqual(real.filter((e) => e.k === 'result'), [{ k: 'result', ok: true, text: 'answer', subtype: 'success' }]);
  // And a duplicate of the real one afterwards produces nothing terminal either.
  assert.deepEqual(feed(a, stamped(resultOk('answer again'), MINE)).filter((e) => e.k === 'result'), []);
});
