/**
 * Command-line entry point: turn flags and the environment into a Config, start the
 * server, say what was started, and stop cleanly on a signal.
 *
 * `parseConfig` is the part worth testing and is therefore pure: it reads nothing but its
 * arguments (the working directory, the home directory and the token generator are
 * injectable) and either returns a complete Config or throws a ConfigError whose message
 * is written for the person at the keyboard. Everything with side effects (the
 * filesystem, the network, the signal handlers) is in `run` and `main`, and importing this
 * module starts nothing.
 *
 * Two refusals are deliberate and are explained in their messages rather than hidden:
 *
 *  - No ANTHROPIC_API_KEY in real mode. This project does not borrow a Claude subscription
 *    login for a server that a handheld drives, so the key is required, not optional.
 *  - A token that is too short. The device can only ever send 16 to 64 characters from a
 *    small alphabet; a shorter secret is also a weaker one.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { claudeDriverFactory } from './drivers/claude.ts';
import { fakeDriverFactory } from './drivers/fake.ts';
import { startServer } from './server.ts';
import type { RunningServer } from './server.ts';
import { clearSession } from './store.ts';
import { ScriptedStt } from './stt.ts';
import { describeTool } from './tools.ts';
import { LIMITS } from './types.ts';
import type { DriverFactory } from './types.ts';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type SettingSource = 'user' | 'project' | 'local';
const SETTING_SOURCES: readonly SettingSource[] = ['user', 'project', 'local'];

/** The characters protocol.ts lets a hello token use (RFC 3986 unreserved). */
const TOKEN_CHARS = /^[A-Za-z0-9._~-]+$/;

export interface Config {
  /** `--help` was given: print usage and stop. Every other field is a default. */
  help: boolean;
  host: string;
  port: number;
  token: string;
  /** The token was made up here, so the banner must show it (it is the only chance). */
  tokenGenerated: boolean;
  cwd: string;
  fakeClaude: boolean;
  fakeDelayMs: number;
  stateDir: string;
  newSession: boolean;
  askTtlSec: number;
  graceSec: number;
  settingSources: SettingSource[];
  /** Things the person should know before trusting the setup. Printed in the banner. */
  warnings: string[];
}

export interface ParseDeps {
  cwd?: string;
  homedir?: string;
  randomToken?: () => string;
}

export const USAGE = `Usage: node src/main.ts [options]

Connection
  --host <addr>          address to listen on (default 127.0.0.1)
  --port <n>             port, 0 for any free one (default 8787)
  --token <secret>       shared secret the device sends, 16 to 64 characters of
                         A-Z a-z 0-9 . _ ~ -   (or set BRIDGE_TOKEN; a generated one
                         is shown once in the banner). Prefer the environment: a
                         command-line argument is visible to other users in 'ps'.

Claude
  --cwd <dir>            project Claude works in (default: the current directory)
  --fake-claude          scripted stand-in for Claude: no API key, no network
  --fake-delay-ms <n>    pause between the fake's steps (default 400)
  --setting-sources <l>  Claude Code settings to read: project,local,user or none
                         (default project,local; 'user' may carry allow rules that
                         skip the approval on the device)
  --state-dir <dir>      where the session id is kept (default
                         $XDG_STATE_HOME/tamaclaude-bridge or
                         ~/.local/state/tamaclaude-bridge)
  --new-session          forget the saved session and start a fresh conversation

Approvals
  --ask-ttl-sec <n>      seconds the player has to answer one ask (default 90)
  --grace-sec <n>        seconds an open ask survives a lost connection (default 15)

  -h, --help             this text

Real mode needs ANTHROPIC_API_KEY in the environment.
`;

function parseIntFlag(name: string, raw: string | undefined, def: number, min: number, max: number): number {
  if (raw === undefined) return def;
  if (!/^\d+$/.test(raw)) throw new ConfigError(`${name} must be a whole number, got "${raw}".`);
  const n = Number(raw);
  if (n < min || n > max) throw new ConfigError(`${name} must be between ${min} and ${max}, got ${n}.`);
  return n;
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

function parseSettingSources(raw: string | undefined): SettingSource[] {
  if (raw === undefined) return ['project', 'local'];
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 1 && parts[0] === 'none') return [];
  const out: SettingSource[] = [];
  for (const p of parts) {
    const known = SETTING_SOURCES.find((s) => s === p);
    if (known === undefined) {
      throw new ConfigError(`--setting-sources: "${p}" is not one of user, project, local (or "none").`);
    }
    if (!out.includes(known)) out.push(known);
  }
  if (out.length === 0) throw new ConfigError('--setting-sources needs at least one of user, project, local, or "none".');
  return out;
}

export function parseConfig(argv: string[], env: Record<string, string | undefined>, deps: ParseDeps = {}): Config {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        token: { type: 'string' },
        cwd: { type: 'string' },
        'fake-claude': { type: 'boolean' },
        'fake-delay-ms': { type: 'string' },
        'state-dir': { type: 'string' },
        'new-session': { type: 'boolean' },
        'ask-ttl-sec': { type: 'string' },
        'grace-sec': { type: 'string' },
        'setting-sources': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    // parseArgs' own messages are decent ("Unknown option '--prot'") but end in advice
    // about `--` that does not apply here.
    const first = (err instanceof Error ? err.message : String(err)).split(/\n|\. /)[0] ?? 'bad arguments';
    throw new ConfigError(`${first.replace(/\.$/, '')}. Run with --help for the list of options.`);
  }
  // The values are strings or booleans by construction of the table above.
  const str = (k: string): string | undefined => (typeof values[k] === 'string' ? (values[k] as string) : undefined);
  const flag = (k: string): boolean => values[k] === true;

  const fakeClaude = flag('fake-claude');
  const base: Config = {
    help: flag('help'),
    host: str('host') ?? '127.0.0.1',
    port: 8787,
    token: '',
    tokenGenerated: false,
    cwd: resolve(str('cwd') ?? deps.cwd ?? process.cwd()),
    fakeClaude,
    fakeDelayMs: 400,
    stateDir: '',
    newSession: flag('new-session'),
    askTtlSec: 90,
    graceSec: 15,
    settingSources: ['project', 'local'],
    warnings: [],
  };
  if (base.help) return base;

  if (base.host.trim() === '') throw new ConfigError('--host must not be empty.');
  base.port = parseIntFlag('--port', str('port'), 8787, 0, 65535);
  base.fakeDelayMs = fakeClaude ? parseIntFlag('--fake-delay-ms', str('fake-delay-ms'), 400, 0, 60_000) : 0;
  if (!fakeClaude && str('fake-delay-ms') !== undefined) {
    throw new ConfigError('--fake-delay-ms only applies together with --fake-claude.');
  }
  base.askTtlSec = parseIntFlag('--ask-ttl-sec', str('ask-ttl-sec'), 90, 1, 3600);
  base.graceSec = parseIntFlag('--grace-sec', str('grace-sec'), 15, 0, 3600);
  base.settingSources = parseSettingSources(str('setting-sources'));

  const given = str('token') ?? env['BRIDGE_TOKEN'];
  if (given === undefined || given === '') {
    base.token = (deps.randomToken ?? ((): string => randomBytes(12).toString('hex')))();
    base.tokenGenerated = true;
  } else {
    base.token = given;
  }
  if (base.token.length < LIMITS.tokenMin) {
    throw new ConfigError(
      `The token is ${base.token.length} characters; it must be at least ${LIMITS.tokenMin}. ` +
        'A short secret is a weak one. Leave --token and BRIDGE_TOKEN unset to get a generated token.',
    );
  }
  if (base.token.length > LIMITS.tokenMax) {
    throw new ConfigError(`The token is ${base.token.length} characters; the device can send at most ${LIMITS.tokenMax}.`);
  }
  if (!TOKEN_CHARS.test(base.token)) {
    throw new ConfigError('The token may only use the characters A-Z a-z 0-9 . _ ~ - (the device cannot send others).');
  }

  if (!fakeClaude) {
    const key = env['ANTHROPIC_API_KEY'];
    if (key === undefined || key.trim() === '') {
      throw new ConfigError(
        'ANTHROPIC_API_KEY is not set. The bridge uses an API key on purpose: it does not use a Claude ' +
          'subscription login, because a server that a handheld drives should not run on a personal ' +
          'login. Set ANTHROPIC_API_KEY, or run with --fake-claude to try the protocol without one.',
      );
    }
  }

  const stateHome = env['XDG_STATE_HOME'];
  const home = deps.homedir ?? homedir();
  base.stateDir = resolve(
    str('state-dir') ??
      (stateHome !== undefined && isAbsolute(stateHome)
        ? join(stateHome, 'tamaclaude-bridge')
        : join(home, '.local', 'state', 'tamaclaude-bridge')),
  );

  if (!isLoopbackHost(base.host)) {
    base.warnings.push(
      `--host ${base.host} is not a loopback address. The link is plaintext ws://: anyone on that network ` +
        'can read the token and every approval and can send their own. Use it only on a network you trust.',
    );
  }
  if (base.settingSources.includes('user')) {
    base.warnings.push(
      'User settings are enabled. An allow rule in them lets Claude run a tool WITHOUT asking the device.',
    );
  }
  return base;
}

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

/** Every address a client could reach `host:port` on. A wildcard host means every interface. */
export function listUrls(
  host: string,
  port: number,
  ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const wrap = (h: string): string => `ws://${h.includes(':') ? `[${h}]` : h}:${port}/`;
  if (host === '0.0.0.0' || host === '::' || host === '[::]') {
    const urls = [wrap('127.0.0.1')];
    for (const list of Object.values(ifaces)) {
      for (const a of list ?? []) {
        if (!a.internal && a.family === 'IPv4') urls.push(wrap(a.address));
      }
    }
    return urls;
  }
  return [wrap(host.replace(/^\[|\]$/g, ''))];
}

function packageVersion(): string {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const v = typeof pkg === 'object' && pkg !== null ? (pkg as { version?: unknown }).version : undefined;
    return typeof v === 'string' ? v : '?';
  } catch {
    return '?';
  }
}

/**
 * The only place the token is ever printed, and only when WE made it up: a token the person
 * supplied is already in their shell history or their service file, and a second copy in a
 * log or a journal is a leak with no benefit.
 */
export function renderBanner(config: Config, urls: readonly string[]): string[] {
  const lines = [`TamaClaude bridge ${packageVersion()}`];
  lines.push(
    config.fakeClaude
      ? `  mode    FAKE (scripted Claude: no API key, no network, step delay ${config.fakeDelayMs} ms)`
      : '  mode    REAL (Claude Agent SDK, API key from ANTHROPIC_API_KEY)',
  );
  lines.push(`  cwd     ${config.cwd}`);
  for (const [i, u] of urls.entries()) lines.push(`  ${i === 0 ? 'listen ' : '       '} ${u}`);
  if (config.tokenGenerated) {
    lines.push(`  token   ${config.token}`);
    lines.push('          (generated for this run and shown only here; the device needs it)');
  } else {
    lines.push('  token   supplied by you (not shown)');
  }
  for (const w of config.warnings) lines.push(`  WARNING ${w}`);
  lines.push(
    config.fakeClaude
      ? '  try it  BRIDGE_TOKEN=<token> node tools/fake-device.ts --url <the listen address>'
      : '  stop    Ctrl-C',
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/**
 * The veto handed to the Claude driver: the same rules that decide what the device is asked
 * about, so a call they forbid is refused inside the SDK's own hook even when a settings
 * file would allow the tool.
 */
export function hardDenyFor(cwd: string): (tool: string, input: Record<string, unknown>) => string | undefined {
  return (tool, input) => describeTool(tool, input, cwd).deny;
}

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

const stdIo: Io = {
  out: (t) => void process.stdout.write(t),
  err: (t) => void process.stderr.write(t),
};

export interface RunResult {
  /** Absent when there was nothing to run (help, or a configuration error). */
  server?: RunningServer;
  config?: Config;
  exitCode: number;
}

export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io = stdIo,
  deps: ParseDeps = {},
): Promise<RunResult> {
  let config: Config;
  try {
    config = parseConfig(argv, env, deps);
    if (config.help) {
      io.out(USAGE);
      return { config, exitCode: 0 };
    }
    const dir = statSync(config.cwd, { throwIfNoEntry: false });
    if (dir === undefined || !dir.isDirectory()) throw new ConfigError(`--cwd "${config.cwd}" is not a directory.`);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.err(`${err.message}\n`);
    return { exitCode: 2 };
  }

  let driverFactory: DriverFactory;
  if (config.fakeClaude) {
    driverFactory = fakeDriverFactory({ delayMs: config.fakeDelayMs });
  } else {
    driverFactory = claudeDriverFactory({
      apiKey: env['ANTHROPIC_API_KEY'] ?? '',
      settingSources: config.settingSources,
      hardDeny: hardDenyFor(config.cwd),
    });
  }

  // The fake's session ids are made up. Written to the real state file they would be
  // "resumed" by the next real run, so the fake keeps no state at all.
  const stateDir = config.fakeClaude ? undefined : config.stateDir;
  if (stateDir !== undefined && config.newSession) clearSession(stateDir);

  let server: RunningServer;
  try {
    server = await startServer({
      host: config.host,
      port: config.port,
      token: config.token,
      cwd: config.cwd,
      driverFactory,
      // No real recognizer exists yet. The demo gets a canned one so push-to-talk can be tried
      // end to end at a desk; real mode keeps the default, which says "not set up".
      ...(config.fakeClaude ? { stt: new ScriptedStt('please run the tests') } : {}),
      askTtlMs: config.askTtlSec * 1000,
      graceMs: config.graceSec * 1000,
      ...(stateDir !== undefined ? { stateDir } : {}),
      log: (line) => io.err(`${new Date().toISOString()} ${line}\n`),
    });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    io.err(
      code === 'EADDRINUSE'
        ? `Port ${config.port} on ${config.host} is already in use. Choose another with --port.\n`
        : `Could not start the bridge: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { config, exitCode: 1 };
  }

  const urls = listUrls(config.host, server.port);
  io.out(`${renderBanner(config, urls).join('\n')}\n`);
  return { server, config, exitCode: 0 };
}

/** SIGINT/SIGTERM close gracefully; a second signal means "now". */
export function installShutdown(server: RunningServer, io: Io = stdIo, proc: NodeJS.Process = process): void {
  let stopping = false;
  const stop = (sig: string): void => {
    if (stopping) {
      io.err('Forced exit.\n');
      proc.exit(1);
      return;
    }
    stopping = true;
    io.err(`${sig} received, shutting down.\n`);
    server.close().then(
      () => proc.exit(0),
      (err: unknown) => {
        io.err(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
        proc.exit(1);
      },
    );
  };
  proc.on('SIGINT', () => stop('SIGINT'));
  proc.on('SIGTERM', () => stop('SIGTERM'));
}

export async function main(argv: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const r = await run(argv, env);
  if (r.server === undefined) {
    process.exitCode = r.exitCode;
    return;
  }
  installShutdown(r.server);
}

if (import.meta.main) {
  void main();
}
