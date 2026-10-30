/**
 * The fake driver is a test double that other tests stand on, so these tests are about
 * whether it keeps the real driver's promises (the DriverEvent invariant in types.ts),
 * not about its canned text:
 *
 *  - every scenario's exact event order;
 *  - the terminal-event rule, checked over EVERY scenario and every way a permission
 *    can go (allowed, refused, thrown, nonsense), because a rule checked on one path
 *    is the bug waiting on the next;
 *  - an interrupt at every point a turn can be stopped, including before it starts
 *    and while a handler that ignores its signal is still being waited on;
 *  - what the permission handler actually receives, since it is what the bridge's
 *    safety rests on.
 *
 * Nothing sleeps: the clock is the injected `sleep`, and "wait for the driver" means
 * letting the microtask queue drain, which is not time.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeBridgeMsg, isPrintableAscii } from '../src/protocol.ts';
import { createFakeDriver, fakeDriverFactory, fakeScenarioFor, FAKE_SCENARIOS } from '../src/drivers/fake.ts';
import type { FakeScenario } from '../src/drivers/fake.ts';
import { summarizeForDevice } from '../src/text.ts';
import { LIMITS } from '../src/types.ts';
import type { DriverEvent, PermissionDecision, PermissionHandler, PermissionRequest, SessionDriver } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** A tick of the macrotask queue: every pending microtask has run before it fires. Not a sleep. */
const drain = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

const DENY: PermissionDecision = { allow: false, message: 'The user denied this action on their handheld device.' };

interface Pending {
  req: PermissionRequest;
  resolve(d: PermissionDecision): void;
  reject(e: unknown): void;
}

type Policy = 'allow' | 'deny' | 'manual';

interface Harness {
  driver: SessionDriver;
  events: DriverEvent[];
  /** Events and permission requests in the order they happened, as `k` / `perm:<tool>` tags. */
  order: string[];
  requests: Pending[];
  logs: string[];
}

interface HarnessOptions {
  policy?: Policy;
  /** Replaces the whole permission handler. */
  handler?: PermissionHandler;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  resume?: string;
  onEvent?: (e: DriverEvent, h: Harness) => void;
}

function tag(e: DriverEvent): string {
  return e.k === 'tool_start' ? `tool_start:${e.name}` : e.k;
}

function harness(o: HarnessOptions = {}): Harness {
  const h: Harness = { driver: undefined as unknown as SessionDriver, events: [], order: [], requests: [], logs: [] };
  const policy = o.policy ?? 'allow';
  const handler: PermissionHandler = o.handler ?? ((req) => {
    h.order.push(`perm:${req.tool}`);
    let resolve!: (d: PermissionDecision) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<PermissionDecision>((res, rej) => { resolve = res; reject = rej; });
    h.requests.push({ req, resolve, reject });
    if (policy === 'allow') resolve({ allow: true });
    else if (policy === 'deny') resolve(DENY);
    return promise;
  });
  h.driver = createFakeDriver(
    {
      cwd: '/work',
      resume: o.resume,
      log: (line) => { h.logs.push(line); },
      onPermission: handler,
      onEvent: (e) => {
        h.events.push(e);
        h.order.push(tag(e));
        o.onEvent?.(e, h);
      },
    },
    { delayMs: o.delayMs, sleep: o.sleep },
  );
  return h;
}

/** A compact, id-free reading of an event list. */
function shape(events: readonly DriverEvent[]): string[] {
  return events.map((e) => {
    switch (e.k) {
      case 'session': return 'session';
      case 'text': return 'text';
      case 'tool_start': return `start:${e.name}`;
      case 'tool_end': return e.ok ? 'end:ok' : 'end:fail';
      case 'result': return `result:${e.ok ? 'ok' : 'fail'}:${e.subtype}`;
      case 'fatal': return 'fatal';
    }
  });
}

const isTerminal = (e: DriverEvent): boolean => e.k === 'result' || e.k === 'fatal';

/** The invariant from types.ts, plus the bookkeeping a consumer of tool events relies on. */
function assertWellFormed(events: readonly DriverEvent[], turns: number, what: string): void {
  const sessions = events.filter((e) => e.k === 'session');
  assert.ok(sessions.length <= 1, `${what}: ${sessions.length} session events`);
  if (sessions.length === 1) assert.equal(events[0]?.k, 'session', `${what}: session is not first`);
  const started = new Set<string>();
  const open = new Set<string>();
  let terminals = 0;
  for (const e of events) {
    if (e.k === 'tool_start') {
      assert.ok(!started.has(e.id), `${what}: tool id ${e.id} started twice`);
      started.add(e.id);
      open.add(e.id);
    } else if (e.k === 'tool_end') {
      assert.ok(open.delete(e.id), `${what}: tool_end for ${e.id} which is not running`);
    } else if (isTerminal(e)) {
      assert.equal(open.size, 0, `${what}: tool(s) ${[...open].join(',')} still running at the terminal event`);
      terminals++;
    }
  }
  assert.equal(terminals, turns, `${what}: ${terminals} terminal events for ${turns} prompts`);
  const last = events[events.length - 1];
  assert.ok(last !== undefined && isTerminal(last), `${what}: the last event is not terminal`);
}

async function mustSettle<T>(p: Promise<T>, what: string): Promise<T> {
  let state: 'pending' | 'ok' | 'err' = 'pending';
  let value: T | undefined;
  p.then((v) => { state = 'ok'; value = v; }, () => { state = 'err'; });
  for (let i = 0; i < 20 && state === 'pending'; i++) await drain();
  assert.equal(state, 'ok', `${what} ${state === 'pending' ? 'did not settle' : 'rejected'}`);
  return value as T;
}

/** A sleep that finishes at once for its first `n` calls and never again. */
function sleepThenStall(n: number): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms) => {
      calls.push(ms);
      return calls.length <= n ? Promise.resolve() : new Promise<void>(() => {});
    },
  };
}

const PROMPT_FOR: Record<FakeScenario, string> = {
  danger: 'please do something danger',
  parallel: 'do two things',
  edit: 'edit the file',
  bash: 'run the checks',
  unicode: 'show me unicode',
  long: 'give a long answer',
  slow: 'be slow about it',
  error: 'cause an error',
  fatal: 'die with a fatal',
  echo: 'hello there',
};

/** The scenarios that ask a person before they act, and how many tools each starts. */
const ASKING: ReadonlyArray<readonly [FakeScenario, number]> = [['danger', 1], ['edit', 1], ['bash', 1], ['parallel', 2]];

const SCENARIOS = FAKE_SCENARIOS.map((s) => s.name);

// ---------------------------------------------------------------------------
describe('scenario selection', () => {
  it('picks the scenario the task describes for each keyword', () => {
    // Hand-typed from the specification, not derived from the table under test.
    const expected: ReadonlyArray<readonly [string, FakeScenario]> = [
      ['danger', 'danger'], ['please DANGER now', 'danger'], ['rm -rf /tmp/x', 'danger'],
      ['two things', 'parallel'], ['do these in Parallel', 'parallel'],
      ['edit the file', 'edit'], ['write a poem', 'edit'],
      ['bash it', 'bash'], ['run the tests', 'bash'], ['test', 'bash'],
      ['show unicode', 'unicode'], ['a long answer', 'long'], ['slow please', 'slow'],
      ['cause an error', 'error'], ['fatal', 'fatal'],
      ['hello', 'echo'], ['', 'echo'], ['What is 2+2?', 'echo'],
      // Prompts that match more than one row: the order of the rows in the task is the order of precedence.
      ['danger test', 'danger'], ['rm -rf the test dir', 'danger'], ['two tests', 'parallel'],
      ['edit and run', 'edit'], ['write a long essay', 'edit'], ['run unicode', 'bash'],
      ['unicode long', 'unicode'], ['a long slow error', 'long'], ['slow error', 'slow'], ['fatal error', 'error'],
    ];
    for (const [prompt, scenario] of expected) assert.equal(fakeScenarioFor(prompt), scenario, JSON.stringify(prompt));
  });

  it('lets the earlier row win when a prompt matches two', () => {
    // For every pair of rows, a prompt naming both gets the earlier one, in either order of mention.
    const rows = FAKE_SCENARIOS.filter((s) => s.keywords.length > 0);
    for (const [i, early] of rows.entries()) {
      for (const late of rows.slice(i + 1)) {
        for (const a of early.keywords) {
          for (const b of late.keywords) {
            assert.equal(fakeScenarioFor(`${b} then ${a}`), early.name, `${b} then ${a}`);
            assert.equal(fakeScenarioFor(`${a} then ${b}`), early.name, `${a} then ${b}`);
          }
        }
      }
    }
  });

  it('matches by substring, as documented, so "latest" selects bash through "test"', () => {
    assert.equal(fakeScenarioFor('the latest news'), 'bash');
    assert.equal(fakeScenarioFor('a network problem'), 'parallel'); // "two" inside "network"
  });

  it('has a prompt in this suite for every scenario, and that prompt selects it', () => {
    assert.deepEqual([...SCENARIOS].sort(), Object.keys(PROMPT_FOR).sort(), 'a scenario was added or removed');
    for (const name of SCENARIOS) assert.equal(fakeScenarioFor(PROMPT_FOR[name]), name);
  });

  it('keeps echo as the fall-through: it has no keywords of its own', () => {
    const echo = FAKE_SCENARIOS.find((s) => s.name === 'echo');
    assert.deepEqual(echo?.keywords, []);
    assert.equal(FAKE_SCENARIOS[FAKE_SCENARIOS.length - 1]?.name, 'echo');
  });
});

// ---------------------------------------------------------------------------
describe('event order for each scenario (every permission allowed)', () => {
  const EXPECTED: Record<Exclude<FakeScenario, 'slow'>, string[]> = {
    danger: ['session', 'text', 'start:Bash', 'end:ok', 'result:ok:success'],
    parallel: ['session', 'text', 'start:Bash', 'start:Edit', 'end:ok', 'end:ok', 'result:ok:success'],
    edit: ['session', 'text', 'start:Edit', 'end:ok', 'result:ok:success'],
    bash: ['session', 'text', 'start:Bash', 'end:ok', 'result:ok:success'],
    unicode: ['session', 'result:ok:success'],
    long: ['session', 'result:ok:success'],
    error: ['session', 'result:fail:error_during_execution'],
    fatal: ['session', 'fatal'],
    echo: ['session', 'text', 'result:ok:success'],
  };

  for (const [scenario, want] of Object.entries(EXPECTED) as Array<[Exclude<FakeScenario, 'slow'>, string[]]>) {
    it(scenario, async () => {
      const h = harness();
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      assert.deepEqual(shape(h.events), want);
      assertWellFormed(h.events, 1, scenario);
    });
  }

  it('slow: starts a tool and then does nothing at all until it is interrupted', async () => {
    const h = harness();
    h.driver.prompt(PROMPT_FOR.slow);
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Grep']);
    await drain();
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Grep'], 'still running, many ticks later');
    assert.equal(h.requests.length, 0, 'a read-only tool is not asked about');
    await mustSettle(h.driver.interrupt(), 'interrupt');
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Grep', 'end:fail', 'result:fail:interrupted']);
    assertWellFormed(h.events, 1, 'slow');
  });

  it('covers every scenario in the table', () => {
    assert.deepEqual([...Object.keys(EXPECTED), 'slow'].sort(), [...SCENARIOS].sort());
  });

  it('puts the tool_end id on the tool_start it belongs to', async () => {
    for (const [scenario] of ASKING) {
      const h = harness();
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      const starts = h.events.filter((e) => e.k === 'tool_start').map((e) => e.id).sort();
      const ends = h.events.filter((e) => e.k === 'tool_end').map((e) => e.id).sort();
      assert.deepEqual(ends, starts, scenario);
      assert.equal(new Set(starts).size, starts.length, 'ids are distinct');
    }
  });

  it('keeps tool ids distinct across turns of one driver', async () => {
    const h = harness();
    h.driver.prompt('bash');
    h.driver.prompt('bash');
    await drain();
    const ids = h.events.filter((e) => e.k === 'tool_start').map((e) => e.id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});

// ---------------------------------------------------------------------------
describe('what the permission handler receives', () => {
  const INPUTS: Record<string, Record<string, unknown>> = {
    danger: { command: 'rm -rf ~' },
    bash: { command: 'npm test' },
    edit: { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' },
  };
  const TOOL: Record<string, string> = { danger: 'Bash', bash: 'Bash', edit: 'Edit' };

  for (const scenario of ['danger', 'bash', 'edit'] as const) {
    it(`${scenario}: the tool name, the real input, the id of the tool_start, and a live signal`, async () => {
      const h = harness({ policy: 'manual' });
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      assert.equal(h.requests.length, 1);
      const { req } = h.requests[0]!;
      assert.equal(req.tool, TOOL[scenario]);
      assert.deepEqual(req.input, INPUTS[scenario]);
      const start = h.events.find((e) => e.k === 'tool_start');
      assert.ok(start && start.k === 'tool_start');
      assert.equal(req.toolUseId, start.id);
      assert.equal(req.signal.aborted, false);
      assert.ok(req.signal instanceof AbortSignal);
      h.requests[0]!.resolve({ allow: true });
      await drain();
    });
  }

  it('parallel: two requests are outstanding AT ONCE, in start order, each with its own id', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt(PROMPT_FOR.parallel);
    await drain();
    // Nothing has been answered, and both are already asking: they are concurrent, not queued.
    assert.equal(h.requests.length, 2);
    const [a, b] = h.requests.map((r) => r.req) as [PermissionRequest, PermissionRequest];
    assert.deepEqual([a.tool, b.tool], ['Bash', 'Edit']);
    assert.deepEqual(a.input, { command: 'npm test' });
    assert.deepEqual(b.input, { file_path: 'src/app.ts', old_string: 'a', new_string: 'b' });
    const starts = h.events.filter((e) => e.k === 'tool_start');
    assert.deepEqual([a.toolUseId, b.toolUseId], starts.map((e) => e.id));
    assert.notEqual(a.toolUseId, b.toolUseId);
    assert.ok(!a.signal.aborted && !b.signal.aborted);
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Bash', 'start:Edit'], 'no tool has ended yet');
    h.requests.forEach((r) => r.resolve({ allow: true }));
    await drain();
  });

  it('reveals the tool BEFORE asking, and ends it only after the answer', async () => {
    for (const [scenario] of ASKING) {
      const h = harness({ policy: 'manual' });
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      const firstAsk = h.order.findIndex((t) => t.startsWith('perm:'));
      const lastStart = h.order.map((t) => t.startsWith('tool_start')).lastIndexOf(true);
      assert.ok(firstAsk > 0, scenario);
      assert.ok(lastStart >= 0 && lastStart < firstAsk, `${scenario}: every tool_start precedes the first ask: ${h.order.join(' ')}`);
      assert.ok(!h.order.includes('tool_end'), `${scenario}: a tool ended before it was answered`);
      assert.ok(!h.order.includes('result'), `${scenario}: finished before it was answered`);
      h.requests.forEach((r) => r.resolve({ allow: true }));
      await drain();
      assert.ok(h.order.lastIndexOf('tool_end') > h.order.indexOf(`perm:${h.requests[0]!.req.tool}`));
    }
  });

  it('hands over a COPY of the input, so a handler that edits it changes nothing later', async () => {
    // The input comes from constants in the fake; if it were passed by reference, the
    // damage would persist into every later request.
    const seen: unknown[] = [];
    const h = harness({
      handler: async (req) => {
        seen.push(structuredClone(req.input));
        for (const k of Object.keys(req.input)) delete req.input[k];
        req.input.injected = true;
        return { allow: true };
      },
    });
    h.driver.prompt('bash');
    h.driver.prompt('bash');
    await drain();
    assert.deepEqual(seen, [{ command: 'npm test' }, { command: 'npm test' }]);
  });

  it('never asks for a tool it did not start first', async () => {
    for (const [scenario] of ASKING) {
      const h = harness({ policy: 'manual' });
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      const started = new Set(h.events.filter((e) => e.k === 'tool_start').map((e) => e.id));
      for (const r of h.requests) assert.ok(started.has(r.req.toolUseId), scenario);
    }
  });
});

// ---------------------------------------------------------------------------
describe('refusals are not errors', () => {
  const ORDER: Record<string, string[]> = {
    danger: ['session', 'text', 'start:Bash', 'end:fail', 'result:ok:success'],
    edit: ['session', 'text', 'start:Edit', 'end:fail', 'result:ok:success'],
    bash: ['session', 'text', 'start:Bash', 'end:fail', 'result:ok:success'],
  };
  const NAMED: Record<string, string> = { danger: 'rm -rf ~', edit: 'src/app.ts', bash: 'npm test' };

  for (const scenario of ['danger', 'edit', 'bash'] as const) {
    it(`${scenario}: ends the tool as failed, carries on, and the result says what was refused and why`, async () => {
      const h = harness({ policy: 'deny' });
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      assert.deepEqual(shape(h.events), ORDER[scenario]);
      const result = h.events[h.events.length - 1];
      assert.ok(result && result.k === 'result');
      assert.equal(result.ok, true, 'the turn itself did not fail');
      assert.match(result.text, new RegExp(NAMED[scenario]!.replace(/[.*+?^${}()|[\]\\~]/g, '\\$&')), 'names the refused call');
      assert.match(result.text, /refused/i);
      assert.ok(result.text.includes(DENY.allow === false ? DENY.message : ''), "carries the handler's own explanation");
    });
  }

  it('parallel: one allowed and one refused is reported as both', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt(PROMPT_FOR.parallel);
    await drain();
    h.requests[0]!.resolve({ allow: true });
    h.requests[1]!.resolve({ allow: false, message: 'No edits today.' });
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Bash', 'start:Edit', 'end:ok', 'end:fail', 'result:ok:success']);
    const result = h.events[h.events.length - 1];
    assert.ok(result && result.k === 'result');
    assert.match(result.text, /ran npm test/);
    assert.match(result.text, /Edit \(src\/app\.ts\) was refused/);
    assert.match(result.text, /No edits today\./);
    assert.doesNotMatch(result.text, /edited src/);
  });

  it('parallel: each tool ends when ITS answer arrives, in whichever order they come', async () => {
    const endsFor = async (first: 0 | 1): Promise<string[]> => {
      const h = harness({ policy: 'manual' });
      h.driver.prompt(PROMPT_FOR.parallel);
      await drain();
      const ids = h.events.filter((e) => e.k === 'tool_start').map((e) => e.id);
      h.requests[first]!.resolve({ allow: true });
      await drain();
      const early = h.events.filter((e) => e.k === 'tool_end');
      assert.equal(early.length, 1, 'only the answered tool has ended');
      assert.equal(early[0]!.id, ids[first]);
      h.requests[1 - first]!.resolve({ allow: true });
      await drain();
      assertWellFormed(h.events, 1, `answered ${first} first`);
      return h.events.filter((e) => e.k === 'tool_end').map((e) => (e.id === ids[0] ? 'bash' : 'edit'));
    };
    assert.deepEqual(await endsFor(0), ['bash', 'edit']);
    assert.deepEqual(await endsFor(1), ['edit', 'bash']);
  });

  it('a deny with interrupt:true stops the whole turn, including the other pending request', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt(PROMPT_FOR.parallel);
    await drain();
    h.requests[0]!.resolve({ allow: false, message: 'Stop everything.', interrupt: true });
    await drain();
    assert.deepEqual(shape(h.events), [
      'session', 'text', 'start:Bash', 'start:Edit', 'end:fail', 'end:fail', 'result:fail:interrupted',
    ]);
    assert.ok(h.requests[1]!.req.signal.aborted, 'the other request is told it is no longer wanted');
    assertWellFormed(h.events, 1, 'deny with interrupt');
  });

  it('a deny WITHOUT interrupt leaves the other request pending and the signals live', async () => {
    // Companion to the test above: the interrupt must come from the flag, not from any deny.
    const h = harness({ policy: 'manual' });
    h.driver.prompt(PROMPT_FOR.parallel);
    await drain();
    h.requests[0]!.resolve(DENY);
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Bash', 'start:Edit', 'end:fail']);
    assert.equal(h.requests[1]!.req.signal.aborted, false);
    h.requests[1]!.resolve({ allow: true });
    await drain();
    assertWellFormed(h.events, 1, 'deny without interrupt');
  });
});

// ---------------------------------------------------------------------------
describe('a handler that misbehaves is a refusal', () => {
  const BAD: ReadonlyArray<readonly [string, PermissionHandler]> = [
    ['throws synchronously', () => { throw new Error('SECRET-BOOM'); }],
    ['rejects', () => Promise.reject(new Error('SECRET-BOOM'))],
    ['returns nothing', (() => Promise.resolve(undefined)) as unknown as PermissionHandler],
    ['returns null', (() => Promise.resolve(null)) as unknown as PermissionHandler],
    ['returns an empty object', (() => Promise.resolve({})) as unknown as PermissionHandler],
    ['returns allow:"yes"', (() => Promise.resolve({ allow: 'yes' })) as unknown as PermissionHandler],
    ['returns allow:1', (() => Promise.resolve({ allow: 1 })) as unknown as PermissionHandler],
    ['returns a bare true', (() => Promise.resolve(true)) as unknown as PermissionHandler],
    ['returns a non-string message', (() => Promise.resolve({ allow: false, message: 42 })) as unknown as PermissionHandler],
  ];

  for (const [name, handler] of BAD) {
    it(`${name}: the tool ends failed and nothing is allowed`, async () => {
      for (const [scenario] of ASKING) {
        const h = harness({ handler });
        h.driver.prompt(PROMPT_FOR[scenario]);
        await drain();
        assertWellFormed(h.events, 1, `${name} / ${scenario}`);
        const ends = h.events.filter((e) => e.k === 'tool_end');
        assert.ok(ends.length > 0 && ends.every((e) => e.ok === false), `${name} / ${scenario}: allowed by a bad answer`);
        const result = h.events[h.events.length - 1];
        assert.ok(result && result.k === 'result' && result.ok === true);
        assert.doesNotMatch(result.text, /SECRET-BOOM/, 'a handler failure text is not copied into the result');
      }
    });
  }

  it('a real allow is the only thing that gets through (the companion to the table above)', async () => {
    const h = harness({ handler: () => Promise.resolve({ allow: true }) });
    h.driver.prompt('bash');
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Bash', 'end:ok', 'result:ok:success']);
  });
});

// ---------------------------------------------------------------------------
describe('exactly one terminal event per accepted prompt', () => {
  const POLICIES: ReadonlyArray<readonly [string, HarnessOptions]> = [
    ['allow', { policy: 'allow' }],
    ['deny', { policy: 'deny' }],
    ['throwing handler', { handler: () => { throw new Error('boom'); } }],
    ['nonsense answers', { handler: (() => Promise.resolve('maybe')) as unknown as PermissionHandler }],
    ['allow, with a delay between steps', { policy: 'allow', delayMs: 5, sleep: () => Promise.resolve() }],
  ];

  for (const [policyName, base] of POLICIES) {
    it(`every scenario that can finish by itself, under: ${policyName}`, async () => {
      for (const scenario of SCENARIOS.filter((s) => s !== 'slow')) {
        const h = harness(base);
        h.driver.prompt(PROMPT_FOR[scenario]);
        await drain();
        assertWellFormed(h.events, 1, `${scenario} under ${policyName}`);
      }
    });
  }

  it('also for every scenario back to back on one driver', async () => {
    const h = harness();
    const finishing = SCENARIOS.filter((s) => s !== 'slow');
    for (const s of finishing) h.driver.prompt(PROMPT_FOR[s]);
    await drain();
    assertWellFormed(h.events, finishing.length, 'queue of every scenario');
    assert.equal(h.events.filter((e) => e.k === 'session').length, 1, 'announced once for the whole session');
  });

  it('even when the consumer throws from its event callback', async () => {
    for (const scenario of SCENARIOS.filter((s) => s !== 'slow')) {
      const h = harness({
        onEvent: () => { throw new Error('consumer bug'); },
      });
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      assertWellFormed(h.events, 1, `${scenario} with a throwing consumer`);
      assert.ok(h.logs.some((l) => l.includes('onEvent threw')), 'it says so in the log instead of swallowing silently');
    }
  });
});

// ---------------------------------------------------------------------------
describe('interrupt', () => {
  it('before the turn has started: still a session, then exactly one interrupted result (every scenario)', async () => {
    for (const scenario of SCENARIOS) {
      const h = harness();
      h.driver.prompt(PROMPT_FOR[scenario]);
      await mustSettle(h.driver.interrupt(), `interrupt in ${scenario}`);
      assert.deepEqual(shape(h.events), ['session', 'result:fail:interrupted'], scenario);
      assertWellFormed(h.events, 1, scenario);
    }
  });

  for (const [scenario, tools] of ASKING) {
    it(`${scenario}: while ${tools === 1 ? 'the permission' : 'both permissions'} ${tools === 1 ? 'is' : 'are'} pending, even though the handler never answers`, async () => {
      const h = harness({ policy: 'manual' });
      h.driver.prompt(PROMPT_FOR[scenario]);
      await drain();
      assert.equal(h.requests.length, tools);
      assert.ok(h.requests.every((r) => !r.req.signal.aborted));
      await mustSettle(h.driver.interrupt(), 'interrupt'); // would hang if the driver waited on the handler alone
      assert.ok(h.requests.every((r) => r.req.signal.aborted), 'every pending request is told to stop waiting');
      const ends = Array(tools).fill('end:fail') as string[];
      assert.deepEqual(shape(h.events).slice(-(tools + 1)), [...ends, 'result:fail:interrupted']);
      assertWellFormed(h.events, 1, scenario);
    });
  }

  it('slow: while a tool is running', async () => {
    const h = harness();
    h.driver.prompt('slow');
    await drain();
    await mustSettle(h.driver.interrupt(), 'interrupt');
    assertWellFormed(h.events, 1, 'slow');
    assert.equal(shape(h.events).at(-1), 'result:fail:interrupted');
  });

  it('at every point of every scenario, however many steps in', async () => {
    // For each scenario, let the first n pauses pass and stall on the next, then interrupt.
    // n = 0 stops it before anything is said; a large n lets it finish on its own first.
    const interruptedRuns = new Map<FakeScenario, number>();
    for (const scenario of SCENARIOS) {
      for (let n = 0; n <= 6; n++) {
        const stall = sleepThenStall(n);
        const h = harness({ policy: 'allow', delayMs: 7, sleep: stall.sleep });
        h.driver.prompt(PROMPT_FOR[scenario]);
        await drain();
        const finishedAlone = h.events.some(isTerminal);
        if (!finishedAlone) {
          await mustSettle(h.driver.interrupt(), `interrupt in ${scenario} after ${n} pauses`);
          interruptedRuns.set(scenario, (interruptedRuns.get(scenario) ?? 0) + 1);
          assert.equal(shape(h.events).at(-1), 'result:fail:interrupted', `${scenario} after ${n} pauses`);
        }
        assertWellFormed(h.events, 1, `${scenario} after ${n} pauses`);
        assert.ok(stall.calls.every((ms) => ms === 7), 'the pause is the configured delay');
      }
    }
    // The mechanism engaged: interrupting actually stopped something in every scenario,
    // or "every interrupt is well formed" would be true of a driver that cannot be stopped.
    for (const scenario of SCENARIOS) assert.ok((interruptedRuns.get(scenario) ?? 0) > 0, `${scenario} was never interrupted`);
  });

  it('resolves only after the terminal event has gone out', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt('bash');
    await drain();
    let seenAtResolve: string[] = [];
    await mustSettle(h.driver.interrupt().then(() => { seenAtResolve = shape(h.events); }), 'interrupt');
    assert.equal(seenAtResolve.at(-1), 'result:fail:interrupted');
  });

  it('does nothing when no turn is running, and does not poison the next one', async () => {
    const h = harness();
    await mustSettle(h.driver.interrupt(), 'idle interrupt');
    assert.deepEqual(h.events, []);
    h.driver.prompt('hello');
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'result:ok:success'], 'an earlier interrupt did not abort this turn');
    await mustSettle(h.driver.interrupt(), 'interrupt after a finished turn');
    h.driver.prompt('again');
    await drain();
    assertWellFormed(h.events, 2, 'after interrupts at rest');
    assert.equal(shape(h.events).at(-1), 'result:ok:success');
  });

  it('twice in a row is the same as once', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt('bash');
    await drain();
    await mustSettle(Promise.all([h.driver.interrupt(), h.driver.interrupt()]), 'double interrupt');
    assertWellFormed(h.events, 1, 'double interrupt');
  });

  it('leaves the prompts queued behind the stopped turn to run normally', async () => {
    const h = harness();
    h.driver.prompt('slow');
    h.driver.prompt('hello after');
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Grep'], 'the second prompt waits');
    await mustSettle(h.driver.interrupt(), 'interrupt');
    await drain();
    assertWellFormed(h.events, 2, 'interrupt then queued prompt');
    const results = h.events.filter((e) => e.k === 'result');
    assert.deepEqual(results.map((r) => r.subtype), ['interrupted', 'success']);
    assert.equal(results[1]!.text, 'You said: hello after');
  });

  it('called from inside the event callback still yields one terminal', async () => {
    // A consumer reacting to the first tool_start by stopping the turn: the re-entrant path.
    const h = harness({
      policy: 'manual',
      onEvent: (e, self) => { if (e.k === 'tool_start') void self.driver.interrupt(); },
    });
    h.driver.prompt('bash');
    await drain();
    assertWellFormed(h.events, 1, 're-entrant interrupt');
    assert.equal(shape(h.events).at(-1), 'result:fail:interrupted');
  });
});

// ---------------------------------------------------------------------------
describe('queued prompts', () => {
  it('wait behind the running turn: their events never interleave with it', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt('bash');
    h.driver.prompt('hello');
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Bash'], 'the second prompt has said nothing yet');
    h.requests[0]!.resolve({ allow: true });
    await drain();
    assert.deepEqual(shape(h.events), [
      'session', 'text', 'start:Bash', 'end:ok', 'result:ok:success',
      'text', 'result:ok:success',
    ]);
    assertWellFormed(h.events, 2, 'queued');
  });

  it('run in the order they were given', async () => {
    const h = harness();
    for (const word of ['alpha', 'bravo', 'charlie']) h.driver.prompt(word);
    await drain();
    const texts = h.events.filter((e) => e.k === 'result').map((e) => e.text);
    assert.deepEqual(texts, ['You said: alpha', 'You said: bravo', 'You said: charlie']);
  });

  it('a prompt sent from inside the terminal-event callback is queued, not run inside it', async () => {
    let sent = false;
    const h = harness({
      onEvent: (e, self) => {
        if (e.k === 'result' && !sent) {
          sent = true;
          const before = self.events.length;
          self.driver.prompt('second');
          assert.equal(self.events.length, before, 'nothing was emitted synchronously from prompt()');
        }
      },
    });
    h.driver.prompt('first');
    await drain();
    assertWellFormed(h.events, 2, 'prompt from callback');
    assert.equal(h.events.filter((e) => e.k === 'result').length, 2);
  });
});

// ---------------------------------------------------------------------------
describe('close', () => {
  it('mid-permission: aborts the request, emits nothing more (not even a terminal event), and resolves', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt('bash');
    await drain();
    const before = shape(h.events);
    assert.deepEqual(before, ['session', 'text', 'start:Bash']);
    await mustSettle(h.driver.close(), 'close');
    assert.ok(h.requests[0]!.req.signal.aborted, 'the pending request is told to stop');
    for (let i = 0; i < 5; i++) await drain();
    assert.deepEqual(shape(h.events), before, 'no tool_end, no result, no fatal after close');
  });

  it('is silent even if the handler answers afterwards', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt('bash');
    await drain();
    await mustSettle(h.driver.close(), 'close');
    h.requests[0]!.resolve({ allow: true });
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Bash']);
  });

  it('before the turn has started: nothing at all, not even the session event', async () => {
    const h = harness();
    h.driver.prompt('hello');
    await mustSettle(h.driver.close(), 'close');
    await drain();
    assert.deepEqual(h.events, []);
  });

  it('drops the prompts still in the queue, so a closed driver never asks anybody anything', async () => {
    // Queued turns are only visible from outside through the questions they would ask:
    // events are suppressed after close either way. So the queue holds turns that ask.
    const queued = (): Harness => {
      const h = harness({ policy: 'manual' });
      for (const p of ['bash', 'edit', 'bash']) h.driver.prompt(p);
      return h;
    };
    // The companion: left alone, the second turn does reach the handler once the first is answered.
    const open = queued();
    await drain();
    assert.equal(open.requests.length, 1);
    open.requests[0]!.resolve({ allow: true });
    await drain();
    assert.equal(open.requests.length, 2, 'a queued turn asks as soon as its turn comes');

    const closed = queued();
    await drain();
    await mustSettle(closed.driver.close(), 'close');
    for (let i = 0; i < 5; i++) await drain();
    assert.equal(closed.requests.length, 1, 'no further permission request after close');
    assert.deepEqual(shape(closed.events), ['session', 'text', 'start:Bash']);
  });

  it('stops a running tool too', async () => {
    const h = harness();
    h.driver.prompt('slow');
    await drain();
    await mustSettle(h.driver.close(), 'close');
    await drain();
    assert.deepEqual(shape(h.events), ['session', 'text', 'start:Grep']);
  });

  it('ignores a prompt given afterwards, without throwing, and does not ask anybody about it', async () => {
    const h = harness({ policy: 'manual' });
    await h.driver.close();
    assert.doesNotThrow(() => h.driver.prompt('bash'));
    await drain();
    assert.deepEqual(h.events, []);
    assert.equal(h.requests.length, 0, 'a tool permission was requested by a closed driver');
  });

  it('is idempotent, and interrupt afterwards is a no-op', async () => {
    const h = harness({ policy: 'manual' });
    h.driver.prompt('bash');
    await drain();
    await mustSettle(Promise.all([h.driver.close(), h.driver.close()]), 'double close');
    await mustSettle(h.driver.close(), 'third close');
    await mustSettle(h.driver.interrupt(), 'interrupt after close');
    assert.equal(shape(h.events).length, 3);
  });

  it('with no turn running just closes', async () => {
    const h = harness();
    await mustSettle(h.driver.close(), 'close');
    assert.deepEqual(h.events, []);
  });
});

// ---------------------------------------------------------------------------
describe('session id', () => {
  it('reports the id to resume, announces it on the first prompt, and keeps it', async () => {
    const h = harness({ resume: 'abc-123' });
    assert.equal(h.driver.sessionId(), 'abc-123');
    assert.deepEqual(h.events, [], 'announced on the first prompt, not at creation');
    h.driver.prompt('hello');
    await drain();
    assert.deepEqual(h.events[0], { k: 'session', id: 'abc-123' });
    assert.equal(h.driver.sessionId(), 'abc-123');
  });

  it('otherwise invents one, distinct per driver, and the event carries the same id', async () => {
    const a = harness();
    const b = harness();
    const ida = a.driver.sessionId();
    const idb = b.driver.sessionId();
    assert.match(ida ?? '', /^fake-\d+$/);
    assert.match(idb ?? '', /^fake-\d+$/);
    assert.notEqual(ida, idb);
    a.driver.prompt('hello');
    await drain();
    assert.deepEqual(a.events[0], { k: 'session', id: ida });
  });

  it('announces once per driver, not once per turn', async () => {
    const h = harness({ resume: 'sid' });
    h.driver.prompt('one');
    await drain();
    h.driver.prompt('two');
    h.driver.prompt('bash');
    await drain();
    assert.equal(h.events.filter((e) => e.k === 'session').length, 1);
  });

  it('treats an empty resume id as none', () => {
    const h = harness({ resume: '' });
    assert.match(h.driver.sessionId() ?? '', /^fake-\d+$/);
  });
});

// ---------------------------------------------------------------------------
describe('timing and the injected sleep', () => {
  it('prompt() returns before any event: progress arrives through onEvent, later', async () => {
    const h = harness();
    h.driver.prompt('hello');
    assert.deepEqual(h.events, [], 'nothing synchronous');
    await drain();
    assert.ok(h.events.length > 0);
  });

  it('never calls sleep when the delay is 0, which is the default', async () => {
    const calls: number[] = [];
    const h = harness({ sleep: (ms) => { calls.push(ms); return Promise.resolve(); } });
    h.driver.prompt('bash');
    await drain();
    assert.deepEqual(calls, []);
    assert.equal(h.events.length, 5);
  });

  it('treats a delay that is not a positive finite number as 0', async () => {
    for (const bad of [Number.NaN, -5, Infinity, -Infinity, 0]) {
      const calls: number[] = [];
      const h = harness({ delayMs: bad, sleep: (ms) => { calls.push(ms); return Promise.resolve(); } });
      h.driver.prompt('hello');
      await drain();
      assert.deepEqual(calls, [], String(bad));
      assertWellFormed(h.events, 1, String(bad));
    }
  });

  it('pauses between steps through the injected sleep, with the configured delay, and waits for it', async () => {
    const waiting: Array<() => void> = [];
    const calls: number[] = [];
    const h = harness({
      delayMs: 250,
      sleep: (ms) => { calls.push(ms); return new Promise<void>((resolve) => { waiting.push(resolve); }); },
    });
    h.driver.prompt('hello');
    await drain();
    assert.deepEqual(calls, [250]);
    assert.deepEqual(h.events, [], 'held by the first pause');
    let guardCount = 0;
    while (!h.events.some(isTerminal) && guardCount++ < 20) {
      waiting.shift()?.();
      await drain();
    }
    assert.ok(calls.length >= 2, 'more than one pause in a turn');
    assert.ok(calls.every((ms) => ms === 250));
    assertWellFormed(h.events, 1, 'paused turn');
  });

  it('is honoured through the factory', async () => {
    const calls: number[] = [];
    const factory = fakeDriverFactory({ delayMs: 9, sleep: (ms) => { calls.push(ms); return Promise.resolve(); } });
    const events: DriverEvent[] = [];
    const d = factory({ cwd: '/w', onEvent: (e) => events.push(e), onPermission: () => Promise.resolve({ allow: true }) });
    d.prompt('hello');
    await drain();
    assert.ok(calls.length > 0 && calls.every((ms) => ms === 9));
    assertWellFormed(events, 1, 'factory driver');
    assert.match(d.sessionId() ?? '', /^fake-\d+$/);
  });

  it('gives each factory call its own driver', () => {
    const factory = fakeDriverFactory();
    const o = { cwd: '/w', onEvent: () => {}, onPermission: () => Promise.resolve({ allow: true } as const) };
    assert.notEqual(factory(o).sessionId(), factory(o).sessionId());
  });
});

// ---------------------------------------------------------------------------
describe('what the scenarios say', () => {
  async function resultOf(prompt: string): Promise<{ ok: boolean; text: string; subtype: string }> {
    const h = harness();
    h.driver.prompt(prompt);
    await drain();
    const r = h.events.find((e) => e.k === 'result');
    assert.ok(r && r.k === 'result');
    return r;
  }

  it('echo repeats the prompt as given: sanitising is the server job, and the fake must not hide a missing one', async () => {
    const r = await resultOf('Hello THERE \u201cfriend\u201d');
    assert.equal(r.text, 'You said: Hello THERE \u201cfriend\u201d');
    assert.equal(r.ok, true);
  });

  it('unicode really has what the panel cannot draw, and the device path copes with it', async () => {
    const r = await resultOf('unicode');
    assert.match(r.text, /[\u201c\u201d]/, 'curly quotes');
    assert.match(r.text, /[\u00e0-\u00ff]/, 'accents');
    assert.match(r.text, /\p{Extended_Pictographic}/u, 'an emoji');
    assert.equal(isPrintableAscii(r.text), false, 'so a server that forgets to sanitise is caught');
    // The caller: text.ts, then the codec that would refuse anything it left behind.
    const summary = summarizeForDevice(r.text, LIMITS.resultMax);
    assert.ok(summary.length > 0 && isPrintableAscii(summary), JSON.stringify(summary));
    assert.doesNotThrow(() => encodeBridgeMsg({ t: 'result', ok: true, text: summary }));
  });

  it('long is long enough to need summarising, and has the markdown a summary must remove', async () => {
    const r = await resultOf('long');
    assert.ok(r.text.length > LIMITS.resultMax * 2, `${r.text.length} characters`);
    assert.match(r.text, /```/);
    assert.match(r.text, /https?:\/\//);
    assert.match(r.text, /^## /m);
    const summary = summarizeForDevice(r.text, LIMITS.resultMax);
    assert.ok(summary.length > 0 && summary.length <= LIMITS.resultMax);
    assert.doesNotMatch(summary, /```|https?:|^#|\*\*/);
    assert.match(summary, /[.!?]$/, 'whole sentences');
    assert.doesNotThrow(() => encodeBridgeMsg({ t: 'result', ok: true, text: summary }));
  });

  it('error is a failed result, not a fatal', async () => {
    const r = await resultOf('error');
    assert.deepEqual([r.ok, r.subtype], [false, 'error_during_execution']);
    assert.ok(r.text.length > 0);
  });

  it('fatal carries a message for the log', async () => {
    const h = harness();
    h.driver.prompt('fatal');
    await drain();
    const f = h.events.find((e) => e.k === 'fatal');
    assert.ok(f && f.k === 'fatal' && f.msg.length > 0);
    assert.equal(h.events.some((e) => e.k === 'result'), false, 'a fatal is the terminal event, not followed by a result');
  });

  it('a fatal does not stop the driver: the next prompt is still answered', async () => {
    const h = harness();
    h.driver.prompt('fatal');
    h.driver.prompt('hello');
    await drain();
    assertWellFormed(h.events, 2, 'fatal then echo');
    assert.equal(shape(h.events).at(-1), 'result:ok:success');
  });

  it('does not write the prompt to the log, which may hold anything the player said', async () => {
    const h = harness({ policy: 'deny' });
    h.driver.prompt('bash with a hunter2-secret in it');
    await drain();
    assert.ok(h.logs.length > 0, 'it does log the scenario');
    assert.ok(h.logs.every((l) => !l.includes('hunter2')), h.logs.join(' | '));
  });

  it('survives a prompt that is not a string', async () => {
    const h = harness();
    h.driver.prompt(undefined as unknown as string);
    h.driver.prompt(42 as unknown as string);
    await drain();
    assertWellFormed(h.events, 2, 'non-string prompts');
  });
});
