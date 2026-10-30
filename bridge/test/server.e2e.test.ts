/**
 * End-to-end tests: the real server on a real loopback socket, driven by the real device
 * client, with a fake Claude behind it.
 *
 * Nothing here sleeps. Time that matters (the ask lifetime, the reconnect grace, the hello
 * deadline, the delay after a wrong token, the abort watchdog) runs on a clock the test
 * moves by hand. Waiting for the network is event-driven: every wait resolves the moment
 * what it waits for is in the transcript, and its timeout only turns a hang into a message.
 * The one exception is the keepalive, which measures a real socket going quiet and so uses
 * real intervals a few milliseconds long.
 *
 * Three habits, from the repo's CLAUDE.md, shape the file:
 *
 *  - Test the CALLER. The rules (approvals, state, text) have their own suites; what is
 *    pinned here is that the SERVER asks the right question of them, in the right order.
 *  - A guard phrased as "X never happens" gets a companion proving the mechanism engaged
 *    (an ask can be answered by `ask_rsp` in the very setup where `say` cannot answer it).
 *  - Invariants that any test could forget are enforced for ALL of them in one place: the
 *    teardown of `startRig` fails a test if the server sent a frame that is not printable
 *    ASCII, skipped or repeated a state, showed two asks at once, wrote the token to its
 *    log, or left a timer armed after `close()`.
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { get as httpGet } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Socket } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { DeviceClient, HelloRefused } from '../src/device-client.ts';
import type { DeviceClientOptions } from '../src/device-client.ts';
import { FAKE_SCENARIOS, fakeDriverFactory, fakeScenarioFor } from '../src/drivers/fake.ts';
import { ABORT_GRACE_MS, startServer } from '../src/server.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { loadSession, saveSession } from '../src/store.ts';
import { ScriptedStt } from '../src/stt.ts';
import { describeTool } from '../src/tools.ts';
import { LIMITS } from '../src/types.ts';
import type {
  AskMsg,
  BridgeMsg,
  Clock,
  DriverEvent,
  DriverFactory,
  DriverOptions,
  ErrMsg,
  HelloMsg,
  PermissionDecision,
  ResultMsg,
  SessionDriver,
  SttAdapter,
  TimerHandle,
} from '../src/types.ts';

const TOKEN = 'e2e-token-0123456789abcdef';
const CWD = '/work/project';

// ---------------------------------------------------------------------------
// Small tools
// ---------------------------------------------------------------------------

/** Wakes things that are waiting for a condition to become true. */
class Signal {
  #waiters = new Set<() => void>();
  fire(): void {
    for (const w of [...this.#waiters]) w();
  }
  until<T>(check: () => T | undefined, what: string, ms = 3000): Promise<T> {
    const first = check();
    if (first !== undefined) return Promise.resolve(first);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        reject(new Error(`timed out after ${ms} ms waiting for ${what}`));
      }, ms);
      const waiter = (): void => {
        const v = check();
        if (v === undefined) return;
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        resolve(v);
      };
      this.#waiters.add(waiter);
    });
  }
}

/** A clock that only moves when told to, and can say what is armed and when one is set. */
class FakeClock implements Clock {
  t = 1_000_000;
  #seq = 0;
  #live = new Map<number, { at: number; ms: number; fn: () => void }>();
  #sets = new Signal();
  #everSet: number[] = [];

  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#seq;
    this.#live.set(id, { at: this.t + ms, ms, fn });
    this.#everSet.push(ms);
    this.#sets.fire();
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    this.#live.delete(h as number);
  }
  get armed(): number {
    return this.#live.size;
  }
  /** The delays of the timers currently armed, for failure messages. */
  delays(): number[] {
    return [...this.#live.values()].map((e) => e.ms);
  }
  /** Resolves once a timer of `ms` is armed (now, or when the server next sets one). */
  async timerSet(ms: number): Promise<void> {
    await this.#sets.until(() => ([...this.#live.values()].some((e) => e.ms === ms) ? true : undefined), `a ${ms} ms timer to be armed`);
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let best: [number, { at: number; ms: number; fn: () => void }] | undefined;
      for (const e of this.#live) {
        if (e[1].at > target) continue;
        if (best === undefined || e[1].at < best[1].at || (e[1].at === best[1].at && e[0] < best[0])) best = e;
      }
      if (best === undefined) break;
      this.#live.delete(best[0]);
      this.t = Math.max(this.t, best[1].at);
      best[1].fn();
    }
    this.t = target;
  }
}

/** Holds the fake driver's steps until released, so a turn can be stopped at a known point. */
class Gate {
  #open = false;
  #held = new Set<() => void>();
  readonly sleep = (_ms: number): Promise<void> => (this.#open ? Promise.resolve() : new Promise<void>((r) => this.#held.add(r)));
  /** Let everything through, now and from here on. */
  open(): void {
    this.#open = true;
    for (const r of this.#held) r();
    this.#held.clear();
  }
}

/** Records what a driver was asked and told, without changing what it does. */
class Spy {
  readonly prompts: string[] = [];
  readonly decisions: PermissionDecision[] = [];
  readonly resumes: (string | undefined)[] = [];
  readonly #signal = new Signal();

  wrap(inner: DriverFactory): DriverFactory {
    return (opts) => {
      this.resumes.push(opts.resume);
      const orig = opts.onPermission;
      const d = inner({
        ...opts,
        onPermission: async (req) => {
          const decision = await orig(req);
          this.decisions.push(decision);
          this.#signal.fire();
          return decision;
        },
      });
      return {
        prompt: (text) => {
          this.prompts.push(text);
          this.#signal.fire();
          d.prompt(text);
        },
        interrupt: () => d.interrupt(),
        close: () => d.close(),
        sessionId: () => d.sessionId(),
      };
    };
  }
  /** The n-th permission decision (1-based), waiting for it if needed. */
  decision(n = 1): Promise<PermissionDecision> {
    return this.#signal.until(() => this.decisions[n - 1], `permission decision ${n}`);
  }
  prompt(n = 1): Promise<string> {
    return this.#signal.until(() => this.prompts[n - 1], `prompt ${n}`);
  }
}

/** A driver the test steers by hand: it does only what the test makes it do. */
class Scripted implements SessionDriver {
  readonly opts: DriverOptions;
  readonly prompts: string[] = [];
  interrupts = 0;
  closed = false;
  #id: string | undefined;
  #n = 0;
  readonly #script: (d: Scripted, prompt: string) => void | Promise<void>;
  readonly #onInterrupt: ((d: Scripted) => Promise<void>) | undefined;
  readonly #ac = new AbortController();

  constructor(
    opts: DriverOptions,
    script: (d: Scripted, prompt: string) => void | Promise<void>,
    onInterrupt: ((d: Scripted) => Promise<void>) | undefined,
    id: string | undefined,
  ) {
    this.opts = opts;
    this.#script = script;
    this.#onInterrupt = onInterrupt;
    this.#id = id ?? opts.resume;
  }
  emit(e: DriverEvent): void {
    this.opts.onEvent(e);
  }
  setSessionId(id: string): void {
    this.#id = id;
  }
  /** Ask the permission handler directly, as the SDK's canUseTool would. */
  permission(tool: string, input: Record<string, unknown>): Promise<PermissionDecision> {
    return this.opts.onPermission({ tool, input, toolUseId: `tu-${++this.#n}`, signal: this.#ac.signal });
  }
  prompt(text: string): void {
    this.prompts.push(text);
    queueMicrotask(() => {
      Promise.resolve(this.#script(this, text)).catch((err: unknown) => {
        throw err instanceof Error ? err : new Error(String(err)); // surfaces as an uncaught error: a test bug
      });
    });
  }
  async interrupt(): Promise<void> {
    this.interrupts += 1;
    if (this.#onInterrupt !== undefined) return this.#onInterrupt(this);
    this.emit({ k: 'result', ok: false, text: '', subtype: 'interrupted' });
  }
  async close(): Promise<void> {
    this.closed = true;
    this.#ac.abort();
  }
  sessionId(): string | undefined {
    return this.#id;
  }
}

function scripted(
  script: (d: Scripted, prompt: string) => void | Promise<void> = () => {},
  o: { onInterrupt?: (d: Scripted) => Promise<void>; id?: string } = {},
): { factory: DriverFactory; made: Scripted[]; driver: () => Scripted } {
  const made: Scripted[] = [];
  return {
    made,
    driver: () => {
      const d = made[0];
      if (d === undefined) throw new Error('the server never made a driver');
      return d;
    },
    factory: (opts) => {
      const d = new Scripted(opts, script, o.onInterrupt, o.id);
      made.push(d);
      return d;
    },
  };
}

const fmt = (m: BridgeMsg): string => {
  switch (m.t) {
    case 'hello_ack':
      return m.ok ? 'hello_ack' : `hello_ack:${m.why}`;
    case 'state':
      return `state ${m.ph}${m.tl ? `:${m.tl}` : ''}${m.pend ? `#${m.pend}` : ''}`;
    case 'ask':
      return `ask ${m.id}`;
    case 'ask_end':
      return `ask_end ${m.why}`;
    case 'result':
      return `result ${m.ok ? 'ok' : 'fail'}`;
    case 'err':
      return `err ${m.code}`;
    case 'stt':
      return 'stt';
    case 'pong':
      return 'pong';
  }
};
/** The transcript from `from`, as short strings, without the keepalive pongs `sync()` adds. */
const shape = (c: DeviceClient, from = 0): string[] => c.transcript.slice(from).filter((m) => m.t !== 'pong').map(fmt);

const isResult = (m: BridgeMsg): m is ResultMsg => m.t === 'result';
const isAsk = (m: BridgeMsg): m is AskMsg => m.t === 'ask';
const isErr = (m: BridgeMsg): m is ErrMsg => m.t === 'err';
const errOf = (code: ErrMsg['code']) => (m: BridgeMsg): m is ErrMsg => m.t === 'err' && m.code === code;
const PRINTABLE = /^[\x20-\x7e]*$/;

// ---------------------------------------------------------------------------
// The rig
// ---------------------------------------------------------------------------

interface RigOptions {
  server?: Partial<ServerOptions>;
}
interface Rig {
  clock: FakeClock;
  logs: string[];
  server: RunningServer;
  url: string;
  clients: DeviceClient[];
  /** Open, say hello with the right token, and wait for the first state. */
  connect(opts?: DeviceClientOptions): Promise<DeviceClient>;
  /** Open the socket and send nothing. */
  open(opts?: DeviceClientOptions): Promise<DeviceClient>;
  /** Resolves once the server has logged a line matching `re`. */
  logged(re: RegExp): Promise<void>;
}

async function startRig(t: TestContext, o: RigOptions = {}): Promise<Rig> {
  const clock = new FakeClock();
  const logs: string[] = [];
  const logSignal = new Signal();
  let n = 0;
  const server = await startServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    cwd: CWD,
    driverFactory: fakeDriverFactory(),
    clock,
    askTtlMs: 60_000,
    graceMs: 15_000,
    newId: () => (++n).toString(16).padStart(8, '0'),
    log: (l) => {
      logs.push(l);
      logSignal.fire();
    },
    ...o.server,
  });
  const clients: DeviceClient[] = [];
  const rig: Rig = {
    clock,
    logs,
    server,
    url: server.url,
    clients,
    async open(opts) {
      const c = await DeviceClient.open(server.url, opts);
      clients.push(c);
      return c;
    },
    async connect(opts) {
      const c = await rig.open(opts);
      c.hello(TOKEN);
      await c.waitFor((m) => m.t === 'hello_ack');
      await c.waitFor((m) => m.t === 'state');
      return c;
    },
    logged: async (re) => {
      await logSignal.until(() => (logs.some((l) => re.test(l)) ? true : undefined), `a log line matching ${re}`);
    },
  };

  // The invariants no single test should have to remember.
  t.after(async () => {
    const problems: Error[] = [];
    const note = (e: unknown): void => void problems.push(e instanceof Error ? e : new Error(String(e)));
    for (const c of clients) {
      try {
        c.assertClean();
      } catch (e) {
        note(e);
      }
    }
    for (const c of clients) c.terminate();
    try {
      await server.close();
    } catch (e) {
      note(e);
    }
    if (clock.armed !== 0) note(new Error(`timers still armed after close(): ${clock.delays().join(', ')} ms`));
    if (logs.some((l) => l.includes(TOKEN))) note(new Error('the configured token appeared in the log'));
    if (problems[0] !== undefined) throw problems[0];
  });
  return rig;
}

/** One full turn from a connected client: say it, wait for the result and for the pet to rest. */
async function turn(c: DeviceClient, text: string): Promise<ResultMsg> {
  c.say(text);
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  return r;
}

const stalePause = (c: DeviceClient): void => {
  // ws has no public way to make a client slow to read. The point is a socket that has not
  // yet noticed it was replaced, so it reaches into the net socket underneath.
  (c.socket as unknown as { _socket: Socket })._socket.pause();
};

// ===========================================================================
// The turn lifecycle
// ===========================================================================

test('happy path: one say produces exactly this conversation, with seq 1..4', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  const r = await turn(c, 'hello there');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'You said: hello there');
  await c.sync();
  assert.deepEqual(shape(c), [
    'hello_ack',
    'state idle',
    'state thinking',
    'result ok',
    'state done',
    'state idle',
  ]);
  const seqs = c.transcript.flatMap((m) => (m.t === 'state' ? [m.seq] : []));
  assert.deepEqual(seqs, [1, 2, 3, 4]);
  assert.equal(c.ack?.ok, true);
});

test('the session id reaches the device in hello_ack once the driver knows it', async (t) => {
  const sc = scripted(() => {}, { id: 'sess-known-123' });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  assert.equal(c.ack?.ok === true && c.ack.sid, 'sess-known-123');
});

test('approve: the ask shows the REAL command, and a tap lets exactly that run', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.say('run the tests');
  const ask = await c.waitFor(isAsk);

  // The caller test: the panel text is whatever tools.ts says about the real input.
  const real = describeTool('Bash', { command: 'npm test' }, CWD);
  assert.equal(ask.sum, real.summary);
  assert.equal(ask.tl, real.label);
  assert.equal(ask.risk, real.risk);
  assert.equal(ask.sum, 'npm test');
  assert.equal(ask.id, '00000001');
  assert.equal(ask.ttl, 60);

  c.answer(ask.id, true);
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  await c.sync();
  assert.match(r.text, /ran npm test/);
  assert.deepEqual((await spy.decision()), { allow: true });
  assert.deepEqual(shape(c), [
    'hello_ack',
    'state idle',
    'state thinking',
    'state tool:Bash',
    'ask 00000001',
    'state asking:Bash#1',
    'ask_end answered',
    'state tool:Bash',
    'state thinking',
    'result ok',
    'state done',
    'state idle',
  ]);
});

test('the ask is built from the tool input, never from what the model said about it', async (t) => {
  const sc = scripted(async (d) => {
    // The model describes a dangerous push as a harmless listing. The describer must not care.
    const decision = await d.permission('Bash', {
      command: 'git push --force origin main',
      description: 'List the files here, harmless',
    });
    d.emit({ k: 'result', ok: true, text: decision.allow ? 'allowed' : 'refused', subtype: 'success' });
  });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  c.say('anything');
  const ask = await c.waitFor(isAsk);
  assert.equal(ask.sum, describeTool('Bash', { command: 'git push --force origin main' }, CWD).summary);
  assert.match(ask.sum, /git push --force/);
  assert.doesNotMatch(ask.sum, /harmless/);
  assert.equal(ask.risk, 'high');
  c.answer(ask.id, false);
  assert.equal((await c.waitFor(isResult)).text, 'refused');
});

test('deny: a refusal is reported and the action does not run', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.say('run the tests');
  const ask = await c.waitFor(isAsk);
  c.answer(ask.id, false);
  const end = await c.waitFor((m) => m.t === 'ask_end');
  assert.deepEqual(end, { t: 'ask_end', id: ask.id, why: 'answered' }, 'a "no" is still an answered ask');
  const r = await c.waitFor(isResult);
  assert.match(r.text, /denied/);
  assert.doesNotMatch(r.text, /I ran/);
  const d = await spy.decision();
  assert.equal(d.allow, false);
});

test('timeout: an unanswered ask is denied exactly when its time is up', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.say('run the tests');
  const ask = await c.waitFor(isAsk);
  const mark = c.mark();

  rig.clock.advance(59_999);
  await c.sync();
  assert.deepEqual(shape(c, mark), [], 'one millisecond early, nothing has happened');

  rig.clock.advance(1);
  const end = await c.waitFor((m) => m.t === 'ask_end');
  assert.deepEqual(end, { t: 'ask_end', id: ask.id, why: 'timeout' });
  const r = await c.waitFor(isResult);
  assert.match(r.text, /did not answer in time/);
  assert.equal((await spy.decision()).allow, false);
});

test('hard-deny: a call the rules forbid is never put in front of the device', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  const r = await turn(c, 'do something dangerous');
  await c.sync();
  assert.equal(r.ok, true, 'the turn still finishes');
  assert.match(r.text, /safety rules/, 'and the model was told why');
  assert.equal(c.transcript.some((m) => m.t === 'ask'), false);
  assert.equal(c.transcript.some((m) => m.t === 'state' && m.ph === 'asking'), false);
  assert.equal((await spy.decision()).allow, false);
  // Companion: the same server DOES ask about an ordinary command, so the silence above is
  // the rule at work and not a server that never asks.
  c.say('run the tests');
  assert.equal((await c.waitFor(isAsk)).sum, 'npm test');
});

test('ask_rsp for an unknown, wrong, repeated or late id is unknown_ask and changes nothing', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();

  c.answer('deadbeef', true); // nothing open at all
  assert.equal((await c.waitFor(isErr)).code, 'unknown_ask');

  c.say('run the tests');
  const ask = await c.waitFor(isAsk);
  c.answer('deadbeef', true); // something open, but not this
  assert.equal((await c.waitFor(isErr)).code, 'unknown_ask');
  await c.sync();
  assert.equal(c.openAsk?.id, ask.id, 'the real ask is untouched');

  c.answer(ask.id, true); // companion: the right id IS accepted
  assert.deepEqual(await spy.decision(), { allow: true });
  await c.waitFor(isResult);
  await c.waitForPhase('idle');
  c.answer(ask.id, true); // the same id again, after it was answered
  assert.equal((await c.waitFor(isErr)).code, 'unknown_ask');

  // A late tap for an ask that timed out.
  c.say('run the tests');
  const second = await c.waitFor(isAsk);
  assert.notEqual(second.id, ask.id);
  rig.clock.advance(60_000);
  await c.waitFor((m) => m.t === 'ask_end');
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  c.answer(second.id, true);
  assert.equal((await c.waitFor(isErr)).code, 'unknown_ask');
  assert.match(r.text, /did not answer in time/);
  assert.equal((await spy.decision(2)).allow, false, 'the late "yes" granted nothing');
});

test('words cannot approve: say, audio and a transcript of "yes approve it" never resolve an ask', async (t) => {
  // A permission request with NO turn behind it (a background task asking), so that `say`
  // and the microphone are not simply refused as busy: they are accepted, and still cannot
  // answer. Without this setup the test would pass for the wrong reason.
  const sc = scripted((d) => {
    d.emit({ k: 'result', ok: true, text: 'noted', subtype: 'success' });
  });
  const stt = new ScriptedStt('yes, approve it');
  const rig = await startRig(t, { server: { driverFactory: sc.factory, stt } });
  const c = await rig.connect();

  let outcome: PermissionDecision | undefined;
  const pending = sc.driver().permission('Bash', { command: 'npm test' }).then((d) => {
    outcome = d;
    return d;
  });
  const ask = await c.waitFor(isAsk);
  assert.equal(ask.sum, 'npm test');

  // Typed words.
  for (const words of ['yes approve it', 'approve', 'yes', 'ok', ask.id]) {
    c.say(words);
    await c.waitFor(isResult); // each is taken as a PROMPT and answered like one
  }
  assert.deepEqual(sc.driver().prompts, ['yes approve it', 'approve', 'yes', 'ok', ask.id], 'they went to Claude as prompts');

  // Spoken words.
  c.speak(10);
  assert.equal((await c.waitFor((m) => m.t === 'stt')).t, 'stt');
  await c.waitFor(isResult);
  assert.equal(sc.driver().prompts.at(-1), 'yes, approve it', 'and so did the dictation');

  await c.sync();
  assert.equal(outcome, undefined, 'the permission request is still waiting');
  assert.equal(c.openAsk?.id, ask.id, 'and the ask is still on the panel');
  assert.equal(c.transcript.some((m) => m.t === 'ask_end'), false);

  // Companion: the SAME ask, in the SAME state, is granted by ask_rsp with its id.
  c.answer(ask.id, true);
  assert.deepEqual(await pending, { allow: true });
  await c.waitFor((m) => m.t === 'ask_end');
});

// ===========================================================================
// Disconnects, takeover, grace
// ===========================================================================

test('a device back inside the grace period gets the same ask, with the time that is LEFT', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const a = await rig.connect();
  a.say('run the tests');
  const ask = await a.waitFor(isAsk);
  assert.equal(ask.ttl, 60);

  a.terminate(); // no goodbye: a Wi-Fi drop
  await rig.logged(/conn 1 closed/);
  rig.clock.advance(14_999); // one millisecond inside the 15 s grace

  const b = await rig.open();
  b.hello(TOKEN);
  await b.waitFor((m) => m.t === 'hello_ack');
  const state = await b.waitFor((m) => m.t === 'state');
  assert.deepEqual(state, { t: 'state', seq: 1, ph: 'asking', tl: 'Bash', pend: 1 });
  const again = await b.waitFor(isAsk);
  assert.equal(again.id, ask.id, 'the same ask');
  assert.equal(again.sum, ask.sum);
  assert.equal(again.ttl, 46, '60 s minus 14.999 s, rounded up: the remaining time, not the original');

  b.answer(again.id, true);
  assert.match((await b.waitFor(isResult)).text, /ran npm test/);
  assert.deepEqual(await spy.decision(), { allow: true });
});

test('a device that stays away past the grace period loses the ask: it is denied, not replayed', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const a = await rig.connect();
  a.say('run the tests');
  await a.waitFor(isAsk);
  a.terminate();
  await rig.logged(/conn 1 closed/);

  rig.clock.advance(15_000);
  const d = await spy.decision();
  assert.equal(d.allow, false);
  assert.equal(d.allow === false && /disconnected/.test(d.message), true, 'the model was told the device went away');

  const b = await rig.open();
  b.hello(TOKEN);
  await b.waitForPhase('idle'); // the turn carried on without the tool and ended
  await b.sync();
  assert.equal(b.transcript.some((m) => m.t === 'ask'), false, 'nothing is replayed');
});

test('takeover: the old socket gets 4001, the new one the replay, and the old one closing late denies nothing', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const a = await rig.connect();
  a.say('run the tests');
  const ask = await a.waitFor(isAsk);

  rig.clock.advance(7000);
  const b = await rig.connect();
  const closed = await a.waitClosed();
  assert.deepEqual(closed, { code: 4001, reason: 'replaced' });
  assert.deepEqual(
    b.transcript.filter((m) => m.t === 'state' || m.t === 'ask').map(fmt),
    ['state asking:Bash#1', 'ask 00000001'],
    'a fresh snapshot (seq 1) and the open ask',
  );
  assert.equal(b.transcript.find((m) => m.t === 'state')?.t === 'state' && b.transcript.find((m) => m.t === 'state')?.seq, 1);
  const replay = b.transcript.find(isAsk);
  assert.equal(replay?.id, ask.id);
  assert.equal(replay?.ttl, 53, '60 s minus 7 s');

  // The old socket's close reaches the server AFTER the new hello. Wait for it, then run the
  // clock far past the grace period: if that close had counted as "the device left", the
  // grace timer would have been armed and would now have denied the ask.
  await rig.logged(/conn 1 closed/);
  rig.clock.advance(20_000);
  await b.sync();
  assert.equal(b.transcript.some((m) => m.t === 'ask_end'), false, 'the ask is still open');

  b.answer(ask.id, true);
  assert.match((await b.waitFor(isResult)).text, /ran npm test/);
  assert.deepEqual(await spy.decision(), { allow: true });
});

test('takeover: a replaced socket that still talks cannot answer the ask', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const a = await rig.connect();
  a.say('run the tests');
  const ask = await a.waitFor(isAsk);

  stalePause(a); // it has not read the close frame yet, so it still believes it is the device
  const b = await rig.connect();
  await b.waitFor(isAsk);

  a.answer(ask.id, true); // the stale device taps ALLOW
  await b.sync();
  assert.equal(b.transcript.some((m) => m.t === 'ask_end'), false, 'the stale tap did not answer the ask');
  assert.equal(b.transcript.some((m) => m.t === 'err'), false, 'and was not even acknowledged');

  b.answer(ask.id, false); // the real device says no
  assert.equal((await spy.decision()).allow, false, 'the only answer that counted was the active device\'s');
  await b.waitFor(isResult);
});

test('a failed handshake takes nothing over and changes nothing', async (t) => {
  const rig = await startRig(t, { server: { authFailDelayMs: 500 } });
  const a = await rig.connect();
  a.say('run the tests');
  const ask = await a.waitFor(isAsk);

  const intruder = await rig.open();
  intruder.hello('not-the-token-0123456789');
  await rig.clock.timerSet(500);
  rig.clock.advance(500);
  const ack = await intruder.waitFor((m) => m.t === 'hello_ack');
  assert.deepEqual(ack, { t: 'hello_ack', v: 1, ok: false, why: 'token' });
  await intruder.waitClosed();

  await a.sync();
  assert.equal(a.closed, undefined, 'the real device is still connected');
  assert.equal(a.openAsk?.id, ask.id);
  a.answer(ask.id, true);
  await a.waitFor((m) => m.t === 'ask_end');
});

// ===========================================================================
// The handshake
// ===========================================================================

test('bad token: refused only after the delay, which runs on the injected clock', async (t) => {
  // An hour. A server that used a real timer would never answer within this test's budget.
  const rig = await startRig(t, { server: { authFailDelayMs: 3_600_000 } });
  const c = await rig.open();
  c.hello('wrong-token-0123456789abc');
  await rig.clock.timerSet(3_600_000);
  c.sendRaw('{"t":"say","text":"let me in anyway"}'); // anything sent while waiting is ignored
  rig.clock.advance(3_599_999);
  assert.deepEqual(c.transcript, [], 'nothing before the delay is over');
  rig.clock.advance(1);
  const ack = await c.waitFor((m) => m.t === 'hello_ack');
  assert.deepEqual(ack, { t: 'hello_ack', v: 1, ok: false, why: 'token' });
  const closed = await c.waitClosed();
  assert.equal(closed.code, 1008);
  assert.deepEqual(shape(c), ['hello_ack:token'], 'and that is all it was ever sent');
});

test('tokens that are close but not equal are refused, and so is the token with a changed case', async (t) => {
  const rig = await startRig(t, { server: { authFailDelayMs: 1 } });
  const wrong = [TOKEN.slice(0, -1), `${TOKEN}x`, TOKEN.toUpperCase(), TOKEN.replace('e2e', 'E2e'), 'a'.repeat(16)];
  for (const token of wrong) {
    const c = await rig.open();
    c.hello(token);
    await rig.clock.timerSet(1);
    rig.clock.advance(1);
    assert.deepEqual(await c.waitFor((m) => m.t === 'hello_ack'), { t: 'hello_ack', v: 1, ok: false, why: 'token' }, token);
  }
  // Companion: the right token, same server, is accepted.
  const good = await rig.connect();
  assert.equal(good.ack?.ok, true);
});

test('the first message must be a hello: anything else gets bad_hello and a 1008', async (t) => {
  const rig = await startRig(t);
  const first: [string, (c: DeviceClient) => void][] = [
    ['a say', (c) => c.sendRaw('{"t":"say","text":"hi"}')],
    ['a ping', (c) => c.sendRaw('{"t":"ping","n":1}')],
    ['not JSON', (c) => c.sendRaw('hello please')],
    ['an empty object', (c) => c.sendRaw('{}')],
    ['a hello with a missing key', (c) => c.sendRaw('{"t":"hello","v":1}')],
    ['a binary frame', (c) => c.sendBinary(Buffer.from([1, 0, 0]))],
  ];
  for (const [what, send] of first) {
    const c = await rig.open();
    send(c);
    const ack = await c.waitFor((m) => m.t === 'hello_ack');
    assert.deepEqual(ack, { t: 'hello_ack', v: 1, ok: false, why: 'bad_hello' }, what);
    assert.equal((await c.waitClosed()).code, 1008, what);
    assert.deepEqual(shape(c), ['hello_ack:bad_hello'], what);
  }
});

test('no hello within the deadline closes the socket; a hello in time is not killed by the same timer', async (t) => {
  const rig = await startRig(t); // default deadline: 5000 ms
  const silent = await rig.open();
  const prompt = await rig.connect();
  await rig.clock.timerSet(5000);
  rig.clock.advance(4999);
  await prompt.sync();
  assert.equal(silent.closed, undefined, 'still waiting one millisecond early');
  rig.clock.advance(1);
  assert.equal((await silent.waitClosed()).code, 1008);
  assert.deepEqual(silent.transcript, [], 'and nothing was sent: there was no hello to answer');
  // Companion: the connection that did say hello is alive long after the deadline passed.
  rig.clock.advance(60_000);
  await prompt.sync();
  assert.equal(prompt.closed, undefined);
});

test('version and audio mismatches are refused with the right reason, in the documented order', async (t) => {
  const rig = await startRig(t, { server: { authFailDelayMs: 1 } });
  const refused = async (hello: Partial<HelloMsg>, token = TOKEN): Promise<DeviceClient> => {
    const c = await rig.open({ hello });
    c.hello(token);
    return c;
  };

  const v2 = await refused({ v: 2 });
  assert.deepEqual(await v2.waitFor((m) => m.t === 'hello_ack'), { t: 'hello_ack', v: 1, ok: false, why: 'version' });
  assert.equal((await v2.waitClosed()).code, 1008);

  for (const bad of [{ rate: 8000 }, { rate: 44100 }, { bits: 8 }, { bits: 24 }, { ch: 2 }, { ch: 0 }]) {
    const c = await refused(bad);
    assert.deepEqual(await c.waitFor((m) => m.t === 'hello_ack'), { t: 'hello_ack', v: 1, ok: false, why: 'bad_hello' }, JSON.stringify(bad));
    assert.equal((await c.waitClosed()).code, 1008);
  }

  // Order: a wrong version is reported before the token is even looked at, with no delay.
  const both = await refused({ v: 3 }, 'wrong-token-0123456789abc');
  assert.equal((await both.waitFor((m) => m.t === 'hello_ack')).t, 'hello_ack');
  assert.equal(both.transcript[0]?.t === 'hello_ack' && !both.transcript[0].ok && both.transcript[0].why, 'version');

  // A wrong token is reported as a token problem even when the audio is also wrong.
  const tokenFirst = await refused({ rate: 8000 }, 'wrong-token-0123456789abc');
  await rig.clock.timerSet(1);
  rig.clock.advance(1);
  assert.equal((await tokenFirst.waitFor((m) => m.t === 'hello_ack')).t, 'hello_ack');
  assert.equal(tokenFirst.transcript[0]?.t === 'hello_ack' && !tokenFirst.transcript[0].ok && tokenFirst.transcript[0].why, 'token');

  // Companion: every one of those deviations was the only difference. The plain hello works.
  const good = await rig.connect();
  assert.equal(good.ack?.ok, true);
});

test('DeviceClient.connect reports a refusal as an error that says why', async (t) => {
  const rig = await startRig(t, { server: { authFailDelayMs: 1 } });
  const attempt = DeviceClient.connect(rig.url, 'wrong-token-0123456789abc');
  await rig.clock.timerSet(1);
  rig.clock.advance(1);
  await assert.rejects(attempt, (e: unknown) => e instanceof HelloRefused && e.why === 'token' && e.closeCode === 1008);
});

test('the token never reaches the log: not the real one, not a wrong one, not a piece of either', async (t) => {
  const rig = await startRig(t, { server: { authFailDelayMs: 1 } });
  const wrong = 'zq7Xk9-pLmN4_rT2vWc8Yb';
  const bad = await rig.open();
  bad.hello(wrong);
  await rig.clock.timerSet(1);
  rig.clock.advance(1);
  await bad.waitClosed();
  const malformed = await rig.open();
  malformed.sendRaw(`{"t":"hello","v":1,"token":"${wrong}","dev":"x"}`); // missing keys
  await malformed.waitClosed();
  const truncated = await rig.open();
  truncated.sendRaw(`{"t":"hello","v":1,"token":"${TOKEN}",`);
  await truncated.waitClosed();
  const good = await rig.connect();
  good.say('hello');
  await good.waitFor(isResult);
  good.sendRaw(`{"t":"say","text":"${TOKEN}","extra":1}`); // a bad frame that quotes the token
  await good.waitFor(isErr);

  assert.ok(rig.logs.length > 4, 'there is something to search');
  const windows = (s: string): string[] => Array.from({ length: s.length - 5 }, (_, i) => s.slice(i, i + 6));
  for (const secret of [wrong, TOKEN]) {
    for (const w of windows(secret)) {
      assert.equal(rig.logs.some((l) => l.includes(w)), false, `a log line contains "${w}" from a token`);
    }
  }
});

// ===========================================================================
// Frames
// ===========================================================================

test('an oversized frame closes the socket with 1009, before and after the hello', async (t) => {
  const rig = await startRig(t);
  const early = await rig.open();
  early.sendRaw('x'.repeat(3000));
  assert.equal((await early.waitClosed()).code, 1009);

  const c = await rig.connect();
  c.sendRaw(`{"t":"say","text":"${'a'.repeat(3000)}"}`);
  assert.equal((await c.waitClosed()).code, 1009);
});

test('a frame over the device limit but under the socket limit is a bad_msg, not a disconnect', async (t) => {
  // Companion to the test above: it shows 1009 comes from the socket limit and the codec's
  // 1024-byte rule is what answers in between.
  const rig = await startRig(t);
  const c = await rig.connect();
  const text = 'a'.repeat(1500);
  assert.ok(text.length > LIMITS.deviceFrameMax);
  c.sendRaw(`{"t":"say","text":"${text}"}`);
  assert.equal((await c.waitFor(isErr)).code, 'bad_msg');
  await c.sync();
  assert.equal(c.closed, undefined);
});

test('malformed frames get bad_msg and the connection survives them, one at a time', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  const bad = [
    'not json',
    '[]',
    'null',
    '{"t":"say"}', // missing key
    '{"t":"say","text":"a","text":"b"}', // duplicate key
    '{"t":"say","text":"a","x":1}', // extra key
    '{"t":"nope"}',
    '{"t":"say","text":"café"}', // not ASCII
    '{"t":"ask_rsp","id":"ABCDEF12","ok":true}', // upper-case id
    '{"t":"ask_rsp","id":"abcdef12","ok":"true"}', // a string is not a boolean
    '{"t":"ping","n":-1}',
    '{"t":"listen","m":"START"}',
    '{"t":"state","seq":1,"ph":"idle","tl":"","pend":0}', // a bridge message, wrong direction
  ];
  for (const frame of bad) {
    c.sendRaw(frame);
    assert.equal((await c.waitFor(isErr)).code, 'bad_msg', frame);
    await c.sync(); // a good frame between them, so they are never five in a row
  }
  assert.equal(c.closed, undefined);
  // Companion: a valid frame of the same shape as the first few is accepted.
  const r = await turn(c, 'a');
  assert.equal(r.ok, true);
});

test('a second hello is out of sequence', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.hello(TOKEN);
  assert.equal((await c.waitFor(isErr)).code, 'bad_msg');
  await c.sync();
  assert.equal(c.closed, undefined);
});

test('five bad frames in a row close the connection; a good frame in between starts the count again', async (t) => {
  const rig = await startRig(t);
  const patient = await rig.connect();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 4; i++) patient.sendRaw('garbage');
    await patient.sync(); // the good frame that resets the count
  }
  assert.equal(patient.closed, undefined, 'twelve bad frames in total, never five in a row');
  assert.equal(patient.transcript.filter(isErr).length, 12, 'every one was answered');

  const c = await rig.connect();
  for (let i = 0; i < 4; i++) c.sendRaw('garbage');
  await c.sync();
  assert.equal(c.closed, undefined, 'four are tolerated');
  for (let i = 0; i < 5; i++) c.sendRaw('garbage');
  assert.equal((await c.waitClosed()).code, 1008, 'the fifth in a row is the last');
});

test('bad audio frames are bad_msg too: odd length, unknown kind, empty, and a TTS frame from a device', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  const frames = [
    Buffer.from([0x01, 0x00, 0x00, 0x00]).subarray(0, 4), // 3 bytes of payload: odd
    Buffer.from([0x07, 0x00, 0x00]), // unknown kind
    Buffer.from([0x01]), // no payload
    Buffer.from([0x02, 0x00, 0x00]), // TTS is bridge to device only
  ];
  for (const f of frames) {
    c.sendBinary(f);
    assert.equal((await c.waitFor(isErr)).code, 'bad_msg', f.toString('hex'));
    await c.sync();
  }
  assert.equal(c.closed, undefined);
});

// ===========================================================================
// Abort
// ===========================================================================

for (const scenario of FAKE_SCENARIOS.map((s) => s.name)) {
  test(`abort: a ${scenario} turn stopped before it gets going ends idle, not error`, async (t) => {
    const gate = new Gate();
    const rig = await startRig(t, { server: { driverFactory: fakeDriverFactory({ delayMs: 1, sleep: gate.sleep }) } });
    const c = await rig.connect();
    const prompt = { danger: 'danger', parallel: 'two in parallel', edit: 'edit it', bash: 'run it', unicode: 'unicode', long: 'long one', slow: 'slow one', error: 'error', fatal: 'fatal', echo: 'hello' }[scenario];
    assert.equal(fakeScenarioFor(prompt), scenario, 'this prompt really selects that scenario');

    c.say(prompt);
    await c.waitForPhase('thinking');
    c.abort();
    const r = await c.waitFor(isResult);
    await c.waitForPhase('idle');
    await c.sync();
    assert.equal(r.ok, false);
    assert.equal(r.text, 'Stopped before finishing.');
    assert.deepEqual(shape(c), ['hello_ack', 'state idle', 'state thinking', 'result fail', 'state idle']);

    // Companion: the server is not wedged; the next turn runs normally.
    gate.open();
    assert.equal((await turn(c, 'hello again')).text, 'You said: hello again');
  });
}

test('abort while an ask is open: the ask ends as abort, the call is denied, the turn ends idle', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.say('run the tests');
  const ask = await c.waitFor(isAsk);
  c.abort();
  assert.deepEqual(await c.waitFor((m) => m.t === 'ask_end'), { t: 'ask_end', id: ask.id, why: 'abort' });
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.equal(r.ok, false);
  const d = await spy.decision();
  assert.equal(d.allow, false);
  await c.sync();
  assert.equal(c.transcript.some((m) => m.t === 'state' && (m.ph === 'done' || m.ph === 'error')), false);
  assert.equal(c.openAsk, undefined);
});

test('abort while a tool is running ends idle', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.say('a slow search');
  await c.waitForPhase('tool', 'Grep');
  c.abort();
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.equal(r.ok, false);
  await c.sync();
  assert.equal(c.transcript.some((m) => m.t === 'state' && (m.ph === 'done' || m.ph === 'error')), false);
});

test('abort ends an open ask itself: it does not rely on the driver cancelling the request', async (t) => {
  // This driver never aborts the permission request's signal, as a careless one would not.
  const decided: PermissionDecision[] = [];
  const sc = scripted(async (d) => {
    decided.push(await d.permission('Bash', { command: 'npm test' }));
  });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  c.say('go');
  const ask = await c.waitFor(isAsk);
  c.abort();
  assert.deepEqual(await c.waitFor((m) => m.t === 'ask_end'), { t: 'ask_end', id: ask.id, why: 'abort' });
  await c.waitFor(isResult);
  await c.waitForPhase('idle');
  await c.sync();
  assert.equal(c.openAsk, undefined, 'nothing is left on the panel');
  assert.equal(decided[0]?.allow, false, 'and the request was refused');
  assert.equal(sc.driver().interrupts, 1);
});

test('a device that takes over mid-turn sees the turn as it is and receives its ending', async (t) => {
  const rig = await startRig(t);
  const a = await rig.connect();
  a.say('a slow search');
  await a.waitForPhase('tool', 'Grep');
  const b = await rig.connect();
  assert.deepEqual(b.transcript.find((m) => m.t === 'state'), { t: 'state', seq: 1, ph: 'tool', tl: 'Grep', pend: 0 });
  b.abort();
  assert.equal((await b.waitFor(isResult)).ok, false);
  await b.waitForPhase('idle');
  await a.waitClosed();
  assert.equal(a.transcript.some(isResult), false, 'the replaced device is told nothing more');
});

test('abort with several asks open ends them all: only the one on screen is ever announced', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.say('two things in parallel');
  const first = await c.waitFor(isAsk);
  c.abort();
  assert.deepEqual(await c.waitFor((m) => m.t === 'ask_end'), { t: 'ask_end', id: first.id, why: 'abort' });
  await c.waitFor(isResult);
  await c.waitForPhase('idle');
  await c.sync();
  assert.equal(c.transcript.filter(isAsk).length, 1, 'the queued ask was never shown');
  assert.equal(c.openAsk, undefined);
});

test('abort with nothing running is a harmless no-op', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.abort();
  c.abort();
  await c.sync();
  assert.deepEqual(shape(c), ['hello_ack', 'state idle'], 'no state, no error, no result');
  assert.equal((await turn(c, 'still works')).ok, true);
});

test('a session that ignores the interrupt is ended by the server after 5 s, and its late ending is swallowed', async (t) => {
  assert.equal(ABORT_GRACE_MS, 5000);
  const sc = scripted(() => {}, { onInterrupt: async () => {} }); // never answers
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  c.say('stuck');
  await c.waitForPhase('thinking');
  c.abort();
  await rig.clock.timerSet(5000);
  const mark = c.mark();

  rig.clock.advance(4999);
  await c.sync();
  assert.deepEqual(shape(c, mark), [], 'still waiting one millisecond early');
  rig.clock.advance(1);
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.deepEqual({ ok: r.ok, text: r.text }, { ok: false, text: 'Stopped.' });

  // The driver still owes the first turn's ending. It must not end the SECOND turn.
  c.say('second');
  await c.waitForPhase('thinking');
  sc.driver().emit({ k: 'result', ok: true, text: 'late ending of the first turn', subtype: 'success' });
  await c.sync();
  assert.equal(c.transcript.filter(isResult).length, 1, 'the late ending was ignored');
  await rig.logged(/late ending/);

  sc.driver().emit({ k: 'result', ok: true, text: 'second answer', subtype: 'success' });
  assert.equal((await c.waitFor(isResult)).text, 'second answer');
  await c.waitForPhase('idle');
});

test('a normal ending cancels the watchdog: no timer is left armed', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.say('a slow search');
  await c.waitForPhase('tool', 'Grep');
  assert.equal(rig.clock.delays().includes(5000), false, 'nothing armed before an abort');
  c.abort();
  await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.equal(rig.clock.delays().includes(5000), false, 'the watchdog was disarmed by the ending');
});

// ===========================================================================
// Errors, busy, scenarios
// ===========================================================================

test('say while a turn runs is busy, and the turn is untouched', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.say('a slow search');
  await c.waitForPhase('tool', 'Grep');
  c.say('and another thing');
  assert.equal((await c.waitFor(isErr)).code, 'busy');
  c.listen('start');
  assert.equal((await c.waitFor(isErr)).code, 'busy');
  await c.sync();
  assert.deepEqual(shape(c), ['hello_ack', 'state idle', 'state thinking', 'state tool:Grep', 'err busy', 'err busy']);
  c.abort();
  await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.equal((await turn(c, 'now it is free')).ok, true); // companion
});

test('an empty say starts nothing', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  for (const blank of ['', '   ']) {
    c.say(blank);
    assert.equal((await c.waitFor(isErr)).code, 'empty');
  }
  await c.sync();
  assert.deepEqual(spy.prompts, []);
  await turn(c, ' padded ');
  assert.deepEqual(spy.prompts, [' padded '], 'and a real one is passed on exactly as typed');
});

test('parallel asks are served one at a time, and a queued ask cannot be answered early', async (t) => {
  const spy = new Spy();
  const rig = await startRig(t, { server: { driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.say('two things in parallel');
  const first = await c.waitFor(isAsk);
  assert.equal(first.id, '00000001');
  const asking = await c.waitFor((m) => m.t === 'state' && m.ph === 'asking' && m.pend === 2);
  assert.equal(asking.t === 'state' && asking.pend, 2, 'both are counted');
  assert.equal(c.transcript.filter(isAsk).length, 1, 'but only one is shown');

  c.answer('00000002', true); // the id of the one that is still waiting
  assert.equal((await c.waitFor(isErr)).code, 'unknown_ask');
  await c.sync();
  assert.equal(c.openAsk?.id, first.id, 'still the first');

  rig.clock.advance(20_000);
  c.answer(first.id, true);
  assert.deepEqual(await c.waitFor((m) => m.t === 'ask_end'), { t: 'ask_end', id: first.id, why: 'answered' });
  const second = await c.waitFor(isAsk);
  assert.equal(second.id, '00000002');
  assert.equal(second.ttl, 60, 'its clock started when it was presented, not when it was requested');
  assert.notEqual(second.sum, first.sum);

  c.answer(second.id, false);
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.match(r.text, /ran npm test/);
  assert.match(r.text, /was refused/);
  assert.deepEqual(spy.decisions.map((d) => d.allow), [true, false]);
});

test('model output is ASCII on every channel: result, tool label, error, session id', async (t) => {
  const fancy = '“naïve” — café \u{1F389}';
  const sc = scripted(async (d, prompt) => {
    if (prompt === 'tool') {
      d.emit({ k: 'tool_start', id: 't1', name: '\u{1F600}Bash​' });
      d.emit({ k: 'tool_end', id: 't1', ok: true });
      d.emit({ k: 'result', ok: true, text: 'done', subtype: 'success' });
    } else if (prompt === 'fatal') {
      d.emit({ k: 'fatal', msg: `session died: ${fancy}` });
    } else {
      d.emit({ k: 'result', ok: true, text: `# Title\n\n${fancy} see https://example.com/x`, subtype: 'success' });
    }
  }, { id: 'sess-café-\u{1F600}' });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  assert.equal(c.ack?.ok && PRINTABLE.test(c.ack.sid), true, 'sid');

  const r = await turn(c, 'text');
  assert.match(r.text, /na\?ve|naive/);
  assert.match(r.text, /cafe/);
  assert.doesNotMatch(r.text, /https|#/);

  c.say('tool');
  const tool = await c.waitForPhase('tool');
  assert.equal(tool.t === 'state' && PRINTABLE.test(tool.tl) && tool.tl !== '', true, 'a label with emoji and a zero-width space is still a label');
  await c.waitFor(isResult);
  await c.waitForPhase('idle');

  c.say('fatal');
  const e = await c.waitFor(errOf('driver'));
  assert.equal(PRINTABLE.test(e.msg), true);
  assert.match(e.msg, /cafe/);
  await c.waitForPhase('idle');

  assert.ok(c.rawFrames.length > 8);
  for (const f of c.rawFrames) assert.match(f, PRINTABLE, 'every frame the server sent');
});

test('the unicode scenario reaches the device as plain ASCII, with the sense kept', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  const r = await turn(c, 'unicode please');
  assert.match(r.text, /^[\x20-\x7e]+$/);
  assert.match(r.text, /"naive"/, 'curly quotes and the diaeresis folded, not dropped');
  assert.match(r.text, /cafe menu/);
  assert.match(r.text, / - /, 'the em dash became a hyphen');
  assert.ok(r.text.length <= LIMITS.resultMax);
  for (const f of c.rawFrames) assert.match(f, PRINTABLE);
});

test('the long scenario arrives as plain whole sentences: no markdown, no code, no link', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  const r = await turn(c, 'a long answer');
  assert.ok(r.text.length > 40 && r.text.length <= LIMITS.resultMax);
  assert.doesNotMatch(r.text, /[`#*]|https?:|function parse/);
  assert.match(r.text, /[.!?]$/, 'it ends on a whole sentence');
});

test('failure endings: an error result is error then rest, a fatal says driver, and the next say works', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.say('an error please');
  const r = await c.waitFor(isResult);
  assert.equal(r.ok, false);
  assert.match(r.text, /did not work/);
  await c.waitForPhase('error');
  await c.waitForPhase('idle');

  const mark = c.mark();
  c.say('a fatal one');
  assert.equal((await c.waitFor(errOf('driver'))).msg, 'fake driver: simulated fatal error');
  await c.waitForPhase('error');
  await c.waitForPhase('idle');
  assert.deepEqual(shape(c, mark), ['state thinking', 'err driver', 'state error', 'state idle'], 'no result for a fatal');

  assert.equal((await turn(c, 'hello after the failure')).text, 'You said: hello after the failure');
});

test('an empty result still says something', async (t) => {
  const subtypes: [string, boolean, RegExp][] = [
    ['error_max_turns', false, /turn limit/],
    ['error_during_execution', false, /went wrong/],
    ['made_up_by_a_future_sdk', false, /did not work/],
    ['success', true, /Done/],
  ];
  const sc = scripted((d, prompt) => {
    const [subtype, ok] = subtypes[Number(prompt)] ?? ['x', false];
    d.emit({ k: 'result', ok: ok as boolean, text: '   ', subtype: subtype as string });
  });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  for (const [i, [, ok, re]] of subtypes.entries()) {
    const r = await turn(c, String(i));
    assert.equal(r.ok, ok);
    assert.match(r.text, re);
  }
});

// ===========================================================================
// Push to talk
// ===========================================================================

test('push to talk: audio in, transcript shown, prompt sent, result back', async (t) => {
  const stt = new ScriptedStt('hello from the mic');
  const spy = new Spy();
  const rig = await startRig(t, { server: { stt, driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.speak(25);
  const r = await c.waitFor(isResult);
  await c.waitForPhase('idle');
  await c.sync();
  assert.equal(r.text, 'You said: hello from the mic');
  assert.deepEqual(shape(c), [
    'hello_ack',
    'state idle',
    'state listening',
    'state transcribing',
    'stt',
    'state thinking',
    'result ok',
    'state done',
    'state idle',
  ]);
  assert.deepEqual(stt.received, [25 * 640], 'the adapter was given every byte that was sent, once');
  assert.deepEqual(spy.prompts, ['hello from the mic'], 'one prompt, not two');
});

test('the device is shown the folded transcript; Claude gets what was actually said', async (t) => {
  const said = '  open the café “menu” page  ';
  const spy = new Spy();
  const rig = await startRig(t, { server: { stt: new ScriptedStt(said), driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.speak(5);
  const heard = await c.waitFor((m) => m.t === 'stt');
  assert.deepEqual(heard, { t: 'stt', text: 'open the cafe "menu" page' });
  assert.equal(await spy.prompt(), 'open the café “menu” page', 'accents and curly quotes intact; only the edges trimmed');
  await c.waitFor(isResult);
});

test('listen cancel throws the audio away and starts nothing', async (t) => {
  const stt = new ScriptedStt('should never be heard');
  const rig = await startRig(t, { server: { stt } });
  const c = await rig.connect();
  c.listen('start');
  await c.waitForPhase('listening');
  c.sendPcm(10);
  c.listen('cancel');
  await c.waitForPhase('idle');
  c.listen('stop'); // there is no window any more
  assert.equal((await c.waitFor(isErr)).code, 'not_listening');
  c.listen('cancel'); // cancelling nothing is fine
  await c.sync();
  assert.deepEqual(stt.received, []);
  assert.deepEqual(shape(c), ['hello_ack', 'state idle', 'state listening', 'state idle', 'err not_listening']);
});

test('listen start twice discards the first utterance', async (t) => {
  const stt = new ScriptedStt('x');
  const rig = await startRig(t, { server: { stt } });
  const c = await rig.connect();
  c.listen('start');
  c.sendPcm(10);
  c.listen('start');
  c.sendPcm(5);
  c.listen('stop');
  await c.waitFor(isResult);
  assert.deepEqual(stt.received, [5 * 640]);
});

test('cancelling during transcription abandons the result: no stt, no prompt', async (t) => {
  let release: (s: string) => void = () => {};
  const slow: SttAdapter & { calls: number } = {
    calls: 0,
    transcribe() {
      this.calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    },
  };
  const spy = new Spy();
  const rig = await startRig(t, { server: { stt: slow, driverFactory: spy.wrap(fakeDriverFactory()) } });
  const c = await rig.connect();
  c.speak(3);
  await c.waitForPhase('transcribing');
  c.listen('start'); // not allowed while the transcription is in flight
  assert.equal((await c.waitFor(isErr)).code, 'busy');
  c.say('typed words'); // nor is a prompt
  assert.equal((await c.waitFor(isErr)).code, 'busy');
  c.listen('cancel');
  await c.waitForPhase('idle');

  release('too late to matter');
  await c.sync();
  assert.equal(slow.calls, 1, 'the adapter really was called, and really did answer');
  assert.deepEqual(spy.prompts, []);
  assert.equal(c.transcript.some((m) => m.t === 'stt'), false);
  assert.equal(shape(c).at(-1), 'state idle');
});

test('an utterance exactly at the ceiling is accepted; one frame more is too_long', async (t) => {
  const stt = new ScriptedStt('long enough');
  const rig = await startRig(t, { server: { stt } });
  const c = await rig.connect();
  const frames = LIMITS.utteranceMaxBytes / LIMITS.audioPayloadMax;
  assert.equal(Number.isInteger(frames), true);

  c.listen('start');
  c.sendPcm(frames, LIMITS.audioPayloadMax);
  c.listen('stop');
  await c.waitFor(isResult);
  await c.waitForPhase('idle');
  assert.deepEqual(stt.received, [LIMITS.utteranceMaxBytes], 'the whole ceiling went through');

  const mark = c.mark();
  c.listen('start');
  c.sendPcm(frames, LIMITS.audioPayloadMax);
  c.sendPcm(1, 2); // two bytes over
  assert.equal((await c.waitFor(errOf('too_long'))).code, 'too_long');
  c.listen('stop');
  assert.equal((await c.waitFor(errOf('not_listening'))).code, 'not_listening', 'the window was closed and the audio dropped');
  await c.sync();
  assert.equal(stt.received.length, 1, 'the oversized utterance never reached the adapter');
  assert.deepEqual(shape(c, mark), ['state listening', 'state idle', 'err too_long', 'err not_listening']);
});

test('audio outside a listen window gets not_listening, at most once a second', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  const frames = (n: number): void => {
    for (let i = 0; i < n; i++) c.sendAudio(Buffer.alloc(640));
  };
  frames(5);
  await c.sync();
  assert.equal(c.transcript.filter(errOf('not_listening')).length, 1, 'five frames, one reminder');
  rig.clock.advance(999);
  frames(1);
  await c.sync();
  assert.equal(c.transcript.filter(errOf('not_listening')).length, 1, 'not yet a second');
  rig.clock.advance(1);
  frames(1);
  await c.sync();
  assert.equal(c.transcript.filter(errOf('not_listening')).length, 2, 'a second has passed');
});

test('no speech engine: stop answers stt_unavailable and the pet rests', async (t) => {
  const rig = await startRig(t); // the default adapter
  const c = await rig.connect();
  c.speak(5);
  assert.equal((await c.waitFor(isErr)).code, 'stt_unavailable');
  await c.waitForPhase('idle');
  await c.sync();
  assert.deepEqual(shape(c), ['hello_ack', 'state idle', 'state listening', 'state transcribing', 'err stt_unavailable', 'state idle']);
  assert.equal((await turn(c, 'typing still works')).ok, true);
});

test('other speech failures are told apart: stt_failed for a crash or junk, empty for silence', async (t) => {
  const cases: [string, () => Promise<unknown>, string][] = [
    ['the engine threw', () => Promise.reject(new Error('boom')), 'stt_failed'],
    ['it returned something that is not text', () => Promise.resolve(42), 'stt_failed'],
    ['it heard nothing', () => Promise.resolve(''), 'empty'],
    ['it heard whitespace', () => Promise.resolve(' \n\t '), 'empty'],
    ['it heard only characters that cannot be shown', () => Promise.resolve('​​'), 'empty'],
  ];
  for (const [what, answer, code] of cases) {
    const spy = new Spy();
    const rig = await startRig(t, { server: { stt: { transcribe: answer as () => Promise<string> }, driverFactory: spy.wrap(fakeDriverFactory()) } });
    const c = await rig.connect();
    c.speak(3);
    assert.equal((await c.waitFor(isErr)).code, code, what);
    await c.waitForPhase('idle');
    await c.sync();
    assert.deepEqual(spy.prompts, [], what);
    assert.equal(shape(c).at(-1), 'state idle', what);
  }
});

test('a device that leaves or is replaced mid-sentence leaves no half-recorded utterance behind', async (t) => {
  const stt = new ScriptedStt('whole sentence');
  const rig = await startRig(t, { server: { stt } });
  const a = await rig.connect();
  a.listen('start');
  await a.waitForPhase('listening');
  a.sendPcm(10);

  const b = await rig.connect(); // takes over while A is listening
  assert.equal(shape(b).at(-1), 'state idle', 'the new device starts from rest');
  b.listen('stop');
  assert.equal((await b.waitFor(isErr)).code, 'not_listening', 'A\'s window did not carry over');

  b.speak(4);
  await b.waitFor(isResult);
  assert.deepEqual(stt.received, [4 * 640], 'and none of A\'s audio was mixed in');

  // The same when the device just vanishes.
  await b.waitForPhase('idle');
  b.listen('start');
  await b.waitForPhase('listening');
  b.sendPcm(6);
  b.terminate();
  await rig.logged(/conn 2 closed/);
  const c = await rig.connect();
  assert.equal(shape(c).at(-1), 'state idle');
  c.listen('stop');
  assert.equal((await c.waitFor(isErr)).code, 'not_listening');
});

// ===========================================================================
// Session persistence
// ===========================================================================

function stateDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the session id is saved on every session event and handed back to the next run', async (t) => {
  const dir = stateDir(t);
  const first = scripted((d, p) => {
    d.emit({ k: 'session', id: p === 'one' ? 'sess-one' : 'sess-two' });
    d.emit({ k: 'result', ok: true, text: 'ok', subtype: 'success' });
  });
  const rig1 = await startRig(t, { server: { driverFactory: first.factory, stateDir: dir } });
  assert.equal(first.driver().opts.resume, undefined, 'nothing to resume the first time');
  const c1 = await rig1.connect();
  await turn(c1, 'one');
  assert.equal(loadSession(dir, CWD), 'sess-one');
  await turn(c1, 'two');
  assert.equal(loadSession(dir, CWD), 'sess-two', 'a later session event replaces the earlier one');
  await rig1.server.close();

  const second = scripted();
  const rig2 = await startRig(t, { server: { driverFactory: second.factory, stateDir: dir } });
  assert.equal(second.driver().opts.resume, 'sess-two', 'the next run resumes it');
  const c2 = await rig2.connect();
  assert.equal(c2.ack?.ok === true && c2.ack.sid, 'sess-two', 'and says so in hello_ack');
});

test('a saved session for another directory, or a damaged file, is not resumed', async (t) => {
  const dir = stateDir(t);
  saveSession(dir, '/somewhere/else', 'foreign-session');
  const other = scripted();
  await startRig(t, { server: { driverFactory: other.factory, stateDir: dir } });
  assert.equal(other.driver().opts.resume, undefined);

  writeFileSync(join(dir, 'session.json'), '{ this is not json');
  const damaged = scripted();
  const rig = await startRig(t, { server: { driverFactory: damaged.factory, stateDir: dir } });
  assert.equal(damaged.driver().opts.resume, undefined);
  const c = await rig.connect();
  assert.equal(c.ack?.ok, true, 'and the server came up anyway');
});

test('without a state directory nothing is written', async (t) => {
  const sc = scripted((d) => {
    d.emit({ k: 'session', id: 'sess-x' });
    d.emit({ k: 'result', ok: true, text: 'ok', subtype: 'success' });
  });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  assert.equal((await turn(c, 'go')).ok, true);
  assert.equal(rig.logs.some((l) => /could not save/.test(l)), false);
});

test('a state directory that cannot be written costs the id, not the turn', async (t) => {
  const dir = stateDir(t);
  writeFileSync(join(dir, 'blocker'), 'a file where a directory is needed');
  const sc = scripted((d) => {
    d.emit({ k: 'session', id: 'sess-x' });
    d.emit({ k: 'result', ok: true, text: 'still fine', subtype: 'success' });
  });
  const rig = await startRig(t, { server: { driverFactory: sc.factory, stateDir: join(dir, 'blocker', 'sub') } });
  const c = await rig.connect();
  assert.equal((await turn(c, 'go')).text, 'still fine');
  await rig.logged(/could not save the session id/);
});

// ===========================================================================
// Keepalive
// ===========================================================================

test('keepalive: a client that never answers pings is dropped; one that does is not', async (t) => {
  // Real intervals, a few milliseconds: this measures a real socket going quiet.
  const rig = await startRig(t, { server: { pingIntervalMs: 20, deadAfterMs: 80 } });
  const dead = await rig.connect({ autoPong: false });
  assert.equal((await dead.waitClosed(5000)).code, 1006, 'terminated without a close frame');
  assert.ok(dead.pings >= 1, 'it WAS pinged: the heartbeat ran, and it chose not to answer');
  await rig.logged(/silent too long/);
});

test('keepalive: a client that answers pings is still here long after the silence limit', async (t) => {
  const rig = await startRig(t, { server: { pingIntervalMs: 20, deadAfterMs: 80 } });
  const alive = await rig.connect();
  await alive.waitForPings(10); // ten heartbeats: far longer than the 80 ms limit
  await alive.sync();
  assert.equal(alive.closed, undefined);
  assert.equal(rig.logs.some((l) => /silent too long/.test(l)), false);
});

test('keepalive: a pause of the bridge itself is not held against the device', async (t) => {
  const rig = await startRig(t, { server: { pingIntervalMs: 20, deadAfterMs: 80 } });
  const c = await rig.connect();
  await c.waitForPings(2); // the heartbeat is running
  // Stand the whole process still for far longer than the silence limit, as a laptop going to
  // sleep or a starved CPU would. The device's pong is queued behind the bridge's next tick.
  const until = performance.now() + 300;
  while (performance.now() < until) { /* blocked on purpose */ }
  const before = c.pings;
  await c.waitForPings(before + 3);
  await c.sync();
  assert.equal(c.closed, undefined, 'a healthy device survives the bridge having been paused');
  await rig.logged(/keepalive ran late/);
});

test('keepalive: any frame counts as life, not only a pong', async (t) => {
  const rig = await startRig(t, { server: { pingIntervalMs: 20, deadAfterMs: 80 } });
  const c = await rig.connect({ autoPong: false });
  let n = 0;
  c.socket.on('ping', () => c.ping(++n)); // an application ping instead of a pong
  await c.waitForPings(10);
  await c.sync();
  assert.equal(c.closed, undefined);
});

// ===========================================================================
// Shutdown and start-up
// ===========================================================================

test('close(): sockets get 1001, the driver is closed, no timer is left, the port is free', async (t) => {
  const sc = scripted(async (d) => {
    await d.permission('Bash', { command: 'npm test' }); // an ask is open when we shut down
  });
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  const idle = await rig.open(); // a socket that never said hello
  c.say('go');
  await c.waitFor(isAsk);

  const port = rig.server.port;
  await rig.server.close();
  assert.equal((await c.waitClosed()).code, 1001);
  assert.equal((await idle.waitClosed()).code, 1001);
  assert.equal(c.transcript.some((m) => m.t === 'ask_end' && m.why === 'abort'), true, 'the open ask was ended before the sockets closed');
  assert.equal(sc.driver().closed, true);
  assert.equal(rig.clock.armed, 0, `armed: ${rig.clock.delays().join(', ')}`);

  // The port really is free: bind it ourselves.
  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port }, () => probe.close((e) => (e ? reject(e) : resolve())));
  });
  await assert.rejects(DeviceClient.open(`ws://127.0.0.1:${port}/`), 'and nobody is listening on it');
  await rig.server.close(); // a second close is harmless
});

test('close() does not wait forever for a client that will not answer the close frame', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  stalePause(c); // never reads the close frame, so never answers it
  const started = Date.now();
  await rig.server.close();
  assert.ok(Date.now() - started < 4000, 'it gave up politely and terminated the socket');
  c.terminate();
});

test('close() while an abort is still winding down leaves no watchdog behind', async (t) => {
  const sc = scripted(() => {}, { onInterrupt: async () => {} }); // never ends the turn
  const rig = await startRig(t, { server: { driverFactory: sc.factory } });
  const c = await rig.connect();
  c.say('stuck');
  await c.waitForPhase('thinking');
  c.abort();
  await rig.clock.timerSet(ABORT_GRACE_MS);
  await rig.server.close();
  assert.equal(rig.clock.armed, 0, `armed: ${rig.clock.delays().join(', ')}`);
  assert.equal(c.transcript.some(isResult), false, 'and the watchdog did not fire into a closing server');
});

test('close() with a turn in flight ends it silently: no late frames, no timers', async (t) => {
  const rig = await startRig(t);
  const c = await rig.connect();
  c.say('a slow search');
  await c.waitForPhase('tool', 'Grep');
  await rig.server.close();
  await c.waitClosed();
  assert.equal(c.transcript.some(isResult), false, 'the interrupted turn reported nothing to a closing socket');
  assert.equal(rig.clock.armed, 0);
});

test('a port that is taken makes startServer fail, and the driver it made is closed again', async (t) => {
  const taken = createNetServer();
  await new Promise<void>((resolve) => taken.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => void taken.close());
  const port = (taken.address() as { port: number }).port;
  const sc = scripted();
  await assert.rejects(
    startServer({ host: '127.0.0.1', port, token: TOKEN, cwd: CWD, driverFactory: sc.factory }),
    (e: NodeJS.ErrnoException) => e.code === 'EADDRINUSE',
  );
  assert.equal(sc.driver().closed, true);
});

test('a token the device could never send is refused at start-up', async () => {
  const sc = scripted();
  for (const token of ['', 'short', 'x'.repeat(LIMITS.tokenMin - 1), 'x'.repeat(LIMITS.tokenMax + 1)]) {
    await assert.rejects(
      startServer({ host: '127.0.0.1', port: 0, token, cwd: CWD, driverFactory: sc.factory }),
      RangeError,
      JSON.stringify(token),
    );
  }
  assert.equal(sc.made.length, 0, 'and no driver was created for it');
});

test('only the root path speaks WebSocket; plain HTTP is told so', async (t) => {
  const rig = await startRig(t);
  await assert.rejects(DeviceClient.open(`${rig.url}other`), 'a path other than /');
  const status = await new Promise<number>((resolve, reject) => {
    httpGet(rig.url.replace('ws://', 'http://'), (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
  assert.equal(status, 426);
});

// ===========================================================================
// The test client is only worth trusting if it can fail
// ===========================================================================

/** A bridge that sends exactly these frames, then a pong so the client knows they have all arrived. */
async function rogue(t: TestContext, frames: string[]): Promise<DeviceClient> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  t.after(() => void wss.close());
  wss.on('connection', (ws) => {
    for (const f of frames) ws.send(f);
    ws.send('{"t":"pong","n":0}');
  });
  const port = (wss.address() as { port: number }).port;
  const c = await DeviceClient.open(`ws://127.0.0.1:${port}/`);
  t.after(() => c.terminate());
  await c.waitFor((m) => m.t === 'pong');
  c.rewind(); // the pong was only a "they have all arrived" marker; let the test read from the top
  return c;
}
const state = (seq: number, ph = 'idle', pend = 0): string => `{"t":"state","seq":${seq},"ph":"${ph}","tl":"","pend":${pend}}`;
const ask = (id: string): string => `{"t":"ask","id":"${id}","tl":"Bash","risk":"med","sum":"x","ttl":5}`;

test('DeviceClient: the invariants it enforces are enforced (it flags what it should)', async (t) => {
  const clean = await rogue(t, [state(1), state(2, 'thinking'), ask('00000001'), '{"t":"ask_end","id":"00000001","why":"answered"}', ask('00000002')]);
  assert.doesNotThrow(() => clean.assertClean());

  const cases: [string, string[], RegExp][] = [
    ['a frame that is not ASCII', ['{"t":"stt","text":"café"}'], /not printable ASCII/],
    ['a frame that does not decode', ['{"t":"state"}'], /undecodable/],
    ['a seq that starts at 2', [state(2)], /seq 2 after 0/],
    ['a seq that skips', [state(1), state(3, 'thinking')], /seq 3 after 1/],
    ['a repeated state', [state(1), state(2)], /repeated/],
    ['two asks at once', [ask('00000001'), ask('00000002')], /still open/],
  ];
  for (const [what, frames, re] of cases) {
    const c = await rogue(t, frames);
    assert.throws(() => c.assertClean(), re, what);
  }
});

test('DeviceClient: waiting fails with a diagnosis, not a hang', async (t) => {
  const c = await rogue(t, [state(1)]);
  await assert.rejects(c.waitFor((m) => m.t === 'result', 50), /timed out after 50 ms.*state#1 idle/);
  const closing = c.waitFor((m) => m.t === 'result', 5000);
  c.terminate();
  await assert.rejects(closing, /connection closed/);
  // Messages that arrived before the wait began are found, and the cursor moves past them.
  const d = await rogue(t, [state(1), state(2, 'thinking')]);
  assert.equal((await d.waitFor((m) => m.t === 'state' && m.ph === 'idle')).t, 'state');
  assert.equal((await d.waitFor((m) => m.t === 'state')).t, 'state', 'the next call starts after the last match');
  await assert.rejects(d.waitFor((m) => m.t === 'state', 30), /timed out/);
});
