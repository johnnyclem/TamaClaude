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
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { DriverEvent } from '../types.ts';

type Rec = Record<string, unknown>;

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

  /** How many tools are announced and not yet ended. */
  get openToolCount(): number {
    return this.#open.size;
  }

  map(msg: SDKMessage): DriverEvent[] {
    if (!isRec(msg)) return [];
    switch (msg.type) {
      case 'system':
        return msg.subtype === 'init' ? this.#init(msg.session_id) : [];
      case 'stream_event':
        return this.#stream(msg.event, msg.parent_tool_use_id);
      case 'assistant':
        return this.#assistant(msg);
      case 'user':
        return this.#user(msg);
      case 'result':
        return this.#result(msg);
      default:
        return [];
    }
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

  #result(msg: Rec): DriverEvent[] {
    // The typings give a result no parent, but the invariant is too important to rest on
    // that: a subagent's result must never be taken for the end of the user's turn.
    if (isSub(msg.parent_tool_use_id)) return [];
    // The turn is over, so nothing can still be running; say so before saying it is done.
    const out = this.abandon();
    const subtype = str(msg.subtype) ?? 'unknown';
    if (subtype === 'success') {
      out.push({
        k: 'result',
        ok: msg.is_error !== true,
        text: typeof msg.result === 'string' ? msg.result : '',
        subtype,
      });
    } else {
      // error_max_turns, error_during_execution, ... and any subtype added later: a result
      // is terminal whatever it is called, and the model produced no answer worth keeping.
      out.push({ k: 'result', ok: false, text: '', subtype });
    }
    return out;
  }
}
