/**
 * A scripted stand-in for Claude Code, so the whole bridge can be exercised with no
 * API key and no network: in unit tests, in the end-to-end test, and behind
 * `--fake-claude` for a person trying the protocol with a fake device.
 *
 * It is only worth having if it is as strict as the real driver, so it keeps the same
 * promises (see DriverEvent in types.ts):
 *
 *  - events arrive in the order the SDK produces them: `tool_start` BEFORE the
 *    permission request (the SDK reveals the tool_use, then asks) and `tool_end`
 *    after it is answered;
 *  - every accepted prompt ends with exactly ONE terminal event, `result` or `fatal`,
 *    and nothing follows it. That includes a prompt that is interrupted, even one
 *    interrupted before it started;
 *  - every `tool_start` is matched by a `tool_end` before the terminal event, also
 *    when the turn is interrupted;
 *  - a denied or timed-out permission is not an error: the tool ends `ok: false` and
 *    the turn carries on to a result that says what was refused;
 *  - after `close()` nothing is emitted at all, not even the terminal event of the turn
 *    that was running. The consumer that closes a driver has stopped listening.
 *
 * A turn never waits on the permission handler alone. Every wait is raced against the
 * turn's abort signal, because the handler is somebody else's code: one that ignores
 * its signal must not be able to leave a turn without its terminal event.
 *
 * SCENARIOS. The scenario is picked from the prompt, lower-cased, by SUBSTRING (not by
 * word, so "latest" selects `bash` through "test"). The first row that matches wins,
 * so a prompt that mentions two things gets the earlier row:
 *
 *   row  scenario   prompt contains         what it does
 *   ---  ---------  ----------------------  ----------------------------------------------
 *    1   danger     "danger", "rm -rf"      Bash {command:'rm -rf ~'}, asks; the permission
 *                                           layer is expected to refuse it
 *    2   parallel   "two", "parallel"       Bash 'npm test' and Edit src/app.ts started
 *                                           together, both asking at once
 *    3   edit       "edit", "write"         Edit {file_path:'src/app.ts', ...}, asks
 *    4   bash       "bash", "test", "run"   Bash {command:'npm test'}, asks
 *    5   unicode    "unicode"               a result full of curly quotes, accents, emoji
 *    6   long       "long"                  a result of several markdown sentences with a
 *                                           code fence and a URL
 *    7   slow       "slow"                  Grep, which needs no permission, and never
 *                                           finishes until interrupted
 *    8   error      "error"                 result {ok:false, 'error_during_execution'}
 *    9   fatal      "fatal"                 a `fatal` event
 *   10   echo       (anything else)         a short thought, then "You said: <prompt>"
 *
 * `slow` uses a tool that needs no permission on purpose, so a test can abort a tool
 * that is RUNNING without first wiring up an approval handler.
 */

import type {
  DriverEvent,
  DriverFactory,
  DriverOptions,
  PermissionDecision,
  SessionDriver,
} from '../types.ts';

export interface FakeDriverExtra {
  /** Pause between steps, in milliseconds. Default 0: no pause at all. */
  delayMs?: number;
  /** Replaces the real timer so a test never waits; called with `delayMs`. */
  sleep?: (ms: number) => Promise<void>;
}

/** Row order is precedence order. `echo` has no keywords: it is what is left. */
export const FAKE_SCENARIOS = [
  { name: 'danger', keywords: ['danger', 'rm -rf'] },
  { name: 'parallel', keywords: ['two', 'parallel'] },
  { name: 'edit', keywords: ['edit', 'write'] },
  { name: 'bash', keywords: ['bash', 'test', 'run'] },
  { name: 'unicode', keywords: ['unicode'] },
  { name: 'long', keywords: ['long'] },
  { name: 'slow', keywords: ['slow'] },
  { name: 'error', keywords: ['error'] },
  { name: 'fatal', keywords: ['fatal'] },
  { name: 'echo', keywords: [] },
] as const;

export type FakeScenario = (typeof FAKE_SCENARIOS)[number]['name'];

/** The scenario a prompt selects. Exported so a test can say what it expects to get. */
export function fakeScenarioFor(prompt: string): FakeScenario {
  const p = (typeof prompt === 'string' ? prompt : '').toLowerCase();
  for (const sc of FAKE_SCENARIOS) {
    if (sc.keywords.some((k) => p.includes(k))) return sc.name;
  }
  return 'echo';
}

// ---------------------------------------------------------------------------
// What the scenarios say. Written as escapes where non-ASCII: the whole point of the
// unicode scenario is that the servers must cope, and an invisible character in this
// file's own source is not something a reviewer can see.
// ---------------------------------------------------------------------------

const UNICODE_TEXT =
  'I fixed the \u201cna\u00efve\u201d parser \u2014 the caf\u00e9 menu loads again. ' +
  'It was a one\u2011character bug \u2026 enjoy the r\u00e9sum\u00e9 \u00bd page \u{1F389}\u{1F680}';

const LONG_TEXT = [
  '## Summary',
  '',
  'I went through the **project** and found three problems. The first is a missing null check in `parse()`, ' +
    'which crashed on empty input. The second is a slow loop in the importer, and the third is a stale lockfile.',
  '',
  '```ts',
  'function parse(input?: string) {',
  "  return input ? input.trim() : '';",
  '}',
  '```',
  '',
  'I fixed all three and added a test for each. The full notes are at https://example.com/notes/2026/fixes?ref=fake ' +
    'and in the pull request.',
  '',
  '- Fixed the null check.',
  '- Sped up the importer.',
  '- Refreshed the lockfile.',
  '',
  'Everything passes now.',
].join('\n');

const INTERRUPTED_TEXT = 'Stopped before finishing.';

interface ToolSpec {
  name: string;
  input: Record<string, unknown>;
  /** How a refusal names it. */
  label: string;
  /** Finishes "I ...": what happened if it was allowed. */
  did: string;
}

const BASH_TEST: ToolSpec = {
  name: 'Bash', input: { command: 'npm test' }, label: 'Bash (npm test)', did: 'ran npm test',
};
const EDIT_APP: ToolSpec = {
  name: 'Edit',
  input: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
  label: 'Edit (src/app.ts)',
  did: 'edited src/app.ts',
};
const BASH_DANGER: ToolSpec = {
  name: 'Bash',
  input: { command: 'rm -rf ~' },
  label: 'Bash (rm -rf ~)',
  // Nothing here runs anything. Say so, in case a test handler does allow it.
  did: 'pretended to run rm -rf ~ (this is the fake driver)',
};
const GREP_SLOW: ToolSpec = {
  name: 'Grep', input: { pattern: 'TODO', path: '.' }, label: 'Grep (TODO)', did: 'searched the repository',
};

/** The model is told why on a refusal, and a fake that drops that text hides a bug in the caller. */
const MSG_PERMISSION_FAILED = 'The permission check failed, so the action was not run.';
const MSG_REFUSED = 'The action was refused.';

interface Verdict { spec: ToolSpec; allowed: boolean; message: string }

function summarise(verdicts: readonly Verdict[]): string {
  const parts: string[] = [];
  const did = verdicts.filter((v) => v.allowed).map((v) => v.spec.did);
  if (did.length > 0) parts.push(`I ${did.join(' and ')}.`);
  for (const v of verdicts) {
    if (!v.allowed) parts.push(`${v.spec.label} was refused, so it did not run. ${v.message}`.trim());
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Machinery
// ---------------------------------------------------------------------------

/** Thrown through a script to unwind it when its turn is interrupted or the driver closes. */
class Interrupted extends Error {}

/**
 * Settles with `p`, or rejects with Interrupted the moment `signal` aborts, whichever
 * comes first. The listener is removed either way, so a long turn does not pile them up.
 */
function guard<T>(p: Promise<T> | T, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Interrupted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Interrupted());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(p).then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e: unknown) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}

const realSleep = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/** Counts drivers made without a session to resume, so two fakes never share an id. */
let created = 0;

interface Turn {
  readonly abort: AbortController;
  /** Tool ids started and not ended, in start order. */
  readonly open: Set<string>;
  /** Set when the terminal event goes out; nothing is emitted for the turn after that. */
  terminal: boolean;
  /** Settles when the turn has fully unwound. Never rejects. */
  done: Promise<void>;
}

/** What a scenario script may do. Only `step`, `useTools` and `hang` can be cut short by an interrupt. */
interface Ctx {
  prompt: string;
  /** A pause, and the place an interrupt or close is noticed. */
  step(): Promise<void>;
  say(text: string): void;
  /** Starts all the tools, then asks about all of them at once. Resolves in `specs` order. */
  useTools(specs: readonly ToolSpec[]): Promise<Verdict[]>;
  /** Starts a tool and leaves it running, with no permission request. */
  startTool(spec: ToolSpec): void;
  /** Never returns; the turn's way out is the interrupt that rejects it. */
  hang(): Promise<never>;
  /** The one way a turn ends. */
  finish(e: DriverEvent): void;
}
type Script = (c: Ctx) => Promise<void>;

async function toolTurn(c: Ctx, narration: string, specs: readonly ToolSpec[]): Promise<void> {
  c.say(narration);
  await c.step();
  const verdicts = await c.useTools(specs);
  await c.step();
  c.finish({ k: 'result', ok: true, text: summarise(verdicts), subtype: 'success' });
}

const SCRIPTS: Record<FakeScenario, Script> = {
  danger: (c) => toolTurn(c, 'I will tidy up the home folder.', [BASH_DANGER]),
  parallel: (c) => toolTurn(c, 'I will run the tests and edit the file at the same time.', [BASH_TEST, EDIT_APP]),
  edit: (c) => toolTurn(c, 'I will update the file.', [EDIT_APP]),
  bash: (c) => toolTurn(c, 'I will run the tests.', [BASH_TEST]),

  async unicode(c) {
    c.finish({ k: 'result', ok: true, text: UNICODE_TEXT, subtype: 'success' });
  },
  async long(c) {
    c.finish({ k: 'result', ok: true, text: LONG_TEXT, subtype: 'success' });
  },
  async error(c) {
    c.finish({ k: 'result', ok: false, text: 'That did not work: the fake driver was asked to fail.', subtype: 'error_during_execution' });
  },
  async fatal(c) {
    c.finish({ k: 'fatal', msg: 'fake driver: simulated fatal error' });
  },

  async slow(c) {
    c.say('I will search the whole repository.');
    await c.step();
    // No permission request: Grep is read-only. The tool stays running until the
    // interrupt rejects the wait, which unwinds this script and ends the tool as failed.
    c.startTool(GREP_SLOW);
    await c.hang();
  },

  async echo(c) {
    c.say('Let me think about that.');
    await c.step();
    c.finish({ k: 'result', ok: true, text: `You said: ${c.prompt}`, subtype: 'success' });
  },
};

export function createFakeDriver(opts: DriverOptions, extra: FakeDriverExtra = {}): SessionDriver {
  const requested = extra.delayMs ?? 0;
  const delayMs = Number.isFinite(requested) && requested > 0 ? requested : 0;
  const sleep = extra.sleep ?? realSleep;
  const id = opts.resume || `fake-${++created}`;

  const queue: string[] = [];
  let current: Turn | undefined;
  let closed = false;
  let announced = false;
  let toolSeq = 0;

  /**
   * The only place an event leaves. Guarding here, not at each call site, is what makes
   * "exactly one terminal, and nothing after it" and "silent after close" structural.
   */
  function emit(turn: Turn, e: DriverEvent): void {
    if (closed || turn.terminal) return;
    // Marked BEFORE the consumer runs, so a consumer that reacts to the result by calling
    // back into the driver cannot cause a second terminal event.
    if (e.k === 'result' || e.k === 'fatal') turn.terminal = true;
    try {
      opts.onEvent(e);
    } catch {
      // A consumer's bug is not ours to propagate: the turn must still end well-formed.
      opts.log?.(`fake: onEvent threw on ${e.k}`);
    }
  }

  function announce(turn: Turn): void {
    if (announced) return;
    announced = true;
    emit(turn, { k: 'session', id });
  }

  async function step(turn: Turn): Promise<void> {
    const signal = turn.abort.signal;
    if (delayMs > 0) await guard(sleep(delayMs), signal);
    else await Promise.resolve(); // still a tick: events never arrive inside `prompt()`
    if (signal.aborted) throw new Interrupted();
  }

  function startTool(turn: Turn, spec: ToolSpec): string {
    const toolId = `toolu_fake_${++toolSeq}`;
    turn.open.add(toolId);
    emit(turn, { k: 'tool_start', id: toolId, name: spec.name });
    return toolId;
  }

  /** Asks the handler about one started tool, then ends it. Fails closed on anything odd. */
  async function decide(turn: Turn, toolId: string, spec: ToolSpec): Promise<Verdict> {
    let verdict: Verdict;
    let stop = false;
    try {
      // A copy of the input and a promise that also captures a synchronous throw: the
      // handler may be an async function, a plain one, or broken.
      const decision: unknown = await guard(
        new Promise<PermissionDecision>((resolve) => {
          resolve(opts.onPermission({ tool: spec.name, input: { ...spec.input }, toolUseId: toolId, signal: turn.abort.signal }));
        }),
        turn.abort.signal,
      );
      const d = (typeof decision === 'object' && decision !== null ? decision : {}) as Record<string, unknown>;
      // Only a real `true` allows. A truthy string or a missing field is a refusal.
      const allowed = d.allow === true;
      stop = !allowed && d.interrupt === true;
      verdict = { spec, allowed, message: allowed ? '' : typeof d.message === 'string' ? d.message : MSG_REFUSED };
    } catch (e) {
      if (e instanceof Interrupted) throw e;
      opts.log?.(`fake: permission handler failed for ${spec.name}`);
      verdict = { spec, allowed: false, message: MSG_PERMISSION_FAILED };
    }
    turn.open.delete(toolId);
    emit(turn, { k: 'tool_end', id: toolId, ok: verdict.allowed });
    if (stop) {
      // The handler asked for the whole turn to stop, which is what the real SDK does too.
      turn.abort.abort();
      throw new Interrupted();
    }
    return verdict;
  }

  function context(turn: Turn, prompt: string): Ctx {
    return {
      prompt,
      step: () => step(turn),
      say: (text) => emit(turn, { k: 'text', text }),
      useTools: (specs) => {
        // Every tool is revealed first, then all of them are asked about: that is what a
        // model's single message with two tool_use blocks looks like to the SDK.
        const ids = specs.map((spec) => startTool(turn, spec));
        return Promise.all(specs.map((spec, n) => decide(turn, ids[n]!, spec)));
      },
      startTool: (spec) => { startTool(turn, spec); },
      hang: () => guard(new Promise<never>(() => {}), turn.abort.signal),
      finish: (e) => emit(turn, e),
    };
  }

  /** A turn cut short still balances its books: end what was started, then say it stopped. */
  function unwind(turn: Turn, terminal: DriverEvent): void {
    for (const toolId of turn.open) emit(turn, { k: 'tool_end', id: toolId, ok: false });
    turn.open.clear();
    emit(turn, terminal);
  }

  async function runTurn(prompt: string, turn: Turn): Promise<void> {
    try {
      await step(turn);
      announce(turn);
      const scenario = fakeScenarioFor(prompt);
      opts.log?.(`fake: scenario ${scenario}`);
      await SCRIPTS[scenario](context(turn, prompt));
    } catch (e) {
      if (e instanceof Interrupted) {
        announce(turn); // an interrupt before the first step still introduces the session
        unwind(turn, { k: 'result', ok: false, text: INTERRUPTED_TEXT, subtype: 'interrupted' });
      } else {
        opts.log?.('fake: internal error in a scenario');
        unwind(turn, { k: 'fatal', msg: 'fake driver: internal error' });
      }
    }
    // Reached with no terminal only if a script returned without finishing: a bug in
    // this file, and the contract still holds.
    if (!turn.terminal) unwind(turn, { k: 'fatal', msg: 'fake driver: scenario ended without a result' });
  }

  function pump(): void {
    if (closed || current !== undefined) return;
    const prompt = queue.shift();
    if (prompt === undefined) return;
    const turn: Turn = { abort: new AbortController(), open: new Set(), terminal: false, done: Promise.resolve() };
    // Registered before anything runs, so an interrupt() issued right after prompt() finds it.
    current = turn;
    turn.done = runTurn(prompt, turn).finally(() => {
      if (current === turn) current = undefined;
      pump();
    });
  }

  return {
    prompt(text: string): void {
      if (closed) {
        opts.log?.('fake: prompt after close ignored');
        return;
      }
      queue.push(typeof text === 'string' ? text : '');
      pump();
    },

    async interrupt(): Promise<void> {
      const turn = current;
      if (closed || turn === undefined) return;
      turn.abort.abort();
      // Resolves once the interrupted turn has emitted its terminal event, so a caller
      // that awaits it can read the outcome. Prompts queued behind it still run.
      await turn.done;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      queue.length = 0;
      const turn = current;
      if (turn === undefined) return;
      // Aborting wakes every pending wait, including a permission request, so the
      // handler's signal fires and the turn unwinds without emitting anything.
      turn.abort.abort();
      await turn.done;
    },

    sessionId(): string | undefined {
      return id;
    },
  };
}

export function fakeDriverFactory(extra?: FakeDriverExtra): DriverFactory {
  return (opts) => createFakeDriver(opts, extra);
}
