/**
 * The command line: configuration rules (pure, table-driven), what the banner shows and
 * hides, and the real entry points run as child processes, because "SIGTERM closes the
 * port" and "importing starts nothing" are claims about a process, not about a function.
 *
 * Also here: the fake-device CLI driven for real against a real server process, since it
 * has no other test and its job is to be typed into.
 */

import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PassThrough } from 'node:stream';
import { WebSocketServer } from 'ws';
import { DeviceClient } from '../src/device-client.ts';
import { runFakeDevice } from '../tools/fake-device.ts';
import {
  ConfigError,
  hardDenyFor,
  installShutdown,
  isLoopbackHost,
  listUrls,
  parseConfig,
  renderBanner,
  run,
} from '../src/main.ts';
import type { Config, Io } from '../src/main.ts';
import { saveSession } from '../src/store.ts';
import { LIMITS } from '../src/types.ts';

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

test('defaults: loopback, port 8787, fake delay 400, a generated 24-hex token, project+local settings', () => {
  const c = cfg(fake());
  assert.deepEqual(
    { host: c.host, port: c.port, fakeClaude: c.fakeClaude, fakeDelayMs: c.fakeDelayMs, askTtlSec: c.askTtlSec, graceSec: c.graceSec },
    { host: '127.0.0.1', port: 8787, fakeClaude: true, fakeDelayMs: 400, askTtlSec: 90, graceSec: 15 },
  );
  assert.equal(c.token, GEN);
  assert.equal(c.tokenGenerated, true);
  assert.deepEqual(c.settingSources, ['project', 'local']);
  assert.equal(c.cwd, '/work/project');
  assert.equal(c.newSession, false);
  assert.deepEqual(c.warnings, []);
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

test('setting sources: project and local by default; none, user and lists are accepted; user warns', () => {
  assert.deepEqual(cfg(fake('--setting-sources', 'project')).settingSources, ['project']);
  assert.deepEqual(cfg(fake('--setting-sources', 'local, project,local')).settingSources, ['local', 'project'], 'trimmed, de-duplicated');
  assert.deepEqual(cfg(fake('--setting-sources', 'none')).settingSources, []);
  const u = cfg(fake('--setting-sources', 'user,project'));
  assert.deepEqual(u.settingSources, ['user', 'project']);
  assert.equal(u.warnings.length, 1);
  assert.match(u.warnings[0] ?? '', /WITHOUT asking/);
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
  for (const flag of ['--host', '--port', '--token', '--cwd', '--fake-claude', '--fake-delay-ms', '--state-dir', '--new-session', '--ask-ttl-sec', '--grace-sec', '--setting-sources']) {
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

  const args = ['--port', '0', '--cwd', work, '--state-dir', dir];
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

function spawnNode(t: TestContext, script: string, args: string[], env: Record<string, string>): Child {
  const clean: NodeJS.ProcessEnv = { ...process.env };
  delete clean['ANTHROPIC_API_KEY'];
  delete clean['BRIDGE_TOKEN'];
  const proc = spawn(process.execPath, [script, ...args], { env: { ...clean, ...env }, stdio: ['pipe', 'pipe', 'pipe'], cwd: ROOT });
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

  dev.write('/l\n'); // the canned recognizer hears "please run the tests"
  await dev.waitOut(/\(O_O\)>\s+listening/);
  await dev.waitOut(/heard: "please run the tests"/);
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
