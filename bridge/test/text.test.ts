/**
 * Everything bound for the panel goes through text.ts, and what it is fed is model
 * output and tool results: untrusted, unbounded and full of characters the bitmap
 * font cannot draw. So these tests are mostly hostile input, plus the one behaviour
 * the summary is for (whole sentences) and the one it used to get wrong (a heading or
 * list marker holding sentences apart, which flattening glued back together).
 *
 * The last block is the CALLER test: the point of text.ts is that its output is
 * accepted by the codec, so the codec is run on it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeBridgeMsg, encodeBridgeMsg, encodeDeviceMsg, isPrintableAscii } from '../src/protocol.ts';
import { sanitize, sanitizeInfo, summarizeForDevice, toAscii, truncateText } from '../src/text.ts';
import { LIMITS } from '../src/types.ts';

/** Generous on purpose: the failure being guarded is quadratic, which takes minutes, not milliseconds. */
const BUDGET_MS = 1500;

function timed<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  const out = fn();
  const ms = performance.now() - t0;
  assert.ok(ms < BUDGET_MS, `${label} took ${Math.round(ms)} ms`);
  return out;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Strings that have each hurt a text pipeline somewhere. */
const HOSTILE: string[] = [
  '', ' ', '\n\n\n', '\0', 'nul \0 byte', 'ctrl \x01\x02\x1f\x7f\x80\x9f end',
  'caf\u00e9 na\u00efve', '\u201csmart\u201d \u2018quotes\u2019 \u2014 dash \u2026', 'emoji \u{1F600}\u{1F600} done',
  'family \u{1F468}\u200d\u{1F469}\u200d\u{1F467}', 'RTL \u202eevil\u202c text', 'marks \u200e\u200f\u2066\u2067\u2068\u2069',
  'zwsp a\u200bb zwj a\u200dc zwnj a\u200cd', 'bom \ufefftext', 'soft\u00adhyphen', 'tags \u{E0041}\u{E0042}\u{E007F}',
  'lone \ud800 high', 'lone \udc00 low', 'reversed \udc00\ud800', 'cut pair \ud83d', 'cjk \u4e2d\u6587\u5b57',
  'arabic \u0645\u0631\u062d\u0628\u0627', 'combining a\u0301\u0302\u0303\u0304\u0305', 'line sep \u2028 para \u2029',
  'vs16 \u2764\ufe0f', 'ligature \ufb01 fullwidth \uff21\uff22 half \u00bd circled \u2460', 'nbsp\u00a0here ideographic\u3000space',
  '"'.repeat(500), '\\'.repeat(500), 'x'.repeat(10000), '\u00e9'.repeat(5000),
  '```\nunterminated fence', '[](', '[a](', '![', '[[[[', ']]]]', '](((((', '#'.repeat(50), '> '.repeat(50), '- '.repeat(50), '|'.repeat(50),
  'http://', 'https://' + 'a'.repeat(2000), '**bold', '__init__ my_var', '~~gone~~', '<script>alert(1)</script>', '&amp; &#x1F600;',
];

// ---------------------------------------------------------------------------
describe('toAscii', () => {
  it('leaves every printable ASCII character alone', () => {
    let all = '';
    for (let c = 0x21; c <= 0x7e; c++) all += String.fromCharCode(c);
    assert.equal(toAscii(all), all);
    assert.equal(toAscii('a b'), 'a b');
  });

  it('turns an empty or all-whitespace string into an empty string', () => {
    assert.equal(toAscii(''), '');
    assert.equal(toAscii('   \t\n\r  '), '');
    assert.equal(toAscii('\u00a0\u3000\u2003'), '');
  });

  it('collapses every kind of whitespace and control character to one space, and trims', () => {
    assert.equal(toAscii('  a \t\n\r b\u00a0\u3000c  '), 'a b c');
    assert.equal(toAscii('a\x01\x02b'), 'a b');
    assert.equal(toAscii('a\x7fb'), 'a b');
    assert.equal(toAscii('a\u0085b'), 'a b'); // NEL is a C1 control and not \s in JavaScript
    assert.equal(toAscii('a\u2028b\u2029c'), 'a b c');
    assert.equal(toAscii('\0'), '');
    assert.equal(toAscii('a\0b'), 'a b'); // NUL separates words; it does not glue them or end the string
  });

  it('keeps every C1 control character out of the output', () => {
    for (let c = 0x80; c <= 0x9f; c++) assert.equal(toAscii(`a${String.fromCharCode(c)}b`), 'a b', c.toString(16));
  });

  it('strips accents down to the base letter', () => {
    assert.equal(toAscii('caf\u00e9 na\u00efve \u00c5ngstr\u00f6m'), 'cafe naive Angstrom');
    assert.equal(toAscii('Za\u017c\u00f3\u0142\u0107'), 'Zazolc');
    assert.equal(toAscii('e\u0301'), 'e'); // an already-decomposed accent
    assert.equal(toAscii('a\u0301\u0302\u0303\u0304'), 'a'); // a pile of them
  });

  it('maps common punctuation and symbols to ASCII', () => {
    assert.equal(toAscii('\u201cquoted\u201d \u2018single\u2019 \u201eescaped\u201f'),'"quoted" \'single\' "escaped"');
    assert.equal(toAscii('a\u2013b\u2014c\u2212d'), 'a-b-c-d');
    assert.equal(toAscii('wait\u2026'), 'wait...');
    assert.equal(toAscii('a \u2192 b \u21d2 c \u2190 d'), 'a -> b => c <- d');
    assert.equal(toAscii('\u2022 item \u00b7 item \u00d7 \u00a9 \u00ae \u2122'), '* item * item x (c) (r) (tm)');
    assert.equal(toAscii('stra\u00dfe \u00e6 \u0153 \u00f8 \u0111 \u0142 \u00f0 \u00fe'), 'strasse ae oe o d l d th');
  });

  it('folds compatibility forms: fullwidth, ligatures, fractions, circled digits', () => {
    assert.equal(toAscii('\uff21\uff22\uff23 \ufb01nal \u00bd \u2460'), 'ABC final 1/2 1');
  });

  it('turns each run of undrawable characters into a single ?', () => {
    assert.equal(toAscii('a\u4e2d\u6587\u5b57b'), 'a?b');
    assert.equal(toAscii('go \u{1F600}\u{1F600}\u{1F600} now'), 'go ? now');
    assert.equal(toAscii('\u{1F600} \u{1F600}'), '? ?'); // separated by a space: two symbols
    assert.equal(toAscii('\u{1F44D}\u{1F3FD}'), '?'); // a thumbs-up and its skin tone are one symbol
    assert.equal(toAscii('I \u2764\ufe0f you'), 'I ? you'); // a heart and its variation selector
    assert.equal(toAscii('\u0645\u0631\u062d\u0628\u0627'), '?');
  });

  it('keeps a ZWJ emoji sequence as ONE ?, because the joiners draw nothing', () => {
    assert.equal(toAscii('x \u{1F468}\u200d\u{1F469}\u200d\u{1F467} y'), 'x ? y');
  });

  it('drops invisible format characters instead of printing ? in the middle of a word', () => {
    const invisible: Array<[string, string]> = [
      ['zero width space', '\u200b'], ['zero width non-joiner', '\u200c'], ['zero width joiner', '\u200d'],
      ['left-to-right mark', '\u200e'], ['right-to-left mark', '\u200f'], ['left-to-right override', '\u202d'],
      ['right-to-left override', '\u202e'], ['pop directional', '\u202c'], ['isolate', '\u2066'], ['pop isolate', '\u2069'],
      ['word joiner', '\u2060'], ['soft hyphen', '\u00ad'], ['byte order mark', '\ufeff'], ['tag character', '\u{E0041}'],
      ['arabic letter mark', '\u061c'],
    ];
    for (const [name, ch] of invisible) {
      assert.equal(toAscii(`he${ch}llo`), 'hello', name);
      assert.equal(toAscii(ch), '', `${name} alone`);
      assert.equal(toAscii(`${ch}${ch}${ch}`), '', `${name} repeated`);
    }
    // The neighbour that must NOT vanish: a visible non-ASCII character in the same place.
    assert.equal(toAscii('he\u4e2dllo'), 'he?llo');
  });

  it('a right-to-left override cannot reorder what the player reads', () => {
    // Dropped, the text is in the order it was written; the override has no effect on ASCII output.
    assert.equal(toAscii('safe \u202etxt.exe\u202c'), 'safe txt.exe');
  });

  it('handles lone surrogates without throwing', () => {
    assert.equal(toAscii('\ud800'), '?');
    assert.equal(toAscii('\udc00'), '?');
    assert.equal(toAscii('a\ud800b'), 'a?b');
    assert.equal(toAscii('a\udc00b'), 'a?b');
    assert.equal(toAscii('\udc00\ud800'), '?');
    assert.equal(toAscii('\ud83dx'), '?x');
    assert.equal(toAscii('\u{1F600}'), '?'); // a proper pair is one character, not two ?
  });

  it('never throws and always returns printable ASCII, for anything that can be passed in', () => {
    const throwing = { toString() { throw new Error('boom'); } };
    const circular: unknown[] = [];
    circular.push(circular);
    for (const v of [null, undefined, 5, 1n, true, {}, [], ['a', 'b'], Symbol('s'), throwing, circular, Object.create(null)]) {
      const out = toAscii(v as unknown as string);
      assert.ok(isPrintableAscii(out), String(typeof v));
    }
    assert.equal(toAscii(throwing as unknown as string), '');
  });

  it('is idempotent, has no double or edge spaces, and is printable ASCII, over a hostile corpus and random code points', () => {
    const r = rng(7);
    const corpus = [...HOSTILE];
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const n = Math.floor(r() * 60);
      for (let k = 0; k < n; k++) {
        const pick = r();
        const cp = pick < 0.3 ? 0x20 + Math.floor(r() * 95)
          : pick < 0.5 ? Math.floor(r() * 0xa0)
          : pick < 0.8 ? Math.floor(r() * 0x3000)
          : Math.floor(r() * 0x110000);
        s += String.fromCodePoint(cp >= 0xd800 && cp <= 0xdfff && r() < 0.5 ? cp : cp);
      }
      corpus.push(s);
    }
    for (const s of corpus) {
      const once = toAscii(s);
      assert.ok(isPrintableAscii(once), JSON.stringify(s.slice(0, 40)));
      assert.equal(toAscii(once), once, `idempotent: ${JSON.stringify(s.slice(0, 40))}`);
      assert.doesNotMatch(once, /^ | $|  /);
    }
  });

  it('stays linear: 200k characters of every awkward shape', () => {
    const shapes: Record<string, string> = {
      ascii: 'The quick brown fox. '.repeat(10000),
      'alternating word and space': 'a '.repeat(100000),
      'only spaces': ' '.repeat(200000),
      accents: '\u00e9'.repeat(200000),
      emoji: '\u{1F600}'.repeat(100000),
      'emoji and spaces': '\u{1F600} '.repeat(66000),
      invisibles: '\u200b'.repeat(200000),
      'invisible between words': 'a\u200bb '.repeat(50000),
      'lone surrogates': '\ud800'.repeat(200000),
      controls: '\0\x01\x7f'.repeat(66000),
      cjk: '\u4e2d'.repeat(200000),
      'combining marks': 'a' + '\u0301'.repeat(199999),
    };
    for (const [name, s] of Object.entries(shapes)) {
      const out = timed(name, () => toAscii(s));
      assert.ok(isPrintableAscii(out), name);
    }
  });

  it('keeps the 200k-character result correct, not just fast', () => {
    assert.equal(toAscii('a '.repeat(100000)), 'a '.repeat(99999) + 'a');
    assert.equal(toAscii('\u{1F600}'.repeat(100000)), '?');
    assert.equal(toAscii('\u200b'.repeat(200000)), '');
  });
});

// ---------------------------------------------------------------------------
describe('truncateText', () => {
  it('returns a string that fits unchanged, at exactly the limit too', () => {
    assert.equal(truncateText('hello', 5), 'hello');
    assert.equal(truncateText('hello', 6), 'hello');
    assert.equal(truncateText('', 0), '');
    assert.equal(truncateText('', 5), '');
  });

  it('cuts one over the limit and says so with ...', () => {
    assert.equal(truncateText('hello!', 5), 'he...');
    assert.equal(truncateText('hello world', 9), 'hello...'); // the space before the dots is dropped
    assert.equal(truncateText('abcdefghij', 4), 'a...');
  });

  it('for a limit of 3 or less, cuts without dots (there is no room for them)', () => {
    assert.equal(truncateText('abcdef', 3), 'abc');
    assert.equal(truncateText('abcdef', 2), 'ab');
    assert.equal(truncateText('abcdef', 1), 'a');
  });

  it('never exceeds the limit, for every limit', () => {
    for (const s of ['x'.repeat(100), 'ab '.repeat(30), 'a', '']) {
      for (let max = -3; max <= 120; max++) {
        const out = truncateText(s, max);
        assert.ok(out.length <= Math.max(0, max), `max ${max}: ${out.length}`);
        if (s.length > Math.max(0, max) && max > 3) assert.ok(out.endsWith('...'), `max ${max}`);
      }
    }
  });

  it('treats a nonsense limit as "nothing fits", never as "no limit"', () => {
    for (const max of [0, -1, -100, NaN, -Infinity]) assert.equal(truncateText('hello', max), '', String(max));
    assert.equal(truncateText('hello', Infinity), 'hello');
    assert.equal(truncateText('hello world', 7.9), 'hell...'); // a fractional limit rounds down
  });

  it('does not leave half a surrogate pair behind', () => {
    const s = '\u{1F600}'.repeat(10);
    for (let max = 0; max <= 24; max++) {
      assert.doesNotMatch(truncateText(s, max), LONE_SURROGATE, `max ${max}`);
    }
    assert.equal(truncateText('\u{1F600}', 1), '');
  });
});

// ---------------------------------------------------------------------------
describe('sanitize and sanitizeInfo', () => {
  it('fold to ASCII and cap', () => {
    assert.equal(sanitize('caf\u00e9 \u201cok\u201d', 100), 'cafe "ok"');
    assert.equal(sanitize('hello world', 8), 'hello...');
    assert.equal(sanitize('x', 0), '');
  });

  it('report truncation only when something was CUT, not when something was folded', () => {
    assert.deepEqual(sanitizeInfo('hello', 5), { text: 'hello', truncated: false }, 'exactly at the limit');
    assert.deepEqual(sanitizeInfo('hello!', 5), { text: 'he...', truncated: true }, 'one over');
    assert.deepEqual(sanitizeInfo('caf\u00e9', 10), { text: 'cafe', truncated: false }, 'folded but whole');
    assert.deepEqual(sanitizeInfo('\u{1F600}\u{1F600} hi', 10), { text: '? hi', truncated: false });
    assert.deepEqual(sanitizeInfo('', 5), { text: '', truncated: false });
    assert.deepEqual(sanitizeInfo('abc', 0), { text: '', truncated: true }, 'a zero limit drops everything');
    assert.deepEqual(sanitizeInfo('abc', NaN), { text: '', truncated: true });
  });

  it('measure the limit after folding, so the panel string is what is capped', () => {
    // 30 two-byte letters fold to 30 characters; the cap applies to the 30, not to some raw length.
    assert.equal(sanitize('\u00e9'.repeat(30), 20).length, 20);
    assert.equal(sanitize('\u200b'.repeat(500) + 'ab', 5), 'ab');
  });
});

// ---------------------------------------------------------------------------
describe('summarizeForDevice: structure no longer glues sentences together', () => {
  const sum = (md: string, max = 400): string => summarizeForDevice(md, max);

  it('puts a period after a heading that has none (the known bug)', () => {
    assert.equal(sum('## Done\n\nI fixed the bug.'), 'Done. I fixed the bug.');
    assert.equal(sum('# Result\nAll tests pass.'), 'Result. All tests pass.');
    assert.equal(sum('### Next steps\n\nRun it.'), 'Next steps. Run it.');
  });

  it('puts one between list items, with any marker style', () => {
    assert.equal(sum('- fixed the bug\n- added a test\n- updated the docs'), 'fixed the bug. added a test. updated the docs');
    assert.equal(sum('* one\n* two'), 'one. two');
    assert.equal(sum('+ one\n+ two'), 'one. two');
    assert.equal(sum('1. one\n2. two\n3. three'), 'one. two. three');
    assert.equal(sum('1) one\n2) two'), 'one. two');
    assert.equal(sum('- [ ] write\n- [x] test'), 'write. test');
    assert.equal(sum('- outer\n  - inner\n    - deepest'), 'outer. inner. deepest');
  });

  it('puts one between a lead-in line and its list, and between a list and what follows', () => {
    assert.equal(sum('Here are the changes\n- fixed bug\n- added test\n\nAll green.'), 'Here are the changes. fixed bug. added test. All green.');
  });

  it('puts one between paragraphs that lack one', () => {
    assert.equal(sum('Summary\n\nFixed it.'), 'Summary. Fixed it.');
  });

  it('puts one between table rows, and drops the separator row', () => {
    assert.equal(sum('| name | state |\n|---|---|\n| a | ok |\n| b | bad |'), 'name state. a ok. b bad');
    assert.equal(sum('| a | b |\n| :-- | --: |\n| 1 | 2 |'), 'a b. 1 2');
  });

  it('drops horizontal rules and treats them as a break', () => {
    assert.equal(sum('Above\n\n---\n\nBelow.'), 'Above. Below.');
    assert.equal(sum('Above\n***\nBelow.'), 'Above. Below.');
    assert.equal(sum('Above\n* * *\nBelow.'), 'Above. Below.');
    assert.equal(sum('Above\n___\nBelow.'), 'Above. Below.');
  });

  it('does not double up punctuation that is already there', () => {
    assert.equal(sum('## Done.\n\nFixed.'), 'Done. Fixed.');
    assert.equal(sum('## Why?\n\nBecause.'), 'Why? Because.');
    assert.equal(sum('## Careful!\n\nReally.'), 'Careful! Really.');
    assert.equal(sum('Steps:\n- one\n- two'), 'Steps: one. two');
    assert.equal(sum('- he said "ok."\n- next'), 'he said "ok." next');
    assert.equal(sum('- done (really!)\n- next'), 'done (really!) next');
    assert.equal(sum('- note;\n- next'), 'note; next');
  });

  it('does add one after a closing bracket that has no punctuation inside it', () => {
    assert.equal(sum('- (see above)\n- next'), '(see above). next');
  });

  it('does NOT add one inside a paragraph or list item that merely wraps', () => {
    assert.equal(sum('Wrapped line one\nstill the same sentence.'), 'Wrapped line one still the same sentence.');
    assert.equal(sum('- first part\n  second part\n- other'), 'first part second part. other');
    assert.equal(sum('> quoted one\n> quoted two.'), 'quoted one quoted two.');
    assert.equal(sum('one\ntwo\nthree'), 'one two three');
  });

  it('does not invent punctuation where nothing follows', () => {
    assert.equal(sum('## Done'), 'Done');
    assert.equal(sum('- only item'), 'only item');
    assert.equal(sum('All done'), 'All done');
    assert.equal(sum('hello'), 'hello');
  });

  it('property: blocks without punctuation come out joined by ". ", whatever their markup', () => {
    const r = rng(11);
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    const kinds = ['heading', 'bullet', 'number', 'star', 'para'] as const;
    for (let round = 0; round < 400; round++) {
      const n = 2 + Math.floor(r() * 5);
      let md = '';
      const blocks: string[] = [];
      let prev: (typeof kinds)[number] | null = null;
      for (let i = 0; i < n; i++) {
        const kind = kinds[Math.floor(r() * kinds.length)]!;
        const body = Array.from({ length: 1 + Math.floor(r() * 3) }, () => words[Math.floor(r() * words.length)]!).join(' ');
        blocks.push(body);
        const marker = kind === 'heading' ? '## ' : kind === 'bullet' ? '- ' : kind === 'number' ? `${i + 1}. ` : kind === 'star' ? '* ' : '';
        if (i > 0) {
          // A plain line right under a list item would be a lazy continuation of it, which is
          // correct markdown, so a paragraph needs a blank line unless it follows a heading.
          const needBlank = kind === 'para' && prev !== 'heading';
          md += needBlank || r() < 0.5 ? '\n\n' : '\n';
        }
        md += marker + body;
        prev = kind;
      }
      assert.equal(sum(md), blocks.join('. '), JSON.stringify(md));
    }
  });
});

describe('summarizeForDevice: markdown is removed', () => {
  const sum = (md: string, max = 400): string => summarizeForDevice(md, max);

  it('drops fenced code, including an unterminated fence and a language tag', () => {
    assert.equal(sum('Before.\n```js\nconsole.log(1)\n```\nAfter.'), 'Before. After.');
    assert.equal(sum('Before.\n```\nnever closed\nstill code'), 'Before.');
    assert.equal(sum('```\nonly code\n```'), '');
    assert.equal(sum('x\n```a```\ny'), 'x. y');
  });

  it('keeps the words inside inline code, emphasis and strikethrough', () => {
    assert.equal(sum('Run `npm test` and **check** the _output_ ~~twice~~.'), 'Run npm test and check the output twice.');
  });

  it('keeps link text and image alt text, drops the address', () => {
    assert.equal(sum('See [the docs](https://example.com/a?b=1) now.'), 'See the docs now.');
    assert.equal(sum('![diagram](img.png) shows it.'), 'diagram shows it.');
    assert.equal(sum('[a](b) and [c](d "title")'), 'a and c');
  });

  it('replaces a bare URL with "a link", and keeps the punctuation that ended the sentence', () => {
    assert.equal(sum('Visit https://example.com/x for more.'), 'Visit a link for more.');
    assert.equal(sum('See https://example.com/x. Then go on.'), 'See a link. Then go on.');
    assert.equal(sum('Is it https://example.com/x? Yes!'), 'Is it a link? Yes!');
    assert.equal(sum('(see http://x.y/z)'), '(see a link)');
  });

  it('strips quote markers, however deep, and a heading inside a quote', () => {
    assert.equal(sum('> quoted'), 'quoted');
    assert.equal(sum('>> deeper'), 'deeper');
    assert.equal(sum('> # Title\n> body.'), 'Title. body.');
    assert.equal(sum('> - item one\n> - item two'), 'item one. item two');
  });

  it('only treats # as a heading when a space follows', () => {
    assert.equal(sum('#hashtag stays'), '#hashtag stays');
    assert.equal(sum('Issue #42 is fixed.'), 'Issue #42 is fixed.');
  });

  it('leaves plain numbers and dashes that are not list markers alone', () => {
    assert.equal(sum('Version 1.5 is out. 3 files changed.'), 'Version 1.5 is out. 3 files changed.');
    assert.equal(sum('well-known and -x flag'), 'well-known and -x flag');
    assert.equal(sum('2 * 3 = 6'), '2 3 = 6'); // the asterisk is emphasis syntax and is dropped, as before
  });

  it('closing hashes on an ATX heading are dropped', () => {
    assert.equal(sum('## Title ##\nBody.'), 'Title. Body.');
  });

  it('folds non-ASCII exactly like toAscii', () => {
    assert.equal(sum('Caf\u00e9 \u201cready\u201d \u2014 done \u{1F600}.'), 'Cafe "ready" - done ?.');
  });
});

describe('summarizeForDevice: whole sentences, and never over the limit', () => {
  const text = 'First one. Second one is here. Third.';

  it('returns everything when it fits, to the character', () => {
    assert.equal(summarizeForDevice(text, text.length), text);
    assert.equal(summarizeForDevice(text, 1000), text);
    assert.equal(summarizeForDevice(text, Infinity), text);
  });

  it('returns as many whole sentences as fit', () => {
    assert.equal(summarizeForDevice(text, text.length - 1), 'First one. Second one is here.');
    assert.equal(summarizeForDevice(text, 30), 'First one. Second one is here.');
    assert.equal(summarizeForDevice(text, 29), 'First one.');
    assert.equal(summarizeForDevice(text, 10), 'First one.');
  });

  it('cuts the first sentence with ... only when not even that fits', () => {
    assert.equal(summarizeForDevice(text, 9), 'First...');
    assert.equal(summarizeForDevice(text, 4), 'F...');
    assert.equal(summarizeForDevice(text, 3), 'Fir');
  });

  it('never returns half of a later sentence once one whole sentence fits', () => {
    const r = rng(5);
    const sentences = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} has ${'word '.repeat(1 + Math.floor(r() * 4))}end.`);
    const joined = sentences.join(' ');
    for (let max = 0; max <= joined.length + 2; max++) {
      const out = summarizeForDevice(joined, max);
      assert.ok(out.length <= max, `max ${max}: ${out.length}`);
      const fitting = sentences.reduce<string[]>((acc, s) => {
        const next = [...acc, s];
        return acc.length === next.length - 1 && next.join(' ').length <= max && acc.length === sentences.indexOf(s) ? next : acc;
      }, []);
      if (fitting.length > 0) {
        assert.equal(out, fitting.join(' '), `max ${max}: should be the longest run of whole sentences`);
      } else {
        // not even the first sentence fits: a cut, marked as one (when there is room for the marker)
        if (max > 3) assert.ok(out.endsWith('...'), `max ${max}: ${out}`);
        assert.ok(joined.startsWith(out.replace(/\.\.\.$/, '')), `max ${max}: not a prefix`);
      }
    }
  });

  it('treats a nonsense limit as nothing fits', () => {
    for (const max of [0, -1, NaN, -Infinity]) assert.equal(summarizeForDevice(text, max), '', String(max));
    assert.equal(summarizeForDevice(text, 10.9), 'First one.');
  });

  it('never exceeds the limit and always returns clean ASCII, over fuzzed markdown and every limit', () => {
    const r = rng(13);
    const bits = ['#', '## ', '- ', '1. ', '> ', '```', '`', '**', '__', '~~', '[a](http://x.y)', 'https://x.y/z.', '|', '---', '\n', '\n\n', ' ', 'word', 'Word.', 'Why?', '\u00e9', '\u{1F600}', '\u200b', '\0', '\ud800', '\u201c', '[', ']', '(', ')', '*', '<b>'];
    for (let i = 0; i < 1500; i++) {
      let md = '';
      const n = Math.floor(r() * 40);
      for (let k = 0; k < n; k++) md += bits[Math.floor(r() * bits.length)]!;
      for (const max of [0, 1, 3, 4, 10, 40, 96, 240, 400]) {
        const out = summarizeForDevice(md, max);
        assert.ok(out.length <= max, `max ${max}: ${JSON.stringify(md)}`);
        assert.ok(isPrintableAscii(out), JSON.stringify(md));
        assert.doesNotMatch(out, /^ | $|  /, JSON.stringify(md));
      }
    }
  });

  it('is deterministic', () => {
    for (const s of HOSTILE) assert.equal(summarizeForDevice(s, 120), summarizeForDevice(s, 120));
  });
});

describe('summarizeForDevice: hostile and huge input', () => {
  it('stays fast on 200k characters of every markdown shape that tempts a regex into backtracking', () => {
    const shapes: Record<string, string> = {
      'open brackets': '['.repeat(200000),
      'link openers': '[a]('.repeat(50000),
      'bracket then text': '[' + 'a'.repeat(199999),
      'images': '![x]('.repeat(40000),
      'fences': '```'.repeat(66000),
      'unterminated fence': '```' + 'a\n'.repeat(100000),
      'newlines': '\n'.repeat(200000),
      'short lines': 'a\n'.repeat(100000),
      'spaces': ' '.repeat(200000),
      'spaces then x': ' '.repeat(199999) + 'x',
      'quote markers': '> '.repeat(100000),
      'one line of quote markers': '>'.repeat(200000),
      'hashes': '#'.repeat(200000),
      'hash lines': '# a\n'.repeat(50000),
      'bullets': '- '.repeat(100000),
      'bullet lines': '- a\n'.repeat(50000),
      'numbered': '1. a\n'.repeat(40000),
      'pipes': '|'.repeat(200000),
      'rule chars': '- '.repeat(100000) + 'x',
      'dashes': '-'.repeat(200000) + 'x',
      'stars': '*'.repeat(200000),
      'underscores': '_'.repeat(200000),
      'urls': 'http://a '.repeat(20000),
      'one long url': 'https://' + 'a'.repeat(200000),
      'url dots': 'http://x' + '.'.repeat(200000),
      'emoji': '\u{1F600}'.repeat(100000),
      'invisibles': '\u200b'.repeat(200000),
      'plain prose': 'Sentence one is here. '.repeat(10000),
      'one sentence': 'word '.repeat(40000),
      'table rows': '| a | b |\n'.repeat(20000),
    };
    for (const [name, md] of Object.entries(shapes)) {
      for (const max of [96, 240, 1_000_000]) {
        const out = timed(`${name} (max ${max})`, () => summarizeForDevice(md, max));
        assert.ok(out.length <= max, name);
        assert.ok(isPrintableAscii(out), name);
      }
    }
  });

  it('answers a huge answer with its first sentences, within the limit', () => {
    const md = 'Sentence one is here. '.repeat(10000);
    const out = summarizeForDevice(md, 240);
    assert.ok(out.length <= 240 && out.startsWith('Sentence one is here. Sentence one'));
    assert.ok(out.endsWith('here.'), 'ends on a sentence boundary');
  });

  it('survives the hostile corpus, whatever the limit', () => {
    for (const s of HOSTILE) {
      for (const max of [0, 5, 96, 240]) {
        const out = summarizeForDevice(s, max);
        assert.ok(out.length <= max && isPrintableAscii(out), JSON.stringify(s.slice(0, 30)));
      }
    }
  });

  it('does not throw on input that is not a string', () => {
    const throwing = { toString() { throw new Error('boom'); } };
    for (const v of [null, undefined, 5, {}, [], throwing]) {
      assert.ok(isPrintableAscii(summarizeForDevice(v as unknown as string, 50)));
    }
  });
});

// ---------------------------------------------------------------------------
// The caller: text.ts exists so that the codec accepts what is built from it.
// ---------------------------------------------------------------------------
describe('text.ts output is accepted by the codec', () => {
  it('every free-text field of every bridge message, built from hostile input', () => {
    for (const h of HOSTILE) {
      const messages = [
        { t: 'result', ok: true, text: summarizeForDevice(h, LIMITS.resultMax) },
        { t: 'stt', text: sanitize(h, LIMITS.sttMax) },
        { t: 'ask', id: '0a1b2c3d', tl: sanitize(h, LIMITS.labelMax), risk: 'high', sum: sanitize(h, LIMITS.summaryMax), ttl: 60 },
        { t: 'state', seq: 1, ph: 'tool', tl: sanitize(h, LIMITS.labelMax), pend: 0 },
        { t: 'err', code: 'driver', msg: sanitize(h, LIMITS.errMax) },
      ] as const;
      for (const m of messages) {
        const wire = encodeBridgeMsg(m);
        assert.deepEqual(decodeBridgeMsg(wire), { ok: true, msg: m }, `${m.t} from ${JSON.stringify(h.slice(0, 30))}`);
      }
      assert.doesNotThrow(() => encodeDeviceMsg({ t: 'say', text: sanitize(h, LIMITS.sayMax) }));
    }
  });

  it('while the same strings, unsanitised, ARE refused (so the line above is not vacuous)', () => {
    const nonAscii = HOSTILE.filter((h) => !isPrintableAscii(h));
    assert.ok(nonAscii.length > 20, 'the corpus must contain plenty of strings that need folding');
    for (const h of nonAscii) {
      assert.throws(() => encodeBridgeMsg({ t: 'stt', text: h.slice(0, LIMITS.sttMax) }), RangeError, JSON.stringify(h.slice(0, 30)));
    }
    // And over-long text is refused too, which is what the cap in sanitize() is for.
    assert.throws(() => encodeBridgeMsg({ t: 'stt', text: 'x'.repeat(LIMITS.sttMax + 1) }), RangeError);
    assert.doesNotThrow(() => encodeBridgeMsg({ t: 'stt', text: sanitize('x'.repeat(LIMITS.sttMax + 1), LIMITS.sttMax) }));
  });
});
