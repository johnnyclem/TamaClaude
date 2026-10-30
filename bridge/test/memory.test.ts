/**
 * The project's memory file, read by the bridge as plain text (src/memory.ts).
 *
 * Every refusal in that module is a security rule, so each has a pair here: the input it must
 * refuse, and a near-identical input it must ACCEPT. A refusal test alone passes for a loader that
 * accepts nothing, and the loader's whole job is to deliver the file when it is safe to.
 *
 * Real temp directories and real symlinks, not a mocked filesystem: what is being checked is what
 * the kernel does with the paths (realpath, O_NOFOLLOW, a FIFO), and a mock would only restate the
 * implementation's idea of it.
 */

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProjectMemory, loadProjectMemory, MEMORY_FILES, MEMORY_MAX_BYTES } from '../src/memory.ts';

const roots: string[] = [];
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A fresh directory pair: `base/proj` is the working directory, `base/outside` holds what must stay unread. */
function rig(): { base: string; cwd: string; outside: string } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'memory-test-')));
  roots.push(base);
  const cwd = join(base, 'proj');
  const outside = join(base, 'outside');
  mkdirSync(cwd);
  mkdirSync(outside);
  return { base, cwd, outside };
}

const write = (dir: string, rel: string, content: string | Buffer): string => {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
};

const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

test('a project with no memory file has no memory, and says so in the shape the driver expects', () => {
  const { cwd } = rig();
  assert.deepEqual(loadProjectMemory(cwd), { text: '', sources: [], truncated: false });
  assert.deepEqual(Object.keys(loadProjectMemory(cwd)).sort(), ['sources', 'text', 'truncated']);
  assert.deepEqual(loadProjectMemory(join(cwd, 'does-not-exist')), { text: '', sources: [], truncated: false });
});

test('CLAUDE.md and .claude/CLAUDE.md are read, in that order, each under its own label', () => {
  const { cwd } = rig();
  write(cwd, 'CLAUDE.md', 'Root rules.\n');
  write(cwd, '.claude/CLAUDE.md', 'Dot-claude rules.\n');
  const m = loadProjectMemory(cwd);
  assert.deepEqual(m.sources, ['CLAUDE.md', join('.claude', 'CLAUDE.md')]);
  assert.equal(m.text, `=== CLAUDE.md ===\nRoot rules.\n\n=== ${join('.claude', 'CLAUDE.md')} ===\nDot-claude rules.`);
  assert.equal(m.truncated, false);
  assert.deepEqual([...MEMORY_FILES], ['CLAUDE.md', join('.claude', 'CLAUDE.md')], 'the two names, and no others, are the contract');
  // Only one of them present is fine too.
  const only = rig();
  write(only.cwd, '.claude/CLAUDE.md', 'Only this.');
  assert.deepEqual(loadProjectMemory(only.cwd).sources, [join('.claude', 'CLAUDE.md')]);
});

test('nothing else is read: no parent directory, no CLAUDE.local.md, no file with another name', () => {
  const { base, cwd } = rig();
  write(base, 'CLAUDE.md', 'PARENT-SENTINEL');
  write(cwd, 'CLAUDE.local.md', 'LOCAL-SENTINEL');
  write(cwd, 'claude.md', 'LOWERCASE-SENTINEL');
  write(cwd, 'sub/CLAUDE.md', 'SUBDIR-SENTINEL');
  assert.deepEqual(loadProjectMemory(cwd), { text: '', sources: [], truncated: false });
});

test('a symlink that leaves the project is skipped, with the reason; one that stays inside is read', () => {
  const { cwd, outside } = rig();
  const secret = write(outside, 'id_rsa', 'OUTSIDE-SECRET-SENTINEL');
  symlinkSync(secret, join(cwd, 'CLAUDE.md'));
  const r = inspectProjectMemory(cwd);
  assert.equal(r.text, '');
  assert.ok(!JSON.stringify(r).includes('OUTSIDE-SECRET-SENTINEL'));
  assert.deepEqual(r.skipped, [{ file: 'CLAUDE.md', why: 'is a link to a file outside the project' }]);

  // Companion: the same kind of link to a file INSIDE the project is delivered, so the refusal
  // above is about where the link goes and not about links.
  const ok = rig();
  write(ok.cwd, 'docs/rules.md', 'Rules kept in docs.');
  symlinkSync(join(ok.cwd, 'docs', 'rules.md'), join(ok.cwd, 'CLAUDE.md'));
  assert.match(loadProjectMemory(ok.cwd).text, /Rules kept in docs\./);
});

test('a linked .claude directory that points elsewhere is not followed', () => {
  const { cwd, outside } = rig();
  write(outside, 'CLAUDE.md', 'OUTSIDE-DIR-SENTINEL');
  symlinkSync(outside, join(cwd, '.claude'));
  assert.deepEqual(loadProjectMemory(cwd), { text: '', sources: [], truncated: false });
});

test('"inside" is judged on path components: a sibling whose name starts with the project\'s is outside', () => {
  const { base, cwd } = rig();
  const sibling = join(base, 'proj-evil');
  mkdirSync(sibling);
  const target = write(sibling, 'CLAUDE.md', 'SIBLING-SENTINEL');
  symlinkSync(target, join(cwd, 'CLAUDE.md'));
  assert.equal(loadProjectMemory(cwd).text, '', 'a plain string prefix check would let /base/proj-evil through for /base/proj');
});

test('only a regular file is read: a directory is skipped', () => {
  const { cwd } = rig();
  mkdirSync(join(cwd, 'CLAUDE.md'));
  const r = inspectProjectMemory(cwd);
  assert.equal(r.text, '');
  assert.deepEqual(r.skipped, [{ file: 'CLAUDE.md', why: 'is not a regular file' }]);
});

test('a FIFO named CLAUDE.md is skipped at once instead of blocking the start-up', () => {
  const { cwd } = rig();
  const made = spawnSync('mkfifo', [join(cwd, 'CLAUDE.md')]);
  if (made.status !== 0) {
    // No mkfifo (a stripped container): this one case cannot run here; the rest of the file still does.
    return;
  }
  // In a child process with a hard timeout: a loader that opened the FIFO for blocking would hang
  // the test run forever instead of failing it.
  const script = `import { loadProjectMemory } from ${JSON.stringify(new URL('../src/memory.ts', import.meta.url).href)};
    process.stdout.write(JSON.stringify(loadProjectMemory(${JSON.stringify(cwd)})));`;
  const child = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { timeout: 5000, encoding: 'utf8' });
  assert.equal(child.error, undefined, `the loader hung on a FIFO: ${String(child.error)}`);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { text: '', sources: [], truncated: false });
});

test('bytes that are not UTF-8 text are refused; real UTF-8, a BOM included, is delivered intact', () => {
  const bad = rig();
  write(bad.cwd, 'CLAUDE.md', Buffer.from([0x52, 0x75, 0x6c, 0x65, 0x73, 0x20, 0xc3, 0x28, 0x0a]));
  const r = inspectProjectMemory(bad.cwd);
  assert.equal(r.text, '');
  assert.deepEqual(r.skipped, [{ file: 'CLAUDE.md', why: 'is not valid UTF-8' }]);

  const good = rig();
  write(good.cwd, 'CLAUDE.md', '﻿Café rules ✓ — naïve “quotes”\n');
  assert.equal(loadProjectMemory(good.cwd).text, '=== CLAUDE.md ===\nCafé rules ✓ — naïve “quotes”');
});

test('binary content is refused: a NUL byte, or mostly control characters without one', () => {
  const nul = rig();
  write(nul.cwd, 'CLAUDE.md', Buffer.from('looks like text\0but is not', 'utf8'));
  assert.match(inspectProjectMemory(nul.cwd).skipped[0]!.why, /NUL/);
  assert.equal(loadProjectMemory(nul.cwd).text, '');

  const ctrl = rig();
  write(ctrl.cwd, 'CLAUDE.md', '\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008abc\u0001\u0002');
  assert.match(inspectProjectMemory(ctrl.cwd).skipped[0]!.why, /control characters/);

  // Companion: tabs, newlines, carriage returns and an odd stray control character in real text are fine.
  const fine = rig();
  write(fine.cwd, 'CLAUDE.md', `line one\r\n\tindented\n${'ordinary prose '.repeat(40)}\u001b[0m a stray escape in ${'a long document '.repeat(20)}`);
  assert.deepEqual(inspectProjectMemory(fine.cwd).sources, ['CLAUDE.md']);
});

test('a bad file does not hide a good one', () => {
  const { cwd } = rig();
  write(cwd, 'CLAUDE.md', Buffer.from([0xff, 0xfe, 0xfd]));
  write(cwd, '.claude/CLAUDE.md', 'The good one.');
  const m = loadProjectMemory(cwd);
  assert.deepEqual(m.sources, [join('.claude', 'CLAUDE.md')]);
  assert.match(m.text, /The good one\./);
});

test('@imports stay literal text: nothing named in the file is read', () => {
  const { cwd, outside } = rig();
  write(outside, 'private.md', 'IMPORTED-SENTINEL');
  write(cwd, 'extra.md', 'LOCAL-IMPORT-SENTINEL');
  write(cwd, 'CLAUDE.md', `See @${join(outside, 'private.md')} and @extra.md and @~/.ssh/id_rsa\n`);
  const m = loadProjectMemory(cwd);
  assert.ok(m.text.includes('@extra.md') && m.text.includes('@~/.ssh/id_rsa'), 'the mentions are there as written');
  assert.ok(!m.text.includes('IMPORTED-SENTINEL') && !m.text.includes('LOCAL-IMPORT-SENTINEL'));
});

test('whitespace-only and empty files add nothing', () => {
  const { cwd } = rig();
  write(cwd, 'CLAUDE.md', '');
  write(cwd, '.claude/CLAUDE.md', ' \n\t\n');
  assert.deepEqual(loadProjectMemory(cwd), { text: '', sources: [], truncated: false });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

const contentBytes = (text: string, label = 'CLAUDE.md'): number => bytes(text.replace(`=== ${label} ===\n`, ''));

test('the cap is 40 KB: a file of exactly that size is whole, one byte more is cut and announced', () => {
  assert.equal(MEMORY_MAX_BYTES, 40 * 1024);
  const exact = rig();
  write(exact.cwd, 'CLAUDE.md', 'a'.repeat(MEMORY_MAX_BYTES));
  const e = loadProjectMemory(exact.cwd);
  assert.equal(e.truncated, false);
  assert.equal(contentBytes(e.text), MEMORY_MAX_BYTES);
  assert.ok(!/was cut/.test(e.text));

  const over = rig();
  write(over.cwd, 'CLAUDE.md', 'a'.repeat(MEMORY_MAX_BYTES + 1));
  const o = loadProjectMemory(over.cwd);
  assert.equal(o.truncated, true);
  assert.match(o.text, /\[The project memory was cut at 40 KB; the rest of it was not loaded\.\]$/, 'the model is told it is looking at part of a file');
  assert.equal(bytes(o.text.slice(o.text.indexOf('\n') + 1, o.text.indexOf('\n\n[The project'))), MEMORY_MAX_BYTES);
});

test('the cap is shared by both files: the second gets what is left, and a full first leaves it nothing', () => {
  const share = rig();
  write(share.cwd, 'CLAUDE.md', 'a'.repeat(30 * 1024));
  write(share.cwd, '.claude/CLAUDE.md', 'b'.repeat(30 * 1024));
  const s = loadProjectMemory(share.cwd);
  assert.deepEqual(s.sources, ['CLAUDE.md', join('.claude', 'CLAUDE.md')]);
  assert.equal(s.truncated, true);
  const second = s.text.split(`=== ${join('.claude', 'CLAUDE.md')} ===\n`)[1]!;
  assert.equal((second.match(/b/g) ?? []).length, 10 * 1024, 'the second file kept exactly the remaining 10 KB');
  const first = s.text.slice(s.text.indexOf('\n') + 1, s.text.indexOf('\n\n=== '));
  assert.equal(first, 'a'.repeat(30 * 1024), 'the first file is whole');

  const full = rig();
  write(full.cwd, 'CLAUDE.md', 'a'.repeat(MEMORY_MAX_BYTES));
  write(full.cwd, '.claude/CLAUDE.md', 'SECOND-SENTINEL');
  const f = inspectProjectMemory(full.cwd);
  assert.equal(f.truncated, true, 'a file that was left out entirely is a truncation');
  assert.ok(!f.text.includes('SECOND-SENTINEL'));
  assert.equal(f.skipped.length, 1);
});

test('a cut never lands inside a character: multi-byte text is shortened to a whole character', () => {
  const { cwd } = rig();
  // '€' is three bytes; 40 KB is not a multiple of three, so the raw cut falls mid-character.
  assert.notEqual(MEMORY_MAX_BYTES % 3, 0);
  write(cwd, 'CLAUDE.md', '€'.repeat(20_000));
  const m = loadProjectMemory(cwd);
  assert.equal(m.truncated, true);
  assert.ok(!m.text.includes('�'), 'no replacement character: the cut was on a boundary');
  const body = m.text.slice(m.text.indexOf('\n') + 1, m.text.indexOf('\n\n[The project'));
  assert.ok(/^€+$/.test(body) && bytes(body) <= MEMORY_MAX_BYTES && bytes(body) > MEMORY_MAX_BYTES - 3);
});

test('only the cap is ever read: bytes beyond it are not touched', () => {
  // 41 KB of text, then a tail of NUL bytes (a sparse file) 300 MB long. A loader that read the whole
  // file would meet the NULs and refuse it as binary, returning nothing; one that reads the cap
  // plus a byte delivers the text. It also finishes at once, which a 300 MB read would not.
  const { cwd } = rig();
  const p = join(cwd, 'CLAUDE.md');
  const fd = openSync(p, 'w');
  writeSync(fd, 'x'.repeat(41 * 1024));
  ftruncateSync(fd, 300 * 1024 * 1024);
  closeSync(fd);
  const t0 = performance.now();
  const m = loadProjectMemory(cwd);
  assert.ok(performance.now() - t0 < 1500);
  assert.equal(m.truncated, true);
  assert.equal(contentBytes(m.text.replace(/\n\n\[The project[\s\S]*$/, '')), MEMORY_MAX_BYTES);
});

test('the loader never throws, whatever it is given', () => {
  for (const cwd of ['', '/', '/nonexistent/at/all', 'relative/missing', '\0bad']) {
    assert.doesNotThrow(() => loadProjectMemory(cwd), JSON.stringify(cwd));
  }
  assert.deepEqual(loadProjectMemory(fileURLToPath(new URL('.', import.meta.url))).sources, [], 'the test directory has no CLAUDE.md of its own');
});
