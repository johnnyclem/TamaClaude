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
 *    malicious call would use to lie to the human.
 *  - Risk and deny are computed on the FULL input. The summary is cut to 96
 *    characters, and a dangerous tail must not hide behind the ellipsis; a command
 *    too long to show in full is itself 'high'.
 *
 * What the Bash analysis catches and does not is listed next to the code that does it
 * (see "COVERAGE" below); the tests exercise both columns so the list cannot rot.
 */

import { homedir } from 'node:os';
import { posix } from 'node:path';
import type { DescribeTool, Risk, ToolView } from './types.ts';
import { LIMITS } from './types.ts';
import { sanitize, sanitizeInfo, toAscii } from './text.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bump = (r: Risk): Risk => (r === 'low' ? 'med' : 'high');

function labelFor(name: string): string {
  // "mcp__github__create_issue" shows its last segment: the panel is 16 characters wide.
  const last = name.startsWith('mcp__') ? name.slice(name.lastIndexOf('__') + 2) : name;
  return sanitize(last || name, LIMITS.labelMax) || 'tool';
}

/**
 * A path keeps its END when it is too long, because the file name is what the human
 * is deciding about and a plain tail cut would show only the directories.
 */
function pathSummary(display: string): string {
  const a = toAscii(display);
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

/** Names a secret-hunting glob would match. */
const SECRET_SAMPLES = ['.env', '.envrc', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519', 'x.pem', 'x.key', 'credentials', 'credentials.json'];

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

const SECRET_DIRS = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.password-store']);
const SECRET_FILE_RE = [
  /^\.env(rc)?(\..+)?$/,
  /^\.(npmrc|netrc|pypirc|git-credentials|pgpass|my\.cnf|s3cfg|boto|htpasswd|vault-token|credentials\.json)$/,
  /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/,
  /^credentials(\.json)?$/,
  /^service-account.*\.json$/,
];
const ENV_TEMPLATE_RE = /^\.env\.(example|sample|template|dist)$/;

/** Secret stores: reading one hands the model credentials, writing one changes who the machine trusts. */
function sensitiveComps(comps: string[]): boolean {
  for (let i = 0; i < comps.length; i++) {
    const c = comps[i]!.toLowerCase();
    if (SECRET_DIRS.has(c)) return true;
    if (c === '.config' && ['gcloud', 'gh', 'hub'].includes((comps[i + 1] ?? '').toLowerCase())) return true;
    if (ENV_TEMPLATE_RE.test(c)) continue;
    if (SECRET_FILE_RE.some((re) => re.test(c))) return true;
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
  sensitive: boolean;
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
  return {
    abs,
    norm,
    inside,
    comps,
    config: configComps(all) || globHitsConfig(raw),
    hidden: comps.some((c) => c.startsWith('.') && c !== '..'),
    sensitive: sensitiveComps(all) || globHitsSecret(raw),
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

const ANSI_SIMPLE: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v',
  '\\': '\\', "'": "'", '"': '"', '?': '?',
};

/** `$'\x72m'` is `rm` to bash; the escapes are decoded so quoting cannot hide a command name. */
function decodeAnsiC(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|.)/gs, (_m, e: string) => {
    const c = e[0]!;
    if ((c === 'x' || c === 'u' || c === 'U') && e.length > 1) {
      const cp = parseInt(e.slice(1), 16);
      return cp > 0x10ffff ? '' : String.fromCodePoint(cp);
    }
    if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    return ANSI_SIMPLE[c] ?? c;
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
// NOT caught, by design or because it cannot be known statically:
//   - a path or command computed at run time ($(echo /), $(echo rm), a glob that only
//     the filesystem can resolve), so those are flagged 'high' as "cannot inspect"
//   - an interpreter doing it (python -c shutil.rmtree, node -e, perl -e)
//   - a script already on disk, or written first with the Write tool and then run
//   - download-then-run in two steps (curl -o x; sh x), aliases and shell functions
//   - symlinks, bind mounts, and relative paths after a cd that is not a literal
// ---------------------------------------------------------------------------

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'csh', 'tcsh', 'mksh']);
const INTERPRETERS = /^(python[\d.]*|node(js)?|deno|bun|ruby|perl|php|lua|osascript)$/;
const FETCHERS = new Set(['curl', 'wget', 'fetch', 'aria2c']);
const PRIVILEGE = new Set(['sudo', 'sudoedit', 'doas', 'pkexec', 'su', 'runas']);
const NETWORK = new Set(['ssh', 'scp', 'sftp', 'nc', 'ncat', 'netcat', 'socat', 'telnet']);
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
}

const noteDeny = (st: State, why: string): void => {
  st.deny ??= why;
};

/** The command a word names. Whitespace means it is prose in one argument, not a command. */
function base(word: string): string {
  if (/\s/.test(word)) return '';
  return (word.split('/').pop() ?? '').toLowerCase();
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
  for (const w of braceExpand(expandVars(raw, st))) {
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
      if (/^[.*?[\]]+$/.test(last) && /[*?[]/.test(last)) comps.pop();
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

const WRAPPERS: Record<string, (w: string[], from: number) => number> = {
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
};

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
    const skip = WRAPPERS[b];
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

function ruleFind(args: string[], st: State, depth: number): void {
  const paths: string[] = [];
  let k = 0;
  while (k < args.length && /^-[HLP]$|^-O\d$/.test(args[k]!)) k++;
  while (k < args.length && !/^[-!(]/.test(args[k]!)) paths.push(args[k++]!);

  const hasDelete = args.includes('-delete');
  let execDestructive = false;
  for (let j = 0; j < args.length; j++) {
    if (!['-exec', '-execdir', '-ok', '-okdir'].includes(args[j]!)) continue;
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
    default:
      break;
  }
}

function analyzeScript(src: string, depth: number, st: State): void {
  checkForkBomb(src, st);
  // The depth cap lives in parseScript, which every nested script (substitution, -c, eval,
  // heredoc) goes through; it reports back through the shared context.
  const segs = parseScript(src, depth, st.ctx);
  if (st.ctx.tooDeep) st.tooDeep = true;
  analyzePipelines(segs, st);
  for (const seg of segs) analyzeSeg(seg, depth, st);
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

function analyzeSeg(seg: Seg, depth: number, st: State): void {
  const words = seg.words.map((w) => expandVars(w, st));
  const found = findCommand(words);
  const cmd = found.idx >= 0 ? base(words[found.idx]!) : '';

  if (found.idx < 0) recordAssignments(words, st);
  if (cmd === 'export' || cmd === 'declare' || cmd === 'local' || cmd === 'readonly') recordAssignments(words, st);

  // A program name that is only known at run time cannot be inspected.
  if (found.idx >= 0 && /^[$`]|\$\(/.test(words[found.idx]!)) st.high = true;
  if (found.wrappers.some((w) => PRIVILEGE.has(w)) || PRIVILEGE.has(cmd)) st.high = true;
  if (NETWORK.has(cmd)) st.high = true;
  if (words.some((w) => w.startsWith('--force'))) st.high = true;
  if (st.tooDeep) st.high = true;

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

  // Commands that are dangerous wherever they appear in the segment.
  for (let j = 0; j < words.length; j++) {
    const w = words[j]!;
    if (ASSIGN_RE.test(w) || w.startsWith('-')) continue;
    const b = base(w);
    const args = words.slice(j + 1);
    switch (b) {
      case 'rm': ruleRm(args, st); break;
      case 'chmod': case 'chown': case 'chgrp': ruleOwnership(args, st); break;
      case 'find': ruleFind(args, st, depth); break;
      case 'dd': ruleDd(args, st); break;
      case 'git': ruleGit(args, st); break;
      case 'cp': case 'mv': case 'ln': case 'docker': case 'npm': case 'yarn': case 'pnpm': case 'brew':
        if (args.some((a) => /^-[a-zA-Z]*f/.test(a) && a !== '--')) st.high = true;
        break;
      default: break;
    }
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

  // Secret stores named anywhere in the command (cat ~/.ssh/id_rsa, source .env).
  for (let k = 0; k < words.length; k++) {
    if (k === found.idx) continue;
    const w = words[k]!;
    const v = w.replace(/^[-\w]+=/, '');
    if (!/\s/.test(v) && v.length <= 512 && !v.startsWith('-') && sensitiveComps(v.split('/'))) st.high = true;
  }

  if (cmd === 'cd' || cmd === 'pushd') st.cwd = nextCwd(words.slice(found.idx + 1).find((w) => !w.startsWith('-')), st);
  else if (cmd === 'popd') st.cwd = undefined;
}

function analyzeCommand(command: string, baseCwd: string | undefined): State {
  const st: State = {
    home: homedir(),
    baseCwd,
    cwd: baseCwd,
    vars: new Map(),
    deny: undefined,
    high: false,
    tooDeep: false,
    ctx: { nextGroup: 0, tooDeep: false },
  };
  analyzeScript(command, 0, st);
  return st;
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

function viewBash(name: string, input: Record<string, unknown>, base: string | undefined): ToolView {
  const command = str(input.command);
  // No command string: nothing to show and nothing verifiable.
  if (command === undefined) return finish(name, { risk: 'high', summary: name });
  const info = sanitizeInfo(command, LIMITS.summaryMax);
  const st = analyzeCommand(command, base);
  let risk: Risk = 'med';
  // Truncated: the human cannot see all of it. Multi-line: structure the one-line summary hides.
  if (st.high || info.truncated || /[\r\n]/.test(command.trim())) risk = 'high';
  // The SDK's own escape hatch: the command runs outside the sandbox the session was configured with.
  if (input.dangerouslyDisableSandbox === true) risk = 'high';
  return finish(name, { risk, summary: info.text, deny: st.deny });
}

const READERS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function viewReader(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  const target = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const pattern = str(input.pattern);
  const glob = str(input.glob);
  const checked = [target, name === 'Glob' ? pattern : undefined, glob].filter((s): s is string => s !== undefined);

  // Reading a secret store is not harmless: what is read is sent to the model.
  const sensitive = checked.some((p) => inspectPath(p, cwd, cwd, home).sensitive);
  let risk: Risk = sensitive ? 'high' : 'low';

  let summary: string;
  if (name === 'Glob' || name === 'Grep') {
    summary = target !== undefined && pattern !== undefined ? `${pattern} in ${target}` : (pattern ?? target ?? name);
    if (pattern === undefined) risk = bump(risk);
  } else if (target !== undefined) {
    summary = pathSummary(displayPath(inspectPath(target, cwd, cwd, home), cwd));
  } else {
    summary = name;
    risk = bump(risk);
  }
  return finish(name, { risk, summary });
}

function viewWriter(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  const target = name === 'NotebookEdit' ? (str(input.notebook_path) ?? str(input.file_path)) : (str(input.file_path) ?? str(input.notebook_path));
  // A write whose target we cannot read is one we cannot judge.
  if (target === undefined) return finish(name, { risk: 'high', summary: name });
  const info = inspectPath(target, cwd, cwd, home);
  const summary = pathSummary(displayPath(info, cwd));
  if (info.config) return finish(name, { risk: 'high', summary, deny: CONFIG_REASON });
  const risk: Risk = !info.inside || info.hidden || info.sensitive ? 'high' : 'med';
  return finish(name, { risk, summary });
}

function viewWebFetch(name: string, input: Record<string, unknown>): ToolView {
  const raw = str(input.url);
  if (raw === undefined) return finish(name, { risk: 'med', summary: name });
  try {
    const u = new URL(raw);
    const web = u.protocol === 'http:' || u.protocol === 'https:';
    // The host is the part a human can judge; the parser (not a regex) decides what it is,
    // so "https://good.com@evil.com/" shows evil.com.
    return finish(name, { risk: web ? 'med' : 'high', summary: u.host || raw });
  } catch {
    return finish(name, { risk: 'high', summary: raw });
  }
}

/** Fields that are the model describing the call rather than being part of it. */
const NARRATION_KEYS = new Set([
  'description', 'title', 'summary', 'reason', 'explanation', 'rationale', 'justification', 'purpose',
  'intent', 'displayname', 'display_name',
]);
const SHORT_FIELD_MAX = 60;
const WRITER_NAME_RE = /write|edit|create|save|put|append|replace|move|rename|copy|delete|remove|patch|update|touch|mkdir|insert|upload|overwrite|modify|set/i;

function viewUnknown(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  let field: string | undefined;
  for (const [k, v] of Object.entries(input)) {
    if (typeof v !== 'string' || NARRATION_KEYS.has(k.toLowerCase())) continue;
    const t = v.trim();
    if (t !== '' && t.length <= SHORT_FIELD_MAX) {
      field = `${k}=${t}`;
      break;
    }
  }
  // A file-writing tool we have never heard of (an MCP filesystem server) that is pointed at
  // Claude Code's configuration is the same attack through a different door.
  if (WRITER_NAME_RE.test(labelFor(name))) {
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.length <= 1024 && !/\s/.test(v.trim()) && inspectPath(v.trim(), cwd, cwd, home).config) {
        return finish(name, { risk: 'high', summary: field ? `${name} ${field}` : name, deny: CONFIG_REASON });
      }
    }
  }
  const summary = field ? `${name} ${field}` : name;
  return finish(name, { risk: 'med', summary });
}

/**
 * A subagent can be started in a permission mode that never asks. That is the same
 * escape as editing the settings file (work happens without a tap), so it is refused
 * rather than asked about; the modes that keep asking are the only ones let through.
 */
const ASKING_MODES = new Set(['default', 'plan']);

function viewAgent(name: string, input: Record<string, unknown>, cwd: string | undefined, home: string): ToolView {
  // The prompt and description are the model's own account of the task, so only the fields that
  // identify WHAT is being started are eligible for the summary.
  const identity: Record<string, unknown> = {};
  for (const k of ['subagent_type', 'mode', 'model']) if (typeof input[k] === 'string') identity[k] = input[k];
  const view = viewUnknown(name, identity, cwd, home);
  const mode = input.mode;
  if (mode === undefined || (typeof mode === 'string' && ASKING_MODES.has(mode))) return view;
  return { ...view, risk: 'high', deny: 'starts a subagent in a permission mode that does not ask the user' };
}

function describe(name: string, input: Record<string, unknown>, cwd: string | undefined): ToolView {
  const home = homedir();
  if (name === 'Bash') return viewBash(name, input, cwd);
  if (name === 'Agent' || name === 'Task') return viewAgent(name, input, cwd, home);
  if (READERS.has(name)) return viewReader(name, input, cwd, home);
  if (WRITERS.has(name)) return viewWriter(name, input, cwd, home);
  if (name === 'WebFetch') return viewWebFetch(name, input);
  if (name === 'WebSearch') {
    const q = str(input.query);
    return finish(name, { risk: 'med', summary: q ?? name });
  }
  return viewUnknown(name, input, cwd, home);
}

/** Analysis crashed (a stack overflow on absurd nesting, say): unknown, so ask, loudly. */
function fallbackView(name: string, input: Record<string, unknown>): ToolView {
  const cmd = name === 'Bash' ? str(input.command) : undefined;
  return finish(name, { risk: 'high', summary: cmd ?? name });
}

export const describeTool: DescribeTool = (name, input, cwd) => {
  const n = typeof name === 'string' ? name : String(name);
  const inp = isRecord(input) ? input : {};
  // A relative cwd cannot define "inside"; treat it as unknown rather than guess.
  const base = typeof cwd === 'string' && cwd.startsWith('/') ? posix.normalize(cwd) : undefined;
  try {
    return describe(n, inp, base);
  } catch {
    return fallbackView(n, inp);
  }
};
