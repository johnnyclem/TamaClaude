/**
 * Driver tests against a scripted fake of the SDK's `query()`.
 *
 * Nothing here has touched the live API (there is no key in the build sandbox), so these
 * tests are the whole of the evidence for the driver's behaviour. What they establish is
 * the driver's contract with the SDK as the typings describe it. What they cannot
 * establish is that the real CLI honours that contract (that hooks really run before
 * allow rules, that an interrupt really ends in a result, that `resume` of an unknown id
 * fails the way the driver assumes); the first run against the real thing has to.
 *
 * The fake records the options it was called with and what the driver pushed into the
 * input iterable, and lets a test play the CLI's side message by message, so an ordering
 * that matters (a result arriving after an interrupt, a stream dying mid-tool) is written
 * out rather than inferred.
 *
 * Every "never" below has a companion that shows the mechanism it relies on engaging:
 * a guard that is vacuously true when nothing happens is not a guard.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type {
  HookInput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { claudeDriverFactory } from '../src/drivers/claude.ts';
import type { ClaudeDriverConfig } from '../src/drivers/claude.ts';
import { VOICE_RULES } from '../src/voice-prompt.ts';
import type {
  Clock,
  DriverEvent,
  PermissionHandler,
  PermissionRequest,
  SessionDriver,
  TimerHandle,
} from '../src/types.ts';

const KEY = 'sk-ant-test-0123456789abcdef';
const SID = 'sess-1';
const UUID0 = '00000000-0000-4000-8000-000000000000';
const CWD = '/work/proj';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeClock implements Clock {
  t = 1_000_000;
  #seq = 0;
  #live = new Map<number, { at: number; fn: () => void }>();
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#seq;
    this.#live.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    this.#live.delete(h as number);
  }
  get armed(): number {
    return this.#live.size;
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#live) {
        if (e[1].at > target) continue;
        if (best === undefined || e[1].at < best[1].at) best = e;
      }
      if (best === undefined) break;
      this.#live.delete(best[0]);
      this.t = Math.max(this.t, best[1].at);
      best[1].fn();
    }
    this.t = target;
  }
}

type QueryParams = Parameters<typeof sdkQuery>[0];
type Waiter = { resolve: (r: IteratorResult<SDKMessage, void>) => void; reject: (e: unknown) => void };

/** The CLI's side of one query: a channel the test pushes messages into. */
class FakeQuery {
  readonly params: QueryParams;
  readonly received: SDKUserMessage[] = [];
  interrupts = 0;
  closes = 0;
  inputEnded = false;
  /** Replace to make interrupt() hang or fail. */
  onInterrupt: () => Promise<undefined> = () => Promise.resolve(undefined);
  /** A CLI that ignores close() and keeps talking, to prove the driver stops listening. */
  keepOpenOnClose = false;
  #items: ({ msg: SDKMessage } | { err: unknown })[] = [];
  #waiters: Waiter[] = [];
  #done = false;

  constructor(params: QueryParams) {
    this.params = params;
    if (typeof params.prompt !== 'string') void this.#drain(params.prompt);
  }

  async #drain(input: AsyncIterable<SDKUserMessage>): Promise<void> {
    for await (const m of input) this.received.push(m);
    this.inputEnded = true;
  }

  push(msg: SDKMessage): void {
    const w = this.#waiters.shift();
    if (w !== undefined) w.resolve({ value: msg, done: false });
    else this.#items.push({ msg });
  }
  fail(err: unknown): void {
    const w = this.#waiters.shift();
    if (w !== undefined) w.reject(err);
    else this.#items.push({ err });
  }
  end(): void {
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }
  next(): Promise<IteratorResult<SDKMessage, void>> {
    const item = this.#items.shift();
    if (item !== undefined) {
      return 'msg' in item ? Promise.resolve({ value: item.msg, done: false }) : Promise.reject(item.err);
    }
    if (this.#done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
  return(): Promise<IteratorResult<SDKMessage, void>> {
    this.end();
    return Promise.resolve({ value: undefined, done: true });
  }
  throw(err: unknown): Promise<IteratorResult<SDKMessage, void>> {
    return Promise.reject(err);
  }
  interrupt(): Promise<undefined> {
    this.interrupts++;
    return this.onInterrupt();
  }
  close(): void {
    this.closes++;
    if (!this.keepOpenOnClose) this.end();
  }
}

/**
 * The fake stands in for `Query`, an AsyncGenerator with two dozen control methods of
 * which the driver uses three (iteration, interrupt, close). One cast, here, rather than
 * a class that implements methods nobody calls.
 */
function asQuery(q: FakeQuery): Query {
  return q as unknown as Query;
}

/** Let every promise chain the driver is waiting on run to completion. Not a sleep. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
}

interface HarnessOpts {
  cfg?: Partial<ClaudeDriverConfig>;
  resume?: string;
  onPermission?: PermissionHandler;
  onEvent?: (e: DriverEvent) => void;
  interruptGraceMs?: number;
  /** Make query() throw for the first N calls. */
  queryThrows?: { times: number; error: unknown };
}

interface Harness {
  driver: SessionDriver;
  events: DriverEvent[];
  logs: string[];
  queries: FakeQuery[];
  requests: PermissionRequest[];
  clock: FakeClock;
  options(run?: number): Options;
  /** Call the `canUseTool` the driver gave query() number `run`, the way the SDK would. */
  ask(tool: string, input: Record<string, unknown>, o?: { run?: number; signal?: AbortSignal }): Promise<PermissionResult>;
}

function harness(over: HarnessOpts = {}): Harness {
  const events: DriverEvent[] = [];
  const logs: string[] = [];
  const queries: FakeQuery[] = [];
  const requests: PermissionRequest[] = [];
  const clock = new FakeClock();
  let throwsLeft = over.queryThrows?.times ?? 0;

  const fakeQuery: typeof sdkQuery = (params) => {
    if (throwsLeft > 0) {
      throwsLeft--;
      throw over.queryThrows!.error;
    }
    const q = new FakeQuery(params);
    queries.push(q);
    return asQuery(q);
  };
  const cfg: ClaudeDriverConfig = { apiKey: KEY, ...over.cfg };
  const driver = claudeDriverFactory(cfg, { query: fakeQuery, clock, interruptGraceMs: over.interruptGraceMs ?? 5000 })({
    cwd: CWD,
    resume: over.resume,
    log: (l) => logs.push(l),
    onEvent: (e) => {
      events.push(e);
      over.onEvent?.(e);
    },
    onPermission: (req) => {
      requests.push(req);
      return (over.onPermission ?? (() => Promise.resolve({ allow: true as const })))(req);
    },
  });

  return {
    driver,
    events,
    logs,
    queries,
    requests,
    clock,
    options: (run = 0) => queries[run]!.params.options!,
    async ask(tool, input, o = {}) {
      const canUseTool = queries[o.run ?? 0]!.params.options!.canUseTool!;
      const r = await canUseTool(tool, input, {
        signal: o.signal ?? new AbortController().signal,
        toolUseID: 'toolu_ask',
        requestId: 'req_1',
      });
      assert.notEqual(r, null, 'the driver must never answer a permission request with null');
      return r!;
    },
  };
}

/** Send a prompt and wait for the query to exist. */
async function begin(h: Harness, text = 'do the thing'): Promise<FakeQuery> {
  const before = h.queries.length;
  h.driver.prompt(text);
  await settle();
  assert.equal(h.queries.length, before + 1, 'a query should have been started');
  return h.queries[h.queries.length - 1]!;
}

// ---------------------------------------------------------------------------
// SDK message builders (see claude-adapter.test.ts for the typed versions of these)
// ---------------------------------------------------------------------------

/** Same single cast as in the adapter tests: only the fields the driver's adapter reads. */
function sdk(partial: Record<string, unknown>): SDKMessage {
  return { uuid: UUID0, session_id: SID, ...partial } as unknown as SDKMessage;
}
const init = (id = SID): SDKMessage => sdk({ type: 'system', subtype: 'init', session_id: id });
const toolStart = (id: string, name = 'Bash'): SDKMessage =>
  sdk({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  });
const blockStop = (): SDKMessage =>
  sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
const toolResult = (id: string, isError = false): SDKMessage =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] },
  });
const assistantText = (text: string): SDKMessage =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text }] },
  });
const resultOk = (text: string): SDKMessage => sdk({ type: 'result', subtype: 'success', is_error: false, result: text });
const resultErr = (subtype = 'error_during_execution'): SDKMessage =>
  sdk({ type: 'result', subtype, is_error: true, errors: ['x'] });

const terminals = (events: DriverEvent[]): DriverEvent[] => events.filter((e) => e.k === 'result' || e.k === 'fatal');

/** The invariant itself. Callers also assert WHICH terminal, so this is never the only check. */
function assertOneTerminalEach(events: DriverEvent[], prompts: number): void {
  assert.equal(terminals(events).length, prompts, `expected ${prompts} terminal event(s): ${JSON.stringify(events)}`);
}

/** Tools announced and not ended, from the event stream alone. */
function dangling(events: DriverEvent[]): string[] {
  const open = new Set<string>();
  for (const e of events) {
    if (e.k === 'tool_start') open.add(e.id);
    if (e.k === 'tool_end') open.delete(e.id);
  }
  return [...open];
}

// ---------------------------------------------------------------------------
// Options: what the SDK is asked to do
// ---------------------------------------------------------------------------

test('no query is started until the first prompt', async () => {
  const h = harness();
  await settle();
  assert.equal(h.queries.length, 0);
  h.driver.prompt('hello');
  await settle();
  assert.equal(h.queries.length, 1);
});

test('the query is started with the options that keep every call behind the handheld', async () => {
  const h = harness();
  await begin(h);
  const o = h.options();
  assert.equal(o.includePartialMessages, true);
  assert.equal(o.permissionMode, 'default');
  assert.deepEqual(o.settingSources, ['project', 'local']);
  assert.equal(o.cwd, CWD);
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: VOICE_RULES });
  assert.equal(typeof o.canUseTool, 'function');
  assert.ok(o.abortController instanceof AbortController);
  assert.equal(o.env?.ANTHROPIC_API_KEY, KEY);
  // The things that must be ABSENT. `in`, not `=== undefined`: a key set to undefined is
  // still a key somebody can later fill in.
  assert.ok(!('allowedTools' in o), 'an auto-allow list would let calls skip canUseTool');
  assert.ok(!('allowDangerouslySkipPermissions' in o));
  assert.ok(!('hooks' in o), 'no hook is registered unless a hardDeny rule was given');
  assert.ok(!('resume' in o), 'nothing to resume yet');
  assert.ok(!('model' in o) && !('maxTurns' in o) && !('pathToClaudeCodeExecutable' in o));
});

test('user-level settings are not loaded unless the caller asks for them', async () => {
  const h = harness();
  await begin(h);
  assert.ok(!h.options().settingSources!.includes('user'));
  // Companion: the config really is what decides it, so the check above is about the
  // default and not about the option being ignored.
  const h2 = harness({ cfg: { settingSources: ['user', 'project'] } });
  await begin(h2);
  assert.deepEqual(h2.options().settingSources, ['user', 'project']);
  const h3 = harness({ cfg: { settingSources: [] } });
  await begin(h3);
  assert.deepEqual(h3.options().settingSources, [], 'an explicit empty list means no settings at all');
});

test('settingSources is a copy: changing the config afterwards changes nothing', async () => {
  const sources: ('user' | 'project' | 'local')[] = ['project'];
  const h = harness({ cfg: { settingSources: sources } });
  await begin(h);
  sources.push('user');
  assert.deepEqual(h.options().settingSources, ['project']);
});

test('the child process keeps the parent environment and gets the configured key on top', async () => {
  process.env.TAMA_DRIVER_TEST_SENTINEL = 'kept';
  const before = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-shell-should-lose';
  try {
    const h = harness();
    await begin(h);
    const env = h.options().env!;
    assert.equal(env.TAMA_DRIVER_TEST_SENTINEL, 'kept', 'the SDK replaces the env wholesale; PATH and HOME must be carried over');
    assert.equal(env.ANTHROPIC_API_KEY, KEY);
    assert.equal(env.PATH, process.env.PATH);
  } finally {
    delete process.env.TAMA_DRIVER_TEST_SENTINEL;
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});

test('optional config reaches the SDK only when set', async () => {
  const h = harness({
    resume: 'old-session',
    cfg: { model: 'claude-test-1', maxTurns: 7, pathToClaudeCodeExecutable: '/opt/claude' },
  });
  await begin(h);
  const o = h.options();
  assert.equal(o.resume, 'old-session');
  assert.equal(o.model, 'claude-test-1');
  assert.equal(o.maxTurns, 7);
  assert.equal(o.pathToClaudeCodeExecutable, '/opt/claude');
});

test('a prompt reaches the CLI as a user message attributed to a human', async () => {
  const h = harness();
  const q = await begin(h, 'read the readme');
  assert.equal(q.received.length, 1);
  assert.deepEqual(q.received[0], {
    type: 'user',
    message: { role: 'user', content: 'read the readme' },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  });
});

test('sessionId() is the resume id until the CLI reports the real one', async () => {
  const h = harness({ resume: 'old-session' });
  assert.equal(h.driver.sessionId(), 'old-session');
  const q = await begin(h);
  q.push(init('new-session'));
  await settle();
  assert.equal(h.driver.sessionId(), 'new-session');
  assert.deepEqual(h.events, [{ k: 'session', id: 'new-session' }]);
  assert.equal(harness().driver.sessionId(), undefined);
});

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test('allow becomes an allow carrying the original input', async () => {
  const h = harness();
  await begin(h);
  const input = { command: 'ls -la', timeout: 5 };
  const r = await h.ask('Bash', input);
  assert.deepEqual(r, { behavior: 'allow', updatedInput: { command: 'ls -la', timeout: 5 } });
});

test('the handler is given a copy: mutating it cannot change what the SDK runs', async () => {
  const h = harness({
    onPermission: (req) => {
      (req.input as Record<string, unknown>).command = 'rm -rf /';
      return Promise.resolve({ allow: true });
    },
  });
  await begin(h);
  const input = { command: 'ls -la' };
  const r = await h.ask('Bash', input);
  assert.deepEqual(r, { behavior: 'allow', updatedInput: { command: 'ls -la' } });
  // Companion: the handler really did get the content, and really did get a different object.
  assert.equal(h.requests.length, 1);
  assert.notEqual(h.requests[0]!.input, input);
  assert.deepEqual(input, { command: 'ls -la' });
});

test('the handler is told the tool, the tool use id, and gets a live signal', async () => {
  const h = harness();
  await begin(h);
  await h.ask('Edit', { file_path: '/a' });
  const req = h.requests[0]!;
  assert.equal(req.tool, 'Edit');
  assert.equal(req.toolUseId, 'toolu_ask');
  assert.deepEqual(req.input, { file_path: '/a' });
  assert.equal(req.signal.aborted, false);
});

test('deny carries the message to the model, and interrupt only when asked', async () => {
  let next: { allow: false; message: string; interrupt?: boolean } = { allow: false, message: 'no thanks' };
  const h = harness({ onPermission: () => Promise.resolve(next) });
  await begin(h);
  assert.deepEqual(await h.ask('Bash', {}), { behavior: 'deny', message: 'no thanks' });
  next = { allow: false, message: 'stop', interrupt: true };
  assert.deepEqual(await h.ask('Bash', {}), { behavior: 'deny', message: 'stop', interrupt: true });
  next = { allow: false, message: 'm', interrupt: false };
  assert.deepEqual(await h.ask('Bash', {}), { behavior: 'deny', message: 'm' });
});

test('anything that is not an explicit answer is a deny', async () => {
  const bad: [string, () => Promise<never>][] = [
    ['a sync throw', () => { throw new Error('secret-token-in-message'); }],
    ['a rejection', () => Promise.reject(new Error('secret-token-in-message'))],
    ['undefined', () => Promise.resolve(undefined as never)],
    ['null', () => Promise.resolve(null as never)],
    ['a string', () => Promise.resolve('allow' as never)],
    ['an empty object', () => Promise.resolve({} as never)],
    ['allow: "yes"', () => Promise.resolve({ allow: 'yes' } as never)],
    ['allow: 1', () => Promise.resolve({ allow: 1 } as never)],
    ['allow: undefined', () => Promise.resolve({ allow: undefined } as never)],
  ];
  for (const [name, handler] of bad) {
    const h = harness({ onPermission: handler });
    await begin(h);
    const r = await h.ask('Bash', { command: 'ls' });
    assert.equal(r.behavior, 'deny', name);
    assert.ok(r.behavior === 'deny' && r.message.length > 0, `${name}: the model needs to be told why`);
    assert.ok(!h.logs.join('\n').includes('secret-token-in-message'), `${name}: an error message may echo the tool input`);
  }
  // Companion: the same harness does allow when the handler says so.
  const ok = harness({ onPermission: () => Promise.resolve({ allow: true }) });
  await begin(ok);
  assert.equal((await ok.ask('Bash', {})).behavior, 'allow');
});

test('a deny without a message still tells the model something', async () => {
  const h = harness({ onPermission: () => Promise.resolve({ allow: false } as never) });
  await begin(h);
  const r = await h.ask('Bash', {});
  assert.ok(r.behavior === 'deny' && r.message.length > 0);
});

test('an input that cannot be copied is a deny, not a crash', async () => {
  const h = harness();
  await begin(h);
  const input: Record<string, unknown> = { fn: () => 1 }; // structuredClone cannot copy a function
  const r = await h.ask('Bash', input);
  assert.equal(r.behavior, 'deny');
  assert.equal(h.requests.length, 0, 'the handler must not see a call it could not be given a safe copy of');
});

test('interrupt cancels a pending ask: the handler is signalled and the SDK is told deny', async () => {
  const h = harness({ onPermission: () => new Promise<never>(() => {}) });
  const q = await begin(h);
  q.push(init());
  const pending = h.ask('Bash', { command: 'ls' });
  await settle();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0]!.signal.aborted, false);

  const done = h.driver.interrupt();
  await settle();
  assert.equal(h.requests[0]!.signal.aborted, true, 'the handler must be told nobody is waiting');
  assert.deepEqual(await pending, {
    behavior: 'deny',
    message: 'The turn was stopped by the user.',
    interrupt: true,
  });
  q.push(resultErr());
  await done;
});

test('close cancels a pending ask the same way', async () => {
  const h = harness({ onPermission: () => new Promise<never>(() => {}) });
  await begin(h);
  const pending = h.ask('Bash', { command: 'ls' });
  await settle();
  await h.driver.close();
  assert.equal(h.requests[0]!.signal.aborted, true);
  assert.equal((await pending).behavior, 'deny');
});

test('an approval that arrives after the turn was stopped is not honoured', async () => {
  let release!: (d: { allow: true }) => void;
  const h = harness({ onPermission: () => new Promise((resolve) => { release = resolve; }) });
  const q = await begin(h);
  const pending = h.ask('Bash', { command: 'ls' });
  await settle();
  const done = h.driver.interrupt();
  release({ allow: true }); // a late tap
  const r = await pending;
  assert.equal(r.behavior, 'deny');
  q.push(resultErr());
  await done;
});

test('an approval that lands in the same instant as the stop is not honoured either', async () => {
  // The other ordering: the handler has already answered when the abort arrives, before the
  // driver has had a chance to act on the answer. The answer is for a question that is gone.
  let release!: (d: { allow: true }) => void;
  const h = harness({ onPermission: () => new Promise((resolve) => { release = resolve; }) });
  const q = await begin(h);
  const pending = h.ask('Bash', { command: 'ls' });
  await settle();
  release({ allow: true });
  const done = h.driver.interrupt();
  const r = await pending;
  assert.equal(r.behavior, 'deny');
  q.push(resultErr());
  await done;
});

test("the SDK's own cancellation reaches the handler and ends the ask", async () => {
  const h = harness({ onPermission: () => new Promise<never>(() => {}) });
  await begin(h);
  const sdkSignal = new AbortController();
  const pending = h.ask('Bash', {}, { signal: sdkSignal.signal });
  await settle();
  assert.equal(h.requests[0]!.signal.aborted, false);
  sdkSignal.abort();
  assert.equal((await pending).behavior, 'deny');
  assert.equal(h.requests[0]!.signal.aborted, true);
  // Already aborted on arrival: refused without bothering the handler.
  const dead = new AbortController();
  dead.abort();
  assert.equal((await h.ask('Bash', {}, { signal: dead.signal })).behavior, 'deny');
  assert.equal(h.requests.length, 1);
});

test('an answered ask is forgotten: a later interrupt does not signal it', async () => {
  const h = harness();
  const q = await begin(h);
  await h.ask('Bash', {});
  const done = h.driver.interrupt();
  await settle();
  assert.equal(h.requests[0]!.signal.aborted, false);
  q.push(resultErr());
  await done;
});

test('a request from a query the driver has discarded is refused without asking', async () => {
  const h = harness();
  const q = await begin(h);
  await h.driver.close();
  const r = await h.ask('Bash', {});
  assert.equal(r.behavior, 'deny');
  assert.equal(h.requests.length, 0);
  assert.ok(q.closes >= 1);
});

// ---------------------------------------------------------------------------
// The hard-deny hook
// ---------------------------------------------------------------------------

type Hook = (input: HookInput, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;

async function hookOf(cfg: Partial<ClaudeDriverConfig>): Promise<{ run: (input: unknown) => Promise<unknown>; matcher: unknown; count: number }> {
  const h = harness({ cfg });
  await begin(h);
  const entries = h.options().hooks?.PreToolUse;
  assert.ok(entries !== undefined && entries.length > 0, 'a PreToolUse hook must be registered');
  const entry = entries[0]!;
  const fn = entry.hooks[0]! as Hook;
  return {
    // The SDK delivers the hook input as parsed JSON; BaseHookInput's bookkeeping fields
    // are irrelevant to the driver, so tests send only the ones it reads.
    run: (input) => fn(input as HookInput, 'toolu_hook', { signal: new AbortController().signal }),
    matcher: entry.matcher,
    count: entries.length,
  };
}
const preToolUse = (tool_name: string, tool_input: unknown): unknown => ({
  hook_event_name: 'PreToolUse',
  tool_name,
  tool_input,
  tool_use_id: 'toolu_hook',
});

test('a hard-denied call is refused by the hook, in the shape the typings give', async () => {
  const seen: [string, Record<string, unknown>][] = [];
  const hook = await hookOf({
    hardDeny: (tool, input) => {
      seen.push([tool, input]);
      return tool === 'Bash' ? 'Deleting the root is never allowed.' : undefined;
    },
  });
  assert.deepEqual(await hook.run(preToolUse('Bash', { command: 'rm -rf /' })), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'Deleting the root is never allowed.',
    },
  });
  assert.deepEqual(seen, [['Bash', { command: 'rm -rf /' }]]);
});

test('the hook applies to every tool, not a matched subset', async () => {
  const hook = await hookOf({ hardDeny: () => undefined });
  assert.equal(hook.matcher, undefined);
  assert.equal(hook.count, 1);
});

test('a call that is not forbidden gets no opinion from the hook, never an allow', async () => {
  const hook = await hookOf({ hardDeny: (tool) => (tool === 'Bash' ? 'no' : undefined) });
  const out = await hook.run(preToolUse('Read', { file_path: '/a' }));
  assert.deepEqual(out, {});
  // An explicit allow from a hook skips the approval flow, which is the whole point of
  // never returning one. Companion to the deny test above: same hook, opposite input.
  assert.notEqual((await hook.run(preToolUse('Bash', {}))) as object, out);
});

test('a hard-deny rule that throws, or returns an empty reason, still denies', async () => {
  const throwing = await hookOf({ hardDeny: () => { throw new Error('rule bug'); } });
  const out = (await throwing.run(preToolUse('Bash', {}))) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out.hookSpecificOutput.permissionDecisionReason.length > 0);

  const empty = await hookOf({ hardDeny: () => '' });
  const out2 = (await empty.run(preToolUse('Bash', {}))) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out2.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(out2.hookSpecificOutput.permissionDecisionReason.length > 0, 'a deny with no reason tells the model nothing');
});

test('a tool input that is not an object is passed as an empty one', async () => {
  const seen: unknown[] = [];
  const hook = await hookOf({ hardDeny: (_t, input) => { seen.push(input); return undefined; } });
  for (const bad of [null, 'text', 42, [1, 2], undefined]) await hook.run(preToolUse('Bash', bad));
  assert.deepEqual(seen, [{}, {}, {}, {}, {}]);
});

test('hook events other than PreToolUse are left alone', async () => {
  let calls = 0;
  const hook = await hookOf({ hardDeny: () => { calls++; return 'no'; } });
  assert.deepEqual(await hook.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }), {});
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Exactly one terminal event per accepted prompt
// ---------------------------------------------------------------------------

test('a normal turn: events in order, one result, the session id kept', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(init());
  q.push(toolStart('t1', 'Read'));
  q.push(blockStop());
  q.push(toolResult('t1'));
  q.push(assistantText('The file is empty.'));
  q.push(resultOk('The file is empty.'));
  await settle();
  assert.deepEqual(h.events, [
    { k: 'session', id: SID },
    { k: 'tool_start', id: 't1', name: 'Read' },
    { k: 'tool_end', id: 't1', ok: true },
    { k: 'text', text: 'The file is empty.' },
    { k: 'result', ok: true, text: 'The file is empty.', subtype: 'success' },
  ]);
  assertOneTerminalEach(h.events, 1);
  assert.equal(h.driver.sessionId(), SID);
  assert.equal(q.closes, 0, 'a finished turn must not tear the session down');
});

test('an error result is one failed terminal', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(init());
  q.push(toolStart('t1'));
  q.push(blockStop());
  q.push(resultErr('error_max_turns'));
  await settle();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'result', ok: false, text: '', subtype: 'error_max_turns' },
  ]);
  assertOneTerminalEach(h.events, 1);
  assert.deepEqual(dangling(h.events), []);
});

test('a stream that ends without a result is one fatal, and the next prompt resumes on a new query', async () => {
  const h = harness();
  const q1 = await begin(h, 'first');
  q1.push(init());
  q1.push(toolStart('t1'));
  q1.push(blockStop());
  q1.end();
  await settle();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'fatal', msg: 'Claude ended the session without an answer.' },
  ]);
  assertOneTerminalEach(h.events, 1);
  assert.deepEqual(dangling(h.events), []);
  assert.equal(q1.closes, 1, 'the dead query is released');

  const q2 = await begin(h, 'second');
  assert.equal(h.options(1).resume, SID, 'the new query continues the conversation');
  assert.equal(q2.received[0]!.message.content, 'second');
  q2.push(resultOk('ok'));
  await settle();
  assertOneTerminalEach(h.events, 2);
  assert.deepEqual(terminals(h.events).map((e) => e.k), ['fatal', 'result']);
});

test('a stream that throws is one fatal carrying the reason, with the key scrubbed', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(init());
  q.fail(new Error(`401 invalid x-api-key ${KEY} caf\u00e9 \u2603`));
  await settle();
  const t = terminals(h.events);
  assert.equal(t.length, 1);
  assert.equal(t[0]!.k, 'fatal');
  const msg = (t[0] as { msg: string }).msg;
  assert.match(msg, /^Claude session failed: 401 invalid x-api-key/);
  assert.ok(!msg.includes(KEY), 'the API key must never leave the process in an event');
  assert.match(msg, /^[\x20-\x7e]*$/, 'fatal text can reach the panel');
  assert.ok(msg.length <= 160);
  assert.ok(!h.logs.some((l) => l.includes(KEY)));
});

test('stderr from the CLI is logged, scrubbed and bounded', async () => {
  const h = harness();
  await begin(h);
  h.options().stderr!(`warn: using ${KEY}\n${'x'.repeat(1000)}`);
  assert.equal(h.logs.length, 1);
  assert.ok(!h.logs[0]!.includes(KEY));
  assert.match(h.logs[0]!, /^claude stderr: warn: using \*\*\*/);
  assert.ok(h.logs[0]!.length <= 200);
});

test('interrupt mid-turn: the query is interrupted, the CLI answers, one terminal', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(init());
  q.push(toolStart('t1'));
  q.push(blockStop());
  await settle();
  assert.equal(q.interrupts, 0);
  const done = h.driver.interrupt();
  await settle();
  assert.equal(q.interrupts, 1);
  assert.equal(terminals(h.events).length, 0, 'the terminal is the CLI\'s result, not something the driver invents');
  q.push(resultErr('error_during_execution'));
  await done;
  await settle();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'result', ok: false, text: '', subtype: 'error_during_execution' },
  ]);
  assertOneTerminalEach(h.events, 1);
  assert.equal(h.clock.armed, 0, 'the grace timer must not outlive the turn');
  // The same query serves the next turn.
  h.driver.prompt('again');
  await settle();
  assert.equal(h.queries.length, 1);
  assert.equal(q.received.length, 2);
});

test('interrupt when nothing is running does nothing', async () => {
  const h = harness();
  await h.driver.interrupt();
  assert.deepEqual(h.events, []);
  const q = await begin(h);
  q.push(resultOk('done'));
  await settle();
  await h.driver.interrupt();
  assert.equal(q.interrupts, 0, 'no turn in flight, so nothing to interrupt');
  assertOneTerminalEach(h.events, 1);
});

test('an interrupt the CLI never acknowledges is given up on: one fatal, query discarded', async () => {
  const h = harness({ interruptGraceMs: 5000 });
  const q = await begin(h);
  q.onInterrupt = () => new Promise<undefined>(() => {}); // a hung CLI
  // A CLI that is hung does not honour close() either: its stream stays open and the driver
  // is still reading it, which is the only situation in which a late result can arrive.
  q.keepOpenOnClose = true;
  q.push(init());
  q.push(toolStart('t1'));
  await settle();
  let returned = false;
  const done = h.driver.interrupt().then(() => { returned = true; });
  await settle();
  h.clock.advance(4999);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'still inside the grace period');
  assert.equal(returned, false);
  h.clock.advance(1);
  await settle();
  await done;
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'fatal', msg: 'Claude did not stop when asked.' },
  ]);
  assertOneTerminalEach(h.events, 1);
  assert.equal(q.closes, 1);
  assert.equal(q.inputEnded, true);

  // A late result from the discarded query must not be taken for the answer to the next prompt.
  const q2 = await begin(h, 'next');
  q.push(resultOk('late answer to the old prompt'));
  await settle();
  assert.equal(terminals(h.events).length, 1, 'the stale result must not end the new turn');
  q2.push(resultOk('real answer'));
  await settle();
  assert.deepEqual(terminals(h.events).map((e) => (e.k === 'result' ? e.text : e.k)), ['fatal', 'real answer']);
});

test('an interrupt that is rejected ends the turn rather than hanging it', async () => {
  const h = harness();
  const q = await begin(h);
  q.onInterrupt = () => Promise.reject(new Error('transport closed'));
  q.push(init());
  await settle();
  await h.driver.interrupt();
  assert.deepEqual(h.events.slice(-1), [{ k: 'fatal', msg: 'Claude could not be interrupted.' }]);
  assertOneTerminalEach(h.events, 1);
  assert.equal(q.closes, 1);
});

test('close mid-turn: one fatal, the query closed, the input ended, late messages ignored', async () => {
  const h = harness();
  const q = await begin(h);
  q.keepOpenOnClose = true;
  q.push(init());
  q.push(toolStart('t1'));
  q.push(blockStop());
  await settle();
  await h.driver.close();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'fatal', msg: 'The Claude session was closed.' },
  ]);
  assert.equal(q.closes, 1);
  assert.equal(q.inputEnded, true);
  assert.ok((h.options().abortController as AbortController).signal.aborted);
  const before = h.events.length;
  q.push(assistantText('too late'));
  q.push(resultOk('too late'));
  await settle();
  assert.equal(h.events.length, before, 'a closed driver says nothing more');
  assertOneTerminalEach(h.events, 1);
});

test('close is idempotent, never throws, and a prompt after it still gets its terminal', async () => {
  const h = harness();
  const q = await begin(h);
  q.close = () => { throw new Error('process already gone'); };
  await assert.doesNotReject(h.driver.close());
  await assert.doesNotReject(h.driver.close());
  assertOneTerminalEach(h.events, 1);
  const before = h.events.length;
  h.driver.prompt('anyone there?');
  assert.equal(h.events.length, before, 'the terminal is deferred out of the caller\'s stack');
  await settle();
  assert.deepEqual(h.events.slice(before).map((e) => e.k), ['fatal'], 'exactly one terminal, and it is a failure');
  assert.equal(h.queries.length, 1, 'no query for a closed driver');
});

test('close with nothing running emits nothing', async () => {
  const h = harness();
  await h.driver.close();
  assert.deepEqual(h.events, []);
});

test('two prompts in a row share one query and each ends with its own result', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(init());
  q.push(assistantText('one'));
  q.push(resultOk('one'));
  await settle();
  assertOneTerminalEach(h.events, 1);

  h.driver.prompt('second');
  await settle();
  assert.equal(h.queries.length, 1, 'the session and its context live in one query');
  assert.deepEqual(q.received.map((m) => m.message.content), ['first', 'second']);
  q.push(init()); // the CLI repeats init each turn
  q.push(assistantText('two'));
  q.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
  assert.deepEqual(
    h.events.filter((e) => e.k === 'result').map((e) => (e as { text: string }).text),
    ['one', 'two'],
  );
  assert.equal(h.events.filter((e) => e.k === 'session').length, 1, 'the repeated init is not repeated to the server');
});

test('a prompt sent while a turn is running waits for it instead of being merged into it', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  h.driver.prompt('second');
  await settle();
  assert.deepEqual(q.received.map((m) => m.message.content), ['first'], 'not pushed early: the CLI could fold it into the first turn');
  q.push(resultOk('one'));
  await settle();
  assert.deepEqual(q.received.map((m) => m.message.content), ['first', 'second']);
  q.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

test('interrupt also stops prompts that were waiting, each with its terminal, and they never run', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  h.driver.prompt('second');
  h.driver.prompt('third');
  const done = h.driver.interrupt();
  await settle();
  assert.deepEqual(
    h.events.filter((e) => e.k === 'result'),
    [
      { k: 'result', ok: false, text: '', subtype: 'interrupted' },
      { k: 'result', ok: false, text: '', subtype: 'interrupted' },
    ],
  );
  q.push(resultErr());
  await done;
  await settle();
  assertOneTerminalEach(h.events, 3);
  assert.deepEqual(q.received.map((m) => m.message.content), ['first'], 'the stopped prompts must never reach Claude');
});

test('close ends waiting prompts too', async () => {
  const h = harness();
  await begin(h, 'first');
  h.driver.prompt('second');
  await h.driver.close();
  assert.deepEqual(h.events, [
    { k: 'fatal', msg: 'The Claude session was closed.' },
    { k: 'fatal', msg: 'The Claude session was closed.' },
  ]);
});

test('a second terminal for the same turn is ignored and logged', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(resultOk('one'));
  q.push(resultOk('one again'));
  q.push(resultErr());
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.deepEqual(terminals(h.events), [{ k: 'result', ok: true, text: 'one', subtype: 'success' }]);
  assert.equal(h.logs.filter((l) => l.includes('ignored a result')).length, 2);
});

test('a duplicate result does not end the NEXT turn early', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(resultOk('one'));
  q.push(resultOk('one again')); // arrives while idle
  await settle();
  h.driver.prompt('second');
  await settle();
  assertOneTerminalEach(h.events, 1);
  q.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

test('activity with no turn behind it is dropped, but a session id is not', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(resultOk('done'));
  await settle();
  const before = h.events.length;
  q.push(toolStart('bg1'));
  q.push(assistantText('a background task woke me'));
  q.push(resultOk('a turn nobody asked for'));
  await settle();
  assert.equal(h.events.length, before);
  assert.ok(h.logs.some((l) => l.includes('no turn in flight')));
  q.push(init('rotated'));
  await settle();
  assert.deepEqual(h.events.slice(before), [{ k: 'session', id: 'rotated' }]);
});

test('a CLI that exits between turns is not an error; the next prompt starts a new query', async () => {
  const h = harness();
  const q1 = await begin(h, 'first');
  q1.push(init());
  q1.push(resultOk('one'));
  await settle();
  q1.end();
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.ok(!h.events.some((e) => e.k === 'fatal'), 'nothing was in flight, so nothing failed');
  const q2 = await begin(h, 'second');
  assert.equal(h.options(1).resume, SID);
  q2.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

test('a stream that throws after the turn is over says nothing', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(resultOk('done'));
  await settle();
  q.fail(new Error('late failure'));
  await settle();
  assertOneTerminalEach(h.events, 1);
});

test('a listener that throws does not break the driver', async () => {
  let boom = true;
  const h = harness({
    onEvent: (e) => {
      if (boom && e.k === 'result') throw new Error('server bug');
    },
  });
  const q = await begin(h, 'first');
  q.push(resultOk('one'));
  await settle();
  boom = false;
  assert.ok(h.logs.some((l) => l.includes('onEvent threw')));
  h.driver.prompt('second');
  await settle();
  q.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
  assert.equal(h.queries.length, 1);
});

test('a listener may send the next prompt from inside the terminal event', async () => {
  let sent = false;
  const h = harness({
    onEvent: (e) => {
      if (e.k === 'result' && !sent) {
        sent = true;
        h.driver.prompt('follow up');
      }
    },
  });
  const q = await begin(h, 'first');
  q.push(resultOk('one'));
  await settle();
  assert.deepEqual(q.received.map((m) => m.message.content), ['first', 'follow up']);
  q.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

test('a message the adapter chokes on costs that message, not the session', async () => {
  const h = harness();
  const q = await begin(h);
  const poisoned = {
    get type(): string {
      throw new Error('hostile getter');
    },
  } as unknown as SDKMessage;
  q.push(poisoned);
  q.push(resultOk('still here'));
  await settle();
  assert.ok(h.logs.some((l) => l.includes('could not map a message')));
  assert.deepEqual(terminals(h.events), [{ k: 'result', ok: true, text: 'still here', subtype: 'success' }]);
});

test('query() throwing is one fatal, and the next prompt tries again', async () => {
  const h = harness({ queryThrows: { times: 1, error: new Error(`spawn failed for ${KEY}`) } });
  h.driver.prompt('first');
  await settle();
  assert.equal(h.queries.length, 0);
  const t = terminals(h.events);
  assert.equal(t.length, 1);
  assert.match((t[0] as { msg: string }).msg, /^Could not start Claude: spawn failed for \*\*\*$/);
  const q = await begin(h, 'second');
  q.push(resultOk('ok'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

test('a queued prompt is not lost when the one before it dies', async () => {
  const h = harness();
  const q1 = await begin(h, 'first');
  h.driver.prompt('second');
  q1.fail(new Error('connection reset'));
  await settle();
  assert.equal(terminals(h.events).length, 1, 'the first prompt got its fatal');
  assert.equal(h.queries.length, 2, 'the second prompt moved to a fresh query');
  assert.deepEqual(h.queries[1]!.received.map((m) => m.message.content), ['second']);
  h.queries[1]!.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

// ---------------------------------------------------------------------------
// The real SDK, as far as it can be reached without a key
// ---------------------------------------------------------------------------

test('with no injected query the real SDK is imported on first use, and a missing binary is one fatal', async () => {
  // No network and no process: the SDK looks for the executable first and gives up. What
  // this shows is the wiring the fake cannot: the lazy import resolves, the real query()
  // accepts the options object without throwing, and its failure arrives through the
  // stream as a single terminal event. What it cannot show is a turn that reaches the API.
  const events: DriverEvent[] = [];
  const logs: string[] = [];
  let driver!: SessionDriver;
  const terminal = new Promise<void>((resolve) => {
    driver = claudeDriverFactory({ apiKey: KEY, pathToClaudeCodeExecutable: '/nonexistent/claude-binary' })({
      cwd: CWD,
      log: (l) => logs.push(l),
      onPermission: () => Promise.resolve({ allow: false, message: 'no' }),
      onEvent: (e) => {
        events.push(e);
        if (e.k === 'result' || e.k === 'fatal') resolve();
      },
    });
  });
  driver.prompt('hello');
  await terminal;
  await driver.close();
  assert.equal(events.length, 1, 'close() after the fatal must add nothing');
  const ev = events[0]!;
  assert.equal(ev.k, 'fatal');
  // From the real SDK's stream, not from the driver's own "could not start" path, which is
  // what a broken import or a rejected options object would produce.
  assert.match((ev as { msg: string }).msg, /^Claude session failed: .*not found/i);
  assert.ok(!JSON.stringify([events, logs]).includes(KEY));
});

// ---------------------------------------------------------------------------
// The source itself
// ---------------------------------------------------------------------------

const SOURCES = ['../src/drivers/claude.ts', '../src/drivers/claude-adapter.ts', '../src/voice-prompt.ts'].map((rel) => ({
  rel,
  text: readFileSync(new URL(rel, import.meta.url), 'utf8'),
}));

/** Names of the options that would let a call run without the handheld's tap. */
function forbiddenTokens(text: string): string[] {
  const found: string[] = [];
  if (/bypass/i.test(text)) found.push('bypass');
  if (/dangerously/i.test(text)) found.push('dangerously');
  if (/allowedTools/.test(text)) found.push('allowedTools');
  for (const m of text.matchAll(/permissionMode\s*[:=]\s*(['"`])([^'"`]*)\1/g)) {
    if (m[2] !== 'default') found.push(`permissionMode ${m[2]}`);
  }
  return found;
}

test('the driver source never mentions the options that skip approval', () => {
  for (const s of SOURCES) assert.deepEqual(forbiddenTokens(s.text), [], s.rel);
});

test('the source check can fail: it flags each forbidden option when one is present', () => {
  const skip = 'bypass' + 'Permissions';
  const dang = 'allowDangerously' + 'SkipPermissions';
  const allow = 'allowed' + 'Tools';
  assert.deepEqual(forbiddenTokens(`permissionMode: '${skip}'`), ['bypass', "permissionMode " + skip]);
  assert.deepEqual(forbiddenTokens(`x.${dang} = true`), ['dangerously']);
  assert.deepEqual(forbiddenTokens(`options.${allow} = ['Bash']`), ['allowedTools']);
  assert.deepEqual(forbiddenTokens(`permissionMode: 'acceptEdits'`), ['permissionMode acceptEdits']);
  assert.deepEqual(forbiddenTokens(`permissionMode: 'default'`), []);
});

test('the driver source asks for the default permission mode and no other', () => {
  const driver = SOURCES.find((s) => s.rel.endsWith('/claude.ts'))!;
  const modes = [...driver.text.matchAll(/permissionMode\s*:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(modes, ['default'], 'exactly one permissionMode, and it is the default');
});
