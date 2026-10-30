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
import {
  appendFileSync,
  closeSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectProjectMemory, loadProjectMemory, MEMORY_FILES, MEMORY_MAX_BYTES, readCapped } from '../src/memory.ts';
import type { MemoryFs } from '../src/memory.ts';
import { describeTool, setBridgeSecrets } from '../src/tools.ts';
import type { DescribeTool } from '../src/types.ts';

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

test('a symlink that leaves the project is skipped, with the reason', () => {
  const { cwd, outside } = rig();
  const secret = write(outside, 'id_rsa', 'OUTSIDE-SECRET-SENTINEL');
  symlinkSync(secret, join(cwd, 'CLAUDE.md'));
  const r = inspectProjectMemory(cwd);
  assert.equal(r.text, '');
  assert.ok(!JSON.stringify(r).includes('OUTSIDE-SECRET-SENTINEL'));
  assert.deepEqual(r.skipped, [{ file: 'CLAUDE.md', why: 'is a link to a file outside the project (links are not followed)' }]);
});

test('a linked .claude directory that points elsewhere is not followed', () => {
  const { cwd, outside } = rig();
  write(outside, 'CLAUDE.md', 'OUTSIDE-DIR-SENTINEL');
  symlinkSync(outside, join(cwd, '.claude'));
  const r = inspectProjectMemory(cwd);
  assert.deepEqual(r.sources, []);
  assert.equal(r.text, '');
  assert.deepEqual(r.skipped, [{ file: join('.claude', 'CLAUDE.md'), why: 'is reached through a link to a place outside the project' }]);
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

// ---------------------------------------------------------------------------
// R2 / V1: the loader is a road to the model with no tap, so it follows no link and asks the tool rules
// ---------------------------------------------------------------------------

const SECRET = 'SECRET-SENTINEL-must-never-reach-the-model';

/** A project that holds the credential stores a repository usually has, with a secret in each. */
function projectWithSecrets(): { base: string; cwd: string; outside: string } {
  const r = rig();
  write(r.cwd, '.env', `DATABASE_URL=postgres://u:${SECRET}@h/db\n`);
  write(r.cwd, '.git/config', `[remote "origin"]\n\turl = https://user:${SECRET}@github.com/x/y\n`);
  write(r.cwd, '.claude/settings.local.json', JSON.stringify({ env: { TOKEN: SECRET } }));
  return r;
}

const clean = (r: ReturnType<typeof inspectProjectMemory>): void => {
  assert.equal(r.text, '');
  assert.deepEqual(r.sources, []);
  assert.ok(!JSON.stringify(r).includes(SECRET), 'the secret is nowhere in the report');
};

test('R2/V1: a CLAUDE.md that is a link to a credential store INSIDE the project is not read', () => {
  const links: { name: string; link: string; target: string }[] = [
    { name: 'CLAUDE.md -> .env', link: 'CLAUDE.md', target: '.env' },
    { name: 'CLAUDE.md -> .git/config', link: 'CLAUDE.md', target: '.git/config' },
    { name: '.claude/CLAUDE.md -> ../.git/config', link: '.claude/CLAUDE.md', target: '../.git/config' },
    { name: '.claude/CLAUDE.md -> settings.local.json', link: '.claude/CLAUDE.md', target: 'settings.local.json' },
  ];
  for (const { name, link, target } of links) {
    const { cwd } = projectWithSecrets();
    symlinkSync(target, join(cwd, link));
    const r = inspectProjectMemory(cwd);
    clean(r);
    assert.deepEqual(r.skipped, [{ file: link, why: 'is a symbolic link (links are not followed)' }], name);
    // The twin rule, as the finding framed it: the Read tool asks about the very same target.
    const view = describeTool('Read', { file_path: join(cwd, link === 'CLAUDE.md' ? target : join('.claude', target)) }, cwd);
    assert.notEqual(view.risk, 'low', `${name}: control, the tool rules do not let the model read the target for nothing`);
  }
  // A link whose target does not exist YET (the operator creates .env later from .env.example) is refused all the same.
  const dangling = rig();
  symlinkSync('.env', join(dangling.cwd, 'CLAUDE.md'));
  assert.equal(inspectProjectMemory(dangling.cwd).skipped.length, 1);
  write(dangling.cwd, '.env', `K=${SECRET}\n`);
  clean(inspectProjectMemory(dangling.cwd));
});

test('R2/V1: a link to a harmless file inside the project is refused too (no link is followed); the same bytes as a plain file are delivered', () => {
  const { cwd } = rig();
  write(cwd, 'docs/rules.md', 'Rules kept in docs.');
  symlinkSync(join(cwd, 'docs', 'rules.md'), join(cwd, 'CLAUDE.md'));
  const r = inspectProjectMemory(cwd);
  assert.equal(r.text, '');
  assert.deepEqual(r.skipped, [{ file: 'CLAUDE.md', why: 'is a symbolic link (links are not followed)' }]);
  // Companion: it is the LINK that is refused, not the content or the location.
  const plain = rig();
  write(plain.cwd, 'CLAUDE.md', 'Rules kept in docs.');
  assert.match(loadProjectMemory(plain.cwd).text, /Rules kept in docs\./);
});

test('R2/V1: a linked directory above the file is refused, whatever it leads to', () => {
  // Inside the project, to a store whose name makes the tool rules ask.
  const aws = rig();
  write(aws.cwd, '.aws/CLAUDE.md', `[default]\naws_secret_access_key = ${SECRET}\n`);
  symlinkSync(join(aws.cwd, '.aws'), join(aws.cwd, '.claude'));
  const a = inspectProjectMemory(aws.cwd);
  clean(a);
  assert.deepEqual(a.skipped, [{ file: join('.claude', 'CLAUDE.md'), why: 'is reached through a linked directory (links are not followed)' }]);
  // Inside the project, to a harmless directory: still a link, still refused.
  const docs = rig();
  write(docs.cwd, 'docs/CLAUDE.md', 'Harmless.');
  symlinkSync(join(docs.cwd, 'docs'), join(docs.cwd, '.claude'));
  assert.equal(inspectProjectMemory(docs.cwd).text, '');
  assert.equal(inspectProjectMemory(docs.cwd).skipped[0]!.why, 'is reached through a linked directory (links are not followed)');
  // Companion: a real .claude directory is read.
  const real = rig();
  write(real.cwd, '.claude/CLAUDE.md', 'Harmless.');
  assert.match(loadProjectMemory(real.cwd).text, /Harmless\./);
});

test('R2/V1: a HARD link cannot be told from the file by its name, so a file with more than one name is refused', () => {
  const inside = projectWithSecrets();
  linkSync(join(inside.cwd, '.claude', 'settings.local.json'), join(inside.cwd, '.claude', 'CLAUDE.md'));
  // Control: the tool rules rate the lexical name low -- this is exactly the gap the link count closes.
  assert.equal(describeTool('Read', { file_path: join(inside.cwd, '.claude', 'CLAUDE.md') }, inside.cwd).risk, 'low');
  const a = inspectProjectMemory(inside.cwd);
  clean(a);
  assert.deepEqual(a.skipped, [{ file: join('.claude', 'CLAUDE.md'), why: 'has more than one hard link (it may be another file under this name)' }]);

  const out = projectWithSecrets();
  const elsewhere = write(out.outside, 'private.txt', `OUTSIDE ${SECRET}`);
  linkSync(elsewhere, join(out.cwd, 'CLAUDE.md'));
  clean(inspectProjectMemory(out.cwd));

  // Companion: a file with one name is delivered, so the count is what decides.
  const one = rig();
  write(one.cwd, 'CLAUDE.md', 'One name only.');
  assert.match(loadProjectMemory(one.cwd).text, /One name only\./);
});

test('R2/V1: the tool rules decide, not a list of ours: a CLAUDE.md that IS the registered bridge token file is not handed over', () => {
  const { cwd } = rig();
  const token = write(cwd, 'CLAUDE.md', 'TOKEN-SENTINEL-0123456789abcdef');
  try {
    setBridgeSecrets([token]);
    assert.equal(describeTool('Read', { file_path: token }, cwd).risk, 'high', 'control: the tool rules ask about it');
    const r = inspectProjectMemory(cwd);
    assert.equal(r.text, '');
    assert.ok(!JSON.stringify(r).includes('TOKEN-SENTINEL'));
    assert.match(r.skipped[0]!.why, /need a tap to read/);
  } finally {
    setBridgeSecrets([]);
  }
  assert.match(loadProjectMemory(cwd).text, /TOKEN-SENTINEL/, 'companion: with nothing registered the same file is memory');
});

test('R2/V1: the loader asks the tool rules about the exact path it would read, with the real working directory, and their answer is final', () => {
  const { base, cwd } = rig();
  write(cwd, 'CLAUDE.md', 'Root.');
  write(cwd, '.claude/CLAUDE.md', 'Dot.');
  const calls: unknown[] = [];
  const answer = (risk: 'low' | 'med' | 'high', deny?: string): DescribeTool => (name, input, c) => {
    calls.push([name, input, c]);
    return { label: 'Read', risk, summary: 'x', ...(deny !== undefined ? { deny } : {}) };
  };

  const low = inspectProjectMemory(cwd, undefined, { describe: answer('low') });
  assert.deepEqual(low.sources, ['CLAUDE.md', join('.claude', 'CLAUDE.md')]);
  assert.deepEqual(calls, [
    ['Read', { file_path: join(cwd, 'CLAUDE.md') }, cwd],
    ['Read', { file_path: join(cwd, '.claude', 'CLAUDE.md') }, cwd],
  ]);

  for (const [risk, deny] of [['med', undefined], ['high', undefined], ['low', 'refused outright']] as const) {
    const r = inspectProjectMemory(cwd, undefined, { describe: answer(risk, deny) });
    assert.deepEqual(r.sources, [], `${risk} ${deny ?? ''}`);
    assert.equal(r.text, '');
    assert.equal(r.skipped.length, 2);
  }

  // A rule that cannot be evaluated cannot be said to pass -- and nothing is thrown.
  const throwing: DescribeTool = () => {
    throw new Error('the analyser broke');
  };
  const t = inspectProjectMemory(cwd, undefined, { describe: throwing });
  assert.deepEqual(t.sources, []);
  assert.deepEqual(t.skipped.map((s) => s.why), ['could not be examined', 'could not be examined']);

  // The working directory it is judged against is the REAL one (see the linked-cwd test): through a link it is not the link.
  const link = join(base, 'cwd-link');
  symlinkSync(cwd, link);
  calls.length = 0;
  inspectProjectMemory(link, undefined, { describe: answer('low') });
  assert.deepEqual(calls[0], ['Read', { file_path: join(cwd, 'CLAUDE.md') }, cwd]);
});

test('R2/V1: one rule decides both -- for these layouts the loader delivers a file exactly when a Read of it is rated low', () => {
  const layouts: { name: string; build: (cwd: string) => string }[] = [
    { name: 'an ordinary CLAUDE.md', build: (cwd) => write(cwd, 'CLAUDE.md', 'Ordinary.') },
    { name: 'an ordinary .claude/CLAUDE.md', build: (cwd) => write(cwd, '.claude/CLAUDE.md', 'Ordinary.') },
    { name: 'a CLAUDE.md registered as a bridge secret', build: (cwd) => {
      const p = write(cwd, 'CLAUDE.md', 'Registered.');
      setBridgeSecrets([p]);
      return p;
    } },
  ];
  for (const { name, build } of layouts) {
    const { cwd } = rig();
    try {
      const path = build(cwd);
      const free = describeTool('Read', { file_path: path }, cwd).risk === 'low';
      const delivered = inspectProjectMemory(cwd).sources.length === 1;
      assert.equal(delivered, free, name);
    } finally {
      setBridgeSecrets([]);
    }
  }
});

// ---------------------------------------------------------------------------
// V7: the corners
// ---------------------------------------------------------------------------

test('V7: a working directory that is itself a link still gets its memory, judged against its real path, and the report says so', () => {
  const { base, cwd } = rig();
  write(cwd, 'CLAUDE.md', 'Linked-cwd rules.');
  write(cwd, 'target.md', 'Link target.');
  const link = join(base, 'link-to-proj');
  symlinkSync(cwd, link);
  const r = inspectProjectMemory(link);
  assert.deepEqual(r.sources, ['CLAUDE.md'], 'a symlinked --cwd (macOS /tmp and /var are links) must not silently lose the memory');
  assert.match(r.text, /Linked-cwd rules\./);
  assert.equal(r.notes?.length, 1);
  assert.match(r.notes![0]!, /working directory is a link/);
  assert.ok(r.notes![0]!.includes(cwd), 'it names the real path the files were judged against');
  assert.match(r.notes![0]!, /^[\x20-\x7e]+$/);
  // Companions: a plain directory (with or without a trailing slash) has nothing to say, and a link BELOW the
  // linked directory is refused as ever.
  assert.equal(inspectProjectMemory(cwd).notes, undefined);
  assert.equal(inspectProjectMemory(cwd + '/').notes, undefined);
  unlinkSync(join(cwd, 'CLAUDE.md'));
  symlinkSync(join(cwd, 'target.md'), join(cwd, 'CLAUDE.md'));
  const below = inspectProjectMemory(link);
  assert.equal(below.text, '');
  assert.equal(below.skipped.length, 1);
});

test('V7: the note about a linked working directory cannot be used to forge banner lines: a real path with a newline or non-ASCII in it is shown as printable ASCII on one line', () => {
  const { base } = rig();
  const nasty = join(base, 'real\n  memory  CLAUDE.md, forged line \u00e9\u4e2d');
  mkdirSync(nasty);
  write(nasty, 'CLAUDE.md', 'Rules.');
  const link = join(base, 'link-to-nasty');
  symlinkSync(nasty, link);
  const r = inspectProjectMemory(link);
  // (Whether the file is delivered is the tool rules' call -- they ask about a path with such characters, see the next
  // test -- so this one is only about the note.)
  assert.equal(r.notes?.length, 1);
  assert.match(r.notes![0]!, /^[\x20-\x7e]+$/, 'one line of printable ASCII');
  assert.ok(!r.notes![0]!.includes('\n'));
});

test('R2/V1: a project whose path the tool rules would ask about (look-alike or non-ASCII characters) gets no memory, and the banner says why', () => {
  const { base } = rig();
  const odd = join(base, 'pr\u00f8ject');
  mkdirSync(odd);
  write(odd, 'CLAUDE.md', 'Rules.');
  // Control: the rules do rate a Read here as one that asks (so the refusal below is theirs, not an accident of this test).
  assert.notEqual(describeTool('Read', { file_path: join(odd, 'CLAUDE.md') }, odd).risk, 'low');
  const r = inspectProjectMemory(odd);
  assert.equal(r.text, '');
  assert.match(r.skipped[0]!.why, /need a tap to read/);
  // Companion: the same file under an ordinary name is delivered.
  const plain = join(base, 'project');
  mkdirSync(plain);
  write(plain, 'CLAUDE.md', 'Rules.');
  assert.deepEqual(inspectProjectMemory(plain).sources, ['CLAUDE.md']);
});

test('V7: O_NOFOLLOW is what stops a link swapped in under the name: the open itself refuses it', () => {
  const { cwd } = rig();
  const target = write(cwd, 'target.md', 'The target.');
  const link = join(cwd, 'link.md');
  symlinkSync(target, link);
  // The expected identity is the TARGET's, so only the open's own refusal can stop this read.
  const r = readCapped(link, 1000, statSync(target));
  assert.equal(r.ok, false);
  // Companion: the same call on the real file reads it.
  const ok = readCapped(target, 1000, statSync(target));
  assert.ok(ok.ok && ok.bytes.toString() === 'The target.');
});

test('V7: the file opened must be the file looked at: another file, a hard link or a directory moved in under the name is refused', () => {
  const { cwd } = rig();
  const a = write(cwd, 'a.md', 'AAA');
  const b = write(cwd, 'b.md', 'BBB');
  assert.deepEqual(readCapped(a, 100, lstatSync(b)), { ok: false, why: 'was replaced while it was being read' });
  linkSync(a, join(cwd, 'a2.md'));
  assert.deepEqual(readCapped(a, 100, lstatSync(a)), { ok: false, why: 'has more than one hard link' });
  mkdirSync(join(cwd, 'dir'));
  assert.deepEqual(readCapped(join(cwd, 'dir'), 100, lstatSync(a)), { ok: false, why: 'is not a regular file' });
  const c = write(cwd, 'c.md', 'CCC');
  const fine = readCapped(c, 100, lstatSync(c));
  assert.ok(fine.ok && fine.bytes.toString() === 'CCC');
});

test('V7: a swap between the look and the read is caught on both sides of the read', () => {
  // (1) Another file renamed over the name WHILE it is being read: the descriptor holds the old file, the name now
  //     means another, and the report refuses rather than describe a name that no longer fits what was read.
  const during = rig();
  const file = write(during.cwd, 'CLAUDE.md', 'Original.');
  const replacement = write(during.outside, 'other.md', 'Replacement.');
  let swapped = false;
  const swapDuringRead: Partial<MemoryFs> = {
    read: (fd, buf, off, len) => {
      if (!swapped) {
        swapped = true;
        renameSync(replacement, file);
      }
      return readSyncVia(fd, buf, off, len);
    },
  };
  const r = inspectProjectMemory(during.cwd, undefined, { fs: swapDuringRead });
  assert.equal(r.text, '');
  assert.deepEqual(r.skipped, [{ file: 'CLAUDE.md', why: 'was replaced while it was being read' }]);

  // (2) A directory above the file turned into a link to the very same inode (a hard link keeps it): the file
  //     is "the same", but the path to it now goes through a link, which is the one thing never allowed.
  const dir = rig();
  const memory = write(dir.cwd, '.claude/CLAUDE.md', 'Original.');
  const twin = join(dir.outside, 'twin');
  mkdirSync(twin);
  let turned = false;
  const turnDirIntoLink: Partial<MemoryFs> = {
    read: (fd, buf, off, len) => {
      if (!turned) {
        turned = true;
        // The hard link has to exist while the name still resolves, so the identity of the file does not change.
        linkSync(memory, join(twin, 'CLAUDE.md'));
        renameSync(join(dir.cwd, '.claude'), join(dir.base, 'moved'));
        symlinkSync(twin, join(dir.cwd, '.claude'));
      }
      return readSyncVia(fd, buf, off, len);
    },
  };
  const d = inspectProjectMemory(dir.cwd, undefined, { fs: turnDirIntoLink });
  assert.equal(d.text, '');
  assert.deepEqual(d.skipped.map((s) => s.file), [join('.claude', 'CLAUDE.md')]);
});

/** The real read, for the wrappers above. */
function readSyncVia(fd: number, buf: Buffer, off: number, len: number): number {
  return readSync(fd, buf, off, len, null);
}

test('V7: a FIFO or a link swapped in between the look and the open neither blocks the start-up nor is followed', () => {
  // In a child with a hard timeout: a loader that opened the FIFO without O_NONBLOCK would hang the run, not fail it.
  const script = `
    import { execFileSync } from 'node:child_process';
    import { lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { inspectProjectMemory } from ${JSON.stringify(new URL('../src/memory.ts', import.meta.url).href)};
    const out = {};
    for (const kind of ['fifo', 'link']) {
      const cwd = join(realpathSync(mkdtempSync(join(tmpdir(), 'memory-swap-'))), 'proj');
      mkdirSync(cwd);
      const file = join(cwd, 'CLAUDE.md');
      const secret = join(cwd, 'secret.txt');
      writeFileSync(file, 'Original.');
      writeFileSync(secret, 'SWAP-SECRET');
      let done = false;
      const lstat = (p) => {
        let st;
        try { st = lstatSync(p); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return undefined; throw e; }
        if (p === file && !done) {
          done = true;
          unlinkSync(file);
          if (kind === 'fifo') execFileSync('mkfifo', [file]); else symlinkSync(secret, file);
        }
        return st;
      };
      const r = inspectProjectMemory(cwd, undefined, { fs: { lstat } });
      out[kind] = { text: r.text, skipped: r.skipped };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const probe = spawnSync('mkfifo', ['--version']);
  if (probe.error !== undefined && (probe.error as NodeJS.ErrnoException).code === 'ENOENT') return; // no mkfifo here
  const child = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', script], { timeout: 8000, encoding: 'utf8' });
  assert.equal(child.error, undefined, `the loader hung or crashed on a swapped-in FIFO: ${String(child.error)} ${child.stderr}`);
  assert.equal(child.status, 0, child.stderr);
  const out = JSON.parse(child.stdout) as Record<string, { text: string; skipped: { file: string; why: string }[] }>;
  for (const kind of ['fifo', 'link']) {
    assert.equal(out[kind]!.text, '', kind);
    assert.ok(!JSON.stringify(out[kind]).includes('SWAP-SECRET'), kind);
    assert.equal(out[kind]!.skipped.length, 1, kind);
  }
  assert.equal(out['fifo']!.skipped[0]!.why, 'is not a regular file');
});

test('V7: a FIFO named .claude/CLAUDE.md, or a directory, a socket-like non-file: refused with the reason, nothing blocks', () => {
  const { cwd } = rig();
  mkdirSync(join(cwd, '.claude'));
  const made = spawnSync('mkfifo', [join(cwd, '.claude', 'CLAUDE.md')]);
  if (made.status !== 0) return;
  const r = inspectProjectMemory(cwd);
  assert.equal(r.text, '');
  assert.deepEqual(r.skipped, [{ file: join('.claude', 'CLAUDE.md'), why: 'is not a regular file' }]);
});

test('V7: the read never asks for more than the cap plus one byte, however big or fast-growing the file', () => {
  const huge = rig();
  const p = join(huge.cwd, 'CLAUDE.md');
  const fd = openSync(p, 'w');
  writeSync(fd, 'x'.repeat(41 * 1024));
  ftruncateSync(fd, 300 * 1024 * 1024);
  closeSync(fd);
  const asked: number[] = [];
  let returned = 0;
  const spy: Partial<MemoryFs> = {
    read: (rfd, buf, off, len) => {
      asked.push(len);
      const n = readSyncVia(rfd, buf, off, len);
      returned += n;
      return n;
    },
  };
  const r = inspectProjectMemory(huge.cwd, MEMORY_MAX_BYTES, { fs: spy });
  assert.equal(r.truncated, true);
  assert.ok(asked.length > 0, 'the spy saw the reads (a guard that "never reads more" needs the mechanism engaged)');
  assert.ok(Math.max(...asked) <= MEMORY_MAX_BYTES + 1, `a single read asked for ${Math.max(...asked)} bytes`);
  assert.ok(returned <= MEMORY_MAX_BYTES + 1, `${returned} bytes were read`);

  // A file that GROWS between the look and the read is read no further than the cap either.
  const growing = rig();
  const g = write(growing.cwd, 'CLAUDE.md', 'short rules\n');
  let grew = false;
  let gotBack = 0;
  const grow: Partial<MemoryFs> = {
    read: (rfd, buf, off, len) => {
      if (!grew) {
        grew = true;
        appendFileSync(g, 'z'.repeat(1_000_000));
      }
      const n = readSyncVia(rfd, buf, off, len);
      gotBack += n;
      return n;
    },
  };
  const rg = inspectProjectMemory(growing.cwd, MEMORY_MAX_BYTES, { fs: grow });
  assert.ok(grew);
  assert.ok(gotBack <= MEMORY_MAX_BYTES + 1, `${gotBack} bytes were read from a growing file`);
  assert.equal(rg.truncated, true);
  assert.match(rg.text, /^=== CLAUDE\.md ===\nshort rules\nz+/);
  assert.ok(bytes(rg.text.replace(/\n\n\[The project[\s\S]*$/, '')) <= MEMORY_MAX_BYTES + '=== CLAUDE.md ===\n'.length);
});

test('V7: a filesystem that fails anywhere costs the file, never a throw', () => {
  const { cwd } = rig();
  write(cwd, 'CLAUDE.md', 'Rules.');
  const eacces = (): never => {
    throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };
  for (const [name, fs] of Object.entries<Partial<MemoryFs>>({
    lstat: { lstat: eacces },
    realpath: { realpath: (p) => (p.endsWith('CLAUDE.md') ? eacces() : realpathSync(p)) },
    open: { open: eacces },
    fstat: { fstat: eacces },
    read: { read: eacces },
    close: { close: eacces },
  })) {
    let r: ReturnType<typeof inspectProjectMemory> | undefined;
    assert.doesNotThrow(() => {
      r = inspectProjectMemory(cwd, undefined, { fs });
    }, name);
    if (name === 'close') assert.deepEqual(r!.sources, ['CLAUDE.md'], 'a close that fails after a good read costs nothing');
    else {
      assert.equal(r!.text, '', name);
      assert.ok(r!.skipped.some((x) => x.file === 'CLAUDE.md'), `${name}: the file is reported as not used`);
    }
  }
  // And a working directory that cannot be resolved at all is "no memory".
  assert.doesNotThrow(() => inspectProjectMemory(cwd, undefined, { fs: { realpath: eacces } }));
  assert.deepEqual(inspectProjectMemory(cwd, undefined, { fs: { realpath: eacces } }).sources, []);
});
