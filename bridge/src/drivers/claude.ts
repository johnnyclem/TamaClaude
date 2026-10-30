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
 *
 *  2. THE REPOSITORY'S OWN CONFIGURATION IS NOT LOADED (`settingSources: []`, the default). This
 *     is the root of the promise "nothing runs unless a human tapped Allow", and everything else
 *     below is defence in depth for the opt-in mode that turns it off. A repository's
 *     `.claude/settings*.json` is not a list of preferences; it is a way to run code and change
 *     the CLI's behaviour BEFORE any tool call exists for the device to be asked about. Measured,
 *     each with a control run that removes the guard and shows the effect (the command keys in both
 *     trusted and untrusted workspaces, the rest in a trusted one):
 *       - `awsAuthRefresh`, `awsCredentialExport`, `gcpAuthRefresh`, `proxyAuthHelper` run a shell
 *         command at the start of the first turn (the first three once `env` selects a cloud
 *         provider, which the same file can do);
 *       - provider selectors in `env` (CLAUDE_CODE_USE_VERTEX/FOUNDRY/BEDROCK/MANTLE/...) with their
 *         base URLs send the conversation to the repository's server, and Vertex sent the operator's
 *         API key in `x-api-key`;
 *       - `env.PATH` makes the tap-free Read of a PDF spawn a repository-supplied `pdftoppm`;
 *       - `env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0` switches background work back on;
 *       - `env.ANTHROPIC_AUTH_TOKEN` / `env.ANTHROPIC_API_KEY` replace the operator's credentials.
 *     A denylist of those keys was the first fix and it rots with every CLI release (the SDK's
 *     Settings type has 180 keys). With no sources, none of the above fired in any experiment.
 *     What a person loses is only the repository's CLAUDE.md, and the bridge supplies that itself
 *     as plain text (src/memory.ts, `projectMemory` below), so the cost is not the instructions.
 *     ONE THING STILL CAME FROM `~/.claude` WITH NO SOURCES (measured): the CLI's own auto-memory, a
 *     `# auto memory` section in the system prompt and the text of `projects/<project>/memory/MEMORY.md`
 *     in the first request, written by earlier unbridged sessions and read with no tap. It is switched
 *     off in the child's environment (AUTO_MEMORY_SWITCH), so "no source loaded" means what the banner says.
 *     A SECOND ONE CAME FROM THE REPOSITORY'S `.git` (measured): at start-up the CLI runs `git` in the working
 *     directory (a status, a log, a config read) to tell the model the branch and the recent commits. It turns off
 *     git's hooks and file-system monitor for them and NOT its filters, so a `filter.<name>.clean` program in the
 *     repository's own `.git/config` ran, with no ask and no settings loaded. The CLI's switch for those commands is
 *     set by default here (GIT_SWITCH): the cost is the branch, status and commits in the prompt, which a voice
 *     session hardly needs. Three read-only git commands of its own remain (test/support/git-commands.ts lists them,
 *     and the real-CLI suite holds the list to the CLI). `gitContext: true` (`--git-context`) is the operator's
 *     explicit way back.
 *     `settingSources: ['project', 'local']` is an explicit opt-in (`--setting-sources`), and a repository you
 *     do not trust must never be run that way.
 *
 *  3. The remaining layers, kept for the opt-in mode and BEST-EFFORT, in this order:
 *       a. PINS (pinnedSettings), written only when some settings source IS loaded: a settings file in
 *          the highest-priority layer (the `--settings` flag layer, which a project file cannot
 *          outrank) that blanks every command-bearing key,
 *          the provider selectors and their endpoints, the proxies, and the variables that hijack
 *          a program lookup, and forces background work and workflows off. A denylist, so it is
 *          incomplete by construction; test/claude-driver.test.ts enumerates the SDK's own Settings
 *          type so a new `*Helper`, `*Refresh` or `*Export` key fails a test instead of slipping
 *          past. It also pins `disableAllHooks`, which is what keeps a repository's command hooks
 *          from running when layer b is not in force (measured). THE CLI SILENTLY DROPS THE WHOLE
 *          FILE if one key in it has the wrong type (measured: `statusLine: ''` discards every
 *          other pin, with no message), which is why object-typed keys are blanked as objects and
 *          why the real-CLI suite proves the file is applied.
 *       b. THE POLICY TIER (`managedSettings`: allowManagedPermissionRulesOnly,
 *          allowManagedHooksOnly) makes the CLI ignore permission rules and hooks from project,
 *          local and flag settings. What it does NOT do, and what an earlier comment here left out:
 *            - it ignores ALL permission rules from those files, `deny` and `ask` included, so a
 *              repository or user `deny` for a file the bridge rates low (a Read inside the working
 *              directory) is silently void. The bridge's own secret-path rules are the only
 *              protection there. Managed `deny` rules ARE honoured, but the bridge does not
 *              forward the repository's;
 *            - it is DROPPED WHOLESALE on a machine that has an administrator-managed tier (a
 *              managed-settings.json, MDM, server-managed settings): the SDK documents that the
 *              spawning parent's tier loses to an admin tier by default, and nothing is logged.
 *              `checkManagedLock()` asks the SDK's own resolver whether it is in force, so the
 *              server can say so at start-up. With it gone, only layers a, c and d remain.
 *       c. THE PreToolUse HOOK answers `ask` for every call `needsAsk` says needs a tap, which
 *          overrides any allow rule and the CLI's auto-allow. It is an SDK hook, not a settings
 *          hook: neither the policy tier nor a repository's `disableAllHooks` touches it
 *          (measured), and it held in every experiment where layer b was absent. Only calls the
 *          bridge rates low (built-in read-only tools inside the working directory) are left to the
 *          CLI, and it asks about everything when no `needsAsk` is configured. `hardDeny` is checked
 *          first, so a forbidden call is refused without the device ever seeing it.
 *       d. `canUseTool`, which is where the device is actually asked.
 *
 *  4. What the user approved is what runs. The handler is given a COPY of the tool
 *     input, and the original goes back to the SDK, so a handler that mutates its
 *     argument cannot change the approved call after the fact.
 *
 *  5. The model's tool subprocesses do not inherit the bridge's secrets. The child
 *     environment is an ALLOWLIST (see CHILD_ENV_NAMES): BRIDGE_TOKEN, cloud credentials and
 *     every other variable stay behind unless the operator names them. The one secret the CLI
 *     needs, the API key, is visible to the commands a person approves: the CLI passes its
 *     own environment on, and scrubbing it needs a sandbox this project does not require.
 *
 *  6. The tools the device cannot serve are neither offered nor askable: `disallowedTools` is
 *     derived from the ONE list in src/tools.ts (UNSERVED_TOOL_NAMES), the same list the permission
 *     handler refuses, and `skills: []` is the SDK's documented way to hide skill listings. Measured:
 *     `skills: []` ALONE leaves the Skill tool offered, so the tool's presence on the unserved list is
 *     what closes the hole (a tap on a skill ran its inline shell, including `cat .env`); with the tool
 *     gone, `skills: []` changes nothing the fake API can see, and is kept as the second barrier the
 *     SDK itself describes.
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
 *  - A turn in which the model goes SILENT (a connection that accepts and never answers: measured
 *    8+ minutes with no terminal) is ended by a watchdog after `stallMs` with no event, unless a
 *    tool is running or the device is being asked, which are legitimately quiet.
 *  - Text that leaves the driver for the device is scrubbed of anything key-like first.
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
  resolveSettings as sdkResolveSettings,
} from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from './claude-adapter.ts';
import type { AdapterEvent } from './claude-adapter.ts';
import { sanitize } from '../text.ts';
import { UNSERVED_TOOL_NAMES } from '../tools.ts';
import { realClock } from '../types.ts';
import type { Clock, DriverEvent, DriverFactory, DriverOptions, SessionDriver, TimerHandle } from '../types.ts';
import { composeSystemAppend } from '../voice-prompt.ts';

export interface ClaudeDriverConfig {
  apiKey: string;
  /**
   * Which settings files the CLI reads. DEFAULT: NONE (`[]`), and that is the safe setting: a
   * repository's settings can run commands at start-up, change the environment and redirect the
   * conversation before any tool call exists to be asked about (see the file header). `'project'`
   * and `'local'` are an explicit opt-in for a repository you trust as much as its build scripts;
   * `'user'` additionally reads the operator's own settings. In an opt-in mode the pins, the policy
   * tier and the hook still apply, as defence in depth and best-effort (see the file header).
   */
  settingSources?: ('user' | 'project' | 'local')[];
  /**
   * The project's memory file as plain text (src/memory.ts `loadProjectMemory(cwd).text`), appended
   * to the system prompt under a heading that says what it is and that it cannot approve anything.
   * This is how the repository's CLAUDE.md reaches the model when no settings are loaded. Pass it
   * only when `settingSources` lacks `'project'`: with that source the CLI loads CLAUDE.md itself
   * (and expands its `@imports`), so the text would arrive twice. '' or unset: no section.
   * Whatever the text says, it cannot end its own quotation: any line that imitates one of the two marker lines
   * is replaced where the section is composed (src/voice-prompt.ts `neutraliseMarkers`).
   */
  projectMemory?: string;
  /**
   * OPT-IN: let the CLI run `git` in the working directory when it starts, so the prompt carries the branch, the
   * status and the recent commits. Default false, which sets GIT_SWITCH in the child's environment and in the pinned
   * settings. On, a `filter.<name>.clean` program in the repository's own `.git/config` can run with no question asked
   * (the CLI turns off git's hooks and file-system monitor for those commands, not its filters), so it is only for a
   * repository whose `.git` directory the operator trusts. See the file header.
   */
  gitContext?: boolean;
  /**
   * How long a turn may go without ANY event from the CLI before the driver gives up on it,
   * interrupts, and ends the turn with `{ ok: false, subtype: 'stalled' }`. Paused while a tool
   * is running or a permission request is open, which are quiet for good reasons. Default
   * DEFAULT_STALL_MS (5 minutes); 0, a negative or a non-finite number disables the watchdog.
   */
  stallMs?: number;
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
  /** Replaces `checkManagedLock` (tests). Asked once, and only when the repository's settings are loaded. */
  checkManagedLock?: (cwd: string) => Promise<ManagedLockStatus | undefined>;
}

const DEFAULT_INTERRUPT_GRACE_MS = 8000;
/** Silence, with nothing running and nothing asked, after which a turn is declared stalled. */
export const DEFAULT_STALL_MS = 300_000;
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
/** What the owner is told when the watchdog gave up. Plain words, no environment names (see text.ts). */
export const STALLED_TEXT = 'Claude is not responding.';
const stalled = (): DriverEvent => ({ k: 'result', ok: false, text: STALLED_TEXT, subtype: 'stalled' });
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
 * The variable that switches the CLI's OWN memory off. With no settings loaded the CLI still keeps one under
 * `$CLAUDE_CONFIG_DIR/projects/<project>/memory/`: it tells the model about that directory in the system
 * prompt, puts MEMORY.md in front of it (measured: `# auto memory`, then the index file's text), and tells it
 * to write there, which the bridge's own rules always refuse. What an earlier, unbridged session left in that
 * file is therefore read by the model with no tap. The name is the one in the bundled binary and in the
 * red-team's measurement; test/real-cli.integration.test.ts plants a MEMORY.md and shows it reaching the model
 * without this variable and not with it.
 */
export const AUTO_MEMORY_SWITCH = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';

/**
 * The variable that stops the CLI's OWN git commands that build the context. Without it, the CLI runs `git status`,
 * `git log` and `git config user.name` in the working directory as it starts and puts the result in the first request as
 * the branch, the status and the recent commits. Git reads the repository's `.git/config` for every one of them, and a
 * `filter.<name>.clean` program defined there runs while git hashes a file that differs from its index entry (the CLI
 * turns off hooks and the file-system monitor for these commands, and not filters), so a repository that arrived WITH its
 * `.git` directory could run a program before any tool call existed for the device to be asked about. Measured on the
 * bundled CLI (test/real-cli.integration.test.ts, with a control run that removes this variable and shows the filter
 * running and the git context in the prompt; the same scenario with `gitContext: true` is the opt-in).
 *
 * WHAT IT DOES NOT STOP, measured the same way: three read-only commands the CLI runs for its own purposes (an index
 * lookup of its local settings file, the remote's name and URL). They hash no file, so they apply no filter; the test
 * plants a filter, a file-system monitor and a hooks directory and none of them runs. The reviewed list is
 * test/support/git-commands.ts, and a command that is not on it fails the real-CLI suite.
 */
export const GIT_SWITCH = 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS';

/**
 * Names `passEnv` may not carry. The token is the credential that would let the child
 * impersonate the device; the others are set by the driver and an operator must not be
 * able to undo them (the key is the configured one, background work, workflows, the CLI's own
 * memory and its own git commands stay off). Git is the operator's to turn on, but only by the
 * explicit `gitContext` setting, which prints a warning: a bare environment name is not that.
 */
export const NEVER_PASS: ReadonlySet<string> = new Set([
  'BRIDGE_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS',
  'CLAUDE_CODE_DISABLE_WORKFLOWS',
  AUTO_MEMORY_SWITCH,
  GIT_SWITCH,
]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface ChildEnv {
  env: Record<string, string>;
  /** `passEnv` entries that were not honoured, so the log can say so. */
  refused: string[];
}

export interface ChildEnvOptions {
  /** Leave the CLI's own git commands on (`--git-context`). Default false: GIT_SWITCH is set. */
  gitContext?: boolean;
}

/**
 * The child's whole environment (the SDK REPLACES it when `env` is set, so nothing is
 * inherited behind this function's back).
 */
export function buildChildEnv(
  source: NodeJS.ProcessEnv,
  apiKey: string,
  passEnv: readonly string[] = [],
  options: ChildEnvOptions = {},
): ChildEnv {
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
  // The Workflow tool starts background agents whatever the variable above says (measured), and
  // it is also on the unserved list; this removes it from the CLI's own tool set as well.
  env.CLAUDE_CODE_DISABLE_WORKFLOWS = '1';
  // The CLI's own memory is not the project's memory the bridge hands over (src/memory.ts) and not something
  // the device could be asked about: see AUTO_MEMORY_SWITCH.
  env[AUTO_MEMORY_SWITCH] = '1';
  // The CLI's own git commands read the repository's `.git/config`, which can run a program (see GIT_SWITCH). Off unless the
  // operator asked for git context by name. The `delete` is for the other branch: with the context on, nothing above may have
  // left the switch behind (the allowlist does not carry it and passEnv refuses it, so this is a second barrier).
  if (options.gitContext === true) delete env[GIT_SWITCH];
  else env[GIT_SWITCH] = '1';
  return { env, refused };
}

// ---------------------------------------------------------------------------
// The pinned settings (best-effort defence in depth for the opt-in settings sources)
// ---------------------------------------------------------------------------

const API_BASE_DEFAULT = 'https://api.anthropic.com';
/** Every spelling the CLI's HTTP stack reads; a repository's `env` can set any of them. */
export const PIN_PROXY_NAMES: readonly string[] = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
];
/** Switches that make the CLI talk to a cloud provider or gateway instead of the API (measured: each redirects). */
export const PIN_PROVIDER_SELECTORS: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD', 'CLAUDE_CODE_USE_MANTLE', 'CLAUDE_CODE_USE_GATEWAY',
];
/** Where those providers (and the API itself, bar ANTHROPIC_BASE_URL which has a default) are reached. */
export const PIN_ENDPOINT_NAMES: readonly string[] = [
  'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_AWS_BASE_URL',
  'ANTHROPIC_GOOGLE_CLOUD_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL', 'CLAUDE_CODE_API_BASE_URL', 'ANTHROPIC_UNIX_SOCKET',
];
/**
 * Credentials and headers a repository could add beside, or in place of, the operator's. Not
 * ANTHROPIC_API_KEY: blanking it makes the CLI fall back to whatever login the machine has
 * (measured: an OAuth token was sent instead), which is worse, and pinning it would write the key to
 * disk. A repository CAN therefore still replace the key in an opt-in mode; see the file header.
 */
export const PIN_CREDENTIAL_NAMES: readonly string[] = [
  'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_FOUNDRY_AUTH_TOKEN', 'ANTHROPIC_AWS_API_KEY',
];
/** Switches that turn on a command-running feature a settings key then configures. */
export const PIN_FEATURE_NAMES: readonly string[] = [
  'CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER', 'CLAUDE_CODE_ENABLE_TELEMETRY', 'CLAUDE_CODE_PROCESS_WRAPPER',
];
/**
 * Variables that decide WHICH program or library a process loads. A repository that sets PATH made the
 * tap-free Read of a PDF run its own `pdftoppm` (measured), and the rest do the same job for the
 * commands a person approves: the tap shows the command, never the environment it runs in. Names the
 * child does not have are pinned to '', except the few where an empty value is itself dangerous (an
 * empty PATH entry means the current directory), which are pinned only when the child has them.
 */
export const PIN_HIJACK_NAMES: readonly string[] = [
  'PATH', 'HOME', 'SHELL', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'DYLD_FRAMEWORK_PATH',
  'BASH_ENV', 'ENV', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PERL5OPT', 'PERL5LIB',
  'RUBYOPT', 'RUBYLIB', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'GIT_ASKPASS', 'SSH_ASKPASS',
];
/** Of the above, the ones that must keep the child's value or stay unpinned, never become ''. */
export const PIN_KEEP_OR_SKIP: ReadonlySet<string> = new Set(['PATH', 'HOME', 'SHELL', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']);
/**
 * What a hijack name is pinned to when the child lacks it and '' would not mean "unset" (measured:
 * git runs an empty GIT_SSH_COMMAND and fails with "cannot run : No such file"). The value is what
 * the program does when the variable is absent.
 */
export const PIN_NEUTRAL: ReadonlyMap<string, string> = new Map([['GIT_SSH_COMMAND', 'ssh']]);

/** Settings keys whose string value is a command the CLI runs by itself, with no question asked. */
export const PIN_COMMAND_KEYS: readonly string[] = [
  'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'proxyAuthHelper',
  'otelHeadersHelper', 'processWrapper',
];
/**
 * The same for keys whose value is an OBJECT. They are blanked as objects: the CLI drops the WHOLE
 * pinned file, silently, if one key has the wrong type (measured: `statusLine: ''`, `null` and `{}`
 * all discard every other pin), so a blank string here would undo everything in this file.
 */
export const PIN_COMMAND_OBJECT_KEYS: readonly string[] = ['statusLine', 'fileSuggestion', 'subagentStatusLine'];

export interface PinnedSettings {
  env: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Settings the repository must not be able to change, written to the flag layer (the `--settings`
 * file), which outranks project and local settings. BEST-EFFORT, and only relevant when
 * `settingSources` loads a repository's files: with none, these have nothing to override. A denylist
 * rots, so test/claude-driver.test.ts reads the SDK's Settings type and fails when a command-bearing
 * key it names is not here; every pin that can be made to matter has a real-CLI test whose control
 * run shows what happens without it.
 *
 *  - `env`: each pinned to what the OPERATOR gave the child, else to nothing (see the PIN_* lists
 *    for the reason each group is there), with ANTHROPIC_BASE_URL defaulting to the public API and
 *    background work, workflows, the CLI's own memory and (unless `gitContext`) its own git commands forced
 *    off. Proxy URLs can carry a password, which is why this goes in a 0600 file and not in the command line,
 *    where `ps` would show it.
 *  - Command-bearing keys, blanked (see PIN_COMMAND_KEYS and PIN_COMMAND_OBJECT_KEYS).
 *  - `disableAllHooks`: a repository's command hooks do not run even when the policy tier is not in
 *    force (measured: SessionStart and UserPromptSubmit hooks ran without it). The driver's own SDK
 *    hook is not a settings hook and is unaffected (measured).
 *  - `disableWorkflows`, `disableSkillShellExecution`: the Workflow tool and the shell commands
 *    inside skill bodies, both of which run work the tap does not show.
 *
 * WHAT THIS STOPS AND WHAT REMAINS, as measured against CLI 2.1.314 (test/real-cli.integration.test.ts):
 *   - Stopped, each by exactly this file and each with a control run that takes ONLY that pin off and
 *     shows the exploit firing: apiKeyHelper, awsAuthRefresh, awsCredentialExport, gcpAuthRefresh and
 *     proxyAuthHelper (a shell command at the start of the first turn); the six provider selectors and
 *     the six provider endpoints (the conversation, and with Vertex the API key, sent to the
 *     repository's server); the six proxy spellings and both NO_PROXY spellings; ANTHROPIC_AUTH_TOKEN and
 *     ANTHROPIC_CUSTOM_HEADERS (credentials and headers added beside the operator's); PATH (the tap-free
 *     Read of a PDF ran a repository-supplied pdftoppm) and BASH_ENV (an approved `echo hi` ran a
 *     repository script); the background and workflow switches; disableAllHooks (a repository
 *     SessionStart hook, when the policy tier is not in force); disableSkillShellExecution.
 *   - Pinned but NOT exercisable headless, so with no control run to show them firing: otelHeadersHelper,
 *     statusLine, fileSuggestion, subagentStatusLine, processWrapper, and the names listed as
 *     unexercised in the real-CLI suite (the other hijack variables, the telemetry switch, the
 *     provider-specific keys). They are held to the SDK's Settings type instead.
 *   - NOT stopped in an opt-in mode: a repository replacing ANTHROPIC_API_KEY with its own (pinning it
 *     would write the key to disk, and blanking it makes the CLI fall back to the machine's own login);
 *     every environment variable and settings key not named above; `deny` and `ask` rules of the
 *     repository (the policy tier discards them); plugins a repository enables (nothing ran in the one
 *     headless experiment, but there is no control showing a plugin CAN run there, so it is unmeasured).
 *   `settingSources: []` covers all of these at once, which is why it is the default.
 */
export function pinnedSettings(childEnv: Readonly<Record<string, string>>, gitContext = false): PinnedSettings {
  const env: Record<string, string> = {};
  for (const name of [...PIN_PROXY_NAMES, ...PIN_PROVIDER_SELECTORS, ...PIN_ENDPOINT_NAMES, ...PIN_CREDENTIAL_NAMES, ...PIN_FEATURE_NAMES, ...PIN_HIJACK_NAMES]) {
    const own = childEnv[name];
    if (own === undefined && PIN_KEEP_OR_SKIP.has(name)) continue;
    env[name] = own ?? PIN_NEUTRAL.get(name) ?? '';
  }
  env.ANTHROPIC_BASE_URL = childEnv.ANTHROPIC_BASE_URL ?? API_BASE_DEFAULT;
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.CLAUDE_CODE_DISABLE_WORKFLOWS = '1';
  // A repository's `env` could otherwise switch the CLI's own memory back on (and `autoMemoryDirectory` point it
  // at any directory the settings name).
  env[AUTO_MEMORY_SWITCH] = '1';
  // And a repository's `env` could switch the CLI's git commands back on. Not pinned when the operator asked for git context:
  // a repository that SWITCHES THEM OFF is harmless, and a pin would undo the operator's choice.
  if (!gitContext) env[GIT_SWITCH] = '1';
  const pinned: PinnedSettings = { env, disableAllHooks: true, disableWorkflows: true, disableSkillShellExecution: true };
  for (const key of PIN_COMMAND_KEYS) pinned[key] = '';
  for (const key of PIN_COMMAND_OBJECT_KEYS) pinned[key] = { type: 'command', command: '' };
  return pinned;
}

/**
 * Policy-tier settings the SDK hands the CLI as managed settings. `allowManagedPermissionRulesOnly`
 * makes the CLI ignore `permissions` and skill `allowed-tools` from project, local and flag
 * settings; `allowManagedHooksOnly` ignores their command hooks. The driver's own SDK hook is
 * not a settings hook and keeps running (measured). Without these a repository's
 * `.claude/settings.local.json` allow rule ran a tool with no question asked.
 *
 * Two things this is NOT, both measured or documented by the SDK, and both reasons it is only one
 * of several layers: it discards every permission rule from those files, `deny` and `ask` included
 * (a repository `deny` for a file the bridge rates low no longer blocks it), and it is dropped
 * entirely when the machine has an administrator-managed tier. See `checkManagedLock`.
 */
const MANAGED_LOCK = { allowManagedPermissionRulesOnly: true, allowManagedHooksOnly: true } as const;

export type ManagedLockKey = keyof typeof MANAGED_LOCK;

export interface ManagedLockStatus {
  /** Both locks are in force: the CLI will ignore the rules and hooks of the settings files. */
  effective: boolean;
  /** The locks the CLI will NOT apply. Empty when `effective`. */
  missing: ManagedLockKey[];
  /** Where the policy tier that displaced ours came from ('file', 'mdm', 'remote', ...). */
  displacedBy: string[];
}

export interface ManagedLockDeps {
  /** Replaces the SDK's `resolveSettings` (tests). */
  resolveSettings?: typeof sdkResolveSettings;
}

/**
 * Is the driver's policy-tier lock actually in force on this machine? Asked of the SDK's own
 * resolver (the same merge engine as the CLI, no process spawned, a few milliseconds), because the
 * CLI logs nothing when an administrator's tier displaces ours. `undefined` means the question could
 * not be answered (the resolver is alpha API and may change): the caller should say "could not
 * verify" rather than "fine". It reads the policy tier only (`settingSources: []`), never a
 * repository's files.
 */
export async function checkManagedLock(cwd: string, deps: ManagedLockDeps = {}): Promise<ManagedLockStatus | undefined> {
  try {
    const resolve = deps.resolveSettings ?? (await import('@anthropic-ai/claude-agent-sdk')).resolveSettings;
    const r = await resolve({ cwd, settingSources: [], managedSettings: { ...MANAGED_LOCK } });
    const missing = (Object.keys(MANAGED_LOCK) as ManagedLockKey[]).filter((k) => r.effective[k] !== true);
    const displacedBy = new Set<string>();
    for (const src of r.sources) {
      if (src.source === 'managed' && src.policyOrigin !== undefined && String(src.policyOrigin) !== 'parent') {
        displacedBy.add(String(src.policyOrigin));
      }
    }
    return { effective: missing.length === 0, missing, displacedBy: [...displacedBy] };
  } catch {
    return undefined;
  }
}

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

// ---------------------------------------------------------------------------
// Scrubbing text that is about to leave the driver
// ---------------------------------------------------------------------------

/** What a removed secret is replaced by. Not asterisks: text.ts reads those as markdown and eats them. */
export const REDACTED = '[redacted]';
/** The shortest configured key that is removed verbatim. Shorter would shred every message it happens to appear in. */
export const KEY_MIN_LENGTH = 4;
/** Key-shaped tokens: the `sk-` family (sk-ant-api03-..., sk-proj-...). `\b` keeps "task-" and "risk-" out. */
const KEY_SHAPED = /\bsk-[A-Za-z0-9_-]{8,}/g;
/**
 * The VALUE of a header, a field or a parameter that carries a credential, at any length and with or without a
 * scheme word in front: `Authorization: Bearer abc`, `"authorization":"Basic Zm9v"`, `Proxy-Authorization: x`,
 * `x-api-key: k`, `api_key=k`, `access_token: t`. The name is kept so the log still says what was echoed.
 * The value stops at whitespace, a quote, a bracket or a separator, and may not START with `[`, which keeps
 * the placeholder itself from being matched again (redacting twice must change nothing).
 * Linear: a bounded run of blanks around the separator and then one character class, no nesting.
 */
const CREDENTIAL_FIELD =
  /\b((?:proxy-)?authorization|x-api-key|(?:anthropic[-_])?api[-_]?key|x-auth-token|(?:access|auth|refresh|id)[-_]token)(["']?[ \t]{0,8}[:=][ \t]{0,8}["']?)(?:(?:Bearer|Basic|Token|Digest|Negotiate|ApiKey)[ \t]+)?[^\s"'<>,;&()[\]{}]+/gi;
/** `?token=...` and the like in a URL or a form body that was echoed. */
const CREDENTIAL_PARAM = /([?&;](?:access_token|auth_token|id_token|refresh_token|token|api[-_]?key|key|password|passwd|secret|sig|signature)=)[^&\s"'<>#]+/gi;
/**
 * A scheme word followed by something credential-shaped, with no header name in front. Looser than it used to be
 * (8 characters, not 16): a base64 `user:pass` is 12. The value must contain a digit, a symbol or a capital after
 * its first letter, which keeps "Basic installation", "Basic Authentication" and "Token limit" in an answer.
 */
const SCHEME_VALUE = /\b(?:Bearer|Basic|Token)[ \t]+(?=[A-Za-z0-9._~+/=-]*(?:[0-9._~+/=-]|[a-z][A-Z]))[A-Za-z0-9._~+/=-]{8,}/g;
/** Any long run of token characters. Only for error text: in an answer it is mostly commit ids and UUIDs. */
const LONG_TOKEN = /[A-Za-z0-9_+/=-]{32,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove from `text` the configured key (verbatim, in every spelling given, from KEY_MIN_LENGTH characters up,
 * whatever its shape: a gateway key need not look like `sk-...`), the value of any credential-bearing field
 * (an Authorization header at any length), key-shaped tokens and echoed scheme values; at the 'error' level also
 * any long token-looking run. All patterns are linear (a bounded prefix then a character class, no nesting),
 * because this runs on text from the network, and redacting twice changes nothing more than redacting once.
 */
export function redactSecrets(text: string, apiKeys: readonly string[], level: 'answer' | 'error'): string {
  let out = text;
  for (const key of new Set(apiKeys)) {
    if (key.length >= KEY_MIN_LENGTH) out = out.split(key).join(REDACTED);
  }
  out = out
    .replace(CREDENTIAL_FIELD, `$1$2${REDACTED}`)
    .replace(CREDENTIAL_PARAM, `$1${REDACTED}`)
    .replace(SCHEME_VALUE, REDACTED)
    .replace(KEY_SHAPED, REDACTED);
  // A session id is a UUID, long and token-shaped but not a secret, and the log is more useful with it.
  if (level === 'error') out = out.replace(LONG_TOKEN, (m) => (UUID.test(m) ? m : REDACTED));
  return out;
}

class ClaudeDriver implements SessionDriver {
  readonly #cfg: ClaudeDriverConfig;
  readonly #opts: DriverOptions;
  readonly #deps: ClaudeDriverDeps;
  readonly #getQuery: () => Promise<QueryFn>;
  readonly #clock: Clock;
  readonly #graceMs: number;
  /** 0 = no watchdog. */
  readonly #stallMs: number;

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
  /** The model-silence watchdog: armed only while a turn is in flight, and re-armed lazily (see #onStallTimer). */
  #stallTimer: TimerHandle | undefined;
  /** When anything last happened on the turn in flight: a message from the CLI, or a permission request ending. */
  #lastActivity = 0;
  /** The "settings are loaded" warning has been logged, and the lock asked about. */
  #warnedSources = false;
  /** The "git context is on" warning has been logged. */
  #warnedGit = false;
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
    const stall = cfg.stallMs ?? DEFAULT_STALL_MS;
    this.#stallMs = Number.isFinite(stall) && stall > 0 ? stall : 0;
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
    // Asked to stop: the grace timer, not the silence watchdog, bounds how long that may take.
    this.#disarmStall();
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
    this.#armStall(run);
    run.input.push(userMessage(current.text, current.uuid));
  }

  /** The turn is over: clear the state BEFORE telling anyone, so a handler may call prompt() from onEvent. */
  #finishTurn(terminal: DriverEvent): void {
    this.#inFlight = false;
    this.#current = undefined;
    this.#clearGrace();
    this.#disarmStall();
    this.#emit(terminal);
  }

  #clearGrace(): void {
    if (this.#grace !== undefined) {
      this.#clock.clearTimeout(this.#grace);
      this.#grace = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // The silence watchdog
  // ---------------------------------------------------------------------------
  //
  // A connection that accepts and never answers leaves the CLI waiting for minutes (measured: no
  // terminal after 8 minutes), and the pet "thinking" the whole time. The watchdog ends such a turn.
  //
  // It is ONE timer per turn, not one per message: activity only stamps `#lastActivity`, and when
  // the timer fires it asks how long ago that was and sleeps for the rest. A streaming answer sends
  // hundreds of messages a second; a timer reset for each would be the busiest code in the driver.
  // Nothing is armed between turns, so an idle bridge holds no timer.
  //
  // Quiet is not stalled. A running tool (a build, a test run, a sub-agent) and an open permission
  // request (a person deciding) produce no events for good reasons, so the watchdog does not fire
  // while either is true. A tool still STREAMING its input does not count as running: a model that
  // went silent in the middle of writing a tool call is exactly the failure this exists for.

  #armStall(run: Run): void {
    this.#disarmStall();
    if (this.#stallMs === 0) return;
    this.#lastActivity = this.#clock.now();
    this.#stallTimer = this.#clock.setTimeout(() => this.#onStallTimer(run), this.#stallMs);
  }

  #disarmStall(): void {
    if (this.#stallTimer !== undefined) {
      this.#clock.clearTimeout(this.#stallTimer);
      this.#stallTimer = undefined;
    }
  }

  /** Something happened on the turn in flight. Cheap: it only reads the clock. */
  #touch(): void {
    this.#lastActivity = this.#clock.now();
  }

  #onStallTimer(run: Run): void {
    this.#stallTimer = undefined;
    if (this.#closed || this.#run !== run || !this.#inFlight) return;
    const paused = this.#pending.size > 0 || run.adapter.runningToolCount > 0;
    const quietFor = this.#clock.now() - this.#lastActivity;
    if (paused || quietFor < this.#stallMs) {
      // While paused, look again after a full period; the pause ending is activity, so the quiet
      // time is counted from then. Otherwise sleep for exactly what is left of the period.
      const wait = paused ? this.#stallMs : this.#stallMs - quietFor;
      this.#stallTimer = this.#clock.setTimeout(() => this.#onStallTimer(run), wait);
      return;
    }
    this.#log(`no sign of life from Claude for ${Math.round(quietFor / 1000)} s; ending the turn`);
    // Tell the CLI to drop the request, then give up on the query as well: one that has been silent
    // this long is not worth waiting for an acknowledgement from, and the next prompt resumes the
    // session on a fresh one. Whatever the old query says afterwards belongs to no turn (see #consume).
    try {
      Promise.resolve(run.q?.interrupt()).catch((err: unknown) => this.#log(`interrupt after a stall failed: ${describeError(err)}`));
    } catch (err) {
      this.#log(`interrupt after a stall failed: ${describeError(err)}`);
    }
    this.#endRun(run, stalled());
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
    // Any frame at all is a sign of life, whoever's turn it belongs to: the CLI is working.
    this.#touch();
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
    this.#disarmStall();
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
    const gitContext = cfg.gitContext === true;
    const { env, refused } = buildChildEnv(this.#deps.env ?? process.env, apiKey, cfg.passEnv, { gitContext });
    if (refused.length > 0) this.#log(`ignored environment names that may not be passed: ${refused.join(', ')}`);
    if (gitContext && !this.#warnedGit) {
      this.#warnedGit = true;
      this.#log(
        'WARNING: git context is on. Claude Code runs git in the working directory when it starts, and a filter in the ' +
          "repository's own .git/config can run a program with no question asked. Only for a repository whose .git you trust.",
      );
    }
    const sources = cfg.settingSources ?? [];
    if ((sources.includes('project') || sources.includes('local')) && !this.#warnedSources) {
      this.#warnedSources = true;
      this.#log(
        `WARNING: settings sources ${sources.join(',')} are loaded. The repository's settings can run commands, ` +
          'change the environment and redirect traffic with no question asked; the pins and the hook are best-effort. ' +
          'Only the default (no settings sources) is safe for a repository you do not trust.',
      );
      this.#reportLock();
    }
    const options: Options = {
      abortController: run.abort,
      cwd: this.#opts.cwd,
      includePartialMessages: true,
      permissionMode: 'default',
      // Default NONE: see the file header. Everything the repository's files could contribute
      // that a person wants (CLAUDE.md) comes through `systemPrompt` below instead.
      settingSources: [...(cfg.settingSources ?? [])],
      managedSettings: { ...MANAGED_LOCK },
      // Only MCP servers the bridge passes (it passes none): a repository's .mcp.json would
      // otherwise start its servers at once, with no question asked (measured).
      strictMcpConfig: true,
      // The words are dictated or typed, never a CLI command: without this "/clear" wipes the
      // conversation, "/cost" becomes the answer, and "@/etc/hostname" reads a file into the
      // prompt with no question asked (all measured). Measured cost on this CLI: none, the
      // repository's CLAUDE.md, rules and skill listing still arrive.
      verbatimPrompts: true,
      // The tools the device cannot serve, from the one list the permission handler also refuses.
      disallowedTools: [...UNSERVED_TOOL_NAMES],
      // No skills: their bodies can carry inline shell commands the CLI runs without asking (measured).
      // `disallowedTools` above removes the Skill tool, which is what closes it; this option alone does
      // not (measured), and is the second barrier.
      skills: [],
      canUseTool: (tool, input, o) => this.#canUseTool(run, tool, input, o),
      // `snapshot: false`: the SDK would otherwise record the system prompt with the session and
      // send that record on every resume (measured), so an edited CLAUDE.md or new voice rules
      // would not reach a resumed conversation. Rendered afresh, the text is the current one.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: composeSystemAppend(cfg.projectMemory), snapshot: false },
      env,
      stderr: (data) => this.#log(`claude stderr: ${data}`),
      hooks: { PreToolUse: [{ hooks: [this.#toolHook()] }] },
    };
    // The pins exist to outrank files that are LOADED. With no settings source there is nothing for them
    // to outrank, and writing them would only cost: a file on disk that can hold a proxy password, a
    // few dozen blank variables in every approved command's environment, and GIT_SSH_COMMAND set to a
    // value that overrides a person's own core.sshCommand. So no file, and no `settings` option.
    if (sources.length > 0) options.settings = this.#pinFilePath(env, gitContext);
    if (this.#sessionId !== undefined) options.resume = this.#sessionId;
    if (cfg.model !== undefined) options.model = cfg.model;
    if (cfg.maxTurns !== undefined) options.maxTurns = cfg.maxTurns;
    if (cfg.pathToClaudeCodeExecutable !== undefined) options.pathToClaudeCodeExecutable = cfg.pathToClaudeCodeExecutable;
    return options;
  }

  /**
   * Say in the log whether the policy-tier lock is in force. Only asked when a repository's files are
   * loaded (with none, there is nothing to lock), and never awaited: it informs, it does not gate.
   * A machine with an administrator's managed tier silently drops the lock (see MANAGED_LOCK).
   */
  #reportLock(): void {
    const ask = this.#deps.checkManagedLock ?? checkManagedLock;
    ask(this.#opts.cwd).then(
      (st) => {
        if (st === undefined) {
          this.#log('WARNING: could not verify that the policy-tier lock is in force; assume a repository\'s permission rules and hooks may apply');
        } else if (!st.effective) {
          const by = st.displacedBy.length > 0 ? ` (admin tier: ${st.displacedBy.join(', ')})` : '';
          // One log line is cut at LOG_LINE_MAX, so this is short on purpose.
          this.#log(`WARNING: the policy-tier lock is NOT in force${by}. Repository permission rules apply; its hooks rely on the pinned disableAllHooks.`);
        }
      },
      () => this.#log('WARNING: could not verify that the policy-tier lock is in force'),
    );
  }

  /** Write the pinned settings once and hand the CLI the path. Throws, which fails the start: better than an unpinned key. */
  #pinFilePath(env: Record<string, string>, gitContext: boolean): string {
    if (this.#pinFile !== undefined) return this.#pinFile;
    let dir = this.#deps.settingsDir;
    if (dir === undefined) {
      dir = mkdtempSync(join(tmpdir(), 'tamaclaude-'));
      this.#pinDir = dir;
    }
    const file = join(dir, 'bridge-settings.json');
    writeFileSync(file, JSON.stringify(pinnedSettings(env, gitContext)), { mode: 0o600 });
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
      // The question is over, so the quiet it caused is not silence: the watchdog counts from now.
      this.#touch();
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

  /**
   * Every event leaves through here, so the scrub below cannot be skipped by a path that forgot it
   * (the repo's recurring trap: a rule kept in one place and not in its twin). A terminal event
   * handler or a log sink that throws must not be able to break the driver.
   */
  #emit(ev: DriverEvent): void {
    try {
      this.#opts.onEvent(this.#scrubbed(ev));
    } catch (err) {
      this.#log(`onEvent threw on ${ev.k}: ${describeError(err)}`);
    }
  }

  #redact(s: string): string {
    return redactSecrets(s, [this.#cfg.apiKey, this.#cfg.apiKey.trim()], 'error');
  }

  /**
   * The event with anything key-like removed from the text a person or a log will read. The CLI's
   * error text is whatever an upstream gateway chose to echo (measured: one put the rejected key
   * in the message, and it went to the device in plaintext), so failed results and fatals get the
   * strict treatment; a model's answer and its narration get the key-shaped patterns only, because
   * a long hex string in an answer is usually a commit id.
   */
  #scrubbed(ev: DriverEvent): DriverEvent {
    const keys = [this.#cfg.apiKey, this.#cfg.apiKey.trim()];
    switch (ev.k) {
      case 'result':
        return { ...ev, text: redactSecrets(ev.text, keys, ev.ok ? 'answer' : 'error') };
      case 'fatal':
        return { ...ev, msg: redactSecrets(ev.msg, keys, 'error') };
      case 'text':
        return { ...ev, text: redactSecrets(ev.text, keys, 'answer') };
      default:
        return ev;
    }
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
