/**
 * SDK message -> DriverEvent, with no I/O.
 *
 * The Agent SDK's message union is large, grows between releases, and describes the
 * same fact several times (a tool call shows up as a streaming block, then as a
 * complete assistant block; its outcome as a user-role tool_result). The bridge wants
 * exactly one small vocabulary, so this class is the only place that knows the SDK's
 * shapes, and the driver above it is only about lifecycle.
 *
 * Guarantees the rest of the bridge relies on:
 *
 *  - Every `tool_start` is followed by exactly one `tool_end` before the turn's
 *    terminal event. The SDK does not promise that (a stream can be cut off, a
 *    tool_result can go missing), so the adapter closes what is left, as failed.
 *  - Nothing here throws. The runtime shape of a message is only as good as the CLI's
 *    JSON, so leaf fields are checked rather than trusted, and anything unrecognised is
 *    ignored: the union grows, and a new variant must not be able to end a turn.
 *  - Subagent traffic (parent_tool_use_id set) can show activity but can never end the
 *    turn or add to the log; only the main thread speaks for the turn.
 *  - A turn nobody asked for is never reported as the answer to a prompt. The driver gives
 *    each prompt a uuid (`begin()`); the CLI echoes it in `user_message_uuids` on every
 *    frame of the turn it ran for that prompt, and a turn it started on its own (a finished
 *    background task, a scheduled wake-up) carries no such stamp. Frames and results are
 *    attributed to the prompt in flight only through that stamp. Measured against the real
 *    CLI (see test/real-cli.integration.test.ts): the FIRST frame of a turn we asked for is
 *    always stamped, even a synthetic API-error message, so "unstamped first frame" means
 *    "not ours".
 *  - What the pet's owner reads is the CLI's own words. A failed result carries the CLI's
 *    short message as its text; an interrupt (`terminal_reason` aborted_*) is reported as
 *    `interrupted`, which the server turns into "Stopped." rather than an error.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DriverEvent } from '../types.ts';

type Rec = Record<string, unknown>;

/**
 * What the adapter tells the driver: the bridge's own vocabulary plus three signals that only
 * the driver can act on. They are not part of `DriverEvent` because the server must never see
 * them: each one is resolved inside the driver (a retry, a fast failure, a log line).
 */
export type AdapterEvent =
  | DriverEvent
  /** The CLI could not find the transcript of the session it was asked to resume. */
  | { k: 'resume_failed' }
  /**
   * The API call failed and the CLI will try again. `giveUp` is set when retrying cannot
   * help (a rejected key, a billing problem): the driver ends the turn at once with that
   * text instead of letting the pet "think" through the CLI's whole backoff.
   */
  | { k: 'api_retry'; error: string; status: number | null; attempt: number; max: number; giveUp: string | undefined }
  /** A result that belongs to a turn nobody here asked for. The driver logs it and moves on. */
  | { k: 'foreign_result' };

/**
 * `error` values of an `api_retry` that waiting cannot fix, with the one short sentence the
 * owner needs. The CLI's own prose for these exists only after its whole retry cycle (about
 * three minutes for a rejected key, measured), so the sentence comes from the CLI's error
 * CODE, which arrives with the first retry. Printable ASCII, one line, under the wire limit.
 *
 * NO IDENTIFIERS WITH UNDERSCORES OR ASTERISKS in these sentences: the server runs result text
 * through src/text.ts, which reads markdown, and `ANTHROPIC_API_KEY` reached the device as
 * `ANTHROPICAPIKEY` (measured). test/claude-adapter.test.ts holds every sentence here to "the
 * sanitiser leaves it unchanged", so this cannot come back.
 */
export const GIVE_UP: ReadonlyMap<string, string> = new Map([
  ['authentication_failed', 'the API key was rejected. Check the key the bridge was started with.'],
  ['oauth_org_not_allowed', 'this account is not allowed to use the API.'],
  ['account_on_hold', 'the Claude account is on hold.'],
  ['verification_required', 'the Claude account needs verification.'],
  ['billing_error', 'the API reports a billing problem.'],
  ['invalid_request', 'the API rejected the request.'],
  ['model_not_found', 'the API does not know this model.'],
  ['cloud_credential_error', 'the cloud credentials were rejected.'],
]);

/** The CLI's diagnostics for itself, not a message for a person. */
const DIAGNOSTIC_PREFIX = '[ede_diagnostic]';
const ERROR_TEXT_MAX = 300;
const STALE_RESUME = 'No conversation found with session ID';

/** Which prompts a frame answers, by the stamps the CLI echoes; undefined when it carries none. */
function stampsOf(msg: Rec): string[] | undefined {
  const list = msg.user_message_uuids;
  if (Array.isArray(list)) return list.filter((u): u is string => typeof u === 'string');
  const one = str(msg.user_message_uuid);
  return one === undefined ? undefined : [one];
}

/** The first error string a person could read, or ''. */
function errorText(msg: Rec): string {
  const errors = msg.errors;
  if (!Array.isArray(errors)) return '';
  for (const e of errors as unknown[]) {
    if (typeof e === 'string' && e.trim() !== '' && !e.startsWith(DIAGNOSTIC_PREFIX)) return e.trim().slice(0, ERROR_TEXT_MAX);
  }
  return '';
}

function isStaleResume(msg: Rec): boolean {
  return msg.subtype === 'error_during_execution' && Array.isArray(msg.errors) &&
    (msg.errors as unknown[]).some((e) => typeof e === 'string' && e.startsWith(STALE_RESUME));
}

/** A result the CLI wrote for a turn that never ran (a startup failure): no frames, no stamp, no turns. */
function isZeroedError(msg: Rec): boolean {
  return msg.is_error === true && (msg.num_turns === 0 || msg.startup_failure_reason !== undefined);
}

function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null;
}

/** A non-empty string, or undefined. Ids and names are only useful when they are real. */
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** The main thread and each subagent have separate content-block index spaces. */
const MAIN = '';
function ctxOf(parent: unknown): string {
  return typeof parent === 'string' ? parent : MAIN;
}
function isSub(parent: unknown): boolean {
  return parent !== null && parent !== undefined;
}

export class ClaudeAdapter {
  /** Tool ids announced with `tool_start` and not yet ended. */
  #open = new Set<string>();
  /**
   * Per context, content-block index -> tool id for blocks whose stream has started but
   * not finished. This is NOT the same as `#open`: once a block finishes streaming the
   * tool is legitimately still running until its tool_result arrives. Only a block that
   * is still streaming when its message ends was cut off and will never run.
   */
  #streaming = new Map<string, Map<number, string>>();
  #session: string | undefined;
  /**
   * Prompt attribution. An adapter nobody has called `begin()` on cannot judge ownership, so
   * it passes everything through (the unit tests of the mapping rules use one); the driver
   * calls `begin()` before it sends the first prompt, which switches judging on for good.
   */
  #bound = false;
  /** The uuid of the prompt in flight; undefined between prompts, when nothing is awaited. */
  #expected: string | undefined;
  /** Whose frames are streaming since the last result: unknown (`idle`), ours, or someone else's. */
  #turn: 'idle' | 'ours' | 'foreign' = 'idle';

  /** How many tools are announced and not yet ended. */
  get openToolCount(): number {
    return this.#open.size;
  }

  /**
   * How many tools are actually RUNNING: announced, finished streaming their input, and without a
   * result yet. A tool whose input block is still streaming is not running; a model that goes silent
   * in the middle of writing one is a stalled turn, and the driver's watchdog must not mistake it
   * for a long build. Subagent tools count (their context has its own streaming map).
   */
  get runningToolCount(): number {
    const streaming = new Set<string>();
    for (const m of this.#streaming.values()) for (const id of m.values()) streaming.add(id);
    let running = 0;
    for (const id of this.#open) if (!streaming.has(id)) running++;
    return running;
  }

  /**
   * A prompt with this uuid is about to be sent. From now until its result, only frames the
   * CLI stamps with it count as the turn's.
   */
  begin(uuid: string): void {
    this.#bound = true;
    this.#expected = uuid;
    // A turn of ours that never produced its result is not the turn of this prompt.
    if (this.#turn === 'ours') this.#turn = 'idle';
  }

  map(msg: SDKMessage): AdapterEvent[] {
    if (!isRec(msg)) return [];
    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init') return this.#init(msg.session_id);
        if (msg.subtype === 'api_retry') return this.#apiRetry(msg);
        return [];
      case 'stream_event':
        return this.#owns(msg, true) ? this.#stream(msg.event, msg.parent_tool_use_id) : [];
      case 'assistant':
        return this.#owns(msg, true) ? this.#assistant(msg) : [];
      case 'user':
        return this.#user(msg);
      case 'result':
        return this.#result(msg);
      default:
        return [];
    }
  }

  /**
   * Does this frame belong to the prompt in flight? Judged from the stamps the CLI echoes;
   * a frame without one inherits the turn it is in. `canStart` says whether the frame may
   * open a turn: only assistant and stream frames do, a tool result never starts one.
   */
  #owns(msg: Rec, canStart: boolean): boolean {
    if (!this.#bound) return true;
    const stamps = stampsOf(msg);
    if (stamps !== undefined) {
      this.#turn = this.#expected !== undefined && stamps.includes(this.#expected) ? 'ours' : 'foreign';
    } else if (this.#turn === 'idle' && canStart) {
      // The first frame of a turn we asked for is always stamped, so this one started on its own.
      this.#turn = 'foreign';
    }
    return this.#turn === 'ours';
  }

  /**
   * End every tool still open, as failed. The driver calls this when a stream dies or is
   * closed, so the terminal event it emits next never finds a tool dangling. `result`
   * does the same for itself.
   */
  abandon(): DriverEvent[] {
    const out: DriverEvent[] = [];
    for (const id of this.#open) out.push({ k: 'tool_end', id, ok: false });
    this.#open.clear();
    this.#streaming.clear();
    return out;
  }

  #apiRetry(msg: Rec): AdapterEvent[] {
    const error = str(msg.error) ?? 'unknown';
    const status = typeof msg.error_status === 'number' ? msg.error_status : null;
    const phrase = GIVE_UP.get(error);
    return [
      {
        k: 'api_retry',
        error,
        status,
        attempt: typeof msg.attempt === 'number' ? msg.attempt : 0,
        max: typeof msg.max_retries === 'number' ? msg.max_retries : 0,
        giveUp: phrase === undefined ? undefined : `Claude API error${status === null ? '' : ` ${status}`}: ${phrase}`,
      },
    ];
  }

  #init(sessionId: unknown): DriverEvent[] {
    const id = str(sessionId);
    // The CLI repeats init every turn; the same id twice in a row is not news.
    if (id === undefined || id === this.#session) return [];
    this.#session = id;
    return [{ k: 'session', id }];
  }

  #streamingFor(ctx: string): Map<number, string> {
    let m = this.#streaming.get(ctx);
    if (m === undefined) {
      m = new Map();
      this.#streaming.set(ctx, m);
    }
    return m;
  }

  /** The block for this tool finished streaming. The tool itself stays open until its result. */
  #finishStreaming(id: string): void {
    for (const m of this.#streaming.values()) {
      for (const [index, streamingId] of m) if (streamingId === id) m.delete(index);
    }
  }

  /** A tool that is done, one way or the other: no longer open and no longer streaming. */
  #settle(id: string): boolean {
    this.#finishStreaming(id);
    return this.#open.delete(id);
  }

  /** Close the blocks of one context that never finished streaming. */
  #closeCutOff(ctx: string): DriverEvent[] {
    const m = this.#streaming.get(ctx);
    if (m === undefined) return [];
    const out: DriverEvent[] = [];
    for (const id of m.values()) {
      if (this.#open.delete(id)) out.push({ k: 'tool_end', id, ok: false });
    }
    m.clear();
    return out;
  }

  /**
   * Only the structure of the stream matters here. The deltas -- including the text
   * deltas of narration between tool calls -- are deliberately ignored: the complete
   * assistant message that follows carries the same text once, and mapping both would
   * log everything twice.
   */
  #stream(event: unknown, parent: unknown): DriverEvent[] {
    if (!isRec(event)) return [];
    const ctx = ctxOf(parent);
    switch (event.type) {
      case 'message_start':
        // A new message while blocks of the previous one never finished means the first
        // stream was abandoned (an API retry, a fallback model).
        return this.#closeCutOff(ctx);
      case 'content_block_start': {
        const block = event.content_block;
        // Only client-side tools: a server-side tool_use (web search) or an MCP tool_use
        // is run by the API and never gets a tool_result from us, so announcing it would
        // leave it open forever.
        if (!isRec(block) || block.type !== 'tool_use') return [];
        const id = str(block.id);
        if (id === undefined || this.#open.has(id)) return [];
        this.#open.add(id);
        if (typeof event.index === 'number') this.#streamingFor(ctx).set(event.index, id);
        return [{ k: 'tool_start', id, name: str(block.name) ?? 'unknown' }];
      }
      case 'content_block_stop':
        if (typeof event.index === 'number') this.#streaming.get(ctx)?.delete(event.index);
        return [];
      case 'message_stop':
        return this.#closeCutOff(ctx);
      default:
        return [];
    }
  }

  #assistant(msg: Rec): DriverEvent[] {
    const message: unknown = msg.message;
    const content: unknown = isRec(message) ? message.content : undefined;
    if (!Array.isArray(content)) return [];
    const sub = isSub(msg.parent_tool_use_id);
    // An interrupt can cut a message mid-stream; the tools it names will never run.
    const aborted = msg.aborted === true;
    const out: DriverEvent[] = [];
    for (const block of content as unknown[]) {
      if (!isRec(block)) continue;
      if (block.type === 'text') {
        const text = block.text;
        if (!sub && typeof text === 'string' && text.trim() !== '') out.push({ k: 'text', text });
      } else if (block.type === 'tool_use') {
        const id = str(block.id);
        if (id === undefined) continue;
        if (aborted) {
          if (this.#settle(id)) out.push({ k: 'tool_end', id, ok: false });
          continue;
        }
        // The complete block is the proof its stream finished, even if the
        // content_block_stop event was never delivered.
        this.#finishStreaming(id);
        // Without partial messages this is the only place the call is announced.
        if (!this.#open.has(id)) {
          this.#open.add(id);
          out.push({ k: 'tool_start', id, name: str(block.name) ?? 'unknown' });
        }
      }
    }
    return out;
  }

  #user(msg: Rec): DriverEvent[] {
    // On resume the CLI can echo the old conversation; none of it happened this turn.
    if ('isReplay' in msg) return [];
    // A tool result never opens a turn, and one that belongs to no turn of ours is not ours.
    if (!this.#owns(msg, false)) return [];
    const message: unknown = msg.message;
    const content: unknown = isRec(message) ? message.content : undefined;
    if (!Array.isArray(content)) return [];
    const out: DriverEvent[] = [];
    for (const block of content as unknown[]) {
      if (!isRec(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      // An id that is not open was never announced or already ended; a tool_end for it
      // would only let a consumer's running count go wrong.
      if (id === undefined || !this.#settle(id)) continue;
      out.push({ k: 'tool_end', id, ok: block.is_error !== true });
    }
    return out;
  }

  #result(msg: Rec): AdapterEvent[] {
    // The typings give a result no parent, but the invariant is too important to rest on
    // that: a subagent's result must never be taken for the end of the user's turn.
    if (isSub(msg.parent_tool_use_id)) return [];

    // The saved session is gone: no frames, no stamp, and the prompt never ran. The driver
    // starts over on a fresh session instead of reporting a failure.
    if (this.#bound && this.#expected !== undefined && this.#turn === 'idle' && isStaleResume(msg)) {
      return [{ k: 'resume_failed' }];
    }

    if (!this.#bound) {
      // Unjudged: every result is the answer.
    } else if (!this.#isOurResult(msg)) {
      this.#turn = 'idle';
      return [{ k: 'foreign_result' }];
    }
    this.#turn = 'idle';
    this.#expected = undefined;

    // The turn is over, so nothing can still be running; say so before saying it is done.
    const out: AdapterEvent[] = this.abandon();
    const subtype = str(msg.subtype) ?? 'unknown';
    const reason = str(msg.terminal_reason);
    if (reason === 'aborted_streaming' || reason === 'aborted_tools') {
      // The CLI reports a stop, whoever asked for it, as an error result. To the owner it is
      // "Stopped.", not "Something went wrong."; the diagnostic in `errors` is not for them.
      out.push({ k: 'result', ok: false, text: '', subtype: 'interrupted' });
    } else if (subtype === 'success') {
      out.push({
        k: 'result',
        ok: msg.is_error !== true,
        text: typeof msg.result === 'string' ? msg.result : '',
        subtype,
      });
    } else {
      // error_max_turns, error_during_execution, ... and any subtype added later: a result
      // is terminal whatever it is called. The CLI's own short sentence is the text; the
      // server falls back to a generic one when there is none.
      out.push({ k: 'result', ok: false, text: errorText(msg), subtype });
    }
    return out;
  }

  /**
   * Is this result the answer to the prompt in flight? It is when its stamps name it, or when
   * it has none but the turn so far was ours. A result with neither a stamp nor any frame is
   * only ours if it is the zeroed error the CLI writes for a turn that never ran.
   */
  #isOurResult(msg: Rec): boolean {
    if (this.#expected === undefined) return false;
    const stamps = stampsOf(msg);
    if (stamps !== undefined) return stamps.includes(this.#expected);
    if (this.#turn === 'ours') return true;
    return this.#turn === 'idle' && isZeroedError(msg);
  }
}
