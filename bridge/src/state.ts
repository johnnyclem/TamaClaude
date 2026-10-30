/**
 * The device-facing phase, as a pure function of what the session has reported.
 *
 * Three sources feed it: the driver (tools starting and ending, a turn finishing),
 * the push-to-talk and prompt plumbing (listen start/stop, a prompt going out) and
 * the approval manager (how many asks are open). None of them knows the others'
 * business, so nothing outside this file decides what the pet should be doing.
 *
 * The one idea that keeps it small: the state stores FACTS, never the phase.
 *
 *   - `base`  is what the turn is doing when nothing else is happening
 *             (idle, listening, transcribing, thinking, done, error);
 *   - `tools` are the tool calls started and not yet ended;
 *   - `asks`  is how many approvals are open, and `askLabel` names the one shown.
 *
 * The phase is derived: an open ask beats a running tool, which beats `base`. That
 * is why "when the asks are answered the phase returns to what it would have been"
 * needs no code at all, and why a stray `tool_end` cannot leave a stale overlay
 * behind: there is no overlay to leave, only a list that is either empty or not.
 *
 * A turn is running exactly while `base` is `thinking`. Tools exist only inside a
 * turn, so tool events and terminal events outside one are ignored, not adopted:
 * adopting a late `tool_start` would park the pet on `tool` with no terminal event
 * left to clear it. `asks` is the exception, on purpose, and the reducer treats it that
 * way everywhere: it is not an event of the turn but a REPORT of what the approval manager
 * has open right now, so only an `asks` input changes it. A terminal event, a stop or a
 * new prompt leave it alone, because an ask can outlive its turn (a background task asking
 * after the result) and hiding an ask that is open would leave the player's panel idle
 * while an approval waits on it. The server therefore has nothing to re-assert after a
 * terminal event: the one place that decides what is open is the manager, and the one input
 * that mirrors it is `asks`.
 *
 * Guarantees the server relies on:
 *  - `reduce` never throws and never mutates its argument, for any input of the declared
 *    types however hostile the strings and numbers inside it;
 *  - an input that changes nothing returns the SAME object, so `next === prev`
 *    means "send no state message";
 *  - every state is frozen, so a caller that tries to edit one fails loudly.
 */

import { sanitize } from './text.ts';
import { LIMITS } from './types.ts';
import type { DriverEvent, Phase, StateMsg } from './types.ts';

/** The phases a turn can rest in with nothing overlaid. `speaking` has no input yet. */
export type BasePhase = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'done' | 'error';

export interface ActiveTool {
  readonly id: string;
  /** Already sanitised: at most LIMITS.labelMax printable ASCII characters, never empty. */
  readonly label: string;
}

export interface BridgeState {
  readonly base: BasePhase;
  /** Started and not ended, oldest first. Empty unless a turn is running. */
  readonly tools: readonly ActiveTool[];
  /** Open asks. Always a non-negative integer that fits the wire. */
  readonly asks: number;
  /** Label of the ask on the panel; '' exactly when `asks` is 0. */
  readonly askLabel: string;
  /** The user stopped the running turn and its terminal event has not arrived yet. */
  readonly aborting: boolean;
}

export type StateInput =
  | DriverEvent
  | { k: 'listen_start' } | { k: 'listen_stop' } | { k: 'listen_cancel' }
  /**
   * The transcript has been handed to the device. A dictated transcript never starts a turn
   * by itself (PROTOCOL.md): the player reads it and the device sends a `say`, so this only
   * ends the transcription and the pet rests.
   */
  | { k: 'stt_done' }
  | { k: 'prompt_sent' }
  | { k: 'asks'; count: number; label: string }   // open asks changed (label of the head ask, '' when none)
  | { k: 'aborted' }                // the USER stopped the turn
  /**
   * `done` and `error` last until something happens, and nothing in the list above is
   * a timer. The server calls this when it wants the pet to rest again (PROTOCOL.md
   * shows `done` followed by `idle`); it does nothing in any other phase.
   */
  | { k: 'settle' };

/** What the panel shows for a tool whose name sanitises to nothing. */
const FALLBACK_LABEL = 'tool';

/**
 * Parallel tool calls are a handful. The cap is for a model (or a bug) that starts
 * tools and never ends them: the list is cleared by the next terminal event anyway,
 * but until then it must not grow without bound. When full the OLDEST is dropped,
 * because only the newest still-active tool is ever shown.
 */
const MAX_ACTIVE_TOOLS = 32;

/** Every number on the wire fits an int32 (PROTOCOL.md). */
const INT_MAX = 2147483647;

const NO_TOOLS: readonly ActiveTool[] = Object.freeze([]);

function freezeState(s: BridgeState): BridgeState {
  return Object.freeze(s);
}

export const initialState: BridgeState = freezeState({
  base: 'idle',
  tools: NO_TOOLS,
  asks: 0,
  askLabel: '',
  aborting: false,
});

function patch(s: BridgeState, p: Partial<BridgeState>): BridgeState {
  return freezeState({ ...s, ...p });
}

/**
 * Names come from the model and from MCP servers, so anything can arrive: empty,
 * megabytes long, emoji, control characters. text.ts is the only way text reaches the
 * panel; the fallback keeps a tool that is running from showing a blank label.
 */
function labelFor(raw: unknown): string {
  const label = sanitize(typeof raw === 'string' ? raw : '', LIMITS.labelMax);
  return label === '' ? FALLBACK_LABEL : label;
}

/** A garbage count is "no asks", not "some asks": nothing is ever asked on a guess. */
function countFor(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0;
  return Math.min(Math.floor(n), INT_MAX);
}

/** No turn in flight and no input window open: the places a new input may begin from. */
function atRest(b: BasePhase): boolean {
  return b === 'idle' || b === 'done' || b === 'error';
}

/** True while a prompt has been sent and its terminal event has not arrived. */
export function isTurnRunning(s: BridgeState): boolean {
  return s.base === 'thinking';
}

/** The phase the device is told about. */
export function phaseOf(s: BridgeState): Phase {
  if (s.asks > 0) return 'asking';
  if (s.tools.length > 0) return 'tool';
  return s.base;
}

function labelOf(s: BridgeState): string {
  if (s.asks > 0) return s.askLabel;
  const last = s.tools[s.tools.length - 1];
  return last === undefined ? '' : last.label;
}

/** A fresh turn: whatever the previous one left behind does not carry over. */
function startTurn(s: BridgeState): BridgeState {
  return patch(s, { base: 'thinking', tools: NO_TOOLS, aborting: false });
}

export function reduce(s: BridgeState, i: StateInput): BridgeState {
  switch (i.k) {
    // Neither changes what the pet is doing: `text` includes chatter between tool
    // calls, and the session id is bookkeeping for the server.
    case 'session':
    case 'text':
      return s;

    case 'listen_start':
      return atRest(s.base) ? patch(s, { base: 'listening' }) : s;
    case 'listen_stop':
      return s.base === 'listening' ? patch(s, { base: 'transcribing' }) : s;
    case 'listen_cancel':
      return s.base === 'listening' || s.base === 'transcribing' ? patch(s, { base: 'idle' }) : s;

    // The transcript is out; only a prompt (the player's SEND, as a `say`) starts a turn. A
    // repeated or stray `stt_done` outside a transcription changes nothing.
    case 'stt_done':
      return s.base === 'transcribing' ? patch(s, { base: 'idle' }) : s;
    // A second `prompt_sent` while the turn runs must not restart it, or a tool that began in
    // between would be forgotten.
    case 'prompt_sent':
      return isTurnRunning(s) ? s : startTurn(s);

    case 'tool_start': {
      if (!isTurnRunning(s) || typeof i.id !== 'string') return s;
      // The same tool_use can be reported twice (a streamed block, then the complete
      // message). A second entry could never be ended and would pin the phase to `tool`.
      if (s.tools.some((t) => t.id === i.id)) return s;
      const tools = [...s.tools, Object.freeze({ id: i.id, label: labelFor(i.name) })];
      return patch(s, { tools: Object.freeze(tools.length > MAX_ACTIVE_TOOLS ? tools.slice(-MAX_ACTIVE_TOOLS) : tools) });
    }
    case 'tool_end': {
      const at = s.tools.findIndex((t) => t.id === i.id);
      if (at < 0) return s;
      return patch(s, { tools: Object.freeze(s.tools.filter((_, n) => n !== at)) });
    }

    case 'asks': {
      const count = countFor(i.count);
      const label = count === 0 ? '' : labelFor(i.label);
      return count === s.asks && label === s.askLabel ? s : patch(s, { asks: count, askLabel: label });
    }

    case 'result':
    case 'fatal': {
      // Nothing to end: a repeat of the terminal event, or one with no prompt before it.
      // Honouring it would flip a settled `error` to `done`, or invent a turn that
      // nobody started.
      if (!isTurnRunning(s)) return s;
      // A user stop is not a failure. Only a `result` is the stopped turn's own ending;
      // a `fatal` means the session itself died, which the player should still see.
      const base: BasePhase = i.k === 'fatal' ? 'error' : s.aborting ? 'idle' : i.ok === true ? 'done' : 'error';
      // `asks` and `askLabel` are deliberately left as they are: see the header.
      return patch(s, { base, tools: NO_TOOLS, aborting: false });
    }

    case 'aborted':
      // Only a running turn can be stopped. Flagging an idle state would make the NEXT
      // turn's result read as a stop, and that turn would end `idle` instead of `done`.
      return isTurnRunning(s) && !s.aborting ? patch(s, { aborting: true }) : s;

    case 'settle':
      return s.base === 'done' || s.base === 'error' ? patch(s, { base: 'idle' }) : s;

    default: {
      // Compile-time: a new StateInput that is not handled above fails the typecheck.
      // Run-time: an input this build has never heard of is ignored, not fatal.
      const unhandled: never = i;
      void unhandled;
      return s;
    }
  }
}

export function toStateMsg(s: BridgeState, seq: number): StateMsg {
  const ph = phaseOf(s);
  return { t: 'state', seq, ph, tl: ph === 'tool' || ph === 'asking' ? labelOf(s) : '', pend: s.asks };
}
