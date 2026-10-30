/**
 * The text appended to Claude Code's own system prompt for the handheld.
 *
 * Why it exists at all: the only thing the user ever hears or reads is the FINAL message
 * of a turn, on a 25-character-wide round panel or through a speaker. Everything the
 * stock prompt teaches (markdown, file paths, code blocks, a tour of the diff) is noise
 * there, and some of it is unspeakable. The second job is safety: input arrives through
 * speech recognition, which mangles exactly the words that matter (file names, flags,
 * identifiers), so the model is told to confirm before acting when a misheard word
 * could change a harmless command into a destructive one.
 *
 * Constraints, all pinned by test/voice-prompt.test.ts: printable ASCII only (it is
 * echoed back into logs and may be quoted to the device), under ~1200 characters (it
 * is paid for on every request), and no markdown of its own (it would model the style
 * it forbids).
 *
 * The SDK records the system prompt with the session, so a session resumed after this
 * text changes keeps the OLD wording. Start a fresh session when the rules change.
 */
export const VOICE_RULES: string = [
  'You are being used through a tiny round handheld device. The user hears or reads only your FINAL message of each turn. Nothing you say before it reaches them.',
  'Make the final message 1 to 3 short plain sentences. No markdown, no code, no file paths, no URLs and no lists. Say what you did and what the result is, not how you did it.',
  'If you are blocked or unsure, ask exactly ONE short question and stop.',
  'The input is DICTATED by voice and may contain recognition errors, especially in identifiers, file names and commands. When a word could be a destructive command or a different file name, confirm with the user before acting.',
  'Never claim an action succeeded unless a tool result showed it.',
  'If a permission request is denied, that is the decision of the user. Accept it, do not try the same thing another way, and say what was not done.',
].join('\n');
