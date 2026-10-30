# TamaClaude bridge

A small server that a handheld device connects to over a WebSocket. The device sends typed
or dictated prompts and its owner's taps on permission requests. The bridge runs one
long-lived Claude Code session (through the Claude Agent SDK) and streams back what the
session is doing (which drives the pet's animation), permission requests, a transcript of
dictated speech, and a short final summary.

It is Phase 2 of [`docs/claude-pet-plan.md`](../docs/claude-pet-plan.md): the desktop half,
built so the whole loop can be tried with **no hardware** and, in fake mode, **no API key**.
The wire format the firmware will be written from is [`PROTOCOL.md`](PROTOCOL.md).

TypeScript on Node 22.18 or newer, run by type stripping: there is no build step.

## Quick start: the desktop demo (fake Claude, no key)

```bash
cd bridge
npm install                       # once: ws, the Agent SDK, typescript

node src/main.ts --fake-claude    # terminal 1
```

The banner prints the address and a token that was generated for this run, once:

```
TamaClaude bridge 0.1.0
  mode    FAKE (scripted Claude: no API key, no network, step delay 400 ms)
  cwd     /home/you/TamaClaude/bridge
  listen  ws://127.0.0.1:8787/
  token   3f9a...            (generated for this run and shown only here; the device needs it)
```

```bash
BRIDGE_TOKEN=3f9a... node tools/fake-device.ts    # terminal 2
```

Type `run the tests` and press enter. The fake device prints the pet's face for each phase,
then an approval box with the real command and a bell; answer it with `/y` or `/n`.

| input | does |
|---|---|
| plain text | sends it as a prompt |
| `/y`, `/n` | allows or denies the ask that is open (the only thing that can approve anything) |
| `/a` | aborts the running turn |
| `/l` | dictates: a short burst of audio through the push-to-talk path (fake mode answers "please run the tests") |
| `/q` | quits |

The fake Claude picks a scenario from words in the prompt: `run`/`test`/`bash` asks to run a
command, `edit`/`write` asks to edit a file, `two`/`parallel` asks about two tools at once,
`danger` tries a command the safety rules refuse outright, `slow` starts a tool that never
finishes (try `/a`), `unicode` and `long` return awkward text, `error` and `fatal` fail,
anything else is echoed back. The full table is the header of `src/drivers/fake.ts`.

## Real mode

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export BRIDGE_TOKEN=$(head -c 16 /dev/urandom | xxd -p)    # or leave it unset to get one in the banner
node src/main.ts --cwd ~/projects/the-repo
```

An API key is **required** and the bridge says why if it is missing: this project does not
run a server that a handheld drives on a personal Claude subscription login.

`--cwd` is the project Claude works in; it is fixed for the life of the process (the plan
defers project switching). The session id is kept in the state directory and resumed on the
next start, per working directory; `--new-session` forgets it. Fake mode keeps no state, so
its made-up ids can never be resumed by a real run.

Prefer `BRIDGE_TOKEN` to `--token`: a command-line argument is visible to other users in `ps`.

## Flags

| flag | default | |
|---|---|---|
| `--host` | `127.0.0.1` | address to listen on. Anything that is not loopback prints a warning, see below |
| `--port` | `8787` | `0` picks a free port (the banner shows the one it got) |
| `--token` | `$BRIDGE_TOKEN`, else generated | 16 to 64 characters of `A-Z a-z 0-9 . _ ~ -` (what the device can send). A generated token is 24 hex characters and is printed once, in the banner. A token you supplied is never printed back |
| `--cwd` | current directory | the project Claude works in |
| `--fake-claude` | off | scripted stand-in for Claude; also gives push-to-talk a canned recognizer |
| `--fake-delay-ms` | `400` (fake mode) | pause between the fake's steps |
| `--state-dir` | `$XDG_STATE_HOME/tamaclaude-bridge`, else `~/.local/state/tamaclaude-bridge` | where the session id lives (directory 0700, file 0600) |
| `--new-session` | off | forget the saved session and start a fresh conversation |
| `--ask-ttl-sec` | `90` | how long the player has to answer one ask |
| `--grace-sec` | `15` | how long an open ask survives a lost connection |
| `--setting-sources` | `project,local` | which Claude Code settings files are read: `user`, `project`, `local`, a list, or `none` |

`SIGINT` and `SIGTERM` close gracefully: connected devices get a 1001 close, the Claude
session is closed, the port is released. A second signal exits immediately.

## Security model, in plain words

A WebSocket that can drive a coding agent is a remote-control surface, so:

- **The token.** The device proves itself with a shared secret in its first message. It is
  compared in constant time (as SHA-256 digests, so the length does not leak either). A wrong
  token waits half a second before it is refused. The token is never written to the log, and
  is printed only when the bridge made it up. Anyone holding the token can connect, and a
  new valid connection **replaces** the current device (close code 4001), so treat it like a
  password.
- **Loopback by default, and `ws://` is plaintext.** There is no TLS in this version. On a
  network, anyone who can read the traffic sees the token and every approval and can inject
  their own. Use `--host` with something other than loopback only on a home LAN, a phone
  hotspot you control, or a VPN, and never expose the port to the internet. (A web page in a
  browser on the same machine can open a WebSocket to a loopback port, but cannot
  authenticate without the token.)
- **Approvals only by tap.** A tool call is allowed only when the bridge receives `ask_rsp`
  with `ok: true` and the id of the ask currently on the panel, from the current device.
  Typed text, speech, a transcript of "yes approve it", and the model's own words cannot
  grant anything; one ask is shown at a time; an id works once; an answer for an ask that has
  ended is refused, so a late tap can never land on the next question.
- **It fails closed.** No answer within the time, a device gone longer than the grace period,
  an abort, an error anywhere in the approval path, or a bridge restart: all of them deny the
  call. Nothing is approved by default.
- **The panel shows the real call.** The label and summary come from the tool's actual input,
  never from the model's description of it, and are reduced to printable ASCII.
- **Hard-deny is a backstop, not a guarantee.** Some calls (deleting the home directory,
  piping a download into a shell, editing Claude's own configuration) are refused without
  ever asking, and in real mode the same rules also run inside the SDK's own hook so they
  hold even when a settings file allows the tool. They are pattern rules over a language
  that is Turing complete; `test/tools.test.ts` lists the gaps it knows about. Approving is
  still a judgement the person makes.
- **Settings files can skip the ask.** User-level Claude settings are not read by default,
  because an allow rule there would let Claude run a tool without asking the device.
  Project and local settings are read, and their allow rules do skip it: do not point
  `--cwd` at a repository you do not trust, or use `--setting-sources none`.
- **The API key** is read from the environment, handed to the Claude child process, scrubbed
  from the driver's logs, and never printed or stored.

## Running the tests

```bash
npm test                  # the whole suite, a few seconds, no network, no API key
npm run typecheck         # tsc --noEmit
node --test --test-reporter=spec test/server.e2e.test.ts     # one file
```

The end-to-end test starts the real server on a loopback socket and drives it with the real
device client against the fake Claude. Time-dependent behaviour (ask lifetime, reconnect
grace, hello deadline, the abort watchdog) runs on an injected clock, so nothing sleeps.
Its teardown fails any test whose server sent a frame that is not printable ASCII, skipped
or repeated a state, showed two asks at once, wrote the token to the log, or left a timer
armed after `close()`. `test/main.test.ts` also runs the real program and the fake-device
CLI as child processes, including `SIGTERM`/`SIGINT`.

## Where things are

| file | what |
|---|---|
| `PROTOCOL.md` | the wire protocol, written for the firmware author; `fixtures/` holds the byte-exact conformance frames |
| `src/types.ts` | the shared contract: limits, message types, driver and clock interfaces |
| `src/protocol.ts` | the strict codec (the only code that turns bytes into messages and back) |
| `src/text.ts` | everything that reaches the panel passes through here: ASCII folding, truncation, summaries |
| `src/state.ts` | the pet's phase as a pure function of what the session reported |
| `src/approvals.ts`, `src/permission.ts` | the approval queue and the glue from a tool call to it |
| `src/tools.ts` | what the panel says about a tool call, and which calls are refused outright |
| `src/drivers/claude.ts`, `claude-adapter.ts` | the real Agent SDK driver and the SDK-message-to-event adapter |
| `src/drivers/fake.ts` | the scripted Claude |
| `src/voice-prompt.ts` | rules appended to Claude's system prompt for a tiny screen |
| `src/server.ts` | the WebSocket server: handshake, keepalive, turn lifecycle, push-to-talk, abort |
| `src/store.ts` | the saved session id |
| `src/stt.ts` | speech-to-text adapters: the default that says "not set up", and a scripted one |
| `src/main.ts` | flags, banner, signals |
| `src/device-client.ts` | a strict typed client of the protocol, used by the tests and the CLI |
| `tools/fake-device.ts` | the interactive terminal stand-in for the handheld |
| `tools/gen-fixtures.ts` | regenerates `fixtures/` from the real encoders |

## What is not done

- **No microphone and no speech-to-text.** The push-to-talk path is complete on the bridge
  side (audio in, transcript, prompt) but ships no engine: by default `listen stop` answers
  `stt_unavailable`. A real adapter (whisper.cpp or a vendor API) implements `SttAdapter`
  in `src/types.ts`. The ES7210 microphone is unproven on the board (plan, Phase 1).
- **No spoken replies.** The `speaking` phase and binary TTS frames exist in the protocol and
  are never sent (plan, Phase 7).
- **No TLS.** `ws://` only, by decision (plan, decision 1).
- **No firmware client.** Nothing here has talked to a board (plan, Phases 3 to 6).
- **Never run against the real Claude Agent SDK or API.** The real driver is type-checked
  against the installed SDK (0.3.314) and tested against a faithful fake of its `query`
  function, and `main.ts` was checked as far as starting the real driver and resuming a
  session without sending a prompt. Nobody has yet run a real turn through it, so the first
  real session may turn up differences in the SDK's message shapes or in how it treats the
  permission callback.
- One device at a time, one project per process, one session per process.

### Where this implementation and PROTOCOL.md differ

The build brief and the protocol document were written separately and disagree in three
places. The server follows the brief; each is a one-line change (`CLOSE` and `DEFAULTS` in
`src/server.ts`) once someone decides.

| | brief (implemented) | PROTOCOL.md |
|---|---|---|
| close code for a refused or missing hello | 1008 | 4002 |
| time allowed for the first message | 5 s | 10 s |
| after a dictated utterance is transcribed | the transcript is sent to Claude at once | shown first; only the player's tap sends it |
