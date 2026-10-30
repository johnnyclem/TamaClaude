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
import { VOICE_RULES } from '../src/voice-prompt.ts';

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

test('the rule check can fail: a prompt without a rule is reported as missing it', () => {
  assert.deepEqual(missingRules(VOICE_RULES.replace('DICTATED', 'spoken')), ['input is dictated']);
  assert.deepEqual(missingRules(VOICE_RULES.replace('exactly ONE short question', 'a few questions')), [
    'ask exactly one question',
  ]);
  assert.ok(missingRules('').length === Object.keys(RULES).length);
});

test('the prompt does not use the markdown it forbids', () => {
  assert.doesNotMatch(VOICE_RULES, /[`*#|]/);
  assert.doesNotMatch(VOICE_RULES, /^\s*(?:[-+]|\d+[.)])\s/m);
});
