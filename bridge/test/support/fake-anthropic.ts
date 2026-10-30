/**
 * A fake Anthropic Messages API, just enough for the real Claude Code CLI to hold a
 * conversation with it, so the driver can be checked against the real binary offline.
 *
 * Why it exists: the unit tests in claude-driver.test.ts run against a scripted fake of the
 * SDK's `query()`, which proves the driver keeps its OWN contract. The questions that decide
 * whether the bridge's promise is true (does an allow rule in a repository skip the device,
 * what does a tool subprocess inherit, how does an interrupt end) are answered by the CLI,
 * and only the CLI can answer them. The CLI talks to whatever ANTHROPIC_BASE_URL says, so a
 * plain `node:http` server that replays scripted server-sent-event streams is all it takes.
 *
 * It is deliberately dumb: it replays what the test scripted, in order, and records what the
 * CLI sent. It never decides anything, so a wrong answer is the test's, not the fake's.
 *
 * No dependency beyond node, no real network (it binds 127.0.0.1), no sleeping unless a
 * scripted reply asks for a delay.
 */

import { createServer } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';

/** One content block of a scripted assistant message. */
export type FakeBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; id?: string };

export const say = (text: string): FakeBlock => ({ kind: 'text', text });
export const useTool = (name: string, input: Record<string, unknown>, id?: string): FakeBlock =>
  id === undefined ? { kind: 'tool', name, input } : { kind: 'tool', name, input, id };

export interface FakeReply {
  /** HTTP status. Anything but 200 sends `errorBody` instead of a stream. */
  status?: number;
  headers?: Record<string, string>;
  /** Sent as the JSON body of a non-200 reply (the Anthropic error envelope by default). */
  errorBody?: unknown;
  /** The assistant message to stream. Default: one empty text block. */
  blocks?: FakeBlock[];
  /** Default: `tool_use` when any block is a tool, else `end_turn`. */
  stopReason?: string;
  /** Wait this long (real time) before the first byte. */
  delayMs?: number;
  /** Stream the first events, then go quiet until the request is aborted (an interrupt test). */
  hangAfterStart?: boolean;
}

export interface FakeRequest {
  /** 1-based, over every request including side requests. */
  n: number;
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  /** Parsed JSON body, or undefined when there was none or it was not JSON. */
  body: Record<string, unknown> | undefined;
  /** True when the request is the conversation itself rather than a helper call. */
  main: boolean;
  /** Set once the CLI went away before the reply finished. */
  aborted: boolean;
}

/** What answers a request. Return undefined to fall through to the default reply. */
export type FakeScript = (req: FakeRequest) => FakeReply | undefined;

const MODEL = 'claude-fake-1';

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

let msgSeq = 0;

/** The event stream for one assistant message. */
function streamFor(blocks: FakeBlock[], stopReason: string, hang: boolean): string[] {
  const id = `msg_fake_${++msgSeq}`;
  const out: string[] = [];
  out.push(
    sse('message_start', {
      type: 'message_start',
      message: {
        id,
        type: 'message',
        role: 'assistant',
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    }),
  );
  let index = 0;
  for (const b of blocks) {
    if (b.kind === 'text') {
      out.push(sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } }));
      // Two deltas, so a consumer that only reads the first one is caught.
      const mid = Math.ceil(b.text.length / 2);
      for (const piece of [b.text.slice(0, mid), b.text.slice(mid)]) {
        if (piece === '') continue;
        out.push(sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } }));
      }
    } else {
      const toolId = b.id ?? `toolu_fake_${msgSeq}_${index}`;
      out.push(
        sse('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: toolId, name: b.name, input: {} },
        }),
      );
      out.push(
        sse('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input) },
        }),
      );
    }
    if (hang && index === blocks.length - 1) return out; // no block stop, no message end: a stalled stream
    out.push(sse('content_block_stop', { type: 'content_block_stop', index }));
    index++;
  }
  out.push(
    sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    }),
  );
  out.push(sse('message_stop', { type: 'message_stop' }));
  return out;
}

export interface FakeAnthropicOptions {
  /** Answers the conversation's own requests. Helper requests always get a short text reply. */
  script?: FakeScript;
}

export class FakeAnthropic {
  /** Every request, in arrival order. */
  readonly requests: FakeRequest[] = [];
  #server: Server;
  #script: FakeScript | undefined;
  #queue: FakeReply[] = [];
  #open = new Set<ServerResponse>();
  #port = 0;

  private constructor(server: Server, script: FakeScript | undefined) {
    this.#server = server;
    this.#script = script;
  }

  static async start(opts: FakeAnthropicOptions = {}): Promise<FakeAnthropic> {
    let self!: FakeAnthropic;
    const server = createServer((req, res) => self.#handle(req, res));
    self = new FakeAnthropic(server, opts.script);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = server.address();
    self.#port = typeof addr === 'object' && addr !== null ? addr.port : 0;
    return self;
  }

  /** What to put in ANTHROPIC_BASE_URL. */
  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  /** The conversation's own requests (not helper calls), in order. */
  get mainRequests(): FakeRequest[] {
    return this.requests.filter((r) => r.main);
  }

  /** Queue replies for the next conversation requests, in order. After the queue, the default applies. */
  enqueue(...replies: FakeReply[]): void {
    this.#queue.push(...replies);
  }

  setScript(script: FakeScript | undefined): void {
    this.#script = script;
  }

  async close(): Promise<void> {
    for (const res of this.#open) res.destroy();
    this.#open.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  #handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        // not JSON: leave undefined
      }
      const url = req.url ?? '';
      // The conversation is the streamed request that carries the tool list. Title and
      // quota helpers are small, non-streamed or tool-less.
      const main =
        req.method === 'POST' &&
        url.startsWith('/v1/messages') &&
        !url.includes('count_tokens') &&
        body?.stream === true &&
        Array.isArray(body.tools) &&
        body.tools.length > 0;
      const rec: FakeRequest = {
        n: this.requests.length + 1,
        method: req.method ?? '',
        url,
        headers: req.headers,
        body,
        main,
        aborted: false,
      };
      this.requests.push(rec);
      res.on('close', () => {
        if (!res.writableEnded) rec.aborted = true;
        this.#open.delete(res);
      });
      this.#open.add(res);
      void this.#reply(rec, res);
    });
  }

  async #reply(rec: FakeRequest, res: ServerResponse): Promise<void> {
    if (!rec.url.startsWith('/v1/messages')) {
      // Telemetry, feature flags, anything else the CLI probes: succeed quietly.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (rec.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
      return;
    }
    let reply: FakeReply | undefined;
    if (rec.main) reply = this.#script?.(rec) ?? this.#queue.shift();
    reply ??= { blocks: [say(rec.main ? 'ok' : 'x')] };

    if (reply.delayMs !== undefined && reply.delayMs > 0) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;

    if (reply.status !== undefined && reply.status !== 200) {
      res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
      res.end(
        JSON.stringify(
          reply.errorBody ?? { type: 'error', error: { type: 'api_error', message: `fake error ${reply.status}` } },
        ),
      );
      return;
    }

    const blocks = reply.blocks ?? [say('')];
    const stop = reply.stopReason ?? (blocks.some((b) => b.kind === 'tool') ? 'tool_use' : 'end_turn');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...reply.headers });
    const events = streamFor(blocks, stop, reply.hangAfterStart === true);
    for (const e of events) {
      if (res.destroyed) return;
      res.write(e);
    }
    if (reply.hangAfterStart !== true) res.end();
  }
}
