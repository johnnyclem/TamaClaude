/**
 * Text that is about to reach the handheld's panel.
 *
 * The bitmap font has no glyphs beyond printable ASCII, so anything else renders
 * as garbage (the firmware's CLAUDE.md calls this its first hard rule). Model
 * output is full of curly quotes, accents and emoji, so every string bound for the
 * device goes through here -- there is deliberately no other way to build one.
 */

const PUNCT: Record<string, string> = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"',
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '•': '*', '·': '*', '●': '*',
  '→': '->', '←': '<-', '⇒': '=>',
  '×': 'x', '©': '(c)', '®': '(r)', '™': '(tm)',
  'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
  'ø': 'o', 'Ø': 'O', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L',
};

/**
 * Printable ASCII only: accents are stripped to their base letter, common
 * punctuation is mapped, whitespace and control characters collapse to single
 * spaces, and each run of anything else (emoji, CJK, ...) becomes one `?`.
 */
export function toAscii(input: string): string {
  let out = '';
  let lastQ = false;
  for (const raw of String(input)) {
    const mapped = PUNCT[raw] ?? raw;
    for (const ch of mapped.normalize('NFKD')) {
      if (/\p{M}/u.test(ch)) continue; // combining accent left over from NFKD
      const cp = ch.codePointAt(0)!;
      if (/\s/u.test(ch) || cp < 0x20 || cp === 0x7f) {
        if (!out.endsWith(' ')) out += ' ';
        lastQ = false;
      } else if (cp <= 0x7e) {
        out += ch;
        lastQ = false;
      } else if (!lastQ) {
        out += '?';
        lastQ = true;
      }
    }
  }
  return out.trim();
}

/** Cut to `max` characters, ending in `...` when something was dropped. */
export function truncateText(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 3) return s.slice(0, Math.max(0, max));
  return s.slice(0, max - 3).trimEnd() + '...';
}

/** ASCII-fold, then cap at `max`. `truncated` tells the caller something was cut. */
export function sanitizeInfo(input: string, max: number): { text: string; truncated: boolean } {
  const ascii = toAscii(input);
  return { text: truncateText(ascii, max), truncated: ascii.length > max };
}

export function sanitize(input: string, max: number): string {
  return sanitizeInfo(input, max).text;
}

/**
 * Turn a model answer into something fit for a 25-character-wide panel and, later,
 * for a text-to-speech engine: markdown, code blocks and URLs removed, then as many
 * WHOLE sentences as fit in `max`. If even the first sentence is too long it is cut
 * with `...`.
 */
export function summarizeForDevice(markdown: string, max: number): string {
  let s = String(markdown);
  s = s.replace(/```[\s\S]*?(```|$)/g, ' ');            // fenced code, including an unterminated one
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');      // [text](url) -> text
  s = s.replace(/\bhttps?:\/\/\S+/gi, 'a link');         // bare URLs
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');              // headings
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '');       // list markers
  s = s.replace(/^\s*>\s?/gm, '');                       // quotes
  s = s.replace(/[`*_~|]/g, '');                         // emphasis, inline code, table pipes
  const flat = toAscii(s);
  if (flat.length <= max) return flat;

  const sentences = flat.split(/(?<=[.!?])\s+/);
  let out = '';
  for (const sentence of sentences) {
    const next = out ? `${out} ${sentence}` : sentence;
    if (next.length > max) break;
    out = next;
  }
  return out || truncateText(flat, max);
}
