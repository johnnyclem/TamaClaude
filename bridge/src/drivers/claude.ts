/**
 * The real Claude driver: one long-lived Agent SDK query serving every turn.
 *
 * It owns LIFECYCLE and SAFETY; the SDK's message shapes are the adapter's business.
 *
 * What the handheld's approval depends on, in order of importance. Every claim below was
 * measured against the real CLI bundled with the SDK (test/real-cli.integration.test.ts,
 * run with BRIDGE_REAL_CLI=1) rather than read from the typings, because an earlier version
 * of this comment asserted things the CLI did not do.
 *
 *  1. The only road to `allow` is `onPermission` returning `{ allow: true }`. A throw, a
 *     rejection, a malformed answer, an abort, a stale session: all of them are a deny.
 *  2. Nothing may auto-approve before the device is asked, and the CLI has three ways to try:
 *     allow rules and `allowed-tools` in the repository's settings files, hooks the repository
 *     ships, and the CLI's own idea of what is safe (reads inside the working directory,
 *     `ls`, `git status`). Two layers close them, and both are needed:
 *       a. `managedSettings` (allowManagedPermissionRulesOnly, allowManagedHooksOnly) makes
 *          the CLI ignore permission rules and hooks from project and local settings. The
 *          driver's own SDK hook still runs (measured), and `disableAllHooks` in a repository
 *          cannot switch it off (measured).
 *       b. The driver's PreToolUse hook answers `ask` for every call `needsAsk` says needs a
 *          tap, which overrides any allow rule and the CLI's auto-allow. Only calls the
 *          bridge itself rates low (built-in read-only tools inside the working directory)
 *          are left to the CLI, and the hook asks about everything when no `needsAsk` is
 *          configured. `hardDeny` is checked first, so a forbidden call is refused without
 *          the device ever seeing it.
 *  3. What the user approved is what runs. The handler is given a COPY of the tool
 *     input, and the original goes back to the SDK, so a handler that mutates its
 *     argument cannot change the approved call after the fact.
 *  4. The model's tool subprocesses do not inherit the bridge's secrets. The child
 *     environment is an ALLOWLIST (see CHILD_ENV_NAMES): BRIDGE_TOKEN, cloud credentials and
 *     every other variable stay behind unless the operator names them. The one secret the CLI
 *     needs, the API key, is visible to the commands a person approves: the CLI passes its
 *     own environment on, and scrubbing it needs a sandbox this project does not require.
 *  5. A repository cannot redirect the key. Its settings `env` is applied on top of the
 *     process environment, so a project could point ANTHROPIC_BASE_URL (or a proxy) at its own
 *     server and read the x-api-key header (measured, in trusted and untrusted workspaces).
 *     The driver pins those names, and `apiKeyHelper`, in the highest-priority settings layer
 *     (the `--settings` flag layer), which a project file cannot outrank.
 *
 * The DriverEvent invariant (exactly one terminal per accepted prompt) is kept by
 * making turns strictly sequential. The CLI may fold prompts sent close together into
 * one turn with one result, which would leave one of ours without a terminal, so the
 * driver holds a second prompt until the first has ended instead of pushing it early.
 * Each prompt carries a uuid and only a result that echoes it ends the turn, so a turn the
 * CLI started by itself can never be reported as the answer (see the adapter).
 *
 * Failure behaviour worth knowing:
 *  - A saved session id the CLI cannot find ("No conversation found", e.g. after its 30 day
 *    transcript cleanup) is forgotten and the same prompt is retried ONCE on a fresh
 *    session. The new id arrives as an ordinary `session` event, which the server stores.
 *  - A rejected key or another API error that retrying cannot fix ends the turn at once with
 *    a short sentence, instead of the CLI's three minutes of backoff.
 *  - Background and delegated work is switched off (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS),
 *    because its results arrive as turns nobody asked for, after the answer was given.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import type { AdapterEvent } from './claude-adapter.ts';
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
  /**
   * Whether this call must be put in front of the device (true) or may be left to the CLI's
   * own rules (false; in practice the built-in read-only tools inside the working directory).
   * Answered in the same PreToolUse hook, after `hardDeny`, as `permissionDecision: 'ask'`,
   * so no allow rule, local settings file or CLI auto-allow can skip the tap. Anything but an
   * explicit `false` (including a throw) asks, and so does leaving it unset.
   */
  needsAsk?: (tool: string, input: Record<string, unknown>) => boolean;
  /**
   * Extra environment variable NAMES to hand to the Claude child process, on top of the
   * allowlist. BRIDGE_TOKEN and the names the driver controls itself are refused.
   */
  passEnv?: string[];
}

type QueryFn = typeof sdkQuery;

export interface ClaudeDriverDeps {
  /** Replaces the SDK's `query` (tests). When absent the SDK is imported on first use. */
  query?: QueryFn;
  clock?: Clock;
  /** How long to wait for the CLI to wind a turn down after `interrupt()` before giving up on it. */
  interruptGraceMs?: number;
  /** The environment the child's is built from. Default: the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Where the pinned settings file is written. Default: a private directory under the temp dir. */
  settingsDir?: string;
}

const DEFAULT_INTERRUPT_GRACE_MS = 8000;
const LOG_LINE_MAX = 200;
const FATAL_MSG_MAX = 160;

/** What the MODEL is told when the bridge itself, not the user, ended an ask. */
const MSG_STOPPED = 'The turn was stopped by the user.';
const MSG_INTERNAL = 'The action was not run because the bridge could not ask the user. Do not retry it; tell the user what you were trying to do.';
const MSG_STALE = 'The bridge session is no longer active, so the action was not run.';
const MSG_NO_TURN = 'No request from the user is waiting on this action, so it was not run.';
const MSG_HOOK_FAILED = 'The bridge could not check this action against its safety rules, so it was not run.';
/** Shown by the CLI beside an `ask` from the hook; the device shows its own text. */
const MSG_ASK = 'The bridge puts this action in front of the user on the handheld.';

/** Fresh each time: a consumer is free to keep or modify an event it was handed. */
const interrupted = (): DriverEvent => ({ k: 'result', ok: false, text: '', subtype: 'interrupted' });
const closedFatal = (): DriverEvent => ({ k: 'fatal', msg: 'The Claude session was closed.' });

// ---------------------------------------------------------------------------
// What the Claude child process is given
// ---------------------------------------------------------------------------

/**
 * The environment variables the Claude child inherits, by exact name. Everything else in the
 * bridge's environment stays behind: BRIDGE_TOKEN (the child's tool subprocesses could
 * otherwise connect to the bridge as the device and approve their own asks), cloud and
 * source-host credentials, and the ambient provider switches (CLAUDE_CODE_USE_BEDROCK,
 * CLAUDE_CODE_REMOTE, ANTHROPIC_AUTH_TOKEN) that would override the API key.
 *
 * What the CLI and a person's tools need to run at all: where to find programs and the home
 * directory, who and what shell, locale and terminal, a scratch directory and the time zone;
 * the proxy and certificate settings a corporate network needs, in both spellings of the
 * proxy names; and the CLI's own configuration directory. Anything else an operator wants
 * the model's commands to see (SSH_AUTH_SOCK, ANTHROPIC_BASE_URL for a gateway) is named
 * with `passEnv`, on purpose and one by one. This list targets macOS and Linux.
 */
export const CHILD_ENV_NAMES: ReadonlySet<string> = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CLAUDE_CONFIG_DIR',
]);
/** Families of names passed whole: locale categories (LC_ALL, LC_CTYPE, ...) and the XDG directories. */
export const CHILD_ENV_PREFIXES: readonly string[] = ['LC_', 'XDG_'];

/**
 * Names `passEnv` may not carry. The token is the credential that would let the child
 * impersonate the device; the other two are set by the driver and an operator must not be
 * able to undo them (the key is the configured one, background work stays off).
 */
const NEVER_PASS: ReadonlySet<string> = new Set([
  'BRIDGE_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChildEnv {
  env: Record<string, string>;
  /** `passEnv` entries that were not honoured, so the log can say so. */
  refused: string[];
}

/**
 * The child's whole environment (the SDK REPLACES it when `env` is set, so nothing is
 * inherited behind this function's back).
 */
export function buildChildEnv(source: NodeJS.ProcessEnv, apiKey: string, passEnv: readonly string[] = []): ChildEnv {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    if (CHILD_ENV_NAMES.has(name) || CHILD_ENV_PREFIXES.some((p) => name.startsWith(p))) env[name] = value;
  }
  const refused: string[] = [];
  for (const name of passEnv) {
    if (!ENV_NAME.test(name) || NEVER_PASS.has(name)) {
      refused.push(name);
      continue;
    }
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  // Last, so nothing above can change them.
  env.ANTHROPIC_API_KEY = apiKey;
  // Background and delegated work finishes in a later turn nobody asked for, after the answer
  // was given (measured: the Agent tool returns "launched" at once and its report arrives
  // seconds later as a turn of its own). Off, the Agent tool runs in the foreground and
  // `run_in_background` is refused as an invalid parameter.
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  return { env, refused };
}

const API_BASE_DEFAULT = 'https://api.anthropic.com';
/** Every spelling the CLI's HTTP stack reads; a repository's `env` can set any of them. */
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy'] as const;

/**
 * Settings the repository must not be able to change, written to the flag layer (the
 * `--settings` file), which outranks project and local settings.
 *
 *  - `env`: the API endpoint and the proxies. A project's own `env` otherwise wins over the
 *    process environment and can send the x-api-key header to a server of its choosing
 *    (measured). Each is pinned to what the OPERATOR gave the child, or to the public API /
 *    no proxy. Proxy URLs can carry a password, which is why this goes in a 0600 file and
 *    not in the command line, where `ps` would show it.
 *  - `apiKeyHelper`: a command the CLI runs to obtain a key, with no question asked
 *    (measured). Emptied.
 *
 * What this does NOT cover: a repository's `env` can still set variables for the commands the
 * person approves (BASH_ENV, LD_PRELOAD, PATH). That is the same trust a person gives a
 * repository when they run its build, and the README says so.
 */
export function pinnedSettings(childEnv: Readonly<Record<string, string>>): { env: Record<string, string>; apiKeyHelper: string } {
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: childEnv.ANTHROPIC_BASE_URL ?? API_BASE_DEFAULT };
  for (const name of PROXY_NAMES) env[name] = childEnv[name] ?? '';
  return { env, apiKeyHelper: '' };
}

/**
 * Policy-tier settings the SDK hands the CLI as managed settings. `allowManagedPermissionRulesOnly`
 * makes the CLI ignore `permissions` and skill `allowed-tools` from project, local and flag
 * settings; `allowManagedHooksOnly` ignores their command hooks. The driver's own SDK hook is
 * not a settings hook and keeps running (measured). Without these a repository's
 * `.claude/settings.local.json` allow rule ran a tool with no question asked.
 */
const MANAGED_LOCK = { allowManagedPermissionRulesOnly: true, allowManagedHooksOnly: true } as const;

/**
 * Tools the model is not offered at all. The device cannot show a multiple-choice question
 * (a tap on ALLOW would tell the model "the user did not answer"), and the others create
 * turns that start on their own later, which a voice session does not listen for. src/tools.ts
 * also refuses a call to any of them with a reason the model reads (a test pins that every
 * name here is refused there too); removing them from the request also saves about a fifth of
 * every request's size (measured: 44.7 KB to 35.2 KB).
 */
export const UNSERVED_TOOLS: readonly string[] = [
  'AskUserQuestion', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'Monitor',
];

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
  /** It was started to continue a saved session. */
  readonly resumed: boolean;
  /** The CLI has reported a session id, so the saved one was found. */
  sessionSeen: boolean;
}

/** The prompt handed to Claude whose terminal event has not been emitted yet. */
interface Current {
  readonly text: string;
  uuid: string;
  /** It already got its one retry on a fresh session. */
  retried: boolean;
}

function userMessage(text: string, uuid: string): SDKUserMessage {
  return {
    type: 'user',
    // The CLI echoes this on every frame of the turn it runs for the prompt; the adapter
    // attributes a turn and its result to the prompt only through it.
    uuid: uuid as SDKUserMessage['uuid'],
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

const STALE_RESUME_TEXT = 'No conversation found with session ID';

class ClaudeDriver implements SessionDriver {
  readonly #cfg: ClaudeDriverConfig;
  readonly #opts: DriverOptions;
  readonly #deps: ClaudeDriverDeps;
  readonly #getQuery: () => Promise<QueryFn>;
  readonly #clock: Clock;
  readonly #graceMs: number;

  #closed = false;
  #sessionId: string | undefined;
  #run: Run | undefined;
  /** A prompt has been handed to Claude and its terminal event has not been emitted yet. */
  #inFlight = false;
  #current: Current | undefined;
  /** Accepted prompts not yet handed to Claude. */
  #waiting: string[] = [];
  /** One controller per open permission request, so interrupt and close can cancel them all. */
  #pending = new Set<AbortController>();
  #grace: TimerHandle | undefined;
  /** The pinned settings file, once written, and the directory to remove with it (when ours). */
  #pinFile: string | undefined;
  #pinDir: string | undefined;

  constructor(cfg: ClaudeDriverConfig, deps: ClaudeDriverDeps, getQuery: () => Promise<QueryFn>, opts: DriverOptions) {
    this.#cfg = cfg;
    this.#opts = opts;
    this.#deps = deps;
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
    this.#removePinFile();
  }

  // ---------------------------------------------------------------------------
  // Turn sequencing
  // ---------------------------------------------------------------------------

  /** Hand the next waiting prompt to Claude, if the previous turn is over. */
  #pump(): void {
    while (!this.#closed && !this.#inFlight && this.#waiting.length > 0) {
      const text = this.#waiting.shift()!;
      this.#inFlight = true;
      const current: Current = { text, uuid: '', retried: false };
      this.#current = current;
      this.#send(this.#run ?? this.#startRun(), current);
    }
  }

  /** Give the prompt a fresh uuid, tell the adapter to expect it, and push it. */
  #send(run: Run, current: Current): void {
    current.uuid = randomUUID();
    run.adapter.begin(current.uuid);
    run.input.push(userMessage(current.text, current.uuid));
  }

  /** The turn is over: clear the state BEFORE telling anyone, so a handler may call prompt() from onEvent. */
  #finishTurn(terminal: DriverEvent): void {
    this.#inFlight = false;
    this.#current = undefined;
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
      resumed: this.#sessionId !== undefined,
      sessionSeen: false,
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
      this.#endRun(run, { k: 'fatal', msg: this.#fatalText('Claude did not start', err) });
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
      if (this.#run !== run) return;
      // Some CLI versions report a missing transcript by failing the stream instead of
      // sending a result first; the recovery is the same.
      if (describeError(err).includes(STALE_RESUME_TEXT) && this.#recoverStaleResume(run)) return;
      this.#endRun(run, { k: 'fatal', msg: this.#fatalText('Claude failed', err) });
      return;
    }
    // The stream ended. With a turn in flight that is a missing answer; when idle the CLI
    // simply went away and the next prompt starts a new query.
    if (this.#run === run) this.#endRun(run, { k: 'fatal', msg: 'Claude ended the session without an answer.' });
  }

  #onMessage(run: Run, msg: SDKMessage): void {
    let events: AdapterEvent[];
    try {
      events = run.adapter.map(msg);
    } catch (err) {
      // A mapping bug must read as "one message lost", not as a dead session.
      this.#log(`could not map a message: ${describeError(err)}`);
      return;
    }
    for (const ev of events) {
      // An earlier event of the same message may have discarded this run.
      if (this.#run !== run) return;
      this.#dispatch(run, ev);
    }
  }

  #dispatch(run: Run, ev: AdapterEvent): void {
    switch (ev.k) {
      case 'session':
        run.sessionSeen = true;
        this.#sessionId = ev.id;
        this.#emit(ev);
        return;
      case 'resume_failed':
        if (!this.#recoverStaleResume(run)) {
          this.#endRun(run, { k: 'result', ok: false, text: 'The saved conversation could not be found.', subtype: 'error_during_execution' });
        }
        return;
      case 'api_retry':
        this.#log(`api retry ${ev.attempt}/${ev.max}: ${ev.error} status=${ev.status ?? 'none'}`);
        // Waiting cannot fix a rejected key; the CLI would back off for minutes before saying so.
        if (ev.giveUp !== undefined && this.#inFlight) {
          this.#endRun(run, { k: 'result', ok: false, text: ev.giveUp, subtype: 'api_error' });
        }
        return;
      case 'foreign_result':
        this.#log('ignored a result that is not the answer to the prompt in flight');
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
   * The saved session cannot be resumed. Forget its id and run the same prompt once more on
   * a fresh session, silently: the first attempt never ran anything. The new id reaches the
   * server as an ordinary `session` event and replaces the stored one.
   */
  #recoverStaleResume(run: Run): boolean {
    const current = this.#current;
    if (this.#run !== run || !this.#inFlight || current === undefined || current.retried || !run.resumed || run.sessionSeen) {
      return false;
    }
    this.#log('the saved session could not be resumed; starting a fresh one');
    this.#sessionId = undefined;
    current.retried = true;
    this.#discard(run);
    this.#send(this.#startRun(), current);
    return true;
  }

  /** Stop one query and forget it, without saying anything about the turn. */
  #discard(run: Run): void {
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
  }

  /**
   * Discard a query. Whatever it was doing is over: dangling tools are closed, the
   * in-flight turn (if any) gets `terminal`, and the next prompt will start a new query
   * that resumes the last known session.
   */
  #endRun(run: Run, terminal: DriverEvent): void {
    if (this.#run !== run) return;
    this.#discard(run);
    for (const ev of run.adapter.abandon()) this.#dispatch(run, ev);
    if (this.#inFlight) this.#finishTurn(terminal);
    this.#pump();
  }

  #buildOptions(run: Run): Options {
    const cfg = this.#cfg;
    const apiKey = cfg.apiKey.trim();
    const { env, refused } = buildChildEnv(this.#deps.env ?? process.env, apiKey, cfg.passEnv);
    if (refused.length > 0) this.#log(`ignored environment names that may not be passed: ${refused.join(', ')}`);
    const options: Options = {
      abortController: run.abort,
      cwd: this.#opts.cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      settingSources: [...(cfg.settingSources ?? ['project', 'local'])],
      managedSettings: { ...MANAGED_LOCK },
      settings: this.#pinFilePath(env),
      // Only MCP servers the bridge passes (it passes none): a repository's .mcp.json would
      // otherwise start its servers at once, with no question asked (measured).
      strictMcpConfig: true,
      // The words are dictated or typed, never a CLI command: without this "/clear" wipes the
      // conversation, "/cost" becomes the answer, and "@/etc/hostname" reads a file into the
      // prompt with no question asked (all measured). Measured cost on this CLI: none, the
      // repository's CLAUDE.md, rules and skill listing still arrive.
      verbatimPrompts: true,
      disallowedTools: [...UNSERVED_TOOLS],
      canUseTool: (tool, input, o) => this.#canUseTool(run, tool, input, o),
      systemPrompt: { type: 'preset', preset: 'claude_code', append: VOICE_RULES },
      env,
      stderr: (data) => this.#log(`claude stderr: ${data}`),
      hooks: { PreToolUse: [{ hooks: [this.#toolHook()] }] },
    };
    if (this.#sessionId !== undefined) options.resume = this.#sessionId;
    if (cfg.model !== undefined) options.model = cfg.model;
    if (cfg.maxTurns !== undefined) options.maxTurns = cfg.maxTurns;
    if (cfg.pathToClaudeCodeExecutable !== undefined) options.pathToClaudeCodeExecutable = cfg.pathToClaudeCodeExecutable;
    return options;
  }

  /** Write the pinned settings once and hand the CLI the path. Throws, which fails the start: better than an unpinned key. */
  #pinFilePath(env: Record<string, string>): string {
    if (this.#pinFile !== undefined) return this.#pinFile;
    let dir = this.#deps.settingsDir;
    if (dir === undefined) {
      dir = mkdtempSync(join(tmpdir(), 'tamaclaude-'));
      this.#pinDir = dir;
    }
    const file = join(dir, 'bridge-settings.json');
    writeFileSync(file, JSON.stringify(pinnedSettings(env)), { mode: 0o600 });
    this.#pinFile = file;
    return file;
  }

  #removePinFile(): void {
    try {
      if (this.#pinDir !== undefined) rmSync(this.#pinDir, { recursive: true, force: true });
      else if (this.#pinFile !== undefined) rmSync(this.#pinFile, { force: true });
    } catch (err) {
      this.#log(`could not remove the pinned settings: ${describeError(err)}`);
    }
    this.#pinFile = undefined;
    this.#pinDir = undefined;
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
    // No prompt in flight means a turn the user did not ask for (or one that ended): the
    // device is idle and has nobody to show a question to.
    if (!this.#inFlight) return deny(MSG_NO_TURN);

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

  /**
   * The PreToolUse hook: the bridge's say before any allow rule or auto-allow. In order,
   * a forbidden call is refused (the device never sees it), then a call that needs a tap is
   * forced to ask, and only what is left is up to the CLI. It never answers `allow`: an allow
   * here would skip the approval flow for every call that is merely not forbidden.
   */
  #toolHook(): HookCallback {
    const { hardDeny, needsAsk } = this.#cfg;
    return (input) => {
      if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
      const tool = input.tool_name;
      const args = asRecord(input.tool_input);

      let reason: string | undefined;
      try {
        reason = hardDeny?.(tool, args);
      } catch {
        // A rule that cannot be evaluated cannot be said to pass.
        reason = MSG_HOOK_FAILED;
      }
      if (reason !== undefined) {
        return Promise.resolve({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason === '' ? MSG_HOOK_FAILED : reason,
          },
        });
      }

      let ask = true;
      if (needsAsk !== undefined) {
        try {
          // Only an explicit `false` leaves the call to the CLI.
          ask = needsAsk(tool, args) !== false;
        } catch {
          ask = true;
        }
      }
      if (!ask) return Promise.resolve({});
      return Promise.resolve({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'ask',
          permissionDecisionReason: MSG_ASK,
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
    // The raw value too: it may differ from the trimmed one the child was given.
    let out = s;
    for (const key of new Set([this.#cfg.apiKey, this.#cfg.apiKey.trim()])) {
      // A key of a few characters would shred every message it appears in; real keys are long.
      if (key.length >= 8) out = out.split(key).join('***');
    }
    return out;
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

  /**
   * Error text bound for a `fatal` event: one short ASCII line with the API key scrubbed.
   * The wire carries only 64 characters of it, so what a person can act on comes first: the
   * SDK's own wording ("Claude Code native binary not found at /path ...") already says
   * what happened and is not prefixed again.
   */
  #fatalText(prefix: string, err: unknown): string {
    const detail = this.#redact(describeError(err));
    return sanitize(/^Claude\b/.test(detail) ? detail : `${prefix}: ${detail}`, FATAL_MSG_MAX);
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
