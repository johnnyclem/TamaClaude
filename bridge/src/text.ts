/**
 * Text that is about to reach the handheld's panel.
 *
 * The bitmap font has no glyphs beyond printable ASCII, so anything else renders
 * as garbage (the firmware's CLAUDE.md calls this its first hard rule). Model
 * output is full of curly quotes, accents and emoji, so every string bound for the
 * device goes through here -- there is deliberately no other way to build one.
 *
 * Model output is also untrusted input: it can carry anything a web page or a
 * tool result can, so nothing here may throw, and nothing may take longer than
 * linear time. Every regular expression below is either anchored to one line or
 * has a bounded repeat for that reason; an unbounded `[^\]]*` over 200k `[`
 * characters is a multi-second stall on the bridge's only thread.
 */

// Written as escapes on purpose: this file decides what reaches the panel, and an
// invisible or look-alike character hiding in its own source is the one place that
// must not be possible. The comments name the groups.
const PUNCT = new Map<string, string>(Object.entries({
  '\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'", '\u2039': "'", '\u203a': "'", // curly and angle single quotes
  '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '\u00ab': '"', '\u00bb': '"', // curly and angle double quotes
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-', // hyphens, dashes, minus sign
  '\u2022': '*', '\u00b7': '*', '\u25cf': '*', // bullet, middle dot, black circle
  '\u2192': '->', '\u2190': '<-', '\u21d2': '=>', // arrows
  '\u00d7': 'x', '\u00a9': '(c)', '\u00ae': '(r)', '\u2122': '(tm)', // multiplication sign, (c), (r), trade mark
  '\u2044': '/', // fraction slash, which is what NFKD makes of the vulgar fractions
  '\u00df': 'ss', '\u00e6': 'ae', '\u00c6': 'AE', '\u0153': 'oe', '\u0152': 'OE', // letters NFKD does not decompose
  '\u00f8': 'o', '\u00d8': 'O', '\u0111': 'd', '\u0110': 'D', '\u0142': 'l', '\u0141': 'L', // more of the same
  '\u00f0': 'd', '\u00d0': 'D', '\u00fe': 'th', '\u00de': 'Th', '\u0131': 'i', // eth, thorn, dotless i
}));

const COMBINING = /\p{M}/u;
/**
 * Invisible format characters: zero-width space/joiner/non-joiner, bidi marks and
 * overrides, soft hyphen, BOM, the emoji tag block. They draw nothing, so turning
 * them into `?` would put visible junk inside words ("he?llo") and, for a flag or
 * family emoji, break one symbol into several.
 */
const FORMAT = /\p{Cf}/u;
const WHITESPACE = /\s/u;

function safeString(v: unknown): string {
  try {
    return String(v);
  } catch {
    return ''; // e.g. an object with a throwing toString; there is nothing sensible to show
  }
}

/**
 * Printable ASCII only: accents are stripped to their base letter, common
 * punctuation is mapped, whitespace and control characters collapse to single
 * spaces, invisible format characters vanish, and each run of anything else
 * (emoji, CJK, ...) becomes one `?`.
 */
export function toAscii(input: string): string {
  const s = typeof input === 'string' ? input : safeString(input);
  // Built with flags, not by inspecting `out`: calling endsWith on a string that is
  // being grown character by character flattens it every time, which is quadratic.
  let out = '';
  let pendingSpace = false;
  let lastQ = false;

  const emit = (piece: string): void => {
    if (pendingSpace && out !== '') out += ' ';
    pendingSpace = false;
    out += piece;
  };

  for (const raw of s) {
    const cp = raw.codePointAt(0)!;
    if (cp > 0x20 && cp <= 0x7e) { // by far the common case; skips normalize and the regexes
      emit(raw);
      lastQ = false;
      continue;
    }
    for (const ch of (PUNCT.get(raw) ?? raw).normalize('NFKD')) {
      const c = ch.codePointAt(0)!;
      // Looked up again AFTER normalising: NFKD turns a vulgar fraction into digits around
      // U+2044, which is a character of its own that needs mapping.
      const folded = PUNCT.get(ch);
      if (folded !== undefined) {
        emit(folded);
        lastQ = false;
      } else if (c > 0x20 && c <= 0x7e) {
        emit(ch);
        lastQ = false;
      } else if (COMBINING.test(ch) || FORMAT.test(ch)) {
        continue; // does not interrupt a run of `?`, so one emoji stays one `?`
      } else if (c <= 0x20 || (c >= 0x7f && c <= 0x9f) || WHITESPACE.test(ch)) {
        pendingSpace = true;
        lastQ = false;
      } else if (!lastQ) {
        emit('?');
        lastQ = true;
      }
    }
  }
  return out;
}

/** `s` cut to `n` UTF-16 units without leaving half of a surrogate pair behind. */
function cut(s: string, n: number): string {
  const r = s.slice(0, n);
  const last = r.charCodeAt(r.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? r.slice(0, -1) : r;
}

/** Cut to `max` characters, ending in `...` when something was dropped. */
export function truncateText(s: string, max: number): string {
  if (!(max > 0)) return ''; // also catches NaN, for which every comparison below would be false
  const cap = Math.floor(max);
  if (s.length <= cap) return s;
  if (cap <= 3) return cut(s, cap).trimEnd();
  return cut(s, cap - 3).trimEnd() + '...';
}

/** ASCII-fold, then cap at `max`. `truncated` tells the caller something was cut. */
export function sanitizeInfo(input: string, max: number): { text: string; truncated: boolean } {
  const ascii = toAscii(input);
  const text = truncateText(ascii, max);
  return { text, truncated: text !== ascii };
}

export function sanitize(input: string, max: number): string {
  return sanitizeInfo(input, max).text;
}

// ---------------------------------------------------------------------------
// summarizeForDevice
// ---------------------------------------------------------------------------

const FENCE = /```[\s\S]*?(?:```|$)/g; // including an unterminated one, which runs to the end
/**
 * `[text](url)`. The text may not contain `[`, so a run of opening brackets fails at
 * once instead of rescanning the rest of the input from every one of them.
 */
const MD_LINK = /!?\[([^[\]\n]{0,100})\]\([^)\n]{0,300}\)/g;
const BARE_URL = /\bhttps?:\/\/\S+/gi;
const HRULE = /^\s*(?:[-*_]\s*){3,}$/;
const QUOTE = /^\s{0,3}(?:>\s?)+/;
const HEADING = /^\s{0,3}#{1,6}\s+/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const CHECKBOX = /^\[[ xX]\]\s+/;
const TERMINAL = /[.!?:;]['")\]]*$/;

// ---------------------------------------------------------------------------
// Inline markup
//
// Markup is removed ONLY where it forms markup. The first version deleted every `*`, `_`, `~`, backtick and
// pipe, which turned "I removed ~/build" into "I removed /build", "snake_case_name" into "snakecasename" and
// "5 * 3" into "5 3": a safety-relevant answer reached the device saying the opposite of what it meant. A
// delimiter counts as markup when it opens or closes a span the way markdown requires:
//   - `*x*`, `**x**`, `***x***`, `_x_`, `~~x~~`: the opener is at the start of a word and is followed by a
//     character that is not a space, the closer follows one and ends the word. So `a*b*c`, `snake_case_name`
//     and `5 * 3` are untouched, and so are `~/build` and `a ~ b` (a single tilde is never markup).
//   - `__x__`: bold, but only when it holds more than one word. `__init__.py` is a name, and `__main__` too.
//   - backticks: the code markers go, the code stays.
//   - a pipe, only in a table row.
// Every pattern is a bounded repeat anchored to a delimiter, so a line of unmatched openers rescans at most
// 200 characters from each; and nothing here is `\s+X$`, which is quadratic on a long run of spaces.
// ---------------------------------------------------------------------------

// A span of emphasis is looked for up to 200 characters long (the `{1,200}` below): a longer one is not worth the rescans.
const BOLD_ITALIC = /(^|[^\w*\\])\*{3}(?=[^\s*])([^*\n]{1,200}?)(?<=[^\s*\\])\*{3}(?![\w*])/g;
const BOLD_STAR = /(^|[^\w*\\])\*{2}(?=[^\s*])([^*\n]{1,200}?)(?<=[^\s*\\])\*{2}(?![\w*])/g;
const ITALIC_STAR = /(^|[^\w*\\])\*(?=[^\s*])([^*\n]{1,200}?)(?<=[^\s*\\])\*(?![\w*])/g;
const BOLD_UNDER = /(^|[^\w\\])__(?=[^\s_])([^_\n]{1,200}?)(?<=[^\s_\\])__(?!\w)/g;
const ITALIC_UNDER = /(^|[^\w\\])_(?=[^\s_])([^_\n]{1,200}?)(?<=[^\s_\\])_(?!\w)/g;
const STRIKE = /(^|[^\w~\\])~~(?=[^\s~])([^~\n]{1,200}?)(?<=[^\s~\\])~~(?![\w~])/g;
const ESCAPED = /\\([*_~`])/g;
const MARKUP_CHARS = /[*_~`\\]/;

/**
 * `text` (already ASCII, single spaces) without the markdown emphasis, strike and code markers that form markup (see above).
 * Taking a marker out can leave two spaces side by side or a space at an end ("a ` b"), which the panel must not get, so a
 * changed text is tidied. `final` also turns an escaped marker (`\\*`) into the plain character: it is done ONCE, on the last
 * pass, because the text goes through this twice (line by line, then as one paragraph) and an unescaped `*` would be read as
 * emphasis the second time.
 */
function stripEmphasis(text: string, final: boolean): string {
  if (!MARKUP_CHARS.test(text)) return text;
  let t = text.replace(BOLD_ITALIC, '$1$2').replace(BOLD_STAR, '$1$2').replace(ITALIC_STAR, '$1$2');
  t = t.replace(BOLD_UNDER, (m: string, pre: string, body: string) => (/\s/.test(body) ? pre + body : m));
  t = t.replace(ITALIC_UNDER, '$1$2').replace(STRIKE, '$1$2');
  t = t.replace(/`/g, '');
  if (final) t = t.replace(ESCAPED, '$1');
  return t === text ? text : t.replace(/ {2,}/g, ' ').trim();
}

/**
 * The closing hashes of an ATX heading ("## Title ##"). A scan, because the obvious `/\s+#+\s*$/` is quadratic on a
 * line with a long run of spaces and no hash at the end: 100 000 of them took eight seconds.
 */
function stripClosingHashes(line: string): string {
  let end = line.length;
  while (end > 0 && WS_CHAR.test(line[end - 1]!)) end--;
  let hashes = end;
  while (hashes > 0 && line[hashes - 1] === '#') hashes--;
  if (hashes === end || hashes === 0 || !WS_CHAR.test(line[hashes - 1]!)) return line; // no hashes, or no space before them: part of the text
  let keep = hashes;
  while (keep > 0 && WS_CHAR.test(line[keep - 1]!)) keep--;
  return line.slice(0, keep);
}
const WS_CHAR = /\s/;

/** Punctuation that ends a sentence rather than an address. */
const URL_TRAIL = ".,;:!?)]'\"";

type LineKind = 'plain' | 'heading' | 'list' | 'table';

interface Piece {
  text: string;
  /** True when this line opens a new block (paragraph, heading, list item, table row). */
  opens: boolean;
}

/**
 * Turn a model answer into something fit for a 25-character-wide panel and, later,
 * for a text-to-speech engine: markdown, code blocks and URLs removed, then as many
 * WHOLE sentences as fit in `max`. If even the first sentence is too long it is cut
 * with `...`. The result never exceeds `max`.
 *
 * Markdown structure is removed line by line rather than all at once because the
 * structure was doing the work of punctuation: "## Done" and "I fixed it" are two
 * sentences only because they sit on different lines. Once the line breaks are
 * flattened they glue into "Done I fixed it", which reads as one wrong sentence, so
 * a block that ends without terminal punctuation gets a period when something
 * follows it. Continuation lines of one paragraph or list item are not blocks and
 * are left alone, or a wrapped line would gain a period in the middle of a sentence.
 */
export function summarizeForDevice(markdown: string, max: number): string {
  if (!(max > 0)) return '';
  const cap = Math.floor(max);

  let s = typeof markdown === 'string' ? markdown : safeString(markdown);
  s = s.replace(FENCE, '\n\n'); // a paragraph break, so prose either side does not run together
  s = s.replace(MD_LINK, '$1');
  s = s.replace(BARE_URL, (url) => {
    // The sentence's own punctuation is not part of the address: keep it. (Scanned from the end: the regex that
    // did this, `[.,;:!?)\]'"]+$`, retried from every character of a long run of dots, and 100 000 took ten seconds.)
    let k = url.length;
    while (k > 0 && URL_TRAIL.includes(url[k - 1]!)) k--;
    return `a link${url.slice(k)}`;
  });

  const pieces: Piece[] = [];
  let afterBreak = true;
  let afterHeading = false;
  for (let line of s.split(/\r\n|\r|\n/)) {
    if (line.trim() === '') {
      afterBreak = true;
      continue;
    }
    if (HRULE.test(line) || (/^[\s|:-]*$/.test(line) && line.includes('-'))) {
      afterBreak = true; // a rule or a table's header separator divides blocks and says nothing
      continue;
    }
    line = line.replace(QUOTE, '');

    let kind: LineKind = 'plain';
    if (HEADING.test(line)) {
      kind = 'heading';
      line = stripClosingHashes(line.replace(HEADING, ''));
    } else if (LIST_ITEM.test(line)) {
      kind = 'list';
      line = line.replace(LIST_ITEM, '').replace(CHECKBOX, '');
    } else if (line.trimStart().startsWith('|')) {
      kind = 'table';
    }

    // A pipe is markup only in a table row; everywhere else it is a character the answer meant ("a | b", `ls | grep x`).
    const flat = stripEmphasis(toAscii(kind === 'table' ? line.replace(/\|/g, ' ') : line), false);
    if (flat === '') continue; // nothing left once the markup is gone
    pieces.push({ text: flat, opens: afterBreak || afterHeading || kind !== 'plain' });
    afterBreak = false;
    afterHeading = kind === 'heading';
  }

  let flat = '';
  for (const [i, p] of pieces.entries()) {
    if (i > 0) {
      const prev = pieces[i - 1]!;
      flat += p.opens && !TERMINAL.test(prev.text) ? '. ' : ' ';
    }
    flat += p.text;
  }
  // A span of emphasis that wrapped onto the next line has its two markers on different lines, so the pass above could not
  // pair them; they are one paragraph now.
  flat = stripEmphasis(flat, true);
  if (flat.length <= cap) return flat;

  const sentences = flat.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > cap) break;
    out = next;
  }
  return out || truncateText(flat, cap);
}
