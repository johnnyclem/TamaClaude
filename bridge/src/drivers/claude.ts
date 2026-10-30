/**
 * The real Claude driver: one long-lived Agent SDK query serving every turn.
 *
 * It owns LIFECYCLE and SAFETY; the SDK's message shapes are the adapter's business.
 *
 * What the handheld's approval depends on, in order of importance:
 *
 *  1. The only road to `allow` is `onPermission` returning `{ allow: true }`. A throw, a
 *     rejection, a malformed answer, an abort, a stale session: all of them are a deny.
 *  2. Nothing may auto-approve before `canUseTool` is asked. So there is no auto-allow
 *     list, no permission-skipping mode, and user-level settings (where allow rules and
 *     default modes live on a developer's machine) are not loaded by default. Project and
 *     local settings still are, and their allow rules DO skip `canUseTool`; the
 *     `hardDeny` hook below is the backstop for the calls that must never run whatever
 *     any settings file says (hooks run before allow rules).
 *  3. What the user approved is what runs. The handler is given a COPY of the tool
 *     input, and the original goes back to the SDK, so a handler that mutates its
 *     argument cannot change the approved call after the fact.
 *
 * The DriverEvent invariant (exactly one terminal per accepted prompt) is kept by
 * making turns strictly sequential. The CLI may fold prompts sent close together into
 * one turn with one result, which would leave one of ours without a terminal, so the
 * driver holds a second prompt until the first has ended instead of pushing it early.
 */

import type {
  CanUseTool,
  HookCallback,
  Options,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  query as sdkQuery,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from './claude-adapter.ts';
import { sanitize } from '../text.ts';
import { realClock } from '../types.ts';
import type { Clock, DriverEvent, DriverFactory, DriverOptions, SessionDriver, TimerHandle } from '../types.ts';
import { VOICE_RULES } from '../voice-prompt.ts';

export interface ClaudeDriverConfig {
  apiKey: string;
  /** Which settings files the CLI reads. Default: project and local, never user. */
  settingSources?: ('user' | 'project' | 'local')[];
  model?: string;
  maxTurns?: number;
  pathToClaudeCodeExecutable?: string;
  /**
   * A reason to refuse this call outright, or undefined to let the normal approval flow
   * decide. Enforced in a PreToolUse hook, which runs before allow rules and before
   * `canUseTool`, so it holds even when a settings file allows the tool.
   */
  hardDeny?: (tool: string, input: Record<string, unknown>) => string | undefined;
}

type QueryFn = typeof sdkQuery;

export interface ClaudeDriverDeps {
  /** Replaces the SDK's `query` (tests). When absent the SDK is imported on first use. */
  query?: QueryFn;
  clock?: Clock;
  /** How long to wait for the CLI to wind a turn down after `interrupt()` before giving up on it. */
  interruptGraceMs?: number;
}

const DEFAULT_INTERRUPT_GRACE_MS = 8000;
const LOG_LINE_MAX = 200;
const FATAL_MSG_MAX = 160;

/** What the MODEL is told when the bridge itself, not the user, ended an ask. */
const MSG_STOPPED = 'The turn was stopped by the user.';
const MSG_INTERNAL = 'The action was not run because the bridge could not ask the user. Do not retry it; tell the user what you were trying to do.';
const MSG_STALE = 'The bridge session is no longer active, so the action was not run.';
const MSG_HOOK_FAILED = 'The bridge could not check this action against its safety rules, so it was not run.';

/** Fresh each time: a consumer is free to keep or modify an event it was handed. */
const interrupted = (): DriverEvent => ({ k: 'result', ok: false, text: '', subtype: 'interrupted' });
const closedFatal = (): DriverEvent => ({ k: 'fatal', msg: 'The Claude session was closed.' });

/**
 * An async iterable the driver pushes prompts onto and the SDK pulls from. Ending it is
 * how the CLI is told no more input is coming.
 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #items: SDKUserMessage[] = [];
  #waiters: ((r: IteratorResult<SDKUserMessage>) => void)[] = [];
  #ended = false;

  push(m: SDKUserMessage): void {
    if (this.#ended) return;
    const w = this.#waiters.shift();
    if (w !== undefined) w({ value: m, done: false });
    else this.#items.push(m);
  }

  end(): void {
    this.#ended = true;
    this.#items = [];
    for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const item = this.#items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/** One spawned query and the state that dies with it. */
interface Run {
  readonly input: PromptQueue;
  readonly abort: AbortController;
  readonly adapter: ClaudeAdapter;
  /** Undefined until the SDK has been loaded and `query()` called. */
  q: Query | undefined;
  /** Settles when the run is torn down; lets `interrupt()` stop waiting on a dead query. */
  readonly gone: Promise<void>;
  markGone: () => void;
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    // The words are the user's own, even when a recognizer typed them. Without this the
    // CLI treats the message as unattributed and its stricter trust checks refuse it.
    origin: { kind: 'human' },
  };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message;
  try {
    return String(err);
  } catch {
    return 'unknown error';
  }
}

function deny(message: string, interrupt?: boolean): PermissionResult {
  return interrupt === true ? { behavior: 'deny', message, interrupt: true } : { behavior: 'deny', message };
}

class ClaudeDriver implements SessionDriver {
  readonly #cfg: ClaudeDriverConfig;
  readonly #opts: DriverOptions;
  readonly #getQuery: () => Promise<QueryFn>;
  readonly #clock: Clock;
  readonly #graceMs: number;

  #closed = false;
  #sessionId: string | undefined;
  #run: Run | undefined;
  /** A prompt has been handed to Claude and its terminal event has not been emitted yet. */
  #inFlight = false;
  /** Accepted prompts not yet handed to Claude. */
  #waiting: string[] = [];
  /** One controller per open permission request, so interrupt and close can cancel them all. */
  #pending = new Set<AbortController>();
  #grace: TimerHandle | undefined;

  constructor(cfg: ClaudeDriverConfig, deps: ClaudeDriverDeps, getQuery: () => Promise<QueryFn>, opts: DriverOptions) {
    this.#cfg = cfg;
    this.#opts = opts;
    this.#getQuery = getQuery;
    this.#clock = deps.clock ?? realClock;
    this.#graceMs = deps.interruptGraceMs ?? DEFAULT_INTERRUPT_GRACE_MS;
    this.#sessionId = opts.resume;
  }

  sessionId(): string | undefined {
    return this.#sessionId;
  }

  prompt(text: string): void {
    if (this.#closed) {
      // Still an accepted prompt, so it still owes a terminal event. Deferred, because the
      // caller is mid-call and may not have finished its own bookkeeping for the turn.
      queueMicrotask(() => this.#emit(closedFatal()));
      return;
    }
    this.#waiting.push(text);
    this.#pump();
  }

  async interrupt(): Promise<void> {
    if (this.#closed) return;
    this.#abortPermissions();
    // Prompts that never reached Claude stop too, each with the terminal it is owed. The
    // user said stop; running something they typed earlier afterwards would surprise them.
    for (let n = this.#waiting.splice(0).length; n > 0; n--) this.#emit(interrupted());

    const run = this.#run;
    if (run === undefined || !this.#inFlight) return;
    if (run.q === undefined) {
      // The SDK has not even been loaded yet: there is nothing to wind down.
      this.#endRun(run, interrupted());
      return;
    }
    // The CLI answers an interrupt with the turn's result, which is the terminal event.
    // If it never does, the turn must not hang forever, and a late result must not be
    // taken for the answer to the NEXT prompt, so the whole query is discarded.
    this.#clearGrace();
    this.#grace = this.#clock.setTimeout(() => {
      this.#grace = undefined;
      if (this.#run === run && this.#inFlight) {
        this.#log('interrupt was not acknowledged; discarding the query');
        this.#endRun(run, { k: 'fatal', msg: 'Claude did not stop when asked.' });
      }
    }, this.#graceMs);
    try {
      await Promise.race([run.q.interrupt(), run.gone]);
    } catch (err) {
      this.#log(`interrupt failed: ${describeError(err)}`);
      this.#endRun(run, { k: 'fatal', msg: 'Claude could not be interrupted.' });
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#abortPermissions();
      const run = this.#run;
      if (run !== undefined) this.#endRun(run, closedFatal());
      else if (this.#inFlight) this.#finishTurn(closedFatal());
      for (let n = this.#waiting.splice(0).length; n > 0; n--) this.#emit(closedFatal());
    } catch (err) {
      // close() is called from shutdown paths that have nothing sensible to do with a throw.
      this.#log(`close failed: ${describeError(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Turn sequencing
  // ---------------------------------------------------------------------------

  /** Hand the next waiting prompt to Claude, if the previous turn is over. */
  #pump(): void {
    while (!this.#closed && !this.#inFlight && this.#waiting.length > 0) {
      const text = this.#waiting.shift()!;
      this.#inFlight = true;
      const run = this.#run ?? this.#startRun();
      run.input.push(userMessage(text));
    }
  }

  /** The turn is over: clear the state BEFORE telling anyone, so a handler may call prompt() from onEvent. */
  #finishTurn(terminal: DriverEvent): void {
    this.#inFlight = false;
    this.#clearGrace();
    this.#emit(terminal);
  }

  #clearGrace(): void {
    if (this.#grace !== undefined) {
      this.#clock.clearTimeout(this.#grace);
      this.#grace = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // The query
  // ---------------------------------------------------------------------------

  #startRun(): Run {
    let markGone!: () => void;
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const run: Run = {
      input: new PromptQueue(),
      abort: new AbortController(),
      adapter: new ClaudeAdapter(),
      q: undefined,
      gone,
      markGone,
    };
    this.#run = run;
    this.#launch(run).catch((err: unknown) => {
      // launch() handles its own failures; this is the net under a bug in that handling.
      this.#log(`unexpected driver failure: ${describeError(err)}`);
      this.#endRun(run, { k: 'fatal', msg: 'The Claude session failed.' });
    });
    return run;
  }

  async #launch(run: Run): Promise<void> {
    let q: Query;
    try {
      const queryFn = await this.#getQuery();
      if (this.#run !== run) return; // closed or interrupted while the SDK was loading
      q = queryFn({ prompt: run.input, options: this.#buildOptions(run) });
    } catch (err) {
      this.#endRun(run, { k: 'fatal', msg: this.#fatalText('Could not start Claude', err) });
      return;
    }
    run.q = q;
    await this.#consume(run, q);
  }

  async #consume(run: Run, q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        // A message from a query we have already given up on belongs to no turn.
        if (this.#run !== run) return;
        this.#onMessage(run, msg);
      }
    } catch (err) {
      if (this.#run === run) this.#endRun(run, { k: 'fatal', msg: this.#fatalText('Claude session failed', err) });
      return;
    }
    // The stream ended. With a turn in flight that is a missing answer; when idle the CLI
    // simply went away and the next prompt starts a new query.
    if (this.#run === run) this.#endRun(run, { k: 'fatal', msg: 'Claude ended the session without an answer.' });
  }

  #onMessage(run: Run, msg: SDKMessage): void {
    let events: DriverEvent[];
    try {
      events = run.adapter.map(msg);
    } catch (err) {
      // A mapping bug must read as "one message lost", not as a dead session.
      this.#log(`could not map a message: ${describeError(err)}`);
      return;
    }
    for (const ev of events) this.#dispatch(ev);
  }

  #dispatch(ev: DriverEvent): void {
    switch (ev.k) {
      case 'session':
        this.#sessionId = ev.id;
        this.#emit(ev);
        return;
      case 'result':
      case 'fatal':
        if (!this.#inFlight) {
          this.#log(`ignored a ${ev.k} with no turn in flight`);
          return;
        }
        this.#finishTurn(ev);
        this.#pump();
        return;
      default:
        // Activity with no prompt behind it (a background task waking the CLI) would put
        // the pet in a state no turn accounts for.
        if (this.#inFlight) this.#emit(ev);
        else this.#log(`dropped a ${ev.k} event with no turn in flight`);
    }
  }

  /**
   * Discard a query. Whatever it was doing is over: dangling tools are closed, the
   * in-flight turn (if any) gets `terminal`, and the next prompt will start a new query
   * that resumes the last known session.
   */
  #endRun(run: Run, terminal: DriverEvent): void {
    if (this.#run !== run) return;
    this.#run = undefined;
    this.#clearGrace();
    this.#abortPermissions();
    run.input.end();
    try {
      run.q?.close();
    } catch (err) {
      this.#log(`query close failed: ${describeError(err)}`);
    }
    run.abort.abort();
    run.markGone();
    for (const ev of run.adapter.abandon()) this.#dispatch(ev);
    if (this.#inFlight) this.#finishTurn(terminal);
    this.#pump();
  }

  #buildOptions(run: Run): Options {
    const cfg = this.#cfg;
    const options: Options = {
      abortController: run.abort,
      cwd: this.#opts.cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: [...(cfg.settingSources ?? ['project', 'local'])],
      canUseTool: (tool, input, o) => this.#canUseTool(run, tool, input, o),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_RULES },
      // The SDK REPLACES the child's environment when `env` is set, so PATH, HOME and the
      // rest have to be carried over by hand.
      env: { ...process.env, ANTHROPIC_API_KEY: cfg.apiKey },
      stderr: (data) => this.#log(`claude stderr: ${data}`),
    };
    if (this.#sessionId !== undefined) options.resume = this.#sessionId;
    if (cfg.model !== undefined) options.model = cfg.model;
    if (cfg.maxTurns !== undefined) options.maxTurns = cfg.maxTurns;
    if (cfg.pathToClaudeCodeExecutable !== undefined) options.pathToClaudeCodeExecutable = cfg.pathToClaudeCodeExecutable;
    if (cfg.hardDeny !== undefined) options.hooks = { PreToolUse: [{ hooks: [this.#hardDenyHook(cfg.hardDeny)] }] };
    return options;
  }

  // ---------------------------------------------------------------------------
  // Permissions
  // ---------------------------------------------------------------------------

  async #canUseTool(
    run: Run,
    tool: string,
    input: Record<string, unknown>,
    o: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    // A request from a query we have discarded, or after close, is answered with a refusal
    // rather than put in front of the user for an answer nobody is waiting for.
    if (this.#closed || this.#run !== run) return deny(MSG_STALE);

    // Ours, not the SDK's, so interrupt() and close() can cancel it, and linked to the
    // SDK's so its own cancellation also reaches the handler.
    const ac = new AbortController();
    const onSdkAbort = (): void => ac.abort();
    if (o.signal.aborted) ac.abort();
    else o.signal.addEventListener('abort', onSdkAbort, { once: true });
    this.#pending.add(ac);
    try {
      if (ac.signal.aborted) return deny(MSG_STOPPED, true);
      const aborted = new Promise<'aborted'>((resolve) => {
        ac.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });
      const decision: unknown = await Promise.race([
        // structuredClone throws on something it cannot copy, which lands in the catch: a deny.
        this.#opts.onPermission({ tool, input: structuredClone(input), toolUseId: o.toolUseID, signal: ac.signal }),
        aborted,
      ]);
      // An abort that lands after the handler answered still wins: the turn it belonged
      // to is over, and an approval is only ever for a question somebody is waiting on.
      if (ac.signal.aborted || decision === 'aborted') return deny(MSG_STOPPED, true);
      if (typeof decision === 'object' && decision !== null) {
        const d = decision as { allow?: unknown; message?: unknown; interrupt?: unknown };
        // `=== true`, not truthiness: only an explicit allow allows.
        if (d.allow === true) return { behavior: 'allow', updatedInput: input };
        if (d.allow === false) {
          const message = typeof d.message === 'string' && d.message !== '' ? d.message : MSG_INTERNAL;
          return deny(message, d.interrupt === true);
        }
      }
      this.#log(`permission handler gave an unusable answer for ${this.#toolLabel(tool)}`);
      return deny(MSG_INTERNAL);
    } catch (err) {
      // The message is not logged: it may echo the tool input, which can hold secrets.
      this.#log(`permission handler failed for ${this.#toolLabel(tool)}: ${err instanceof Error ? err.name : 'non-error'}`);
      return deny(MSG_INTERNAL);
    } finally {
      o.signal.removeEventListener('abort', onSdkAbort);
      this.#pending.delete(ac);
    }
  }

  #abortPermissions(): void {
    for (const ac of this.#pending) ac.abort();
    this.#pending.clear();
  }

  #hardDenyHook(hardDeny: NonNullable<ClaudeDriverConfig['hardDeny']>): HookCallback {
    return (input) => {
      if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
      let reason: string | undefined;
      try {
        reason = hardDeny(input.tool_name, asRecord(input.tool_input));
      } catch {
        // A rule that cannot be evaluated cannot be said to pass.
        reason = MSG_HOOK_FAILED;
      }
      // No opinion is `{}`, never an explicit allow: an allow here would skip the approval
      // flow for every call that is merely not forbidden.
      if (reason === undefined) return Promise.resolve({});
      return Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason === '' ? MSG_HOOK_FAILED : reason,
        },
      });
    };
  }

  // ---------------------------------------------------------------------------
  // Plumbing
  // ---------------------------------------------------------------------------

  /** A terminal event handler or a log sink that throws must not be able to break the driver. */
  #emit(ev: DriverEvent): void {
    try {
      this.#opts.onEvent(ev);
    } catch (err) {
      this.#log(`onEvent threw on ${ev.k}: ${describeError(err)}`);
    }
  }

  #redact(s: string): string {
    const key = this.#cfg.apiKey;
    // A key of a few characters would shred every message it appears in; real keys are long.
    return key.length >= 8 ? s.split(key).join('***') : s;
  }

  #log(line: string): void {
    try {
      this.#opts.log?.(sanitize(this.#redact(line), LOG_LINE_MAX));
    } catch {
      // nowhere left to report a broken logger
    }
  }

  #toolLabel(tool: unknown): string {
    return sanitize(typeof tool === 'string' ? tool : '?', 48) || '?';
  }

  /** Error text bound for a `fatal` event: one short ASCII line with the API key scrubbed. */
  #fatalText(prefix: string, err: unknown): string {
    return sanitize(this.#redact(`${prefix}: ${describeError(err)}`), FATAL_MSG_MAX);
  }
}

export function claudeDriverFactory(cfg: ClaudeDriverConfig, deps: ClaudeDriverDeps = {}): DriverFactory {
  // Loaded on first use, not at import: the fake-claude mode and the unit tests never need
  // the SDK, and importing it costs a quarter of a second. A failed import is not cached.
  let loading: Promise<QueryFn> | undefined;
  const getQuery = (): Promise<QueryFn> => {
    if (deps.query !== undefined) return Promise.resolve(deps.query);
    loading ??= import('@anthropic-ai/claude-agent-sdk').then(
      (m) => m.query,
      (err: unknown) => {
        loading = undefined;
        throw err;
      },
    );
    return loading;
  };
  return (opts) => new ClaudeDriver(cfg, deps, getQuery, opts);
}
