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
 *
 * `run` is a composition root, and a composition root is where a safety property can be
 * deleted by one line without any unit noticing: the API key, the hard-deny hook, which
 * settings files are read, the bind address, the recognizer, whether a device on this
 * machine is accepted. The wiring is therefore two pure functions, `buildClaudeConfig` and
 * `buildServerOptions`, which `run` calls and test/main.test.ts reads line by line, AND two
 * seams in `run` itself (`RunDeps.makeClaudeDriver`, `RunDeps.startServer`) through which a
 * test sees exactly what `run` handed over. Reading the pure functions proves they are right;
 * only the seams prove `run` calls them and passes their output on unchanged, which is where
 * a one-line regression (the driver given only the key, the veto stripped, the grace period
 * forced) used to survive the whole suite. test/server.e2e.test.ts builds its real-driver rig
 * through `run` for the same reason.
 *
 * THE DEFAULT IS TO READ NO REPOSITORY CONFIGURATION (`--setting-sources none`). A
 * repository's `.claude/settings*.json` can run commands when Claude starts, change the
 * environment and send the conversation (and the API key) to another server before any tool
 * call exists for the device to be asked about. So the bridge reads the project's CLAUDE.md
 * ITSELF and hands the model plain text (src/memory.ts); `project` and `local` remain as an
 * explicit opt-in that prints a loud warning.
 *
 * TWO MORE SWITCHES FOLLOW THE SAME RULE (safe unless asked, said out loud when asked). `--git-context` lets the CLI run
 * git in the working directory when it starts, which reads the repository's own `.git/config` and so lets a clean filter
 * written there run a program with no ask; off by default (the driver sets the CLI's switch for it), a boxed warning when on.
 * `--ask-all` is the strict mode for somebody who prefers safety to convenience: the tap rule answers yes for every call,
 * so even the one read the CLI would run on its own is put to the device, because the names that keep a read tap-free are a
 * heuristic that will never be complete. Both are real-mode only.
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AUTO_MEMORY_SWITCH, checkManagedLock, claudeDriverFactory, DEFAULT_STALL_MS, GIT_SWITCH, NEVER_PASS } from './drivers/claude.ts';
import type { ClaudeDriverConfig, ManagedLockStatus } from './drivers/claude.ts';
import { fakeDriverFactory } from './drivers/fake.ts';
import { inspectProjectMemory, MEMORY_MAX_BYTES } from './memory.ts';
import type { ProjectMemory, ProjectMemoryReport } from './memory.ts';
import { startServer } from './server.ts';
import type { RunningServer, ServerOptions } from './server.ts';
import { clearSession } from './store.ts';
import { ScriptedStt } from './stt.ts';
import { sanitize } from './text.ts';
import { AUTO_RUN_TOOLS, bridgeSecretsInside, describeTool, needsTap, setBridgeSecrets } from './tools.ts';
import { LIMITS } from './types.ts';
import type { DriverFactory, Logger } from './types.ts';

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

/** Where the token came from, which decides what the banner says about it and what it warns about. */
export type TokenSource = 'argv' | 'file' | 'env' | 'generated';

export interface Config {
  /** `--help` was given: print usage and stop. Every other field is a default. */
  help: boolean;
  host: string;
  port: number;
  token: string;
  /** The token was made up here, so the banner must show it (it is the only chance). */
  tokenGenerated: boolean;
  tokenSource: TokenSource;
  /** The absolute path of --token-file, when that is where the token came from. */
  tokenFile: string | undefined;
  /** Accept a device on this machine. Always true in fake mode; in real mode only with --allow-local-device. */
  allowLocalDevice: boolean;
  /** Extra environment variable NAMES the Claude child may see (--pass-env). */
  passEnv: string[];
  model: string | undefined;
  maxTurns: number | undefined;
  cwd: string;
  fakeClaude: boolean;
  fakeDelayMs: number;
  stateDir: string;
  newSession: boolean;
  askTtlSec: number;
  graceSec: number;
  /** Seconds of silence from Claude, with no tool running and no ask open, after which a turn is ended. 0: never. */
  turnStallSec: number;
  /**
   * Which Claude Code settings files are read. DEFAULT: none. `project` and `local` are an opt-in for a
   * repository the operator trusts like its build scripts; see the file header and the banner.
   */
  settingSources: SettingSource[];
  /**
   * OPT-IN (`--git-context`): the CLI runs git in the working directory when it starts, which reads the repository's own
   * `.git/config`, and a clean filter defined there can run a program with no ask. DEFAULT: off; see the file header.
   */
  gitContext: boolean;
  /** STRICT MODE (`--ask-all`): every call that is not refused asks the device, a Read inside the working directory included. */
  askAll: boolean;
  /** Things the person should know before trusting the setup. Printed in the banner. */
  warnings: string[];
}

export interface ParseDeps {
  cwd?: string;
  homedir?: string;
  randomToken?: () => string;
  /** Reads a --token-file: its text and its permission bits. Default: the real file system. */
  readTokenFile?: (path: string) => { text: string; mode: number };
}

/** The seams of `run` (see the file header): a test sees, and can replace, what `run` hands over. */
export interface RunDeps extends ParseDeps {
  /** Builds the real driver factory from the configuration `run` composed. Default: `claudeDriverFactory`. */
  makeClaudeDriver?: (cfg: ClaudeDriverConfig) => DriverFactory;
  /** Starts the server from the options `run` composed. Default: `startServer`. */
  startServer?: (opts: ServerOptions) => Promise<RunningServer>;
  /** Reads the project's memory file. Default: `inspectProjectMemory`. */
  loadMemory?: (cwd: string) => ProjectMemoryReport;
  /** Asks whether the policy-tier lock is in force. Default: `checkManagedLock`. */
  checkManagedLock?: (cwd: string) => Promise<ManagedLockStatus | undefined>;
  /** Registers the bridge's own credential files with the tool rules. Default: tools.ts. */
  secrets?: { set: (paths: readonly string[]) => void; inside: (cwd: string) => string[] };
  /** Makes SIGUSR1 unable to open the Node inspector. Default: `neutraliseInspector`. */
  guardInspector?: (io: Io) => void;
}

function readTokenFileFromDisk(path: string): { text: string; mode: number } {
  return { text: readFileSync(path, 'utf8'), mode: statSync(path).mode };
}

export const USAGE = `Usage: node src/main.ts [options]

Connection
  --host <addr>          address to listen on (default 127.0.0.1)
  --port <n>             port, 0 for any free one (default 8787)
  --token-file <path>    read the shared secret the device sends from a file (16 to 64
                         characters of A-Z a-z 0-9 . _ ~ -). Keep it outside the project
                         and readable by you only.
  --token <secret>       the same secret on the command line. Every user of this
                         machine sees it in 'ps': prefer --token-file, or give nothing
                         and a token is generated and shown once in the banner. The
                         BRIDGE_TOKEN environment variable is also read (after the
                         two flags); anything running as you can read it from /proc.
  --allow-local-device   accept a device on THIS machine (the emulator). Real mode
                         refuses one by default, because the commands Claude runs here
                         could otherwise connect as the device and approve themselves.
                         Fake mode always allows it.

Claude
  --cwd <dir>            project Claude works in (default: the current directory)
  --fake-claude          scripted stand-in for Claude: no API key, no network
  --fake-delay-ms <n>    pause between the fake's steps (default 400)
  --model <id>           the Claude model (default: the Claude Code default)
  --max-turns <n>        most model turns one prompt may take (default: unlimited; Claude
                         can read files inside the project without asking, so a loop of
                         those costs API calls until this or --turn-stall-sec stops it)
  --turn-stall-sec <n>   end a turn when Claude has shown no sign of life for this many
                         seconds while no tool is running and no ask is open (default 300,
                         0 = never). A tool that is running, or an ask on the panel, is not
                         counted as silence.
  --pass-env <names>     environment variables, comma separated or repeated, that the
                         commands Claude runs may see. Everything else of this
                         process's environment stays behind. A name the bridge sets
                         itself is refused here (BRIDGE_TOKEN, ANTHROPIC_API_KEY and
                         the CLAUDE_CODE_DISABLE_* switches that keep background work,
                         workflows, the CLI's own memory and its git commands off).
  --setting-sources <l>  OPT-IN: Claude Code settings files to read, a comma list of user,
                         project, local, or none (the default, and the only safe setting
                         for a repository you do not trust). With none, the bridge reads
                         the project's CLAUDE.md itself and gives Claude plain text. With
                         project or local, the repository's own settings can run commands
                         when Claude starts, change its environment and redirect its
                         traffic before you are asked about anything; the bridge blocks
                         the ways it knows of, which is best effort.
  --git-context          OPT-IN: let Claude Code run git in the working directory when it
                         starts, so the prompt carries the branch, the status and the recent
                         commits. Off by default, because git then reads the repository's own
                         .git/config, and a filter defined there can run a program before you
                         are asked about anything. Only for a --cwd whose .git directory you
                         trust (a clone you made yourself does not bring one; an archive or a
                         copied folder does). Without it Claude is not told the branch or the
                         status, which a voice session hardly needs.
  --state-dir <dir>      where the session id is kept (default
                         $XDG_STATE_HOME/tamaclaude-bridge or
                         ~/.local/state/tamaclaude-bridge)
  --new-session          forget the saved session and start a fresh conversation

Approvals
  --ask-all              STRICT MODE: every tool call asks the device, a Read inside the
                         working directory included. By default that one read runs with no
                         tap unless the path looks like a credential store, and what looks
                         like one is decided by file names, which will never be complete.
                         Choose this when safety matters more to you than convenience.
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
  if (raw === undefined) return [];
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
        'token-file': { type: 'string' },
        'allow-local-device': { type: 'boolean' },
        'pass-env': { type: 'string', multiple: true },
        model: { type: 'string' },
        'max-turns': { type: 'string' },
        cwd: { type: 'string' },
        'fake-claude': { type: 'boolean' },
        'fake-delay-ms': { type: 'string' },
        'state-dir': { type: 'string' },
        'new-session': { type: 'boolean' },
        'ask-ttl-sec': { type: 'string' },
        'grace-sec': { type: 'string' },
        'turn-stall-sec': { type: 'string' },
        'setting-sources': { type: 'string' },
        'git-context': { type: 'boolean' },
        'ask-all': { type: 'boolean' },
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
  const strs = (k: string): string[] => (Array.isArray(values[k]) ? (values[k] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
  const flag = (k: string): boolean => values[k] === true;

  const fakeClaude = flag('fake-claude');
  const base: Config = {
    help: flag('help'),
    host: str('host') ?? '127.0.0.1',
    port: 8787,
    token: '',
    tokenGenerated: false,
    tokenSource: 'generated',
    tokenFile: undefined,
    allowLocalDevice: fakeClaude || flag('allow-local-device'),
    passEnv: [],
    model: undefined,
    maxTurns: undefined,
    cwd: resolve(str('cwd') ?? deps.cwd ?? process.cwd()),
    fakeClaude,
    fakeDelayMs: 400,
    stateDir: '',
    newSession: flag('new-session'),
    askTtlSec: 90,
    graceSec: 15,
    turnStallSec: DEFAULT_STALL_MS / 1000,
    settingSources: [],
    gitContext: flag('git-context'),
    askAll: flag('ask-all'),
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
  base.turnStallSec = parseIntFlag('--turn-stall-sec', str('turn-stall-sec'), DEFAULT_STALL_MS / 1000, 0, 3600);
  base.settingSources = parseSettingSources(str('setting-sources'));

  const claudeOnly = ['pass-env', 'model', 'max-turns', 'turn-stall-sec', 'git-context', 'ask-all'].filter((k) => values[k] !== undefined);
  if (fakeClaude && claudeOnly.length > 0) {
    throw new ConfigError(`--${claudeOnly[0]} only applies to the real Claude, not together with --fake-claude.`);
  }
  base.passEnv = parsePassEnv(strs('pass-env'));
  base.model = parseModel(str('model'));
  base.maxTurns = str('max-turns') === undefined ? undefined : parseIntFlag('--max-turns', str('max-turns'), 1, 1, 1000);

  const tokenFlag = str('token');
  const tokenFile = str('token-file');
  if (tokenFlag !== undefined && tokenFile !== undefined) {
    throw new ConfigError('--token and --token-file are two ways to give the same secret; give one of them.');
  }
  let given: string | undefined;
  if (tokenFile !== undefined) {
    const path = resolve(deps.cwd ?? process.cwd(), tokenFile);
    let file: { text: string; mode: number };
    try {
      file = (deps.readTokenFile ?? readTokenFileFromDisk)(path);
    } catch (err) {
      // The code (ENOENT, EACCES) says what is wrong; the message could quote the path twice.
      const code = (err as { code?: unknown } | null)?.code;
      throw new ConfigError(`Cannot read --token-file ${path}${typeof code === 'string' ? ` (${code})` : ''}.`);
    }
    given = file.text.trim();
    if (given === '') throw new ConfigError(`--token-file ${path} is empty.`);
    base.tokenSource = 'file';
    base.tokenFile = path;
    // A secret in a file other users can read is no better than one on the command line.
    if ((file.mode & 0o077) !== 0) {
      base.warnings.push(`The token file ${path} can be read by other users (mode ${(file.mode & 0o777).toString(8)}). Make it yours alone: chmod 600.`);
    }
  } else if (tokenFlag !== undefined && tokenFlag !== '') {
    given = tokenFlag;
    base.tokenSource = 'argv';
    base.warnings.push(
      "--token puts the secret on the command line, where every user of this machine can read it in 'ps'. Use --token-file, or leave the token unset for a generated one.",
    );
  } else if ((env['BRIDGE_TOKEN'] ?? '') !== '') {
    given = env['BRIDGE_TOKEN'];
    base.tokenSource = 'env';
  }
  if (given === undefined || given === '') {
    base.token = (deps.randomToken ?? ((): string => randomBytes(12).toString('hex')))();
    base.tokenGenerated = true;
    base.tokenSource = 'generated';
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
      'User settings (~/.claude) are enabled. Their permission rules and hooks are ignored here, but the rest of them (environment ' +
        'variables, CLAUDE.md) applies to everything Claude runs, and the bridge\'s blocks on settings that run commands or ' +
        'redirect traffic are best effort.',
    );
  }
  if (!fakeClaude && base.allowLocalDevice) {
    base.warnings.push(
      '--allow-local-device: a process on this machine can connect as the device. The commands Claude runs here are such processes, ' +
        'and anything running as you can read the token, so one of them could approve its own asks. Use this for the emulator only.',
    );
  }
  if (!fakeClaude && !base.allowLocalDevice && isLoopbackHost(base.host)) {
    base.warnings.push(
      `No device can connect: --host ${base.host} is this machine, and a real-mode bridge refuses a device on its own machine. ` +
        "Use --host with this machine's address on your network for the handheld, or --allow-local-device for the emulator.",
    );
  }
  return base;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why each name the driver sets for itself may not be given with --pass-env. WHICH names are refused is NOT decided
 * here: it is `NEVER_PASS` in the driver, the very list the driver applies when it builds the child's environment.
 * This file used to keep a second copy of the names (three of the driver's four, later three of five), so
 * `--pass-env CLAUDE_CODE_DISABLE_WORKFLOWS` was accepted at start-up and then dropped by the driver with a log line
 * nobody reads. Only the explanations live here, and test/main.test.ts fails for a name without one.
 */
export const NEVER_PASSED_WHY: ReadonlyMap<string, string> = new Map([
  ['BRIDGE_TOKEN', 'it is the credential that lets a process connect as the device; passing it would let the commands Claude runs approve their own asks'],
  ['ANTHROPIC_API_KEY', 'the key is always passed, and it is the one from this process'],
  ['CLAUDE_CODE_DISABLE_BACKGROUND_TASKS', 'the bridge turns background work off for a voice session and nothing may turn it back on'],
  ['CLAUDE_CODE_DISABLE_WORKFLOWS', 'the Workflow tool starts background agents whatever the other switches say, so the bridge turns it off and nothing may turn it back on'],
  [AUTO_MEMORY_SWITCH, "the bridge switches the CLI's own memory off (what an earlier session left in ~/.claude would be read with no tap) and nothing may turn it back on"],
  [GIT_SWITCH, "the bridge keeps the CLI's own git commands off, because git runs a filter written in the repository's .git/config; the only way to turn them on is --git-context, which says so"],
]);

/** Every name the child is never given, with the reason the operator is told: the driver's list, explained. */
export const NEVER_PASSED: ReadonlyMap<string, string> = new Map(
  [...NEVER_PASS].map((name): [string, string] => [name, NEVER_PASSED_WHY.get(name) ?? 'the bridge sets it itself and nothing may undo that']),
);

function parsePassEnv(raw: readonly string[]): string[] {
  const out: string[] = [];
  for (const part of raw.flatMap((r) => r.split(','))) {
    const name = part.trim();
    if (name === '') continue;
    if (!ENV_NAME.test(name)) throw new ConfigError(`--pass-env: "${name}" is not an environment variable name.`);
    const why = NEVER_PASSED.get(name);
    if (why !== undefined) throw new ConfigError(`--pass-env ${name} is refused: ${why}.`);
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > 64) throw new ConfigError('--pass-env names more than 64 variables.');
  return out;
}

function parseModel(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  // Model ids are short ASCII ("claude-sonnet-4-5", "...[1m]"); anything else is a typo or a smuggled argument.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,99}$/.test(raw)) throw new ConfigError(`--model "${raw.slice(0, 40)}" does not look like a model id.`);
  return raw;
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
 * The read-only tools that run without a tap AND that the Claude Code build bundled with the pinned
 * SDK actually offers. The bridge's own rule (`AUTO_RUN_TOOLS`) is wider: it also rates `Glob`,
 * `Grep`, `LS` and `NotebookRead` free so that a CLI which has them behaves the same. This build has
 * none of those (a search or a listing is a `Bash` call and asks), which is what the banner and the
 * README say. test/real-cli.integration.test.ts measures the tools the CLI offers; a build that adds
 * one must change this list and those two texts together.
 */
export const CLI_FREE_TOOLS: readonly string[] = ['Read'];

/** Does the bridge give the model the project's CLAUDE.md as text? Only when the CLI will not load it itself. */
export function bridgeSuppliesMemory(config: Pick<Config, 'settingSources'>): boolean {
  return !config.settingSources.includes('project');
}

/** True when the CLI will read the repository's own settings files: the opt-in that runs repository-chosen code. */
export function readsRepositorySettings(config: Pick<Config, 'settingSources'>): boolean {
  return config.settingSources.includes('project') || config.settingSources.includes('local');
}

/**
 * The warning printed when the repository's own settings are switched on. Deliberately a block, not a
 * line among the other warnings: it is the one switch that gives a repository the power to run code,
 * change the environment and redirect traffic before any call exists for the device to be asked about.
 */
export function settingsWarning(config: Pick<Config, 'settingSources'>): string[] {
  if (!readsRepositorySettings(config)) return [];
  const bar = '  ' + '='.repeat(76);
  return [
    bar,
    `  WARNING  THE REPOSITORY'S OWN SETTINGS ARE ON (--setting-sources ${config.settingSources.join(',')})`,
    '           Those files can run commands when Claude starts, change the environment of everything',
    '           it runs, send your API key and the conversation to another server, and switch features',
    '           back on, all BEFORE the device is asked about anything. The bridge blocks the ways it',
    '           knows of; that is best effort, and a new Claude Code release can add a way it does not.',
    '           Use this only for a repository you trust as you trust its build scripts.',
    '           --setting-sources none (the default) is the only safe setting for one you do not.',
    bar,
  ];
}

export interface BannerInfo {
  /** What the bridge read as the project's memory; absent when it did not look (or this is a banner test). */
  memory?: ProjectMemoryReport;
}

function memoryLines(config: Config, info: BannerInfo): string[] {
  if (!bridgeSuppliesMemory(config)) return ['  memory  loaded by Claude Code itself (the project settings are on)'];
  const m = info.memory;
  if (m === undefined) return [];
  const out: string[] = [];
  if (m.sources.length === 0) {
    out.push('  memory  none: no CLAUDE.md or .claude/CLAUDE.md in the working directory');
  } else {
    out.push(`  memory  ${m.sources.join(', ')}, read by the bridge as plain text (no @imports and no links followed)`);
    if (m.truncated) out.push(`          CUT at ${MEMORY_MAX_BYTES / 1024} KB: the rest of it is not given to Claude`);
  }
  // Said beside the file list, not instead of it: how the directory was read (a working directory that is itself a link).
  // Squeezed to one printable ASCII line again here: a real path can hold anything, and this is the operator's terminal.
  for (const n of m.notes ?? []) out.push(`          ${sanitize(n, 240)}`);
  for (const s of m.skipped) out.push(`          not used: ${sanitize(s.file, 60)} ${sanitize(s.why, 240)}`);
  return out;
}

/**
 * The warning printed when git context is switched on (`--git-context`). A block, like the settings warning: it is the other
 * switch that lets a repository's own files run a program before any call exists for the device to be asked about. Git reads
 * `.git/config` for every command the CLI then runs, and a `filter.<name>.clean` defined there runs while git hashes a file
 * that differs from its index entry. The CLI turns off git's hooks and file-system monitor for those commands, and not
 * filters. The source of such a config is a repository that arrived WITH its `.git` directory (an archive, a copied folder)
 * or a `.git/config` edited by a call somebody tapped; `git clone` does not copy configuration.
 */
export function gitContextWarning(config: Pick<Config, 'gitContext'>): string[] {
  if (!config.gitContext) return [];
  const bar = '  ' + '='.repeat(76);
  return [
    bar,
    '  WARNING  GIT CONTEXT IS ON (--git-context)',
    '           Claude Code will run git in the working directory when it starts (a status, a log). Git',
    "           reads the repository's own .git/config, and a filter defined there can run a program with",
    '           no question asked, BEFORE the device is asked about anything. Claude Code turns off git\'s',
    '           hooks and file-system monitor for those commands; it does not turn off filters.',
    '           Use --cwd only for a repository whose .git directory you trust: a clone you made yourself',
    '           does not bring one, an archive or a copied folder does.',
    bar,
  ];
}

/** What the banner says about git on every real-mode start: the block above when it is on, one line saying it is off otherwise. */
function gitLines(config: Pick<Config, 'gitContext'>): string[] {
  if (config.gitContext) return gitContextWarning(config);
  return [
    "  git     context off: Claude Code skips git status and git log at start-up, so a filter in the repository's own",
    '          .git/config cannot run a program then; Claude is not told the branch, the status or the recent commits (--git-context)',
  ];
}

/**
 * The only place the token is ever printed, and only when WE made it up: a token the person
 * supplied is already in their shell history or their service file, and a second copy in a
 * log or a journal is a leak with no benefit.
 */
export function renderBanner(config: Config, urls: readonly string[], info: BannerInfo = {}): string[] {
  const lines = [`TamaClaude bridge ${packageVersion()}`];
  lines.push(
    config.fakeClaude
      ? `  mode    FAKE (scripted Claude: no API key, no network, step delay ${config.fakeDelayMs} ms)`
      : `  mode    REAL (Claude Agent SDK, API key from ANTHROPIC_API_KEY, model ${config.model ?? 'default'}` +
          `${config.maxTurns === undefined ? '' : `, at most ${config.maxTurns} turns a prompt`})`,
  );
  lines.push(`  cwd     ${config.cwd}`);
  for (const [i, u] of urls.entries()) lines.push(`  ${i === 0 ? 'listen ' : '       '} ${u}`);
  if (config.tokenGenerated) {
    lines.push(`  token   ${config.token}`);
    lines.push('          (generated for this run and shown only here; the device needs it)');
  } else if (config.tokenSource === 'file') {
    lines.push('  token   supplied by you, from the token file (not shown)');
  } else if (config.tokenSource === 'env') {
    lines.push('  token   supplied by you, from BRIDGE_TOKEN (not shown; every process of your user can read the environment)');
  } else {
    lines.push('  token   supplied by you, on the command line (not shown)');
  }
  if (!config.fakeClaude) {
    lines.push(
      `  devices ${config.allowLocalDevice ? 'on this machine AND elsewhere' : 'only on other machines (a device on this machine is refused)'}`,
    );
    lines.push(
      config.askAll
        ? '  no tap  nothing (--ask-all, strict mode): every call asks the device first, a Read inside the working directory included'
        : `  no tap  ${CLI_FREE_TOOLS.join(', ')} inside the working directory, through no symbolic link and not a credential store ` +
            '(a search or a listing is a Bash call and asks); every other call asks the device first',
    );
    lines.push(
      config.settingSources.length === 0
        ? '  settings none are read: no settings file, hook, helper, MCP server, skill, plugin or command of the repository or of ' +
            "~/.claude is loaded, and the CLI's own auto-memory is off"
        : `  settings ${config.settingSources.join(', ')} (OPT-IN, see the warning below)`,
    );
    lines.push(...memoryLines(config, info));
    lines.push(...gitLines(config));
    lines.push(
      config.turnStallSec === 0
        ? '  stall   a turn is never ended for silence (--turn-stall-sec 0)'
        : `  stall   a turn with no sign of life from Claude for ${config.turnStallSec} s is ended (--turn-stall-sec)`,
    );
    lines.push(...settingsWarning(config));
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

/**
 * The driver's "must this go to the device?" question: the same single answer the rest of the
 * bridge uses, so the SDK's hook, the permission handler and the README cannot disagree
 * about which calls run without a tap.
 *
 * `askAll` is the strict mode (`--ask-all`): the answer is yes for EVERY call, the tap-free Read inside the working
 * directory included. The driver's hook consults `hardDeny` first, so a refused call is still refused without being
 * asked about; this only removes the calls the bridge's naming rules let through. Name-based secret detection is a
 * heuristic that will never be complete, and this is the way out of depending on it.
 */
export function needsAskFor(cwd: string, askAll = false): (tool: string, input: Record<string, unknown>) => boolean {
  if (askAll) return () => true;
  return (tool, input) => needsTap(tool, input, cwd);
}

/**
 * Everything the real Claude driver is configured with, from the parsed flags and the environment.
 *
 * `memory` is what the bridge read of the project's CLAUDE.md; when it is not given it is read here, so
 * calling this with two arguments is complete. It is passed to the driver only when the CLI will not
 * load that file itself (the `project` source does, and would then expand its @imports and show it twice).
 */
export function buildClaudeConfig(config: Config, env: Record<string, string | undefined>, memory?: ProjectMemory): ClaudeDriverConfig {
  const mem = bridgeSuppliesMemory(config) ? (memory ?? inspectProjectMemory(config.cwd)) : undefined;
  return {
    // Trimmed: a key pasted with a trailing newline is a key the API refuses, with a message about
    // authentication that points everywhere but the whitespace.
    apiKey: (env['ANTHROPIC_API_KEY'] ?? '').trim(),
    settingSources: config.settingSources,
    hardDeny: hardDenyFor(config.cwd),
    needsAsk: needsAskFor(config.cwd, config.askAll),
    gitContext: config.gitContext,
    passEnv: config.passEnv,
    stallMs: config.turnStallSec * 1000,
    ...(mem !== undefined && mem.text !== '' ? { projectMemory: mem.text } : {}),
    ...(config.model !== undefined ? { model: config.model } : {}),
    ...(config.maxTurns !== undefined ? { maxTurns: config.maxTurns } : {}),
  };
}

/** Everything the server is started with. `stateDir` is absent when nothing may be saved (fake mode). */
export function buildServerOptions(
  config: Config,
  driverFactory: DriverFactory,
  extra: { stateDir?: string; log?: Logger } = {},
): ServerOptions {
  return {
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
    allowLocalDevice: config.allowLocalDevice,
    ...(extra.stateDir !== undefined ? { stateDir: extra.stateDir } : {}),
    ...(extra.log !== undefined ? { log: extra.log } : {}),
  };
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

/** Words for the operator when the policy-tier lock is not (or cannot be shown to be) in force. */
export function lockWarning(status: ManagedLockStatus | undefined): string | undefined {
  if (status === undefined) {
    return (
      'Could not verify whether the policy-tier lock (which makes Claude Code ignore the permission rules and hooks of the settings ' +
      'files above) is in force on this machine. Assume it is not: the bridge\'s own ask hook is then the only guard on tool calls.'
    );
  }
  if (status.effective) return undefined;
  const by = status.displacedBy.length > 0 ? ` (${status.displacedBy.join(', ')})` : '';
  return (
    `An administrator's policy tier${by} is active on this machine, so the lock that makes Claude Code ignore the permission rules ` +
    `and hooks of the settings files above is NOT in force (${status.missing.join(', ')} not applied). The repository's hooks can ` +
    "run commands; only the bridge's own ask hook still guards tool calls."
  );
}

const inspectorGuarded = new WeakSet<object>();

/**
 * Makes `kill -USR1 <pid>` unable to open Node's inspector on this process.
 *
 * Node starts an unauthenticated inspector on 127.0.0.1:9229 when it gets SIGUSR1, unless a JavaScript
 * handler is installed for it (measured: with one, the signal runs the handler and nothing listens). Any
 * process running as the operator's user, including every command Claude runs once approved, can send that
 * signal, and the inspector would let it read BRIDGE_TOKEN and ANTHROPIC_API_KEY or answer the bridge's own
 * asks. `npm start` also passes `--disable-sigusr1`; this is the same refusal in code, so it holds when
 * the bridge is started another way. It removes THAT road only: anything running as the operator's user
 * can still read the process's memory through /proc or ptrace where the system allows it, and the README
 * says so. Idempotent.
 */
export function neutraliseInspector(io: Io = stdIo, proc: Pick<NodeJS.Process, 'on'> = process): void {
  if (inspectorGuarded.has(proc)) return;
  inspectorGuarded.add(proc);
  proc.on('SIGUSR1', () => io.err('SIGUSR1 ignored: this bridge does not open the Node inspector on a signal.\n'));
}

export async function run(
  argv: string[],
  env: Record<string, string | undefined>,
  io: Io = stdIo,
  deps: RunDeps = {},
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
  let memory: ProjectMemoryReport | undefined;
  if (config.fakeClaude) {
    driverFactory = fakeDriverFactory({ delayMs: config.fakeDelayMs });
  } else {
    (deps.guardInspector ?? neutraliseInspector)(io);

    // The bridge's own credential files are secret stores for the tool rules, so a read of them asks at
    // high risk even inside the working directory; and the person is told when one sits in the project.
    const secrets = deps.secrets ?? { set: setBridgeSecrets, inside: bridgeSecretsInside };
    secrets.set([...(config.tokenFile !== undefined ? [config.tokenFile] : []), config.stateDir]);
    const inside = secrets.inside(config.cwd);
    if (inside.length > 0) {
      config.warnings.push(
        `The bridge's own ${inside.length === 1 ? 'file' : 'files'} (${inside.join(', ')}) ${inside.length === 1 ? 'is' : 'are'} inside the working ` +
          `directory. Claude can read ${inside.length === 1 ? 'it' : 'them'} only after a tap, but keep the token file and the state directory outside the project.`,
      );
    }

    // Looked at once, here, so the banner and the driver describe the same bytes.
    if (bridgeSuppliesMemory(config)) memory = (deps.loadMemory ?? inspectProjectMemory)(config.cwd);

    if (config.settingSources.length > 0) {
      const note = lockWarning(await (deps.checkManagedLock ?? checkManagedLock)(config.cwd));
      if (note !== undefined) config.warnings.push(note);
    }

    driverFactory = (deps.makeClaudeDriver ?? claudeDriverFactory)(buildClaudeConfig(config, env, memory));
  }

  // The fake's session ids are made up. Written to the real state file they would be
  // "resumed" by the next real run, so the fake keeps no state at all.
  const stateDir = config.fakeClaude ? undefined : config.stateDir;
  if (stateDir !== undefined && config.newSession) clearSession(stateDir);

  let server: RunningServer;
  try {
    server = await (deps.startServer ?? startServer)(
      buildServerOptions(config, driverFactory, {
        ...(stateDir !== undefined ? { stateDir } : {}),
        log: (line) => io.err(`${new Date().toISOString()} ${line}\n`),
      }),
    );
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
  io.out(`${renderBanner(config, urls, memory !== undefined ? { memory } : {}).join('\n')}\n`);
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
