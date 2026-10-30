/**
 * The bridge server: one WebSocket endpoint, one Claude session, one active device.
 *
 * This file is glue. The decisions that matter live elsewhere and are tested there: what
 * the wire looks like (protocol.ts), what a phase is (state.ts), when a tool may run
 * (approvals.ts, permission.ts) and what the panel may show (text.ts, tools.ts). What is
 * left for the server, and what the end-to-end test pins, is ORDER and OWNERSHIP:
 *
 *  - The device owns exactly one thing: the answer to the ask on its screen. `ask_rsp`
 *    with the matching id is the only road to `allow`; `say`, audio and transcripts are
 *    prompts, and a prompt is never an answer. That is a property of which functions call
 *    `approvals.answer` (one), not of anything this file checks in text.
 *  - Every connection-scoped fact (the sequence number, the last state sent, the bad-frame
 *    count, an open listen window) lives with the connection, or is dropped when the
 *    connection changes hands. A takeover must not leave the new device with the old one's
 *    half-recorded sentence, and a stale socket closing late must not look like the active
 *    device leaving.
 *  - Failing closed is the default. A throw anywhere becomes a log line and, where there
 *    is a device to tell, `err internal`; an ask with nobody to answer it is denied by the
 *    approval manager's grace timer; a turn that never ends after `abort` is ended here.
 *
 * Timers. Everything a test must be able to steer (the hello deadline, the delay after a
 * wrong token, the abort watchdog, and through the approval manager the ask lifetime and
 * the reconnect grace) runs on the injected Clock. The keepalive deliberately does not: it
 * measures a real TCP socket going quiet, which a fake clock cannot model, and a clock that
 * jumps 90 seconds to expire an ask would otherwise kill the very connection it is testing.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import { ApprovalManager } from './approvals.ts';
import type { ApprovalEvent, AskInfo } from './approvals.ts';
import { createPermissionHandler } from './permission.ts';
import { decodeAudioFrame, decodeDeviceMsg, encodeBridgeMsg } from './protocol.ts';
import { initialState, reduce, toStateMsg } from './state.ts';
import type { BridgeState, StateInput } from './state.ts';
import { loadSession, saveSession } from './store.ts';
import { SttUnavailableError, UnavailableStt } from './stt.ts';
import { sanitize, summarizeForDevice } from './text.ts';
import { AUDIO, FRAME_KIND_MIC, LIMITS, PROTOCOL_VERSION, realClock } from './types.ts';
import type {
  AskMsg,
  BridgeMsg,
  Clock,
  DeviceMsg,
  DriverEvent,
  DriverFactory,
  ErrCode,
  HelloMsg,
  HelloWhy,
  Logger,
  ResultMsg,
  SessionDriver,
  SttAdapter,
  TimerHandle,
} from './types.ts';

export interface ServerOptions {
  host: string;
  port: number;
  token: string;
  cwd: string;
  driverFactory: DriverFactory;
  stt?: SttAdapter;
  clock?: Clock;
  /** How long an ask stays open once presented. Default 90 s. */
  askTtlMs?: number;
  /** How long open asks survive with no device before they are denied. Default 15 s. */
  graceMs?: number;
  /** Ask id source; tests inject a counter. */
  newId?: () => string;
  /** Where the session id is kept between runs. Absent: nothing is saved or resumed. */
  stateDir?: string;
  log?: Logger;
  helloTimeoutMs?: number;
  authFailDelayMs?: number;
  pingIntervalMs?: number;
  deadAfterMs?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Close codes this server sends. PROTOCOL.md's table names 4001 (replaced) and 4002
 * (handshake failed); the build brief says 1008 for every refusal. The brief won, and the
 * disagreement is reported rather than papered over: this table is the one place to change.
 */
export const CLOSE = {
  goingAway: 1001,
  policy: 1008,
  tooBig: 1009,
  replaced: 4001,
} as const;

/**
 * Largest frame the socket layer admits. Above the 1024-byte device limit on purpose: between
 * LIMITS.deviceFrameMax and this the codec, not the socket, refuses a frame, and the player
 * gets a `bad_msg` they can act on instead of a dropped connection. Beyond it the socket
 * layer closes with 1009 before any of our code sees the bytes.
 */
const MAX_PAYLOAD = 2048;
/** How long a turn gets to wind down after `abort` before the server ends it itself. */
export const ABORT_GRACE_MS = 5000;
const MAX_BAD_FRAMES = 5;
/** One `not_listening` per second is a hint; one per audio frame is a flood at 50 frames a second. */
const NOT_LISTENING_GAP_MS = 1000;
/** Real time we give polite clients to answer a close frame before we stop being polite. */
const SHUTDOWN_WAIT_MS = 1000;

const DEFAULTS = {
  askTtlMs: 90_000,
  graceMs: 15_000,
  helloTimeoutMs: 5000,
  authFailDelayMs: 500,
  pingIntervalMs: 10_000,
  deadAfterMs: 25_000,
} as const;

const GENERIC_RESULT = new Map<string, string>([
  ['success', 'Done.'],
  ['interrupted', 'Stopped.'],
  ['error_max_turns', 'Hit the turn limit.'],
  ['error_max_budget_usd', 'Hit the spending limit.'],
  ['error_max_structured_output_retries', 'Could not produce an answer.'],
  ['error_during_execution', 'Something went wrong.'],
]);

/** Words for a turn that ended without any text of its own. Never empty: a blank result looks like a hang. */
function fallbackResultText(ok: boolean, subtype: unknown): string {
  const known = typeof subtype === 'string' ? GENERIC_RESULT.get(subtype) : undefined;
  if (known !== undefined) return known;
  return ok ? 'Done.' : 'That did not work.';
}

function buildResult(e: Extract<DriverEvent, { k: 'result' }>): ResultMsg {
  const ok = e.ok === true;
  const text = summarizeForDevice(typeof e.text === 'string' ? e.text : '', LIMITS.resultMax);
  return { t: 'result', ok, text: text === '' ? fallbackResultText(ok, e.subtype) : text };
}

function askMsg(a: AskInfo): AskMsg {
  return { t: 'ask', id: a.id, tl: a.label, risk: a.risk, sum: a.summary, ttl: a.ttlSec };
}

function toBuffer(d: RawData): Buffer {
  if (Buffer.isBuffer(d)) return d;
  if (Array.isArray(d)) return Buffer.concat(d);
  return Buffer.from(d);
}

/**
 * Compared as digests, not as strings: timingSafeEqual wants equal lengths, and padding or
 * early-returning on a length mismatch would tell a guesser how long the token is.
 */
function tokenMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

interface Conn {
  readonly id: number;
  readonly ws: WebSocket;
  readonly remote: string;
  /** new: waiting for hello. authing: wrong token, waiting out the delay. active: past the handshake. */
  phase: 'new' | 'authing' | 'active' | 'closed';
  /** We have started closing it; whatever else it says is ignored. */
  closing: boolean;
  helloTimer: TimerHandle | undefined;
  authTimer: TimerHandle | undefined;
  keepalive: ReturnType<typeof setInterval> | undefined;
  /** performance.now() of the last frame, ping or pong. */
  lastSeen: number;
  /** performance.now() of the last keepalive tick, to notice when the process itself stood still. */
  lastTick: number;
  seq: number;
  last: { ph: string; tl: string; pend: number } | undefined;
  badFrames: number;
  lastNotListening: number;
}

interface ListenWindow {
  chunks: Buffer[];
  bytes: number;
}

class Bridge {
  readonly #host: string;
  readonly #port: number;
  readonly #token: string;
  readonly #cwd: string;
  readonly #stateDir: string | undefined;
  readonly #clock: Clock;
  readonly #logger: Logger;
  readonly #stt: SttAdapter;
  readonly #helloTimeoutMs: number;
  readonly #authFailDelayMs: number;
  readonly #pingIntervalMs: number;
  readonly #deadAfterMs: number;

  readonly #approvals: ApprovalManager;
  readonly #driver: SessionDriver;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #conns = new Set<Conn>();

  #connSeq = 0;
  #active: Conn | undefined;
  #state: BridgeState = initialState;
  /** A prompt has gone to the driver and its terminal event has not come back. */
  #turnActive = false;
  /**
   * Terminal events the driver still owes for turns we already ended ourselves (the abort
   * watchdog). They arrive later, in order, and must not end whatever turn is running then.
   */
  #staleTerminals = 0;
  #watchdog: TimerHandle | undefined;
  #listen: ListenWindow | undefined;
  /** Bumped whenever a transcription in flight stops being wanted; a late result checks it. */
  #sttGen = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  constructor(o: ServerOptions) {
    if (typeof o.token !== 'string' || o.token.length < LIMITS.tokenMin || o.token.length > LIMITS.tokenMax) {
      throw new RangeError(`server: token must be ${LIMITS.tokenMin} to ${LIMITS.tokenMax} characters`);
    }
    this.#host = o.host;
    this.#port = o.port;
    this.#token = o.token;
    this.#cwd = o.cwd;
    this.#stateDir = o.stateDir;
    this.#clock = o.clock ?? realClock;
    this.#logger = o.log ?? (() => {});
    this.#stt = o.stt ?? new UnavailableStt();
    this.#helloTimeoutMs = o.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs;
    this.#authFailDelayMs = o.authFailDelayMs ?? DEFAULTS.authFailDelayMs;
    this.#pingIntervalMs = o.pingIntervalMs ?? DEFAULTS.pingIntervalMs;
    this.#deadAfterMs = o.deadAfterMs ?? DEFAULTS.deadAfterMs;

    this.#approvals = new ApprovalManager({
      clock: this.#clock,
      ttlMs: o.askTtlMs ?? DEFAULTS.askTtlMs,
      graceMs: o.graceMs ?? DEFAULTS.graceMs,
      ...(o.newId !== undefined ? { newId: o.newId } : {}),
      onEvent: (e) => this.#onApproval(e),
    });

    const resume = this.#stateDir === undefined ? undefined : loadSession(this.#stateDir, this.#cwd);
    this.#driver = o.driverFactory({
      cwd: this.#cwd,
      onEvent: (e) => this.#onDriver(e),
      onPermission: createPermissionHandler({
        approvals: this.#approvals,
        cwd: this.#cwd,
        log: (l) => this.#log(l),
      }),
      ...(resume !== undefined ? { resume } : {}),
      log: (l) => this.#log(l),
    });

    // Plain HTTP gets a polite refusal rather than a hang or a stack trace.
    this.#http = createServer((_req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket', connection: 'Upgrade' });
      res.end('This is the TamaClaude bridge. Connect with a WebSocket.\n');
    });
    this.#http.on('error', (err) => this.#log(`http error: ${errName(err)}`));
    this.#wss = new WebSocketServer({
      server: this.#http,
      path: '/',
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: false,
      clientTracking: false, // we keep our own set, which also holds sockets that never said hello
    });
    this.#wss.on('error', (err) => this.#log(`ws server error: ${errName(err)}`));
    this.#wss.on('connection', (ws, req) => this.#onConnection(ws, req));
  }

  async start(): Promise<RunningServer> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      this.#http.once('error', onError);
      this.#http.listen({ host: this.#host, port: this.#port }, () => {
        this.#http.off('error', onError);
        resolve();
      });
    });
    const port = (this.#http.address() as AddressInfo).port;
    const host = this.#host === '' || this.#host === '0.0.0.0' ? '127.0.0.1' : this.#host === '::' ? '::1' : this.#host;
    return {
      port,
      url: `ws://${host.includes(':') ? `[${host}]` : host}:${port}/`,
      close: () => this.close(),
    };
  }

  close(): Promise<void> {
    this.#closing ??= this.#doClose();
    return this.#closing;
  }

  // ---------------------------------------------------------------------------
  // Logging and sending
  // ---------------------------------------------------------------------------

  /** One short ASCII line. A logger that throws must not be able to take the bridge down. */
  #log(line: string): void {
    try {
      this.#logger(sanitize(line, 300));
    } catch {
      // nowhere left to report a broken logger
    }
  }

  #send(conn: Conn, msg: BridgeMsg): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    let frame: string;
    try {
      frame = encodeBridgeMsg(msg);
    } catch (err) {
      // The encoder is strict on purpose (a bad frame is a bridge bug), so a throw here means
      // some string was not sanitised or a limit was missed. The reason text names the field
      // and never the value, so it is safe to log.
      this.#log(`encode failed for ${msg.t}: ${err instanceof Error ? err.message : errName(err)}`);
      if (msg.t === 'err' && msg.code === 'internal') return;
      this.#send(conn, { t: 'err', code: 'internal', msg: 'internal error' });
      return;
    }
    conn.ws.send(frame, (err) => {
      if (err) this.#log(`send failed on conn ${conn.id}: ${errName(err)}`);
    });
  }

  #err(conn: Conn, code: ErrCode, msg: string): void {
    this.#send(conn, { t: 'err', code, msg: sanitize(msg, LIMITS.errMax) });
  }

  #close(conn: Conn, code: number, reason: string): void {
    if (conn.closing) return;
    conn.closing = true;
    try {
      conn.ws.close(code, reason);
    } catch (err) {
      this.#log(`close failed on conn ${conn.id}: ${errName(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /** Reduce one or more inputs, then tell the device once, so it never sees a half-way state. */
  #apply(...inputs: StateInput[]): void {
    let next = this.#state;
    for (const i of inputs) next = reduce(next, i);
    if (next === this.#state) return;
    this.#state = next;
    const conn = this.#active;
    if (conn !== undefined) this.#pushState(conn, false);
  }

  /**
   * What the approval manager has open RIGHT NOW, as a state input. The manager is the source
   * of truth for asks; the reducer only mirrors it, and state.ts's terminal events clear that
   * mirror, so anything that can end a turn must re-read the manager afterwards.
   */
  #asksNow(): StateInput {
    return { k: 'asks', count: this.#approvals.pendingCount(), label: this.#approvals.current()?.label ?? '' };
  }

  /**
   * A `state` message only when what the device can see changed. The reducer keeps facts
   * the device is never told (the abort flag, tool ids), so "the reducer returned a new
   * object" is not the same as "there is news".
   */
  #pushState(conn: Conn, force: boolean): void {
    const m = toStateMsg(this.#state, 0);
    const prev = conn.last;
    if (!force && prev !== undefined && prev.ph === m.ph && prev.tl === m.tl && prev.pend === m.pend) return;
    conn.seq += 1;
    conn.last = { ph: m.ph, tl: m.tl, pend: m.pend };
    this.#send(conn, { ...m, seq: conn.seq });
  }

  // ---------------------------------------------------------------------------
  // Connections and the handshake
  // ---------------------------------------------------------------------------

  #onConnection(ws: WebSocket, req: IncomingMessage): void {
    const conn: Conn = {
      id: ++this.#connSeq,
      ws,
      remote: req.socket.remoteAddress ?? '?',
      phase: 'new',
      closing: false,
      helloTimer: undefined,
      authTimer: undefined,
      keepalive: undefined,
      lastSeen: performance.now(),
      lastTick: performance.now(),
      seq: 0,
      last: undefined,
      badFrames: 0,
      lastNotListening: -Infinity,
    };
    if (this.#closed) {
      ws.close(CLOSE.goingAway, 'bridge shutting down');
      return;
    }
    this.#conns.add(conn);
    this.#log(`conn ${conn.id} opened from ${conn.remote}`);

    // Without a listener an 'error' (an oversized frame, a reset) would be an uncaught exception.
    ws.on('error', (err) => this.#log(`conn ${conn.id} socket error: ${errName(err)}`));
    ws.on('close', () => this.#onClosed(conn));
    ws.on('pong', () => {
      conn.lastSeen = performance.now();
    });
    ws.on('ping', () => {
      conn.lastSeen = performance.now();
    });
    ws.on('message', (data, isBinary) => {
      conn.lastSeen = performance.now();
      try {
        this.#onMessage(conn, data, isBinary);
      } catch (err) {
        this.#log(`conn ${conn.id} handler failed: ${errName(err)}`);
        this.#err(conn, 'internal', 'internal error');
      }
    });

    conn.helloTimer = this.#clock.setTimeout(() => {
      conn.helloTimer = undefined;
      if (conn.phase !== 'new') return;
      this.#log(`conn ${conn.id} sent no hello in time`);
      this.#close(conn, CLOSE.policy, 'hello timeout');
    }, this.#helloTimeoutMs);
  }

  #onClosed(conn: Conn): void {
    conn.phase = 'closed';
    this.#clearConnTimers(conn);
    this.#conns.delete(conn);
    this.#log(`conn ${conn.id} closed`);
    // Only the ACTIVE connection leaving is the device leaving. A socket we replaced closes
    // late, after its successor has said hello, and treating that as a disconnect would arm
    // the grace timer against an ask the new device is looking at.
    if (conn !== this.#active) return;
    this.#active = undefined;
    this.#dropListen(); // the half-recorded sentence went with the device
    if (!this.#closed) this.#approvals.deviceDisconnected();
  }

  #clearConnTimers(conn: Conn): void {
    if (conn.helloTimer !== undefined) this.#clock.clearTimeout(conn.helloTimer);
    if (conn.authTimer !== undefined) this.#clock.clearTimeout(conn.authTimer);
    if (conn.keepalive !== undefined) clearInterval(conn.keepalive);
    conn.helloTimer = undefined;
    conn.authTimer = undefined;
    conn.keepalive = undefined;
  }

  /** Answer a hello with a refusal and hang up. Says nothing about WHY beyond the three codes. */
  #refuse(conn: Conn, why: HelloWhy): void {
    this.#clearConnTimers(conn);
    this.#log(`conn ${conn.id} hello refused: ${why}`);
    this.#send(conn, { t: 'hello_ack', v: PROTOCOL_VERSION, ok: false, why });
    this.#close(conn, CLOSE.policy, 'hello refused');
  }

  #handshake(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.phase !== 'new') return; // during the delay after a wrong token nothing else is read
    if (conn.helloTimer !== undefined) this.#clock.clearTimeout(conn.helloTimer);
    conn.helloTimer = undefined;

    if (isBinary) return this.#refuse(conn, 'bad_hello');
    // Never logged or echoed from here on: the frame holds the token, and so would any error
    // that quoted it.
    const dec = decodeDeviceMsg(toBuffer(data).toString('utf8'));
    if (!dec.ok || dec.msg.t !== 'hello') return this.#refuse(conn, 'bad_hello');
    const hello = dec.msg;

    // The order is PROTOCOL.md's: version, then token, then the audio parameters. A wrong
    // token is never told about the audio, and a wrong version is told without delay because
    // it reveals nothing about the secret.
    if (hello.v !== PROTOCOL_VERSION) return this.#refuse(conn, 'version');
    if (!tokenMatches(hello.token, this.#token)) {
      conn.phase = 'authing';
      conn.authTimer = this.#clock.setTimeout(() => {
        conn.authTimer = undefined;
        this.#refuse(conn, 'token');
      }, this.#authFailDelayMs);
      return;
    }
    if (hello.rate !== AUDIO.rate || hello.bits !== AUDIO.bits || hello.ch !== AUDIO.channels) {
      return this.#refuse(conn, 'bad_hello');
    }
    this.#accept(conn, hello);
  }

  #accept(conn: Conn, hello: HelloMsg): void {
    const old = this.#active;
    // Detached before anything is dropped or sent, so the state changes below go to nobody
    // instead of to the connection that is about to be told 4001.
    this.#active = undefined;
    this.#dropListen();
    this.#active = conn;
    conn.phase = 'active';
    if (old !== undefined) {
      this.#log(`conn ${old.id} replaced by conn ${conn.id}`);
      this.#close(old, CLOSE.replaced, 'replaced');
    }
    // Idempotent when a device replaces a device: the connection never lapsed, so the
    // reconnect grace for open asks is never started.
    this.#approvals.deviceConnected();
    this.#log(`conn ${conn.id} hello ok dev=${sanitize(hello.dev, LIMITS.devMax)} fw=${sanitize(hello.fw, LIMITS.fwMax)}`);

    this.#send(conn, { t: 'hello_ack', v: PROTOCOL_VERSION, ok: true, sid: this.#sid() });
    this.#pushState(conn, true); // seq restarts at 1 on every connection
    const open = this.#approvals.current();
    if (open !== undefined) this.#send(conn, askMsg(open)); // with the time that is LEFT, not the original

    conn.keepalive = setInterval(() => this.#keepalive(conn), this.#pingIntervalMs);
  }

  #sid(): string {
    try {
      return sanitize(this.#driver.sessionId() ?? '', 64);
    } catch {
      return '';
    }
  }

  #keepalive(conn: Conn): void {
    if (conn.closing || conn.phase !== 'active') return;
    const now = performance.now();
    // A tick that arrives much later than scheduled means THIS process was not running (a laptop
    // that slept, a blocked event loop), and the device's silence in that time proves nothing:
    // its pong is queued behind us. Judging it dead would drop a healthy connection on every
    // resume, so the silence window starts again.
    if (now - conn.lastTick > 2 * this.#pingIntervalMs) {
      this.#log(`conn ${conn.id} keepalive ran late; giving the device a fresh window`);
      conn.lastSeen = now;
    }
    conn.lastTick = now;
    if (now - conn.lastSeen > this.#deadAfterMs) {
      // A half-open socket (the Wi-Fi dropped without a FIN) never closes by itself, and a
      // close frame would sit in its send buffer: terminate, do not close politely.
      this.#log(`conn ${conn.id} silent too long, dropping it`);
      conn.ws.terminate();
      return;
    }
    try {
      conn.ws.ping();
    } catch (err) {
      this.#log(`ping failed on conn ${conn.id}: ${errName(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Messages from the device
  // ---------------------------------------------------------------------------

  #onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.phase === 'new' || conn.phase === 'authing') return this.#handshake(conn, data, isBinary);
    // A replaced socket can still deliver bytes while its close handshake completes. Only the
    // active connection may speak: this is what stops a stale device from answering an ask.
    if (conn !== this.#active || conn.closing) return;

    if (isBinary) return this.#onAudio(conn, toBuffer(data));

    const dec = decodeDeviceMsg(toBuffer(data).toString('utf8'));
    if (!dec.ok) return this.#badFrame(conn, dec.msg);
    this.#onDeviceMsg(conn, dec.msg);
  }

  #badFrame(conn: Conn, reason: string): void {
    conn.badFrames += 1;
    this.#log(`conn ${conn.id} bad frame (${conn.badFrames}/${MAX_BAD_FRAMES}): ${reason}`);
    this.#err(conn, 'bad_msg', reason);
    if (conn.badFrames >= MAX_BAD_FRAMES) this.#close(conn, CLOSE.policy, 'too many bad frames');
  }

  #onDeviceMsg(conn: Conn, m: DeviceMsg): void {
    if (m.t === 'hello') return this.#badFrame(conn, 'hello sent twice');
    conn.badFrames = 0; // the run of bad frames is broken by any good one
    switch (m.t) {
      case 'say':
        return this.#onSay(conn, m.text);
      case 'listen':
        return this.#onListen(conn, m.m);
      case 'ask_rsp':
        // THE ONLY CALL TO answer() IN THE BRIDGE. Nothing below this line is reachable from a
        // `say`, from audio, or from a transcript.
        if (this.#approvals.answer(m.id, m.ok) === 'unknown') this.#err(conn, 'unknown_ask', 'no open ask with that id');
        return;
      case 'abort':
        return this.#onAbort();
      case 'ping':
        return this.#send(conn, { t: 'pong', n: m.n });
    }
  }

  /** Something is already using the input: a turn, an open listen window, or a transcription. */
  #inputBusy(): boolean {
    return this.#turnActive || this.#state.base === 'listening' || this.#state.base === 'transcribing';
  }

  #onSay(conn: Conn, text: string): void {
    if (this.#inputBusy()) return this.#err(conn, 'busy', 'a turn is already running');
    // The text is used as it came. Only a prompt with nothing in it is refused: an empty
    // user message is an error in the real SDK and says nothing to a fake one.
    if (text.trim() === '') return this.#err(conn, 'empty', 'nothing to say');
    this.#startTurn(text, false);
  }

  #startTurn(text: string, dictated: boolean): void {
    this.#turnActive = true;
    if (dictated) this.#apply({ k: 'stt_done' });
    this.#apply({ k: 'prompt_sent' });
    try {
      this.#driver.prompt(text);
    } catch (err) {
      this.#log(`driver refused the prompt: ${errName(err)}`);
      this.#finishTurn({ k: 'fatal', msg: 'The Claude session could not take the prompt.' });
    }
  }

  // ---------------------------------------------------------------------------
  // Push to talk
  // ---------------------------------------------------------------------------

  #onListen(conn: Conn, mode: 'start' | 'stop' | 'cancel'): void {
    switch (mode) {
      case 'start':
        // A second `start` inside a window is a restart, not an error: the device may have
        // lost track of whether it was listening, and starting over is what it asked for.
        if (this.#turnActive || this.#state.base === 'transcribing') return this.#err(conn, 'busy', 'a turn is already running');
        this.#listen = { chunks: [], bytes: 0 };
        this.#apply({ k: 'listen_start' });
        if (this.#state.base !== 'listening') {
          this.#listen = undefined; // the state machine would not open a window: do not hold audio for one
          return this.#err(conn, 'busy', 'cannot listen now');
        }
        return;
      case 'stop': {
        const win = this.#listen;
        if (win === undefined) return this.#err(conn, 'not_listening', 'no listen window is open');
        this.#listen = undefined;
        const gen = ++this.#sttGen;
        this.#apply({ k: 'listen_stop' });
        void this.#transcribe(conn, gen, Buffer.concat(win.chunks, win.bytes));
        return;
      }
      case 'cancel':
        // Cancelling nothing is fine; cancelling a transcription in flight abandons its result.
        this.#dropListen();
        return;
    }
  }

  /** Forget the audio, abandon any transcription in flight, and stop being in a listen phase. */
  #dropListen(): void {
    this.#listen = undefined;
    this.#sttGen += 1;
    this.#apply({ k: 'listen_cancel' });
  }

  #onAudio(conn: Conn, frame: Buffer): void {
    const dec = decodeAudioFrame(frame);
    if (!dec.ok) return this.#badFrame(conn, dec.msg);
    // Direction is part of the rule and the decoder cannot see it: a device sends MIC only.
    if (dec.msg.kind !== FRAME_KIND_MIC) return this.#badFrame(conn, 'audio: wrong direction');
    conn.badFrames = 0;

    const win = this.#listen;
    if (win === undefined || this.#state.base !== 'listening') {
      const now = this.#clock.now();
      if (now - conn.lastNotListening >= NOT_LISTENING_GAP_MS) {
        conn.lastNotListening = now;
        this.#err(conn, 'not_listening', 'no listen window is open');
      }
      return;
    }
    const pcm = dec.msg.pcm;
    if (win.bytes + pcm.length > LIMITS.utteranceMaxBytes) {
      this.#dropListen();
      this.#err(conn, 'too_long', 'utterance is too long');
      return;
    }
    win.chunks.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length));
    win.bytes += pcm.length;
  }

  /** Still the transcription somebody wants: same device, not cancelled, not shut down. */
  #sttWanted(conn: Conn, gen: number): boolean {
    return !this.#closed && gen === this.#sttGen && conn === this.#active && this.#state.base === 'transcribing';
  }

  async #transcribe(conn: Conn, gen: number, pcm: Buffer): Promise<void> {
    let transcript: unknown;
    try {
      transcript = await this.#stt.transcribe(pcm);
    } catch (err) {
      if (!this.#sttWanted(conn, gen)) return;
      const unavailable = err instanceof SttUnavailableError;
      this.#log(`speech to text ${unavailable ? 'unavailable' : `failed (${errName(err)})`}`);
      this.#endListen(conn, unavailable ? 'stt_unavailable' : 'stt_failed', unavailable ? 'speech to text is not set up' : 'speech to text failed');
      return;
    }
    if (!this.#sttWanted(conn, gen)) return;
    if (typeof transcript !== 'string') {
      this.#log('speech to text returned something that is not text');
      this.#endListen(conn, 'stt_failed', 'speech to text failed');
      return;
    }
    const original = transcript.trim();
    const shown = sanitize(original, LIMITS.sttMax);
    if (original === '' || shown === '') return this.#endListen(conn, 'empty', 'nothing was heard');

    // The panel gets the folded copy; Claude gets what was actually said, accents and all.
    this.#send(conn, { t: 'stt', text: shown });
    this.#startTurn(original, true);
  }

  /** A listen attempt that produced no prompt: say why and rest. */
  #endListen(conn: Conn, code: ErrCode, msg: string): void {
    this.#err(conn, code, msg);
    this.#apply({ k: 'listen_cancel' });
  }

  // ---------------------------------------------------------------------------
  // Events from the approval manager
  // ---------------------------------------------------------------------------

  #onApproval(e: ApprovalEvent): void {
    try {
      const conn = this.#active;
      switch (e.k) {
        case 'ask':
          // With nobody connected there is nobody to show it to; the reconnect replays it.
          if (conn !== undefined) this.#send(conn, askMsg(e.ask));
          return;
        case 'end':
          if (conn !== undefined) this.#send(conn, { t: 'ask_end', id: e.id, why: e.why });
          return;
        case 'pending':
          this.#apply(this.#asksNow());
          return;
      }
    } catch (err) {
      this.#log(`approval event failed: ${errName(err)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Events from the Claude session
  // ---------------------------------------------------------------------------

  #onDriver(e: DriverEvent): void {
    if (this.#closed) return; // the consumer that closed a driver has stopped listening
    try {
      switch (e.k) {
        case 'session':
          this.#saveSession(e.id);
          return;
        case 'text':
          return; // narration is for logs, and logs do not get model output
        case 'tool_start':
        case 'tool_end':
          this.#apply(e);
          return;
        case 'result':
        case 'fatal':
          this.#onTerminal(e);
          return;
      }
    } catch (err) {
      this.#log(`driver event ${e.k} failed: ${errName(err)}`);
    }
  }

  #saveSession(id: string): void {
    if (this.#stateDir === undefined) return;
    try {
      saveSession(this.#stateDir, this.#cwd, id);
    } catch (err) {
      // Losing the id costs a conversation on the next restart; it must not cost the turn.
      this.#log(`could not save the session id: ${errName(err)}`);
    }
  }

  #onTerminal(e: Extract<DriverEvent, { k: 'result' | 'fatal' }>): void {
    if (this.#staleTerminals > 0) {
      this.#staleTerminals -= 1;
      this.#log('ignored the late ending of a turn that was already stopped');
      return;
    }
    if (!this.#turnActive) {
      this.#log(`ignored a ${e.k} with no turn running`);
      return;
    }
    this.#finishTurn(e);
  }

  /** The turn is over, by the driver's word or ours. Exactly once per turn. */
  #finishTurn(e: Extract<DriverEvent, { k: 'result' | 'fatal' }>): void {
    this.#turnActive = false;
    if (this.#watchdog !== undefined) this.#clock.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;

    const conn = this.#active;
    if (e.k === 'result') {
      if (conn !== undefined) this.#send(conn, buildResult(e));
    } else if (conn !== undefined) {
      this.#err(conn, 'driver', sanitize(typeof e.msg === 'string' ? e.msg : '', LIMITS.errMax) || 'the Claude session failed');
    }
    // An ask can outlive the turn that raised it (a background task asking after the result).
    // It is still open and still answerable, so the panel keeps showing it; the terminal event
    // would otherwise have wiped it from the state while it stayed on the device's screen.
    this.#apply(e, this.#asksNow());
    // done and error last until told otherwise, and the pet should rest again.
    this.#apply({ k: 'settle' });
  }

  // ---------------------------------------------------------------------------
  // Abort
  // ---------------------------------------------------------------------------

  #onAbort(): void {
    if (!this.#turnActive) return; // nothing to stop is not an error
    this.#apply({ k: 'aborted' }); // before the cancellations, so the ending that follows reads as a stop
    this.#approvals.cancelAll('abort');
    if (this.#watchdog === undefined) {
      this.#watchdog = this.#clock.setTimeout(() => this.#onWatchdog(), ABORT_GRACE_MS);
    }
    try {
      this.#driver.interrupt().catch((err: unknown) => this.#log(`interrupt failed: ${errName(err)}`));
    } catch (err) {
      this.#log(`interrupt failed: ${errName(err)}`);
    }
  }

  /**
   * The driver promised a terminal event after `interrupt()` and did not deliver. The
   * device must not sit in `thinking` because of that, so the turn is ended here. The
   * driver still owes its real ending; `#staleTerminals` makes sure it is swallowed when it
   * comes instead of ending a later turn early.
   */
  #onWatchdog(): void {
    this.#watchdog = undefined;
    if (!this.#turnActive) return;
    this.#log('the session did not stop in time; ending the turn here');
    this.#staleTerminals += 1;
    this.#finishTurn({ k: 'result', ok: false, text: '', subtype: 'interrupted' });
  }

  // ---------------------------------------------------------------------------
  // Shutdown
  // ---------------------------------------------------------------------------

  async #doClose(): Promise<void> {
    this.#closed = true;
    if (this.#watchdog !== undefined) this.#clock.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    for (const c of this.#conns) this.#clearConnTimers(c);

    // Stop accepting first. The callback fires when the last connection is gone.
    const httpClosed = new Promise<void>((resolve) => {
      if (!this.#http.listening) return resolve();
      this.#http.close(() => resolve());
    });
    this.#wss.close();

    // Open asks end before the sockets do, so the device hears them end. A second pass after
    // the driver is closed catches a request that slipped in while it was winding down.
    this.#cancelAsks();
    const sockets = [...this.#conns].map((c) => c.ws);
    for (const c of this.#conns) this.#close(c, CLOSE.goingAway, 'bridge shutting down');
    try {
      await this.#driver.close();
    } catch (err) {
      this.#log(`driver close failed: ${errName(err)}`);
    }
    this.#cancelAsks();

    // Real time, not the injected clock: this is a transport courtesy, and it must end even
    // when a test's fake clock never moves.
    await Promise.all(sockets.map((ws) => this.#closedOrTerminated(ws)));
    this.#http.closeAllConnections();
    await httpClosed;
  }

  #cancelAsks(): void {
    try {
      this.#approvals.cancelAll('abort');
    } catch (err) {
      this.#log(`cancelling asks failed: ${errName(err)}`);
    }
  }

  #closedOrTerminated(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, SHUTDOWN_WAIT_MS);
      ws.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const bridge = new Bridge(opts);
  try {
    return await bridge.start();
  } catch (err) {
    // A port that is taken must not leave a driver (and its child process) running.
    await bridge.close().catch(() => {});
    throw err;
  }
}
