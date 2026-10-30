/**
 * Speech-to-text adapters. The bridge never assumes an engine (types.ts SttAdapter), and
 * ships none: a real one (whisper.cpp, a vendor API) is a later, separate decision.
 *
 * What lives here is the two adapters everything else needs today: the default, which
 * says plainly that there is no engine, and a scripted one for tests and the fake device.
 */

import type { SttAdapter } from './types.ts';

/**
 * Thrown by an adapter that has no engine at all, as opposed to one that failed on this
 * utterance. The server tells the device the difference (`stt_unavailable` means "fall back
 * to typing and stop trying", `stt_failed` means "try again"), and a class is a sturdier
 * way to say so than matching on message text.
 */
export class SttUnavailableError extends Error {
  constructor(message = 'no speech-to-text engine is configured') {
    super(message);
    this.name = 'SttUnavailableError';
  }
}

/** The default adapter: every attempt says there is nothing to listen with. */
export class UnavailableStt implements SttAdapter {
  transcribe(_pcm: Buffer): Promise<string> {
    return Promise.reject(new SttUnavailableError());
  }
}

export type SttScript = string | ((pcm: Buffer, call: number) => string | Promise<string>);

/**
 * Returns what it was told to, whatever the audio. For tests (so the whole push-to-talk
 * path can run with no engine) and for the fake device (so the desktop demo can dictate).
 * It records what it was given, so a test can prove the audio reached the adapter intact.
 */
export class ScriptedStt implements SttAdapter {
  readonly #script: SttScript;
  /** Byte length of the audio handed to each call, in order. */
  readonly received: number[] = [];

  constructor(script: SttScript) {
    this.#script = script;
  }

  async transcribe(pcm: Buffer): Promise<string> {
    this.received.push(pcm.length);
    const s = this.#script;
    return typeof s === 'string' ? s : s(pcm, this.received.length);
  }
}
