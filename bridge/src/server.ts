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
 *  - A dictated transcript is shown, never run. After `listen stop` the server sends `stt`
 *    and rests at `idle`; the player's SEND tap makes the device send a `say`, and only that
 *    starts a turn. Ambient audio therefore cannot become a prompt that runs before anyone
 *    read it.
 *  - Only the authenticated, active connection is ever sent a frame (`#send` refuses every
 *    other); the one thing a connection that has not passed the handshake can receive is
 *    the refusal itself, through `#sendRefusal`, which can say nothing else.
 *  - Every connection-scoped fact (the sequence number, the last state sent, the bad-frame
 *    count, an open listen window) lives with the connection, or is dropped when the
 *    connection changes hands. A takeover must not leave the new device with the old one's
 *    half-recorded sentence, and a stale socket closing late must not look like the active
 *    device leaving.
 *  - Failing closed is the default. A throw anywhere becomes a log line and, where there
 *    is a device to tell, `err internal`; an ask with nobody to answer it is denied by the
 *    approval manager's grace timer; a turn that never ends after `abort` is ended here.
 *
 * ADMISSION. Who may even become a connection is decided before any WebSocket exists, in
 * this order, and each step costs the bridge almost nothing:
 *  1. at the TCP level: a global and a per-address cap on live sockets, and no socket at all
 *     for an address that is locked out after failed hellos;
 *  2. in the HTTP layer: the upgrade request must complete within a few seconds (a socket
 *     that never speaks costs one socket and no timer of ours);
 *  3. at the upgrade: the path is `/`, there is no `Origin` header (a browser always sends
 *     one, a device never does, so a web page cannot use the bridge as a stepping stone),
 *     and, unless `allowLocalDevice` is set, the peer is not this machine. That last rule
 *     exists because the model's own tool subprocesses run on this machine: with the token
 *     and a loopback socket they could connect as the device and approve their own asks.
 *
 * TIMERS. Everything a test must be able to steer (the hello deadline, the delay after a
 * wrong token, the abort watchdog, and through the approval manager the ask lifetime and
 * the reconnect grace) runs on the injected Clock. The keepalive runs on its own clock
 * (`keepaliveClock`, real and monotonic by default): it measures a real TCP socket going
 * quiet, and a test clock that jumps 90 seconds to expire an ask must not kill the very
 * connection it is testing. A test that needs the keepalive's real timings gives it a clock
 * of its own.
 */

import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { networkInterfaces } from 'node:os';
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
import { AUDIO, CLOSE, FRAME_KIND_MIC, LIMITS, PROTOCOL_VERSION, realClock } from './types.ts';
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
  PermissionHandler,
  ResultMsg,
  SessionDriver,
  SttAdapter,
  TimerHandle,
} from './types.ts';

/** Numbers that bound what an unauthenticated or misbehaving peer can cost. All overridable for tests. */
export interface ServerLimits {
  /** Live sockets of any kind, from anyone. */
  maxConnections: number;
  /** Live sockets from one address. */
  maxConnectionsPerAddress: number;
  /** How long a socket gets to finish its HTTP upgrade request. */
  headersTimeoutMs: number;
  /** Failed hellos from one address before it starts being locked out. */
  authFreeFailures: number;
  /** The first lockout; each further failure doubles it. */
  authLockoutBaseMs: number;
  authLockoutMaxMs: number;
  /** An address with no failure for this long is forgotten. */
  authForgetMs: number;
  /** Bytes queued for a device that is not reading, beyond which it is dropped. */
  maxBufferedBytes: number;
  /** Asks open at once (presented plus waiting); the next one is refused without asking. */
  maxOpenAsks: number;
}

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
  /** How often the keepalive looks at a connection. A silent device is dropped at the first look after `deadAfterMs`. */
  keepaliveCheckMs?: number;
  /**
   * A listen window that receives no audio for this long is closed by the bridge (`err` `empty`, then
   * `idle`). Without it a microphone that never delivers a frame would leave the bridge `listening`, and
   * every `say` answered `busy`, for as long as the device's pongs keep the connection alive.
   */
  listenIdleMs?: number;
  deadAfterMs?: number;
  /** The keepalive's time source. Default: the real monotonic clock. */
  keepaliveClock?: Clock;
  /**
   * Accept a device whose peer address is this machine's own (loopback, or one of its
   * interface addresses). Default false: the model's commands run here, and a process that
   * knows the token could otherwise connect as the device and approve its own asks. Fake
   * mode and the emulator set it.
   */
  allowLocalDevice?: boolean;
  /** This machine's own addresses. Default: every address of every network interface. */
  localAddresses?: () => readonly string[];
  limits?: Partial<ServerLimits>;
}

export interface RunningServer {
  port: number;
  /** The address the socket is really bound to (a wildcard stays a wildcard here, unlike `url`). */
  host: string;
  url: string;
  close(): Promise<void>;
}

export { CLOSE };

/**
 * Largest message the socket layer admits, text or binary. Above the 1024-byte device limit
 * on purpose: between LIMITS.deviceFrameMax and this the codec, not the socket, refuses a
 * frame, and the player gets a `bad_msg` they can act on instead of a dropped connection.
 * Beyond it the socket layer closes with 1009 before any of our code sees the bytes.
 * PROTOCOL.md says the same number.
 */
export const MAX_PAYLOAD = 2048;
/** How long a turn gets to wind down after `abort` before the server ends it itself. */
export const ABORT_GRACE_MS = 5000;
/** Five undecodable frames in a row close the connection. */
export const MAX_BAD_FRAMES = 5;
/** One `not_listening` per second is a hint; one per audio frame is a flood at 50 frames a second. */
const NOT_LISTENING_GAP_MS = 1000;
/** Real time we give polite clients to answer a close frame before we stop being polite. */
const SHUTDOWN_WAIT_MS = 1000;
/** Refusals of the same kind are logged at most this often, with a count, so a flood cannot write the log full. */
const ADMIT_LOG_GAP_MS = 10_000;
/** Addresses with a failed-hello record; the oldest is forgotten beyond this. */
export const MAX_TRACKED_ADDRESSES = 512;

/**
 * Every number a deployment can feel. Exported so a test can pin them to PROTOCOL.md's
 * timings table: the document promises these figures to firmware authors.
 */
export const DEFAULTS = {
  askTtlMs: 90_000,
  graceMs: 15_000,
  helloTimeoutMs: 10_000,
  authFailDelayMs: 500,
  pingIntervalMs: 10_000,
  keepaliveCheckMs: 5_000,
  deadAfterMs: 25_000,
  listenIdleMs: 15_000,
  headersTimeoutMs: 5_000,
  maxConnections: 32,
  maxConnectionsPerAddress: 8,
  authFreeFailures: 5,
  authLockoutBaseMs: 2_000,
  authLockoutMaxMs: 300_000,
  authForgetMs: 600_000,
  maxBufferedBytes: 65_536,
  maxOpenAsks: 8,
} as const;

const GENERIC_RESULT = new Map<string, string>([
  ['success', 'Done.'],
  ['interrupted', 'Stopped.'],
  ['error_max_turns', 'Hit the turn limit.'],
  ['error_max_budget_usd', 'Hit the spending limit.'],
  ['error_max_structured_output_retries', 'Could not produce an answer.'],
  ['error_during_execution', 'Something went wrong.'],
  ['session_failed', 'The Claude session failed.'],
  // The driver's own watchdog ended the turn (no sign of life); it words this itself, so this is the fallback.
  ['stalled', 'Claude is not responding.'],
]);

/** What the MODEL is told when the bridge, not the user, refuses a call because too many are waiting. */
const MSG_TOO_MANY_ASKS =
  'Too many actions are already waiting for the user to approve them on the handheld, so this one was not run. ' +
  'Wait for the user to answer those, then try again.';

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

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/**
 * One spelling per address: lower case, no zone id (`fe80::1%eth0`), and an IPv4 address
 * that arrived on a dual-stack socket (`::ffff:127.0.0.1`, or its hex form) as plain IPv4.
 */
export function normalizeAddress(address: string): string {
  let s = address.trim().toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted?.[1] !== undefined) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return s;
}

export function isLoopbackAddress(address: string): boolean {
  const a = normalizeAddress(address);
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a);
}

/** Every address of every network interface of this machine, normalised. */
export function ownAddresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) out.push(normalizeAddress(a.address));
  }
  return out;
}

/**
 * Is `address` this machine? Loopback, or an address one of its interfaces carries. An
 * address that is not known at all (a socket that already went away) counts as local: the
 * answer decides whether a peer is refused, and "cannot tell" must refuse.
 */
export function isLocalPeer(address: string | undefined, own: readonly string[]): boolean {
  if (address === undefined || address === '' || address === '?') return true;
  if (isLoopbackAddress(address)) return true;
  const a = normalizeAddress(address);
  return own.some((o) => o === a);
}

/** Failed hellos per address, shared by every connection from it, with a lockout that doubles. */
export class FailureTable {
  readonly #byAddr = new Map<string, { fails: number; last: number; until: number }>();
  readonly #free: number;
  readonly #base: number;
  readonly #max: number;
  readonly #forget: number;

  constructor(l: Pick<ServerLimits, 'authFreeFailures' | 'authLockoutBaseMs' | 'authLockoutMaxMs' | 'authForgetMs'>) {
    this.#free = l.authFreeFailures;
    this.#base = l.authLockoutBaseMs;
    this.#max = l.authLockoutMaxMs;
    this.#forget = l.authForgetMs;
  }

  /** Milliseconds left on the lockout, 0 when the address may try. */
  lockedFor(addr: string, now: number): number {
    const e = this.#byAddr.get(addr);
    if (e === undefined) return 0;
    if (now - e.last > this.#forget) {
      this.#byAddr.delete(addr);
      return 0;
    }
    return Math.max(0, e.until - now);
  }

  /** Records a wrong token; returns the lockout it earned (0: none yet). */
  fail(addr: string, now: number): number {
    const prev = this.#byAddr.get(addr);
    const fails = (prev !== undefined && now - prev.last <= this.#forget ? prev.fails : 0) + 1;
    const over = fails - this.#free;
    const lock = over <= 0 ? 0 : Math.min(this.#max, this.#base * 2 ** Math.min(over - 1, 30));
    // Re-inserted so the Map's insertion order is also least-recently-failed first.
    this.#byAddr.delete(addr);
    this.#byAddr.set(addr, { fails, last: now, until: now + lock });
    if (this.#byAddr.size > MAX_TRACKED_ADDRESSES) {
      const oldest = this.#byAddr.keys().next().value;
      if (oldest !== undefined) this.#byAddr.delete(oldest);
    }
    return lock;
  }

  succeed(addr: string): void {
    this.#byAddr.delete(addr);
  }

  get size(): number {
    return this.#byAddr.size;
  }
}

const REJECT_TEXT = new Map<number, string>([
  [400, 'Bad Request'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [503, 'Service Unavailable'],
]);

/** An HTTP answer on a socket that will never become a WebSocket, then hang up. */
function rejectUpgrade(socket: Duplex, status: number, why: string): void {
  try {
    const body = `${why}\n`;
    socket.end(
      `HTTP/1.1 ${status} ${REJECT_TEXT.get(status) ?? 'Error'}\r\nConnection: close\r\nContent-Type: text/plain\r\n` +
        `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
  } catch {
    // the peer is already gone
  }
  // A peer that will not read must not keep the socket alive.
  const t = setTimeout(() => socket.destroy(), 2000);
  t.unref();
  socket.once('close', () => clearTimeout(t));
}

interface Conn {
  readonly id: number;
  readonly ws: WebSocket;
  /** `address:port`, for logs. */
  readonly remote: string;
  /** The peer's address, normalised: the key failed hellos are counted under. */
  readonly addr: string;
  /** new: waiting for hello. authing: wrong token, waiting out the delay. active: past the handshake. closed: refused or gone. */
  phase: 'new' | 'authing' | 'active' | 'closed';
  /** We have started closing it; whatever else it says is ignored. */
  closing: boolean;
  helloTimer: TimerHandle | undefined;
  authTimer: TimerHandle | undefined;
  keepalive: TimerHandle | undefined;
  /** keepalive-clock reading of the last frame, ping or pong. */
  lastSeen: number;
  /** keepalive-clock reading of the last keepalive tick, to notice when the process itself stood still. */
  lastTick: number;
  /** Keepalive ticks since the handshake; a ping goes out every `pingEvery`-th. */
  ticks: number;
  seq: number;
  last: { ph: string; tl: string; pend: number } | undefined;
  badFrames: number;
  lastNotListening: number;
  /** The device's own label, for the takeover log. */
  dev: string;
}

interface ListenWindow {
  chunks: Buffer[];
  bytes: number;
  /** Clock reading of the window opening or of the last audio frame, whichever is later. */
  lastAudio: number;
  /** One timer per window, re-armed lazily: when it fires it looks at `lastAudio` before it closes anything. */
  timer: TimerHandle | undefined;
}

/** Real and monotonic: the keepalive measures a real socket going quiet. */
const monotonicClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function positive(name: string, n: number): number {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`server: ${name} must be a positive number, got ${n}`);
  return n;
}

class Bridge {
  readonly #host: string;
  readonly #port: number;
  readonly #token: string;
  readonly #cwd: string;
  readonly #stateDir: string | undefined;
  readonly #clock: Clock;
  readonly #ka: Clock;
  readonly #logger: Logger;
  readonly #stt: SttAdapter;
  readonly #helloTimeoutMs: number;
  readonly #authFailDelayMs: number;
  readonly #pingEvery: number;
  readonly #checkMs: number;
  readonly #deadAfterMs: number;
  readonly #listenIdleMs: number;
  readonly #allowLocal: boolean;
  readonly #localAddresses: () => readonly string[];
  readonly #limits: ServerLimits;
  readonly #failures: FailureTable;

  readonly #approvals: ApprovalManager;
  readonly #driver: SessionDriver;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #conns = new Set<Conn>();
  /** Every live TCP socket, of any phase, for the caps. */
  readonly #sockets = new Set<Socket>();
  readonly #perAddr = new Map<string, number>();
  readonly #admitLog = new Map<string, { count: number; at: number }>();

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
    this.#ka = o.keepaliveClock ?? monotonicClock;
    this.#logger = o.log ?? (() => {});
    this.#stt = o.stt ?? new UnavailableStt();
    this.#helloTimeoutMs = positive('helloTimeoutMs', o.helloTimeoutMs ?? DEFAULTS.helloTimeoutMs);
    this.#authFailDelayMs = o.authFailDelayMs ?? DEFAULTS.authFailDelayMs;
    const pingMs = positive('pingIntervalMs', o.pingIntervalMs ?? DEFAULTS.pingIntervalMs);
    // The silent device is noticed at a look, so looks must be at least as frequent as pings.
    this.#checkMs = Math.min(positive('keepaliveCheckMs', o.keepaliveCheckMs ?? DEFAULTS.keepaliveCheckMs), pingMs);
    this.#pingEvery = Math.max(1, Math.round(pingMs / this.#checkMs));
    this.#deadAfterMs = positive('deadAfterMs', o.deadAfterMs ?? DEFAULTS.deadAfterMs);
    this.#listenIdleMs = positive('listenIdleMs', o.listenIdleMs ?? DEFAULTS.listenIdleMs);
    this.#allowLocal = o.allowLocalDevice === true;
    this.#localAddresses = o.localAddresses ?? ((): readonly string[] => ownAddresses());
    this.#limits = {
      maxConnections: DEFAULTS.maxConnections,
      maxConnectionsPerAddress: DEFAULTS.maxConnectionsPerAddress,
      headersTimeoutMs: DEFAULTS.headersTimeoutMs,
      authFreeFailures: DEFAULTS.authFreeFailures,
      authLockoutBaseMs: DEFAULTS.authLockoutBaseMs,
      authLockoutMaxMs: DEFAULTS.authLockoutMaxMs,
      authForgetMs: DEFAULTS.authForgetMs,
      maxBufferedBytes: DEFAULTS.maxBufferedBytes,
      maxOpenAsks: DEFAULTS.maxOpenAsks,
      ...o.limits,
    };
    this.#failures = new FailureTable(this.#limits);

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
      onPermission: this.#boundedPermissions(
        createPermissionHandler({
          approvals: this.#approvals,
          cwd: this.#cwd,
          log: (l) => this.#log(l),
        }),
      ),
      ...(resume !== undefined ? { resume } : {}),
      log: (l) => this.#log(l),
    });

    // Plain HTTP gets a polite refusal rather than a hang or a stack trace. The two timeouts
    // bound how long a socket may take to deliver its request headers: an upgrade request is
    // one packet, and a socket that never sends one is not a device.
    const headersTimeout = positive('headersTimeoutMs', this.#limits.headersTimeoutMs);
    this.#http = createServer(
      {
        headersTimeout,
        requestTimeout: headersTimeout,
        // Node checks those timeouts on a timer of its own, every 30 s by default.
        connectionsCheckingInterval: Math.max(10, Math.min(1000, Math.floor(headersTimeout / 2))),
      },
      (_req, res) => {
        res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket', connection: 'Upgrade' });
        res.end('This is the TamaClaude bridge. Connect with a WebSocket.\n');
      },
    );
    this.#http.on('error', (err) => this.#log(`http error: ${errName(err)}`));
    this.#http.on('connection', (socket) => this.#onSocket(socket));
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
    // noServer: the upgrade is ours to accept or refuse (see ADMISSION), not the library's.
    this.#wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: false,
      clientTracking: false, // we keep our own set, which also holds sockets that never said hello
    });
    this.#wss.on('error', (err) => this.#log(`ws server error: ${errName(err)}`));
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
    const bound = this.#http.address() as AddressInfo;
    const host = this.#host === '' || this.#host === '0.0.0.0' ? '127.0.0.1' : this.#host === '::' ? '::1' : this.#host;
    return {
      port: bound.port,
      host: bound.address,
      url: `ws://${host.includes(':') ? `[${host}]` : host}:${bound.port}/`,
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

  /**
   * Refusals that an outsider can cause at will are logged as a count, at most once per
   * reason per ADMIT_LOG_GAP_MS: a flood must not be able to write the log full, and the
   * count still says it is happening.
   */
  #admitNote(reason: string, detail: string): void {
    const now = this.#clock.now();
    const slot = this.#admitLog.get(reason) ?? { count: 0, at: -Infinity };
    slot.count += 1;
    if (now - slot.at >= ADMIT_LOG_GAP_MS) {
      this.#log(`admission: refused ${slot.count} connection(s): ${reason} (latest from ${detail})`);
      slot.count = 0;
      slot.at = now;
    }
    this.#admitLog.set(reason, slot);
  }

  /**
   * THE ONLY WAY A FRAME REACHES A DEVICE, with the one exception of the handshake refusal.
   * A connection that is not the authenticated active one is sent nothing, whoever asks: an
   * ask carries the real command and a result carries the model's answer, and neither may
   * leak to a socket that has not proved itself.
   */
  #send(conn: Conn, msg: BridgeMsg): void {
    if (conn !== this.#active || conn.phase !== 'active') return;
    this.#write(conn, msg);
  }

  /** The hello_ack that says no. Nothing else can be sent to a connection that has not passed the handshake. */
  #sendRefusal(conn: Conn, why: HelloWhy): void {
    this.#write(conn, { t: 'hello_ack', v: PROTOCOL_VERSION, ok: false, why });
  }

  #write(conn: Conn, msg: BridgeMsg): void {
    if (conn.ws.readyState !== WebSocket.OPEN) return;
    // A device that has stopped reading is dead as far as the bridge can tell, and every frame
    // queued for it is memory. Dropping it is the same as the device leaving: its asks get the
    // grace period, and it can reconnect.
    if (conn.ws.bufferedAmount > this.#limits.maxBufferedBytes) {
      this.#log(`conn ${conn.id} is not reading (${conn.ws.bufferedAmount} bytes queued), dropping it`);
      conn.closing = true;
      conn.ws.terminate();
      return;
    }
    let frame: string;
    try {
      frame = encodeBridgeMsg(msg);
    } catch (err) {
      // The encoder is strict on purpose (a bad frame is a bridge bug), so a throw here means
      // some string was not sanitised or a limit was missed. The reason text names the field
      // and never the value, so it is safe to log.
      this.#log(`encode failed for ${msg.t}: ${err instanceof Error ? err.message : errName(err)}`);
      if (msg.t === 'err' && msg.code === 'internal') return;
      this.#write(conn, { t: 'err', code: 'internal', msg: 'internal error' });
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

  /**
   * A model that fires off asks faster than a person can read them would queue them without
   * limit, and each waiting ask is a full lifetime on the panel. Past the bound the call is
   * refused (so the model is told) without bothering the device.
   */
  #boundedPermissions(inner: PermissionHandler): PermissionHandler {
    return (req) => {
      const open = this.#approvals.pendingCount();
      if (open >= this.#limits.maxOpenAsks) {
        this.#log(`permission: refused tool=${sanitize(typeof req.tool === 'string' ? req.tool : '?', 48)} (${open} asks already open)`);
        return Promise.resolve({ allow: false, message: MSG_TOO_MANY_ASKS });
      }
      return inner(req);
    };
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
   * of truth for asks and the reducer only mirrors it: this is the one input that changes it.
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
  // Admission: sockets, upgrades
  // ---------------------------------------------------------------------------

  /** A TCP connection, before a single byte of HTTP. The cheapest place to say no. */
  #onSocket(socket: Socket): void {
    // An 'error' with no listener is an uncaught exception, and a reset is not exceptional.
    socket.on('error', () => {});
    const addr = normalizeAddress(socket.remoteAddress ?? '?');
    if (this.#closed) return void socket.destroy();
    if (this.#sockets.size >= this.#limits.maxConnections) {
      this.#admitNote('too many connections', addr);
      return void socket.destroy();
    }
    const n = this.#perAddr.get(addr) ?? 0;
    if (n >= this.#limits.maxConnectionsPerAddress) {
      this.#admitNote('too many connections from one address', addr);
      return void socket.destroy();
    }
    const lock = this.#failures.lockedFor(addr, this.#clock.now());
    if (lock > 0) {
      this.#admitNote('address locked out after failed hellos', addr);
      return void socket.destroy();
    }
    this.#sockets.add(socket);
    this.#perAddr.set(addr, n + 1);
    socket.once('close', () => {
      this.#sockets.delete(socket);
      const left = (this.#perAddr.get(addr) ?? 1) - 1;
      if (left <= 0) this.#perAddr.delete(addr);
      else this.#perAddr.set(addr, left);
    });
  }

  #onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {});
    const peer = (socket as Socket).remoteAddress;
    if (this.#closed) return rejectUpgrade(socket, 503, 'The bridge is shutting down.');
    if ((req.url ?? '').split('?')[0] !== '/') return rejectUpgrade(socket, 404, 'Only / speaks WebSocket.');
    // A browser always sends Origin on a WebSocket and a device never does. Refusing it keeps
    // any web page, on this machine or the network, from using the bridge as a stepping stone.
    if (req.headers.origin !== undefined) {
      this.#admitNote('upgrade with an Origin header', peer ?? '?');
      return rejectUpgrade(socket, 403, 'Browsers are not devices.');
    }
    if (!this.#allowLocal && isLocalPeer(peer, this.#localAddresses())) {
      this.#admitNote(
        `refused a device on this machine (the model's own commands run here; --allow-local-device lifts this)`,
        peer ?? '?',
      );
      return rejectUpgrade(socket, 403, 'This bridge does not accept a device on its own machine. Start it with --allow-local-device to allow one.');
    }
    this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, req));
  }

  // ---------------------------------------------------------------------------
  // Connections and the handshake
  // ---------------------------------------------------------------------------

  #onConnection(ws: WebSocket, req: IncomingMessage): void {
    const now = this.#ka.now();
    const conn: Conn = {
      id: ++this.#connSeq,
      ws,
      remote: `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`,
      addr: normalizeAddress(req.socket.remoteAddress ?? '?'),
      phase: 'new',
      closing: false,
      helloTimer: undefined,
      authTimer: undefined,
      keepalive: undefined,
      lastSeen: now,
      lastTick: now,
      ticks: 0,
      seq: 0,
      last: undefined,
      badFrames: 0,
      lastNotListening: -Infinity,
      dev: '',
    };
    // Without a listener an 'error' (an oversized frame, a reset) would be an uncaught exception.
    ws.on('error', (err) => this.#log(`conn ${conn.id} socket error: ${errName(err)}`));
    if (this.#closed) {
      ws.close(CLOSE.goingAway, 'bridge shutting down');
      return;
    }
    this.#conns.add(conn);
    this.#log(`conn ${conn.id} opened from ${conn.remote}`);

    ws.on('close', () => this.#onClosed(conn));
    ws.on('pong', () => {
      conn.lastSeen = this.#ka.now();
    });
    ws.on('ping', () => {
      conn.lastSeen = this.#ka.now();
    });
    ws.on('message', (data, isBinary) => {
      conn.lastSeen = this.#ka.now();
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
      this.#close(conn, CLOSE.handshake, 'hello timeout');
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
    if (conn.keepalive !== undefined) this.#ka.clearTimeout(conn.keepalive);
    conn.helloTimer = undefined;
    conn.authTimer = undefined;
    conn.keepalive = undefined;
  }

  /**
   * Answer a hello with a refusal and hang up. Says nothing about WHY beyond the three codes.
   * The connection is finished the moment it is refused: its phase is `closed` at once, not
   * when the socket gets round to closing, so a second hello already waiting in the same
   * read can never be mistaken for a first one and promote it.
   */
  #refuse(conn: Conn, why: HelloWhy): void {
    this.#clearConnTimers(conn);
    conn.phase = 'closed';
    this.#log(`conn ${conn.id} hello refused: ${why}`);
    this.#sendRefusal(conn, why);
    this.#close(conn, CLOSE.handshake, 'hello refused');
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

    // An address that has failed too often is not even compared: a lockout that still checked
    // the token would let the guesser go on guessing and hear "yes" once. It is told what a
    // wrong token is told, after the same delay.
    const now = this.#clock.now();
    const locked = this.#failures.lockedFor(conn.addr, now) > 0;
    if (locked || !tokenMatches(hello.token, this.#token)) {
      if (!locked) {
        const lock = this.#failures.fail(conn.addr, now);
        if (lock > 0) this.#log(`auth: ${conn.addr} is locked out for ${Math.ceil(lock / 1000)} s after repeated wrong tokens`);
      }
      conn.phase = 'authing';
      conn.authTimer = this.#clock.setTimeout(() => {
        conn.authTimer = undefined;
        this.#refuse(conn, 'token');
      }, this.#authFailDelayMs);
      return;
    }
    this.#failures.succeed(conn.addr);
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
    conn.dev = sanitize(hello.dev, LIMITS.devMax);
    if (old !== undefined) {
      // Loud on purpose: a takeover is either the player's second device or somebody who has the
      // token. The token itself is never in this line.
      this.#log(
        `WARNING takeover: conn ${conn.id} (dev=${conn.dev} from ${conn.remote}) replaced conn ${old.id} (dev=${old.dev} from ${old.remote})`,
      );
      this.#close(old, CLOSE.replaced, 'replaced');
    }
    // Idempotent when a device replaces a device: the connection never lapsed, so the
    // reconnect grace for open asks is never started.
    this.#approvals.deviceConnected();
    this.#log(`conn ${conn.id} hello ok dev=${conn.dev} fw=${sanitize(hello.fw, LIMITS.fwMax)}`);

    this.#send(conn, { t: 'hello_ack', v: PROTOCOL_VERSION, ok: true, sid: this.#sid() });
    this.#pushState(conn, true); // seq restarts at 1 on every connection
    const open = this.#approvals.current();
    if (open !== undefined) this.#send(conn, askMsg(open)); // with the time that is LEFT, not the original

    const now = this.#ka.now();
    conn.lastSeen = now;
    conn.lastTick = now;
    conn.keepalive = this.#ka.setTimeout(() => this.#keepalive(conn), this.#checkMs);
  }

  #sid(): string {
    try {
      return sanitize(this.#driver.sessionId() ?? '', 64);
    } catch {
      return '';
    }
  }

  /**
   * One look at a connection, every `keepaliveCheckMs`: drop it if it has been silent for
   * more than `deadAfterMs`, otherwise ping it on every `pingEvery`-th look. A silent device
   * is therefore dropped between deadAfterMs and deadAfterMs + keepaliveCheckMs after its
   * last frame (25 to 30 s with the defaults), which is what PROTOCOL.md says.
   */
  #keepalive(conn: Conn): void {
    conn.keepalive = undefined;
    if (conn.closing || conn.phase !== 'active') return;
    const now = this.#ka.now();
    // A look that arrives much later than scheduled means THIS process was not running (a laptop
    // that slept, a blocked event loop), and the device's silence in that time proves nothing:
    // its pong is queued behind us. Judging it dead would drop a healthy connection on every
    // resume, so the silence window starts again.
    if (now - conn.lastTick > 2 * this.#checkMs) {
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
    conn.ticks += 1;
    if (conn.ticks % this.#pingEvery === 0) {
      try {
        conn.ws.ping();
      } catch (err) {
        this.#log(`ping failed on conn ${conn.id}: ${errName(err)}`);
      }
    }
    conn.keepalive = this.#ka.setTimeout(() => this.#keepalive(conn), this.#checkMs);
  }

  // ---------------------------------------------------------------------------
  // Messages from the device
  // ---------------------------------------------------------------------------

  #onMessage(conn: Conn, data: RawData, isBinary: boolean): void {
    if (conn.phase === 'new' || conn.phase === 'authing') return this.#handshake(conn, data, isBinary);
    // A replaced socket can still deliver bytes while its close handshake completes, and a
    // refused one can have more queued behind the hello that was refused. Only the active
    // connection may speak: this is what stops a stale device from answering an ask.
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
    this.#startTurn(text);
  }

  #startTurn(text: string): void {
    this.#turnActive = true;
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
        this.#discardWindow(); // a restart: the old window's timer must not outlive it
        this.#listen = { chunks: [], bytes: 0, lastAudio: this.#clock.now(), timer: undefined };
        this.#armListenTimer(this.#listen, this.#listenIdleMs);
        this.#apply({ k: 'listen_start' });
        if (this.#state.base !== 'listening') {
          this.#discardWindow(); // the state machine would not open a window: do not hold audio (or a timer) for one
          return this.#err(conn, 'busy', 'cannot listen now');
        }
        return;
      case 'stop': {
        const win = this.#listen;
        if (win === undefined) return this.#err(conn, 'not_listening', 'no listen window is open');
        this.#discardWindow();
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
    this.#discardWindow();
    this.#sttGen += 1;
    this.#apply({ k: 'listen_cancel' });
  }

  /** Throws the open window away, with its timer. Does not touch the phase: that is the caller's reducer input. */
  #discardWindow(): void {
    const win = this.#listen;
    if (win === undefined) return;
    if (win.timer !== undefined) this.#clock.clearTimeout(win.timer);
    win.timer = undefined;
    this.#listen = undefined;
  }

  #armListenTimer(win: ListenWindow, ms: number): void {
    win.timer = this.#clock.setTimeout(() => this.#onListenTimer(win), ms);
  }

  /**
   * The idle rule for a listen window. A frame does not touch the timer (50 of them a second would mean
   * 50 clear-and-set pairs a second); it only moves `lastAudio`, and the timer, when it fires, either closes
   * the window or sleeps again for what is left.
   */
  #onListenTimer(win: ListenWindow): void {
    win.timer = undefined;
    if (this.#listen !== win) return;
    const idle = this.#clock.now() - win.lastAudio;
    if (idle < this.#listenIdleMs) return this.#armListenTimer(win, this.#listenIdleMs - idle);
    this.#log(`listen window had no audio for ${Math.round(idle / 1000)} s, closing it`);
    this.#listen = undefined;
    const conn = this.#active;
    if (conn !== undefined) this.#endListen(conn, 'empty', 'listen window timed out');
    else this.#apply({ k: 'listen_cancel' });
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
    win.lastAudio = this.#clock.now();
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
    const shown = sanitize(transcript.trim(), LIMITS.sttMax);
    if (shown === '') return this.#endListen(conn, 'empty', 'nothing was heard');

    // The transcript is SHOWN, never run. The device puts it in front of the player, and only
    // the player's SEND tap (a `say`) starts a turn; what Claude then gets is exactly the text
    // the player saw. The pet rests at `idle` meanwhile.
    this.#send(conn, { t: 'stt', text: shown });
    this.#apply({ k: 'stt_done' });
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
          // Not sent when nobody is connected: that is the only time the manager ends an ask
          // for `disconnect`, so the reason is reserved and never actually delivered.
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

  /**
   * The turn is over, by the driver's word or ours. Exactly once per turn, and exactly one
   * `result` frame for it: a session that failed outright also gets an `err` `driver` first
   * (what went wrong, for logs), then the `result` with ok false, so a device that releases
   * its input on `result` is never left waiting.
   */
  #finishTurn(e: Extract<DriverEvent, { k: 'result' | 'fatal' }>): void {
    this.#turnActive = false;
    if (this.#watchdog !== undefined) this.#clock.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;

    const conn = this.#active;
    if (conn !== undefined) {
      if (e.k === 'result') {
        this.#send(conn, buildResult(e));
      } else {
        const msg = typeof e.msg === 'string' ? e.msg : '';
        this.#err(conn, 'driver', sanitize(msg, LIMITS.errMax) || 'the Claude session failed');
        this.#send(conn, buildResult({ k: 'result', ok: false, text: msg, subtype: 'session_failed' }));
      }
    }
    // The reducer leaves the open asks alone: an ask can outlive the turn that raised it (a
    // background task asking after the result), it is still answerable, and the manager's
    // own events say when it is not.
    this.#apply(e);
    // done and error last until told otherwise, and the pet should rest again.
    this.#apply({ k: 'settle' });
  }

  // ---------------------------------------------------------------------------
  // Abort
  // ---------------------------------------------------------------------------

  /**
   * `abort` stops the running turn and ends every open ask. With no turn running there is
   * nothing to stop, but an ask can have outlived its turn, so it still ends those: "stop
   * everything" must not leave an approval on the panel. It does nothing else: a listen
   * window or a transcription is cancelled with `listen cancel`, not with this.
   */
  #onAbort(): void {
    if (!this.#turnActive) {
      if (this.#approvals.pendingCount() > 0) this.#approvals.cancelAll('abort');
      return;
    }
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
    this.#discardWindow();
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
