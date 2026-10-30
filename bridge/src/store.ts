/**
 * The one thing the bridge remembers between runs: which Claude session to resume.
 *
 * A handheld that forgot the conversation every time the laptop rebooted would be a
 * toy, but a stale or foreign file must never be able to hurt: this id is handed to the
 * Agent SDK as `resume`, so a corrupt file is "no session", never an exception, and the
 * id is held to the shape of a real one (a UUID in practice) before it goes anywhere
 * near a child process.
 *
 * The file is keyed by working directory. A session is a conversation ABOUT a project;
 * resuming project A's conversation while the bridge is pointed at project B would let
 * Claude act in B with A's context, which is a surprise nobody asked for.
 *
 * Writes are atomic (temp file in the same directory, then rename) so a crash or a
 * power cut mid-write leaves the old file or the new one, never half of one. The
 * directory is 0700 and the file 0600: the id is not a credential, but it names a
 * conversation that may contain anything the player said.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

const FILE = 'session.json';
const VERSION = 1;

/**
 * A session id as the SDK issues them is a UUID. The pattern is deliberately looser (any
 * short token that cannot be mistaken for a command-line flag) so a future id format does
 * not silently stop resuming, and strict enough that a corrupt or planted file cannot
 * smuggle whitespace, a leading dash or a path separator into an argument vector.
 */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A real file is about 100 bytes. Anything bigger is not ours and is not worth parsing. */
const MAX_FILE_BYTES = 4096;

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID.test(id);
}

/** The saved session id for `cwd`, or undefined. Never throws. */
export function loadSession(stateDir: string, cwd: string): string | undefined {
  try {
    const file = join(stateDir, FILE);
    if (statSync(file).size > MAX_FILE_BYTES) return undefined;
    const data: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const rec = data as Record<string, unknown>; // narrowed from `object` only to index it; every field is checked below
    if (rec['v'] !== VERSION) return undefined;
    if (typeof rec['cwd'] !== 'string' || resolve(rec['cwd']) !== resolve(cwd)) return undefined;
    const id = rec['sessionId'];
    return isValidSessionId(id) ? id : undefined;
  } catch {
    return undefined; // missing, unreadable, not JSON: all the same answer
  }
}

/** Throws on a bad id (a driver bug worth hearing about) or an I/O failure; the caller logs it. */
export function saveSession(stateDir: string, cwd: string, id: string): void {
  if (!isValidSessionId(id)) throw new RangeError('refusing to save a session id of an unexpected shape');
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = join(stateDir, FILE);
  // Same directory as the target: rename is only atomic within one filesystem.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const body = `${JSON.stringify({ v: VERSION, cwd: resolve(cwd), sessionId: id })}\n`;
  try {
    // 'wx': never write through a pre-existing file or symlink at the temp name.
    writeFileSync(tmp, body, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Forget the saved session (the `--new-session` flag). Never throws. */
export function clearSession(stateDir: string): void {
  try {
    rmSync(join(stateDir, FILE), { force: true });
  } catch {
    // Nothing to do: the next save replaces the file anyway.
  }
}
