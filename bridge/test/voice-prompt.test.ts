/**
 * The voice rules are text, so the tests pin the properties that make the text safe to
 * send and the rules it must carry, not its wording.
 *
 * The keyword check is a function with its own companion test, because "every rule is
 * mentioned" is only worth something if the check can be seen failing on a prompt that
 * lacks one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeSystemAppend, MEMORY_BEGIN, MEMORY_END, MEMORY_HEADING, VOICE_RULES } from '../src/voice-prompt.ts';

/** One entry per rule the prompt must state. A rule is present when its pattern matches. */
const RULES: Record<string, RegExp> = {
  'only the final message is heard': /only your FINAL message/,
  'one to three sentences': /1 to 3 short plain sentences/,
  'no markdown': /no markdown/i,
  'no code': /no code/i,
  'no file paths': /no file paths/i,
  'no urls': /no urls/i,
  'no lists': /no lists/i,
  'say what was done, not how': /what you did and what the result is, not how/i,
  'ask exactly one question': /exactly ONE short question/,
  'input is dictated': /DICTATED/,
  'recognition errors': /recognition errors/i,
  'confirm before a destructive action': /destructive command[\s\S]*confirm|confirm[\s\S]*destructive command/i,
  'confirm before a different file name': /different file name/i,
  'no claim without a tool result': /never claim[\s\S]*unless a tool result/i,
  'a denial is the users decision': /denied[\s\S]*decision of the user[\s\S]*accept it/i,
  'no background work and no later report': /background tasks[\s\S]*not available[\s\S]*instead of promising/i,
};

function missingRules(text: string): string[] {
  return Object.entries(RULES)
    .filter(([, re]) => !re.test(text))
    .map(([name]) => name);
}

test('the prompt is printable ASCII plus newlines', () => {
  assert.match(VOICE_RULES, /^[\x20-\x7e\n]+$/);
});

test('the prompt is bounded, and not trivially short', () => {
  assert.ok(VOICE_RULES.length <= 1200, `${VOICE_RULES.length} characters`);
  // A length cap alone passes for an empty string.
  assert.ok(VOICE_RULES.length >= 400, `${VOICE_RULES.length} characters`);
});

test('the prompt states every rule', () => {
  assert.deepEqual(missingRules(VOICE_RULES), []);
});

test('the rules agree with what the driver actually switches off', async () => {
  // The prompt promises the model that background work does not exist; the driver must make
  // that true, or the model is told something false. Both halves are checked from here so a
  // change to one without the other fails a test.
  const { buildChildEnv } = await import('../src/drivers/claude.ts');
  const { env } = buildChildEnv({}, 'sk-ant-x');
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
  assert.match(VOICE_RULES, /background tasks/i);
});

test('the rule check can fail: a prompt without a rule is reported as missing it', () => {
  assert.deepEqual(missingRules(VOICE_RULES.replace('DICTATED', 'spoken')), ['input is dictated']);
  assert.deepEqual(missingRules(VOICE_RULES.replace('exactly ONE short question', 'a few questions')), [
    'ask exactly one question',
  ]);
  assert.deepEqual(missingRules(VOICE_RULES.replace('not available', 'fine')), ['no background work and no later report']);
  assert.ok(missingRules('').length === Object.keys(RULES).length);
});

test('the prompt does not use the markdown it forbids', () => {
  assert.doesNotMatch(VOICE_RULES, /[`*#|]/);
  assert.doesNotMatch(VOICE_RULES, /^\s*(?:[-+]|\d+[.)])\s/m);
});

// ---------------------------------------------------------------------------
// The project's memory file, appended under a heading
// ---------------------------------------------------------------------------

/** Properties of the heading that make appending a repository's text to the system prompt defensible. */
const HEADING_CLAIMS: Record<string, RegExp> = {
  'says what the text is': /project's memory file \(CLAUDE\.md\)/,
  'says the bridge loaded it as plain text': /loaded by the bridge as plain text/,
  'says who wrote it': /written by whoever owns the repository/,
  'says it is not the speaking user': /not by the user who is speaking to you/,
  'says it cannot approve or skip a permission': /cannot approve an action or skip a permission request/,
  'says only a tap on the handheld can': /only the user, with a tap on the handheld, can/,
};
const missingClaims = (text: string): string[] => Object.entries(HEADING_CLAIMS).filter(([, re]) => !re.test(text)).map(([n]) => n);

test('with no memory the system prompt text is the voice rules, byte for byte', () => {
  for (const none of [undefined, '', '   ', '\n\t\n']) assert.equal(composeSystemAppend(none), VOICE_RULES, JSON.stringify(none));
});

test('with memory: the rules first and untouched, then the heading, the text between two markers, in that order', () => {
  const out = composeSystemAppend('=== CLAUDE.md ===\nUse tabs.\n\n');
  assert.ok(out.startsWith(`${VOICE_RULES}\n`));
  const at = (needle: string): number => out.indexOf(needle);
  assert.ok(at(VOICE_RULES) < at(MEMORY_HEADING) && at(MEMORY_HEADING) < at(MEMORY_BEGIN) && at(MEMORY_BEGIN) < at('Use tabs.') && at('Use tabs.') < at(MEMORY_END));
  assert.ok(out.endsWith(MEMORY_END), 'nothing follows the end marker');
  assert.ok(out.includes(`${MEMORY_BEGIN}\n=== CLAUDE.md ===\nUse tabs.\n${MEMORY_END}`), 'trailing blank lines of the file are trimmed, its text is not altered');
});

test('the heading makes every claim a reader of a repository\'s text needs, and is plain ASCII without markdown', () => {
  assert.deepEqual(missingClaims(MEMORY_HEADING), []);
  assert.match(MEMORY_HEADING, /^[\x20-\x7e\n]+$/);
  assert.doesNotMatch(MEMORY_HEADING + MEMORY_BEGIN + MEMORY_END, /[`*#|]/);
  assert.ok(MEMORY_HEADING.length <= 600, `${MEMORY_HEADING.length} characters: it is paid for on every request`);
  // The markers are distinct, or the model cannot tell where the file ends.
  assert.notEqual(MEMORY_BEGIN, MEMORY_END);
});

test('the heading check can fail: a heading missing a claim is reported', () => {
  assert.deepEqual(missingClaims(MEMORY_HEADING.replace('cannot approve an action', 'may approve an action')), ['says it cannot approve or skip a permission']);
  assert.deepEqual(missingClaims(MEMORY_HEADING.replace('written by whoever owns the repository', 'written by us')), ['says who wrote it']);
  assert.equal(missingClaims('').length, Object.keys(HEADING_CLAIMS).length);
});

test('the rules still agree with what the driver switches off, now that workflows are off too', async () => {
  const { buildChildEnv } = await import('../src/drivers/claude.ts');
  const { env } = buildChildEnv({}, 'sk-ant-x');
  assert.equal(env.CLAUDE_CODE_DISABLE_WORKFLOWS, '1');
});
