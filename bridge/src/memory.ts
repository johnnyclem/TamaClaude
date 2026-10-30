/**
 * The project's memory file (CLAUDE.md), read by the BRIDGE and handed to the model as plain text.
 *
 * Why the bridge reads it instead of the CLI. The CLI only loads CLAUDE.md when it also loads the
 * repository's settings files, and those files can run commands at start-up, change the
 * environment, redirect the conversation to another server and re-enable background work (all
 * measured, see src/drivers/claude.ts). So the driver loads NO repository or user configuration by
 * default, and the one thing a person wants from the repository, its instructions, comes through
 * here instead, as text that can do nothing but be read.
 *
 * This loader is a second road to the model that no tap guards: what it reads goes into every request
 * with no question asked. So it may read only what the tool rules would let the model read for
 * nothing anyway (a `Read` rated low), and it asks THEM rather than keeping a list of its own. An
 * earlier version judged only "does the real path stay inside the project", and a repository that
 * committed `CLAUDE.md -> .env` (or `.claude/CLAUDE.md -> ../.git/config`) had the operator's secrets in
 * the system prompt of every turn while a `Read` of the same path asked at high risk.
 *
 * What "plain text" means, each point a refusal rather than a best effort:
 *  - Only two names are read, `<cwd>/CLAUDE.md` and `<cwd>/.claude/CLAUDE.md`. No search upwards, no
 *    user-level file, no `CLAUDE.local.md`.
 *  - NO LINK IS FOLLOWED. The file itself must not be a symbolic link (lstat), no directory above it
 *    inside the project may be one (the real path of the file must equal the path it was asked for),
 *    and it must have a single hard link (a hard link cannot be told from a file by its name; git does
 *    not ship them, so one means somebody with access to the machine made it). The working directory
 *    itself MAY be a link: it is resolved first and everything is judged against its real path.
 *  - The file must be a regular file. That is checked on the OPEN descriptor (fstat), which must be the
 *    very file lstat described (same device and inode), and the open does not block on a FIFO and does
 *    not follow a link swapped in under the name. The path is looked at again after the read.
 *  - The path must be one the TOOL RULES rate low for a `Read` (src/tools.ts `describeTool`, the same
 *    answer the permission handler and the SDK hook use). A credential store, the bridge's own token
 *    file or anything else that would ask is left out, and the banner says so.
 *  - `@path` imports are NOT expanded. The CLI expands them (including to files outside the
 *    project); here they stay literal text in front of the model.
 *  - The bytes must be valid UTF-8 and contain no NUL, or the file is skipped. A binary file in
 *    that slot is a mistake or an attack; either way the model should not be shown it.
 *  - The total is capped (MEMORY_MAX_BYTES, 40 KB). The read never goes beyond the cap (plus the one
 *    byte that tells a file of exactly the cap from a longer one), so a huge, growing or endless file
 *    cannot cost memory or time, and what was cut is announced IN the text, so the model knows it is
 *    looking at part of a file.
 *
 * What this does NOT do: it does not make the text trustworthy. A repository's CLAUDE.md is written
 * by whoever owns the repository, and it reaches the model as instructions-shaped text exactly as it
 * would through the CLI. The driver says so in the heading it puts above it, and nothing in it can
 * approve anything: approvals come only from a tap on the device. (That the text cannot forge the
 * marker lines that frame it is src/voice-prompt.ts's job, at the one place the framing is built.)
 *
 * Node-only and synchronous on purpose: it runs once at start-up, before the first turn.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { sanitize } from './text.ts';
import { describeTool } from './tools.ts';
import type { DescribeTool } from './types.ts';

/** The most file content the memory may carry, in bytes. */
export const MEMORY_MAX_BYTES = 40 * 1024;

/** The two places a project keeps its memory file, relative to the working directory. */
export const MEMORY_FILES: readonly string[] = ['CLAUDE.md', join('.claude', 'CLAUDE.md')];

export interface ProjectMemory {
  /** Ready to append to the system prompt; '' when there is nothing to show. */
  text: string;
  /** The files that contributed, as paths relative to the working directory. */
  sources: string[];
  /** Part of the content was left out because of the cap. */
  truncated: boolean;
}

export interface ProjectMemoryReport extends ProjectMemory {
  /** Files that exist but were skipped, with the reason, for the start-up log. */
  skipped: { file: string; why: string }[];
  /**
   * Things about HOW the directory was read that the person should see beside the file list, ready to
   * print (printable ASCII, no newline). Today: the working directory is itself a link, so the files
   * were judged against its real path. Absent when there is nothing to say.
   */
  notes?: string[];
}

/** The filesystem calls this module makes, replaceable so a test can play an attacker between two of them. */
export interface MemoryFs {
  /** `undefined`: nothing there. A symbolic link is described, not followed. */
  lstat(path: string): Stats | undefined;
  realpath(path: string): string;
  open(path: string, flags: number): number;
  fstat(fd: number): Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number): number;
  close(fd: number): void;
}

export interface MemoryDeps {
  /** The tool rules' answer for a `Read`. Default: the real `describeTool`, so ONE rule decides both. */
  describe?: DescribeTool;
  fs?: Partial<MemoryFs>;
}

const isAbsent = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

const realFs: MemoryFs = {
  lstat: (p) => {
    try {
      return lstatSync(p);
    } catch (e) {
      if (isAbsent(e)) return undefined;
      throw e;
    }
  },
  realpath: (p) => realpathSync(p),
  open: (p, flags) => openSync(p, flags),
  fstat: (fd) => fstatSync(fd),
  read: (fd, buffer, offset, length) => readSync(fd, buffer, offset, length, null),
  close: (fd) => closeSync(fd),
};

const TRUNCATION_NOTICE = `[The project memory was cut at ${MEMORY_MAX_BYTES / 1024} KB; the rest of it was not loaded.]`;

/** Control characters that never occur in text a person wrote (TAB, LF and CR are fine). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** More than this share of controls and the content is not text. */
const CONTROL_SHARE_MAX = 0.01;

type Read = { ok: true; bytes: Buffer; cut: boolean } | { ok: false; why: string };

/** The same file, by the only identity a path cannot fake. */
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/**
 * Read up to `limit` bytes of a regular file, refusing anything else. `cut` says there was more.
 *
 * `expected` is what lstat said about the path a moment ago; the file opened must be that one. The
 * path is a plain path (no link in it, which the caller has checked), so this is about the gap
 * between the check and the use: a link, a FIFO or another file moved in under the name in between.
 */
export function readCapped(path: string, limit: number, expected: Stats, fs: MemoryFs = realFs): Read {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO swapped in under the name cannot hang the start-up; O_NOFOLLOW so a
    // symlink swapped in after the lstat is refused by the kernel, not followed; O_NOCTTY so
    // a terminal device cannot become our controlling terminal.
    fd = fs.open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | constants.O_NOCTTY);
  } catch {
    return { ok: false, why: 'could not be opened (or is a link)' };
  }
  try {
    const st = fs.fstat(fd);
    if (!st.isFile()) return { ok: false, why: 'is not a regular file' };
    if (!sameFile(st, expected)) return { ok: false, why: 'was replaced while it was being read' };
    if (st.nlink > 1) return { ok: false, why: 'has more than one hard link' };
    // One byte more than the limit is how a file of exactly `limit` bytes is told from a longer one.
    // The size is NOT taken from fstat: a file that grows while it is read is still read only this far.
    const buf = Buffer.alloc(limit + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.read(fd, buf, got, buf.length - got);
      if (n === 0) break;
      got += n;
    }
    const cut = got > limit;
    return { ok: true, bytes: buf.subarray(0, Math.min(got, limit)), cut };
  } catch {
    return { ok: false, why: 'could not be read' };
  } finally {
    try {
      fs.close(fd);
    } catch {
      // nothing to do about a close that failed
    }
  }
}

/** Shorten a UTF-8 buffer to a character boundary, so a cut never leaves half a character. */
function cutAtBoundary(bytes: Buffer): Buffer {
  let end = bytes.length;
  // A continuation byte is 10xxxxxx; step back to the lead byte and drop the incomplete character.
  let i = end;
  while (i > 0 && end - i < 4 && (bytes[i - 1]! & 0xc0) === 0x80) i--;
  if (i > 0) {
    const lead = bytes[i - 1]!;
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (end - (i - 1) < need) end = i - 1;
  }
  return bytes.subarray(0, end);
}

/** The text, or the reason the bytes are not text. */
function decode(bytes: Buffer): { ok: true; text: string } | { ok: false; why: string } {
  if (bytes.includes(0)) return { ok: false, why: 'contains a NUL byte (not a text file)' };
  let text: string;
  try {
    // `ignoreBOM: false` is the decoder's default and what strips a leading byte-order mark; spelled out
    // because the model should not be shown an invisible character at the head of the file.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return { ok: false, why: 'is not valid UTF-8' };
  }
  const controls = text.match(CONTROL)?.length ?? 0;
  if (controls > 0 && controls / Math.max(text.length, 1) > CONTROL_SHARE_MAX) {
    return { ok: false, why: 'is mostly control characters (not a text file)' };
  }
  return { ok: true, text };
}

type Verdict = { kind: 'absent' } | { kind: 'refused'; why: string } | { kind: 'ok'; before: Stats };

/**
 * May this file be handed to the model? Everything that needs no read. A refusal's message completes
 * the sentence "not used: <file> ...".
 */
function judge(abs: string, root: string, fs: MemoryFs, describe: DescribeTool): Verdict {
  const refuse = (why: string): Verdict => ({ kind: 'refused', why });
  let before: Stats | undefined;
  try {
    before = fs.lstat(abs);
  } catch {
    return refuse('could not be examined');
  }
  if (before === undefined) return { kind: 'absent' };
  if (before.isSymbolicLink()) {
    // Never followed, whatever it points at; the reason says where it led so the person can tell a harmless
    // convenience link from an attempt. A dangling link has no "where".
    let target: string | undefined;
    try {
      target = fs.realpath(abs);
    } catch {
      target = undefined;
    }
    const outside = target !== undefined && !target.startsWith(root.endsWith(sep) ? root : root + sep);
    return refuse(outside ? 'is a link to a file outside the project (links are not followed)' : 'is a symbolic link (links are not followed)');
  }
  if (!before.isFile()) return refuse('is not a regular file');
  if (before.nlink > 1) return refuse('has more than one hard link (it may be another file under this name)');

  // The file is not a link, but a directory above it may be (`.claude` -> somewhere). The real path of a
  // file reached without any link is the path itself, because the root is already a real path.
  let real: string;
  try {
    real = fs.realpath(abs);
  } catch {
    return refuse('could not be resolved');
  }
  if (real !== abs) {
    const inside = real.startsWith(root.endsWith(sep) ? root : root + sep);
    return refuse(inside ? 'is reached through a linked directory (links are not followed)' : 'is reached through a link to a place outside the project');
  }

  // The one rule: the model may be given this file silently only if reading it would be silent anyway.
  const view = describe('Read', { file_path: abs }, root);
  if (view.deny !== undefined || view.risk !== 'low') {
    return refuse("is a file Claude would need a tap to read (a credential store, a path with unusual characters or one of the bridge's own files), so it is not handed over");
  }
  return { kind: 'ok', before };
}

/** Same as {@link loadProjectMemory}, plus why each file that exists was left out. */
export function inspectProjectMemory(cwd: string, maxBytes: number = MEMORY_MAX_BYTES, deps: MemoryDeps = {}): ProjectMemoryReport {
  const report: ProjectMemoryReport = { text: '', sources: [], truncated: false, skipped: [] };
  const fs: MemoryFs = { ...realFs, ...deps.fs };
  const describe = deps.describe ?? describeTool;
  let root: string;
  try {
    // The working directory MAY be a link (macOS /tmp and /var are); everything below it may not.
    root = fs.realpath(cwd);
    if (root !== resolve(cwd)) {
      report.notes = [`the working directory is a link: the memory files were judged against its real path, ${sanitize(root, 160)}`];
    }
  } catch {
    return report; // no working directory, no memory
  }

  const parts: string[] = [];
  let budget = maxBytes;
  for (const rel of MEMORY_FILES) {
    const skip = (why: string): void => {
      report.skipped.push({ file: rel, why });
    };
    try {
      const abs = join(root, rel);
      const checked = judge(abs, root, fs, describe);
      if (checked.kind === 'absent') continue; // the normal case, not worth a line in the log
      if (checked.kind === 'refused') {
        skip(checked.why);
        continue;
      }
      if (budget <= 0) {
        report.truncated = true;
        skip('was not read: the size cap was already reached');
        continue;
      }
      const read = readCapped(abs, budget, checked.before, fs);
      if (!read.ok) {
        skip(read.why);
        continue;
      }
      // The name still has to be that file after the read: a directory above it swapped for a link
      // while we were reading would otherwise have been judged only before the fact.
      const after = fs.lstat(abs);
      if (after === undefined || !sameFile(after, checked.before) || fs.realpath(abs) !== abs) {
        skip('was replaced while it was being read');
        continue;
      }
      const bytes = read.cut ? cutAtBoundary(read.bytes) : read.bytes;
      const decoded = decode(bytes);
      if (!decoded.ok) {
        skip(decoded.why);
        continue;
      }
      if (decoded.text.trim() === '') continue;
      budget -= bytes.length;
      if (read.cut) report.truncated = true;
      report.sources.push(rel);
      parts.push(`=== ${rel} ===\n${decoded.text.trimEnd()}`);
    } catch {
      // Never thrown: a file that cannot be judged is a file that is not used, and the banner says so.
      skip('could not be examined');
    }
  }

  if (parts.length > 0) {
    if (report.truncated) parts.push(TRUNCATION_NOTICE);
    report.text = parts.join('\n\n');
  } else {
    // Every file was empty, unreadable or refused: whatever was cut is not in front of the model.
    report.truncated = false;
  }
  return report;
}

/**
 * The project's memory as text for the model. `{ text: '', sources: [], truncated: false }` when
 * the project has none (or none that may be read). Never throws.
 */
export function loadProjectMemory(cwd: string): ProjectMemory {
  const { text, sources, truncated } = inspectProjectMemory(cwd);
  return { text, sources, truncated };
}
