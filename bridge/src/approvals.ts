/**
 * Approvals: the safety core of the bridge.
 *
 * This module is the only thing that can turn a tool call into "allowed", and the
 * only input that can do it is `answer(id, true)`, which the server calls when the
 * handheld sends `ask_rsp`. Voice, typed text, the model and a timer can all END an
 * ask; none of them can GRANT one. Everything else in here exists to keep that
 * sentence true under races:
 *
 *  - Only the HEAD of the queue is ever presented, and only the head's id is ever
 *    accepted. A late tap for an ask that already timed out can therefore never
 *    land on the NEXT ask: it carries the old id, the head has a new one.
 *  - Ids are unpredictable (random, never sequential), so a stale or guessed id
 *    does not accidentally name a live ask.
 *  - Every way out (answer, timeout, abort, disconnect) resolves the promise exactly
 *    once and disarms exactly the timers that belonged to it. Nothing is armed
 *    when nothing is open, so a forgotten timer cannot deny (or keep alive) a
 *    request it knows nothing about.
 *  - Fail closed: no answer by the deadline is a refusal, and a device that stays
 *    away for `graceMs` takes every open request down with it.
 *
 * EVENT ORDER. Every state change delivers its events in one fixed order:
 *     1. `end`     for the head that just closed (its id was exposed, so the device
 *                  must be told to withdraw it; waiting requests never had one),
 *     2. `ask`     for the new head, if the head changed,
 *     3. `pending` once, carrying the FINAL count of the operation (cancelAll with
 *                  three open emits a single `pending 0`, never 2, 1, 0).
 * The server turns these into ask_end / ask / state, so the device sees the old
 * prompt withdrawn before the new one appears and a pend count that describes the
 * world after both. State is fully updated BEFORE any event is delivered, so
 * `current()` inside a listener already shows the new head.
 *
 * REENTRANCY. A listener may call back in (answer, request, ...). Events produced
 * while one is being delivered are queued behind it rather than interleaved,
 * because interleaving can deliver `pending 0` before an older `pending 1` and
 * leave the device believing something is still open.
 */

import { randomBytes } from 'node:crypto';
import type { AskEndReason, Clock, Risk, TimerHandle } from './types.ts';
import { LIMITS, RISKS, realClock } from './types.ts';
import { sanitize } from './text.ts';

export interface AskInfo {
  id: string;
  label: string;
  risk: Risk;
  summary: string;
  /** Seconds REMAINING (rounded up), at least 1 while the ask is open. */
  ttlSec: number;
}

export type ApprovalEvent =
  | { k: 'ask'; ask: AskInfo }
  | { k: 'end'; id: string; why: AskEndReason }
  | { k: 'pending'; count: number };

export type ApprovalOutcome =
  | { allow: true }
  | { allow: false; reason: 'denied' | 'timeout' | 'abort' | 'disconnect' };

export interface ApprovalManagerOptions {
  clock?: Clock;
  /** How long the head ask stays open, from the moment it becomes the head. */
  ttlMs: number;
  /** How long open asks survive with no device connected before all are denied. */
  graceMs: number;
  /** Id source. Tests inject; the default is random. */
  newId?: () => string;
  /**
   * Delivery sink. A listener that throws does not wedge the manager (state is
   * already consistent and the remaining events are still delivered); the first
   * error is rethrown to whoever triggered the change, so a broken sink is loud.
   */
  onEvent: (e: ApprovalEvent) => void;
}

/** setTimeout fires immediately (with a warning) for delays above this. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** More collisions than this in a row means newId is broken, not unlucky. */
const ID_RETRIES = 32;

function defaultNewId(): string {
  // Whole bytes, trimmed to idLen so an odd length still works.
  return randomBytes(Math.ceil(LIMITS.idLen / 2)).toString('hex').slice(0, LIMITS.idLen);
}

interface Entry {
  /** Assigned at enqueue so uniqueness is checked against everything open, but NOT exposed until it is the head. */
  readonly id: string;
  readonly label: string;
  readonly risk: Risk;
  readonly summary: string;
  readonly resolve: (o: ApprovalOutcome) => void;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  ttl: TimerHandle | undefined;
  deadline: number;
}

export class ApprovalManager {
  readonly #clock: Clock;
  readonly #ttlMs: number;
  readonly #graceMs: number;
  readonly #newId: () => string;
  readonly #onEvent: (e: ApprovalEvent) => void;

  #queue: Entry[] = [];
  /** The device starts away: nothing may be approved by a tap that cannot arrive. */
  #connected = false;
  /** Identity token, so a grace timer that outlives its cancellation cannot act for a newer one. */
  #grace: { handle: TimerHandle } | undefined;
  #outbox: ApprovalEvent[] = [];
  #draining = false;

  constructor(opts: ApprovalManagerOptions) {
    // A bad TTL would not fail loudly later: NaN and huge values make Node fire the
    // timer at once, which silently denies everything. Refuse them here.
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0 || opts.ttlMs > MAX_TIMER_MS) {
      throw new RangeError(`approvals: ttlMs must be in (0, ${MAX_TIMER_MS}], got ${opts.ttlMs}`);
    }
    if (!Number.isFinite(opts.graceMs) || opts.graceMs < 0 || opts.graceMs > MAX_TIMER_MS) {
      throw new RangeError(`approvals: graceMs must be in [0, ${MAX_TIMER_MS}], got ${opts.graceMs}`);
    }
    this.#clock = opts.clock ?? realClock;
    this.#ttlMs = opts.ttlMs;
    this.#graceMs = opts.graceMs;
    this.#newId = opts.newId ?? defaultNewId;
    this.#onEvent = opts.onEvent;
  }

  /**
   * Ask for permission. Resolves when the head-of-queue rules settle it; never
   * rejects except when the id source is broken (the caller must treat a rejection
   * as a refusal, which the permission handler does).
   */
  request(
    view: { label: string; risk: Risk; summary: string },
    opts?: { signal?: AbortSignal },
  ): Promise<ApprovalOutcome> {
    const signal = opts?.signal;
    // Never enqueued, so no event: the open count did not change.
    if (signal?.aborted) return Promise.resolve({ allow: false, reason: 'abort' });

    return new Promise<ApprovalOutcome>((resolve) => {
      const entry: Entry = {
        id: this.#freshId(),
        // The last stop before the panel: the tools layer already did this, and it is
        // idempotent, so doing it again costs nothing and protects against a caller
        // that did not. An unknown risk is shown as the most alarming one.
        label: sanitize(typeof view.label === 'string' ? view.label : '', LIMITS.labelMax) || 'tool',
        risk: RISKS.includes(view.risk) ? view.risk : 'high',
        // A blank approval prompt invites a blind tap.
        summary: sanitize(typeof view.summary === 'string' ? view.summary : '', LIMITS.summaryMax) || '(no details)',
        resolve,
        signal,
        onAbort: undefined,
        ttl: undefined,
        deadline: 0,
      };
      if (signal) {
        entry.onAbort = () => this.#close([entry], { allow: false, reason: 'abort' }, 'abort');
        signal.addEventListener('abort', entry.onAbort, { once: true });
      }
      this.#queue.push(entry);
      const events: ApprovalEvent[] = [];
      if (this.#queue.length === 1) this.#present(entry, events);
      events.push({ k: 'pending', count: this.#queue.length });
      this.#syncGrace();
      this.#emit(events);
    });
  }

  /**
   * The device's tap. Accepted ONLY for the id of the current head; every other
   * string (never issued, already answered, timed out, still waiting, different
   * case, empty, from another process) is 'unknown' and changes nothing. That is
   * what makes a late answer harmless.
   */
  answer(id: string, ok: boolean): 'accepted' | 'unknown' {
    const head = this.#queue[0];
    if (head === undefined || typeof id !== 'string' || id !== head.id) return 'unknown';
    // Strictly `true` grants. A truthy non-boolean from a sloppy caller is a refusal.
    this.#close([head], ok === true ? { allow: true } : { allow: false, reason: 'denied' }, 'answered');
    return 'accepted';
  }

  deviceConnected(): void {
    this.#connected = true;
    this.#syncGrace();
  }

  deviceDisconnected(): void {
    this.#connected = false;
    this.#syncGrace();
  }

  /** The open head ask with its REMAINING time, for replay to a reconnecting device. */
  current(): AskInfo | undefined {
    const head = this.#queue[0];
    return head === undefined ? undefined : this.#info(head);
  }

  /** Open asks, including the head. */
  pendingCount(): number {
    return this.#queue.length;
  }

  cancelAll(_reason: 'abort'): void {
    this.#close([...this.#queue], { allow: false, reason: 'abort' }, 'abort');
  }

  // ---------------------------------------------------------------------------

  #freshId(): string {
    for (let i = 0; i < ID_RETRIES; i++) {
      const id = this.#newId();
      // '' would make answer('') match; refuse it rather than hand it out.
      if (typeof id !== 'string' || id === '') throw new Error('approvals: newId must return a non-empty string');
      // A duplicate of anything still open would let one tap answer two asks.
      if (!this.#queue.some((e) => e.id === id)) return id;
    }
    throw new Error('approvals: newId kept returning ids that are already open');
  }

  #info(e: Entry): AskInfo {
    const left = Math.ceil((e.deadline - this.#clock.now()) / 1000);
    return { id: e.id, label: e.label, risk: e.risk, summary: e.summary, ttlSec: Math.max(1, left) };
  }

  /** Make `e` the head: start its clock and announce it. TTL never runs for a waiting request. */
  #present(e: Entry, events: ApprovalEvent[]): void {
    e.deadline = this.#clock.now() + this.#ttlMs;
    e.ttl = this.#clock.setTimeout(
      () => this.#close([e], { allow: false, reason: 'timeout' }, 'timeout'),
      this.#ttlMs,
    );
    events.push({ k: 'ask', ask: this.#info(e) });
  }

  /**
   * The single choke point for ending requests. Entries that are no longer open
   * are ignored, so a stale timer or a second abort is a no-op by construction
   * rather than by every caller remembering to check.
   */
  #close(victims: Entry[], outcome: ApprovalOutcome, why: AskEndReason): void {
    const open = victims.filter((v) => this.#queue.includes(v));
    if (open.length === 0) return;

    const oldHead = this.#queue[0];
    for (const v of open) this.#detach(v);

    const events: ApprovalEvent[] = [];
    if (oldHead !== undefined && open.includes(oldHead)) events.push({ k: 'end', id: oldHead.id, why });
    const head = this.#queue[0];
    if (head !== undefined && head !== oldHead) this.#present(head, events);
    events.push({ k: 'pending', count: this.#queue.length });

    this.#syncGrace();
    for (const v of open) v.resolve(outcome);
    this.#emit(events);
  }

  #detach(e: Entry): void {
    if (e.ttl !== undefined) {
      this.#clock.clearTimeout(e.ttl);
      e.ttl = undefined;
    }
    if (e.signal !== undefined && e.onAbort !== undefined) e.signal.removeEventListener('abort', e.onAbort);
    const i = this.#queue.indexOf(e);
    if (i >= 0) this.#queue.splice(i, 1);
  }

  /** The grace timer runs exactly when something is open and no device is connected. */
  #syncGrace(): void {
    const needed = !this.#connected && this.#queue.length > 0;
    if (needed && this.#grace === undefined) {
      const token: { handle: TimerHandle } = { handle: undefined };
      token.handle = this.#clock.setTimeout(() => this.#onGrace(token), this.#graceMs);
      this.#grace = token;
    } else if (!needed && this.#grace !== undefined) {
      this.#clock.clearTimeout(this.#grace.handle);
      this.#grace = undefined;
    }
  }

  #onGrace(token: { handle: TimerHandle }): void {
    if (this.#grace !== token) return; // cancelled, or superseded by a newer grace period
    this.#grace = undefined;
    this.#close([...this.#queue], { allow: false, reason: 'disconnect' }, 'disconnect');
  }

  #emit(events: ApprovalEvent[]): void {
    this.#outbox.push(...events);
    if (this.#draining) return; // the outer delivery loop will get to them, in causal order
    this.#draining = true;
    let failure: { err: unknown } | undefined;
    try {
      for (let e = this.#outbox.shift(); e !== undefined; e = this.#outbox.shift()) {
        try {
          this.#onEvent(e);
        } catch (err) {
          failure ??= { err };
        }
      }
    } finally {
      this.#draining = false;
    }
    if (failure) throw failure.err;
  }
}
