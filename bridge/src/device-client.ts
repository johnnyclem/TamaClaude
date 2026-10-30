/**
 * A typed stand-in for the handheld's side of the protocol, used by the end-to-end test
 * AND by the interactive fake-device CLI, so the thing the tests exercise is the thing a
 * person types into.
 *
 * It is strict on purpose. The device it imitates has a 1 KB receive buffer and a font with
 * no glyphs beyond ASCII, so everything the bridge sends is decoded with the same strict
 * decoder the firmware will implement, and what that finds is RECORDED, not thrown:
 *
 *  - a frame that is not printable ASCII, or does not decode, or is not what the bridge may
 *    send;
 *  - a `state` whose `seq` is not exactly one more than the last (and one after the
 *    handshake), or that repeats the previous one's content (the bridge promises a state
 *    only when something changed);
 *  - an `ask` while another is still open (the promise is one at a time).
 *
 * Recording rather than throwing keeps a violation from being swallowed by whichever
 * promise it happened to reject; `assertClean()` turns the record into a failure, and the
 * e2e harness calls it for every client of every test, so no test can forget.
 *
 * Waiting is event-driven. `waitFor` resolves the moment a matching message is in the
 * transcript (including one that arrived before the call) and its timeout exists only to
 * turn a hang into a diagnosis.
 */

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { RawData } from 'ws';
import { decodeAudioFrame, decodeBridgeMsg, encodeAudioFrame, encodeDeviceMsg } from './protocol.ts';
import { AUDIO, FRAME_KIND_MIC, FRAME_KIND_TTS, PROTOCOL_VERSION } from './types.ts';
import type { AskMsg, BridgeMsg, DeviceMsg, HelloAckMsg, HelloMsg, HelloWhy } from './types.ts';

export interface DeviceClientOptions {
  dev?: string;
  fw?: string;
  /** Answer the bridge's WebSocket pings. Off, the bridge sees a half-open socket. Default on. */
  autoPong?: boolean;
  /** How long to wait for the socket to open. */
  openTimeoutMs?: number;
  /** For tests: change fields of the hello (a wrong version, wrong audio parameters). */
  hello?: Partial<HelloMsg>;
}

export interface CloseInfo {
  code: number;
  reason: string;
}

/** The bridge answered the hello with `ok: false`. */
export class HelloRefused extends Error {
  readonly why: HelloWhy;
  readonly closeCode: number | undefined;
  constructor(why: HelloWhy, closeCode: number | undefined) {
    super(`the bridge refused the hello: ${why}`);
    this.name = 'HelloRefused';
    this.why = why;
    this.closeCode = closeCode;
  }
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const DEFAULT_WAIT_MS = 3000;

function toBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

/** A short, safe rendering of a message for failure diagnostics. */
export function describeMsg(m: BridgeMsg): string {
  switch (m.t) {
    case 'state':
      return `state#${m.seq} ${m.ph}${m.tl ? `:${m.tl}` : ''} pend=${m.pend}`;
    case 'ask':
      return `ask ${m.id} ${m.risk} ${m.tl} ttl=${m.ttl}`;
    case 'ask_end':
      return `ask_end ${m.id} ${m.why}`;
    case 'result':
      return `result ${m.ok ? 'ok' : 'fail'}`;
    case 'err':
      return `err ${m.code}`;
    case 'hello_ack':
      return m.ok ? 'hello_ack ok' : `hello_ack ${m.why}`;
    case 'stt':
      return 'stt';
    case 'pong':
      return `pong ${m.n}`;
  }
}

export class DeviceClient extends EventEmitter {
  /** Every decoded message the bridge sent, in order. */
  readonly transcript: BridgeMsg[] = [];
  /** The exact text of every text frame, in order. */
  readonly rawFrames: string[] = [];
  /** Wire-rule violations by the BRIDGE; see the file comment. Empty means clean. */
  readonly protocolErrors: string[] = [];
  /** Binary (TTS) frames received. Version 1 sends none. */
  binaryFrames = 0;
  /** WebSocket pings received from the bridge. */
  pings = 0;
  closed: CloseInfo | undefined;
  ack: HelloAckMsg | undefined;
  /** The ask the bridge has presented and not ended, if any. */
  openAsk: AskMsg | undefined;

  readonly #ws: WebSocket;
  readonly #opts: DeviceClientOptions;
  #cursor = 0;
  #lastSeq = 0;
  #lastState: BridgeMsg | undefined;
  #syncN = 0;
  #waiters = new Set<() => void>();

  private constructor(ws: WebSocket, opts: DeviceClientOptions) {
    super();
    this.#ws = ws;
    this.#opts = opts;
    ws.on('message', (data, isBinary) => this.#onFrame(data, isBinary));
    ws.on('ping', () => {
      this.pings += 1;
      this.#wake();
    });
    ws.on('close', (code, reason) => {
      this.closed = { code, reason: reason.toString('utf8') };
      this.emit('close', this.closed);
      this.#wake();
    });
    // A refused connection or a reset surfaces through open()/waitClosed(); an unhandled
    // 'error' event would otherwise crash the process.
    ws.on('error', () => {});
  }

  /** Opens the socket and sends nothing. For tests of the handshake itself. */
  static open(url: string, opts: DeviceClientOptions = {}): Promise<DeviceClient> {
    const ws = new WebSocket(url, {
      autoPong: opts.autoPong ?? true,
      perMessageDeflate: false,
      handshakeTimeout: opts.openTimeoutMs ?? 5000,
    });
    const client = new DeviceClient(ws, opts);
    return new Promise<DeviceClient>((resolve, reject) => {
      ws.once('open', () => resolve(client));
      ws.once('error', (err) => reject(err));
    });
  }

  /** Opens the socket, says hello, and resolves once the bridge accepted it. */
  static async connect(url: string, token: string, opts: DeviceClientOptions = {}): Promise<DeviceClient> {
    const client = await DeviceClient.open(url, opts);
    client.hello(token);
    const ack = await client.waitFor((m): m is HelloAckMsg => m.t === 'hello_ack', DEFAULT_WAIT_MS);
    if (!ack.ok) {
      const closed = await client.waitClosed(DEFAULT_WAIT_MS).catch(() => undefined);
      throw new HelloRefused(ack.why, closed?.code);
    }
    return client;
  }

  /** The underlying socket, for tests that need to do something a client should not. */
  get socket(): WebSocket {
    return this.#ws;
  }

  get isOpen(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  hello(token: string): void {
    this.send({
      t: 'hello',
      v: PROTOCOL_VERSION,
      token,
      dev: this.#opts.dev ?? 'fake-device',
      fw: this.#opts.fw ?? '0.0.0',
      rate: AUDIO.rate,
      bits: AUDIO.bits,
      ch: AUDIO.channels,
      ...this.#opts.hello,
    });
  }

  send(m: DeviceMsg): void {
    this.sendRaw(encodeDeviceMsg(m));
  }

  /** Any text at all, valid or not. */
  sendRaw(text: string): void {
    this.#ws.send(text);
  }

  sendBinary(data: Uint8Array): void {
    this.#ws.send(data);
  }

  say(text: string): void {
    this.send({ t: 'say', text });
  }

  listen(m: 'start' | 'stop' | 'cancel'): void {
    this.send({ t: 'listen', m });
  }

  answer(id: string, ok: boolean): void {
    this.send({ t: 'ask_rsp', id, ok });
  }

  abort(): void {
    this.send({ t: 'abort' });
  }

  ping(n: number): void {
    this.send({ t: 'ping', n });
  }

  /** One MIC frame. */
  sendAudio(pcm: Uint8Array): void {
    this.sendBinary(encodeAudioFrame(FRAME_KIND_MIC, pcm));
  }

  /**
   * `frames` frames of a quiet 440 Hz tone, `frameBytes` each (640 is 20 ms). A tone, not
   * silence, so a real recognizer behind this has something to chew on in a manual demo.
   */
  static pcmBurst(frames: number, frameBytes = 640): Buffer[] {
    const out: Buffer[] = [];
    let n = 0;
    for (let f = 0; f < frames; f++) {
      const b = Buffer.alloc(frameBytes);
      for (let i = 0; i + 1 < frameBytes; i += 2) {
        b.writeInt16LE(Math.round(6000 * Math.sin((2 * Math.PI * 440 * n++) / AUDIO.rate)), i);
      }
      out.push(b);
    }
    return out;
  }

  /** Sends a burst inside an open listen window; does not start or stop it. */
  sendPcm(frames: number, frameBytes = 640): void {
    for (const b of DeviceClient.pcmBurst(frames, frameBytes)) this.sendAudio(b);
  }

  /** A whole push-to-talk utterance: start, audio, stop. */
  speak(frames = 25, frameBytes = 640): void {
    this.listen('start');
    this.sendPcm(frames, frameBytes);
    this.listen('stop');
  }

  // ---------------------------------------------------------------------------
  // Receiving
  // ---------------------------------------------------------------------------

  #onFrame(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.binaryFrames += 1;
      const dec = decodeAudioFrame(toBuffer(data));
      if (!dec.ok) this.#violation(`bad binary frame: ${dec.msg}`);
      else if (dec.msg.kind !== FRAME_KIND_TTS) this.#violation('binary frame of the wrong direction');
      this.#wake();
      return;
    }
    const raw = toBuffer(data).toString('utf8');
    this.rawFrames.push(raw);
    if (!PRINTABLE_ASCII.test(raw)) this.#violation('a text frame is not printable ASCII');
    const dec = decodeBridgeMsg(raw);
    if (!dec.ok) {
      this.#violation(`undecodable frame: ${dec.msg}`);
      this.#wake();
      return;
    }
    const m = dec.msg;
    this.#check(m);
    this.transcript.push(m);
    if (m.t === 'hello_ack') this.ack = m;
    if (m.t === 'ask') this.openAsk = m;
    else if (m.t === 'ask_end' && this.openAsk?.id === m.id) this.openAsk = undefined;
    this.emit('msg', m);
    this.#wake();
  }

  /** The promises the bridge makes about ordering and repetition, checked as frames arrive. */
  #check(m: BridgeMsg): void {
    if (m.t === 'state') {
      if (m.seq !== this.#lastSeq + 1) this.#violation(`state seq ${m.seq} after ${this.#lastSeq}`);
      this.#lastSeq = m.seq;
      const p = this.#lastState;
      if (p?.t === 'state' && p.ph === m.ph && p.tl === m.tl && p.pend === m.pend) {
        this.#violation(`state repeated: ${describeMsg(m)}`);
      }
      this.#lastState = m;
      // The wire must not contradict itself: `pend` counts open asks, and the bridge ends an ask
      // (ask_end) before it reports the count without it, so "none open" with an ask still on
      // the screen means the device would be told it is idle while an approval waits on it.
      if (m.pend === 0 && this.openAsk !== undefined) {
        this.#violation(`state says no ask is open (pend 0) while ask ${this.openAsk.id} is still on the panel`);
      }
    } else if (m.t === 'ask') {
      if (this.openAsk !== undefined && this.openAsk.id !== m.id) {
        this.#violation(`ask ${m.id} presented while ${this.openAsk.id} is still open`);
      }
    }
  }

  #violation(what: string): void {
    this.protocolErrors.push(what);
    this.emit('protocol_error', what);
  }

  /** Throws if the bridge broke a wire rule at any point so far. */
  assertClean(): void {
    if (this.protocolErrors.length > 0) {
      throw new Error(`the bridge broke the protocol: ${this.protocolErrors.join('; ')}`);
    }
  }

  #wake(): void {
    for (const w of [...this.#waiters]) w();
  }

  /** Move the read cursor of `waitFor` back to `to` (the start by default), to re-read the transcript. */
  rewind(to = 0): void {
    this.#cursor = to;
  }

  /** Index into `transcript` for "everything from now on" (see `since`). */
  mark(): number {
    return this.transcript.length;
  }

  since(mark: number): BridgeMsg[] {
    return this.transcript.slice(mark);
  }

  /**
   * Resolves with `check()` as soon as it returns something other than undefined. Rejects
   * on timeout, or if the connection closes first, saying what had arrived.
   */
  #until<T>(check: () => T | undefined, ms: number, what: string): Promise<T> {
    const first = check();
    if (first !== undefined) return Promise.resolve(first);
    return new Promise<T>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(`timed out after ${ms} ms waiting for ${what}; received: ${this.#tail()}`));
      }, ms);
      const waiter = (): void => {
        const v = check();
        if (v !== undefined) {
          done();
          resolve(v);
        } else if (this.closed !== undefined) {
          done();
          reject(new Error(`the connection closed (${this.closed.code}) while waiting for ${what}; received: ${this.#tail()}`));
        }
      };
      this.#waiters.add(waiter);
    });
  }

  #tail(): string {
    const t = this.transcript.slice(-8).map(describeMsg);
    return t.length === 0 ? '(nothing)' : t.join(' | ');
  }

  /**
   * The next message at or after the cursor that satisfies `pred`; the cursor then moves
   * just past it, so successive calls read the transcript like a stream. Messages skipped
   * over stay in `transcript`.
   */
  waitFor<T extends BridgeMsg>(pred: (m: BridgeMsg) => m is T, ms?: number): Promise<T>;
  waitFor(pred: (m: BridgeMsg) => boolean, ms?: number): Promise<BridgeMsg>;
  waitFor(pred: (m: BridgeMsg) => boolean, ms: number = DEFAULT_WAIT_MS): Promise<BridgeMsg> {
    return this.#until(
      () => {
        for (let i = this.#cursor; i < this.transcript.length; i++) {
          const m = this.transcript[i]!;
          if (pred(m)) {
            this.#cursor = i + 1;
            return m;
          }
        }
        return undefined;
      },
      ms,
      'a matching message',
    );
  }

  /** Waits for a `state` with this phase (and, if given, this label). */
  waitForPhase(ph: string, tl?: string, ms?: number): Promise<BridgeMsg> {
    return this.waitFor((m) => m.t === 'state' && m.ph === ph && (tl === undefined || m.tl === tl), ms);
  }

  /**
   * A barrier: when this resolves, everything the bridge sent BEFORE it handled our ping
   * has arrived. It reads nothing from the cursor, so a test can then assert on exactly
   * what came, which is how "nothing else happened" is checked without sleeping.
   */
  async sync(ms: number = DEFAULT_WAIT_MS): Promise<void> {
    const n = ++this.#syncN;
    this.ping(n);
    await this.#until(() => this.transcript.find((m) => m.t === 'pong' && m.n === n), ms, `pong ${n}`);
  }

  /** Resolves once the bridge has sent at least `n` WebSocket pings (the keepalive heartbeat). */
  async waitForPings(n: number, ms: number = DEFAULT_WAIT_MS): Promise<void> {
    await this.#until(() => (this.pings >= n ? true : undefined), ms, `${n} pings from the bridge`);
  }

  waitClosed(ms: number = DEFAULT_WAIT_MS): Promise<CloseInfo> {
    return this.#until(() => this.closed, ms, 'the connection to close');
  }

  /** Every message from the cursor on, then waiting for more, until the connection closes. */
  async *messages(): AsyncGenerator<BridgeMsg, void, undefined> {
    for (;;) {
      const m = this.transcript[this.#cursor];
      if (m !== undefined) {
        this.#cursor += 1;
        yield m;
        continue;
      }
      if (this.closed !== undefined) return;
      await new Promise<void>((resolve) => {
        const w = (): void => {
          this.#waiters.delete(w);
          resolve();
        };
        this.#waiters.add(w);
      });
    }
  }

  /** Close politely and wait for the bridge to acknowledge; a no-op when already closed. */
  async close(ms: number = DEFAULT_WAIT_MS): Promise<void> {
    if (this.closed !== undefined) return;
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.close(1000);
    await this.waitClosed(ms).catch(() => this.#ws.terminate());
  }

  /** Drop the socket with no goodbye (a Wi-Fi drop, as far as the bridge can tell). */
  terminate(): void {
    this.#ws.terminate();
  }
}
