/**
 * ApprovalManager tests.
 *
 * Every test here drives the real manager with a fake Clock; nothing sleeps. The
 * rules are the safety argument for the whole bridge, so each guard is paired with a
 * test that proves the mechanism ENGAGED (a guard phrased as "X never happens" passes
 * vacuously if X is impossible for another reason), and each was negative-checked by
 * breaking the source on purpose.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { ApprovalManager } from '../src/approvals.ts';
import type { ApprovalEvent, ApprovalOutcome } from '../src/approvals.ts';
import { LIMITS } from '../src/types.ts';
import type { Clock, Risk, TimerHandle } from '../src/types.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A clock that only moves when told to, and can say how many timers are armed. */
class FakeClock implements Clock {
  t = 1_000_000;
  /** A leaky clock ignores clearTimeout, to prove the manager does not rely on cancellation alone. */
  readonly leaky: boolean;
  #seq = 0;
  #live = new Map<number, { at: number; fn: () => void }>();

  constructor(leaky = false) {
    this.leaky = leaky;
  }
  now(): number {
    return this.t;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = ++this.#seq;
    this.#live.set(id, { at: this.t + ms, fn });
    return id;
  }
  clearTimeout(h: TimerHandle): void {
    if (!this.leaky) this.#live.delete(h as number);
  }
  get armed(): number {
    return this.#live.size;
  }
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let best: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.#live) {
        if (e[1].at > target) continue;
        if (best === undefined || e[1].at < best[1].at || (e[1].at === best[1].at && e[0] < best[0])) best = e;
      }
      if (best === undefined) break;
      this.#live.delete(best[0]);
      this.t = Math.max(this.t, best[1].at);
      best[1].fn();
    }
    this.t = target;
  }
}

const id = (n: number): string => n.toString(16).padStart(8, '0');
const counterIds = (): (() => string) => {
  let n = 0;
  return () => id(++n);
};
const view = (label = 'Bash', summary = 'npm test', risk: Risk = 'med') => ({ label, risk, summary });

const PENDING = Symbol('pending');
/** Resolves to the promise's value if it has already settled, else PENDING. */
const peek = <T>(p: Promise<T>): Promise<T | typeof PENDING> => Promise.race([p, Promise.resolve(PENDING)]);

interface Rig {
  mgr: ApprovalManager;
  clock: FakeClock;
  events: ApprovalEvent[];
}
interface RigOpts {
  ttlMs?: number;
  graceMs?: number;
  connected?: boolean;
  leaky?: boolean;
  newId?: () => string;
  onEvent?: (e: ApprovalEvent, r: Rig) => void;
}
function rig(o: RigOpts = {}): Rig {
  const clock = new FakeClock(o.leaky ?? false);
  const events: ApprovalEvent[] = [];
  const r = { clock, events } as Rig;
  r.mgr = new ApprovalManager({
    clock,
    ttlMs: o.ttlMs ?? 60_000,
    graceMs: o.graceMs ?? 10_000,
    newId: o.newId ?? counterIds(),
    onEvent: (e) => {
      events.push(e);
      o.onEvent?.(e, r);
    },
  });
  if (o.connected !== false) r.mgr.deviceConnected();
  return r;
}

/** One short string per event, so an ordering assertion is one deepEqual. */
const trace = (events: ApprovalEvent[]): string[] =>
  events.map((e) => (e.k === 'ask' ? `ask:${e.ask.id}` : e.k === 'end' ? `end:${e.id}:${e.why}` : `pending:${e.count}`));

const snapshot = (r: Rig): string =>
  JSON.stringify({ current: r.mgr.current(), pending: r.mgr.pendingCount(), events: r.events.length, armed: r.clock.armed });

// ---------------------------------------------------------------------------
// Basic flow
// ---------------------------------------------------------------------------

test('a request is presented and resolves only through answer()', async () => {
  const r = rig();
  const p = r.mgr.request(view('Bash', 'npm test', 'med'));

  assert.deepEqual(trace(r.events), [`ask:${id(1)}`, 'pending:1']);
  assert.deepEqual(r.mgr.current(), { id: id(1), label: 'Bash', risk: 'med', summary: 'npm test', ttlSec: 60 });
  assert.equal(r.mgr.pendingCount(), 1);
  assert.equal(await peek(p), PENDING, 'nothing but a tap, a timeout, an abort or a disconnect may settle it');

  assert.equal(r.mgr.answer(id(1), true), 'accepted');
  assert.deepEqual(await p, { allow: true });
  assert.deepEqual(trace(r.events.slice(2)), [`end:${id(1)}:answered`, 'pending:0']);
  assert.equal(r.mgr.current(), undefined);
  assert.equal(r.mgr.pendingCount(), 0);
});

test('a denial carries reason "denied", and a non-boolean answer is a denial, never a grant', async () => {
  const r = rig();
  const p = r.mgr.request(view());
  assert.equal(r.mgr.answer(id(1), false), 'accepted');
  assert.deepEqual(await p, { allow: false, reason: 'denied' });

  const q = r.mgr.request(view());
  // A sloppy caller handing over a truthy non-boolean must not approve anything.
  assert.equal(r.mgr.answer(id(2), 'yes' as unknown as boolean), 'accepted');
  assert.deepEqual(await q, { allow: false, reason: 'denied' });
});

// ---------------------------------------------------------------------------
// FIFO and the head-only rule
// ---------------------------------------------------------------------------

test('FIFO: only the head is presented, waiting ids are refused, and the next head follows in order', async () => {
  const r = rig();
  const a = r.mgr.request(view('A'));
  const b = r.mgr.request(view('B'));
  const c = r.mgr.request(view('C'));

  assert.deepEqual(trace(r.events), [`ask:${id(1)}`, 'pending:1', 'pending:2', 'pending:3']);
  assert.equal(r.mgr.pendingCount(), 3);
  assert.equal(r.mgr.current()?.label, 'A');

  // The test knows B's and C's ids only because it injected the counter. A device never would;
  // even so, the manager must refuse them until they are the head.
  const before = snapshot(r);
  assert.equal(r.mgr.answer(id(2), true), 'unknown');
  assert.equal(r.mgr.answer(id(3), true), 'unknown');
  assert.equal(snapshot(r), before, 'refusing a waiting id changes nothing');
  assert.equal(await peek(b), PENDING);
  assert.equal(await peek(c), PENDING);

  assert.equal(r.mgr.answer(id(1), true), 'accepted');
  assert.deepEqual(trace(r.events.slice(4)), [`end:${id(1)}:answered`, `ask:${id(2)}`, 'pending:2']);
  assert.equal(r.mgr.current()?.label, 'B');

  assert.equal(r.mgr.answer(id(2), false), 'accepted');
  assert.equal(r.mgr.current()?.label, 'C');
  assert.equal(r.mgr.answer(id(3), true), 'accepted');

  assert.deepEqual(await a, { allow: true });
  assert.deepEqual(await b, { allow: false, reason: 'denied' });
  assert.deepEqual(await c, { allow: true });
});

// ---------------------------------------------------------------------------
// Unknown and late answers
// ---------------------------------------------------------------------------

test('answer() is accepted only for the head id: everything else is unknown and changes nothing', async () => {
  const ids = ['abc12345', 'def67890'];
  const r = rig({ newId: () => ids.shift()! });
  const a = r.mgr.request(view('A'));
  const b = r.mgr.request(view('B'));

  const wrong: [string, string][] = [
    ['never issued', 'ffffffff'],
    ['empty', ''],
    ['wrong case', 'ABC12345'],
    ['truncated', 'abc1234'],
    ['padded', 'abc12345 '],
    ['extended', 'abc123456'],
    ['waiting but not head', 'def67890'],
    ['from another process', 'a1b2c3d4'],
  ];
  for (const [why, x] of wrong) {
    const before = snapshot(r);
    assert.equal(r.mgr.answer(x, true), 'unknown', why);
    assert.equal(snapshot(r), before, `${why}: state must be untouched`);
  }
  assert.equal(await peek(a), PENDING);
  assert.equal(await peek(b), PENDING);

  // Companion: the guard is not simply refusing everything.
  assert.equal(r.mgr.answer('abc12345', true), 'accepted');
  assert.deepEqual(await a, { allow: true });

  // Already answered: the old id is dead, and it did not become B's.
  const before = snapshot(r);
  assert.equal(r.mgr.answer('abc12345', true), 'unknown');
  assert.equal(snapshot(r), before);
  assert.equal(await peek(b), PENDING);
  assert.equal(r.mgr.answer('def67890', false), 'accepted');
});

test('an id from a previous process is unknown to a fresh manager', () => {
  const old = rig({ newId: () => 'aaaaaaaa' });
  old.mgr.request(view());
  const fresh = rig({ newId: () => 'bbbbbbbb' });
  void fresh.mgr.request(view());
  assert.equal(fresh.mgr.answer('aaaaaaaa', true), 'unknown');
  assert.equal(fresh.mgr.pendingCount(), 1);
});

test('a late answer for a timed-out ask cannot land on the next ask', async () => {
  const r = rig({ ttlMs: 60_000 });
  const a = r.mgr.request(view('A'));
  const b = r.mgr.request(view('B'));

  r.clock.advance(60_000);
  assert.deepEqual(await a, { allow: false, reason: 'timeout' });
  assert.deepEqual(trace(r.events.slice(3)), [`end:${id(1)}:timeout`, `ask:${id(2)}`, 'pending:1']);

  // The tap that was meant for A arrives now. B is the head; it must not be approved.
  assert.equal(r.mgr.answer(id(1), true), 'unknown');
  assert.equal(await peek(b), PENDING);
  assert.equal(r.mgr.current()?.id, id(2));
  assert.equal(r.mgr.answer(id(2), true), 'accepted');
  assert.deepEqual(await b, { allow: true });
});

// ---------------------------------------------------------------------------
// TTL
// ---------------------------------------------------------------------------

test('TTL expiry: open one millisecond before, timeout exactly at the deadline', async () => {
  const r = rig({ ttlMs: 60_000 });
  const p = r.mgr.request(view());
  r.clock.advance(59_999);
  assert.equal(await peek(p), PENDING);
  assert.equal(r.mgr.pendingCount(), 1);
  r.clock.advance(1);
  assert.deepEqual(await p, { allow: false, reason: 'timeout' });
  assert.deepEqual(trace(r.events.slice(2)), [`end:${id(1)}:timeout`, 'pending:0']);
});

test('TTL starts when a request becomes the head, not when it is queued', async () => {
  const r = rig({ ttlMs: 60_000 });
  const a = r.mgr.request(view('A'));
  r.clock.advance(10_000);
  const b = r.mgr.request(view('B')); // queued at t=10s
  r.clock.advance(20_000); // t=30s
  assert.equal(r.mgr.answer(id(1), true), 'accepted');
  assert.deepEqual(await a, { allow: true });
  assert.equal(r.mgr.current()?.ttlSec, 60, 'B starts with the full TTL when it becomes the head');

  r.clock.advance(59_999); // t=89.999s: queue-time TTL would have expired B at t=70s
  assert.equal(await peek(b), PENDING);
  r.clock.advance(1);
  assert.deepEqual(await b, { allow: false, reason: 'timeout' });
});

test('a waiting request has no timer of its own', () => {
  const r = rig();
  void r.mgr.request(view('A'));
  void r.mgr.request(view('B'));
  void r.mgr.request(view('C'));
  assert.equal(r.clock.armed, 1, 'device connected: exactly the head TTL');
});

test('TTL runs whether or not a device is connected', async () => {
  for (const connected of [true, false]) {
    const r = rig({ ttlMs: 30_000, graceMs: 120_000, connected });
    const p = r.mgr.request(view());
    r.clock.advance(30_000);
    assert.deepEqual(await p, { allow: false, reason: 'timeout' }, `connected=${connected}`);
  }
});

test('ttlSec is the remaining time, rounded up, never below 1', () => {
  const r = rig({ ttlMs: 60_000 });
  void r.mgr.request(view());
  assert.equal((r.events[0] as { k: 'ask'; ask: { ttlSec: number } }).ask.ttlSec, 60);
  assert.equal(r.mgr.current()?.ttlSec, 60);
  r.clock.advance(500);
  assert.equal(r.mgr.current()?.ttlSec, 60, 'ceil(59.5)');
  r.clock.advance(500);
  assert.equal(r.mgr.current()?.ttlSec, 59);
  r.clock.advance(58_000 + 400); // 0.1 s left
  assert.equal(r.mgr.current()?.ttlSec, 1);
  // Past the deadline but the timer has not run yet (a lagging event loop): still >= 1 while open.
  r.clock.t += 5_000;
  assert.equal(r.mgr.pendingCount(), 1);
  assert.equal(r.mgr.current()?.ttlSec, 1);

  const odd = rig({ ttlMs: 1_500 });
  void odd.mgr.request(view());
  assert.equal(odd.mgr.current()?.ttlSec, 2);
});

test('a stale timer that fires after its ask ended does nothing, and cannot time out the next head', async () => {
  // clearTimeout is ignored here, so A's TTL callback WILL run after A was answered.
  const r = rig({ ttlMs: 60_000, leaky: true });
  const a = r.mgr.request(view('A'));
  const b = r.mgr.request(view('B'));
  r.clock.advance(30_000);
  assert.equal(r.mgr.answer(id(1), true), 'accepted'); // B becomes head at t=30s, deadline t=90s
  assert.deepEqual(await a, { allow: true });

  const n = r.events.length;
  r.clock.advance(30_000); // t=60s: A's leaked TTL fires now
  assert.equal(r.events.length, n, 'a stale timer must not emit anything');
  assert.equal(await peek(b), PENDING, 'and must not touch the new head');
  assert.equal(r.mgr.current()?.id, id(2));

  // Companion: B's own, live TTL still works.
  r.clock.advance(30_000);
  assert.deepEqual(await b, { allow: false, reason: 'timeout' });
});

test('a stale grace timer cannot deny requests after the device came back', async () => {
  const r = rig({ graceMs: 10_000, leaky: true, connected: false });
  const p = r.mgr.request(view());
  r.mgr.deviceConnected(); // cancels, but the leaky clock still holds the callback
  r.clock.advance(10_000);
  assert.equal(await peek(p), PENDING, 'the device is connected: nothing may deny on its behalf');
  assert.equal(r.mgr.pendingCount(), 1);
});

// ---------------------------------------------------------------------------
// Disconnect: fail closed
// ---------------------------------------------------------------------------

test('the device starts away: a request with nobody connected is denied after the grace period', async () => {
  const r = rig({ connected: false, graceMs: 10_000, ttlMs: 60_000 });
  const p = r.mgr.request(view());
  assert.equal(r.clock.armed, 2, 'head TTL plus the grace timer');
  r.clock.advance(9_999);
  assert.equal(await peek(p), PENDING, 'the grace period is a grace period');
  r.clock.advance(1);
  assert.deepEqual(await p, { allow: false, reason: 'disconnect' });
  assert.deepEqual(trace(r.events.slice(2)), [`end:${id(1)}:disconnect`, 'pending:0']);
  assert.equal(r.clock.armed, 0);
});

test('companion: with a device connected the same wait denies nothing', async () => {
  const r = rig({ connected: true, graceMs: 10_000, ttlMs: 60_000 });
  const p = r.mgr.request(view());
  assert.equal(r.clock.armed, 1, 'no grace timer while the device is here');
  r.clock.advance(50_000); // five grace periods
  assert.equal(await peek(p), PENDING);
  assert.equal(r.mgr.pendingCount(), 1);
});

test('grace expiry denies every open request, ends only the exposed head, and reports one pending count', async () => {
  const r = rig({ connected: false, graceMs: 5_000 });
  const ps = [r.mgr.request(view('A')), r.mgr.request(view('B')), r.mgr.request(view('C'))];
  const n = r.events.length;
  r.clock.advance(5_000);
  for (const p of ps) assert.deepEqual(await p, { allow: false, reason: 'disconnect' });
  assert.deepEqual(trace(r.events.slice(n)), [`end:${id(1)}:disconnect`, 'pending:0']);
  assert.equal(r.mgr.pendingCount(), 0);
  assert.equal(r.clock.armed, 0);
});

test('the ask TTL keeps running during the grace period and can win it', async () => {
  const r = rig({ connected: false, graceMs: 60_000, ttlMs: 20_000 });
  const p = r.mgr.request(view());
  r.clock.advance(20_000);
  assert.deepEqual(await p, { allow: false, reason: 'timeout' });
  assert.equal(r.clock.armed, 0, 'and the grace timer went with the last request');
});

test('deviceConnected() cancels the grace timer', async () => {
  const r = rig({ connected: false, graceMs: 10_000, ttlMs: 60_000 });
  const p = r.mgr.request(view());
  r.clock.advance(6_000);
  r.mgr.deviceConnected();
  assert.equal(r.clock.armed, 1, 'only the TTL is left');
  r.clock.advance(30_000);
  assert.equal(await peek(p), PENDING);
  assert.equal(r.mgr.answer(id(1), true), 'accepted');
});

test('deviceDisconnected() starts the grace timer only if something is open, from that moment', async () => {
  const r = rig({ connected: true, graceMs: 10_000, ttlMs: 60_000 });
  r.mgr.deviceDisconnected();
  assert.equal(r.clock.armed, 0, 'nothing open: nothing to time');

  r.mgr.deviceConnected();
  const p = r.mgr.request(view());
  r.clock.advance(5_000);
  r.mgr.deviceDisconnected(); // grace runs from t=5s
  r.clock.advance(9_999);
  assert.equal(await peek(p), PENDING, 'ten seconds after the disconnect, not after the request');
  r.clock.advance(1);
  assert.deepEqual(await p, { allow: false, reason: 'disconnect' });
});

test('a second request does not extend the grace period, and repeated disconnects do not either', async () => {
  const r = rig({ connected: false, graceMs: 10_000, ttlMs: 60_000 });
  const a = r.mgr.request(view('A'));
  r.clock.advance(6_000);
  const b = r.mgr.request(view('B'));
  r.mgr.deviceDisconnected();
  r.mgr.deviceDisconnected();
  r.clock.advance(4_000); // 10 s after A
  assert.deepEqual(await a, { allow: false, reason: 'disconnect' });
  assert.deepEqual(await b, { allow: false, reason: 'disconnect' });
});

test('a flapping device gets a fresh full grace period each time it leaves', async () => {
  const r = rig({ connected: true, graceMs: 10_000, ttlMs: 60_000 });
  const p = r.mgr.request(view());
  r.mgr.deviceDisconnected();
  r.clock.advance(9_000);
  r.mgr.deviceConnected();
  r.mgr.deviceDisconnected();
  r.clock.advance(9_999);
  assert.equal(await peek(p), PENDING);
  r.clock.advance(1);
  assert.deepEqual(await p, { allow: false, reason: 'disconnect' });
});

test('after a disconnect denial a new request while still away starts a new grace period', async () => {
  const r = rig({ connected: false, graceMs: 5_000 });
  const a = r.mgr.request(view('A'));
  r.clock.advance(5_000);
  assert.deepEqual(await a, { allow: false, reason: 'disconnect' });
  const b = r.mgr.request(view('B'));
  assert.equal(r.clock.armed, 2);
  r.clock.advance(5_000);
  assert.deepEqual(await b, { allow: false, reason: 'disconnect' });
  // And the first ask's id stays dead.
  assert.equal(r.mgr.answer(id(1), true), 'unknown');
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

test('a signal already aborted resolves "abort" at once, enqueues nothing and emits nothing', async () => {
  const r = rig();
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await r.mgr.request(view(), { signal: ac.signal }), { allow: false, reason: 'abort' });
  assert.equal(r.mgr.pendingCount(), 0);
  assert.equal(r.events.length, 0);
  assert.equal(r.clock.armed, 0);
});

test('aborting the head ends it, promotes the next, and drops the signal listener', async () => {
  const r = rig();
  const ac = new AbortController();
  const a = r.mgr.request(view('A'), { signal: ac.signal });
  const b = r.mgr.request(view('B'));
  assert.equal(getEventListeners(ac.signal, 'abort').length, 1, 'the listener is registered');
  const n = r.events.length;

  ac.abort();
  assert.deepEqual(await a, { allow: false, reason: 'abort' });
  assert.deepEqual(trace(r.events.slice(n)), [`end:${id(1)}:abort`, `ask:${id(2)}`, 'pending:1']);
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  assert.equal(await peek(b), PENDING);
  assert.equal(r.mgr.answer(id(1), true), 'unknown', 'a tap for the aborted ask is late');
  assert.equal(r.mgr.answer(id(2), true), 'accepted');
});

test('aborting a waiting request removes it silently: its id was never exposed, so there is no end event', async () => {
  const r = rig();
  const ac = new AbortController();
  const a = r.mgr.request(view('A'));
  const b = r.mgr.request(view('B'), { signal: ac.signal });
  const n = r.events.length;

  ac.abort();
  assert.deepEqual(await b, { allow: false, reason: 'abort' });
  assert.deepEqual(trace(r.events.slice(n)), ['pending:1']);
  assert.equal(r.mgr.current()?.id, id(1), 'the head is untouched');
  assert.equal(await peek(a), PENDING);
  assert.equal(r.mgr.answer(id(1), true), 'accepted');
});

test('an abort after the request was answered changes nothing (the listener is gone)', async () => {
  const r = rig();
  const ac = new AbortController();
  const p = r.mgr.request(view(), { signal: ac.signal });
  assert.equal(r.mgr.answer(id(1), true), 'accepted');
  assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  const n = r.events.length;
  ac.abort();
  assert.deepEqual(await p, { allow: true });
  assert.equal(r.events.length, n);
});

test('cancelAll("abort") denies everything, emits one end and one pending(0), and is a no-op when empty', async () => {
  const r = rig();
  r.mgr.cancelAll('abort');
  assert.equal(r.events.length, 0, 'nothing open, nothing to report');

  const ps = [r.mgr.request(view('A')), r.mgr.request(view('B')), r.mgr.request(view('C'))];
  const n = r.events.length;
  r.mgr.cancelAll('abort');
  for (const p of ps) assert.deepEqual(await p, { allow: false, reason: 'abort' });
  assert.deepEqual(trace(r.events.slice(n)), [`end:${id(1)}:abort`, 'pending:0']);
  assert.equal(r.mgr.pendingCount(), 0);
  assert.equal(r.clock.armed, 0);
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test('pending fires exactly when the open count changes', async () => {
  const r = rig();
  r.mgr.deviceConnected();
  r.mgr.deviceDisconnected();
  r.mgr.deviceConnected();
  assert.deepEqual(trace(r.events), [], 'connection changes alone say nothing');

  void r.mgr.request(view('A'));
  void r.mgr.request(view('B'));
  assert.deepEqual(trace(r.events), [`ask:${id(1)}`, 'pending:1', 'pending:2']);

  const n = r.events.length;
  r.mgr.answer('zzzzzzzz', true); // refused: count unchanged
  assert.equal(r.events.length, n);
});

test('events caused by a listener are delivered after the one being delivered, in causal order', async () => {
  // A listener that approves instantly. Without a delivery queue the nested end/pending(0)
  // overtakes the outer pending(1) and the device is left believing one ask is still open.
  const r = rig({
    onEvent: (e, rr) => {
      if (e.k === 'ask') rr.mgr.answer(e.ask.id, true);
    },
  });
  const p = r.mgr.request(view());
  assert.deepEqual(await p, { allow: true });
  assert.deepEqual(trace(r.events), [`ask:${id(1)}`, 'pending:1', `end:${id(1)}:answered`, 'pending:0']);
  assert.equal(r.mgr.pendingCount(), 0, 'and the LAST pending the device hears agrees with that');
});

test('state is already updated when a listener runs: current() shows the new head', async () => {
  const seen: (string | undefined)[] = [];
  const r = rig({ onEvent: (e, rr) => e.k === 'end' && seen.push(rr.mgr.current()?.id) });
  void r.mgr.request(view('A'));
  void r.mgr.request(view('B'));
  r.mgr.answer(id(1), true);
  assert.deepEqual(seen, [id(2)]);
});

test('a throwing listener does not wedge the manager: the outcome stands, the rest is delivered, the error surfaces', async () => {
  let armed = true;
  const r = rig({
    onEvent: (e) => {
      if (e.k === 'end' && armed) {
        armed = false;
        throw new Error('sink broke');
      }
    },
  });
  const a = r.mgr.request(view('A'));
  void r.mgr.request(view('B'));
  assert.throws(() => r.mgr.answer(id(1), true), /sink broke/);
  assert.deepEqual(await a, { allow: true }, 'the tap still counted');
  assert.deepEqual(trace(r.events.slice(3)), [`end:${id(1)}:answered`, `ask:${id(2)}`, 'pending:1'], 'later events were still delivered');
  assert.equal(r.mgr.current()?.id, id(2));
  assert.equal(r.mgr.answer(id(2), true), 'accepted', 'and it keeps working');
  assert.equal(r.clock.armed, 0);
});

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

test('default ids are LIMITS.idLen lowercase hex characters and are not a counter', async () => {
  const events: ApprovalEvent[] = [];
  const clock = new FakeClock();
  const mgr = new ApprovalManager({ clock, ttlMs: 60_000, graceMs: 10_000, onEvent: (e) => events.push(e) });
  mgr.deviceConnected();
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const p = mgr.request(view());
    const cur = mgr.current()!;
    assert.match(cur.id, new RegExp(`^[0-9a-f]{${LIMITS.idLen}}$`));
    seen.add(cur.id);
    mgr.answer(cur.id, true);
    await p;
  }
  // 100 draws from 2^32 collide about once in a million runs; two collisions are about once in 10^12.
  assert.ok(seen.size >= 99, `ids repeat: ${seen.size} distinct of 100`);
  const nums = [...seen].map((s) => parseInt(s, 16));
  const steps = new Set(nums.slice(1).map((n, i) => n - nums[i]!));
  assert.ok(steps.size > 50, 'consecutive ids are not a fixed-step sequence');
});

test('an id that is already open is never handed out again; the late answer for the first cannot hit the second', async () => {
  const queue = ['same0001', 'same0001', 'same0001', 'fresh001'];
  const calls: string[] = [];
  const r = rig({ newId: () => { const x = queue.shift()!; calls.push(x); return x; } });
  const a = r.mgr.request(view('A'));
  const b = r.mgr.request(view('B'));
  assert.deepEqual(calls, ['same0001', 'same0001', 'same0001', 'fresh001'], 'newId was retried until it was unique');

  assert.equal(r.mgr.answer('same0001', true), 'accepted');
  assert.deepEqual(await a, { allow: true });
  assert.equal(r.mgr.current()?.id, 'fresh001');
  // A duplicated tap for A: if B had inherited A's id this would approve B.
  assert.equal(r.mgr.answer('same0001', true), 'unknown');
  assert.equal(await peek(b), PENDING);
});

test('a broken id source rejects the request and leaves nothing behind', async () => {
  const dup = rig({ newId: () => 'same0001' });
  void dup.mgr.request(view('A'));
  const before = snapshot(dup);
  await assert.rejects(dup.mgr.request(view('B')), /already open/);
  assert.equal(snapshot(dup), before, 'the failed request enqueued nothing and armed nothing');

  for (const bad of ['', undefined, 42, null]) {
    const r = rig({ newId: () => bad as unknown as string });
    await assert.rejects(r.mgr.request(view()), /non-empty string/, String(bad));
    assert.equal(r.mgr.pendingCount(), 0);
    assert.equal(r.clock.armed, 0);
  }
  const thrower = rig({ newId: () => { throw new Error('entropy gone'); } });
  await assert.rejects(thrower.mgr.request(view()), /entropy gone/);
  assert.equal(thrower.mgr.pendingCount(), 0);
  assert.equal(thrower.clock.armed, 0);
});

// ---------------------------------------------------------------------------
// Timers
// ---------------------------------------------------------------------------

test('no timer is armed once nothing is open, by any way of ending', async () => {
  const endings: [string, (r: Rig) => Promise<void>][] = [
    ['answered', async (r) => { const p = r.mgr.request(view()); r.mgr.answer(id(1), true); await p; }],
    ['answered while away', async (r) => { r.mgr.deviceDisconnected(); const p = r.mgr.request(view()); r.mgr.answer(id(1), false); await p; }],
    ['timeout', async (r) => { const p = r.mgr.request(view()); r.clock.advance(60_000); await p; }],
    ['abort head', async (r) => { const ac = new AbortController(); const p = r.mgr.request(view(), { signal: ac.signal }); ac.abort(); await p; }],
    ['abort waiting', async (r) => {
      const ac = new AbortController();
      const a = r.mgr.request(view()); const b = r.mgr.request(view(), { signal: ac.signal });
      ac.abort(); await b; r.mgr.answer(id(1), true); await a;
    }],
    ['cancelAll', async (r) => { const ps = [r.mgr.request(view()), r.mgr.request(view())]; r.mgr.cancelAll('abort'); await Promise.all(ps); }],
    ['grace expiry', async (r) => { r.mgr.deviceDisconnected(); const p = r.mgr.request(view()); r.clock.advance(10_000); await p; }],
    ['disconnect then reconnect then answer', async (r) => { const p = r.mgr.request(view()); r.mgr.deviceDisconnected(); r.mgr.deviceConnected(); r.mgr.answer(id(1), true); await p; }],
    ['aborted before enqueue', async (r) => { const ac = new AbortController(); ac.abort(); await r.mgr.request(view(), { signal: ac.signal }); }],
  ];
  for (const [name, run] of endings) {
    const r = rig();
    await run(r);
    assert.equal(r.mgr.pendingCount(), 0, `${name}: nothing open`);
    assert.equal(r.clock.armed, 0, `${name}: no timer left armed`);
  }
});

test('companion: timers ARE armed while something is open, so the leak check above is not vacuous', () => {
  const connected = rig();
  void connected.mgr.request(view());
  assert.ok(connected.clock.armed >= 1);
  const away = rig({ connected: false });
  void away.mgr.request(view());
  assert.equal(away.clock.armed, 2);
});

// ---------------------------------------------------------------------------
// What reaches the panel, and construction
// ---------------------------------------------------------------------------

test('the manager re-applies the panel text rules: ASCII, length limits, no blank prompt, unknown risk is high', () => {
  const r = rig();
  void r.mgr.request({ label: 'Bäsh\u{1F600}x'.repeat(10), summary: 'é—'.repeat(200) + ' rm', risk: 'bogus' as Risk });
  const ask = r.mgr.current()!;
  assert.match(ask.label, /^[\x20-\x7e]+$/);
  assert.match(ask.summary, /^[\x20-\x7e]+$/);
  assert.ok(ask.label.length <= LIMITS.labelMax);
  assert.ok(ask.summary.length <= LIMITS.summaryMax);
  assert.equal(ask.risk, 'high');

  const blank = rig();
  void blank.mgr.request({ label: '', summary: '   ', risk: 'low' });
  assert.equal(blank.mgr.current()?.label, 'tool');
  assert.equal(blank.mgr.current()?.summary, '(no details)');

  // Idempotent on text that is already fine.
  const fine = rig();
  void fine.mgr.request({ label: 'Bash', summary: 'ls -la', risk: 'low' });
  assert.deepEqual(fine.mgr.current(), { id: id(1), label: 'Bash', summary: 'ls -la', risk: 'low', ttlSec: 60 });
});

test('construction refuses TTLs that would silently misbehave', () => {
  const mk = (ttlMs: number, graceMs: number) => () => new ApprovalManager({ ttlMs, graceMs, onEvent: () => {} });
  for (const ttl of [0, -1, NaN, Infinity, 2 ** 31]) assert.throws(mk(ttl, 1000), RangeError, `ttl ${ttl}`);
  for (const grace of [-1, NaN, Infinity, 2 ** 31]) assert.throws(mk(1000, grace), RangeError, `grace ${grace}`);
  assert.doesNotThrow(mk(2 ** 31 - 1, 0), 'the boundaries themselves are fine');
});

test('outcomes are exactly the documented shapes', async () => {
  const shapes: ApprovalOutcome[] = [];
  const r = rig();
  const p1 = r.mgr.request(view()); r.mgr.answer(id(1), true); shapes.push(await p1);
  const p2 = r.mgr.request(view()); r.mgr.answer(id(2), false); shapes.push(await p2);
  const p3 = r.mgr.request(view()); r.clock.advance(60_000); shapes.push(await p3);
  const p4 = r.mgr.request(view()); r.mgr.cancelAll('abort'); shapes.push(await p4);
  assert.deepEqual(shapes, [
    { allow: true },
    { allow: false, reason: 'denied' },
    { allow: false, reason: 'timeout' },
    { allow: false, reason: 'abort' },
  ]);
});
