/**
 * Shared contract for the bridge.
 *
 * The WIRE half (messages, limits, binary frame kinds) is specified for humans in
 * PROTOCOL.md and is what the firmware will implement; the INTERNAL half (drivers,
 * approvals, clock) is what the bridge's own modules agree on. Nothing in this
 * file may do I/O, and nothing may be added to the wire half without a protocol
 * version decision: a firmware in somebody's pocket cannot be patched by pulling.
 *
 * Syntax rule: this project runs TypeScript by type stripping (no build step), so
 * only erasable syntax is allowed -- no enums, no namespaces, no constructor
 * parameter properties.
 */

export const PROTOCOL_VERSION = 1;

/**
 * Limits the firmware also enforces. They exist because a handheld has a 25
 * character-wide line and a few KB of receive buffer. Changing one is a protocol
 * change.
 */
export const LIMITS = {
  /** Largest text (JSON) frame the bridge accepts from a device, in bytes. */
  deviceFrameMax: 1024,
  /** Largest text frame the bridge ever sends, in bytes (the firmware's receive buffer). */
  bridgeFrameMax: 1024,
  tokenMin: 16,
  tokenMax: 64,
  /** Device id and firmware version strings in `hello`. */
  devMax: 32,
  fwMax: 16,
  /** Tool name / short label shown on the panel. */
  labelMax: 16,
  /** An ask id is this many lowercase hex characters. */
  idLen: 8,
  /** A typed or transcribed prompt. */
  sayMax: 400,
  /** A transcript echoed back to the device. */
  sttMax: 240,
  /** The final spoken/printed summary of a turn. */
  resultMax: 240,
  /** What an approval prompt shows of the tool call. */
  summaryMax: 96,
  /** `err.msg`. */
  errMax: 64,
  /** One audio frame's payload: 40 ms of 16 kHz s16le mono. */
  audioPayloadMax: 1280,
  /** The bridge's own ceiling on one push-to-talk utterance (the device caps at 30 s). */
  utteranceMaxBytes: 35 * 32000,
} as const;

export const AUDIO = { rate: 16000, bits: 16, channels: 1 } as const;

/** First byte of every binary WebSocket frame. */
export const FRAME_KIND_MIC = 0x01; // device -> bridge, PCM while listening
export const FRAME_KIND_TTS = 0x02; // bridge -> device, PCM while speaking

export type Phase =
  | 'idle'
  | 'listening'
  | 'transcribing'
  | 'thinking'
  | 'tool'
  | 'asking'
  | 'speaking'
  | 'done'
  | 'error';
export const PHASES: readonly Phase[] = [
  'idle', 'listening', 'transcribing', 'thinking', 'tool', 'asking', 'speaking', 'done', 'error',
];

export type Risk = 'low' | 'med' | 'high';
export const RISKS: readonly Risk[] = ['low', 'med', 'high'];

/** Why an ask stopped being open. `answered` is the only one the device caused. */
export type AskEndReason = 'answered' | 'timeout' | 'abort' | 'disconnect';
export const ASK_END_REASONS: readonly AskEndReason[] = ['answered', 'timeout', 'abort', 'disconnect'];

export type ErrCode =
  | 'bad_msg'        // undecodable, oversized, wrong type, or out of sequence
  | 'busy'           // `say`/`listen` while a turn is running
  | 'unknown_ask'    // ask_rsp for an id that is not open (never asked, answered, or expired)
  | 'not_listening'  // audio frame outside a listen window
  | 'too_long'       // utterance over the ceiling
  | 'empty'          // nothing intelligible in the audio
  | 'stt_unavailable'
  | 'stt_failed'
  | 'driver'         // the Claude session failed
  | 'internal';
export const ERR_CODES: readonly ErrCode[] = [
  'bad_msg', 'busy', 'unknown_ask', 'not_listening', 'too_long', 'empty',
  'stt_unavailable', 'stt_failed', 'driver', 'internal',
];

export type HelloWhy = 'token' | 'version' | 'bad_hello';
export const HELLO_WHYS: readonly HelloWhy[] = ['token', 'version', 'bad_hello'];

// ---------------------------------------------------------------------------
// Wire messages. Every one is a FLAT JSON object whose first key is `t`, with
// no nested objects or arrays and a FIXED set of keys per type (no optional
// keys), so the firmware can parse them with a few lines of C++. All strings
// are printable ASCII (0x20-0x7E) -- the panel font has no other glyphs.
// ---------------------------------------------------------------------------

// device -> bridge

export interface HelloMsg {
  t: 'hello';
  v: number;
  token: string;
  dev: string;
  fw: string;
  rate: number;
  bits: number;
  ch: number;
}
/** A typed prompt. Also the fallback input path if the microphone never works. */
export interface SayMsg { t: 'say'; text: string }
export interface ListenMsg { t: 'listen'; m: 'start' | 'stop' | 'cancel' }
/** The ONLY way to approve or deny a tool call. Voice and text can never grant it. */
export interface AskRspMsg { t: 'ask_rsp'; id: string; ok: boolean }
export interface AbortMsg { t: 'abort' }
export interface PingMsg { t: 'ping'; n: number }
export type DeviceMsg = HelloMsg | SayMsg | ListenMsg | AskRspMsg | AbortMsg | PingMsg;
export const DEVICE_MSG_TYPES = ['hello', 'say', 'listen', 'ask_rsp', 'abort', 'ping'] as const;

// bridge -> device

export type HelloAckMsg =
  | { t: 'hello_ack'; v: number; ok: true; sid: string }
  | { t: 'hello_ack'; v: number; ok: false; why: HelloWhy };
/**
 * `seq` rises by one per state message within a connection, `tl` is the tool label
 * ("" unless ph is `tool` or `asking`), `pend` is the number of open asks.
 */
export interface StateMsg { t: 'state'; seq: number; ph: Phase; tl: string; pend: number }
export interface SttMsg { t: 'stt'; text: string }
/** `sum` is built by the bridge from the real tool input, never from the model's own description. */
export interface AskMsg { t: 'ask'; id: string; tl: string; risk: Risk; sum: string; ttl: number }
export interface AskEndMsg { t: 'ask_end'; id: string; why: AskEndReason }
export interface ResultMsg { t: 'result'; ok: boolean; text: string }
export interface ErrMsg { t: 'err'; code: ErrCode; msg: string }
export interface PongMsg { t: 'pong'; n: number }
export type BridgeMsg = HelloAckMsg | StateMsg | SttMsg | AskMsg | AskEndMsg | ResultMsg | ErrMsg | PongMsg;
export const BRIDGE_MSG_TYPES = ['hello_ack', 'state', 'stt', 'ask', 'ask_end', 'result', 'err', 'pong'] as const;

export type DecodeResult<T> =
  | { ok: true; msg: T }
  | { ok: false; code: ErrCode; msg: string };

// ---------------------------------------------------------------------------
// Internal contracts
// ---------------------------------------------------------------------------

export type TimerHandle = unknown;
/** Injected everywhere that waits, so tests are deterministic and need no real sleeps. */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(h: TimerHandle): void;
}
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export type Logger = (line: string) => void;

/**
 * What a Claude session reports, normalised so the bridge never sees the Agent
 * SDK's wire shapes. Both the real driver and the fake one emit exactly these.
 *
 * INVARIANT: every accepted prompt ends with exactly ONE terminal event, `result`
 * or `fatal`. The server relies on it to know a turn is over.
 */
export type DriverEvent =
  | { k: 'session'; id: string }
  | { k: 'tool_start'; id: string; name: string }
  | { k: 'tool_end'; id: string; ok: boolean }
  /** Assistant narration. For logs only: it is never spoken or shown (it includes chatter between tool calls). */
  | { k: 'text'; text: string }
  /** `text` is the model's full final answer (unsanitised); the server summarises it. */
  | { k: 'result'; ok: boolean; text: string; subtype: string }
  | { k: 'fatal'; msg: string };

export interface PermissionRequest {
  tool: string;
  input: Record<string, unknown>;
  toolUseId: string;
  /** Aborted when the session no longer wants an answer (interrupt, close). */
  signal: AbortSignal;
}
export type PermissionDecision =
  | { allow: true }
  /** `message` is shown to the MODEL, so it can explain itself; `interrupt` stops the turn. */
  | { allow: false; message: string; interrupt?: boolean };
export type PermissionHandler = (req: PermissionRequest) => Promise<PermissionDecision>;

export interface DriverOptions {
  cwd: string;
  onEvent: (e: DriverEvent) => void;
  onPermission: PermissionHandler;
  /** A session id to continue; a driver that cannot resume starts fresh and reports the new id. */
  resume?: string;
  log?: Logger;
}
export interface SessionDriver {
  /** Queue one user prompt. Non-blocking; progress arrives through `onEvent`. */
  prompt(text: string): void;
  /** Stop the running turn. A terminal event must still follow. */
  interrupt(): Promise<void>;
  close(): Promise<void>;
  sessionId(): string | undefined;
}
export type DriverFactory = (opts: DriverOptions) => SessionDriver;

/** What the panel shows about a tool call, and whether it may be asked about at all. */
export interface ToolView {
  /** Short label for the panel (<= LIMITS.labelMax, ASCII). */
  label: string;
  risk: Risk;
  /** Built from the REAL tool input (<= LIMITS.summaryMax, ASCII). */
  summary: string;
  /** Set when the call must be refused outright without ever asking the device. */
  deny?: string;
}
export type DescribeTool = (name: string, input: Record<string, unknown>, cwd?: string) => ToolView;

/** Speech to text. The bridge never assumes a particular engine. */
export interface SttAdapter {
  /** 16 kHz s16le mono PCM in, transcript out. Throw (or return '') on failure. */
  transcribe(pcm: Buffer): Promise<string>;
}
