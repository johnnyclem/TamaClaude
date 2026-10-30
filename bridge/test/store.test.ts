/**
 * The session store. A bad file is "no session", never an exception and never an id that
 * reaches the SDK: each rejection below is paired with a file that IS accepted, so a
 * loader that returned undefined for everything would not pass.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearSession, isValidSessionId, loadSession, saveSession } from '../src/store.ts';

const CWD = '/work/project';
const ID = '3f2b8c1e-9d4a-4e6b-8a0c-5d7e1f2a3b4c';

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'tamaclaude-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const file = (dir: string): string => join(dir, 'session.json');
const write = (dir: string, body: string): void => writeFileSync(file(dir), body);
const record = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, cwd: CWD, sessionId: ID, ...over });

test('a saved session comes back for the same working directory', (t) => {
  const dir = scratch(t);
  assert.equal(loadSession(dir, CWD), undefined, 'nothing saved yet');
  saveSession(dir, CWD, ID);
  assert.equal(loadSession(dir, CWD), ID);
});

test('the file holds exactly {v, cwd, sessionId} and a later save replaces an earlier one', (t) => {
  const dir = scratch(t);
  saveSession(dir, CWD, 'first-id');
  saveSession(dir, CWD, ID);
  assert.deepEqual(JSON.parse(readFileSync(file(dir), 'utf8')), { v: 1, cwd: CWD, sessionId: ID });
  assert.equal(loadSession(dir, CWD), ID);
});

test('a session belongs to its working directory: another one does not get it', (t) => {
  const dir = scratch(t);
  saveSession(dir, CWD, ID);
  assert.equal(loadSession(dir, '/work/other'), undefined);
  assert.equal(loadSession(dir, CWD), ID, 'and the right one still does');
  // The same directory spelled differently is the same directory.
  assert.equal(loadSession(dir, '/work/project/'), ID);
  assert.equal(loadSession(dir, '/work/project/sub/..'), ID);
});

test('the directory is created private (0700) and the file is 0600', (t) => {
  const dir = join(scratch(t), 'nested', 'state');
  saveSession(dir, CWD, ID);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file(dir)).mode & 0o777, 0o600);
});

test('a save leaves no temporary file behind', (t) => {
  const dir = scratch(t);
  saveSession(dir, CWD, ID);
  saveSession(dir, CWD, 'another-id');
  assert.deepEqual(readdirSync(dir), ['session.json']);
});

test('a failed save cleans up after itself and leaves the old file alone', (t) => {
  const dir = scratch(t);
  saveSession(dir, CWD, ID);
  // Make the final rename impossible: a directory cannot be replaced by a file.
  rmSync(file(dir));
  mkdirSync(file(dir));
  assert.throws(() => saveSession(dir, CWD, 'new-id'));
  assert.deepEqual(readdirSync(dir), ['session.json'], 'no stray temp file');
  assert.equal(statSync(file(dir)).isDirectory(), true, 'the target was not disturbed');
});

test('a missing, unreadable or non-JSON file is no session, and never throws', (t) => {
  const dir = scratch(t);
  assert.equal(loadSession(join(dir, 'does-not-exist'), CWD), undefined);
  assert.equal(loadSession(file(dir), CWD), undefined, 'a state dir that is actually a file');
  for (const body of ['', '{', 'null', '[]', '"just a string"', '42', '{"v":1', '\u0000\u0001', record() + 'trailing']) {
    write(dir, body);
    assert.equal(loadSession(dir, CWD), undefined, JSON.stringify(body));
  }
  write(dir, record());
  assert.equal(loadSession(dir, CWD), ID, 'the unmodified record is accepted');
});

test('a wrong version, or fields of the wrong type, is no session', (t) => {
  const dir = scratch(t);
  for (const bad of [
    { v: 2 },
    { v: '1' },
    { v: undefined },
    { cwd: 7 },
    { cwd: undefined },
    { sessionId: 12345 },
    { sessionId: null },
    { sessionId: undefined },
  ]) {
    write(dir, record(bad));
    assert.equal(loadSession(dir, CWD), undefined, JSON.stringify(bad));
  }
  write(dir, record());
  assert.equal(loadSession(dir, CWD), ID);
});

test('an id that could be read as a flag, a path or two arguments is refused on load', (t) => {
  const dir = scratch(t);
  const bad = ['', '-rf', '--resume', 'a b', 'a/b', '../x', 'a\nb', 'a;b', ' lead', 'x'.repeat(129), 'éclair'];
  for (const sessionId of bad) {
    write(dir, record({ sessionId }));
    assert.equal(loadSession(dir, CWD), undefined, JSON.stringify(sessionId));
  }
  // The shapes the SDK really issues, and the longest we accept, pass.
  for (const sessionId of [ID, 'abc123', 'a.b_c-d', 'x'.repeat(128)]) {
    write(dir, record({ sessionId }));
    assert.equal(loadSession(dir, CWD), sessionId);
  }
});

test('the same rule guards the save: a bad id is refused loudly and nothing is written', (t) => {
  const dir = scratch(t);
  for (const bad of ['', '-x', 'a b', '../up', 'x'.repeat(129)]) {
    assert.throws(() => saveSession(dir, CWD, bad), RangeError, JSON.stringify(bad));
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(isValidSessionId(ID), true);
  assert.equal(isValidSessionId(undefined), false);
});

test('a file far bigger than a record is not parsed at all', (t) => {
  const dir = scratch(t);
  write(dir, record({ padding: 'x'.repeat(10_000) }));
  assert.equal(loadSession(dir, CWD), undefined);
});

test('clearSession forgets the saved session, and forgetting nothing is fine', (t) => {
  const dir = scratch(t);
  saveSession(dir, CWD, ID);
  assert.equal(loadSession(dir, CWD), ID);
  clearSession(dir);
  assert.equal(loadSession(dir, CWD), undefined);
  assert.doesNotThrow(() => clearSession(dir));
  assert.doesNotThrow(() => clearSession(join(dir, 'never', 'existed')));
});

test('a save is atomic: when the final rename fails the old session is whole, and the new one is nowhere to be seen', (t) => {
  const dir = scratch(t);
  saveSession(dir, CWD, ID);
  const before = readFileSync(file(dir), 'utf8');

  // The write goes to a temporary file and only a rename makes it THE file. Make the rename the
  // thing that fails (a power cut between the two steps looks exactly like this), and check that
  // no byte of the new record reached the real path. A save that wrote the real path directly
  // would have replaced the old record before anything could go wrong.
  const real = fs.renameSync;
  fs.renameSync = (): never => {
    throw Object.assign(new Error('simulated failure between the write and the rename'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => saveSession(dir, CWD, 'replacement-id'), /simulated failure/);
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(readFileSync(file(dir), 'utf8'), before, 'the old record is byte for byte intact');
  assert.equal(loadSession(dir, CWD), ID);
  assert.deepEqual(readdirSync(dir), ['session.json'], 'and the half-finished temporary file was cleaned up');

  // Companion: with the rename working, the same call does replace it, so the failure above was the rename.
  saveSession(dir, CWD, 'replacement-id');
  assert.equal(loadSession(dir, CWD), 'replacement-id');
});

test('ST4: the temporary file is created exclusively and private -- flag wx, mode 0600 -- so a file or link put at that name is never written through', (t) => {
  const dir = scratch(t);
  const real = fs.writeFileSync;
  const seen: Array<{ path: string; options: unknown }> = [];
  // A spy that records how the file is opened and then does the write. The temp name has random bytes in it, so a
  // test cannot plant a file at it; what can be pinned is the way the bridge asks for it to be created.
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions): void => {
    seen.push({ path: String(path), options });
    real(path, data, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  try {
    saveSession(dir, CWD, ID);
  } finally {
    fs.writeFileSync = real;
    syncBuiltinESMExports();
  }
  assert.equal(seen.length, 1, 'one write, to one file');
  const w = seen[0]!;
  assert.notEqual(w.path, file(dir), 'never straight to the real path: that is what makes the save atomic');
  assert.match(w.path, /session\.json\.\d+\.[0-9a-f]{8}\.tmp$/, 'a name no other process can guess');
  assert.deepEqual(w.options, { mode: 0o600, flag: 'wx' }, 'created exclusively (never through an existing file or link) and readable by the owner only');
  assert.equal(loadSession(dir, CWD), ID, 'and the save worked');
});
