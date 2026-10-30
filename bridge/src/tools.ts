/**
 * What the handheld is told about a tool call, and which calls are never asked.
 *
 * READ THIS FIRST. Everything in here that looks like a security rule is a BACKSTOP,
 * not a sandbox. Pattern matching over shell text is trivially bypassable by a model
 * that is trying to: it can write a script with the Write tool and run it, compute a
 * path at run time, or drive an interpreter. The real controls are (1) the human tap,
 * which nothing in this file can grant, and (2) the risk label, which exists so that
 * tap is informed. The hard denies below catch the catastrophic mistakes a model makes
 * by accident and the lazy attacks a prompt injection tries first; they are not a
 * promise that nothing else can hurt you. Do not run the bridge as a user whose
 * damage you could not accept.
 *
 * Design rules that the tests pin:
 *
 *  - The summary is built ONLY from the real tool input. The model's own
 *    "description" / title text is never used, because it is exactly the text a
 *    malicious call would use to lie to the human. For a tool this file does not know
 *    (every MCP tool), only an ALLOWLIST of identifying fields (url, path, command,
 *    query, to ...) is shown; any other field is reduced to a count and a byte size,
 *    because a denylist of "narration" keys is one the model only has to step around.
 *  - Risk and deny are computed on the FULL input. The summary is cut to 96
 *    characters, and a dangerous tail must not hide behind the ellipsis; a command
 *    too long to show in full is itself 'high'.
 *  - Text that the ASCII fold would change or drop (a fullwidth solidus, a zero-width
 *    space, a Cyrillic look-alike) is shown as `?` and makes the call at least 'high':
 *    the panel must never display something other than what will run.
 *  - FAIL CLOSED. If the analyser throws, for any tool and any reason, the call is
 *    DENIED ("could not be analysed"), not asked about. A crash used to turn a
 *    hard-deny into an ordinary ask, and a crash is exactly what a hostile input aims for.
 *    Every lookup keyed by text from the model uses a Map or a Set (never a plain
 *    object, whose `__proto__` and `constructor` are keys nobody listed).
 *
 * WHICH CALLS MAY RUN WITHOUT A TAP. The driver asks the device about every call that is
 * not hard-denied and not rated 'low' here (see `needsTap`). 'low' is therefore the
 * auto-run set, and it is deliberately tiny: the built-in READ-ONLY tools (AUTO_RUN_TOOLS)
 * aimed at a place INSIDE the session's working directory (symlinks followed) that is
 * not a secret store and does not contain one. Everything else, including every Bash
 * command however harmless it looks, every write, every web tool and every MCP tool, is
 * 'med' or 'high' and needs a tap. test/tools.test.ts enumerates this set from the SDK's
 * own tool list so a new built-in cannot join it by accident.
 *
 * What the Bash analysis catches and does not is listed next to the code that does it
 * (see "COVERAGE" below); the tests exercise both columns so the list cannot rot.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { DescribeTool, Risk, ToolView } from './types.ts';
import { LIMITS } from './types.ts';
import { sanitize, sanitizeInfo, toAscii, truncateText } from './text.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Anything outside printable ASCII and plain whitespace: exactly what `toAscii` would
 * fold, drop or replace. A look-alike character is how a path or URL lies to a human
 * who can only read ASCII, so its presence is a risk in itself (see `spoofable`).
 */
const NOT_PLAIN = /[^\x20-\x7e\t\n\r]/u;
const spoofable = (s: string): boolean => NOT_PLAIN.test(s);

/**
 * The text as the panel will show it, with every character the ASCII fold would
 * silently rewrite shown as `?` instead, one per character. `toAscii` alone turns a
 * fullwidth solidus into a real one, so `github.com/evil` would look like a path on
 * github.com when the character was something else.
 */
function plain(s: string): string {
  if (!spoofable(s)) return s;
  let out = '';
  for (const ch of s) out += NOT_PLAIN.test(ch) ? '?' : ch;
  return out;
}

function labelFor(name: string): string {
  // "mcp__github__create_issue" shows its last segment: the panel is 16 characters wide.
  const last = name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return sanitize(plain(last || name), LIMITS.labelMax) || 'tool';
}

/**
 * A path keeps its END when it is too long, because the file name is what the human
 * is deciding about and a plain tail cut would show only the directories.
 */
function pathSummary(display: string): string {
  const a = toAscii(plain(display));
  if (a.length <= LIMITS.summaryMax) return a;
  return '...' + a.slice(a.length - (LIMITS.summaryMax - 3));
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Claude Code's own configuration. Writing any of it can widen what runs WITHOUT a
 * tap (a hook, an allow rule, a subagent with its own permission mode, an MCP
 * server, a skill that carries `allowed-tools`), which would defeat the whole
 * approval design, so these are refused outright rather than asked about. A project's
 * CLAUDE.md is plain instructions and stays editable.
 */
const CONFIG_FILES = new Set(['.claude.json', '.mcp.json']);
const CONFIG_RE = /(?<![\w.-])(?:\.claude|\.claude\.json|\.mcp\.json)(?![\w.-])/i;
const CONFIG_REASON = "writes Claude Code's own configuration (.claude/, .claude.json, .mcp.json), which could widen what runs without a tap";

const GLOB_CHARS = /[*?[]/;

function globToRegex(comp: string): RegExp | undefined {
  try {
    const body = comp.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
    return new RegExp(`^${body}$`, 'i');
  } catch {
    return undefined; // an unbalanced [ ... ] is not a pattern we can reason about
  }
}

/** Does a glob component such as `.cl*` or `.clau?e` expand to a config name? Bash never matches a leading dot with `*`. */
function globHitsConfig(word: string): boolean {
  if (!GLOB_CHARS.test(word)) return false;
  for (const comp of word.split('/')) {
    if (!comp.startsWith('.') || !GLOB_CHARS.test(comp)) continue;
    const re = globToRegex(comp);
    if (re && (re.test('.claude') || re.test('.claude.json') || re.test('.mcp.json'))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The secret lists
//
// WHAT COUNTS AS A SECRET STORE is data, in one exported object, and every pattern below is
// BUILT from it, so a name cannot be on a list and missing from the matching. It is exported
// because test/tools.test.ts derives its whole table from these lists (and pins a digest of
// each one) instead of keeping a second copy of the names: a mutation sweep deleted sixty
// individual entries and the suite stayed green, which is what happens when the lists live
// only in the code that uses them. Reading a secret store is 'high' (what is read goes to
// the model); so is writing one.
// ---------------------------------------------------------------------------

export const SECRET_LISTS = {
  /** A directory with one of these names, at any depth, is a secret store. */
  dirs: ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.password-store', '.oci', '.terraform.d', '.ibmcloud', '.bluemix', '.minikube'],
  /** `~/.config/<app>` directories that hold a login. */
  configApps: ['gcloud', 'gh', 'hub', 'doctl', 'rclone', 'op', 'heroku', 'huggingface'],
  /** Absolute places that are secret stores wherever the project lives. `/proc` is all of it: `environ` is every secret of a process, `cmdline` every argument. */
  absoluteRoots: [
    '/proc', '/etc/shadow', '/etc/gshadow', '/etc/master.passwd', '/etc/sudoers', '/etc/sudoers.d', '/etc/ssl/private',
    '/run/secrets', '/var/run/secrets', '/Library/Keychains', '/System/Library/Keychains',
  ],
  /**
   * Under the home directory (relative to it). The last two are the BRIDGE's own: the token file the
   * README suggests, and the default state directory (src/store.ts); a bridge started with other
   * paths registers them through `setBridgeSecrets`.
   */
  homeFiles: [
    '.claude.json', '.claude/.credentials.json', '.netrc', '.npmrc', '.pypirc', '.git-credentials', '.pgpass', '.bash_history', '.zsh_history',
    '.tamaclaude-token', '.local/state/tamaclaude-bridge',
  ],
  /**
   * `<dir>/<name>` (lower case, compared case-insensitively): the second is a secret only beneath the first. `.git/config`
   * can carry a remote URL with a token in it (the rest of `.git` is not a secret); the personal, git-ignored settings
   * file is where a project's env and tokens go; the macOS keychains live under Library. A pair, not a home-relative
   * root, so a glob such as `~/*` is not a warning only because `Library` is a directory that contains one.
   */
  pairs: [['.git', 'config'], ['.claude', 'settings.local.json'], ['library', 'keychains']],
  /** `.<name>` dotfiles that carry a login. */
  dotfiles: ['npmrc', 'netrc', 'pypirc', 'git-credentials', 'pgpass', 'my.cnf', 's3cfg', 'boto', 'htpasswd', 'vault-token', 'dockercfg', 'terraformrc', 'yarnrc.yml', 'yarnrc.yaml'],
  /** `id_<type>` and `id_<type>_sk`: private keys. */
  keyTypes: ['rsa', 'dsa', 'ecdsa', 'ed25519'],
  /** `anything.<extension>`: key material and state that holds it. */
  extensions: ['pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'kdbx', 'tfstate', 'tfvars'],
  /** `secret.<ext>` and `secrets.<ext>`. */
  secretsExtensions: ['json', 'yaml', 'yml', 'toml', 'env', 'txt'],
  /** A shell or REPL history: every command ever typed, including the ones with a password on them. (`*_history` is a pattern.) */
  historyFiles: ['.history', '.zhistory', '.lesshst', '.viminfo'],
  /** `token.<ext>`, `bridge.token`, `access_token.json`: a file named for the credential it holds. Source code (`token.ts`) is not on the list. */
  tokenExtensions: ['txt', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'dat', 'key', 'secret'],
  /**
   * Names a secret-hunting GLOB would match (`**\/.env*`, `*.pem`). Deliberately not every name above:
   * a sample for `*.yaml` or `*.txt` would ask about every search for configuration or notes.
   */
  globSamples: [
    '.env', '.envrc', '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.npmrc', '.netrc', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
    'x.pem', 'x.key', 'x.p12', 'x.pfx', 'x.jks', 'x.keystore', 'x.kdbx', 'x.tfstate', 'x.tfvars', 'credentials', 'credentials.json',
    '.bash_history', '.zsh_history', 'token', '.token', 'bridge.token', '.tamaclaude-token', 'secrets.json',
  ],
} as const;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const anyOf = (xs: readonly string[]): string => xs.map(escapeRe).join('|');

export interface SecretNamePattern {
  re: RegExp;
  /** Names that must match `re` and be rated high everywhere; the test drives every one. */
  examples: readonly string[];
  /** True when only the FILE name (the last component) is judged: a directory called `tokens` is not a secret. */
  last: boolean;
}

/** `.env.example` and friends are documentation, not secrets. */
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/;

export const SECRET_NAME_PATTERNS: readonly SecretNamePattern[] = [
  { re: /^\.env(rc)?(\..+)?$/, examples: ['.env', '.envrc', '.env.local', '.env.production', '.envrc.local'], last: false },
  { re: new RegExp(`^\\.(?:${anyOf(SECRET_LISTS.dotfiles)})$`), examples: SECRET_LISTS.dotfiles.map((n) => `.${n}`), last: false },
  {
    re: new RegExp(`^id_(?:${anyOf(SECRET_LISTS.keyTypes)})(?:_sk)?$`),
    examples: SECRET_LISTS.keyTypes.flatMap((t) => [`id_${t}`, `id_${t}_sk`]),
    last: false,
  },
  { re: /^ssh_host_.*_key$/, examples: ['ssh_host_rsa_key', 'ssh_host_ed25519_key'], last: false },
  { re: new RegExp(`\\.(?:${anyOf(SECRET_LISTS.extensions)})$`), examples: SECRET_LISTS.extensions.map((e) => `server.${e}`), last: false },
  // credentials, .credentials.json, application_default_credentials.json
  { re: /(?:^|[._-])credentials(?:\.[\w.]+)?$/, examples: ['credentials', '.credentials.json', 'application_default_credentials.json', 'aws-credentials'], last: false },
  { re: /^service-account.*\.json$/, examples: ['service-account.json', 'service-account-prod.json'], last: false },
  { re: /^\.?token$/, examples: ['token', '.token'], last: false },
  {
    re: new RegExp(`^secrets?\\.(?:${anyOf(SECRET_LISTS.secretsExtensions)})$`),
    examples: SECRET_LISTS.secretsExtensions.flatMap((e) => [`secret.${e}`, `secrets.${e}`]),
    last: false,
  },
  {
    re: new RegExp(`^(?:\\.?[\\w-]*_history|${anyOf(SECRET_LISTS.historyFiles)})$`),
    examples: ['.bash_history', '.python_history', 'psql_history', 'fish_history', ...SECRET_LISTS.historyFiles],
    last: false,
  },
  // The bridge's own token file by NAME, wherever it was put (a copy in the project, a backup beside it).
  {
    re: new RegExp(`(?:^|[._-])tokens?(?:\\.(?:${anyOf(SECRET_LISTS.tokenExtensions)}))?$`),
    examples: ['bridge.token', '.tamaclaude-token', 'my_token', 'github-token', 'tokens', ...SECRET_LISTS.tokenExtensions.map((e) => `token.${e}`), 'access_token.json'],
    last: true,
  },
];

/** The list names, for the code that reads them. */
const SECRET_DIRS: ReadonlySet<string> = new Set(SECRET_LISTS.dirs);
const SECRET_CONFIG_APPS: ReadonlySet<string> = new Set(SECRET_LISTS.configApps);
const SECRET_SAMPLES: readonly string[] = SECRET_LISTS.globSamples;

/** `**\/.env*` or `*.pem` names secret files. A pattern needs three literal characters to count, so `*` and `*.ts` do not. */
function globHitsSecret(word: string): boolean {
  if (!GLOB_CHARS.test(word)) return false;
  for (const comp of word.split('/')) {
    if (!GLOB_CHARS.test(comp) || comp.replace(/[*?[\]]/g, '').length < 3) continue;
    const re = globToRegex(comp);
    if (re && SECRET_SAMPLES.some((n) => re.test(n))) return true;
  }
  return false;
}

function mentionsConfig(word: string): boolean {
  return CONFIG_RE.test(word) || globHitsConfig(word);
}

function configComps(comps: string[]): boolean {
  return comps.some((c, i) => {
    const l = c.toLowerCase();
    return l === '.claude' || (i === comps.length - 1 && CONFIG_FILES.has(l));
  });
}

/** The longest a single file name can be on any file system we run on. */
const MAX_NAME = 255;
/** A glob this long is not one anybody typed to find a file: it is asked about rather than matched. */
const MAX_GLOB = 1024;

/** Secret stores: reading one hands the model credentials, writing one changes who the machine trusts. */
function sensitiveComps(comps: string[]): boolean {
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]!.toLowerCase();
    const next = (comps[i + 1] ?? '').toLowerCase();
    if (SECRET_DIRS.has(c)) return true;
    if (c === '.config' && SECRET_CONFIG_APPS.has(next)) return true;
    for (const [a, b] of SECRET_LISTS.pairs) if (c === a && next === b) return true;
    if (c === '.claude.json') return true; // OAuth account, MCP server environments
    // No file system has a name this long, so nothing real hides here; and a few of these patterns
    // backtrack, which a megabyte of `.credentials.credentials...` must not be able to exploit.
    if (c.length > MAX_NAME) continue;
    if (ENV_TEMPLATE_RE.test(c)) continue;
    const isFile = i === comps.length - 1;
    for (const p of SECRET_NAME_PATTERNS) if ((isFile || !p.last) && p.re.test(c)) return true;
  }
  return false;
}

/**
 * The bridge's OWN credentials, registered by the composition root at start-up (the --token-file
 * it was given, the state directory it writes to). They are secret stores wherever they live,
 * including inside the working directory, which is exactly where a token file ends up when the
 * project is the home directory. Absolute, normalised, and also resolved through symlinks when
 * they exist, so a link to the token file is the token file.
 */
let bridgeSecrets: readonly string[] = [];
let secretsGeneration = 0;

export function setBridgeSecrets(paths: readonly string[]): void {
  const out = new Set<string>();
  for (const raw of paths) {
    if (typeof raw !== 'string' || !raw.startsWith('/')) continue; // the caller resolves; a relative path means nothing here
    const norm = posix.normalize(raw).replace(/\/+$/, '') || '/';
    out.add(norm);
    try {
      out.add(realpathSync(norm));
    } catch {
      // not there yet (a token file about to be written): the lexical path stands
    }
  }
  bridgeSecrets = [...out];
  secretsGeneration++;
}

/** Which of the registered bridge secrets lie inside `cwd`? The composition root warns about them at start-up. */
export function bridgeSecretsInside(cwd: string): string[] {
  const base = posix.normalize(cwd).replace(/\/+$/, '') || '/';
  return bridgeSecrets.filter((s) => s === base || s.startsWith(base === '/' ? '/' : base + '/'));
}

let rootsFor: { key: string; roots: string[] } | undefined;

/**
 * Absolute places that are secret stores wherever the project lives, resolved against the
 * home directory: the lists above, the bridge's default state directory (also where
 * $XDG_STATE_HOME points), and whatever was registered with `setBridgeSecrets`.
 */
function secretRoots(home: string): string[] {
  const xdg = process.env['XDG_STATE_HOME'];
  const key = `${home}\0${xdg ?? ''}\0${secretsGeneration}`;
  if (rootsFor?.key === key) return rootsFor.roots;
  const h = home.replace(/\/+$/, '');
  const roots: string[] = [...SECRET_LISTS.absoluteRoots];
  for (const d of SECRET_DIRS) roots.push(`${h}/${d}`);
  for (const a of SECRET_CONFIG_APPS) roots.push(`${h}/.config/${a}`);
  for (const f of SECRET_LISTS.homeFiles) roots.push(`${h}/${f}`);
  if (xdg !== undefined && xdg.startsWith('/')) roots.push(`${posix.normalize(xdg).replace(/\/+$/, '')}/tamaclaude-bridge`);
  roots.push(...bridgeSecrets);
  rootsFor = { key, roots };
  return roots;
}

/** Is this absolute path a secret store, or inside one? */
function sensitiveAbs(abs: string, home: string): boolean {
  return secretRoots(home).some((r) => abs === r || abs.startsWith(r + '/'));
}

/** Is this directory (absolute) a place a recursive search would walk into a secret store from? */
function reachesSecret(abs: string, home: string): boolean {
  const dir = abs === '/' ? '/' : abs.replace(/\/+$/, '') + '/';
  return secretRoots(home).some((r) => r === abs || (r + '/').startsWith(dir));
}

/**
 * A glob word such as `/pro?/self/environ` or `/etc/sh*`, matched component by component
 * against the secret stores, in both directions (it may name something inside one, or a
 * directory that contains one). Bash's `*` never matches a leading dot, so it does not here.
 */
function globHitsSecretRoot(word: string, home: string): boolean {
  if (!GLOB_CHARS.test(word)) return false;
  if (word.length > MAX_GLOB) return true;
  const comps = word.split('/').filter((c) => c !== '' && c !== '.');
  const res = comps.map((c) => (GLOB_CHARS.test(c) ? globToRegex(c) : undefined));
  for (const root of secretRoots(home)) {
    const rc = root.split('/').filter((c) => c !== '');
    const n = Math.min(comps.length, rc.length);
    let ok = n > 0;
    for (let i = 0; i < n && ok; i++) {
      const re = res[i];
      if (GLOB_CHARS.test(comps[i]!)) ok = re !== undefined && re.test(rc[i]!) && (!rc[i]!.startsWith('.') || comps[i]!.startsWith('.'));
      else ok = comps[i]!.toLowerCase() === rc[i]!.toLowerCase();
    }
    if (ok) return true;
  }
  return false;
}

interface PathInfo {
  /** Absolute, normalised; undefined for a relative path when the cwd is unknown. */
  abs: string | undefined;
  norm: string;
  /** Inside the session cwd. `false` when it cannot be shown to be inside. */
  inside: boolean;
  /** Components relative to the session cwd when inside it, otherwise all of them. */
  comps: string[];
  config: boolean;
  hidden: boolean;
  /** A secret store, or a glob that could name one. */
  sensitive: boolean;
  /**
   * The same without the secret-NAME globs (`*.json` can match `credentials.json`). Bash words
   * use this one: a shell glob in a command the human taps on is not worth a warning on
   * every `ls *.json`, while a Glob or Grep that runs unasked has to be stricter.
   */
  sensitiveLiteral: boolean;
}

function expandHome(p: string, home: string): string {
  const m = /^(?:~[^/]*|\$HOME|\$\{HOME\})(?=\/|$)/.exec(p);
  return m ? home + p.slice(m[0].length) : p;
}

/**
 * `resolveFrom` is where relative paths start (the cwd, or a virtual cwd after `cd`);
 * `baseCwd` is the session cwd that defines "inside". They differ only in Bash.
 */
function inspectPath(raw: string, resolveFrom: string | undefined, baseCwd: string | undefined, home: string): PathInfo {
  const expanded = expandHome(raw, home);
  let abs: string | undefined;
  if (expanded.startsWith('/')) abs = posix.normalize(expanded);
  else if (resolveFrom !== undefined) abs = posix.resolve(resolveFrom, expanded);
  const norm = abs ?? posix.normalize(expanded);

  let inside = false;
  let comps: string[];
  if (abs !== undefined && baseCwd !== undefined) {
    const rel = posix.relative(baseCwd, abs);
    inside = rel === '' || (rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel));
    comps = (inside ? rel : abs).split('/').filter((c) => c !== '' && c !== '.');
  } else {
    // A relative path with nowhere to resolve it is inside by definition unless it climbs out.
    inside = abs === undefined && norm !== '..' && !norm.startsWith('../');
    comps = norm.split('/').filter((c) => c !== '' && c !== '.');
  }
  const all = norm.split('/').filter((c) => c !== '' && c !== '.');
  const literal = sensitiveComps(all) || sensitiveAbs(norm, home) || globHitsSecretRoot(abs ?? norm, home);
  return {
    abs,
    norm,
    inside,
    comps,
    config: configComps(all) || globHitsConfig(raw),
    hidden: comps.some((c) => c.startsWith('.') && c !== '..'),
    sensitive: literal || globHitsSecret(raw),
    sensitiveLiteral: literal,
  };
}

function displayPath(info: PathInfo, baseCwd: string | undefined): string {
  if (info.abs !== undefined && baseCwd !== undefined && info.inside) return posix.relative(baseCwd, info.abs) || '.';
  return info.abs ?? info.norm;
}

// ---------------------------------------------------------------------------
// A tolerant shell reader
//
// This is not bash. It reads enough of the grammar to split a command line into
// simple commands with their quoting removed, and to find the command and process
// substitutions inside it, so that `r""m -rf "$HOME"` and `echo $(rm -rf /)` are seen
// for what they are. Where it is unsure it errs towards reading MORE as code (it does
// not honour `#` comments, for instance), because a false alarm costs a tap and a
// miss costs a disk.
// ---------------------------------------------------------------------------

const MAX_DEPTH = 6;
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Heredoc {
  delim: string;
  quoted: boolean;
  strip: boolean;
  body: string | undefined;
}
interface Redirect {
  op: string;
  target: string;
}
interface Seg {
  words: string[];
  redirects: Redirect[];
  heredocs: Heredoc[];
  /** Everything parsed out of $(...), `...` and <(...) in this segment, at any depth. */
  subs: Seg[];
  /** Segments joined by `|` share a group. */
  group: number;
  /** Stdin comes from the previous segment of the group. */
  piped: boolean;
}
interface ParseCtx {
  nextGroup: number;
  tooDeep: boolean;
}

function matchTick(src: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') j++;
    else if (ch === '`') return j;
  }
  return -1;
}

function skipDouble(src: string, start: number): number {
  const n = src.length;
  let j = start + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') j += 2;
    else if (ch === '"') return j + 1;
    else if (ch === '$' && src[j + 1] === '(') {
      const e = matchParen(src, j + 2);
      if (e < 0) return n;
      j = e + 1;
    } else if (ch === '`') {
      const e = matchTick(src, j + 1);
      if (e < 0) return n;
      j = e + 1;
    } else j++;
  }
  return n;
}

/** `from` is just past the opening paren; returns the index of the matching `)` or -1. */
function matchParen(src: string, from: number): number {
  let depth = 1;
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') j++;
    else if (ch === "'") {
      const k = src.indexOf("'", j + 1);
      if (k < 0) return -1;
      j = k;
    } else if (ch === '"') j = skipDouble(src, j) - 1;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return j;
  }
  return -1;
}

function matchBrace(src: string, from: number): number {
  let depth = 1;
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === '\\') j++;
    else if (ch === "'") {
      const k = src.indexOf("'", j + 1);
      if (k < 0) return -1;
      j = k;
    } else if (ch === '"') j = skipDouble(src, j) - 1;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return j;
  }
  return -1;
}

/** Inner source of every $(...) and `...` in free text (heredoc bodies, ${...} contents). */
function findSubstitutions(text: string): string[] {
  const out: string[] = [];
  for (let j = 0; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '$' && text[j + 1] === '(') {
      const e = matchParen(text, j + 2);
      const end = e < 0 ? text.length : e;
      out.push(text.slice(j + 2, end));
      j = end;
    } else if (ch === '`') {
      const e = matchTick(text, j + 1);
      const end = e < 0 ? text.length : e;
      out.push(untick(text.slice(j + 1, end)));
      j = end;
    }
  }
  return out;
}

const untick = (s: string): string => s.replace(/\\([$`\\])/g, '$1');

const ANSI_SIMPLE = new Map<string, string>(Object.entries({
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
}));

/** `$'\x72m'` is `rm` to bash; the escapes are decoded so quoting cannot hide a command name. */
function decodeAnsiC(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|.)/gs, (_m, e: string) => {
    const c = e[0]!;
    if ((c === 'x' || c === 'u' || c === 'U') && e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp > 0x10ffff ? '' : String.fromCodePoint(cp);
    }
    if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    return ANSI_SIMPLE.get(c) ?? c;
  });
}

function parseScript(src: string, depth: number, ctx: ParseCtx): Seg[] {
  const out: Seg[] = [];
  if (depth > MAX_DEPTH) {
    ctx.tooDeep = true;
    return out;
  }
  const n = src.length;
  let i = 0;
  let cur = '';
  let inWord = false;
  let quoted = false;
  let words: string[] = [];
  let redirects: Redirect[] = [];
  let heredocs: Heredoc[] = [];
  let subs: Seg[] = [];
  let pendingRedir: string | undefined;
  let group = ctx.nextGroup++;
  let piped = false;
  const awaiting: Heredoc[] = [];

  const sub = (inner: string): void => {
    for (const s of parseScript(inner, depth + 1, ctx)) {
      out.push(s); // substitutions run before their parent command, so they come first
      subs.push(s);
    }
  };

  const endWord = (): void => {
    if (!inWord) return;
    if (pendingRedir !== undefined) {
      const op = pendingRedir;
      pendingRedir = undefined;
      if (op === '<<' || op === '<<-') {
        const h: Heredoc = { delim: cur, quoted, strip: op === '<<-', body: undefined };
        heredocs.push(h);
        awaiting.push(h);
      } else if (!(op.endsWith('&') && /^(\d+|-)$/.test(cur))) {
        redirects.push({ op, target: cur }); // `2>&1` duplicates a descriptor and names no file
      }
    } else {
      words.push(cur);
    }
    cur = '';
    inWord = false;
    quoted = false;
  };

  /**
   * 'pipe': the next segment reads this one's stdout. 'end': a hard boundary.
   * 'keep': a soft boundary (newline, parenthesis) that must not break a pipeline
   * whose `|` is still pending, as in "curl x |\n sh".
   */
  const endSeg = (mode: 'pipe' | 'end' | 'keep'): void => {
    endWord();
    pendingRedir = undefined;
    const nonEmpty = words.length > 0 || redirects.length > 0 || heredocs.length > 0;
    if (nonEmpty) out.push({ words, redirects, heredocs, subs, group, piped });
    words = [];
    redirects = [];
    heredocs = [];
    subs = [];
    if (mode === 'pipe') piped = true;
    else if (mode === 'end' || nonEmpty) {
      piped = false;
      group = ctx.nextGroup++;
    }
  };

  const readHeredocBodies = (): void => {
    for (let h = awaiting.shift(); h !== undefined; h = awaiting.shift()) {
      const lines: string[] = [];
      while (i < n) {
        let eol = src.indexOf('\n', i);
        const more = eol >= 0;
        if (!more) eol = n;
        const line = src.slice(i, eol);
        i = more ? eol + 1 : n;
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        lines.push(line);
      }
      h.body = lines.join('\n');
    }
  };

  /** $(...), ${...} and `...` at src[i]; true when one was consumed (quoted or not). */
  const expansion = (): boolean => {
    const c = src[i];
    if (c === '$' && src[i + 1] === '(') {
      const e = matchParen(src, i + 2);
      const end = e < 0 ? n : e;
      sub(src.slice(i + 2, end));
      cur += src.slice(i, Math.min(n, end + 1));
      i = end + 1;
      return true;
    }
    if (c === '$' && src[i + 1] === '{') {
      const e = matchBrace(src, i + 2);
      const end = e < 0 ? n : e;
      for (const inner of findSubstitutions(src.slice(i + 2, end))) sub(inner);
      cur += src.slice(i, Math.min(n, end + 1));
      i = end + 1;
      return true;
    }
    if (c === '`') {
      const e = matchTick(src, i + 1);
      const end = e < 0 ? n : e;
      sub(untick(src.slice(i + 1, end)));
      cur += src.slice(i, Math.min(n, end + 1));
      i = end + 1;
      return true;
    }
    return false;
  };

  const readDouble = (): void => {
    i++; // opening quote
    while (i < n) {
      const ch = src[i]!;
      if (ch === '"') {
        i++;
        return;
      }
      if (ch === '\\') {
        const nx = src[i + 1];
        if (nx === '\n') i += 2;
        else if (nx !== undefined && '"\\$`'.includes(nx)) {
          cur += nx;
          i += 2;
        } else {
          cur += ch;
          i++;
        }
        continue;
      }
      if (expansion()) continue;
      cur += ch;
      i++;
    }
  };

  while (i < n) {
    const c = src[i]!;
    if (c === '\\') {
      if (src[i + 1] === '\n') {
        i += 2; // line continuation
      } else if (i + 1 < n) {
        cur += src[i + 1];
        inWord = true;
        quoted = true;
        i += 2;
      } else i++;
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      cur += j < 0 ? src.slice(i + 1) : src.slice(i + 1, j);
      i = j < 0 ? n : j + 1;
      inWord = true;
      quoted = true;
      continue;
    }
    if (c === '"') {
      readDouble();
      inWord = true;
      quoted = true;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      let j = i + 2;
      while (j < n && src[j] !== "'") j += src[j] === '\\' ? 2 : 1;
      cur += decodeAnsiC(src.slice(i + 2, Math.min(j, n)));
      i = j + 1;
      inWord = true;
      quoted = true;
      continue;
    }
    if (c === '$' && src[i + 1] === '"') {
      i++; // $"..." is a double-quoted string; the quote is handled next turn
      continue;
    }
    if ((c === '$' || c === '`') && expansion()) {
      inWord = true;
      continue;
    }
    if (c === '<' || c === '>') {
      if (src[i + 1] === '(') {
        // process substitution: the inner command runs, and its output is a file name
        const e = matchParen(src, i + 2);
        const end = e < 0 ? n : e;
        sub(src.slice(i + 2, end));
        cur += src.slice(i, Math.min(n, end + 1));
        i = end + 1;
        inWord = true;
        continue;
      }
      if (inWord && /^\d+$/.test(cur) && pendingRedir === undefined) {
        cur = '';
        inWord = false; // `2>file`: the 2 is a descriptor, not an argument
      } else endWord();
      let op = c;
      i++;
      if (c === '>') {
        if (src[i] === '>') {
          op = '>>';
          i++;
        } else if (src[i] === '|') {
          op = '>|';
          i++;
        } else if (src[i] === '&') {
          op = '>&';
          i++;
        }
      } else if (src[i] === '<') {
        i++;
        if (src[i] === '<') {
          op = '<<<';
          i++;
        } else if (src[i] === '-') {
          op = '<<-';
          i++;
        } else op = '<<';
      } else if (src[i] === '&') {
        op = '<&';
        i++;
      } else if (src[i] === '>') {
        op = '<>';
        i++;
      }
      pendingRedir = op;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '\n') {
      endSeg('keep');
      i++;
      readHeredocBodies();
      continue;
    }
    if (c === ';') {
      endSeg('end');
      i++;
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '>') {
        endWord();
        const op = src[i + 2] === '>' ? '&>>' : '&>';
        i += op.length;
        pendingRedir = op;
      } else {
        endSeg('end');
        i += src[i + 1] === '&' ? 2 : 1;
      }
      continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') {
        endSeg('end');
        i += 2;
      } else {
        endSeg('pipe');
        i += src[i + 1] === '&' ? 2 : 1;
      }
      continue;
    }
    if (c === '(' || c === ')') {
      endSeg('keep');
      i++;
      continue;
    }
    cur += c;
    inWord = true;
    i++;
  }
  endSeg('end');
  return out;
}

// ---------------------------------------------------------------------------
// Bash analysis
//
// COVERAGE. Caught (denied or flagged high), each pinned by a test:
//   - flag spellings:   rm -rf, -fr, -r -f, -Rf, --recursive --force, --rec --forc
//   - spacing, tabs, quoting, backslashes, $'\x72m', "" inside a name
//   - absolute and aliased command names (/bin/rm, \rm, RM), sudo/env/xargs/timeout wrappers
//   - $HOME, ${HOME}, ~, ~/, //, /., /tmp/.. and a trailing slash, {a,b} brace lists
//   - a variable set earlier in the same command (X=/; rm -rf $X) and `cd /; rm -rf *`
//   - the same command inside bash -c '...', eval '...', $(...), `...`, <(...), (...)
//   - chains (; && || | newline) and heredoc/here-string bodies fed to a shell
//   - download piped into a shell, or into an interpreter that reads its program from stdin
//   - zsh's `=rm` (the full path of rm) and `noglob`/`nocorrect`: read as the command they name
//   - a command too big to analyse (BASH_WORK_LIMIT units of work, MAX_COMMAND_CHARS characters, a
//     find nested more than MAX_DEPTH deep in find): refused, so the analysis can never be a stall
// Flagged 'high' (the human sees the warning; nothing is refused) because the analyser
// cannot see what runs:
//   - a shell or an interpreter doing the work: bash -c, bash script.sh, source, ./script,
//     python/node/perl/ruby/php with code or a file (only a bare --version is exempt)
//   - anything that reads the environment (env, printenv, set, export -p, $SOMETHING_TOKEN),
//     /proc, shell history, ~/.claude.json, .git/config and the other secret stores
//   - a path or command computed at run time ($(echo /), $(echo rm), a glob that only
//     the filesystem can resolve)
//   - zsh syntax that runs code while a word is expanded (`*(e:'...':)`, `*(+fn)`, `${(e)x}`),
//     because the reader does not track quoting per character and a refusal is final
//   - anything that hands out stored credentials (`security`, `secret-tool`, `git credential`)
//     or runs in a place the line does not describe (docker/podman run, a VM)
// NOT caught at all, by design or because it cannot be known statically; each is a row in
// the characterisation table in test/tools.test.ts, so changing one is a deliberate act:
//   - an interpreter, script or build tool DOING the damage (python -c shutil.rmtree is
//     only 'high'), a script already on disk or written with the Write tool then run
//   - download-then-run in two steps (curl -o x; sh x), base64 into a shell, aliases, functions
//   - home-directory deletion spelled so that the path is not a literal (rm -rf ~/.[!.]*,
//     "$(echo ~)", echo ~ | xargs rm -rf, rsync --delete, mv ~ /tmp/x)
//   - only the TOP level of a system directory is protected: rm -rf /usr/lib is not denied
//     (prefix matching would also refuse rm -rf /home/me/project)
//   - symlinks, bind mounts, and relative paths after a cd that is not a literal
//   - `find` behind a wrapper this file does not list (`parallel find / -delete ::: x`): its rule
//     runs at the command position only, because applying it to every word spelled `find` made the
//     analysis exponential. (rm, chmod, dd, git and the rest still apply wherever they appear.)
//   - the other zsh-only ways to run code (aliases, functions, hooks such as precmd, `print -z`)
// ---------------------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'mksh']);
const INTERPRETERS = /^(python[\d.]*|node(js)?|deno|bun|ruby|perl|php|lua|osascript|pwsh|powershell|tsx|ts-node|rscript|julia)$/;
/** A version or help query runs no program text: the one thing an interpreter or shell may be asked that is not 'high'. */
const INFO_ONLY_RE = /^(?:-v|-V|-h|-version|-help|--version|--help)$/;
/** awk programs can run commands (system(), `print | "cmd"`, getline) and read the whole environment (ENVIRON). */
const AWK_RE = /^(?:awk|gawk|mawk|nawk)$/;
const AWK_EXEC_RE = /\bsystem\s*\(|\bgetline\b|\|&|\|\s*"|\bENVIRON\b/;
/** Commands that arrange for code to run LATER, outside any approval this session can see. */
const SCHEDULERS = new Set(['crontab', 'at', 'batch', 'launchctl', 'systemd-run']);
/** Programs run by absolute path from these directories are ordinary tools; any other path is a script in the tree or the home directory. */
const SYSTEM_BIN_RE = /^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?s?bin\//;
/** Commands that read file CONTENT recursively: pointed at a directory that contains a secret store, they read it. */
const SEARCHERS = new Set(['grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack']);
const VAR_REF_RE = /\$\{?[!#]?([A-Za-z_][A-Za-z0-9_]*)/g;
/** TOKEN, SECRET, PASSWORD, API_KEY ... as a whole word of a variable name, or a name ending in _KEY. */
const SECRET_VAR_RE = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|APIKEY|API_KEY|PRIVATE_KEY|ACCESS_KEY)(?:_|$)|_KEY$|^KEY$/i;
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'aria2c']);
const PRIVILEGE = new Set(['sudo', 'sudoedit', 'doas', 'pkexec', 'su', 'runas']);
const NETWORK = new Set(['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet']);
/** Print or manage stored credentials: the macOS keychain command, libsecret, the kernel keyring. */
const CREDENTIAL_CMDS = new Set(['security', 'secret-tool', 'keyctl']);
/** Run commands inside a virtual machine or a stack of containers: an environment the line says nothing about. */
const VM_CMDS = new Set(['lima', 'limactl', 'colima', 'multipass', 'vagrant', 'docker-compose', 'podman-compose']);
const PREFIX_WORDS = new Set(['!', '{', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'time', 'coproc']);
const READ_ONLY = new Set([
  'cat', 'less', 'more', 'head', 'tail', 'ls', 'll', 'la', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'wc', 'stat',
  'file', 'diff', 'cmp', 'du', 'df', 'tree', 'realpath', 'readlink', 'dirname', 'basename', 'test', '[', '[[',
  'echo', 'printf', 'pwd', 'jq', 'sort', 'uniq', 'cut', 'md5sum', 'sha1sum', 'sha256sum', 'shasum', 'cksum',
  'od', 'hexdump', 'strings', 'nl', 'tac', 'rev', 'column', 'which', 'type', 'cd', 'pushd', 'popd',
]);
const GIT_READ_ONLY = new Set([
  'diff', 'log', 'show', 'status', 'blame', 'ls-files', 'grep', 'shortlog', 'cat-file', 'rev-parse', 'describe',
  'ls-tree', 'rev-list', 'whatchanged', 'reflog', 'help', 'version',
]);
const SYSTEM_DIRS = new Set([
  '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/mnt', '/media', '/opt', '/proc', '/root',
  '/run', '/sbin', '/srv', '/sys', '/usr', '/var', '/users', '/system', '/library', '/applications', '/private',
  '/volumes',
]);
const BLOCK_DEV_RE =
  /^\/dev\/(?:sd[a-z]|hd[a-z]|vd[a-z]|xvd[a-z]|nvme\d|mmcblk\d|disk\d|rdisk\d|loop\d|dm-\d|md\d|mapper\/|sr\d|nbd\d|zram\d|mtd|mem$|kmem$|port$)/i;
const SAFE_DEV_RE = /^\/dev\/(?:null|zero|full|random|urandom|stdin|stdout|stderr|tty|ptmx|fd\/|shm\/|pts\/)/;

interface State {
  home: string;
  /** Session cwd: what "inside" means. */
  baseCwd: string | undefined;
  /** Where a relative path points right now; follows literal `cd`s, undefined once unknowable. */
  cwd: string | undefined;
  vars: Map<string, string>;
  deny: string | undefined;
  high: boolean;
  tooDeep: boolean;
  ctx: ParseCtx;
  /** Units of analysis work spent so far; see BASH_WORK_LIMIT. */
  work: number;
}

const noteDeny = (st: State, why: string): void => {
  st.deny ??= why;
};

/**
 * THE WORK BOUND. The analyser runs synchronously in the bridge's only thread, inside the hook
 * the CLI is waiting on, so a command that makes it spend minutes stalls the keepalive, every
 * open ask and the device with it. A ~270 character `find . -exec find . -exec ...` chain did
 * exactly that (every level re-analysed the whole tail: tens of seconds at depth 20, hours at
 * 28), and 50 000 plain words took seven seconds because every word copied the words after it.
 * Both are fixed at the root, and this bound is what keeps the NEXT shape of that bug a refusal
 * instead of a freeze.
 *
 * One unit is roughly ten microseconds: one segment parsed, one segment analysed, one rule applied,
 * one path inspected (four when it is a glob, which is matched against every secret store), or
 * WORDS_PER_UNIT plain words looked at. Past BASH_WORK_LIMIT the analysis stops and the command is
 * refused: nobody reviews a command of that size on a 25 character panel, and a refusal is final
 * only for that command (the model is told to split it up). 5 000 units is about twice what a
 * 300 line script spends (measured: 2 300) and bounds the worst stall to under a tenth of a second.
 */
export const BASH_WORK_LIMIT = 5000;
const WORDS_PER_UNIT = 8;
export const TOO_COMPLEX = 'the command is too complex to analyse; split it into smaller commands';
/** One mebibyte of characters: far past any real command, and the point at which even parsing is a stall. */
export const MAX_COMMAND_CHARS = 1 << 20;

/** Spend `units`; false once the bound is passed (the caller stops), after refusing the command. */
function spend(st: State, units: number): boolean {
  if (st.work > BASH_WORK_LIMIT) return false;
  st.work += units;
  if (st.work <= BASH_WORK_LIMIT) return true;
  st.high = true;
  noteDeny(st, TOO_COMPLEX);
  return false;
}
const overBudget = (st: State): boolean => st.work > BASH_WORK_LIMIT;

/**
 * The command a word names. Whitespace means it is prose in one argument, not a command.
 * zsh expands a word that starts with `=` to the full path of the command it names, so `=rm`
 * IS `/bin/rm` there; bash would call it a missing program. The reader cannot know which shell
 * runs the line, so it takes the dangerous reading and `=rm -rf ~` meets the same rules as `rm -rf ~`.
 */
function base(word: string): string {
  if (/\s/.test(word)) return '';
  const name = /^=[A-Za-z0-9_.+/-]/.test(word) ? word.slice(1) : word;
  return (name.split('/').pop() ?? '').toLowerCase();
}

function expandVars(w: string, st: State): string {
  return w.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (m, a?: string, b?: string) => {
    const name = (a ?? b)!;
    if (name === 'HOME') return '~';
    return st.vars.get(name) ?? m;
  });
}

/** `{a,b}` lists, one level at a time, capped so a pathological word cannot explode. */
function braceExpand(w: string, budget = { n: 64 }): string[] {
  const re = /\{([^{}]*)\}/g;
  for (let m = re.exec(w); m; m = re.exec(w)) {
    if (!m[1]!.includes(',')) continue;
    const out: string[] = [];
    for (const alt of m[1]!.split(',')) {
      if (budget.n-- <= 0) break;
      out.push(...braceExpand(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length), budget));
    }
    return out;
  }
  return [w];
}

/** Does deleting or re-owning this wreck the machine or the account? */
function catastrophic(raw: string, st: State): boolean {
  const alternatives = braceExpand(expandVars(raw, st));
  // Up to 64 spellings per word, each resolved and split: a long list of brace words is paid for like the work it is.
  if (!spend(st, alternatives.length)) return true;
  for (const w of alternatives) {
    let p = w;
    if (p.startsWith('~')) p = st.home + (p.indexOf('/') < 0 ? '' : p.slice(p.indexOf('/')));
    if (!p.startsWith('/')) {
      if (st.cwd === undefined) continue; // cannot resolve; the recursion itself is flagged high
      p = posix.resolve(st.cwd, p);
    }
    const comps = posix.normalize(p).split('/').filter((c) => c !== '' && c !== '.');
    // A trailing glob removes the directory's contents, which is as bad as removing it.
    while (comps.length > 0) {
      const last = comps[comps.length - 1]!;
      if (/^[.*?[\]!^]+$/.test(last) && /[*?[]/.test(last)) comps.pop();
      else break;
    }
    if (comps.length === 0) return true;
    const abs = '/' + comps.join('/');
    if (SYSTEM_DIRS.has(abs.toLowerCase())) return true;
    if (st.home.length > 1 && abs.toLowerCase() === st.home.toLowerCase()) return true;
  }
  return false;
}

interface Found {
  idx: number;
  wrappers: string[];
}

function skipOpts(words: string[], from: number, withArg: readonly string[] = []): number {
  let i = from;
  while (i < words.length) {
    const w = words[i]!;
    if (w === '--') return i + 1;
    if (!w.startsWith('-') || w === '-') return i;
    i += withArg.includes(w) ? 2 : 1;
  }
  return i;
}

/**
 * A Map, never a plain object: the key is the command word, which is text from the model, and
 * `WRAPPERS['__proto__']` on an object literal is `Object.prototype`. That one word used to
 * make the analyser throw and silently drop every hard-deny that came with it.
 */
const WRAPPERS = new Map<string, (w: string[], from: number) => number>(Object.entries({
  sudo: (w, f) => skipOpts(w, f, ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '-R']),
  sudoedit: (w, f) => f,
  doas: (w, f) => skipOpts(w, f, ['-u', '-C']),
  pkexec: (w, f) => skipOpts(w, f, ['--user']),
  env: (w, f) => skipOpts(w, f, ['-u', '-C', '-S', '--unset', '--chdir']),
  command: (w, f) => skipOpts(w, f),
  builtin: (w, f) => f,
  exec: (w, f) => skipOpts(w, f, ['-a']),
  nohup: (w, f) => skipOpts(w, f),
  setsid: (w, f) => skipOpts(w, f),
  nice: (w, f) => skipOpts(w, f, ['-n', '--adjustment']),
  ionice: (w, f) => skipOpts(w, f, ['-c', '-n', '-p']),
  stdbuf: (w, f) => skipOpts(w, f, ['-i', '-o', '-e']),
  timeout: (w, f) => skipOpts(w, f, ['-s', '-k', '--signal', '--kill-after']) + 1,
  xargs: (w, f) => skipOpts(w, f, ['-I', '-n', '-P', '-s', '-L', '-d', '-E', '-a', '--max-args', '--max-procs']),
  busybox: (w, f) => f,
  toybox: (w, f) => f,
  // zsh precommand modifiers: `noglob find / -delete` is `find / -delete`.
  noglob: (w, f) => f,
  nocorrect: (w, f) => f,
  // Programs that run the rest of their line, so the command after them is the command that runs.
  unbuffer: (w, f) => skipOpts(w, f),
  fakeroot: (w, f) => skipOpts(w, f),
  chronic: (w, f) => skipOpts(w, f),
  caffeinate: (w, f) => skipOpts(w, f, ['-t', '-w']),
  watch: (w, f) => skipOpts(w, f, ['-n', '--interval']),
  flock: (w, f) => skipOpts(w, f, ['-w', '-E', '--timeout', '--conflict-exit-code']) + 1, // the lock file, then the command
}));

/** The index of the word that actually names the program, after env assignments and wrappers. */
function findCommand(words: string[]): Found {
  const wrappers: string[] = [];
  let i = 0;
  for (;;) {
    while (i < words.length && ASSIGN_RE.test(words[i]!)) i++;
    const w = words[i];
    if (w === undefined) return { idx: -1, wrappers };
    if (PREFIX_WORDS.has(w)) {
      i++;
      continue;
    }
    const b = base(w);
    const skip = WRAPPERS.get(b);
    if (skip === undefined) return { idx: i, wrappers };
    wrappers.push(b);
    i = skip(words, i + 1);
  }
}

/** The script argument of `sh -c ...`, flags like -lc and -o pipefail skipped. */
function shellScript(words: string[], from: number): string | undefined {
  for (let k = from; k < words.length; k++) {
    const w = words[k]!;
    if (w === '--') return undefined;
    if (w === '-o' || w === '-O' || w === '+o' || w === '+O') {
      k++;
      continue;
    }
    if (w.startsWith('--')) continue;
    if (w.startsWith('-') && w.length > 1) {
      if (/^-[a-zA-Z]*c/.test(w)) return words[k + 1];
      continue;
    }
    return undefined; // the first operand is a script file we cannot see
  }
  return undefined;
}

function nextCwd(arg: string | undefined, st: State): string | undefined {
  if (arg === undefined) return st.home;
  if (arg === '-' || /[$`*?[]/.test(arg)) return undefined;
  const e = expandHome(arg, st.home);
  if (e.startsWith('/')) return posix.normalize(e);
  return st.cwd === undefined ? undefined : posix.resolve(st.cwd, e);
}

function checkForkBomb(src: string, st: State): void {
  // Name length is bounded so a megabyte of non-space input cannot make the match quadratic.
  const squashed = src.replace(/\s+/g, '');
  if (
    /([^(){}|&;<>]{1,32})\(\)\{\1\|\1&\}/.test(squashed) ||
    /function([^(){}|&;<>]{1,32})(?:\(\))?\{\1\|\1&\}/.test(squashed)
  ) {
    noteDeny(st, 'fork bomb');
  }
}

/** Remember `X=/` so that `rm -rf $X` is judged on what X holds. */
function recordAssignments(words: string[], st: State): void {
  for (const w of words) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(w);
    if (!m) continue;
    const v = expandVars(m[2]!, st);
    if (/[$`]/.test(v)) st.vars.delete(m[1]!);
    else st.vars.set(m[1]!, v);
  }
}

// -- per-command rules ------------------------------------------------------

function parseRm(args: string[]): { recursive: boolean; force: boolean; targets: string[] } {
  let recursive = false;
  let force = false;
  const targets: string[] = [];
  let ended = false;
  for (const w of args) {
    if (ended || !w.startsWith('-') || w === '-') {
      targets.push(w);
    } else if (w === '--') {
      ended = true;
    } else if (w.startsWith('--')) {
      // getopt_long accepts any unambiguous prefix: --rec, --recur, --forc ...
      const name = w.slice(2).split('=')[0]!;
      if (name.length > 0 && 'recursive'.startsWith(name)) recursive = true;
      if (name.length > 0 && 'force'.startsWith(name)) force = true;
    } else {
      if (/[rR]/.test(w)) recursive = true;
      if (/[fF]/.test(w)) force = true;
    }
  }
  return { recursive, force, targets };
}

function ruleRm(args: string[], st: State): void {
  const { recursive, force, targets } = parseRm(args);
  if (recursive) st.high = true;
  if (force) st.high = true;
  if (args.includes('--no-preserve-root')) st.high = true;
  if (recursive && targets.some((t) => catastrophic(t, st))) noteDeny(st, 'recursive delete of the root, a system directory or the home directory');
}

function ruleOwnership(args: string[], st: State): void {
  let recursive = false;
  const operands: string[] = [];
  let ended = false;
  for (const w of args) {
    if (ended || !w.startsWith('-') || w === '-') operands.push(w);
    else if (w === '--') ended = true;
    else if (w.startsWith('--')) {
      const name = w.slice(2).split('=')[0]!;
      if (name.length >= 3 && 'recursive'.startsWith(name)) recursive = true;
    } else if (w.includes('R')) recursive = true;
    else operands.push(w); // chmod -x: a mode, not a flag
  }
  if (!recursive) return;
  st.high = true;
  if (operands.some((t) => catastrophic(t, st))) noteDeny(st, 'recursive chmod/chown of the root, a system directory or the home directory');
}

/** `rsync --delete` makes the destination match the source, so aimed at a home directory it deletes the home directory. */
function ruleRsync(args: string[], st: State): void {
  if (!args.some((a) => a.startsWith('--delete'))) return;
  st.high = true;
  if (args.filter((a) => !a.startsWith('-')).some((t) => catastrophic(t, st))) noteDeny(st, 'rsync --delete into the root, a system directory or the home directory');
}

/**
 * Only what is moved AWAY is judged: `mv file ~` puts something in the home directory,
 * `mv ~ /tmp/x` takes the home directory out from under the account.
 */
function ruleMove(args: string[], st: State): void {
  const operands: string[] = [];
  let toDir = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-t') i++; // the directory after -t is the destination, whatever its position
    else if (a.startsWith('--target-directory')) toDir = true;
    else if (!a.startsWith('-') || a === '-') operands.push(a);
  }
  const sources = toDir ? operands.slice(1) : operands.slice(0, -1);
  if (sources.some((t) => catastrophic(t, st))) noteDeny(st, 'moves the root, a system directory or the home directory away');
}

const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);

function ruleFind(args: string[], st: State, depth: number): void {
  // A find inside a find's -exec, inside a find's -exec ...: nobody types that more than a level or two
  // deep. Past the depth the reader follows everywhere else it is refused, not rated: what hides at
  // the bottom of a chain this long is not something a human can check.
  if (depth >= MAX_DEPTH) {
    st.tooDeep = true;
    st.high = true;
    noteDeny(st, TOO_COMPLEX);
    return;
  }
  const paths: string[] = [];
  let k = 0;
  while (k < args.length && /^-[HLP]$|^-O\d$/.test(args[k]!)) k++;
  while (k < args.length && !/^[-!(]/.test(args[k]!)) paths.push(args[k++]!);

  const hasDelete = args.includes('-delete');
  let execDestructive = false;
  for (let j = 0; j < args.length; j++) {
    if (!FIND_EXEC.has(args[j]!)) continue;
    let e = j + 1;
    while (e < args.length && args[e] !== ';' && args[e] !== '+') e++;
    const inner = args.slice(j + 1, e);
    if (inner.length > 0) {
      // The command find runs is itself a command; judge it as one.
      analyzeSeg({ words: inner, redirects: [], heredocs: [], subs: [], group: -1, piped: false }, depth + 1, st);
      const at = findCommand(inner).idx;
      if (at >= 0 && ['rm', 'shred', 'unlink'].includes(base(inner[at]!))) execDestructive = true;
    }
    j = e;
  }
  if (hasDelete) st.high = true;
  if ((hasDelete || execDestructive) && paths.some((p) => catastrophic(p, st))) noteDeny(st, 'find -delete or -exec rm over the root, a system directory or the home directory');
}

function ruleDd(args: string[], st: State): void {
  for (const w of args) {
    const m = /^of=(.*)$/s.exec(w);
    if (!m) continue;
    const target = expandVars(m[1]!, st);
    if (/[$`]/.test(target)) st.high = true; // a target computed at run time may be a disk
    if (target.startsWith('/dev/') && !SAFE_DEV_RE.test(target)) noteDeny(st, 'dd writing to a device file');
  }
}

function ruleGit(args: string[], st: State): void {
  let i = 0;
  while (i < args.length) {
    const w = args[i]!;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(w)) i += 2;
    else if (w.startsWith('-')) i++;
    else break;
  }
  const sub = (args[i] ?? '').toLowerCase();
  const rest = args.slice(i + 1);
  const shortF = (w: string): boolean => /^-[a-zA-Z]*f/.test(w);
  const long = (w: string, name: string): boolean => w.startsWith('--') && name.startsWith(w.slice(2).split('=')[0]!) && w.length > 3;
  switch (sub) {
    case 'push':
      // `+ref` and `:ref` are force and delete spelled as refspecs.
      if (rest.some((w) => shortF(w) || w.startsWith('--force') || long(w, 'mirror') || long(w, 'delete') || /^[+:]\S/.test(w))) st.high = true;
      break;
    case 'reset':
      if (rest.some((w) => long(w, 'hard'))) st.high = true;
      break;
    case 'clean':
      if (rest.some((w) => shortF(w) || w.startsWith('--force'))) st.high = true;
      break;
    case 'checkout':
    case 'switch':
    case 'restore':
      if (rest.some((w) => shortF(w) || w.startsWith('--force') || w === '.')) st.high = true;
      break;
    case 'branch':
      if (rest.some((w) => /^-[a-zA-Z]*D/.test(w))) st.high = true;
      break;
    case 'credential':
      // `git credential fill` prints the stored username and password for a host.
      st.high = true;
      break;
    default:
      break;
  }
}

/** The words that have a rule of their own in `analyzeSeg`'s "wherever they appear" pass. */
const RULED = new Set(['rm', 'chmod', 'chown', 'chgrp', 'find', 'dd', 'git', 'rsync', 'docker', 'podman', 'nerdctl', 'mv', 'cp', 'ln', 'npm', 'yarn', 'pnpm', 'brew']);
const isForceFlag = (a: string): boolean => /^-[a-zA-Z]*f/.test(a) && a !== '--';

/**
 * A container runtime hands the command to a program the analyser never sees, in an environment
 * the person cannot judge from the line: `docker run -v /:/host alpine ...` is a root shell on this
 * machine's files, and a container on its own network can reach the bridge from an address the
 * local-peer refusal does not know. Anything that RUNS something is 'high'; `docker ps` and
 * `docker logs` are ordinary. (Rated, never refused: there are plenty of honest uses.)
 */
function ruleContainer(args: string[], st: State): void {
  let i = 0;
  while (i < args.length && args[i]!.startsWith('-')) i += ['-H', '--host', '-c', '--context', '--config', '--log-level'].includes(args[i]!) ? 2 : 1;
  const sub = (args[i] ?? '').toLowerCase();
  if (['run', 'create', 'exec', 'compose', 'start', 'attach', 'cp'].includes(sub)) st.high = true;
}

function analyzeScript(src: string, depth: number, st: State): void {
  checkForkBomb(src, st);
  // The depth cap lives in parseScript, which every nested script (substitution, -c, eval,
  // heredoc) goes through; it reports back through the shared context.
  const segs = parseScript(src, depth, st.ctx);
  if (st.ctx.tooDeep) st.tooDeep = true;
  if (!spend(st, segs.length)) return;
  analyzePipelines(segs, st);
  for (const seg of segs) {
    analyzeSeg(seg, depth, st);
    if (overBudget(st)) return;
  }
}

/**
 * An interpreter given no program text and no file reads its program from stdin. (Code in
 * `-c`/`-e` or a script operand is an operand, so a pipe feeding it is only data.)
 */
function readsProgramFromStdin(args: string[]): boolean {
  return args.every((a) => a.startsWith('-')) || args.includes('-');
}

function analyzePipelines(segs: Seg[], st: State): void {
  const groups = new Map<number, Seg[]>();
  for (const s of segs) {
    const g = groups.get(s.group);
    if (g) g.push(s);
    else groups.set(s.group, [s]);
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    let fetched = false;
    for (const s of g) {
      const f = findCommand(s.words);
      const cmd = f.idx >= 0 ? base(s.words[f.idx]!) : '';
      if (s.piped && SHELLS.has(cmd)) {
        // A shell reading its script from a pipe: whatever came down it is executed.
        st.high = true;
        if (fetched) noteDeny(st, 'downloaded content piped into a shell');
      }
      if (s.piped && fetched && INTERPRETERS.test(cmd) && readsProgramFromStdin(s.words.slice(f.idx + 1))) {
        // `curl x | python3` is `curl x | sh` in another language.
        st.high = true;
        noteDeny(st, 'downloaded content piped into an interpreter');
      }
      if (s.words.some((w) => FETCHERS.has(base(w)))) {
        st.high = true; // curl/wget piped anywhere: out to a server or in from one
        fetched = true;
      }
    }
  }
}

function writeTarget(raw: string, st: State): void {
  const target = expandVars(raw, st);
  if (BLOCK_DEV_RE.test(target)) {
    noteDeny(st, 'writing to a disk device file');
    return;
  }
  if (SAFE_DEV_RE.test(target)) return;
  const info = inspectPath(target, st.cwd, st.baseCwd, st.home);
  if (info.config || mentionsConfig(target)) {
    noteDeny(st, CONFIG_REASON);
    return;
  }
  if (!info.inside || info.hidden || info.sensitive) st.high = true;
}

/**
 * Does running this program execute text the analyser never sees? A shell or interpreter
 * is given code (-c, -e, a file, stdin), `source` and `.` run a file, a path-qualified
 * command (`./build.sh`, `tools/run`, `~/bin/x`) is a program that lives in the tree or
 * the home directory, and awk can call system(). Any of them can be the second step of
 * "write a script with the Write tool, then run it", which is why they are all 'high'.
 */
function runsUnseenCode(cmd: string, word: string, operands: string[]): boolean {
  if (SHELLS.has(cmd) || INTERPRETERS.test(cmd)) return !(operands.length > 0 && operands.every((o) => INFO_ONLY_RE.test(o)));
  if (cmd === 'source' || cmd === '.') return true;
  if (AWK_RE.test(cmd)) return operands.some((o) => AWK_EXEC_RE.test(o));
  return word.includes('/') && !SYSTEM_BIN_RE.test(word);
}

/** `env`, `printenv`, `set`, `export -p`, `declare -x`, `ps e`: they print every secret in the environment. */
function dumpsEnvironment(cmd: string, operands: string[], found: Found): boolean {
  if (cmd === 'printenv') return true;
  // `env` (or `env -0`, `env A=1`) with no command after it prints the environment.
  if (found.idx < 0 && found.wrappers.includes('env')) return true;
  const names = operands.filter((o) => !o.startsWith('-'));
  if (cmd === 'set') return operands.length === 0;
  if (cmd === 'export' || cmd === 'readonly') return names.length === 0;
  if (cmd === 'declare' || cmd === 'typeset') return names.length === 0 || operands.some((o) => /^-[a-zA-Z]*p/.test(o));
  // BSD-style `ps e` / `ps auxe` appends each process's environment; `ps -e` (all processes) does not.
  return cmd === 'ps' && names.some((o) => /^[a-zA-Z]+$/.test(o) && o.includes('e'));
}

function analyzeSeg(seg: Seg, depth: number, st: State): void {
  // Paid for before any per-word work, so a segment of a hundred thousand words is refused in O(1).
  if (!spend(st, 1 + seg.words.length / WORDS_PER_UNIT)) return;
  const words = seg.words.map((w) => expandVars(w, st));
  const found = findCommand(words);
  const cmd = found.idx >= 0 ? base(words[found.idx]!) : '';

  if (found.idx < 0) recordAssignments(words, st);
  if (cmd === 'export' || cmd === 'declare' || cmd === 'local' || cmd === 'readonly') recordAssignments(words, st);

  // A program name that is only known at run time cannot be inspected.
  if (found.idx >= 0 && /^[$`]|\$\(/.test(words[found.idx]!)) st.high = true;
  if (found.wrappers.some((w) => PRIVILEGE.has(w)) || PRIVILEGE.has(cmd)) st.high = true;
  if (NETWORK.has(cmd) || CREDENTIAL_CMDS.has(cmd) || VM_CMDS.has(cmd)) st.high = true;
  if (words.some((w) => w.startsWith('--force'))) st.high = true;
  if (st.tooDeep) st.high = true;

  // Code the analyser cannot read, and secrets it cannot let go by unremarked.
  const operands = found.idx >= 0 ? words.slice(found.idx + 1) : [];
  if (found.idx >= 0 && runsUnseenCode(cmd, words[found.idx]!, operands)) st.high = true;
  if (SCHEDULERS.has(cmd) || dumpsEnvironment(cmd, operands, found)) st.high = true;

  // Code hidden in strings: bash -c '...', eval '...', and scripts fed in on stdin.
  const isShell = SHELLS.has(cmd);
  let script: string | undefined;
  if (isShell) script = shellScript(words, found.idx + 1);
  if (isShell && script !== undefined) analyzeScript(script, depth + 1, st);
  if (cmd === 'eval') {
    st.high = true;
    analyzeScript(words.slice(found.idx + 1).join(' '), depth + 1, st);
  }
  const readsStdinScript = isShell && script === undefined && shellScript(words, found.idx + 1) === undefined;
  for (const h of seg.heredocs) {
    const body = h.body ?? '';
    if (readsStdinScript) analyzeScript(body, depth + 1, st);
    else {
      // An unquoted heredoc still runs $(...) inside it, even when it is only data.
      if (!h.quoted) for (const inner of findSubstitutions(body)) analyzeScript(inner, depth + 1, st);
      if (INTERPRETERS.test(cmd) && mentionsConfig(body)) noteDeny(st, CONFIG_REASON);
    }
  }
  for (const r of seg.redirects) {
    if (r.op === '<<<' && readsStdinScript) analyzeScript(expandVars(r.target, st), depth + 1, st);
  }

  // Downloaded text handed to a shell without a pipe: bash <(curl ...), eval "$(curl ...)".
  if ((isShell || cmd === 'eval' || cmd === 'source' || cmd === '.') && seg.subs.some((s) => s.words.some((w) => FETCHERS.has(base(w))))) {
    st.high = true;
    noteDeny(st, 'downloaded content passed to a shell');
  }

  // Disk-level destruction, found by command position.
  if (cmd.startsWith('mkfs') || cmd === 'mke2fs' || cmd === 'wipefs' || cmd === 'mkswap') noteDeny(st, 'formats or wipes a disk');
  if (cmd === 'diskutil' && /^(erase|secureerase|zerodisk|randomdisk|partitiondisk|apfs delete)/i.test(words.slice(found.idx + 1).join(' ').replace(/^-\S+\s*/, ''))) noteDeny(st, 'formats or wipes a disk');
  if (['tee', 'cp', 'mv', 'shred', 'truncate', 'install'].includes(cmd)) {
    for (const w of words.slice(found.idx + 1)) if (BLOCK_DEV_RE.test(w)) noteDeny(st, 'writing to a disk device file');
  }

  // Commands that are dangerous wherever they appear in the segment (a wrapper nobody listed, `watch rm -rf /`).
  // The words after one are copied only when a rule needs them, and each copy is paid for: copying them for
  // EVERY word made a plain command of fifty thousand words quadratic. `find` is the one exception to
  // "wherever": its rule re-analyses everything after each -exec, so applying it to every word spelled `find`
  // was exponential in the number of them (see ruleFind). It runs at the command position only.
  for (let j = 0; j < words.length; j++) {
    const w = words[j]!;
    if (ASSIGN_RE.test(w) || w.startsWith('-')) continue;
    const b = base(w);
    if (!RULED.has(b)) continue;
    if (b === 'find' && j !== found.idx) continue;
    if (!spend(st, 1 + (words.length - j) / WORDS_PER_UNIT)) return;
    const args = words.slice(j + 1);
    switch (b) {
      case 'rm': ruleRm(args, st); break;
      case 'chmod': case 'chown': case 'chgrp': ruleOwnership(args, st); break;
      case 'find': ruleFind(args, st, depth); break;
      case 'dd': ruleDd(args, st); break;
      case 'git': ruleGit(args, st); break;
      case 'rsync': ruleRsync(args, st); break;
      case 'docker': case 'podman': case 'nerdctl':
        ruleContainer(args, st);
        if (args.some(isForceFlag)) st.high = true;
        break;
      case 'mv': case 'cp': case 'ln': case 'npm': case 'yarn': case 'pnpm': case 'brew':
        if (b === 'mv') ruleMove(args, st);
        if (args.some(isForceFlag)) st.high = true;
        break;
      default: break;
    }
    if (overBudget(st)) return;
  }

  // Redirects and tee: where does the output land?
  for (const r of seg.redirects) {
    if (r.op === '<' || r.op === '<<<' || r.op === '<&') continue;
    writeTarget(r.target, st);
  }
  if (cmd === 'tee') for (const w of words.slice(found.idx + 1)) if (!w.startsWith('-')) writeTarget(w, st);

  // Mentioning Claude Code's configuration in anything that is not plainly a read.
  const readOnly = READ_ONLY.has(cmd) || (cmd === 'git' && GIT_READ_ONLY.has((words.slice(found.idx + 1).find((w) => !w.startsWith('-')) ?? '').toLowerCase())) ||
    (cmd === 'find' && !words.some((w) => ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'].includes(w)));
  if (!readOnly && found.idx >= 0) {
    if (words.some((w, k) => k !== found.idx && mentionsConfig(w))) noteDeny(st, CONFIG_REASON);
    // After `cd .claude`, every relative name in a mutating command lives there.
    if (st.cwd !== undefined && inspectPath(st.cwd, undefined, undefined, st.home).config) noteDeny(st, CONFIG_REASON);
  }

  // Secret stores named anywhere in the command (cat ~/.ssh/id_rsa, source .env, tr -d x < /proc/1/environ).
  // Input redirects name files too; the command word itself is not a path to a secret.
  const named = words.filter((_w, k) => k !== found.idx);
  for (const r of seg.redirects) if (r.op === '<' || r.op === '<>') named.push(r.target);
  const searches = SEARCHERS.has(cmd);
  for (const w of named) {
    const v = w.replace(/^[-\w]+=/, '');
    if (/\s/.test(v) || v.length > 512 || v.startsWith('-')) continue;
    for (const alt of braceExpand(v)) {
      // Inspecting a path is the dearest thing done per word, and a glob is matched against every secret store.
      if (!spend(st, GLOB_CHARS.test(alt) ? 4 : 1)) return;
      const info = inspectPath(alt, st.cwd, st.baseCwd, st.home);
      // grep -r pattern ~ walks into ~/.ssh: a search is judged by what is beneath its directory too.
      if (info.sensitiveLiteral || (searches && info.abs !== undefined && reachesSecret(info.abs, st.home))) st.high = true;
    }
  }

  if (cmd === 'cd' || cmd === 'pushd') st.cwd = nextCwd(words.slice(found.idx + 1).find((w) => !w.startsWith('-')), st);
  else if (cmd === 'popd') st.cwd = undefined;
}

function mentionsSecretVar(src: string): boolean {
  for (const m of src.matchAll(VAR_REF_RE)) if (SECRET_VAR_RE.test(m[1]!)) return true;
  return false;
}

/**
 * `text` with every single-quoted span removed (and, with `double`, every double-quoted span too) and
 * every backslash-escaped character blanked: what a shell would still read as syntax. An unterminated
 * quote swallows the rest, which is what the shell does with it.
 */
function withoutQuoted(text: string, double: boolean): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\\') {
      out += ' '; // an escaped character is a literal one, never syntax
      i++;
    } else if (c === "'" || (double && c === '"')) {
      const j = text.indexOf(c, i + 1);
      if (j < 0) break;
      i = j;
    } else out += c;
  }
  return out;
}

/**
 * zsh syntax that RUNS CODE while a word is being expanded, with no command word to find:
 *   - a glob qualifier with code, `*(e:'rm -rf ~':)` or `*(+function)`;
 *   - a parameter-expansion flag, `${(e)x}`, `${(P)name}`: `e` evaluates, `P` reads a variable by name.
 * Both are errors in bash, so a line that contains one was written for zsh, and the CLI runs the
 * operator's own shell. They are rated 'high' and never refused, because this reader does not track
 * quoting per character and a refusal is final: `grep 'f(name:' x` must still work. That is a choice
 * to be honest about, not coverage: zsh has more ways to run code than these two, and the README says
 * the analyser is a backstop (`=rm` and `=curl x | =sh`, which ARE command words, go through the
 * ordinary rules via `base`).
 */
function mentionsZshCode(command: string): boolean {
  if (/\$\{\(/.test(withoutQuoted(command, false))) return true;
  const bare = withoutQuoted(command, true);
  return /\([^()\s]*e:/.test(bare) || /\(\+[A-Za-z_]/.test(bare);
}

function analyzeCommand(command: string, baseCwd: string | undefined): State {
  const st: State = {
    home: safeHome(),
    baseCwd,
    cwd: baseCwd,
    vars: new Map(),
    deny: undefined,
    high: false,
    tooDeep: false,
    ctx: { nextGroup: 0, tooDeep: false },
    work: 0,
  };
  // Parsing is linear, but a megabyte of text still costs a second the bridge does not have; no
  // model writes a command this long on purpose, and a person cannot review it on the panel.
  if (command.length > MAX_COMMAND_CHARS) {
    st.high = true;
    noteDeny(st, TOO_COMPLEX);
    return st;
  }
  analyzeScript(command, 0, st);
  // Any reference to a secret-looking variable, wherever it sits (quotes, heredocs, nested -c).
  if (mentionsSecretVar(command)) st.high = true;
  if (mentionsZshCode(command)) st.high = true;
  return st;
}

/**
 * For the tests: how much work analysing `command` took, against BASH_WORK_LIMIT. A count, not a
 * clock, so a test about "this stays cheap" cannot fail because the machine was busy.
 */
export function bashWorkUnits(command: string, cwd?: string): number {
  return analyzeCommand(command, cwd === undefined ? undefined : posix.normalize(cwd)).work;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

interface Built {
  risk: Risk;
  /** The text to show, already shaped (a path keeps its end). */
  summary: string;
  deny?: string;
}

function finish(name: string, b: Built): ToolView {
  const label = labelFor(name);
  const text = sanitizeInfo(b.summary, LIMITS.summaryMax).text || label;
  const view: ToolView = { label, risk: b.deny !== undefined ? 'high' : b.risk, summary: text };
  if (b.deny !== undefined) view.deny = toAscii(b.deny);
  return view;
}

const raiseTo = (cur: Risk, r: Risk): Risk => (r === 'high' || (r === 'med' && cur === 'low') ? r : cur);

function viewBash(name: string, input: Record<string, unknown>, base: string | undefined): ToolView {
  const command = str(input.command);
  // No command string: nothing to show and nothing verifiable.
  if (command === undefined) return finish(name, { risk: 'high', summary: name });
  const info = sanitizeInfo(plain(command), LIMITS.summaryMax);
  const st = analyzeCommand(command, base);
  let risk: Risk = 'med';
  // Truncated: the human cannot see all of it. Multi-line: structure the one-line summary hides.
  // Not plain ASCII: the panel shows `?` where the command has a look-alike or invisible character.
  if (st.high || info.truncated || spoofable(command) || /[\r\n]/.test(command.trim())) risk = 'high';
  // The SDK's own escape hatch: the command runs outside the sandbox the session was configured with.
  if (input.dangerouslyDisableSandbox === true) risk = 'high';
  return finish(name, { risk, summary: info.text, deny: st.deny });
}

// -- the auto-run set -------------------------------------------------------

/**
 * THE AUTO-RUN SET. These built-in tools only read, and are the only calls that can ever be
 * rated 'low', which is what lets the driver run them without a tap. A tool joins this list
 * only if it cannot change anything, start anything or send anything anywhere; reading is
 * allowed because what is read goes to the model and the model is the session. 'low' is
 * further conditional: see `viewReader`. (`LS` and `NotebookRead` are older names that some
 * CLI versions still use; the current SDK's own list has neither.)
 */
export const AUTO_RUN_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'];
const READERS = new Set(AUTO_RUN_TOOLS);
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const isMissing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** The part of a glob up to its first wildcard component: the directory that really exists. */
function literalPrefix(abs: string): string {
  const comps = abs.split('/');
  const k = comps.findIndex((c) => GLOB_CHARS.test(c));
  return k < 0 ? abs : comps.slice(0, k).join('/') || '/';
}

/**
 * Where a path REALLY lands once symlinks are followed, judged against the real working
 * directory. A link inside the project that points at ~/.ssh is not inside the project, and
 * neither is a file about to be created beneath a link to /etc: a path that does not exist
 * yet is resolved through its nearest directory that does.
 * `undefined` means "cannot tell" (the cwd itself does not exist), so the lexical answer
 * stands; 'unknown' means it could not be resolved for a reason that is not absence (a loop,
 * a name too long, a NUL byte), which is treated as outside.
 */
function realInfo(abs: string, cwd: string, home: string): PathInfo | 'unknown' | undefined {
  let realCwd: string;
  try {
    realCwd = realpathSync(cwd);
  } catch {
    return undefined;
  }
  const tail: string[] = [];
  let probe = literalPrefix(abs);
  for (;;) {
    try {
      return inspectPath(posix.join(realpathSync(probe), ...tail), undefined, realCwd, home);
    } catch (e) {
      const up = posix.dirname(probe);
      if (!isMissing(e) || up === probe) return isMissing(e) ? undefined : 'unknown';
      tail.unshift(posix.basename(probe));
      probe = up;
    }
  }
}

/** `rel` resolved from `start` unless it already names a place of its own. */
const joinFrom = (start: string, rel: string): string => (rel.startsWith('/') || rel.startsWith('~') ? rel : posix.join(start, rel));

function viewReader(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  const target = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const pattern = str(input.pattern);
  const glob = str(input.glob);

  // 'low' means "runs without a tap", so it has to be earned on every count. Anything that
  // cannot be shown to be a plain read INSIDE the working directory is asked about.
  let risk: Risk = 'low';
  if (cwd === undefined) risk = 'med'; // "inside" means nothing without a working directory

  // The places this call touches. A search starts at its path argument, or at the cwd.
  const searches = name === 'Glob' || name === 'Grep';
  const start = searches ? (target ?? cwd) : target;
  const places: { raw: string; nameLike: boolean }[] = [];
  if (start !== undefined) places.push({ raw: start, nameLike: true });
  const filter = name === 'Glob' ? pattern : name === 'Grep' ? glob : undefined;
  if (start !== undefined && filter !== undefined) places.push({ raw: joinFrom(start, filter), nameLike: name === 'Glob' });
  // A read with nothing to read, or a search with nothing to search for, is malformed: not an auto-run.
  if (start === undefined || (searches && pattern === undefined)) risk = raiseTo(risk, 'med');

  for (const { raw, nameLike } of places) {
    const info = inspectPath(raw, cwd, cwd, home);
    // Reading a secret store is not harmless: what is read is sent to the model.
    if (info.sensitive) risk = raiseTo(risk, 'high');
    // A look-alike character makes the path on the panel a different path from the one read.
    if (nameLike && spoofable(raw)) risk = raiseTo(risk, 'high');
    // grep -r over a directory that CONTAINS ~/.ssh reads it, though nothing names it.
    if (name === 'Grep' && raw === start && info.abs !== undefined && reachesSecret(info.abs, home)) risk = raiseTo(risk, 'high');
    if (!info.inside) risk = raiseTo(risk, 'med');
    else if (cwd !== undefined && info.abs !== undefined) {
      const real = realInfo(info.abs, cwd, home);
      if (real === 'unknown' || (real !== undefined && !real.inside)) risk = raiseTo(risk, 'med');
      if (real !== undefined && real !== 'unknown' && real.sensitive) risk = raiseTo(risk, 'high');
    }
  }

  let summary: string;
  if (searches) summary = target !== undefined && pattern !== undefined ? `${pattern} in ${target}` : (pattern ?? target ?? name);
  else if (target !== undefined) summary = pathSummary(displayPath(inspectPath(target, cwd, cwd, home), cwd));
  else summary = name;
  return finish(name, { risk, summary: plain(summary) });
}

function viewWriter(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  const target = name === 'NotebookEdit' ? (str(input.notebook_path) ?? str(input.file_path)) : (str(input.file_path) ?? str(input.notebook_path));
  // A write whose target we cannot read is one we cannot judge.
  if (target === undefined) return finish(name, { risk: 'high', summary: name });
  const info = inspectPath(target, cwd, cwd, home);
  const summary = pathSummary(displayPath(info, cwd));
  if (info.config) return finish(name, { risk: 'high', summary, deny: CONFIG_REASON });
  let risk: Risk = !info.inside || info.hidden || info.sensitive || spoofable(target) ? 'high' : 'med';
  // Writing through a link inside the project writes wherever it points.
  if (cwd !== undefined && info.abs !== undefined) {
    const real = realInfo(info.abs, cwd, home);
    if (real !== undefined && real !== 'unknown' && real.config) return finish(name, { risk: 'high', summary, deny: CONFIG_REASON });
    if (real === 'unknown' || (real !== undefined && (!real.inside || real.sensitive || real.hidden))) risk = 'high';
  }
  return finish(name, { risk, summary });
}

// -- the web ------------------------------------------------------------------

/** A path longer than this is not shown in full next to its host, so it cannot be judged. */
const WEB_PATH_MAX = 64;

/** A host that is this machine or its network: a fetch there reaches things no website should. */
function privateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (h === 'localhost' || /\.(?:localhost|local|internal|lan|home|corp)$/.test(h)) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return h.includes(':') && /^(?:::1?$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::ffff:)/.test(h);
}

function viewWebFetch(name: string, input: Record<string, unknown>): ToolView {
  const raw = str(input.url);
  if (raw === undefined) return finish(name, { risk: 'med', summary: name });
  try {
    const u = new URL(raw);
    const web = u.protocol === 'http:' || u.protocol === 'https:';
    // The host is the part a human can judge; the parser (not a regex) decides what it is,
    // so "https://good.com@evil.com/" shows evil.com. The start of the path and the query follow it:
    // data leaves in them, behind a host that looks harmless.
    const shown = web ? `${u.host}${u.pathname}${u.search}` : raw;
    const info = sanitizeInfo(plain(shown), LIMITS.summaryMax);
    const risky =
      !web || u.search !== '' || u.username !== '' || u.password !== '' || u.pathname.length > WEB_PATH_MAX ||
      privateHost(u.hostname) || spoofable(raw) || info.truncated;
    return finish(name, { risk: risky ? 'high' : 'med', summary: info.text || u.host || raw });
  } catch {
    return finish(name, { risk: 'high', summary: plain(raw) });
  }
}

function viewWebSearch(name: string, input: Record<string, unknown>): ToolView {
  const q = str(input.query);
  if (q === undefined) return finish(name, { risk: 'med', summary: name });
  // A search is data leaving: if the panel cannot show all of it, or shows `?` for part of it, say so.
  const info = sanitizeInfo(plain(q), LIMITS.summaryMax);
  return finish(name, { risk: info.truncated || spoofable(q) ? 'high' : 'med', summary: info.text });
}

// -- tools this file does not know ------------------------------------------

/**
 * The only fields of an UNKNOWN tool's input that are ever shown (compared lower-cased with
 * `_` and `-` removed, so `file_path`, `filePath` and `FILE-PATH` are one). They say WHAT a call
 * is aimed at. Everything else -- body, text, content, description, note, prompt -- is the
 * model's free text, which is exactly where a lie to the human would go, and is never shown:
 * it is only counted. Credentials (key, token, password) are deliberately not on the list.
 */
const IDENT_KEYS = new Set([
  'url', 'uri', 'href', 'path', 'filepath', 'filename', 'file', 'dir', 'directory', 'command', 'cmd', 'script',
  'query', 'q', 'sql', 'to', 'cc', 'bcc', 'recipient', 'recipients', 'channel', 'repo', 'repository', 'owner',
  'id', 'name', 'projectid', 'project', 'table', 'branch', 'ref', 'sha', 'domain', 'host', 'hostname', 'server',
  'resource', 'user', 'username', 'email', 'address', 'target', 'source', 'destination', 'dest', 'skill', 'taskid',
]);
const AGENT_KEYS = new Set(['subagenttype', 'mode', 'model']);
const FIELD_VALUE_MAX = 48;
const NAME_SHOWN_MAX = 40;

function fieldText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.join(',');
  return undefined;
}

/**
 * `name key=value ... (N fields, M B)`: the tool, the allowlisted fields that fit, and how
 * much input there was in total. A call with no identifying field at all reads
 * `name (N fields, M B)`, which says plainly that the panel cannot tell you what it does.
 */
function identifySummary(name: string, input: Record<string, unknown>, keys: Set<string>, stats: boolean): string {
  const n = Object.keys(input).length;
  let bytes = '?';
  try {
    bytes = String(Buffer.byteLength(JSON.stringify(input) ?? '', 'utf8'));
  } catch {
    // circular or BigInt: the size is unknown, which the summary says
  }
  const suffix = stats ? ` (${n} field${n === 1 ? '' : 's'}, ${bytes} B)` : '';
  let out = sanitize(plain(name), NAME_SHOWN_MAX) || 'tool';
  for (const [k, v] of Object.entries(input)) {
    if (!keys.has(k.toLowerCase().replace(/[_-]/g, ''))) continue;
    const t = fieldText(v);
    if (t === undefined) continue;
    const value = sanitize(plain(t), FIELD_VALUE_MAX);
    if (value === '') continue;
    const piece = ` ${k.toLowerCase()}=${value}`;
    const room = LIMITS.summaryMax - suffix.length - out.length;
    if (piece.length <= room) out += piece;
    else {
      if (room > 12) out += truncateText(piece, room);
      break;
    }
  }
  return out + suffix;
}

const WRITER_NAME_RE = /write|edit|create|save|put|append|replace|move|rename|copy|delete|remove|patch|update|touch|mkdir|insert|upload|overwrite|modify|set/i;

/** Rated 'high' without exception: nothing here knows what the tool does, only what it was aimed at. */
function viewUnknown(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  const summary = identifySummary(name, input, IDENT_KEYS, true);
  // A file-writing tool we have never heard of (an MCP filesystem server) that is pointed at
  // Claude Code's configuration is the same attack through a different door.
  if (WRITER_NAME_RE.test(labelFor(name))) {
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.length <= 1024 && !/\s/.test(v.trim()) && inspectPath(v.trim(), cwd, cwd, home).config) {
        return finish(name, { risk: 'high', summary, deny: CONFIG_REASON });
      }
    }
  }
  return finish(name, { risk: 'high', summary });
}

/**
 * Built-in tools that only keep the session's own books (the to-do list, tool lookup).
 * They still need a tap -- they are not read-only, so they are not in the auto-run set -- but
 * they are 'med' rather than 'high', because crying wolf on every to-do update teaches the
 * player to ignore the label that matters.
 */
const SESSION_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'ToolSearch']);

function viewSession(name: string, input: Record<string, unknown>): ToolView {
  if (name === 'TodoWrite' && Array.isArray(input.todos)) return finish(name, { risk: 'med', summary: `${name} (${input.todos.length} items)` });
  return finish(name, { risk: 'med', summary: identifySummary(name, input, IDENT_KEYS, false) });
}

/**
 * A subagent can be started in a permission mode that never asks. That is the same
 * escape as editing the settings file (work happens without a tap), so it is refused
 * rather than asked about; the modes that keep asking are the only ones let through.
 */
const ASKING_MODES = new Set(['default', 'plan']);

function viewAgent(name: string, input: Record<string, unknown>): ToolView {
  // The prompt and description are the model's own account of the task, so only the fields that
  // identify WHAT is being started are eligible for the summary. That means the person who taps
  // ALLOW approves a task they cannot read: a sub-agent whose whole brief (the prompt) is never
  // shown, and which may be told to do anything the model could do. Its own tool calls still ask
  // one by one, which bounds the damage but not the surprise, so every Agent call is 'high' and the
  // README lists "what a delegated task was asked to do" among the things 96 characters cannot show.
  const summary = identifySummary(name, input, AGENT_KEYS, false);
  const mode = input.mode;
  if (mode === undefined || (typeof mode === 'string' && ASKING_MODES.has(mode))) return finish(name, { risk: 'high', summary });
  return finish(name, { risk: 'high', summary, deny: 'starts a subagent in a permission mode that does not ask the user' });
}

// -- tools the device cannot serve ------------------------------------------

/**
 * Tools that would hang, answer the model with a lie, or run work the person cannot see, on a
 * handheld that has no keyboard, no multiple-choice screen, no way to wake the session later and
 * 96 characters to describe a call. They are refused with a reason the MODEL reads, so it does the
 * useful thing instead of retrying. Each entry is here because ALLOWING it would be worse than
 * refusing it:
 *  - AskUserQuestion: the panel cannot show the question, and a tap on ALLOW tells the model
 *    "the user did not answer", which it reads as an answer.
 *  - ScheduleWakeup, CronCreate, CronDelete, CronList: they create or manage turns that start
 *    on their own later; nothing in a voice session is listening for those (and a result with
 *    no prompt behind it is exactly what the driver now refuses to report).
 *  - Monitor: streams a background process's output into the session as unprompted turns.
 *  - Workflow: runs a script of sub-agents in the background; the ask shows the first 48 characters
 *    of up to half a megabyte of script, and its agents' own asks surface later, under whatever
 *    prompt happens to be in flight.
 *  - Skill: a skill body can carry inline shell commands that the CLI runs under its own read-only
 *    rules, never through the permission callback, so one tap on "Skill" ran `cat .env` unasked.
 *  - EnterPlanMode, ExitPlanMode: a tap on ALLOW tells the model "the user approved the plan",
 *    which nobody reviewed on a panel that cannot show one.
 *  - SendMessage, ListAgents, TaskStop: they address background agents and tasks, which a voice
 *    session does not start (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) and cannot supervise.
 *  - EnterWorktree, ExitWorktree: they move the session's working directory, which is what
 *    "inside the working directory" is judged against.
 *  - ReportFindings: hands structured output to a host UI that does not exist here.
 * The names are exact tool names from the SDK's BUILTIN_TOOL_NAMES (test/tools.test.ts checks every
 * one; an MCP tool that happens to share a name has a different, prefixed one), and each was seen
 * in the first request the real CLI sends to the model, or in the listing ToolSearch loads next.
 *
 * THIS IS THE ONE LIST. The driver hides exactly these names from the model (`disallowedTools`),
 * the permission handler refuses exactly these names, and `describeTool` rates them all the same
 * way; none of them keeps a copy.
 */
const UNSERVED_TOOLS = new Map<string, string>([
  ['AskUserQuestion', 'This device cannot show multiple-choice questions; ask one short question in your final message instead.'],
  ['ScheduleWakeup', 'Wake-ups are not available in this voice session; do the work now, or say in your final message what to do later.'],
  ['CronCreate', 'Scheduled tasks are not available in this voice session; do the work now, or say in your final message what to schedule.'],
  ['CronDelete', 'Scheduled tasks are not available in this voice session; there is nothing to delete.'],
  ['CronList', 'Scheduled tasks are not available in this voice session; there is nothing to list.'],
  ['Monitor', 'Background monitors are not available in this voice session; run it to completion and report in your final message.'],
  ['Workflow', 'Workflows are not available in this voice session; do the steps yourself with the ordinary tools, one at a time.'],
  ['Skill', 'Skills are not available in this voice session; do the steps yourself with the ordinary tools.'],
  ['EnterPlanMode', 'Plan mode is not available in this voice session; say your plan in your final message instead.'],
  ['ExitPlanMode', 'Plan mode is not available in this voice session; say the plan in your final message instead.'],
  ['SendMessage', 'Messaging other agents is not available in this voice session; do the work yourself.'],
  ['ListAgents', 'Other agents are not available in this voice session; there is nothing to list.'],
  ['TaskStop', 'Background tasks are not available in this voice session; there is nothing to stop.'],
  ['EnterWorktree', 'Worktrees are not available in this voice session; work in the current directory.'],
  ['ExitWorktree', 'Worktrees are not available in this voice session; there is nothing to exit.'],
  ['ReportFindings', 'Reporting findings is not available in this voice session; put the findings in your final message.'],
]);

/** Older spellings the SDK still resolves (its LEGACY_TOOL_NAME_ALIASES); a test checks every alias of an unserved tool is here. */
const UNSERVED_ALIASES = new Map<string, string>([
  ['KillShell', 'TaskStop'],
  ['KillBash', 'TaskStop'],
  ['ListPeers', 'ListAgents'],
]);

/**
 * The same names as a list, for whoever stops OFFERING them to the model (the driver's
 * `disallowedTools`): one fact, one place, so the two cannot drift apart.
 */
export const UNSERVED_TOOL_NAMES: readonly string[] = [...UNSERVED_TOOLS.keys()];

/** Why this tool is refused outright, in words the model reads; undefined when it is not on the list. */
export function unservedReason(name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  return UNSERVED_TOOLS.get(UNSERVED_ALIASES.get(name) ?? name);
}

// -- entry point --------------------------------------------------------------

function describe(name: string, input: Record<string, unknown>, cwd: string | undefined): ToolView {
  const unserved = unservedReason(name);
  if (unserved !== undefined) return finish(name, { risk: 'high', summary: name, deny: unserved });
  const home = safeHome();
  if (name === 'Bash') return viewBash(name, input, cwd);
  if (name === 'Agent' || name === 'Task') return viewAgent(name, input);
  if (READERS.has(name)) return viewReader(name, input, cwd, home);
  if (WRITERS.has(name)) return viewWriter(name, input, cwd, home);
  if (name === 'WebFetch') return viewWebFetch(name, input);
  if (name === 'WebSearch') return viewWebSearch(name, input);
  if (SESSION_TOOLS.has(name)) return viewSession(name, input);
  return viewUnknown(name, input, cwd, home);
}

/** `os.homedir()` throws when the account has no home; the answer must not become "deny everything". */
function safeHome(): string {
  try {
    return homedir();
  } catch {
    return '/nonexistent-home';
  }
}

/** Why a call whose analysis crashed is refused. The model reads it, so it says what happened. */
export const ANALYSIS_FAILED = 'the call could not be analysed (an internal error in the bridge), so it is refused';

/**
 * The view for a call the analyser could not process. It is a DENY, not an ask: a crash on
 * hostile input must never turn a refusal into something a tired thumb can approve. Nothing
 * here touches the input, so it cannot throw in turn.
 */
function failClosed(name: unknown): ToolView {
  let label = 'tool';
  try {
    label = labelFor(typeof name === 'string' ? name : String(name));
  } catch {
    // an object whose toString throws: the generic label stands
  }
  return { label, risk: 'high', summary: label, deny: ANALYSIS_FAILED };
}

type Analyser = (name: string, input: Record<string, unknown>, cwd: string | undefined) => ToolView;

/**
 * The seam that lets a test prove the fail-closed rule with an analyser that throws on
 * demand. Production uses `describeTool` below, which is this with the real analyser.
 */
export function makeDescribeTool(analyse: Analyser): DescribeTool {
  return (name, input, cwd) => {
    try {
      const n = typeof name === 'string' ? name : String(name);
      const inp = isRecord(input) ? input : {};
      // A relative cwd cannot define "inside"; treat it as unknown rather than guess.
      const base = typeof cwd === 'string' && cwd.startsWith('/') ? posix.normalize(cwd) : undefined;
      return analyse(n, inp, base);
    } catch {
      return failClosed(name);
    }
  };
}

export const describeTool: DescribeTool = makeDescribeTool(describe);

/**
 * The single answer to "may this run without a tap?": only a call rated 'low' and not
 * refused. The driver's PreToolUse hook asks this (through the server) so that no rule,
 * settings file or CLI default can skip the device for anything else.
 */
export function needsTap(name: string, input: Record<string, unknown>, cwd?: string, describe: DescribeTool = describeTool): boolean {
  const v = describe(name, input, cwd);
  // A refused call can never be free, whatever risk its view carries (`finish` makes it high, but this
  // is the function the driver trusts, so it does not rely on that).
  return v.deny !== undefined || v.risk !== 'low';
}
