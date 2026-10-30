/**
 * An interactive terminal stand-in for the handheld, so the whole loop can be tried at a
 * desk with no hardware: type a request, watch the pet's state change, approve or deny a
 * tool call, dictate through the push-to-talk path.
 *
 *   node tools/fake-device.ts --url ws://127.0.0.1:8787 --token <token>
 *
 * Input (one line at a time):
 *   plain text   send it as a prompt (`say`)
 *   /y  /n       allow or deny the ask that is open (the only way to approve anything)
 *   /a           abort the running turn
 *   /l           dictate: send a short burst of audio through the listen path
 *   /send        send the last thing heard as a prompt (the player's SEND tap)
 *   /q           quit
 *
 * A dictated transcript is only SHOWN: the bridge never runs it by itself. /send is the tap
 * that makes the device send it back as a `say`, exactly as the handheld's SEND button will.
 *
 * It is a thin shell over src/device-client.ts, which the end-to-end tests drive too, so
 * the code a person types into is the code the tests exercise.
 *
 * Exit status: 0 on /q or when input ends and the turn has finished, 2 if the bridge
 * refused the hello (wrong token, wrong version) or the arguments are unusable, 1 if the
 * connection could not be made or was lost. The terminal is always handed back: the
 * readline interface is closed on every path, which is what undoes raw mode on a tty.
 */

import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { DeviceClient, HelloRefused } from '../src/device-client.ts';
import type { CloseInfo } from '../src/device-client.ts';
import type { AskMsg, BridgeMsg, Phase } from '../src/types.ts';

export interface DeviceIo {
  out: (text: string) => void;
  err: (text: string) => void;
  input: NodeJS.ReadableStream;
  /** True for a real terminal: readline then handles Ctrl-C itself and echoes. */
  tty: boolean;
}

/** One small ASCII face per phase. Nothing here may need more than a 5x7 font. */
export const FACES: Readonly<Record<Phase, string>> = {
  idle: '(o_o)',
  listening: '(O_O)>',
  transcribing: '(o_o)..',
  thinking: '(-_-)?',
  tool: '(>_<)~',
  asking: '(O_O)!',
  speaking: '(^o^)',
  done: '(^_^)',
  error: '(x_x)',
};

const BELL = '\x07';
const HELP = [
  'Type a request and press enter to send it.',
  '  /y /n   allow or deny the open ask    /a  abort    /q  quit',
  '  /l      dictate (then /send to send what was heard)',
].join('\n');

const USAGE = `Usage: node tools/fake-device.ts [--url ws://127.0.0.1:8787] [--token <token>]
The token can also come from BRIDGE_TOKEN (preferred: arguments show up in 'ps').
`;

export interface DeviceArgs {
  url: string;
  token: string;
  help: boolean;
}

export function parseDeviceArgs(argv: string[], env: Record<string, string | undefined>): DeviceArgs | string {
  let values: ReturnType<typeof parseArgs>['values'];
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: { url: { type: 'string' }, token: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (err) {
    return `${(err instanceof Error ? err.message : String(err)).split(/\n|\. /)[0]?.replace(/\.$/, '')}.\n${USAGE}`;
  }
  const url = typeof values['url'] === 'string' ? values['url'] : 'ws://127.0.0.1:8787';
  const token = typeof values['token'] === 'string' ? values['token'] : (env['BRIDGE_TOKEN'] ?? '');
  const help = values['help'] === true;
  if (!help && token === '') return `No token. Pass --token or set BRIDGE_TOKEN.\n${USAGE}`;
  return { url, token, help };
}

function explainRefusal(why: string): string {
  switch (why) {
    case 'token':
      return 'the token was wrong';
    case 'version':
      return 'the bridge speaks a different protocol version';
    default:
      return 'the bridge did not accept the hello';
  }
}

function renderAsk(a: AskMsg): string {
  return [
    BELL,
    '==================================================',
    ` APPROVE?  ${a.tl}   risk: ${a.risk.toUpperCase()}   (id ${a.id})`,
    `   ${a.sum}`,
    ` ${a.ttl} s to answer:   /y allow    /n deny`,
    '==================================================',
  ].join('\n');
}

function render(m: BridgeMsg): string | undefined {
  switch (m.t) {
    case 'state':
      return `[${String(m.seq).padStart(3)}] ${FACES[m.ph]}  ${m.ph}${m.tl ? `: ${m.tl}` : ''}${m.pend > 0 ? `  (${m.pend} ask${m.pend === 1 ? '' : 's'} open)` : ''}`;
    case 'ask':
      return renderAsk(m);
    case 'ask_end':
      return `      ask ${m.id} ended: ${m.why}`;
    case 'result':
      return `RESULT (${m.ok ? 'ok' : 'failed'}): ${m.text}`;
    case 'stt':
      return `heard: "${m.text}"   (nothing runs until you /send it)`;
    case 'err':
      return `!! ${m.code}`;
    case 'pong':
    case 'hello_ack':
      return undefined;
  }
}

export async function runFakeDevice(
  argv: string[],
  env: Record<string, string | undefined>,
  io: DeviceIo,
): Promise<number> {
  const args = parseDeviceArgs(argv, env);
  if (typeof args === 'string') {
    io.err(args);
    return 2;
  }
  if (args.help) {
    io.out(USAGE);
    return 0;
  }

  let client: DeviceClient;
  try {
    client = await DeviceClient.connect(args.url, args.token, { dev: 'fake-device', fw: 'cli' });
  } catch (err) {
    if (err instanceof HelloRefused) {
      io.err(`Refused by the bridge: ${explainRefusal(err.why)}.\n`);
      return 2;
    }
    // The URL is the person's own and safe to echo; the token never appears in an error.
    const why = err instanceof Error ? err.message : String(err);
    io.err(`Could not connect to ${args.url}: ${why}\n`);
    // A real-mode bridge turns away a device on its own machine with a 403, and that is the one
    // refusal a person at a desk is likely to meet and unlikely to guess.
    if (/\b403\b/.test(why)) io.err('A bridge in real mode refuses a device on its own machine unless it was started with --allow-local-device.\n');
    return 1;
  }

  const sid = client.ack?.ok === true ? client.ack.sid : '';
  io.out(`connected to ${args.url}${sid ? ` (session ${sid})` : ''}\n${HELP}\n`);

  let quitting = false;
  /** A prompt or utterance has gone out and its result has not come back. */
  let inFlight = false;
  /** The last transcript the bridge showed, waiting for the player's SEND. */
  let heard: string | undefined;

  const show = (m: BridgeMsg): void => {
    if (m.t === 'result' || m.t === 'err') inFlight = false;
    // A transcript ends the dictation; no turn follows it until it is sent.
    if (m.t === 'stt') {
      heard = m.text;
      inFlight = false;
    }
    const line = render(m);
    if (line !== undefined) io.out(`${line}\n`);
  };
  // The bridge sends its first `state` right behind `hello_ack`, and both can arrive in one
  // network read, so by the time connect() returns that state may already have been delivered.
  // Show what is already there and start listening in the same breath, so nothing falls between.
  for (const m of client.transcript) show(m);
  client.on('msg', show);
  client.on('protocol_error', (what: string) => io.err(`PROTOCOL ERROR from the bridge: ${what}\n`));

  const closed =
    client.closed !== undefined
      ? Promise.resolve(client.closed)
      : new Promise<CloseInfo>((resolve) => client.once('close', resolve));
  const rl = createInterface({ input: io.input, terminal: io.tty });

  const handleLine = (raw: string): void => {
    const line = raw.trim();
    if (line === '') return;
    try {
      switch (line) {
        case '/q':
        case '/quit':
          quitting = true;
          rl.close();
          return;
        case '/y':
        case '/n': {
          const open = client.openAsk;
          if (open === undefined) {
            io.out('no ask is open\n');
            return;
          }
          client.answer(open.id, line === '/y');
          return;
        }
        case '/a':
          client.abort();
          return;
        case '/l':
          inFlight = true;
          client.speak();
          return;
        case '/send': {
          if (heard === undefined) {
            io.out('nothing was heard yet; /l dictates\n');
            return;
          }
          const text = heard;
          heard = undefined;
          inFlight = true;
          client.say(text);
          return;
        }
        case '/help':
        case '/?':
          io.out(`${HELP}\n`);
          return;
        default:
          if (line.startsWith('/')) {
            io.out(`unknown command ${line}; /help lists them\n`);
            return;
          }
          inFlight = true;
          client.say(line);
      }
    } catch (err) {
      // The encoder refuses text the real device could not send (non-ASCII, too long).
      inFlight = false;
      io.out(`cannot send that: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  };
  rl.on('line', handleLine);
  rl.on('SIGINT', () => {
    quitting = true;
    rl.close();
  });

  // Input ended (a script, or Ctrl-D): let a turn that is still running finish, so
  // `printf 'run the tests\n' | fake-device` shows the answer instead of hanging up on it.
  const inputEnded = new Promise<void>((resolve) => rl.once('close', resolve));
  const outcome = await Promise.race([
    closed.then((c) => ({ kind: 'lost' as const, c })),
    inputEnded.then(() => ({ kind: 'input' as const })),
  ]);

  if (outcome.kind === 'input' && !quitting) {
    const drained = await Promise.race([
      closed.then(() => 'lost' as const),
      new Promise<'idle'>((resolve) => {
        const check = (): void => {
          if (!inFlight) {
            client.off('msg', check);
            resolve('idle');
          }
        };
        if (!inFlight) resolve('idle');
        else client.on('msg', check);
      }),
    ]);
    if (drained === 'lost') {
      io.err('The connection was lost.\n');
      return 1;
    }
  }

  rl.close();
  if (outcome.kind === 'lost') {
    io.err(outcome.c.code === 4001 ? 'Another device took this connection over.\n' : `The connection was lost (${outcome.c.code}).\n`);
    return 1;
  }
  await client.close(1000).catch(() => {});
  return 0;
}

if (import.meta.main) {
  const io: DeviceIo = {
    out: (t) => void process.stdout.write(t),
    err: (t) => void process.stderr.write(t),
    input: process.stdin,
    tty: process.stdin.isTTY === true,
  };
  const code = await runFakeDevice(process.argv.slice(2), process.env, io);
  // Output is tiny; let it flush, then leave. exit() also resets a tty left in raw mode.
  process.stdout.write('', () => process.exit(code));
}
