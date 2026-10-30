/**
 * A scripted stand-in for the Agent SDK's `query()`, shared by every test that composes the
 * REAL Claude driver over a fake CLI (claude-driver.test.ts, and the server-level tests that
 * run the driver inside the real server).
 *
 * It plays the CLI's side of one query: a channel the test pushes SDK messages into, and a
 * record of what the driver sent the other way. Two things in here are not obvious and are
 * the reason the file is shared rather than copied:
 *
 *  1. THE FAKE STAMPS LIKE THE REAL CLI. The driver gives every prompt it pushes a `uuid` and
 *     only believes a turn (and a result) that echoes it back in `user_message_uuids`; that is
 *     what stops a background turn nobody asked for from being reported as the answer. The real
 *     CLI stamps every frame of a turn it ran for a prompt, so `push()` adds the stamp of the
 *     most recent prompt the driver sent to assistant, stream and result frames that carry
 *     none. A test that wants a frame from a turn nobody asked for says so: `push(msg, {stamp:
 *     false})`. A fake that did not stamp would make every result look foreign and the driver
 *     would (correctly) never end a turn.
 *  2. `cliToolCall()` runs a tool call through the driver's options the way the CLI does:
 *     PreToolUse hooks first (deny wins, ask forces the prompt), then `canUseTool`. The order
 *     was measured against the real binary (test/real-cli.integration.test.ts), not assumed.
 */

import assert from 'node:assert/strict';
import type {
  HookInput,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import type { Clock, TimerHandle } from '../../src/types.ts';

export const SID = 'sess-1';
export const UUID0 = '00000000-0000-4000-8000-000000000000';

export class FakeClock implements Clock {
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

export type QueryParams = Parameters<typeof sdkQuery>[0];
type Waiter = { resolve: (r: IteratorResult<SDKMessage, void>) => void; reject: (e: unknown) => void };

export interface PushOptions {
  /** false: leave the frame unstamped, as the CLI does for a turn it started on its own. */
  stamp?: boolean;
  /** Stamp with this uuid instead of the latest prompt's. */
  stampWith?: string;
}

const STAMPED = new Set(['assistant', 'stream_event', 'result']);

/** The CLI's side of one query: a channel the test pushes messages into. */
export class FakeQuery {
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

  /** The uuid of the prompt the driver sent last: what a real CLI would echo on that turn. */
  get lastPromptUuid(): string | undefined {
    return this.received[this.received.length - 1]?.uuid;
  }

  push(msg: SDKMessage, o: PushOptions = {}): void {
    const item = this.#stamped(msg, o);
    const w = this.#waiters.shift();
    if (w !== undefined) w.resolve({ value: item, done: false });
    else this.#items.push({ msg: item });
  }

  #stamped(msg: SDKMessage, o: PushOptions): SDKMessage {
    if (o.stamp === false) return msg;
    try {
      const rec = msg as unknown as Record<string, unknown>;
      if (typeof rec.type !== 'string' || !STAMPED.has(rec.type)) return msg;
      if ('user_message_uuids' in rec || 'user_message_uuid' in rec) return msg;
      const uuid = o.stampWith ?? this.lastPromptUuid;
      if (uuid === undefined) return msg;
      return { ...rec, user_message_uuid: uuid, user_message_uuids: [uuid] } as unknown as SDKMessage;
    } catch {
      // A hostile message (a test hands the driver a getter that throws) is delivered as it is.
      return msg;
    }
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
export function asQuery(q: FakeQuery): Query {
  return q as unknown as Query;
}

/** Let every promise chain the driver is waiting on run to completion. Not a sleep. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((r) => setImmediate(r));
}

export interface FakeSdk {
  query: typeof sdkQuery;
  /** Every query the driver started, in order. */
  queries: FakeQuery[];
}

/** A `query()` replacement. `throwTimes` makes the first N calls throw `error` instead. */
export function fakeSdk(over: { throwTimes?: number; error?: unknown } = {}): FakeSdk {
  const queries: FakeQuery[] = [];
  let throwsLeft = over.throwTimes ?? 0;
  const query: typeof sdkQuery = (params) => {
    if (throwsLeft > 0) {
      throwsLeft--;
      throw over.error;
    }
    const q = new FakeQuery(params);
    queries.push(q);
    return asQuery(q);
  };
  return { query, queries };
}

// ---------------------------------------------------------------------------
// SDK message builders: only the fields the adapter reads
// ---------------------------------------------------------------------------

/** One unavoidable cast: SDK messages carry usage tables and counters nobody here reads. */
export function sdk(partial: Record<string, unknown>): SDKMessage {
  return { uuid: UUID0, session_id: SID, ...partial } as unknown as SDKMessage;
}

export const init = (id = SID): SDKMessage => sdk({ type: 'system', subtype: 'init', session_id: id });
export const toolStart = (id: string, name = 'Bash'): SDKMessage =>
  sdk({
    type: 'stream_event',
    parent_tool_use_id: null,
    event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  });
export const blockStop = (): SDKMessage =>
  sdk({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } });
export const toolResult = (id: string, isError = false): SDKMessage =>
  sdk({
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'x', is_error: isError }] },
  });
export const assistantText = (text: string): SDKMessage =>
  sdk({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text }] },
  });
export const resultOk = (text: string): SDKMessage =>
  sdk({ type: 'result', subtype: 'success', is_error: false, result: text, terminal_reason: 'completed' });
export const resultErr = (subtype = 'error_during_execution', extra: Record<string, unknown> = {}): SDKMessage =>
  sdk({ type: 'result', subtype, is_error: true, errors: ['x'], ...extra });
/** What the CLI sends for an interrupt, a stop in mid-stream or a deny with `interrupt: true`. */
export const resultAborted = (reason: 'aborted_streaming' | 'aborted_tools' = 'aborted_streaming'): SDKMessage =>
  sdk({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: reason,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
  });
export const apiRetry = (error: string, status: number | null, attempt = 1, max = 10): SDKMessage =>
  sdk({ type: 'system', subtype: 'api_retry', attempt, max_retries: max, retry_delay_ms: 600, error_status: status, error });

// ---------------------------------------------------------------------------
// The CLI's permission pipeline, as measured against the real binary
// ---------------------------------------------------------------------------

export interface CliToolOutcome {
  decision: 'allow' | 'deny';
  /** Who decided: a PreToolUse hook, the CLI's own auto-allow, or the `canUseTool` callback. */
  via: 'hook' | 'cli-auto-allow' | 'canUseTool';
  message?: string;
  /** What each hook returned, in order. */
  hookOutputs: unknown[];
}

type HookFn = (input: HookInput, id: string | undefined, o: { signal: AbortSignal }) => Promise<unknown>;

/**
 * Run one tool call through `options` the way the CLI does. `autoAllow` stands for the CLI's
 * own rule that some calls (a Read inside the working directory, `ls`) run without asking
 * unless a hook forces the question; the real binary does exactly that, and the driver's
 * `ask` hook exists to override it.
 */
export async function cliToolCall(
  options: Options,
  tool: string,
  input: Record<string, unknown>,
  o: { toolUseID?: string; signal?: AbortSignal; autoAllow?: boolean } = {},
): Promise<CliToolOutcome> {
  const toolUseID = o.toolUseID ?? 'toolu_sim';
  const signal = o.signal ?? new AbortController().signal;
  const hookOutputs: unknown[] = [];
  let forceAsk = false;
  let hookAllow = false;
  for (const matcher of options.hooks?.PreToolUse ?? []) {
    for (const h of matcher.hooks) {
      const out = await (h as HookFn)(
        { hook_event_name: 'PreToolUse', tool_name: tool, tool_input: input, tool_use_id: toolUseID } as unknown as HookInput,
        toolUseID,
        { signal },
      );
      hookOutputs.push(out);
      const spec = (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | undefined)
        ?.hookSpecificOutput;
      if (spec?.permissionDecision === 'deny') {
        return { decision: 'deny', via: 'hook', message: spec.permissionDecisionReason ?? '', hookOutputs };
      }
      if (spec?.permissionDecision === 'ask') forceAsk = true;
      if (spec?.permissionDecision === 'allow') hookAllow = true;
    }
  }
  if (!forceAsk && hookAllow) return { decision: 'allow', via: 'hook', hookOutputs };
  if (!forceAsk && o.autoAllow === true) return { decision: 'allow', via: 'cli-auto-allow', hookOutputs };
  const canUseTool = options.canUseTool;
  assert.ok(canUseTool !== undefined, 'the driver must register canUseTool');
  const r: PermissionResult | null = await canUseTool(tool, input, { signal, toolUseID, requestId: 'req_sim' } as Parameters<
    NonNullable<Options['canUseTool']>
  >[2]);
  assert.notEqual(r, null, 'the driver must never answer a permission request with null');
  if (r!.behavior === 'allow') return { decision: 'allow', via: 'canUseTool', hookOutputs };
  return { decision: 'deny', via: 'canUseTool', message: r!.message, hookOutputs };
}
