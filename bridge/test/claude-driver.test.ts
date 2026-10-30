/**
 * Driver tests against a scripted fake of the SDK's `query()`.
 *
 * What these establish is the driver's contract with the SDK as the typings describe it AND
 * as the real CLI was measured to behave: test/real-cli.integration.test.ts (opt-in,
 * BRIDGE_REAL_CLI=1) runs the same driver over the real bundled CLI against a fake Anthropic
 * API, and every claim about the CLI that this file relies on (hooks beat allow rules, an
 * interrupt ends in an `aborted_*` result, a stale resume id fails before any frame, the
 * results echo the prompt's uuid) is pinned there. This file cannot establish that the real
 * CLI keeps behaving that way; that is what the opt-in run is for.
 *
 * The fake records the options it was called with and what the driver pushed into the
 * input iterable, and lets a test play the CLI's side message by message, so an ordering
 * that matters (a result arriving after an interrupt, a stream dying mid-tool) is written
 * out rather than inferred. It stamps the frames it plays with the prompt's uuid the way the
 * real CLI does (test/support/fake-sdk.ts); a frame of a turn nobody asked for is pushed with
 * `{ stamp: false }`.
 *
 * Every "never" below has a companion that shows the mechanism it relies on engaging:
 * a guard that is vacuously true when nothing happens is not a guard.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput, Options, PermissionResult, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  buildChildEnv,
  checkManagedLock,
  CHILD_ENV_NAMES,
  CHILD_ENV_PREFIXES,
  claudeDriverFactory,
  DEFAULT_STALL_MS,
  PIN_COMMAND_KEYS,
  PIN_COMMAND_OBJECT_KEYS,
  PIN_CREDENTIAL_NAMES,
  PIN_ENDPOINT_NAMES,
  PIN_FEATURE_NAMES,
  PIN_HIJACK_NAMES,
  PIN_KEEP_OR_SKIP,
  PIN_NEUTRAL,
  PIN_PROVIDER_SELECTORS,
  PIN_PROXY_NAMES,
  pinnedSettings,
  REDACTED,
  redactSecrets,
  STALLED_TEXT,
} from '../src/drivers/claude.ts';
import type { ClaudeDriverConfig, ManagedLockStatus } from '../src/drivers/claude.ts';
import { describeTool, UNSERVED_TOOL_NAMES } from '../src/tools.ts';
import { summarizeForDevice } from '../src/text.ts';
import { LIMITS } from '../src/types.ts';
import { composeSystemAppend, MEMORY_BEGIN, MEMORY_END, MEMORY_HEADING, VOICE_RULES } from '../src/voice-prompt.ts';
import type { DriverEvent, PermissionHandler, PermissionRequest, SessionDriver } from '../src/types.ts';
import {
  FakeClock,
  apiRetry,
  assistantText,
  blockStop,
  cliToolCall,
  fakeSdk,
  init,
  resultAborted,
  resultErr,
  resultOk,
  settle,
  toolResult,
  toolStart,
  SID,
} from './support/fake-sdk.ts';
import type { FakeQuery } from './support/fake-sdk.ts';
import { settingsKeys, settingsTypeErrors } from './support/sdk-settings-type.ts';
import { REAL_CLI_VERIFIED_SDK } from './support/sdk-version.ts';

const KEY = 'sk-ant-test-0123456789abcdef';
const CWD = '/work/proj';

// One scratch directory for every driver's pinned-settings file in this file.
const SCRATCH = mkdtempSync(join(tmpdir(), 'claude-driver-test-'));
after(() => rmSync(SCRATCH, { recursive: true, force: true }));

/** A parent environment with secrets in it, so every test that builds a child env is a leak test. */
const PARENT_ENV: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/tester',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'C',
  XDG_CONFIG_HOME: '/home/tester/.config',
  HTTPS_PROXY: 'http://proxy.example:3128',
  no_proxy: 'localhost',
  BRIDGE_TOKEN: 'bridge-token-must-not-leak-0123',
  AWS_SECRET_ACCESS_KEY: 'aws-secret-must-not-leak',
  GITHUB_TOKEN: 'gh-secret-must-not-leak',
  ANTHROPIC_API_KEY: 'sk-ant-from-the-shell-should-lose',
  ANTHROPIC_AUTH_TOKEN: 'extra-bearer-must-not-leak',
  ANTHROPIC_BASE_URL: 'https://gateway.example',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_REMOTE: 'true',
  MY_OPT_IN: 'operator-asked-for-this',
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface HarnessOpts {
  cfg?: Partial<ClaudeDriverConfig>;
  resume?: string;
  onPermission?: PermissionHandler;
  onEvent?: (e: DriverEvent) => void;
  interruptGraceMs?: number;
  /** Make query() throw for the first N calls. */
  queryThrows?: { times: number; error: unknown };
  env?: NodeJS.ProcessEnv;
  /** What the lock check answers; defaults to "in force" so no test reaches for the machine's real policy tier. */
  lock?: ManagedLockStatus | undefined | 'throws';
  /** Records each time the lock is asked about. */
  lockAsked?: string[];
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
  const requests: PermissionRequest[] = [];
  const clock = new FakeClock();
  const sdkFake = fakeSdk(over.queryThrows === undefined ? {} : { throwTimes: over.queryThrows.times, error: over.queryThrows.error });
  const queries = sdkFake.queries;
  const cfg: ClaudeDriverConfig = { apiKey: KEY, ...over.cfg };
  const driver = claudeDriverFactory(cfg, {
    query: sdkFake.query,
    clock,
    interruptGraceMs: over.interruptGraceMs ?? 5000,
    env: over.env ?? PARENT_ENV,
    settingsDir: SCRATCH,
    checkManagedLock: (cwd) => {
      over.lockAsked?.push(cwd);
      if (over.lock === 'throws') return Promise.reject(new Error('resolver moved'));
      return Promise.resolve('lock' in over ? over.lock : { effective: true, missing: [], displacedBy: [] });
    },
  })({
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
  assert.deepEqual(o.settingSources, [], 'the default loads no repository or user configuration at all');
  assert.equal(o.cwd, CWD);
  // `snapshot: false`: a recorded prompt would keep an edited CLAUDE.md out of a resumed session (measured).
  assert.deepEqual(o.systemPrompt, { type: 'preset', preset: 'claude_code', append: VOICE_RULES, snapshot: false });
  assert.deepEqual(o.skills, [], 'no skills: their inline shell commands run without a question');
  assert.equal(typeof o.canUseTool, 'function');
  assert.ok(o.abortController instanceof AbortController);
  assert.equal(o.env?.ANTHROPIC_API_KEY, KEY);
  // The things that must be ABSENT. `in`, not `=== undefined`: a key set to undefined is
  // still a key somebody can later fill in.
  assert.ok(!('allowedTools' in o), 'an auto-allow list would let calls skip canUseTool');
  assert.ok(!('allowDangerouslySkipPermissions' in o));
  assert.ok(!('resume' in o), 'nothing to resume yet');
  assert.ok(!('model' in o) && !('maxTurns' in o) && !('pathToClaudeCodeExecutable' in o));
});

test('a repository cannot grant itself permissions: the policy tier locks rules and hooks, and the hook is always there', async () => {
  const h = harness();
  await begin(h);
  const o = h.options();
  // Without the lock a `.claude/settings.local.json` allow rule ran Bash and Write with
  // canUseTool never called (measured against the real CLI).
  assert.deepEqual(o.managedSettings, { allowManagedPermissionRulesOnly: true, allowManagedHooksOnly: true });
  const entries = o.hooks?.PreToolUse;
  assert.ok(entries !== undefined && entries.length === 1, 'the PreToolUse hook is registered even with no rule configured');
  // An MCP server in the repository would start at once with no question asked.
  assert.equal(o.strictMcpConfig, true);
  // Typed or dictated words are never a CLI command or a file mention.
  assert.equal(o.verbatimPrompts, true);
  assert.deepEqual(o.disallowedTools, [...UNSERVED_TOOL_NAMES]);
  assert.ok(o.disallowedTools!.length > 0);
});

test('every tool the driver removes from the model is also refused by the bridge\'s own rules', () => {
  // One list (src/tools.ts), two consumers (the driver stops OFFERING these, the describer
  // REFUSES a call to them), so a name cannot drift out of one and stay in the other.
  for (const name of UNSERVED_TOOL_NAMES) {
    const view = describeTool(name, {}, CWD);
    assert.ok(view.deny !== undefined, `${name} is removed from the model but describeTool would ask the device about it`);
  }
  // Companion: the check can fail, because an ordinary tool is not refused.
  assert.equal(describeTool('Read', { file_path: `${CWD}/a.txt` }, CWD).deny, undefined);
});

test('the pinned settings file holds the endpoint, the proxies and an empty key helper, and is private', async () => {
  const h = harness({ env: { PATH: '/bin', HOME: '/h', HTTPS_PROXY: 'http://user:proxy-pass@proxy.example:3128', ANTHROPIC_BASE_URL: 'https://gateway.example' } , cfg: { passEnv: ['ANTHROPIC_BASE_URL'], settingSources: ['project', 'local'] } });
  await begin(h);
  const path = h.options().settings;
  assert.equal(typeof path, 'string', 'a path, not an inline object: inline settings show up in `ps`');
  const text = readFileSync(path as string, 'utf8');
  const pinned = JSON.parse(text) as { env: Record<string, string>; apiKeyHelper: string };
  assert.deepEqual(pinned, JSON.parse(JSON.stringify(pinnedSettings(h.options().env as Record<string, string>))), 'the file is exactly what the pin function says');
  assert.equal(pinned.env.ANTHROPIC_BASE_URL, 'https://gateway.example');
  assert.equal(pinned.env.HTTPS_PROXY, 'http://user:proxy-pass@proxy.example:3128');
  assert.equal(pinned.env.HTTP_PROXY, '', 'a proxy the operator did not set is pinned to none, not left to the repository');
  assert.equal(pinned.apiKeyHelper, '');
  assert.equal(statSync(path as string).mode & 0o077, 0, 'the file may hold a proxy password: owner only');
  // The command line carries only the path; the password must not be in anything the SDK serialises into argv.
  const { settings, managedSettings, ...rest } = h.options();
  void settings;
  assert.ok(!JSON.stringify([managedSettings, rest.systemPrompt, rest.disallowedTools]).includes('proxy-pass'));
});

test('the pinned file is written only when a settings source is loaded: with none there is nothing for it to outrank', async () => {
  const none = harness();
  await begin(none);
  assert.ok(!('settings' in none.options()), 'no `settings` option by default');
  await none.driver.close();
  // Nothing was written: the scratch directory holds no pinned file for this driver.
  // Companion: every source, alone, gets one, so the absence above is about the empty list and not a broken writer.
  for (const source of ['project', 'local', 'user'] as const) {
    const h = harness({ cfg: { settingSources: [source] } });
    await begin(h);
    const path = h.options().settings;
    assert.equal(typeof path, 'string', source);
    assert.ok(existsSync(path as string), source);
    assert.deepEqual(JSON.parse(readFileSync(path as string, 'utf8')), JSON.parse(JSON.stringify(pinnedSettings(h.options().env as Record<string, string>))));
  }
});

test('without an operator endpoint the pin is the public API, and the pin function is what decides', () => {
  assert.equal(pinnedSettings({}).env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
  assert.equal(pinnedSettings({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' }).env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy']) {
    assert.equal(pinnedSettings({}).env[k], '', k);
    assert.equal(pinnedSettings({ [k]: 'http://p' }).env[k], 'http://p', k);
  }
});

test('close removes the pinned settings file the driver wrote', async () => {
  const h = harness({ cfg: { settingSources: ['project'] } });
  await begin(h);
  const path = h.options().settings as string;
  assert.ok(existsSync(path));
  await h.driver.close();
  assert.ok(!existsSync(path), 'a settings file with a proxy password must not outlive the driver');
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

test('the child gets an allowlist of the parent environment, never BRIDGE_TOKEN or other secrets', async () => {
  const h = harness();
  await begin(h);
  const env = h.options().env!;
  // Carried over by hand, because the SDK REPLACES the child's environment when `env` is set.
  assert.equal(env.PATH, PARENT_ENV.PATH);
  assert.equal(env.HOME, PARENT_ENV.HOME);
  assert.equal(env.LANG, PARENT_ENV.LANG);
  assert.equal(env.LC_ALL, 'C', 'locale families are passed whole');
  assert.equal(env.XDG_CONFIG_HOME, PARENT_ENV.XDG_CONFIG_HOME);
  assert.equal(env.HTTPS_PROXY, PARENT_ENV.HTTPS_PROXY);
  assert.equal(env.no_proxy, 'localhost', 'proxy names in both cases');
  assert.equal(env.ANTHROPIC_API_KEY, KEY, 'the configured key wins over the shell\'s');
  // The model's tool subprocesses run as this user: anything in here is theirs.
  for (const secret of ['BRIDGE_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'GITHUB_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_REMOTE', 'MY_OPT_IN']) {
    assert.ok(!(secret in env), `${secret} must not reach the child`);
  }
  assert.ok(!('ANTHROPIC_BASE_URL' in env), 'an endpoint is the operator\'s to name, not inherited from the shell');
  assert.ok(!JSON.stringify(env).includes('must-not-leak'));
  // Companion: the filter is what removes them, not an environment that never had them.
  assert.equal(PARENT_ENV.BRIDGE_TOKEN, 'bridge-token-must-not-leak-0123');
});

test('background work is switched off in the child, and no passEnv entry can undo that or the key', () => {
  const { env, refused } = buildChildEnv(
    { ...PARENT_ENV, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' },
    KEY,
    ['MY_OPT_IN', 'BRIDGE_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'not a name', 'ABSENT_VAR'],
  );
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.MY_OPT_IN, 'operator-asked-for-this', 'a name the operator opted into is passed');
  assert.ok(!('BRIDGE_TOKEN' in env), 'even a named BRIDGE_TOKEN is not passed: it would let the model impersonate the device');
  assert.ok(!('ABSENT_VAR' in env), 'a name that is not set is simply absent');
  assert.deepEqual(refused, ['BRIDGE_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'not a name']);
});

test('the allowlist is exactly what the design says, so a change to it is a decision', () => {
  assert.deepEqual([...CHILD_ENV_NAMES].sort(), [
    'ALL_PROXY', 'CLAUDE_CONFIG_DIR', 'HOME', 'HTTPS_PROXY', 'HTTP_PROXY', 'LANG', 'LOGNAME', 'NODE_EXTRA_CA_CERTS',
    'NO_PROXY', 'PATH', 'SHELL', 'SSL_CERT_FILE', 'TERM', 'TMPDIR', 'TZ', 'USER',
    'all_proxy', 'http_proxy', 'https_proxy', 'no_proxy',
  ].sort());
  assert.ok(![...CHILD_ENV_NAMES].some((n) => /TOKEN|KEY|SECRET|PASSWORD|BRIDGE/i.test(n)), 'no credential name belongs on the allowlist');
});

test('the key is trimmed before it reaches the child, and scrubbed from logs in both spellings', async () => {
  const h = harness({ cfg: { apiKey: `  ${KEY}\n` } });
  await begin(h);
  assert.equal(h.options().env!.ANTHROPIC_API_KEY, KEY);
  h.options().stderr!(`using ${KEY} and ${'  ' + KEY + '\n'} again`);
  assert.ok(!h.logs.join('\n').includes(KEY));
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
  const { uuid, ...rest } = q.received[0]!;
  assert.deepEqual(rest, {
    type: 'user',
    message: { role: 'user', content: 'read the readme' },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
  });
  assert.match(uuid ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'every prompt carries a uuid the CLI echoes back');
});

test('each prompt gets its own uuid', async () => {
  const h = harness();
  const q = await begin(h, 'one');
  q.push(resultOk('1'));
  await settle();
  h.driver.prompt('two');
  await settle();
  const [a, b] = q.received.map((m) => m.uuid);
  assert.ok(a !== undefined && b !== undefined && a !== b);
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

type HookOut = { hookSpecificOutput?: { hookEventName: string; permissionDecision: string; permissionDecisionReason: string } };

test('a call the bridge rates low gets no opinion from the hook, never an allow', async () => {
  const hook = await hookOf({ hardDeny: (tool) => (tool === 'Bash' ? 'no' : undefined), needsAsk: (tool) => tool !== 'Read' });
  const out = await hook.run(preToolUse('Read', { file_path: '/a' }));
  assert.deepEqual(out, {});
  // An explicit allow from a hook skips the approval flow, which is the whole point of
  // never returning one. Companion to the deny test above: same hook, opposite input.
  assert.notEqual((await hook.run(preToolUse('Bash', {}))) as object, out);
  for (const tool of ['Read', 'Bash', 'Write', 'mcp__x__y']) {
    const o = (await hook.run(preToolUse(tool, {}))) as HookOut;
    assert.notEqual(o.hookSpecificOutput?.permissionDecision, 'allow', tool);
  }
});

test('a call that needs a tap is forced to ask, which beats an allow rule and the CLI\'s own auto-allow', async () => {
  const seen: [string, Record<string, unknown>][] = [];
  const hook = await hookOf({ needsAsk: (tool, input) => { seen.push([tool, input]); return true; } });
  const out = (await hook.run(preToolUse('Write', { file_path: '/a', content: 'x' }))) as HookOut;
  assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask');
  assert.ok((out.hookSpecificOutput?.permissionDecisionReason ?? '').length > 0);
  assert.deepEqual(seen, [['Write', { file_path: '/a', content: 'x' }]]);
});

test('with no needsAsk configured every call asks: nothing is left to the CLI by default', async () => {
  const hook = await hookOf({});
  for (const tool of ['Read', 'Bash', 'Glob', 'WebFetch']) {
    const out = (await hook.run(preToolUse(tool, {}))) as HookOut;
    assert.equal(out.hookSpecificOutput?.permissionDecision, 'ask', tool);
  }
});

test('only an explicit false from needsAsk leaves a call to the CLI; anything else, including a throw, asks', async () => {
  const cases: [string, () => unknown, string | undefined][] = [
    ['false', () => false, undefined],
    ['true', () => true, 'ask'],
    ['undefined', () => undefined, 'ask'],
    ['0', () => 0, 'ask'],
    ['an empty string', () => '', 'ask'],
    ['null', () => null, 'ask'],
    ['a throw', () => { throw new Error('rule bug'); }, 'ask'],
  ];
  for (const [name, fn, expected] of cases) {
    const hook = await hookOf({ needsAsk: fn as never });
    const out = (await hook.run(preToolUse('Read', { file_path: '/a' }))) as HookOut;
    assert.equal(out.hookSpecificOutput?.permissionDecision, expected, name);
  }
});

test('a hard-denied call is refused before needsAsk is even consulted', async () => {
  let asked = 0;
  const hook = await hookOf({ hardDeny: () => 'never', needsAsk: () => { asked++; return true; } });
  const out = (await hook.run(preToolUse('Bash', { command: 'rm -rf /' }))) as HookOut;
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
  assert.equal(asked, 0, 'a call that is refused outright must never reach the device, so it is not even classified');
});

test('through the CLI\'s own pipeline: hard-deny never asks, a tap-worthy call asks even when the CLI would auto-allow, a low call does not', async () => {
  const h = harness({
    cfg: {
      hardDeny: (tool) => (tool === 'Bash' ? 'refused by rule' : undefined),
      needsAsk: (tool) => tool !== 'Read',
    },
  });
  await begin(h);
  const o = h.options();

  const denied = await cliToolCall(o, 'Bash', { command: 'rm -rf /' }, { autoAllow: true });
  assert.deepEqual([denied.decision, denied.via, denied.message], ['deny', 'hook', 'refused by rule']);
  assert.equal(h.requests.length, 0, 'the device never sees a hard-denied call');

  // The CLI's auto-allow (a write that a local allow rule permits, `ls`) would have let this run.
  const asked = await cliToolCall(o, 'Write', { file_path: '/a', content: 'x' }, { autoAllow: true });
  assert.deepEqual([asked.decision, asked.via], ['allow', 'canUseTool']);
  assert.equal(h.requests.length, 1, 'the tap-worthy call reached the device even though the CLI would have run it');

  // A built-in read inside the working directory: the CLI's own rule applies and nobody is asked.
  const low = await cliToolCall(o, 'Read', { file_path: `${CWD}/a.txt` }, { autoAllow: true });
  assert.deepEqual([low.decision, low.via], ['allow', 'cli-auto-allow']);
  assert.equal(h.requests.length, 1, 'a low call is the only kind that runs without the device');
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

test('an error result is one failed terminal carrying the CLI\'s own sentence', async () => {
  const h = harness();
  const q = await begin(h);
  q.push(init());
  q.push(toolStart('t1'));
  q.push(blockStop());
  q.push(resultErr('error_max_turns', { errors: ['Reached maximum number of turns (1)'] }));
  await settle();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'result', ok: false, text: 'Reached maximum number of turns (1)', subtype: 'error_max_turns' },
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
  assert.match(msg, /^Claude failed: 401 invalid x-api-key/);
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
  assert.match(h.logs[0]!, /^claude stderr: warn: using \[redacted\]/);
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
  // What the real CLI sends for an interrupt (measured): an error result with an aborted reason.
  q.push(resultAborted('aborted_tools'));
  await done;
  await settle();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'result', ok: false, text: '', subtype: 'interrupted' },
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
  // A turn the CLI started on its own: nothing in it echoes a prompt of ours.
  q.push(toolStart('bg1'), { stamp: false });
  q.push(assistantText('a background task woke me'), { stamp: false });
  q.push(resultOk('a turn nobody asked for'), { stamp: false });
  await settle();
  assert.equal(h.events.length, before);
  assert.ok(h.logs.some((l) => l.includes('not the answer to the prompt in flight') || l.includes('no turn in flight')));
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
  assert.match((t[0] as { msg: string }).msg, /^Claude did not start: spawn failed for \[redacted\]$/);
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
// A saved session that cannot be resumed (H6, D6)
// ---------------------------------------------------------------------------

/** What the real CLI sends for a resume id with no transcript: no frames, no stamp, nothing ran (measured). */
const staleResult = (id = 'dead-session'): ReturnType<typeof resultErr> =>
  resultErr('error_during_execution', {
    errors: [`No conversation found with session ID: ${id}`],
    num_turns: 0,
    duration_ms: 0,
    session_id: id,
  });

test('a stale resume id is forgotten and the prompt runs once more on a fresh session, silently', async () => {
  const h = harness({ resume: 'dead-session' });
  assert.equal(h.driver.sessionId(), 'dead-session');
  const q1 = await begin(h, 'what is in the readme');
  assert.equal(h.options(0).resume, 'dead-session', 'the first attempt really did try to resume');
  q1.push(staleResult(), { stamp: false });
  await settle();

  assert.deepEqual(terminals(h.events), [], 'the first attempt never ran, so it owes nobody a terminal');
  assert.equal(q1.closes, 1, 'the dead query is released');
  assert.equal(h.queries.length, 2, 'a fresh query was started');
  assert.ok(!('resume' in h.options(1)), 'the fresh query does not try the dead id again');
  assert.equal(h.driver.sessionId(), undefined, 'the dead id is no longer ours');
  const q2 = h.queries[1]!;
  assert.deepEqual(q2.received.map((m) => m.message.content), ['what is in the readme'], 'the SAME prompt, once');
  assert.notEqual(q2.received[0]!.uuid, q1.received[0]!.uuid, 'a new uuid: the old one belongs to the discarded query');

  q2.push(init('brand-new'));
  q2.push(assistantText('It says hello.'));
  q2.push(resultOk('It says hello.'));
  await settle();
  assert.deepEqual(h.events, [
    { k: 'session', id: 'brand-new' },
    { k: 'text', text: 'It says hello.' },
    { k: 'result', ok: true, text: 'It says hello.', subtype: 'success' },
  ], 'the new id is reported so the server stores it in place of the dead one');
  assert.equal(h.driver.sessionId(), 'brand-new');
  assertOneTerminalEach(h.events, 1);
  assert.ok(h.logs.some((l) => l.includes('could not be resumed')));
});

test('after a recovery the next query resumes the NEW session, not the dead one', async () => {
  const h = harness({ resume: 'dead-session' });
  const q1 = await begin(h, 'first');
  q1.push(staleResult(), { stamp: false });
  await settle();
  const q2 = h.queries[1]!;
  q2.push(init('brand-new'));
  q2.push(resultOk('one'));
  await settle();
  q2.end(); // the CLI goes away between turns
  await settle();
  await begin(h, 'second');
  assert.equal(h.options(2).resume, 'brand-new');
});

test('the retry happens once: a second failure is an ordinary failed turn, not a loop', async () => {
  const h = harness({ resume: 'dead-session' });
  const q1 = await begin(h, 'first');
  q1.push(staleResult(), { stamp: false });
  await settle();
  const q2 = h.queries[1]!;
  // The fresh query fails with the same words (it has no resume id, so this is not a stale
  // resume any more, whatever the text says).
  q2.push(staleResult('whatever'), { stamp: false });
  await settle();
  assert.equal(h.queries.length, 2, 'no third query');
  assertOneTerminalEach(h.events, 1);
  const t = terminals(h.events)[0]!;
  assert.equal(t.k, 'result');
  assert.equal((t as { ok: boolean }).ok, false);
});

test('the same recovery when the CLI fails the stream instead of sending a result', async () => {
  const h = harness({ resume: 'dead-session' });
  const q1 = await begin(h, 'first');
  q1.fail(new Error('Claude Code returned an error result: No conversation found with session ID: dead-session'));
  await settle();
  assert.deepEqual(terminals(h.events), []);
  assert.equal(h.queries.length, 2);
  h.queries[1]!.push(resultOk('fine'));
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.deepEqual(terminals(h.events), [{ k: 'result', ok: true, text: 'fine', subtype: 'success' }]);
});

test('a missing transcript in the MIDDLE of a session is not retried: the session was found at the start', async () => {
  const h = harness({ resume: 'live-session' });
  const q = await begin(h, 'first');
  q.push(init('live-session'));
  q.push(staleResult('live-session'), { stamp: false });
  await settle();
  assert.equal(h.queries.length, 1, 'no retry');
  assertOneTerminalEach(h.events, 1);
});

test('"no conversation found" on a query that was not resuming anything is not a retry trigger', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(staleResult(), { stamp: false });
  await settle();
  assert.equal(h.queries.length, 1);
  assertOneTerminalEach(h.events, 1);
});

// ---------------------------------------------------------------------------
// A turn nobody asked for is never the answer (M18, D7)
// ---------------------------------------------------------------------------

test('a notification turn that finishes while a prompt waits is not reported as that prompt\'s answer', async () => {
  const h = harness();
  const q = await begin(h, 'what is the status');
  // The CLI was still running a turn of its own (a finished background job): unstamped frames.
  q.push(assistantText('NOTIFICATION-TURN: the job finished.'), { stamp: false });
  q.push(resultOk('NOTIFICATION-TURN: the job finished.'), { stamp: false });
  await settle();
  assert.deepEqual(terminals(h.events), [], 'the notification turn\'s result must not end the user\'s turn');
  assert.ok(!JSON.stringify(h.events).includes('NOTIFICATION'), 'nor may its narration reach the pet');
  // Companion: the user's own turn, stamped, is then reported normally.
  q.push(assistantText('All green.'));
  q.push(resultOk('All green.'));
  await settle();
  assert.deepEqual(terminals(h.events), [{ k: 'result', ok: true, text: 'All green.', subtype: 'success' }]);
});

test('a result that echoes another prompt\'s uuid is not ours, a list containing ours is', async () => {
  const h = harness();
  const q = await begin(h, 'one');
  q.push(resultOk('for someone else'), { stampWith: '11111111-1111-4111-8111-111111111111' });
  await settle();
  assert.deepEqual(terminals(h.events), []);
  assert.ok(h.logs.some((l) => l.includes('not the answer to the prompt in flight')));
  const mine = q.lastPromptUuid!;
  q.push({ ...resultOk('folded'), user_message_uuid: 'x', user_message_uuids: ['11111111-1111-4111-8111-111111111111', mine] } as never, { stamp: false });
  await settle();
  assert.deepEqual(terminals(h.events), [{ k: 'result', ok: true, text: 'folded', subtype: 'success' }]);
});

test('a late duplicate of the previous turn\'s result does not end the next turn', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  const firstUuid = q.lastPromptUuid!;
  q.push(resultOk('one'));
  await settle();
  h.driver.prompt('second');
  await settle();
  q.push(resultOk('one again'), { stampWith: firstUuid });
  await settle();
  assertOneTerminalEach(h.events, 1);
  q.push(resultOk('two'));
  await settle();
  assertOneTerminalEach(h.events, 2);
  assert.deepEqual(terminals(h.events).map((e) => (e as { text: string }).text), ['one', 'two']);
});

test('a frame of a turn nobody asked for is dropped even while a prompt is in flight', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(toolStart('bg1'), { stamp: false });
  q.push(assistantText('narration of the background turn'), { stamp: false });
  await settle();
  assert.equal(h.events.length, 0, 'no tool_start and no text from a turn that is not ours');
  // Companion: the same frames, stamped, are the turn's own.
  q.push(toolStart('t1'));
  q.push(assistantText('narration of my turn'));
  await settle();
  assert.deepEqual(h.events.map((e) => e.k), ['tool_start', 'text']);
});

test('a zeroed error for a turn that never ran ends the prompt, whatever it says', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(resultErr('error_during_execution', { errors: ['Claude Code requires a newer Node'], num_turns: 0 }), { stamp: false });
  await settle();
  assert.deepEqual(terminals(h.events), [
    { k: 'result', ok: false, text: 'Claude Code requires a newer Node', subtype: 'error_during_execution' },
  ]);
});

// ---------------------------------------------------------------------------
// A stop is "Stopped.", not an error (M19)
// ---------------------------------------------------------------------------

test('a deny with interrupt:true ends the turn as interrupted, not as a failure', async () => {
  const h = harness({ onPermission: () => Promise.resolve({ allow: false, message: 'stop', interrupt: true }) });
  const q = await begin(h, 'delete things');
  q.push(init());
  q.push(toolStart('t1'));
  q.push(blockStop());
  const r = await h.ask('Bash', { command: 'rm x' });
  assert.deepEqual(r, { behavior: 'deny', message: 'stop', interrupt: true });
  q.push(resultAborted('aborted_tools'));
  await settle();
  assert.deepEqual(h.events.slice(-2), [
    { k: 'tool_end', id: 't1', ok: false },
    { k: 'result', ok: false, text: '', subtype: 'interrupted' },
  ]);
});

test('an interrupt in mid-stream is reported as interrupted too', async () => {
  const h = harness();
  const q = await begin(h, 'talk for a while');
  const done = h.driver.interrupt();
  q.push(resultAborted('aborted_streaming'));
  await done;
  await settle();
  assert.deepEqual(terminals(h.events), [{ k: 'result', ok: false, text: '', subtype: 'interrupted' }]);
});

// ---------------------------------------------------------------------------
// A rejected key does not stall the pet (M20, D8)
// ---------------------------------------------------------------------------

test('an API error that retrying cannot fix ends the turn at once with a short sentence', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  q.push(init());
  q.push(apiRetry('authentication_failed', 401, 1, 10));
  await settle();
  const t = terminals(h.events);
  assert.equal(t.length, 1, 'one terminal, right away, not after the CLI\'s backoff');
  assert.equal(t[0]!.k, 'result');
  const r = t[0] as Extract<DriverEvent, { k: 'result' }>;
  assert.equal(r.ok, false);
  assert.equal(r.subtype, 'api_error');
  assert.match(r.text, /^Claude API error 401: the API key was rejected\./);
  assert.match(r.text, /^[\x20-\x7e]*$/);
  assert.equal(q.closes, 1, 'the query that is stuck in backoff is discarded');
  // Companion: the next prompt is not poisoned by it.
  const q2 = await begin(h, 'again');
  q2.push(resultOk('ok'));
  await settle();
  assertOneTerminalEach(h.events, 2);
});

test('every error code the CLI cannot recover from ends the turn; the transient ones are only logged', async () => {
  const fatal = ['authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'verification_required', 'billing_error', 'invalid_request', 'model_not_found', 'cloud_credential_error'];
  for (const code of fatal) {
    const h = harness();
    const q = await begin(h, 'hello');
    q.push(apiRetry(code, 400));
    await settle();
    assert.equal(terminals(h.events).length, 1, code);
  }
  for (const code of ['rate_limit', 'overloaded', 'server_error', 'unknown', 'max_output_tokens']) {
    const h = harness();
    const q = await begin(h, 'hello');
    q.push(apiRetry(code, 529, 2, 10));
    await settle();
    assert.equal(terminals(h.events).length, 0, `${code} may well succeed on the next attempt`);
    assert.ok(h.logs.some((l) => l.includes('api retry 2/10') && l.includes(code)));
    q.push(resultOk('made it'));
    await settle();
    assertOneTerminalEach(h.events, 1);
  }
});

test('a retry notice with no prompt in flight changes nothing', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(resultOk('done'));
  await settle();
  q.push(apiRetry('authentication_failed', 401));
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.equal(q.closes, 0, 'an idle session is not torn down by a notice');
});

// ---------------------------------------------------------------------------
// Permission requests need a prompt behind them
// ---------------------------------------------------------------------------

test('a permission request with no prompt in flight is refused without asking the device', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.push(resultOk('done'));
  await settle();
  const r = await h.ask('Bash', { command: 'touch x' });
  assert.equal(r.behavior, 'deny');
  assert.equal(h.requests.length, 0, 'the device is idle and must not be shown a question');
  // Companion: with a prompt in flight the same request reaches the handler.
  h.driver.prompt('second');
  await settle();
  assert.equal((await h.ask('Bash', { command: 'touch x' })).behavior, 'allow');
  assert.equal(h.requests.length, 1);
});

// ---------------------------------------------------------------------------
// What the server is allowed to see
// ---------------------------------------------------------------------------

test('only the bridge\'s own event vocabulary ever leaves the driver', async () => {
  const h = harness({ resume: 'dead-session' });
  const q1 = await begin(h, 'one');
  q1.push(staleResult(), { stamp: false });
  await settle();
  const q2 = h.queries[1]!;
  q2.push(apiRetry('overloaded', 529));
  q2.push(resultOk('foreign'), { stamp: false });
  q2.push(init('s2'));
  q2.push(toolStart('t1'));
  q2.push(blockStop());
  q2.push(toolResult('t1'));
  q2.push(resultOk('fine'));
  await settle();
  const allowed = new Set(['session', 'tool_start', 'tool_end', 'text', 'result', 'fatal']);
  assert.ok(h.events.length > 0);
  for (const e of h.events) assert.ok(allowed.has(e.k), `${e.k} is the adapter's private signal and must not reach the server`);
});

test('a listener that sends the next prompt from inside the terminal event gets it delivered in order', async () => {
  const seen: string[] = [];
  const h = harness({
    onEvent: (e) => {
      if (e.k === 'result') {
        seen.push(e.text);
        if (e.text === 'one') h.driver.prompt('follow up');
      }
    },
  });
  const q = await begin(h, 'first');
  q.push(resultOk('one'));
  await settle();
  assert.deepEqual(q.received.map((m) => m.message.content), ['first', 'follow up']);
  q.push(resultOk('two'));
  await settle();
  assert.deepEqual(seen, ['one', 'two']);
  assertOneTerminalEach(h.events, 2);
});

test('the turn is over before anyone is told: a handler that interrupts from the terminal event interrupts nothing', async () => {
  // The server aborts and cleans up from inside its handler for the terminal event. If the
  // driver still counted the turn as running at that moment, the interrupt would go to a
  // CLI with nothing to interrupt and arm a grace timer that later reports a bogus failure.
  let q!: FakeQuery;
  const h = harness({
    onEvent: (e) => {
      if (e.k === 'result') void h.driver.interrupt();
    },
  });
  q = await begin(h, 'first');
  q.push(resultOk('done'));
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.equal(q.interrupts, 0, 'nothing was in flight, so nothing is interrupted');
  assert.equal(h.clock.armed, 0, 'and no grace timer is left to fire a fatal later');
  h.clock.advance(60_000);
  assertOneTerminalEach(h.events, 1);
});

test('fatal text puts what a person can act on first and is not prefixed twice', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.fail(new Error('Claude Code native binary not found at /opt/claude. Please ensure Claude Code is installed.'));
  await settle();
  const msg = (terminals(h.events)[0] as { msg: string }).msg;
  assert.ok(msg.startsWith('Claude Code native binary not found at /opt/claude'), msg);
  assert.ok(msg.slice(0, 64).includes('/opt/claude'), 'the wire keeps 64 characters: the path must be inside them');
  const h2 = harness();
  const q2 = await begin(h2, 'first');
  q2.fail(new Error('socket hang up'));
  await settle();
  assert.equal((terminals(h2.events)[0] as { msg: string }).msg, 'Claude failed: socket hang up');
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
  // The SDK's own sentence comes first (the wire carries 64 characters of it), without a prefix in front.
  assert.match((ev as { msg: string }).msg, /^Claude Code native binary not found at \/nonexistent\/claude-binary/i);
  assert.ok(!JSON.stringify([events, logs]).includes(KEY));
});

// ---------------------------------------------------------------------------
// The pins: derived from their lists and from the SDK's own Settings type
// ---------------------------------------------------------------------------

/** Every env name the pin function is responsible for, from the lists themselves. */
const PINNED_ENV_GROUPS: Record<string, readonly string[]> = {
  proxies: PIN_PROXY_NAMES,
  'provider selectors': PIN_PROVIDER_SELECTORS,
  endpoints: PIN_ENDPOINT_NAMES,
  credentials: PIN_CREDENTIAL_NAMES,
  'feature switches': PIN_FEATURE_NAMES,
  'program-lookup hijackers': PIN_HIJACK_NAMES,
};

test('every pinned environment name is in the file: the operator\'s value when the child has one, else nothing the repository chose', () => {
  for (const [group, names] of Object.entries(PINNED_ENV_GROUPS)) {
    assert.ok(names.length > 0, group);
    for (const name of names) {
      // The operator's own value always wins, so a gateway or a corporate proxy keeps working.
      assert.equal(pinnedSettings({ [name]: 'operator-value' }).env[name], 'operator-value', `${group}: ${name}`);
      const bare = pinnedSettings({}).env;
      if (PIN_KEEP_OR_SKIP.has(name)) {
        assert.ok(!(name in bare), `${name}: an empty value would be worse than none (an empty PATH entry is the current directory)`);
      } else {
        assert.equal(bare[name], PIN_NEUTRAL.get(name) ?? '', `${group}: ${name} is blanked when the operator gave none`);
      }
    }
  }
  // The one neutral value exists because blank is not "unset" for git over ssh (measured).
  assert.equal(PIN_NEUTRAL.get('GIT_SSH_COMMAND'), 'ssh');
  // No name is in two groups, or one group's rule would silently override another's.
  const all = Object.values(PINNED_ENV_GROUPS).flat();
  assert.equal(new Set(all).size, all.length, 'a name appears in two pin groups');
});

test('the pinned environment forces the two background switches and the public API, whatever the operator passed', () => {
  const env = pinnedSettings({ CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0', CLAUDE_CODE_DISABLE_WORKFLOWS: 'false' }).env;
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.equal(env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1');
  assert.equal(pinnedSettings({}).env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
});

test('the API key is never written to the pinned file (a repository can replace it in an opt-in mode; that is documented, not hidden)', async () => {
  const h = harness({ env: { PATH: '/bin', HTTPS_PROXY: 'http://u:proxy-pass@proxy.example:3128' }, cfg: { settingSources: ['project'] } });
  await begin(h);
  const text = readFileSync(h.options().settings as string, 'utf8');
  assert.ok(!text.includes(KEY), 'the key would sit on disk until close(), and survive a kill');
  assert.ok(!('ANTHROPIC_API_KEY' in (JSON.parse(text) as { env: Record<string, string> }).env));
  // Companion: the file really does carry the other secret-bearing value, so the check can fail.
  assert.ok(text.includes('proxy-pass'));
});

test('every command-bearing key is blanked: strings as empty strings, objects as empty-command objects', () => {
  const pinned = pinnedSettings({});
  for (const key of PIN_COMMAND_KEYS) assert.equal(pinned[key], '', key);
  for (const key of PIN_COMMAND_OBJECT_KEYS) assert.deepEqual(pinned[key], { type: 'command', command: '' }, key);
  // The boolean pins: the hook and workflow switches that back the policy tier up.
  assert.equal(pinned.disableAllHooks, true, 'a repository hook must not run when the policy tier is not in force');
  assert.equal(pinned.disableWorkflows, true);
  assert.equal(pinned.disableSkillShellExecution, true);
});

test('the pinned file is a valid Settings literal: the CLI discards a whole file over one mistyped key', () => {
  // Measured against the real CLI: `statusLine: ''` (and null, and {}) made it drop EVERY pin in the
  // file without a word. The SDK's own Settings type is the contract the CLI validates against.
  assert.deepEqual(settingsTypeErrors(pinnedSettings({})), []);
  assert.deepEqual(
    settingsTypeErrors(pinnedSettings({ PATH: '/usr/bin', HTTPS_PROXY: 'http://p', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' })),
    [],
  );
  // Companion: the check can fail, on exactly the mistake that bit.
  const bad = settingsTypeErrors({ ...pinnedSettings({}), statusLine: '' });
  assert.ok(bad.length > 0 && bad.some((m) => /statusLine|not assignable/.test(m)), String(bad));
  assert.ok(settingsTypeErrors({ apiKeyHelper: 5 }).length > 0);
});

/** Keys the SDK's Settings type names like a command runner, or gives a command-shaped value. */
function commandCandidates(keys: { name: string; runsCommand: boolean }[]): string[] {
  return keys.filter((k) => /(Helper|Refresh|Export)$/.test(k.name) || k.runsCommand).map((k) => k.name);
}
/** Candidates that are neither pinned nor reviewed: the ones a human has to look at. */
function unreviewed(candidates: string[], pinned: string[], reviewed: Record<string, string>): string[] {
  return candidates.filter((n) => !pinned.includes(n) && !(n in reviewed));
}
/**
 * Keys that look like command runners and are deliberately NOT pinned, each with the reason. A new
 * SDK key that looks like one fails the test below until somebody adds it here or to the pins.
 */
const REVIEWED_NOT_PINNED: Record<string, string> = {
  policyHelper: 'honoured only from admin-controlled policy sources (the SDK documents it); a flag-layer value is ignored',
  hooks: 'command hooks: ignored by the policy tier (allowManagedHooksOnly) and by the pinned disableAllHooks',
  strictKnownMarketplaces: 'a plugin-marketplace allowlist; `command` appears in a marketplace SOURCE shape, nothing here is run from the file',
  allowedMarketplaces: 'a plugin-marketplace allowlist, as above',
  blockedMarketplaces: 'a plugin-marketplace denylist, as above',
  sandbox: 'configures the optional sandbox, which this bridge does not rely on: every command asks regardless',
  forceRemoteSettingsRefresh: 'a boolean (managed settings only) that makes the CLI refetch remote policy at start-up; it names no command',
};

test('every key the SDK names Helper, Refresh or Export, or gives a command-shaped value, is pinned or has a reviewed reason', () => {
  const keys = settingsKeys();
  const candidates = commandCandidates(keys);
  // The candidate list must contain what the incident was about, or the scan found nothing real.
  for (const known of ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper', 'otelHeadersHelper', 'statusLine', 'fileSuggestion']) {
    assert.ok(candidates.includes(known), `the scan should have found ${known}; the SDK's Settings type changed shape`);
  }
  const pinned = Object.keys(pinnedSettings({}));
  assert.deepEqual(unreviewed(candidates, pinned, REVIEWED_NOT_PINNED), [], 'a command-running settings key is neither pinned nor reviewed');
  // A reviewed reason for a key that is pinned, or that no longer exists, is a stale note.
  const names = new Set(keys.map((k) => k.name));
  for (const n of Object.keys(REVIEWED_NOT_PINNED)) {
    assert.ok(names.has(n), `${n} is reviewed but the SDK no longer has it`);
    assert.ok(!pinned.includes(n), `${n} is both pinned and reviewed-not-pinned`);
  }
  // Every pinned command key exists in the SDK's type (a rename would leave a pin pinning nothing).
  for (const n of [...PIN_COMMAND_KEYS, ...PIN_COMMAND_OBJECT_KEYS, 'disableAllHooks', 'disableWorkflows', 'disableSkillShellExecution']) {
    assert.ok(names.has(n), `${n} is pinned but is not a key of the SDK's Settings type any more`);
  }
});

test('the settings scan can fail: a new *Helper key the pins do not know is reported', () => {
  const real = settingsKeys();
  const withNew = [...real, { name: 'newCredentialHelper', type: 'string', doc: '', runsCommand: false }];
  assert.deepEqual(unreviewed(commandCandidates(withNew), Object.keys(pinnedSettings({})), REVIEWED_NOT_PINNED), ['newCredentialHelper']);
  const shaped = [...real, { name: 'postStartHook', type: '{ command: string }', doc: '', runsCommand: true }];
  assert.deepEqual(unreviewed(commandCandidates(shaped), Object.keys(pinnedSettings({})), REVIEWED_NOT_PINNED), ['postStartHook']);
  // And a pin that is dropped from the function is reported too.
  const { apiKeyHelper, ...without } = pinnedSettings({});
  void apiKeyHelper;
  assert.deepEqual(unreviewed(commandCandidates(real), Object.keys(without), REVIEWED_NOT_PINNED), ['apiKeyHelper']);
});

// ---------------------------------------------------------------------------
// Opt-in settings sources
// ---------------------------------------------------------------------------

test('loading the repository\'s settings is announced in the log, once, and the default never says it', async () => {
  const quiet = harness();
  await begin(quiet);
  assert.ok(!quiet.logs.some((l) => /WARNING/.test(l)), 'the default loads nothing, so there is nothing to warn about');

  const loud = harness({ cfg: { settingSources: ['project', 'local'] } });
  const q = await begin(loud);
  const warnings = loud.logs.filter((l) => /^WARNING: settings sources project,local/.test(l));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /run commands/);
  // A second query (the CLI went away between turns) does not repeat it.
  q.push(resultOk('done'));
  await settle();
  q.end();
  await settle();
  await begin(loud, 'again');
  assert.equal(loud.logs.filter((l) => /^WARNING: settings sources/.test(l)).length, 1);

  // `user` alone is the operator's own configuration, not the repository's: no repository warning.
  const own = harness({ cfg: { settingSources: ['user'] } });
  await begin(own);
  assert.ok(!own.logs.some((l) => /^WARNING/.test(l)));
});

test('the driver says in its log whether the policy-tier lock is in force, only when a repository\'s files are loaded', async () => {
  // Default: nothing is loaded, so there is nothing to lock and nobody is asked.
  const asked: string[] = [];
  const quiet = harness({ lockAsked: asked });
  await begin(quiet);
  await settle();
  assert.deepEqual(asked, []);

  const down: ManagedLockStatus = { effective: false, missing: ['allowManagedPermissionRulesOnly', 'allowManagedHooksOnly'], displacedBy: ['file'] };
  const displaced = harness({ cfg: { settingSources: ['project'] }, lock: down, lockAsked: asked });
  await begin(displaced);
  await settle();
  assert.deepEqual(asked, [CWD], 'asked once, about the working directory');
  const line = displaced.logs.find((l) => /policy-tier lock is NOT in force/.test(l));
  assert.ok(line !== undefined, displaced.logs.join('\n'));
  assert.match(line, /admin tier: file/);
  assert.match(line, /disableAllHooks/);
  assert.match(line, /^[\x20-\x7e]+$/);

  // In force: no warning. Unknown: a distinct line, never silence and never "fine".
  const fine = harness({ cfg: { settingSources: ['local'] } });
  await begin(fine);
  await settle();
  assert.ok(!fine.logs.some((l) => /lock/.test(l)));
  for (const lock of [undefined, 'throws'] as const) {
    const unknown = harness({ cfg: { settingSources: ['project'] }, lock });
    await begin(unknown);
    await settle();
    assert.ok(unknown.logs.some((l) => /could not verify that the policy-tier lock is in force/.test(l)), String(lock));
  }
  // Asked once per driver, not once per query.
  const once = harness({ cfg: { settingSources: ['project'] }, lock: down, lockAsked: (asked.length = 0, asked) });
  const q = await begin(once);
  q.push(resultOk('done'));
  await settle();
  q.end();
  await settle();
  await begin(once, 'again');
  await settle();
  assert.equal(asked.length, 1);
});

// ---------------------------------------------------------------------------
// The project's memory file reaches the model as text
// ---------------------------------------------------------------------------

test('the project memory is appended to the system prompt under a heading, after the voice rules, and nowhere else', async () => {
  const memory = '=== CLAUDE.md ===\nUse tabs. Run the formatter before committing.';
  const h = harness({ cfg: { projectMemory: memory } });
  await begin(h);
  const o = h.options();
  const sp = o.systemPrompt as { type: string; preset: string; append: string; snapshot: boolean };
  assert.equal(sp.append, composeSystemAppend(memory));
  assert.ok(sp.append.startsWith(VOICE_RULES), 'the voice rules come first and are untouched');
  assert.ok(sp.append.includes(MEMORY_HEADING) && sp.append.includes(MEMORY_BEGIN) && sp.append.includes(MEMORY_END));
  assert.ok(sp.append.indexOf(MEMORY_HEADING) < sp.append.indexOf('Use tabs'), 'the heading says what the text is before the text');
  assert.match(MEMORY_HEADING, /memory file/);
  assert.match(MEMORY_HEADING, /cannot approve/, 'the model is told this text cannot grant a permission');
  // Only the system prompt: not the environment, not the pinned file, not an option anybody serialises elsewhere.
  assert.ok(!JSON.stringify(o.env).includes('Use tabs'));
  assert.ok(!('settings' in o), 'and with no settings source there is no pinned file for it to be in either');
  assert.equal(sp.snapshot, false, 'a recorded prompt would keep an edited CLAUDE.md out of a resumed session');
});

test('no memory, an empty memory and a whitespace-only memory add no section at all', async () => {
  for (const projectMemory of [undefined, '', '  \n\t ']) {
    const h = harness({ cfg: projectMemory === undefined ? {} : { projectMemory } });
    await begin(h);
    assert.equal((h.options().systemPrompt as { append: string }).append, VOICE_RULES, JSON.stringify(projectMemory));
  }
});

// ---------------------------------------------------------------------------
// The driver's own environment allowlist (M10)
// ---------------------------------------------------------------------------

test('the allowlist\'s prefixes match the START of a name: a name that merely contains one is not passed', () => {
  assert.ok(CHILD_ENV_PREFIXES.length > 0);
  for (const prefix of CHILD_ENV_PREFIXES) {
    const passes = (name: string): boolean => name in buildChildEnv({ [name]: 'v' }, KEY).env;
    assert.ok(passes(`${prefix}SOMETHING`), `${prefix}SOMETHING starts with the prefix and is passed`);
    for (const name of [`SECRET_${prefix}ALL`, `MY_${prefix}CONFIG`, `DB_${prefix}PASSWORD`, `X${prefix}TOKEN`, `${prefix.toLowerCase()}something`]) {
      assert.ok(!passes(name), `${name} contains ${prefix} but does not start with it`);
    }
  }
});

// ---------------------------------------------------------------------------
// A request from a query that was given up on (M9)
// ---------------------------------------------------------------------------

test('a permission request from a DISCARDED query is refused while a newer turn is in flight, and never shown to the device', async () => {
  // The case the identity check exists for: close() is not involved, a turn IS in flight, but the
  // request belongs to the query the driver already gave up on (an interrupt it never acknowledged).
  const h = harness({ interruptGraceMs: 1000 });
  const q1 = await begin(h, 'first');
  q1.onInterrupt = () => new Promise(() => {}); // the CLI never answers
  void h.driver.interrupt();
  await settle();
  h.clock.advance(1000);
  await settle();
  assert.equal(terminals(h.events).length, 1, 'the first turn ended (fatal: did not stop)');
  const q2 = await begin(h, 'second');
  assert.notEqual(q1, q2);

  const stale = await h.ask('Bash', { command: 'touch x' }, { run: 0 });
  assert.equal(stale.behavior, 'deny');
  assert.equal(h.requests.length, 0, 'a question from the old query must not be put to the device during the new turn');
  assert.match((stale as { message: string }).message, /no longer active/);

  // Companion: the same request from the CURRENT query does reach the device, so the refusal above
  // is about which query asked and not about the turn.
  const fresh = await h.ask('Bash', { command: 'touch x' }, { run: 1 });
  assert.equal(fresh.behavior, 'allow');
  assert.equal(h.requests.length, 1);
});

// ---------------------------------------------------------------------------
// The silence watchdog (D15)
// ---------------------------------------------------------------------------

const terminalOf = (events: DriverEvent[]): DriverEvent | undefined => terminals(events)[0];

test('a turn with no event for the stall period is interrupted and ends as stalled, exactly once', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  q.push(init());
  await settle();
  h.clock.advance(DEFAULT_STALL_MS - 1);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'not yet: one millisecond short');
  h.clock.advance(1);
  await settle();
  assert.deepEqual(terminalOf(h.events), { k: 'result', ok: false, text: STALLED_TEXT, subtype: 'stalled' });
  assertOneTerminalEach(h.events, 1);
  assert.equal(q.interrupts, 1, 'the CLI was told to drop the request');
  assert.equal(q.closes, 1, 'and the silent query was given up on');
  assert.equal(h.clock.armed, 0, 'no timer left behind');
  assert.ok(h.logs.some((l) => /no sign of life/.test(l)));
  assert.match(STALLED_TEXT, /^[\x20-\x7e]+$/);
});

test('every event restarts the quiet period, and it is counted from the LAST one', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  h.clock.advance(200_000);
  q.push(init());
  await settle();
  h.clock.advance(200_000);
  q.push(assistantText('working'));
  await settle();
  h.clock.advance(200_000);
  await settle();
  assert.equal(terminals(h.events).length, 0, '600 s in, but never 300 s without a word');
  h.clock.advance(100_000);
  await settle();
  assert.equal(terminalOf(h.events)?.k, 'result');
  assert.equal((terminalOf(h.events) as { subtype: string }).subtype, 'stalled');
});

test('a message from a turn nobody asked for still counts as a sign of life', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  h.clock.advance(250_000);
  q.push(assistantText('a background turn is talking'), { stamp: false });
  await settle();
  h.clock.advance(250_000);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'the CLI is busy, not silent');
});

test('a tool that is RUNNING pauses the watchdog; its result is activity and restarts the count', async () => {
  const h = harness();
  const q = await begin(h, 'build it');
  q.push(init());
  q.push(toolStart('t1', 'Bash'));
  q.push(blockStop());
  await settle();
  h.clock.advance(DEFAULT_STALL_MS * 10);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'a long build is quiet and fine');
  q.push(toolResult('t1'));
  await settle();
  h.clock.advance(DEFAULT_STALL_MS - 1);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'counted from the result, not from before the tool');
  h.clock.advance(1);
  await settle();
  assert.equal((terminalOf(h.events) as { subtype: string }).subtype, 'stalled');
});

test('a tool still STREAMING its input is not running: a model that goes silent mid-call is the stall', async () => {
  const h = harness();
  const q = await begin(h, 'build it');
  q.push(init());
  q.push(toolStart('t1', 'Bash')); // no content_block_stop: the input never finished
  await settle();
  h.clock.advance(DEFAULT_STALL_MS);
  await settle();
  assert.equal((terminalOf(h.events) as { subtype: string }).subtype, 'stalled');
  assert.deepEqual(dangling(h.events), [], 'and the tool it announced is closed, not left open');
});

test('an open permission request pauses the watchdog; answering it is activity', async () => {
  let release!: () => void;
  const answer = new Promise<{ allow: true }>((resolve) => {
    release = () => resolve({ allow: true });
  });
  const h = harness({ onPermission: () => answer });
  const q = await begin(h, 'delete it');
  q.push(init());
  await settle();
  const ask = h.ask('Bash', { command: 'rm x' });
  await settle();
  // Ten and a HALF periods: the watchdog's own timer is mid-period when the person answers, so
  // counting from the answer and counting from the last message give different moments.
  h.clock.advance(DEFAULT_STALL_MS * 10.5);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'a person is deciding; that is not the model being silent');
  release();
  await ask;
  await settle();
  h.clock.advance(DEFAULT_STALL_MS - 1);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'the quiet is counted from the answer');
  h.clock.advance(1);
  await settle();
  assert.equal((terminalOf(h.events) as { subtype: string }).subtype, 'stalled');
});

test('no timer is armed unless a turn is running: before, between and after turns', async () => {
  const h = harness();
  assert.equal(h.clock.armed, 0, 'a new driver');
  const q = await begin(h, 'one');
  assert.ok(h.clock.armed > 0, 'a turn arms the watchdog (so this test can see it disarm)');
  q.push(resultOk('done'));
  await settle();
  assert.equal(h.clock.armed, 0, 'between turns');
  h.driver.prompt('two');
  await settle();
  assert.ok(h.clock.armed > 0);
  await h.driver.close();
  assert.equal(h.clock.armed, 0, 'after close');
});

test('a late result from the query that stalled is ignored, and cannot end the NEXT prompt', async () => {
  const h = harness();
  const q1 = await begin(h, 'first');
  q1.push(init());
  await settle();
  h.clock.advance(DEFAULT_STALL_MS);
  await settle();
  assertOneTerminalEach(h.events, 1);
  const q2 = await begin(h, 'second');
  // The stalled CLI wakes up and finishes the first turn, with its prompt's stamp.
  q1.push(resultOk('too late'), { stampWith: UUID_OF(q1) });
  q1.push(resultAborted());
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.equal(h.events.filter((e) => e.k === 'result' && (e as { text: string }).text === 'too late').length, 0, 'its words reach nobody');
  q2.push(resultOk('real answer'));
  await settle();
  assertOneTerminalEach(h.events, 2);
  assert.deepEqual(terminals(h.events)[1], { k: 'result', ok: true, text: 'real answer', subtype: 'success' });
});

/** The uuid the driver gave the prompt a query received first. */
function UUID_OF(q: FakeQuery): string {
  return q.received[0]!.uuid as string;
}

test('the stall period is configurable, and 0 or a non-number turns the watchdog off entirely', async () => {
  const short = harness({ cfg: { stallMs: 1500 } });
  await begin(short);
  short.clock.advance(1499);
  await settle();
  assert.equal(terminals(short.events).length, 0);
  short.clock.advance(1);
  await settle();
  assert.equal((terminalOf(short.events) as { subtype: string }).subtype, 'stalled');

  for (const stallMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const off = harness({ cfg: { stallMs } });
    await begin(off);
    assert.equal(off.clock.armed, 0, `stallMs ${stallMs}: no timer at all`);
    off.clock.advance(10 ** 9);
    await settle();
    assert.equal(terminals(off.events).length, 0, `stallMs ${stallMs}`);
  }
});

test('after a stall the waiting prompt starts on a fresh query with its own full period', async () => {
  const h = harness();
  const q1 = await begin(h, 'first');
  h.driver.prompt('second'); // waits behind the first
  await settle();
  assert.equal(h.queries.length, 1);
  h.clock.advance(DEFAULT_STALL_MS);
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.equal(h.queries.length, 2, 'the second prompt started on a new query straight away');
  assert.equal(h.queries[1]!.received.length, 1);
  h.clock.advance(DEFAULT_STALL_MS - 1);
  await settle();
  assertOneTerminalEach(h.events, 1);
  h.clock.advance(1);
  await settle();
  assertOneTerminalEach(h.events, 2);
  assert.equal(q1.closes, 1);
});

test('an interrupt that fails after a stall costs a log line, not a second terminal or a crash', async () => {
  const h = harness();
  const q = await begin(h, 'first');
  q.onInterrupt = () => Promise.reject(new Error('the CLI is gone'));
  h.clock.advance(DEFAULT_STALL_MS);
  await settle();
  assertOneTerminalEach(h.events, 1);
  assert.ok(h.logs.some((l) => /interrupt after a stall failed: the CLI is gone/.test(l)));
});

test('asking the driver to stop hands the clock to the grace timer: the silence watchdog does not also end the turn', async () => {
  const h = harness({ interruptGraceMs: 10 * DEFAULT_STALL_MS });
  const q = await begin(h, 'first');
  q.onInterrupt = () => new Promise(() => {}); // acknowledged never
  void h.driver.interrupt();
  await settle();
  h.clock.advance(3 * DEFAULT_STALL_MS);
  await settle();
  assert.equal(terminals(h.events).length, 0, 'still waiting for the CLI to answer the interrupt, not declared stalled');
});

// ---------------------------------------------------------------------------
// Upstream text is scrubbed before it leaves the driver (D16)
// ---------------------------------------------------------------------------

test('redactSecrets removes the configured key, key-shaped tokens and echoed auth values', () => {
  const keys = [KEY];
  assert.equal(redactSecrets(`Incorrect API key provided: ${KEY}.`, keys, 'error'), `Incorrect API key provided: ${REDACTED}.`);
  assert.equal(redactSecrets('key sk-ant-api03-ABCDEFGHIJKLMNOP end', [], 'answer'), `key ${REDACTED} end`);
  assert.equal(redactSecrets('sent Authorization: Bearer abcdef0123456789.xyz', [], 'answer'), `sent Authorization: ${REDACTED}`);
  // Ordinary words that happen to be Basic or Bearer are left alone: the value must be long.
  assert.equal(redactSecrets('a Basic installation, the Bearer of news', [], 'answer'), 'a Basic installation, the Bearer of news');
  assert.equal(redactSecrets('Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ=', [], 'answer'), `Authorization: ${REDACTED}`);
});

test('redaction is strict for error text and key-shaped only for an answer', () => {
  const hash = 'a'.repeat(40);
  const token = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
  // An answer keeps a commit id and a long identifier; an upstream error does not.
  assert.equal(redactSecrets(`commit ${hash}`, [], 'answer'), `commit ${hash}`);
  assert.equal(redactSecrets(`commit ${hash}`, [], 'error'), `commit ${REDACTED}`);
  assert.equal(redactSecrets(`token ${token}`, [], 'answer'), `token ${token}`);
  assert.equal(redactSecrets(`token ${token}`, [], 'error'), `token ${REDACTED}`);
  // A session id is a UUID: long, token-shaped, and not a secret; the log needs it.
  const uuid = '3602e11c-9a7b-4c1d-8f00-0123456789ab';
  assert.equal(redactSecrets(`session ${uuid}`, [], 'error'), `session ${uuid}`);
  // `sk-` inside a word is not a key.
  assert.equal(redactSecrets('the risk-assessment and task-runner', [], 'answer'), 'the risk-assessment and task-runner');
  // A key too short to be real is left alone rather than shredding every message.
  assert.equal(redactSecrets('use abc here', ['abc'], 'error'), 'use abc here');
  // The placeholder survives the sanitiser that turns result text into device text.
  assert.equal(summarizeForDevice(`Error ${REDACTED}.`, LIMITS.resultMax), `Error ${REDACTED}.`);
  assert.match(REDACTED, /^[\x20-\x7e]+$/);
  assert.doesNotMatch(REDACTED, /[_*`#]/);
  // Linear time on a hostile input.
  const t0 = performance.now();
  redactSecrets('a-'.repeat(200_000) + 'sk-'.repeat(50_000), [KEY], 'error');
  assert.ok(performance.now() - t0 < 1500, 'a megabyte of near-misses must not stall the bridge');
});

test('a failed result whose upstream text echoes the key reaches the server without it', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  q.push(resultErr('error_during_execution', { errors: [`API Error: 400 Incorrect API key provided: ${KEY}. Also sk-ant-api03-LEAKEDLEAKEDLEAKED`] }));
  await settle();
  const r = terminalOf(h.events) as Extract<DriverEvent, { k: 'result' }>;
  assert.equal(r.ok, false);
  const wire = JSON.stringify(h.events);
  assert.ok(!wire.includes(KEY) && !wire.includes('LEAKED'), wire);
  assert.ok(r.text.includes(REDACTED) && r.text.startsWith('API Error: 400'), 'the useful part of the message is still there');
  // A failed result is the STRICT level: a long token-looking run goes too (a gateway may echo a credential in any shape).
  const long = 'Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2RlZmdoaWo';
  const h3 = harness();
  const q3 = await begin(h3, 'hello');
  q3.push(resultErr('error_during_execution', { errors: [`gateway said: bad credential ${long}`] }));
  await settle();
  assert.equal((terminalOf(h3.events) as { text: string }).text, `gateway said: bad credential ${REDACTED}`);
  // Companion: text with nothing in it to remove passes through unchanged.
  const h2 = harness();
  const q2 = await begin(h2, 'hello');
  q2.push(resultErr('error_during_execution', { errors: ['API Error: 529 overloaded, try again later'] }));
  await settle();
  assert.equal((terminalOf(h2.events) as { text: string }).text, 'API Error: 529 overloaded, try again later');
});

test('a successful answer and the narration are scrubbed of key-shaped text too, but keep their commit ids', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  q.push(assistantText(`I found ${KEY} in the file`));
  q.push(resultOk(`The key is ${KEY} and the commit is ${'b'.repeat(40)}.`));
  await settle();
  const wire = JSON.stringify(h.events);
  assert.ok(!wire.includes(KEY), wire);
  const r = terminalOf(h.events) as Extract<DriverEvent, { k: 'result' }>;
  assert.equal(r.text, `The key is ${REDACTED} and the commit is ${'b'.repeat(40)}.`);
  assert.ok(h.events.some((e) => e.k === 'text' && e.text === `I found ${REDACTED} in the file`));
});

test('a fatal message and the give-up sentence are scrubbed on the same road', async () => {
  const h = harness();
  const q = await begin(h, 'hello');
  q.fail(new Error(`connect ECONNREFUSED while using ${KEY} and sk-ant-api03-ZZZZZZZZZZZZZZZZ`));
  await settle();
  const f = terminalOf(h.events) as Extract<DriverEvent, { k: 'fatal' }>;
  assert.ok(!JSON.stringify(f).includes(KEY) && !f.msg.includes('ZZZZ'), f.msg);
  // The hint for a rejected key is driver-authored text; the sanitiser must leave it exactly as written.
  const h2 = harness();
  const q2 = await begin(h2, 'hello');
  q2.push(apiRetry('authentication_failed', 401));
  await settle();
  const r = terminalOf(h2.events) as Extract<DriverEvent, { k: 'result' }>;
  assert.equal(summarizeForDevice(r.text, LIMITS.resultMax), r.text, 'what the server sends the device is what the driver wrote');
  assert.doesNotMatch(r.text, /[A-Z]+_[A-Z_]+/, 'no environment variable name: the sanitiser strips underscores from them');
});

// ---------------------------------------------------------------------------
// Is the driver's policy-tier lock in force on this machine? (K2, K3, M5)
// ---------------------------------------------------------------------------

type Resolver = NonNullable<Parameters<typeof checkManagedLock>[1]>['resolveSettings'];
const resolver = (effective: Record<string, unknown>, sources: unknown[] = []): Resolver =>
  (() => Promise.resolve({ effective, provenance: {}, sources })) as unknown as Resolver;

test('checkManagedLock: both locks in force', async () => {
  const seen: unknown[] = [];
  const ok = await checkManagedLock(CWD, {
    resolveSettings: ((opts: unknown) => {
      seen.push(opts);
      return Promise.resolve({ effective: { allowManagedPermissionRulesOnly: true, allowManagedHooksOnly: true }, provenance: {}, sources: [{ source: 'managed', policyOrigin: 'parent', settings: {} }] });
    }) as unknown as Resolver,
  });
  assert.deepEqual(ok, { effective: true, missing: [], displacedBy: [] });
  // It asks for the policy tier only, with the driver's own lock: never a repository's files.
  assert.deepEqual(seen, [{ cwd: CWD, settingSources: [], managedSettings: { allowManagedPermissionRulesOnly: true, allowManagedHooksOnly: true } }]);
});

test('checkManagedLock: an administrator\'s tier displaces the lock, and says where it came from', async () => {
  const admin = await checkManagedLock(CWD, { resolveSettings: resolver({}, [{ source: 'managed', policyOrigin: 'file', settings: { permissions: {} } }]) });
  assert.deepEqual(admin, { effective: false, missing: ['allowManagedPermissionRulesOnly', 'allowManagedHooksOnly'], displacedBy: ['file'] });
  const half = await checkManagedLock(CWD, { resolveSettings: resolver({ allowManagedHooksOnly: true }) });
  assert.deepEqual([half?.effective, half?.missing], [false, ['allowManagedPermissionRulesOnly']]);
  // "true" must be the boolean: a string is not a lock the CLI honours the same way.
  const text = await checkManagedLock(CWD, { resolveSettings: resolver({ allowManagedPermissionRulesOnly: 'true', allowManagedHooksOnly: true }) });
  assert.equal(text?.effective, false);
});

test('checkManagedLock: when the question cannot be answered, the answer is "unknown", never "fine"', async () => {
  const broken = await checkManagedLock(CWD, { resolveSettings: (() => Promise.reject(new Error('alpha API moved'))) as unknown as Resolver });
  assert.equal(broken, undefined);
  const garbage = await checkManagedLock(CWD, { resolveSettings: (() => Promise.resolve(null)) as unknown as Resolver });
  assert.equal(garbage, undefined);
});

// ---------------------------------------------------------------------------
// The version this driver's CLI claims were measured against
// ---------------------------------------------------------------------------

test('the installed SDK is the one the real-CLI suite was last run against', () => {
  const installed = (JSON.parse(readFileSync(new URL('../node_modules/@anthropic-ai/claude-agent-sdk/package.json', import.meta.url), 'utf8')) as { version: string }).version;
  assert.equal(
    installed,
    REAL_CLI_VERIFIED_SDK,
    `the SDK is ${installed} but test/real-cli.integration.test.ts was last run against ${REAL_CLI_VERIFIED_SDK}. ` +
      'Run `npm run test:real-cli`; only when it passes, update REAL_CLI_VERIFIED_SDK in test/support/sdk-version.ts. ' +
      'Every claim about the CLI (what settings run, what a pin stops) was measured on the old one.',
  );
  const dep = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@anthropic-ai/claude-agent-sdk'];
  assert.equal(dep, REAL_CLI_VERIFIED_SDK, 'package.json pins the SDK to the exact version, with no range');
});

// ---------------------------------------------------------------------------
// The source itself
// ---------------------------------------------------------------------------

const SOURCES = ['../src/drivers/claude.ts', '../src/drivers/claude-adapter.ts', '../src/voice-prompt.ts', '../src/memory.ts'].map((rel) => ({
  rel,
  text: readFileSync(new URL(rel, import.meta.url), 'utf8'),
}));

/** Names of the options that would let a call run without the handheld's tap. */
function forbiddenTokens(text: string): string[] {
  const found: string[] = [];
  if (/bypass/i.test(text)) found.push('bypass');
  if (/dangerously/i.test(text)) found.push('dangerously');
  // Not preceded by a letter: `disallowedTools` is the opposite option and must stay legal.
  if (/(?<![A-Za-z])allowedTools/.test(text)) found.push('allowedTools');
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
  assert.deepEqual(forbiddenTokens(`options.disallowedTools = ['Bash']`), [], 'the deny list is not the allow list');
  assert.deepEqual(forbiddenTokens(`permissionMode: 'acceptEdits'`), ['permissionMode acceptEdits']);
  assert.deepEqual(forbiddenTokens(`permissionMode: 'default'`), []);
});

test('the driver source asks for the default permission mode and no other', () => {
  const driver = SOURCES.find((s) => s.rel.endsWith('/claude.ts'))!;
  const modes = [...driver.text.matchAll(/permissionMode\s*:\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(modes, ['default'], 'exactly one permissionMode, and it is the default');
});
