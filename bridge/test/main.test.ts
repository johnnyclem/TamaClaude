/**
 * The command line: configuration rules (pure, table-driven), what the banner shows and
 * hides, and the real entry points run as child processes, because "SIGTERM closes the
 * port" and "importing starts nothing" are claims about a process, not about a function.
 *
 * Also here: the fake-device CLI driven for real against a real server process, since it
 * has no other test and its job is to be typed into.
 */

import { after, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { connect as netConnect, createServer as createNetServer } from 'node:net';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import { DeviceClient } from '../src/device-client.ts';
import { runFakeDevice } from '../tools/fake-device.ts';
import {
  buildClaudeConfig,
  buildServerOptions,
  bridgeSuppliesMemory,
  CLI_FREE_TOOLS,
  ConfigError,
  hardDenyFor,
  installShutdown,
  isLoopbackHost,
  listUrls,
  lockWarning,
  needsAskFor,
  neutraliseInspector,
  parseConfig,
  readsRepositorySettings,
  renderBanner,
  run as runProgram,
  settingsWarning,
  USAGE,
} from '../src/main.ts';
import type { Config, Io, RunDeps } from '../src/main.ts';
import { CHILD_ENV_NAMES, CHILD_ENV_PREFIXES, DEFAULT_STALL_MS } from '../src/drivers/claude.ts';
import type { ClaudeDriverConfig, ManagedLockStatus } from '../src/drivers/claude.ts';
import { MEMORY_MAX_BYTES } from '../src/memory.ts';
import type { ProjectMemoryReport } from '../src/memory.ts';
import { DEFAULTS } from '../src/server.ts';
import type { RunningServer, ServerOptions } from '../src/server.ts';
import { AUTO_RUN_TOOLS, describeTool, setBridgeSecrets, UNSERVED_TOOL_NAMES } from '../src/tools.ts';
import { saveSession } from '../src/store.ts';
import { LIMITS } from '../src/types.ts';
import type { DriverFactory } from '../src/types.ts';
import { ScriptedStt } from '../src/stt.ts';

/**
 * Everything a test starts that outlives it if its own cleanup does not run: servers `run()` brought up, and the child
 * processes the entry-point tests spawn. node:test stops running a test's `after` hooks once one of them has thrown, so a
 * regression that makes ONE hook fail used to leave a listening server or a bridge process behind, the process never exited,
 * and the whole run hung instead of printing the failure (M6, measured: the token, cwd, host and stateDir wiring mutants).
 * The file-level hook below is the safety net: a failing test costs one red test, not the run.
 */
const LIVE_SERVERS = new Set<RunningServer>();
const LIVE_CHILDREN = new Set<ChildProcess>();
after(async () => {
  setBridgeSecrets([]); // the registry is process-wide; a test that used the real one must not leak it
  for (const c of LIVE_CHILDREN) c.kill('SIGKILL');
  LIVE_CHILDREN.clear();
  await Promise.all([...LIVE_SERVERS].map((s) => s.close().catch(() => undefined)));
  LIVE_SERVERS.clear();
});
/** `run()` from main.ts, with every server it starts registered for the safety net. */
const run: typeof runProgram = async (...args) => {
  const r = await runProgram(...args);
  if (r.server !== undefined) LIVE_SERVERS.add(r.server);
  return r;
};

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const MAIN = join(ROOT, 'src', 'main.ts');
const DEVICE = join(ROOT, 'tools', 'fake-device.ts');

const GEN = 'a1b2c3d4e5f6a1b2c3d4e5f6'; // what the injected generator returns: 24 hex characters
const deps = { cwd: '/work/project', homedir: '/home/dev', randomToken: () => GEN };
const KEY = 'sk-ant-test-key-0000000000';
const SUPPLIED = 'supplied-token-0123456789';

const fake = (...a: string[]): string[] => ['--fake-claude', ...a];
const cfg = (argv: string[], env: Record<string, string | undefined> = {}): Config => parseConfig(argv, env, deps);
const refuses = (argv: string[], env: Record<string, string | undefined>, re: RegExp, why?: string): void =>
  assert.throws(() => cfg(argv, env), (e: unknown) => e instanceof ConfigError && re.test(e.message), why ?? JSON.stringify(argv));

// ===========================================================================
// parseConfig
// ===========================================================================

test('defaults: loopback, port 8787, fake delay 400, a generated 24-hex token, NO repository settings read', () => {
  const c = cfg(fake());
  assert.deepEqual(
    { host: c.host, port: c.port, fakeClaude: c.fakeClaude, fakeDelayMs: c.fakeDelayMs, askTtlSec: c.askTtlSec, graceSec: c.graceSec },
    { host: '127.0.0.1', port: 8787, fakeClaude: true, fakeDelayMs: 400, askTtlSec: 90, graceSec: 15 },
  );
  assert.equal(c.token, GEN);
  assert.equal(c.tokenGenerated, true);
  assert.deepEqual(c.settingSources, [], 'the default reads no repository and no user configuration');
  assert.equal(c.turnStallSec, 300);
  assert.equal(c.tokenFile, undefined);
  assert.equal(c.cwd, '/work/project');
  assert.equal(c.newSession, false);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(
    { tokenSource: c.tokenSource, allowLocalDevice: c.allowLocalDevice, passEnv: c.passEnv, model: c.model, maxTurns: c.maxTurns },
    { tokenSource: 'generated', allowLocalDevice: true, passEnv: [], model: undefined, maxTurns: undefined },
  );
});

test('the real generator makes 24 lowercase hex characters, a different one each time', () => {
  const a = parseConfig(fake(), {});
  const b = parseConfig(fake(), {});
  assert.match(a.token, /^[0-9a-f]{24}$/);
  assert.notEqual(a.token, b.token);
  assert.ok(a.token.length >= LIMITS.tokenMin);
});

test('the token comes from --token, else BRIDGE_TOKEN, else is generated; the flag wins', () => {
  assert.deepEqual([cfg(fake('--token', SUPPLIED)).token, cfg(fake('--token', SUPPLIED)).tokenGenerated], [SUPPLIED, false]);
  assert.equal(cfg(fake(), { BRIDGE_TOKEN: SUPPLIED }).token, SUPPLIED);
  assert.equal(cfg(fake('--token', SUPPLIED), { BRIDGE_TOKEN: 'from-the-environment-0123' }).token, SUPPLIED);
  assert.equal(cfg(fake(), { BRIDGE_TOKEN: '' }).tokenGenerated, true, 'an empty variable is no variable');
});

test('a token shorter than the minimum is refused, one at the minimum is not', () => {
  const edge = (n: number): string => 'k'.repeat(n);
  refuses(fake('--token', edge(LIMITS.tokenMin - 1)), {}, /at least 16/);
  refuses(fake(), { BRIDGE_TOKEN: edge(3) }, /at least 16/, 'from the environment too');
  assert.equal(cfg(fake('--token', edge(LIMITS.tokenMin))).token.length, LIMITS.tokenMin);
  assert.equal(cfg(fake('--token', edge(LIMITS.tokenMax))).token.length, LIMITS.tokenMax);
  refuses(fake('--token', edge(LIMITS.tokenMax + 1)), {}, /at most 64/);
});

test('a token the device could not send is refused too, whatever its length', () => {
  refuses(fake('--token', 'has a space in it 123456'), {}, /may only use/);
  refuses(fake('--token', 'café-token-0123456789'), {}, /may only use/);
  refuses(fake('--token', 'quote"inside-0123456789'), {}, /may only use/);
  assert.equal(cfg(fake('--token', 'A-Za-z0-9._~-token-ok')).tokenGenerated, false, 'the full allowed alphabet is fine');
});

test('real mode without ANTHROPIC_API_KEY is refused, and the message says why and what to do', () => {
  for (const env of [{}, { ANTHROPIC_API_KEY: '' }, { ANTHROPIC_API_KEY: '   ' }]) {
    assert.throws(
      () => cfg([], env),
      (e: unknown) =>
        e instanceof ConfigError &&
        /ANTHROPIC_API_KEY/.test(e.message) &&
        /subscription/.test(e.message) &&
        /--fake-claude/.test(e.message),
      JSON.stringify(env),
    );
  }
  assert.doesNotThrow(() => cfg([], { ANTHROPIC_API_KEY: KEY }), 'with a key it is accepted');
  assert.doesNotThrow(() => cfg(fake(), {}), 'and fake mode never needs one');
});

test('the API key is not kept in the config, so it cannot be logged by accident', () => {
  const c = cfg([], { ANTHROPIC_API_KEY: KEY });
  assert.equal(JSON.stringify(c).includes(KEY), false);
  assert.equal(c.fakeClaude, false);
  assert.equal(c.fakeDelayMs, 0, 'the fake delay means nothing in real mode');
});

test('a host that is not loopback earns a warning about plaintext; loopback hosts do not', () => {
  for (const host of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
    assert.deepEqual(cfg(fake('--host', host)).warnings, [], host);
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.20', '10.0.0.5', 'my-laptop.local', '127.0.0.1.evil.example']) {
    const w = cfg(fake('--host', host)).warnings;
    assert.equal(w.length, 1, host);
    assert.match(w[0] ?? '', /plaintext ws:\/\//, host);
    assert.match(w[0] ?? '', /trust/, host);
  }
});

test('numbers are checked: whole, in range, and port 0 is allowed', () => {
  assert.equal(cfg(fake('--port', '0')).port, 0);
  assert.equal(cfg(fake('--port', '65535')).port, 65535);
  refuses(fake('--port', '65536'), {}, /--port must be between 0 and 65535/);
  refuses(fake('--port=-1'), {}, /whole number/);
  refuses(fake('--port', '-1'), {}, /--port.*ambiguous.*--help/, 'a dash is read as the next flag, and says so');
  refuses(fake('--port', 'http'), {}, /whole number/);
  refuses(fake('--port', '80.5'), {}, /whole number/);
  assert.equal(cfg(fake('--ask-ttl-sec', '30', '--grace-sec', '0')).graceSec, 0);
  refuses(fake('--ask-ttl-sec', '0'), {}, /--ask-ttl-sec must be between 1/);
  assert.equal(cfg(fake('--ask-ttl-sec', '3600')).askTtlSec, 3600, 'an hour is the longest an ask may wait');
  refuses(fake('--ask-ttl-sec', '3601'), {}, /--ask-ttl-sec must be between 1 and 3600/);
  refuses(fake('--grace-sec', '99999'), {}, /--grace-sec must be between/);
  assert.equal(cfg(fake('--fake-delay-ms', '0')).fakeDelayMs, 0);
  assert.equal(cfg(fake('--fake-delay-ms', '50')).fakeDelayMs, 50);
  refuses(fake('--fake-delay-ms', 'slow'), {}, /whole number/);
  refuses(['--fake-delay-ms', '5'], { ANTHROPIC_API_KEY: KEY }, /only applies together with --fake-claude/);
});

test('mistakes in the arguments get a friendly message, not a stack trace', () => {
  refuses(fake('--prot', '1'), {}, /Unknown option '--prot'.*--help/);
  refuses(fake('stray'), {}, /Unexpected argument 'stray'.*--help/);
  refuses(fake('--port'), {}, /--port.*argument/);
  refuses(fake('--host', ' '), {}, /--host must not be empty/);
});

test('the state directory: flag, else XDG_STATE_HOME, else the home directory; a relative XDG is ignored', () => {
  assert.equal(cfg(fake()).stateDir, '/home/dev/.local/state/tamaclaude-bridge');
  assert.equal(cfg(fake(), { XDG_STATE_HOME: '/var/state' }).stateDir, '/var/state/tamaclaude-bridge');
  assert.equal(cfg(fake(), { XDG_STATE_HOME: 'relative/dir' }).stateDir, '/home/dev/.local/state/tamaclaude-bridge');
  assert.equal(cfg(fake('--state-dir', '/srv/x'), { XDG_STATE_HOME: '/var/state' }).stateDir, '/srv/x');
});

test('the working directory defaults to where you are and is made absolute', () => {
  assert.equal(cfg(fake('--cwd', '/srv/app')).cwd, '/srv/app');
  assert.equal(cfg(fake('--cwd', 'sub/dir')).cwd, resolve('sub/dir'));
  assert.equal(parseConfig(fake(), {}, { randomToken: () => GEN }).cwd, process.cwd());
});

test('setting sources: NONE by default; project, local, user and lists are an explicit opt-in; user warns', () => {
  assert.deepEqual(cfg(fake()).settingSources, []);
  assert.deepEqual(cfg(fake('--setting-sources', 'none')).settingSources, [], 'saying none is the same as saying nothing');
  assert.deepEqual(cfg(fake('--setting-sources', 'project')).settingSources, ['project']);
  assert.deepEqual(cfg(fake('--setting-sources', 'local, project,local')).settingSources, ['local', 'project'], 'trimmed, de-duplicated');
  assert.deepEqual(cfg(fake('--setting-sources', 'none')).settingSources, []);
  const u = cfg(fake('--setting-sources', 'user,project'));
  assert.deepEqual(u.settingSources, ['user', 'project']);
  assert.equal(u.warnings.length, 1);
  assert.match(u.warnings[0] ?? '', /permission rules and hooks are ignored/, 'the warning says what is still true, not what the old design allowed');
  assert.match(u.warnings[0] ?? '', /best effort/, 'and that the blocks on the rest are not a guarantee');
  assert.doesNotMatch(u.warnings[0] ?? '', /WITHOUT asking/);
  refuses(fake('--setting-sources', 'project,global'), {}, /"global" is not one of/);
  refuses(fake('--setting-sources', ','), {}, /at least one/);
});

test('--help needs nothing else: no token, no key', () => {
  const c = parseConfig(['--help'], {}, deps);
  assert.equal(c.help, true);
  assert.equal(parseConfig(['-h'], {}, deps).help, true);
  assert.equal(cfg(fake()).help, false);
});

test('--new-session is a plain switch', () => {
  assert.equal(cfg(fake('--new-session')).newSession, true);
});

// ===========================================================================
// The banner
// ===========================================================================

test('the banner shows the URL, the mode and the cwd, and the generated token exactly once', () => {
  const c = cfg(fake('--cwd', '/srv/app'));
  const text = renderBanner(c, ['ws://127.0.0.1:8787/']).join('\n');
  assert.match(text, /ws:\/\/127\.0\.0\.1:8787\//);
  assert.match(text, /FAKE/);
  assert.match(text, /\/srv\/app/);
  assert.equal(text.split(GEN).length - 1, 1, 'once');
  assert.match(renderBanner(cfg([], { ANTHROPIC_API_KEY: KEY }), ['ws://x/']).join('\n'), /REAL/);
});

test('a token the person supplied is not printed back, and neither is the API key', () => {
  const c = cfg(fake('--token', SUPPLIED), { ANTHROPIC_API_KEY: KEY });
  const text = renderBanner(c, ['ws://127.0.0.1:8787/']).join('\n');
  assert.equal(text.includes(SUPPLIED), false);
  assert.equal(text.includes(KEY), false);
  assert.match(text, /supplied by you/);
});

test('warnings appear in the banner', () => {
  const text = renderBanner(cfg(fake('--host', '0.0.0.0')), ['ws://127.0.0.1:8787/']).join('\n');
  assert.match(text, /WARNING.*plaintext/);
});

test('a wildcard host lists every interface address; a named host lists itself', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    wlan0: [
      { address: '192.168.1.20', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
  } as unknown as ReturnType<typeof import('node:os').networkInterfaces>;
  assert.deepEqual(listUrls('0.0.0.0', 9000, ifaces), ['ws://127.0.0.1:9000/', 'ws://192.168.1.20:9000/']);
  assert.deepEqual(listUrls('10.1.2.3', 9000, ifaces), ['ws://10.1.2.3:9000/']);
  assert.deepEqual(listUrls('::1', 9000, ifaces), ['ws://[::1]:9000/']);
});

// ===========================================================================
// run(): in-process
// ===========================================================================

function capture(): { io: Io; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => void out.push(s), err: (s) => void err.push(s) }, out, err };
}
const portOf = (banner: string): string => {
  const m = /ws:\/\/127\.0\.0\.1:(\d+)\//.exec(banner);
  if (m?.[1] === undefined) throw new Error(`no URL in the banner: ${banner}`);
  return m[0];
};

test('run: a configuration error is exit 2 with the message on stderr and nothing started', async () => {
  const c = capture();
  const r = await run(['--prot', '1'], {}, c.io, deps);
  assert.equal(r.exitCode, 2);
  assert.equal(r.server, undefined);
  assert.match(c.err.join(''), /Unknown option/);
  assert.deepEqual(c.out, []);

  const noKey = capture();
  assert.equal((await run([], {}, noKey.io, deps)).exitCode, 2, 'real mode without a key');
  assert.match(noKey.err.join(''), /ANTHROPIC_API_KEY/);

  const badCwd = capture();
  assert.equal((await run(fake('--cwd', '/definitely/not/here'), {}, badCwd.io, deps)).exitCode, 2);
  assert.match(badCwd.err.join(''), /is not a directory/);
});

test('run: --help prints the usage and starts nothing', async () => {
  const c = capture();
  const r = await run(['--help'], {}, c.io, deps);
  assert.equal(r.exitCode, 0);
  assert.equal(r.server, undefined);
  const text = c.out.join('');
  for (const flag of ['--host', '--port', '--token', '--token-file', '--allow-local-device', '--cwd', '--fake-claude', '--fake-delay-ms', '--model', '--max-turns', '--pass-env', '--state-dir', '--new-session', '--ask-ttl-sec', '--grace-sec', '--setting-sources']) {
    assert.ok(text.includes(flag), flag);
  }
});

test('run: fake mode comes up, shows the token once, and a device can use it end to end', async (t) => {
  const c = capture();
  const r = await run(fake('--port', '0', '--fake-delay-ms', '0', '--cwd', ROOT), {}, c.io, deps);
  assert.equal(r.exitCode, 0);
  const server = r.server;
  assert.ok(server);
  t.after(() => server.close());

  const banner = c.out.join('');
  assert.equal(banner.split(GEN).length - 1, 1, 'the token is in the banner once');
  const url = portOf(banner);
  assert.equal(url, server.url, 'and the URL shows the port that was actually bound');

  const dev = await DeviceClient.connect(url, GEN);
  dev.say('hello banner');
  const res = await dev.waitFor((m) => m.t === 'result');
  assert.equal(res.t === 'result' && res.text, 'You said: hello banner');
  dev.speak(5); // fake mode has a canned recognizer so push-to-talk can be tried
  const heard = await dev.waitFor((m) => m.t === 'stt');
  assert.equal(heard.t === 'stt' && heard.text, 'please run the tests');
  dev.terminate();

  assert.ok(c.err.length > 2, 'the server logged to stderr');
  assert.equal(c.err.join('').includes(GEN), false, 'and the token is not in the log');
  assert.equal(c.out.join('').split(GEN).length - 1, 1, 'nor was it printed again');
});

test('run: a supplied token is accepted and never printed', async (t) => {
  const c = capture();
  const r = await run(fake('--port', '0', '--cwd', ROOT), { BRIDGE_TOKEN: SUPPLIED }, c.io, deps);
  assert.ok(r.server);
  t.after(() => r.server?.close());
  assert.equal((c.out.join('') + c.err.join('')).includes(SUPPLIED), false);
  const dev = await DeviceClient.connect(r.server.url, SUPPLIED);
  assert.equal(dev.ack?.ok, true);
  dev.terminate();
});

test('run: a port that is already taken is a friendly exit 1', async (t) => {
  const taken = createNetServer();
  await new Promise<void>((resolve) => taken.listen({ host: '127.0.0.1', port: 0 }, resolve));
  t.after(() => void taken.close());
  const port = String((taken.address() as { port: number }).port);
  const c = capture();
  const r = await run(fake('--port', port, '--cwd', ROOT), {}, c.io, deps);
  assert.equal(r.exitCode, 1);
  assert.equal(r.server, undefined);
  assert.match(c.err.join(''), new RegExp(`Port ${port} .*already in use.*--port`));
});

test('run: real mode wires the saved session through, and --new-session forgets it', async (t) => {
  // The real driver starts nothing until the first prompt, so this needs no network and no
  // SDK: hello_ack carries the session id the driver was given to resume.
  const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  saveSession(dir, work, 'saved-session-0001');

  // The device below is on this machine, which a real-mode bridge refuses unless it is told to allow it.
  const args = ['--port', '0', '--cwd', work, '--state-dir', dir, '--allow-local-device'];
  const c1 = capture();
  const r1 = await run(args, { ANTHROPIC_API_KEY: KEY }, c1.io, deps);
  assert.ok(r1.server);
  const d1 = await DeviceClient.connect(r1.server.url, GEN);
  assert.equal(d1.ack?.ok === true && d1.ack.sid, 'saved-session-0001', 'resumed');
  d1.terminate();
  await r1.server.close();
  assert.equal((c1.out.join('') + c1.err.join('')).includes(KEY), false, 'the API key is nowhere in the output');
  assert.match(c1.out.join(''), /REAL/);

  const c2 = capture();
  const r2 = await run([...args, '--new-session'], { ANTHROPIC_API_KEY: KEY }, c2.io, deps);
  assert.ok(r2.server);
  t.after(() => r2.server?.close());
  const d2 = await DeviceClient.connect(r2.server.url, GEN);
  assert.equal(d2.ack?.ok === true && d2.ack.sid, '', 'a fresh conversation');
  d2.terminate();
});

test('run: fake mode keeps no state, so its made-up session ids cannot be resumed by a real run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const c = capture();
  const r = await run(fake('--port', '0', '--fake-delay-ms', '0', '--cwd', ROOT, '--state-dir', dir), {}, c.io, deps);
  assert.ok(r.server);
  t.after(() => r.server?.close());
  const dev = await DeviceClient.connect(r.server.url, GEN);
  dev.say('hello');
  await dev.waitFor((m) => m.t === 'result');
  dev.terminate();
  const { readdirSync } = await import('node:fs');
  assert.deepEqual(readdirSync(dir), []);
});

test('the hard-deny veto handed to the real driver is the describer\'s own deny', () => {
  const deny = hardDenyFor('/work/project');
  assert.match(deny('Bash', { command: 'rm -rf ~' }) ?? '', /recursive delete/);
  assert.equal(deny('Bash', { command: 'npm test' }), undefined, 'and an ordinary command has no veto');
  assert.equal(deny('Read', { file_path: 'src/app.ts' }), undefined);
});

// ===========================================================================
// The token file, local devices, and the child Claude runs in
// ===========================================================================

const tokenFile = (text: string, mode = 0o600): Parameters<typeof parseConfig>[2] => ({ ...deps, readTokenFile: () => ({ text, mode }) });
const real = (...a: string[]): string[] => a;
const KEYENV = { ANTHROPIC_API_KEY: KEY };

test('--token-file: the secret comes from the file, trimmed, is never shown, and is never on the command line', () => {
  let asked = '';
  const c = parseConfig(fake('--token-file', 'secrets/bridge.token'), { BRIDGE_TOKEN: 'from-the-environment-0123' }, {
    ...deps,
    readTokenFile: (path) => {
      asked = path;
      return { text: `${SUPPLIED}\n`, mode: 0o600 };
    },
  });
  assert.equal(asked, resolve('/work/project', 'secrets/bridge.token'), 'a relative path is relative to where you ran it');
  assert.deepEqual([c.token, c.tokenSource, c.tokenGenerated, c.warnings], [SUPPLIED, 'file', false, []], 'and it beats the environment');
  const banner = renderBanner(c, ['ws://127.0.0.1:8787/']).join('\n');
  assert.equal(banner.includes(SUPPLIED), false);
  assert.match(banner, /token file/);
});

test('--token-file: a file others can read is warned about; an empty, missing, short or doubled one is refused', () => {
  const loose = parseConfig(fake('--token-file', '/t'), {}, tokenFile(SUPPLIED, 0o644));
  assert.equal(loose.warnings.length, 1);
  assert.match(loose.warnings[0] ?? '', /can be read by other users \(mode 644\).*chmod 600/);
  assert.deepEqual(parseConfig(fake('--token-file', '/t'), {}, tokenFile(SUPPLIED, 0o600)).warnings, [], 'companion: 0600 is fine');
  assert.deepEqual(parseConfig(fake('--token-file', '/t'), {}, tokenFile(SUPPLIED, 0o400)).warnings, [], 'and so is 0400');

  const refuse = (argv: string[], d: Parameters<typeof parseConfig>[2], re: RegExp): void =>
    assert.throws(() => parseConfig(argv, {}, d), (e: unknown) => e instanceof ConfigError && re.test(e.message), JSON.stringify(argv));
  refuse(fake('--token-file', '/t'), tokenFile('  \n'), /is empty/);
  refuse(fake('--token-file', '/t'), tokenFile('short'), /at least 16/);
  refuse(fake('--token-file', '/t'), tokenFile('has a space inside it 123'), /may only use/);
  refuse(fake('--token-file', '/t', '--token', SUPPLIED), tokenFile(SUPPLIED), /give one of them/);
  refuse(fake('--token-file', '/nope'), { ...deps, readTokenFile: () => { throw Object.assign(new Error('boom'), { code: 'ENOENT' }); } }, /Cannot read --token-file \/nope \(ENOENT\)/);
});

test('--token-file reads a real file, and its mode is the real mode', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-tok-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'token');
  writeFileSync(f, `${SUPPLIED}\n`);
  chmodSync(f, 0o600);
  const ok = parseConfig(fake('--token-file', f), {}, deps);
  assert.deepEqual([ok.token, ok.warnings], [SUPPLIED, []]);
  chmodSync(f, 0o640);
  assert.match(parseConfig(fake('--token-file', f), {}, deps).warnings[0] ?? '', /mode 640/);
});

test('where the token came from decides what is said: a flag warns about ps, the environment is named, a generated one is shown once', () => {
  const flag = cfg(fake('--token', SUPPLIED));
  assert.equal(flag.tokenSource, 'argv');
  assert.equal(flag.warnings.length, 1);
  assert.match(flag.warnings[0] ?? '', /--token puts the secret on the command line.*'ps'.*--token-file/);
  const env = cfg(fake(), { BRIDGE_TOKEN: SUPPLIED });
  assert.deepEqual([env.tokenSource, env.warnings], ['env', []]);
  assert.match(renderBanner(env, ['ws://x/']).join('\n'), /from BRIDGE_TOKEN.*every process of your user/);
  assert.deepEqual([cfg(fake()).tokenSource, cfg(fake('--token', '')).tokenSource], ['generated', 'generated']);
  for (const c of [flag, env]) assert.equal(renderBanner(c, ['ws://x/']).join('\n').includes(SUPPLIED), false, c.tokenSource);
});

test('--allow-local-device: real mode refuses a device on this machine unless told; fake mode always allows it; each case says so', () => {
  assert.equal(cfg(fake()).allowLocalDevice, true);
  assert.equal(cfg(fake('--allow-local-device')).allowLocalDevice, true);
  assert.equal(cfg(real(), KEYENV).allowLocalDevice, false, 'the default of real mode is the safe one');
  assert.equal(cfg(real('--allow-local-device'), KEYENV).allowLocalDevice, true);

  // The default real run on the default host can never be reached by anything; say so.
  const stuck = cfg(real(), KEYENV);
  assert.equal(stuck.warnings.length, 1);
  assert.match(stuck.warnings[0] ?? '', /No device can connect.*refuses a device on its own machine.*--allow-local-device/);
  // A host that other machines can reach has nothing to warn about...
  assert.deepEqual(cfg(real('--host', '0.0.0.0'), KEYENV).warnings.filter((w) => /No device/.test(w)), []);
  // ...and allowing the local one is a risk the operator is told they took.
  const risky = cfg(real('--allow-local-device'), KEYENV);
  assert.equal(risky.warnings.length, 1);
  assert.match(risky.warnings[0] ?? '', /can connect as the device.*approve its own asks.*emulator only/);
  assert.deepEqual(cfg(fake()).warnings, [], 'fake mode has no such risk');
});

test('--pass-env: names are validated, split on commas, repeatable; the secrets that must never reach Claude are refused loudly', () => {
  assert.deepEqual(cfg(real('--pass-env', 'SSH_AUTH_SOCK'), KEYENV).passEnv, ['SSH_AUTH_SOCK']);
  assert.deepEqual(cfg(real('--pass-env', 'A_ONE, B_TWO', '--pass-env', 'C_3,A_ONE'), KEYENV).passEnv, ['A_ONE', 'B_TWO', 'C_3'], 'trimmed and de-duplicated');
  assert.deepEqual(cfg(real(), KEYENV).passEnv, []);
  for (const name of ['BRIDGE_TOKEN', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']) {
    refuses(real('--pass-env', name), KEYENV, new RegExp(`--pass-env ${name} is refused`), name);
  }
  refuses(real('--pass-env', 'SSH_AUTH_SOCK,BRIDGE_TOKEN'), KEYENV, /BRIDGE_TOKEN is refused: it is the credential/, 'among others');
  for (const bad of ['has space', '1LEADING', 'a=b', 'a;rm', '$(x)']) refuses(real('--pass-env', bad), KEYENV, /not an environment variable name/, bad);
  refuses(['--fake-claude', '--pass-env', 'A'], {}, /--pass-env only applies to the real Claude/);
});

test('--model and --max-turns: checked, passed on, shown in the banner, and meaningless in fake mode', () => {
  const c = cfg(real('--model', 'claude-sonnet-4-5', '--max-turns', '12'), KEYENV);
  assert.deepEqual([c.model, c.maxTurns], ['claude-sonnet-4-5', 12]);
  assert.match(renderBanner(c, ['ws://x/']).join('\n'), /model claude-sonnet-4-5, at most 12 turns a prompt/);
  assert.match(renderBanner(cfg(real(), KEYENV), ['ws://x/']).join('\n'), /model default/);
  assert.equal(cfg(real('--model', 'claude-opus-4-1[1m]'), KEYENV).model, 'claude-opus-4-1[1m]');
  for (const bad of ['', ' x', 'a b', '--max-turns', 'x;y', 'é', 'x'.repeat(101)]) refuses(real('--model', bad), KEYENV, /does not look like a model id|argument/, JSON.stringify(bad));
  refuses(real('--max-turns', '0'), KEYENV, /--max-turns must be between 1 and 1000/);
  refuses(real('--max-turns', '1001'), KEYENV, /--max-turns must be between 1 and 1000/);
  refuses(real('--max-turns', 'many'), KEYENV, /whole number/);
  refuses(['--fake-claude', '--model', 'x'], {}, /--model only applies to the real Claude/);
  refuses(['--fake-claude', '--max-turns', '3'], {}, /--max-turns only applies to the real Claude/);
});

test('the real-mode banner says what runs without a tap, which devices are accepted, and which settings are read', () => {
  const text = renderBanner(cfg(real('--host', '0.0.0.0'), KEYENV), ['ws://x/']).join('\n');
  // K9: what THIS Claude Code build has. The bridge's rule is wider (AUTO_RUN_TOOLS), but a banner that names
  // tools the CLI does not offer tells the person that a search is free when it is a Bash ask.
  assert.match(text, /no tap  Read inside the working directory \(a search or a listing is a Bash call and asks\); every other call asks the device first/);
  for (const absent of AUTO_RUN_TOOLS.filter((n) => !CLI_FREE_TOOLS.includes(n))) {
    assert.doesNotMatch(text.split('\n').find((l) => l.includes('no tap')) ?? '', new RegExp(`\\b${absent}\\b`), `${absent} is not a tool this CLI offers`);
  }
  assert.deepEqual(
    CLI_FREE_TOOLS.filter((n) => !AUTO_RUN_TOOLS.includes(n)),
    [],
    'a tool the banner calls free must be one the bridge really lets through without a tap',
  );
  assert.match(text, /devices only on other machines/);
  assert.match(text, /settings none are read: nothing in the repository or in ~\/\.claude can change how Claude runs/);
  assert.match(renderBanner(cfg(real('--allow-local-device'), KEYENV), ['ws://x/']).join('\n'), /devices on this machine AND elsewhere/);
  const fakeText = renderBanner(cfg(fake()), ['ws://x/']).join('\n');
  assert.doesNotMatch(fakeText, /no tap|settings|devices|stall|memory/, 'none of it applies to the scripted Claude');
});

test('D10: with project or local settings opted in, the banner carries a loud block saying what that allows; with none it carries none', () => {
  const block = (sources: string): string =>
    renderBanner(cfg(real('--setting-sources', sources), KEYENV), ['ws://x/']).join('\n');
  for (const sources of ['project', 'local', 'project,local', 'user,project']) {
    const text = block(sources);
    assert.match(text, /WARNING {2}THE REPOSITORY'S OWN SETTINGS ARE ON/, sources);
    assert.match(text, /run commands when Claude starts/, sources);
    assert.match(text, /send your API key and the conversation to another server/, sources);
    assert.match(text, /BEFORE the device is asked about anything/, sources);
    assert.match(text, /best effort/, sources);
    assert.match(text, /--setting-sources none \(the default\) is the only safe setting/, sources);
    assert.match(text, new RegExp(`settings ${sources.replace(',', ', ')} \\(OPT-IN`), sources);
  }
  // Companions: the default, an explicit none and a user-only opt-in (which is the operator's own file) have no such block.
  for (const sources of ['none', 'user']) assert.doesNotMatch(block(sources), /REPOSITORY'S OWN SETTINGS/, sources);
  assert.doesNotMatch(renderBanner(cfg(real(), KEYENV), ['ws://x/']).join('\n'), /REPOSITORY'S OWN SETTINGS/);
  assert.deepEqual(settingsWarning({ settingSources: [] }), []);
  assert.ok(settingsWarning({ settingSources: ['project'] }).length > 5, 'the helper the banner uses is the block itself');
  assert.equal(readsRepositorySettings({ settingSources: ['user'] }), false);
  assert.equal(readsRepositorySettings({ settingSources: ['local'] }), true);
  // The block is for the person at the keyboard: ASCII, and not mixed into the one-line warnings.
  assert.match(settingsWarning({ settingSources: ['project'] }).join('\n'), /^[\x20-\x7e\n]+$/);
  assert.deepEqual(cfg(real('--setting-sources', 'project'), KEYENV).warnings.filter((w) => /REPOSITORY/.test(w)), []);
});

test('D10: the banner says which memory files the bridge read, that they are plain text, and when they were cut', () => {
  const memory = (over: Partial<ProjectMemoryReport>): ProjectMemoryReport => ({ text: 'x', sources: [], truncated: false, skipped: [], ...over });
  const banner = (m: ProjectMemoryReport | undefined, ...args: string[]): string =>
    renderBanner(cfg(real(...args), KEYENV), ['ws://x/'], m === undefined ? {} : { memory: m }).join('\n');

  assert.match(banner(memory({ sources: ['CLAUDE.md', '.claude/CLAUDE.md'] })), /memory {2}CLAUDE\.md, \.claude\/CLAUDE\.md, read by the bridge as plain text \(no @imports followed\)/);
  assert.match(banner(memory({ sources: ['CLAUDE.md'], truncated: true })), /CUT at 40 KB: the rest of it is not given to Claude/);
  assert.doesNotMatch(banner(memory({ sources: ['CLAUDE.md'] })), /CUT at/, 'companion: not cut, not said');
  assert.match(banner(memory({ sources: [] })), /memory {2}none: no CLAUDE\.md or \.claude\/CLAUDE\.md in the working directory/);
  assert.match(banner(memory({ skipped: [{ file: 'CLAUDE.md', why: 'is a link to a file outside the project' }] })), /not used: CLAUDE\.md is a link to a file outside the project/);
  // With the project source on, the CLI loads the file itself, and the banner does not claim to have read it.
  assert.match(banner(undefined, '--setting-sources', 'project'), /memory {2}loaded by Claude Code itself/);
  assert.doesNotMatch(banner(memory({ sources: ['CLAUDE.md'] }), '--setting-sources', 'project'), /read by the bridge/);
  // The stall line states the number, or that there is none.
  assert.match(banner(undefined), /stall {3}a turn with no sign of life from Claude for 300 s is ended \(--turn-stall-sec\)/);
  assert.match(banner(undefined, '--turn-stall-sec', '45'), /for 45 s is ended/);
  assert.match(banner(undefined, '--turn-stall-sec', '0'), /stall {3}a turn is never ended for silence/);
});

// ===========================================================================
// run()'s wiring, line by line
// ===========================================================================

test('buildClaudeConfig: the key, the settings, the hard-deny, the tap rule, the child environment and the model', () => {
  const env = { ANTHROPIC_API_KEY: `  ${KEY}\n`, BRIDGE_TOKEN: SUPPLIED, OTHER: 'x' };
  const c = cfg(real('--pass-env', 'SSH_AUTH_SOCK', '--model', 'm-1', '--max-turns', '9'), env);
  const d = buildClaudeConfig(c, env);
  assert.equal(d.apiKey, KEY, 'the key comes from the environment, trimmed');
  assert.deepEqual(d.passEnv, ['SSH_AUTH_SOCK']);
  assert.equal(d.model, 'm-1');
  assert.equal(d.maxTurns, 9);
  assert.equal(d.stallMs, DEFAULT_STALL_MS, 'the watchdog is on by default, with the driver\'s own default');
  assert.equal(JSON.stringify(d).includes(SUPPLIED), false, 'the bridge token is nowhere in what the driver is given');

  // Which settings files are read is exactly what was asked for: none by default, and an opt-in list as given.
  assert.deepEqual(d.settingSources, [], 'the default driver is given no settings source at all');
  assert.deepEqual(buildClaudeConfig(cfg(real('--setting-sources', 'none'), env), env).settingSources, []);
  assert.deepEqual(buildClaudeConfig(cfg(real('--setting-sources', 'project,local'), env), env).settingSources, ['project', 'local']);
  assert.deepEqual(buildClaudeConfig(cfg(real('--setting-sources', 'user,project'), env), env).settingSources, ['user', 'project']);

  // Without the optional flags the driver is not given the options at all.
  const plain = buildClaudeConfig(cfg(real(), KEYENV), KEYENV);
  assert.equal('model' in plain, false);
  assert.equal('maxTurns' in plain, false);
  assert.deepEqual(plain.passEnv, []);

  // The veto and the tap rule are the describer's, relative to the working directory that was configured.
  const deny = d.hardDeny;
  const ask = d.needsAsk;
  assert.ok(deny && ask, 'both are set: with no needsAsk the driver would ask about everything, with no hardDeny about nothing');
  assert.match(deny('Bash', { command: 'rm -rf ~' }) ?? '', /recursive delete/);
  assert.equal(deny('Bash', { command: 'npm test' }), undefined);
  assert.equal(deny('Bash', { command: 'rm -rf .' }), undefined, 'deleting the project\'s own contents is the human\'s call in /work/project...');
  assert.match(buildClaudeConfig(cfg(real('--cwd', '/'), env), env).hardDeny?.('Bash', { command: 'rm -rf .' }) ?? '', /recursive delete/, '...and the root\'s in /');
  assert.equal(ask('Read', { file_path: '/work/project/src/app.ts' }), false, 'a read inside the project runs without a tap');
  assert.equal(ask('Read', { file_path: 'src/app.ts' }), false);
  for (const [tool, input] of [
    ['Read', { file_path: '/etc/hostname' }],
    ['Bash', { command: 'ls' }],
    ['Write', { file_path: 'a.txt', content: 'x' }],
    ['WebFetch', { url: 'https://example.com/' }],
    ['mcp__x__y', { a: 1 }],
  ] as const) {
    assert.equal(ask(tool, { ...input }), true, `${tool} needs a tap`);
  }
  // The same function the rest of the bridge uses: no second opinion.
  assert.equal(needsAskFor('/work/project')('Bash', { command: 'ls' }), true);
});

test('buildServerOptions: seconds become milliseconds, the host is the flag, the recognizer is canned only in fake mode', async () => {
  const factory: DriverFactory = () => {
    throw new Error('not used');
  };
  const log = (): void => {};
  const r = buildServerOptions(cfg(real('--host', '10.1.2.3', '--port', '9000', '--ask-ttl-sec', '30', '--grace-sec', '7', '--cwd', '/srv/app', '--token', SUPPLIED), KEYENV), factory, { stateDir: '/var/state', log });
  assert.deepEqual(
    { host: r.host, port: r.port, token: r.token, cwd: r.cwd, askTtlMs: r.askTtlMs, graceMs: r.graceMs, allowLocalDevice: r.allowLocalDevice, stateDir: r.stateDir },
    { host: '10.1.2.3', port: 9000, token: SUPPLIED, cwd: '/srv/app', askTtlMs: 30_000, graceMs: 7_000, allowLocalDevice: false, stateDir: '/var/state' },
  );
  assert.equal(r.driverFactory, factory);
  assert.equal(r.log, log);
  assert.equal('stt' in r, false, 'real mode has no recognizer: listen stop says "not set up" rather than pretending');

  const f = buildServerOptions(cfg(fake()), factory);
  assert.ok(f.stt instanceof ScriptedStt, 'fake mode can dictate');
  assert.equal(await f.stt.transcribe(Buffer.alloc(2)), 'please run the tests');
  assert.equal(f.allowLocalDevice, true, 'the scripted demo runs on this machine');
  assert.equal('stateDir' in f, false, 'and keeps no state');

  assert.equal(buildServerOptions(cfg(real('--allow-local-device'), KEYENV), factory).allowLocalDevice, true);
  // The defaults the CLI hands over are the defaults the server would use itself.
  const d = buildServerOptions(cfg(fake()), factory);
  assert.deepEqual([d.askTtlMs, d.graceMs], [DEFAULTS.askTtlMs, DEFAULTS.graceMs]);
});

const nonLoopback = (): string | undefined =>
  Object.values(networkInterfaces()).flat().find((a) => a !== undefined && !a.internal && a.family === 'IPv4')?.address;

/** Resolves with how a TCP connection attempt ended: 'connected' or the error code. */
function tcp(host: string, port: number): Promise<string> {
  return new Promise((resolve) => {
    const s = netConnect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve('connected');
    });
    s.once('error', (e: NodeJS.ErrnoException) => resolve(e.code ?? 'error'));
  });
}

test('run: a default run listens on loopback only, and the bound address says so; a wildcard host really is reachable', async (t) => {
  // 127.0.0.2 is loopback on Linux but is not 127.0.0.1: a server bound to a wildcard answers there, one bound to
  // 127.0.0.1 does not. It stands in for "another address of this machine" where there is no network interface.
  const other = nonLoopback() ?? (process.platform === 'linux' ? '127.0.0.2' : undefined);
  if (other === undefined) return t.skip('no second address on this machine to probe');

  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const c1 = capture();
  const r1 = await run(['--port', '0', '--cwd', work, '--allow-local-device'], KEYENV, c1.io, deps);
  assert.ok(r1.server);
  t.after(() => r1.server?.close());
  assert.equal(r1.server.host, '127.0.0.1', 'bound to the host that was asked for, which is the default');
  assert.equal(await tcp('127.0.0.1', r1.server.port), 'connected', 'the probe works at all');
  assert.equal(await tcp(other, r1.server.port), 'ECONNREFUSED', `and ${other} is not served`);

  // Companion: the same probe DOES get through to a server that was told to listen on every interface.
  const c2 = capture();
  const r2 = await run(fake('--port', '0', '--host', '0.0.0.0', '--cwd', work), {}, c2.io, deps);
  assert.ok(r2.server);
  t.after(() => r2.server?.close());
  assert.equal(r2.server.host, '0.0.0.0');
  assert.equal(await tcp(other, r2.server.port), 'connected', 'so the refusal above was the bind address and not the network');
});

test('run: real mode turns a device on this machine away unless --allow-local-device, and says so before anyone asks', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const closed = capture();
  const r1 = await run(['--port', '0', '--cwd', work], KEYENV, closed.io, deps);
  assert.ok(r1.server);
  t.after(() => r1.server?.close());
  assert.match(closed.out.join(''), /WARNING No device can connect/);
  await assert.rejects(DeviceClient.connect(r1.server.url, GEN), /403/, 'even with the right token');
  assert.match(closed.err.join(''), /admission: refused 1 connection\(s\): refused a device on this machine/);

  const open = capture();
  const r2 = await run(['--port', '0', '--cwd', work, '--allow-local-device'], KEYENV, open.io, deps);
  assert.ok(r2.server);
  t.after(() => r2.server?.close());
  assert.match(open.out.join(''), /WARNING --allow-local-device: a process on this machine can connect as the device/);
  const dev = await DeviceClient.connect(r2.server.url, GEN);
  assert.equal(dev.ack?.ok, true);
  dev.terminate();
  assert.equal((open.out.join('') + open.err.join('')).includes(KEY), false);
});

test('run: a token from --token-file is what the device must send, and it appears nowhere in the output', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-tok-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = join(dir, 'token');
  writeFileSync(f, `${SUPPLIED}\n`, { mode: 0o600 });
  const c = capture();
  const r = await run(fake('--port', '0', '--fake-delay-ms', '0', '--cwd', ROOT, '--token-file', f), {}, c.io, deps);
  assert.ok(r.server);
  t.after(() => r.server?.close());
  assert.equal((await DeviceClient.connect(r.server.url, SUPPLIED)).ack?.ok, true);
  await assert.rejects(DeviceClient.connect(r.server.url, GEN), /token/, 'and the generator was not consulted');
  assert.equal((c.out.join('') + c.err.join('')).includes(SUPPLIED), false);
});

test('fake-device: told no by a real-mode bridge on its own machine, it says which flag lets it in', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const c = capture();
  const r = await run(['--port', '0', '--cwd', work], KEYENV, c.io, deps);
  assert.ok(r.server);
  t.after(() => r.server?.close());
  const err: string[] = [];
  // The input ENDS (after a quit): if the bridge wrongly let the device in, the device would read it and leave with
  // code 0, which the assertion below reports. An input that never ended would make that regression a hang that
  // takes the rest of the run with it (M6).
  const input = new PassThrough();
  input.end('/q\n');
  const code = await runFakeDevice(['--url', r.server.url, '--token', GEN], {}, {
    out: () => {},
    err: (s) => void err.push(s),
    input,
    tty: false,
  });
  assert.equal(code, 1, 'the bridge refused the device (exit 1); 0 would mean it was let in');
  assert.match(err.join(''), /Could not connect.*403/);
  assert.match(err.join(''), /--allow-local-device/);
  assert.equal(err.join('').includes(GEN), false, 'the token is never echoed');
});

// ===========================================================================
// run() itself, through its seams (M3): what it hands over is what the builders make
// ===========================================================================
//
// buildClaudeConfig and buildServerOptions are pure and are checked above. That does not show that
// run() CALLS them and passes the result on unchanged: a one-line edit in run() (the driver given only
// the key, the veto stripped, the grace period forced) used to leave every test green. The seams below
// are how a test sees exactly what run() handed over.

interface Seen {
  config: Config;
  /** What run() gave the driver factory, in order. */
  claude: ClaudeDriverConfig[];
  /** What run() gave startServer, in order. */
  server: ServerOptions[];
  /** The factory the driver seam returned, so the test can see it reached the server options untouched. */
  factory: DriverFactory;
  out: string;
  err: string;
}

const STOPPED: RunningServer = { port: 1, host: '127.0.0.1', url: 'ws://127.0.0.1:1/', close: () => Promise.resolve() };

/** Runs run() with every outward-facing seam replaced by a recorder; nothing is started, no global is touched. */
async function seen(argv: string[], env: Record<string, string | undefined> = KEYENV, over: Partial<RunDeps> = {}): Promise<Seen> {
  const claude: ClaudeDriverConfig[] = [];
  const server: ServerOptions[] = [];
  const factory: DriverFactory = () => {
    throw new Error('not used');
  };
  const c = capture();
  const r = await run(argv, env, c.io, {
    ...deps,
    makeClaudeDriver: (cfg) => {
      claude.push(cfg);
      return factory;
    },
    startServer: (opts) => {
      server.push(opts);
      return Promise.resolve(STOPPED);
    },
    secrets: { set: () => {}, inside: () => [] },
    guardInspector: () => {},
    checkManagedLock: () => Promise.resolve({ effective: true, missing: [], displacedBy: [] }),
    ...over,
  });
  assert.equal(r.exitCode, 0, c.err.join(''));
  assert.ok(r.config);
  return { config: r.config, claude, server, factory, out: c.out.join(''), err: c.err.join('') };
}

/** An object without its function members: what a deep comparison can say about a configuration. */
const dataOf = (o: object): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== 'function'));

/** Calls that tell a veto and a tap rule relative to `cwd` from ones relative to / or ones that were dropped. */
const probes = (cwd: string): ReadonlyArray<readonly [string, Record<string, unknown>]> => [
  ['Bash', { command: 'rm -rf ~' }],
  ['Bash', { command: 'rm -rf .' }],
  ['Bash', { command: 'npm test' }],
  ['Read', { file_path: 'src/app.ts' }],
  ['Read', { file_path: join(cwd, 'src', 'app.ts') }],
  ['Read', { file_path: '/srv/other/file' }],
  ['Read', { file_path: '/etc/hostname' }],
  ['Write', { file_path: 'a.txt', content: 'x' }],
  ['WebFetch', { url: 'https://example.com/' }],
  ['mcp__x__y', { a: 1 }],
];

test('M3: run() gives the driver exactly what buildClaudeConfig makes -- every field, and both functions behave the same', async () => {
  const argv = real('--port', '0', '--cwd', ROOT, '--pass-env', 'SSH_AUTH_SOCK', '--model', 'm-1', '--max-turns', '9', '--turn-stall-sec', '77', '--setting-sources', 'none');
  const s = await seen(argv);
  assert.equal(s.claude.length, 1, 'the driver factory was built once');
  const got = s.claude[0]!;
  const want = buildClaudeConfig(s.config, KEYENV);
  assert.deepEqual(dataOf(got), dataOf(want), 'the data: key, sources, pass-through names, model, turns, stall');
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'and no field is missing or invented');
  assert.equal(got.apiKey, KEY);
  assert.deepEqual([got.model, got.maxTurns, got.stallMs, got.passEnv, got.settingSources], ['m-1', 9, 77_000, ['SSH_AUTH_SOCK'], []]);

  assert.equal(typeof got.hardDeny, 'function', 'the veto reached the driver');
  assert.equal(typeof got.needsAsk, 'function', 'and so did the tap rule');
  let denied = 0;
  let asked = 0;
  for (const [tool, input] of probes(ROOT)) {
    assert.equal(got.hardDeny?.(tool, input), want.hardDeny?.(tool, input), `veto for ${tool} ${JSON.stringify(input)}`);
    assert.equal(got.needsAsk?.(tool, input), want.needsAsk?.(tool, input), `tap rule for ${tool} ${JSON.stringify(input)}`);
    if (got.hardDeny?.(tool, input) !== undefined) denied += 1;
    if (got.needsAsk?.(tool, input) === false) asked += 1;
  }
  // The table can tell the variants apart: something is refused, something is free, something differs by working directory.
  assert.ok(denied >= 1 && asked >= 2, `the probes exercise the rules (denied ${denied}, free ${asked})`);
  assert.equal(got.hardDeny?.('Bash', { command: 'rm -rf .' }), undefined, 'deleting the project\'s own contents is the human\'s call in the project');
  const underRoot = buildClaudeConfig(cfg(real('--cwd', '/'), KEYENV), KEYENV);
  assert.notEqual(underRoot.hardDeny?.('Bash', { command: 'rm -rf .' }), got.hardDeny?.('Bash', { command: 'rm -rf .' }), 'a veto relative to / is not the same veto');
  assert.notEqual(underRoot.needsAsk?.('Read', { file_path: '/srv/other/file' }), got.needsAsk?.('Read', { file_path: '/srv/other/file' }));
});

test('M3: run() gives the server exactly what buildServerOptions makes, and the driver factory it built, untouched', async () => {
  const argv = real('--port', '0', '--cwd', ROOT, '--ask-ttl-sec', '45', '--grace-sec', '20', '--allow-local-device', '--token', SUPPLIED, '--state-dir', '/var/state/x');
  const s = await seen(argv);
  assert.equal(s.server.length, 1);
  const got = s.server[0]!;
  const want = buildServerOptions(s.config, s.factory, { stateDir: '/var/state/x', ...(got.log !== undefined ? { log: got.log } : {}) });
  assert.deepEqual(dataOf(got), dataOf(want), 'host, port, token, cwd, timings, local-device rule, state directory');
  assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), 'and no option is missing or invented (a canned recognizer in real mode would show here)');
  assert.equal(got.driverFactory, s.factory, 'the server runs the driver the composition built, not another one');
  assert.deepEqual([got.askTtlMs, got.graceMs, got.allowLocalDevice, got.token, got.cwd], [45_000, 20_000, true, SUPPLIED, ROOT]);
  assert.equal('stt' in got, false, 'real mode has no canned recognizer');
  assert.equal(typeof got.log, 'function');

  // Companion: fake mode composes differently, and the same check sees it.
  const f = await seen(fake('--port', '0', '--fake-delay-ms', '0', '--cwd', ROOT));
  assert.equal(f.claude.length, 0, 'fake mode never builds the real driver');
  assert.ok(f.server[0]?.stt instanceof ScriptedStt);
});

test('M3: the log run() gives the server writes to stderr with a timestamp, and the token is not in what run() prints', async () => {
  const s = await seen(real('--port', '0', '--cwd', ROOT, '--token', SUPPLIED));
  s.server[0]?.log?.('hello from the server');
  const c = capture();
  const again = await run(real('--port', '0', '--cwd', ROOT), KEYENV, c.io, {
    ...deps,
    makeClaudeDriver: () => () => {
      throw new Error('not used');
    },
    startServer: (opts) => {
      opts.log?.('a line');
      return Promise.resolve(STOPPED);
    },
    secrets: { set: () => {}, inside: () => [] },
    guardInspector: () => {},
  });
  assert.equal(again.exitCode, 0);
  assert.match(c.err.join(''), /^\d{4}-\d\d-\d\dT[\d:.]+Z a line\n$/);
  assert.equal((s.out + s.err).includes(SUPPLIED), false);
});

test('D10: the project memory is read by the bridge and given to the driver as text, unless the project source makes the CLI load it', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-mem-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, '.claude'));
  writeFileSync(join(work, 'imported.md'), 'IMPORTED-SENTINEL');
  writeFileSync(join(work, 'CLAUDE.md'), 'Use tabs in this project.\n@imported.md\n');
  writeFileSync(join(work, '.claude', 'CLAUDE.md'), 'The tests are in test/.\n');

  const base = real('--port', '0', '--cwd', work);
  const s = await seen(base);
  const mem = s.claude[0]?.projectMemory ?? '';
  assert.match(mem, /Use tabs in this project\./);
  assert.match(mem, /The tests are in test\//);
  assert.match(mem, /@imported\.md/, 'an @import is text in front of the model, not a file read');
  assert.doesNotMatch(mem, /IMPORTED-SENTINEL/, 'it was not expanded');
  assert.deepEqual(dataOf(s.claude[0]!), dataOf(buildClaudeConfig(s.config, KEYENV)), 'and it is what the builder makes');
  assert.match(s.out, /memory {2}CLAUDE\.md, \.claude\/CLAUDE\.md, read by the bridge as plain text/);

  // With the project source the CLI loads CLAUDE.md itself: giving it twice would show it twice and follow its @imports.
  for (const sources of ['project', 'user,project', 'project,local']) {
    const p = await seen([...base, '--setting-sources', sources]);
    assert.equal('projectMemory' in (p.claude[0] ?? {}), false, `${sources}: the driver is not given a second copy`);
    assert.match(p.out, /memory {2}loaded by Claude Code itself/, sources);
  }
  // Local or user alone do not load <cwd>/CLAUDE.md, so the bridge still supplies it.
  for (const sources of ['local', 'user']) {
    const p = await seen([...base, '--setting-sources', sources]);
    assert.match(p.claude[0]?.projectMemory ?? '', /Use tabs/, sources);
  }
  assert.equal(bridgeSuppliesMemory({ settingSources: ['project'] }), false);
  assert.equal(bridgeSuppliesMemory({ settingSources: [] }), true);

  // No file, no section: the driver is given no empty text.
  const empty = mkdtempSync(join(tmpdir(), 'tamaclaude-mem-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const none = await seen(real('--port', '0', '--cwd', empty));
  assert.equal('projectMemory' in (none.claude[0] ?? {}), false);
  assert.match(none.out, /memory {2}none: no CLAUDE\.md/);
});

test('D10: an oversized or foreign memory file is capped, announced, or left out -- and the banner says so', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-mem-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  writeFileSync(join(work, 'CLAUDE.md'), `${'rule\n'.repeat(MEMORY_MAX_BYTES)}`);
  const big = await seen(real('--port', '0', '--cwd', work));
  assert.ok((big.claude[0]?.projectMemory ?? '').length <= MEMORY_MAX_BYTES + 400, 'capped');
  assert.match(big.claude[0]?.projectMemory ?? '', /cut at 40 KB/, 'the model is told it has part of a file');
  assert.match(big.out, /CUT at 40 KB/, 'and so is the person');

  // A link to a file elsewhere is not read, and the person is told it was not used.
  const outside = mkdtempSync(join(tmpdir(), 'tamaclaude-out-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'secret.md'), 'ELSEWHERE-SENTINEL');
  rmSync(join(work, 'CLAUDE.md'));
  symlinkSync(join(outside, 'secret.md'), join(work, 'CLAUDE.md'));
  const linked = await seen(real('--port', '0', '--cwd', work));
  assert.equal('projectMemory' in (linked.claude[0] ?? {}), false);
  assert.equal(JSON.stringify(linked.claude[0]).includes('ELSEWHERE-SENTINEL'), false);
  assert.match(linked.out, /not used: CLAUDE\.md is a link to a file outside the project/);
});

test('D15: --turn-stall-sec: a whole number of seconds, 0 turns it off, real mode only, and the driver gets milliseconds', async () => {
  assert.equal(cfg(real(), KEYENV).turnStallSec, DEFAULT_STALL_MS / 1000);
  assert.equal(cfg(real('--turn-stall-sec', '45'), KEYENV).turnStallSec, 45);
  assert.equal(cfg(real('--turn-stall-sec', '0'), KEYENV).turnStallSec, 0, 'zero is allowed: it means never');
  assert.equal(cfg(real('--turn-stall-sec', '3600'), KEYENV).turnStallSec, 3600);
  refuses(real('--turn-stall-sec', '3601'), KEYENV, /--turn-stall-sec must be between 0 and 3600/);
  refuses(real('--turn-stall-sec', 'soon'), KEYENV, /whole number/);
  refuses(real('--turn-stall-sec=-5'), KEYENV, /whole number/);
  refuses(['--fake-claude', '--turn-stall-sec', '9'], {}, /--turn-stall-sec only applies to the real Claude/);

  assert.equal(buildClaudeConfig(cfg(real('--turn-stall-sec', '45'), KEYENV), KEYENV).stallMs, 45_000);
  assert.equal(buildClaudeConfig(cfg(real('--turn-stall-sec', '0'), KEYENV), KEYENV).stallMs, 0, '0 reaches the driver as "disabled", not as the default');
  assert.equal((await seen(real('--port', '0', '--cwd', ROOT, '--turn-stall-sec', '12'))).claude[0]?.stallMs, 12_000, 'and run() passes it on');
});

test('S5/M13: run() registers the bridge\'s own credential files with the tool rules, and warns when one is inside the project', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const calls: string[][] = [];
  const spy = (inside: string[] = []): RunDeps['secrets'] => ({
    set: (paths) => void calls.push([...paths]),
    inside: () => inside,
  });

  // A token FILE and the state directory, both absolute.
  const tokenPath = join(work, 'elsewhere.txt');
  await seen(real('--port', '0', '--cwd', work, '--token-file', tokenPath, '--state-dir', '/var/state/x'), KEYENV, {
    secrets: spy(),
    readTokenFile: () => ({ text: SUPPLIED, mode: 0o600 }),
  });
  assert.deepEqual(calls.pop(), [tokenPath, '/var/state/x'], 'exactly the token file and the state directory');

  // A token that did not come from a file has no path to register; the state directory still does.
  await seen(real('--port', '0', '--cwd', work, '--token', SUPPLIED, '--state-dir', '/var/state/y'), KEYENV, { secrets: spy() });
  assert.deepEqual(calls.pop(), ['/var/state/y']);
  await seen(real('--port', '0', '--cwd', work, '--state-dir', '/var/state/z'), { ...KEYENV, BRIDGE_TOKEN: SUPPLIED }, { secrets: spy() });
  assert.deepEqual(calls.pop(), ['/var/state/z']);

  // The fake Claude runs no tools and keeps no state: nothing to protect, nothing registered.
  await seen(fake('--port', '0', '--cwd', work, '--fake-delay-ms', '0'), {}, { secrets: spy() });
  assert.deepEqual(calls, []);

  // The warning: present when the registry says a file lies inside the working directory, absent otherwise.
  const inside = await seen(real('--port', '0', '--cwd', work, '--token-file', join(work, 'bridge.token')), KEYENV, {
    secrets: spy([join(work, 'bridge.token')]),
    readTokenFile: () => ({ text: SUPPLIED, mode: 0o600 }),
  });
  assert.equal(inside.config.warnings.filter((w) => /inside the working directory/.test(w)).length, 1);
  assert.match(inside.out, /WARNING The bridge's own file \(.*bridge\.token\) is inside the working directory\. Claude can read it only after a tap/);
  const outside = await seen(real('--port', '0', '--cwd', work), KEYENV, { secrets: spy([]) });
  assert.deepEqual(outside.config.warnings.filter((w) => /inside the working directory/.test(w)), [], 'companion: nothing inside, nothing said');
});

test('S5/M13 end to end: with the REAL registry, a read of the token file is asked about at high risk inside the project, and an ordinary file is free', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  t.after(() => setBridgeSecrets([])); // the registry is process-wide; leave it as found
  const tokenPath = join(work, 'notes.txt'); // an innocent name: only the registration can make it a secret
  writeFileSync(tokenPath, SUPPLIED);
  writeFileSync(join(work, 'other.txt'), 'ordinary');
  const free = (file: string): ReturnType<typeof describeTool> => describeTool('Read', { file_path: file }, work);

  assert.equal(free(tokenPath).risk, 'low', 'control: before the registration it is an ordinary file in the project');
  const s = await seen(real('--port', '0', '--cwd', work, '--token-file', tokenPath, '--state-dir', join(work, 'state')), KEYENV, {
    secrets: undefined as unknown as RunDeps['secrets'], // the default: tools.ts itself
    readTokenFile: () => ({ text: SUPPLIED, mode: 0o600 }),
  });
  assert.equal(free(tokenPath).risk, 'high', 'after run(), the token file is a secret store');
  assert.equal(s.claude[0]?.needsAsk?.('Read', { file_path: tokenPath }), true, 'and the rule the driver is handed asks about it');
  assert.equal(free(join(work, 'other.txt')).risk, 'low', 'companion: the registration is for those paths, not for the project');
  assert.equal(s.claude[0]?.needsAsk?.('Read', { file_path: join(work, 'other.txt') }), false);
  assert.equal(free(join(work, 'state', 'session.json')).risk, 'high', 'the state directory too');
  assert.match(s.out, /WARNING The bridge's own files \(.*\) are inside the working directory/, 'and the person is told both sit in the project');
});

test('K3/M5: with a settings source on, run() asks whether the policy-tier lock is in force and says so when it is not', async () => {
  const lock = (over: Partial<ManagedLockStatus>): ManagedLockStatus => ({ effective: true, missing: [], displacedBy: [], ...over });
  const asked: string[] = [];
  const check = (answer: ManagedLockStatus | undefined): RunDeps['checkManagedLock'] => (cwd) => {
    asked.push(cwd);
    return Promise.resolve(answer);
  };

  const fine = await seen(real('--port', '0', '--cwd', ROOT, '--setting-sources', 'project'), KEYENV, { checkManagedLock: check(lock({})) });
  assert.deepEqual(asked.splice(0), [ROOT], 'asked once, about the working directory');
  assert.deepEqual(fine.config.warnings.filter((w) => /policy tier|lock/.test(w)), [], 'in force: nothing to add');

  const displaced = await seen(real('--port', '0', '--cwd', ROOT, '--setting-sources', 'project,local'), KEYENV, {
    checkManagedLock: check(lock({ effective: false, missing: ['allowManagedHooksOnly'], displacedBy: ['file'] })),
  });
  assert.deepEqual(asked.splice(0), [ROOT]);
  assert.match(displaced.out, /WARNING An administrator's policy tier \(file\) is active on this machine, so the lock .* is NOT in force \(allowManagedHooksOnly not applied\)\. The repository's hooks can run commands; only the bridge's own ask hook still guards tool calls\./);

  const unknown = await seen(real('--port', '0', '--cwd', ROOT, '--setting-sources', 'user'), KEYENV, { checkManagedLock: check(undefined) });
  assert.deepEqual(asked.splice(0), [ROOT]);
  assert.match(unknown.out, /WARNING Could not verify whether the policy-tier lock .* is in force/);

  // Companion: with no source there is nothing for the lock to guard, so nothing is asked and nothing is said.
  const none = await seen(real('--port', '0', '--cwd', ROOT), KEYENV, { checkManagedLock: check(lock({ effective: false, missing: ['x' as never] })) });
  assert.deepEqual(asked, [], 'not even asked');
  assert.doesNotMatch(none.out, /policy tier/);

  assert.equal(lockWarning(lock({})), undefined);
  assert.match(lockWarning(lock({ effective: false, missing: ['allowManagedPermissionRulesOnly', 'allowManagedHooksOnly'] })) ?? '', /allowManagedPermissionRulesOnly, allowManagedHooksOnly not applied/);
});

test('D14: neutraliseInspector installs one SIGUSR1 handler, once; real mode asks for it and fake mode does not', async () => {
  const handlers = new Map<string, Array<() => void>>();
  const proc = { on: (sig: string, fn: () => void) => void handlers.set(sig, [...(handlers.get(sig) ?? []), fn]) } as unknown as NodeJS.Process;
  const c = capture();
  neutraliseInspector(c.io, proc);
  neutraliseInspector(c.io, proc);
  assert.equal(handlers.get('SIGUSR1')?.length, 1, 'idempotent: a second call adds nothing');
  assert.deepEqual([...handlers.keys()], ['SIGUSR1'], 'and it touches no other signal');
  handlers.get('SIGUSR1')?.[0]?.();
  assert.match(c.err.join(''), /SIGUSR1 ignored: this bridge does not open the Node inspector on a signal\./);

  let guarded = 0;
  await seen(real('--port', '0', '--cwd', ROOT), KEYENV, { guardInspector: () => void (guarded += 1) });
  assert.equal(guarded, 1, 'real mode');
  await seen(fake('--port', '0', '--cwd', ROOT), {}, { guardInspector: () => void (guarded += 1) });
  assert.equal(guarded, 1, 'fake mode runs no tools, and keeps the control possible');
});

// ===========================================================================
// README.md is held to the code on the points that are security claims
// ===========================================================================

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
/** The README with its line breaks and indentation folded, so a sentence can be matched wherever it wraps. */
const READ_FLAT = README.replace(/\s+/g, ' ');
const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };

/** The rows of the Flags table: flag -> [default cell, description cell], backticks removed. */
function flagRows(): Map<string, [string, string]> {
  const table = README.slice(README.indexOf('## Flags'), README.indexOf('`SIGINT` and `SIGTERM`'));
  const rows = new Map<string, [string, string]>();
  for (const line of table.split('\n')) {
    const cells = line.trim().startsWith('|') ? line.trim().slice(1, -1).split('|').map((c) => c.trim()) : [];
    const flag = /^`(--[a-z-]+)`$/.exec(cells[0] ?? '')?.[1];
    if (flag !== undefined) rows.set(flag, [(cells[1] ?? '').replace(/`/g, ''), cells[2] ?? '']);
  }
  return rows;
}

test('README: lists every flag, the exact set that runs without a tap, and the exact environment the child gets', () => {
  const usage = [...USAGE.matchAll(/^\s+(?:-h, )?(--[a-z-]+)/gm)].map((m) => m[1]!);
  assert.ok(usage.length >= 17, 'the usage text was not read');
  const rows = flagRows();
  for (const flag of usage.filter((f) => f !== '--help')) assert.ok(rows.has(flag), `${flag} is not in the README's flags table`);
  for (const flag of rows.keys()) assert.ok(usage.includes(flag), `the README documents ${flag}, which the usage text does not have`);

  // K9: the bullet names what THIS build has -- the banner's own constant -- and the next sentence names the bridge's wider rule.
  const bullet = /\*\*Exactly one tool runs without a tap in the Claude Code build this bridge ships with: ((?:`[A-Za-z]+`(?:, | and )?)+), inside the working directory\.\*\*/.exec(READ_FLAT)?.[1];
  assert.ok(bullet, 'the README no longer states which tool runs without a tap in this build');
  const named = [...bullet.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!);
  assert.deepEqual(named.sort(), [...CLI_FREE_TOOLS].sort(), 'the README and the banner disagree about what needs no tap in this build');
  assert.equal(CLI_FREE_TOOLS.length, 1, 'the sentence says "exactly one tool"');
  const wider = /it also lets ((?:`[A-Za-z]+`(?:, | and )?)+) through when they are inside the project/.exec(READ_FLAT)?.[1];
  assert.ok(wider, 'the README no longer states the bridge\'s own, wider rule');
  assert.deepEqual([...wider.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!).sort(), [...AUTO_RUN_TOOLS].sort(), 'the README and tools.ts disagree about the bridge\'s rule');

  // The tools the model is not offered: every name, from the one list.
  const refused = /not offered, and is refused if it asks for, the tools a voice device cannot serve:\*\*((?:\s*`[A-Za-z]+`,?|\s+and)+)/.exec(READ_FLAT)?.[1];
  assert.ok(refused, 'the README no longer lists the tools that are refused');
  assert.deepEqual([...refused.matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1]!).sort(), [...UNSERVED_TOOL_NAMES].sort(), 'the README and tools.ts disagree about which tools are refused');

  // The environment allowlist, by name.
  const env = README.slice(README.indexOf('### What the commands Claude runs can see'), README.indexOf('### Who may connect'));
  for (const name of [...CHILD_ENV_NAMES].filter((n) => n === n.toUpperCase() || !CHILD_ENV_NAMES.has(n.toUpperCase()))) {
    assert.ok(env.includes(`\`${name}\``), `${name} is passed to the child but the README does not say so`);
  }
  for (const prefix of CHILD_ENV_PREFIXES) assert.ok(env.includes(`\`${prefix}*\``), `${prefix}* is passed but not in the README`);
  assert.match(env, /`BRIDGE_TOKEN`[^.]*\*\*stay behind\*\*/);

  // No claim the code no longer makes.
  assert.doesNotMatch(README, /one-line change/);
  assert.doesNotMatch(README, /Where this implementation and PROTOCOL\.md differ/);
  assert.doesNotMatch(README, /xxd/, 'the token recipe silently produced an empty token without xxd');
  assert.doesNotMatch(READ_FLAT, /CLAUDE\.md and env apply/, 'the old banner claim');
  assert.doesNotMatch(READ_FLAT, /Settings files cannot skip the ask/, 'the old heading, which was only true of permission rules');
  assert.doesNotMatch(READ_FLAT, /either alone is enough/, 'the two layers are best effort, and one of them is dropped on a managed machine');
  assert.doesNotMatch(READ_FLAT, /a repository cannot redirect the API key/i);
});

test('C8: the README flag table\'s defaults and ranges are the program\'s', () => {
  const rows = flagRows();
  const cell = (flag: string): string => rows.get(flag)?.[0] ?? assert.fail(`${flag} is not in the table`);
  const note = (flag: string): string => rows.get(flag)?.[1] ?? '';
  const c = cfg(real(), KEYENV);
  assert.equal(cell('--host'), c.host);
  assert.equal(cell('--port'), String(c.port));
  assert.equal(cell('--ask-ttl-sec'), String(DEFAULTS.askTtlMs / 1000));
  assert.equal(cell('--grace-sec'), String(DEFAULTS.graceMs / 1000));
  assert.equal(cell('--fake-delay-ms').split(' ')[0], String(cfg(fake()).fakeDelayMs));
  assert.equal(cell('--turn-stall-sec'), String(DEFAULT_STALL_MS / 1000));
  assert.equal(cell('--setting-sources'), 'none');
  assert.deepEqual(c.settingSources, [], 'and "none" is what the program does');
  assert.equal(cell('--max-turns'), 'unlimited');
  assert.equal(c.maxTurns, undefined);
  assert.equal(cell('--state-dir').split(',')[0], '$XDG_STATE_HOME/tamaclaude-bridge');
  assert.match(cell('--token'), /^\$BRIDGE_TOKEN, else generated$/);
  assert.equal(cell('--allow-local-device'), 'off (on in fake mode)');
  assert.equal(c.allowLocalDevice, false);
  assert.equal(cfg(fake()).allowLocalDevice, true);

  // Ranges: "(a to b)" in a row means a is accepted, b is accepted, and one past either end is refused.
  let ranges = 0;
  for (const [flag, [, desc]] of rows) {
    const m = /\((\d+) to (\d+)[;)]/.exec(desc);
    if (m === null) continue;
    ranges += 1;
    const [lo, hi] = [Number(m[1]), Number(m[2])];
    const accepts = (n: number): boolean => {
      try {
        cfg(real(flag, String(n)), KEYENV);
        return true;
      } catch (e) {
        if (e instanceof ConfigError) return false;
        throw e;
      }
    };
    assert.deepEqual([accepts(lo), accepts(hi), accepts(hi + 1)], [true, true, false], `${flag}: the README says ${lo} to ${hi}`);
    if (lo > 0) assert.equal(accepts(lo - 1), false, `${flag}: one below ${lo}`);
  }
  assert.ok(ranges >= 3, `only ${ranges} ranges were found in the table: the check is not reading it`);
  assert.match(note('--turn-stall-sec'), /\(0 to 3600; `0` never\)/);
});

test('C8/C10: the README\'s admission numbers and lockout wording are the server\'s', () => {
  const secs = (ms: number): number => ms / 1000;
  assert.match(READ_FLAT, new RegExp(`\\(${DEFAULTS.maxConnections} in all, ${DEFAULTS.maxConnectionsPerAddress} per address, whether or not they ever speak\\)`));
  assert.match(READ_FLAT, new RegExp(`finish its HTTP request within ${secs(DEFAULTS.headersTimeoutMs)} seconds and say \`hello\` within ${secs(DEFAULTS.helloTimeoutMs)}`));
  assert.match(READ_FLAT, /A wrong token waits half a second before it is refused/);
  assert.equal(DEFAULTS.authFailDelayMs, 500);
  // The first FIVE are free; the SIXTH earns the first pause (2 s), which then doubles to 5 minutes.
  assert.match(READ_FLAT, new RegExp(`the first ${['', 'one', 'two', 'three', 'four', 'five'][DEFAULTS.authFreeFailures]} are answered as usual, the sixth pauses the address for ${secs(DEFAULTS.authLockoutBaseMs)} seconds, and each further wrong token doubles the pause up to ${secs(DEFAULTS.authLockoutMaxMs) / 60} minutes`));
  assert.equal(DEFAULTS.authFreeFailures + 1, 6, 'the sixth');
  assert.doesNotMatch(READ_FLAT, /after five, the address is paused/);
  assert.match(READ_FLAT, new RegExp(`more than ${DEFAULTS.maxOpenAsks} asks open at once`));
  assert.match(READ_FLAT, /ask_rsp/);
});

test('S4: npm start carries --disable-sigusr1, the README says what that does and does not do, and the in-code guard is real-mode only', () => {
  assert.match(PACKAGE.scripts['start'] ?? '', /(^|\s)--disable-sigusr1(\s|$)/, 'the start script closes the inspector signal');
  assert.match(READ_FLAT, /`npm start` is `node --disable-sigusr1 src\/main\.ts`/);
  assert.match(READ_FLAT, /closes one road, not the class/);
  assert.match(READ_FLAT, /Anything running as your user can take over the bridge/);
  assert.match(READ_FLAT, /removes the WebSocket road to the asks and only that road/);
  assert.equal(PACKAGE.scripts['test:real-cli']?.includes('BRIDGE_REAL_CLI=1'), true, 'K10: the opt-in suite has a script, and the README names it');
  assert.match(README, /npm run test:real-cli/);
  assert.match(READ_FLAT, /Nothing runs it automatically/);
});

test('S7/S8/C9: the README states what is NOT guaranteed, in so many words', () => {
  const must: Array<[RegExp, string]> = [
    [/Anything running as your user can take over the bridge/, 'same-user processes'],
    [/A container, a virtual machine or another network namespace connects from an address that is not one of this machine's own/, 'containers and VMs'],
    [/a TLS-terminating proxy on this machine always arrives from loopback and is refused/, 'the proxy trap'],
    [/on a machine that has an administrator's policy tier .* the bridge's lock is dropped by Claude Code/, 'the policy tier'],
    [/a repository can still replace `ANTHROPIC_API_KEY` with its own/, 'repository settings in an opt-in mode'],
    [/`none` is the only safe setting for a repository you do not trust/, 'the only safe setting'],
    [/All of that is best effort, and it is not a guarantee/, 'the pins'],
    [/Hard-deny is a backstop, not a guarantee/, 'hard-deny'],
    [/a sub-agent's brief is not shown at all/, 'what Agent summaries cannot show'],
    [/`~\/\.aws`, `~\/\.ssh`, `~\/\.config\/gh`, `~\/\.npmrc` and the like are reachable by any command you approve/, 'credential files under HOME'],
    [/leaves it behind/, 'secrets outliving the process'],
    [/A loop of free reads costs money/, 'cost'],
  ];
  for (const [re, what] of must) assert.match(READ_FLAT, re, what);
});

test('installShutdown: a signal closes the server then exits 0; a second signal forces exit 1', async () => {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const proc = {
    on: (sig: string, fn: () => void) => void handlers.set(sig, fn),
    exit: (code: number) => void exits.push(code),
  } as unknown as NodeJS.Process;
  let closed = 0;
  let finish: () => void = () => {};
  const server = {
    port: 0,
    host: '127.0.0.1',
    url: '',
    close: () => {
      closed += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  const c = capture();
  installShutdown(server, c.io, proc);
  assert.deepEqual([...handlers.keys()].sort(), ['SIGINT', 'SIGTERM']);

  handlers.get('SIGTERM')?.();
  assert.equal(closed, 1);
  assert.deepEqual(exits, [], 'not before the server has closed');
  handlers.get('SIGINT')?.(); // impatient
  assert.deepEqual(exits, [1]);
  assert.equal(closed, 1, 'and it did not try to close twice');
  finish();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(exits, [1, 0]);
});

// ===========================================================================
// Child processes: the real entry points
// ===========================================================================

interface Child {
  proc: ChildProcess;
  out: () => string;
  err: () => string;
  /** Resolves with the match as soon as stdout (or stderr) matches. */
  waitOut(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  waitErr(re: RegExp, ms?: number): Promise<RegExpMatchArray>;
  write(text: string): void;
  end(): void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function spawnNode(t: TestContext, script: string, args: string[], env: Record<string, string>, nodeArgs: string[] = []): Child {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean['ANTHROPIC_API_KEY'];
  delete clean['BRIDGE_TOKEN'];
  const proc = spawn(process.execPath, [...nodeArgs, script, ...args], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
  LIVE_CHILDREN.add(proc);
  t.after(() => void proc.kill('SIGKILL'));
  let out = '';
  let err = '';
  const waiters: (() => void)[] = [];
  const wake = (): void => waiters.forEach((w) => w());
  proc.stdout?.setEncoding('utf8').on('data', (d: string) => ((out += d), wake()));
  proc.stderr?.setEncoding('utf8').on('data', (d: string) => ((err += d), wake()));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('close', (code, signal) => {
      resolve({ code, signal });
      wake();
    });
  });
  const wait = (get: () => string, re: RegExp, ms: number): Promise<RegExpMatchArray> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        const m = re.exec(get());
        if (m === null) return false;
        resolve(m);
        return true;
      };
      if (check()) return;
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${re}\nstdout:\n${out}\nstderr:\n${err}`)), ms);
      const w = (): void => {
        if (check()) clearTimeout(timer);
      };
      waiters.push(w);
      // A process that has ended will never print what is awaited: say so now, with what it did print, instead of
      // after the full wait (a wiring regression made every child-process test wait out its 10 s, one after the other).
      void exited.then(({ code, signal }) => {
        if (check()) return;
        clearTimeout(timer);
        reject(new Error(`the process ended (code ${code}, signal ${signal}) before ${re} appeared\nstdout:\n${out}\nstderr:\n${err}`));
      });
    });
  return {
    proc,
    out: () => out,
    err: () => err,
    waitOut: (re, ms = 10_000) => wait(() => out, re, ms),
    waitErr: (re, ms = 10_000) => wait(() => err, re, ms),
    write: (text) => void proc.stdin?.write(text),
    end: () => void proc.stdin?.end(),
    exited,
  };
}

async function startBridge(t: TestContext, extra: string[] = []): Promise<{ child: Child; url: string }> {
  const child = spawnNode(t, MAIN, ['--fake-claude', '--fake-delay-ms', '50', '--port', '0', ...extra], { BRIDGE_TOKEN: SUPPLIED });
  const m = await child.waitOut(/listen\s+(ws:\/\/\S+)/);
  return { child, url: m[1] ?? '' };
}

test('importing the module starts nothing', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(MAIN).href)});`], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, ANTHROPIC_API_KEY: '', BRIDGE_TOKEN: '' },
  });
  assert.equal(r.signal, null, 'it exited by itself instead of sitting on a port');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '', 'and printed no banner');
});

test('the program refuses a missing key with a message and exit 2, and prints no banner', async (t) => {
  const child = spawnNode(t, MAIN, ['--port', '0'], {});
  const { code } = await child.exited;
  assert.equal(code, 2);
  assert.match(child.err(), /ANTHROPIC_API_KEY/);
  assert.equal(child.out(), '');
});

test('SIGTERM and SIGINT close the port and exit 0', async (t) => {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    const { child, url } = await startBridge(t);
    const port = Number(new URL(url).port);
    const dev = await DeviceClient.connect(url, SUPPLIED);
    assert.equal(dev.ack?.ok, true, 'it was serving');
    child.proc.kill(sig);
    const { code } = await child.exited;
    assert.equal(code, 0, `${sig}: ${child.err()}`);
    assert.match(child.err(), new RegExp(`${sig} received`));
    assert.equal((await dev.waitClosed()).code, 1001, 'the connected device was told the bridge is going away');
    await assert.rejects(DeviceClient.open(`ws://127.0.0.1:${port}/`), `${sig}: nobody listens on the port any more`);
  }
});

test('S4/D14: SIGUSR1 does not open the Node inspector on a real-mode bridge, which keeps serving; the same signal does open it where the guard is absent', async (t) => {
  // --inspect-port=0 makes the inspector, if anything opens it, pick a free port instead of 9229, so a
  // second bridge (or another tool) on this machine can neither hide a failure nor cause one. The flag by itself
  // opens nothing: the inspector starts only on the signal, which is exactly what is under test. The child is
  // started WITHOUT --disable-sigusr1, so what is tested is the code, not npm's script.
  const work = mkdtempSync(join(tmpdir(), 'tamaclaude-cwd-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const args = ['--port', '0', '--cwd', work, '--allow-local-device', '--token', SUPPLIED, '--state-dir', join(work, 'state')];

  const guarded = spawnNode(t, MAIN, args, { ANTHROPIC_API_KEY: KEY }, ['--inspect-port=0']);
  const url = (await guarded.waitOut(/listen\s+(ws:\/\/\S+)/))[1] ?? '';
  guarded.proc.kill('SIGUSR1');
  // Whichever comes first: the bridge saying it ignored the signal, or Node saying it opened the inspector. Racing them turns
  // the regression into a failure now, not after the full wait for a message that will never come.
  const ignored = guarded.waitErr(/SIGUSR1 ignored: this bridge does not open the Node inspector/).then(() => 'ignored', () => 'silence');
  const opened = guarded.waitErr(/Debugger listening on (\S+)/).then((m) => `inspector opened at ${m[1]}`, () => 'silence');
  assert.equal(await Promise.race([ignored, opened]), 'ignored', 'SIGUSR1 must be ignored, not turned into an open inspector');
  // Give an inspector that was going to open the time to say so: a connection round trip through the same process.
  const dev = await DeviceClient.connect(url, SUPPLIED);
  assert.equal(dev.ack?.ok, true, 'and the bridge went on serving');
  dev.terminate();
  assert.doesNotMatch(guarded.err(), /Debugger listening/, 'nothing opened an inspector');
  assert.equal(guarded.proc.exitCode, null, 'and the process is alive');

  // The control: the fake bridge installs no guard, and the very same signal does start the inspector. Without
  // this the assertion above would be true on a Node where the signal does nothing at all.
  const open = spawnNode(t, MAIN, ['--fake-claude', '--fake-delay-ms', '50', '--port', '0'], { BRIDGE_TOKEN: SUPPLIED }, ['--inspect-port=0']);
  await open.waitOut(/listen\s+(ws:\/\/\S+)/);
  open.proc.kill('SIGUSR1');
  await open.waitErr(/Debugger listening on ws:\/\/127\.0\.0\.1:\d+\//);
});

test('fake-device: type a request, see the pet change, approve with /y, and quit', async (t) => {
  const { url } = await startBridge(t);
  const dev = spawnNode(t, DEVICE, ['--url', url], { BRIDGE_TOKEN: SUPPLIED });
  await dev.waitOut(/connected to/);
  await dev.waitOut(/\(o_o\)\s+idle/);

  dev.write('run the tests\n');
  await dev.waitOut(/\(-_-\)\?\s+thinking/);
  await dev.waitOut(/\(>_<\)~\s+tool: Bash/);
  await dev.waitOut(/APPROVE\?\s+Bash\s+risk: MED[\s\S]*npm test[\s\S]*\d+ s to answer/);
  assert.ok(dev.out().includes('\x07'), 'the bell rang for the ask');
  await dev.waitOut(/\(O_O\)!\s+asking: Bash\s+\(1 ask open\)/);

  dev.write('/y\n');
  await dev.waitOut(/ask [0-9a-f]{8} ended: answered/);
  await dev.waitOut(/RESULT \(ok\): I ran npm test\./);
  await dev.waitOut(/\(\^_\^\)\s+done/);

  dev.write('/q\n');
  const { code } = await dev.exited;
  assert.equal(code, 0, dev.err());
});

test('fake-device: /n denies, /a aborts, /l dictates through the listen path', async (t) => {
  const { url } = await startBridge(t);
  const dev = spawnNode(t, DEVICE, ['--url', url], { BRIDGE_TOKEN: SUPPLIED });
  await dev.waitOut(/\(o_o\)\s+idle/);

  dev.write('/y\n'); // nothing to answer yet
  await dev.waitOut(/no ask is open/);

  dev.write('/send\n'); // nothing has been heard yet
  await dev.waitOut(/nothing was heard yet/);

  dev.write('/l\n'); // the canned recognizer hears "please run the tests"
  await dev.waitOut(/\(O_O\)>\s+listening/);
  await dev.waitOut(/heard: "please run the tests"/);
  await dev.waitOut(/heard: "please run the tests"[^]*\(o_o\)\s+idle/); // and the pet rests: nothing has been sent
  assert.doesNotMatch(dev.out(), /APPROVE\?/, 'dictation alone asked for nothing');
  dev.write('/send\n'); // the player's SEND tap
  await dev.waitOut(/APPROVE\?/);
  dev.write('/n\n');
  await dev.waitOut(/RESULT \(ok\):.*denied/);

  dev.write('a slow search\n');
  await dev.waitOut(/tool: Grep/);
  dev.write('/a\n');
  await dev.waitOut(/RESULT \(failed\): Stopped before finishing\./);

  dev.write('/nonsense\n');
  await dev.waitOut(/unknown command \/nonsense/);
  dev.write('café\n'); // the real device could not send this either
  await dev.waitOut(/cannot send that/);

  dev.write('/q\n');
  assert.equal((await dev.exited).code, 0, dev.err());
});

test('fake-device: when input ends it waits for the turn to finish, then leaves', async (t) => {
  const { url } = await startBridge(t);
  const dev = spawnNode(t, DEVICE, ['--url', url], { BRIDGE_TOKEN: SUPPLIED });
  await dev.waitOut(/\(o_o\)\s+idle/);
  dev.write('hello from a script\n');
  dev.end();
  const { code } = await dev.exited;
  assert.equal(code, 0, dev.err());
  assert.match(dev.out(), /RESULT \(ok\): You said: hello from a script/);
});

test('fake-device: when input ends right after a dictation it leaves, because no turn follows a transcript', async (t) => {
  const { url } = await startBridge(t);
  const dev = spawnNode(t, DEVICE, ['--url', url], { BRIDGE_TOKEN: SUPPLIED });
  await dev.waitOut(/\(o_o\)\s+idle/);
  dev.write('/l\n');
  dev.end();
  // A device that waited for a result would wait for ever: nothing runs until the transcript is sent.
  const done = await Promise.race([
    dev.exited,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 8000).unref()),
  ]);
  assert.notEqual(done, 'hung', 'it is still waiting for a result that is not coming');
  assert.equal((done as { code: number | null }).code, 0, dev.err());
  assert.match(dev.out(), /heard: "please run the tests"/);
  assert.doesNotMatch(dev.out(), /APPROVE\?/);
});

test('fake-device: a rejected hello exits non-zero with the reason, and never prints the token', async (t) => {
  const { url } = await startBridge(t);
  const wrong = 'wrong-token-0123456789abc';
  const dev = spawnNode(t, DEVICE, ['--url', url, '--token', wrong], {});
  const { code } = await dev.exited;
  assert.equal(code, 2);
  assert.match(dev.err(), /Refused by the bridge: the token was wrong/);
  assert.equal((dev.out() + dev.err()).includes(wrong), false);
  assert.equal(dev.out(), '', 'it never claimed to be connected');
});

test('fake-device: shows the first state even when it arrives in the same network read as hello_ack', async (t) => {
  // Under load the two frames land together and are delivered before connect() returns. The
  // frames are corked into one write here so that is what happens every time, not just on a
  // busy machine, and the CLI must still show the pet's first face.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  t.after(() => void wss.close());
  wss.on('connection', (ws) => {
    ws.once('message', () => {
      const sock = (ws as unknown as { _socket: { cork(): void; uncork(): void } })._socket;
      sock.cork();
      ws.send('{"t":"hello_ack","v":1,"ok":true,"sid":""}');
      ws.send('{"t":"state","seq":1,"ph":"idle","tl":"","pend":0}');
      sock.uncork();
    });
  });
  const url = `ws://127.0.0.1:${(wss.address() as { port: number }).port}/`;

  const out: string[] = [];
  const input = new PassThrough();
  input.write('/q\n'); // read as soon as the CLI is ready for input, which is after it has shown what it has
  const code = await runFakeDevice(['--url', url], { BRIDGE_TOKEN: SUPPLIED }, {
    out: (s) => void out.push(s),
    err: () => {},
    input,
    tty: false,
  });
  assert.equal(code, 0);
  assert.match(out.join(''), /\(o_o\)\s+idle/);
});

test('fake-device: no token, an unknown flag, a dead address: each exits non-zero with a message', async (t) => {
  const noToken = spawnNode(t, DEVICE, [], {});
  assert.equal((await noToken.exited).code, 2);
  assert.match(noToken.err(), /No token/);

  const badFlag = spawnNode(t, DEVICE, ['--nope'], { BRIDGE_TOKEN: SUPPLIED });
  assert.equal((await badFlag.exited).code, 2);
  assert.match(badFlag.err(), /Unknown option/);

  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen({ host: '127.0.0.1', port: 0 }, resolve));
  const dead = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  const refused = spawnNode(t, DEVICE, ['--url', `ws://127.0.0.1:${dead}`], { BRIDGE_TOKEN: SUPPLIED });
  assert.equal((await refused.exited).code, 1);
  assert.match(refused.err(), /Could not connect/);
  assert.equal(refused.err().includes(SUPPLIED), false);
});

test('fake-device: if the bridge goes away it says so and exits non-zero', async (t) => {
  const { child, url } = await startBridge(t);
  const dev = spawnNode(t, DEVICE, ['--url', url], { BRIDGE_TOKEN: SUPPLIED });
  await dev.waitOut(/\(o_o\)\s+idle/);
  child.proc.kill('SIGTERM');
  const { code } = await dev.exited;
  assert.equal(code, 1);
  assert.match(dev.err(), /connection was lost \(1001\)/);
});
