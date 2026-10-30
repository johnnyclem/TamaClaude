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
 * What "plain text" means, each point a refusal rather than a best effort:
 *  - Only two names are read, `<cwd>/CLAUDE.md` and `<cwd>/.claude/CLAUDE.md`. No search upwards, no
 *    user-level file, no `CLAUDE.local.md`.
 *  - The file must be a regular file whose real path stays inside the real working directory. A
 *    symlink to ~/.ssh/id_rsa, /etc/passwd or a FIFO is skipped, not followed. The check is made on
 *    the OPEN file descriptor (fstat), not on a path that could be swapped between check and use,
 *    and the open does not block on a FIFO.
 *  - `@path` imports are NOT expanded. The CLI expands them (including to files outside the
 *    project); here they stay literal text in front of the model.
 *  - The bytes must be valid UTF-8 and contain no NUL, or the file is skipped. A binary file in
 *    that slot is a mistake or an attack; either way the model should not be shown it.
 *  - The total is capped (MEMORY_MAX_BYTES, 40 KB). The read never goes beyond the cap, so a huge
 *    or endless file cannot cost memory or time, and what was cut is announced IN the text, so the
 *    model knows it is looking at part of a file.
 *
 * What this does NOT do: it does not make the text trustworthy. A repository's CLAUDE.md is written
 * by whoever owns the repository, and it reaches the model as instructions-shaped text exactly as it
 * would through the CLI. The driver says so in the heading it puts above it, and nothing in it can
 * approve anything: approvals come only from a tap on the device.
 *
 * Node-only and synchronous on purpose: it runs once at start-up, before the first turn.
 */

import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';

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
}

const TRUNCATION_NOTICE = `[The project memory was cut at ${MEMORY_MAX_BYTES / 1024} KB; the rest of it was not loaded.]`;

/** Control characters that never occur in text a person wrote (TAB, LF and CR are fine). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
/** More than this share of controls and the content is not text. */
const CONTROL_SHARE_MAX = 0.01;

type Read = { ok: true; bytes: Buffer; cut: boolean } | { ok: false; why: string };

/** Read up to `limit` bytes of a regular file, refusing anything else. `cut` says there was more. */
function readCapped(path: string, limit: number): Read {
  let fd: number;
  try {
    // O_NONBLOCK so a FIFO swapped in under the name cannot hang the start-up; O_NOFOLLOW so a
    // symlink swapped in after the realpath check is refused by the kernel, not followed.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch {
    return { ok: false, why: 'could not be opened' };
  }
  try {
    if (!fstatSync(fd).isFile()) return { ok: false, why: 'is not a regular file' };
    // One byte more than the limit is how a file of exactly `limit` bytes is told from a longer one.
    const buf = Buffer.alloc(limit + 1);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, null);
      if (n === 0) break;
      got += n;
    }
    const cut = got > limit;
    return { ok: true, bytes: buf.subarray(0, Math.min(got, limit)), cut };
  } catch {
    return { ok: false, why: 'could not be read' };
  } finally {
    try {
      closeSync(fd);
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

/** Same as {@link loadProjectMemory}, plus why each file that exists was left out. */
export function inspectProjectMemory(cwd: string, maxBytes: number = MEMORY_MAX_BYTES): ProjectMemoryReport {
  const report: ProjectMemoryReport = { text: '', sources: [], truncated: false, skipped: [] };
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return report; // no working directory, no memory
  }
  const inside = root.endsWith(sep) ? root : root + sep;

  const parts: string[] = [];
  let budget = maxBytes;
  for (const rel of MEMORY_FILES) {
    const skip = (why: string): void => {
      report.skipped.push({ file: rel, why });
    };
    let real: string;
    try {
      real = realpathSync(join(root, rel));
    } catch {
      continue; // absent: the normal case, not worth a line in the log
    }
    // The real path, symlinks resolved: a link inside the project to a file elsewhere lands outside.
    if (!real.startsWith(inside)) {
      skip('is a link to a file outside the project');
      continue;
    }
    if (budget <= 0) {
      report.truncated = true;
      skip('was not read: the size cap was already reached');
      continue;
    }
    const read = readCapped(real, budget);
    if (!read.ok) {
      skip(read.why);
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
