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

The banner prints the address and a token that was generated for this run, once, to the
terminal and nowhere else:

```
TamaClaude bridge 0.1.0
  mode    FAKE (scripted Claude: no API key, no network, step delay 400 ms)
  cwd     /home/you/TamaClaude/bridge
  listen  ws://127.0.0.1:8787/
  token   3f9a...
          (generated for this run and shown only here; the device needs it)
  try it  BRIDGE_TOKEN=<token> node tools/fake-device.ts --url <the listen address>
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
| `/l` | dictates: a short burst of audio through the push-to-talk path (fake mode hears "please run the tests") |
| `/send` | the player's SEND tap: sends what was heard as a prompt. A transcript is only shown, never run by itself |
| `/q` | quits |

The fake Claude picks a scenario from words in the prompt: `run`/`test`/`bash` asks to run a
command, `edit`/`write` asks to edit a file, `two`/`parallel` asks about two tools at once,
`danger` tries a command the safety rules refuse outright, `slow` starts a tool that never
finishes (try `/a`), `unicode` and `long` return awkward text, `error` and `fatal` fail,
anything else is echoed back. The full table is the header of `src/drivers/fake.ts`.

## Real mode

```bash
export ANTHROPIC_API_KEY=sk-ant-...
(umask 077; openssl rand -hex 16 > ~/.tamaclaude-token)   # or: node -p "require('crypto').randomBytes(16).toString('hex')" > the same file
node src/main.ts --cwd ~/projects/the-repo --host 0.0.0.0 --token-file ~/.tamaclaude-token
```

An API key is **required** and the bridge says why if it is missing: this project does not
run a server that a handheld drives on a personal Claude subscription login.

`--cwd` is the project Claude works in; it is fixed for the life of the process (the plan
defers project switching). The session id is kept in the state directory and resumed on the
next start, per working directory; `--new-session` forgets it. Fake mode keeps no state, so
its made-up ids can never be resumed by a real run.

**A real-mode bridge refuses a device on its own machine.** The commands Claude runs
execute here, so a process on this machine that learns the token could connect as the
device and approve its own asks. `--host` therefore has to be an address other machines can
reach (the default, loopback, is reachable only from this machine, and the banner warns that
no device can connect). To use the emulator or `tools/fake-device.ts` against a real-mode
bridge, say so with `--allow-local-device`, and accept that the commands you approve can do
the same.

### The token

The token is the device's credential. Three ways to give it, safest first:

1. **`--token-file <path>`**: read once at start-up; never in a command line or an
   environment. Keep the file outside the project and readable by you only (the bridge warns
   about a file others can read).
2. **Nothing**: a token is generated and printed once in the banner.
3. **`BRIDGE_TOKEN`** in the environment, or **`--token`**. The environment of a process is
   readable by everything running as your user (`/proc/<pid>/environ`), and a command-line
   argument by every user of the machine (`ps`). `--token` also warns.

The bridge checks the token's length and alphabet, nothing more: use a random one (the recipe
above, or let it generate one). Wrong guesses are rate-limited per address, but a guessable
token is still guessable.

Say it plainly: **anything running as your user can read the token**, including the commands
Claude runs once you approve them. Secrecy from them is not what keeps the asks safe; the
refusal of a device on this machine (above) is.

## Flags

| flag | default | |
|---|---|---|
| `--host` | `127.0.0.1` | address to listen on. Anything that is not loopback prints a warning, see below |
| `--port` | `8787` | `0` picks a free port (the banner shows the one it got) |
| `--token-file` | none | file holding the token (16 to 64 characters of `A-Z a-z 0-9 . _ ~ -`, what the device can send) |
| `--token` | `$BRIDGE_TOKEN`, else generated | the same on the command line or in the environment, with the cautions above. A generated token is 24 hex characters and is printed once, in the banner. A token you supplied is never printed back |
| `--allow-local-device` | off (on in fake mode) | accept a device on this machine, see above |
| `--cwd` | current directory | the project Claude works in |
| `--fake-claude` | off | scripted stand-in for Claude; also gives push-to-talk a canned recognizer |
| `--fake-delay-ms` | `400` (fake mode) | pause between the fake's steps |
| `--model` | the Claude Code default | the model; a voice session may want a smaller one than the default |
| `--max-turns` | unlimited | most model turns one prompt may take |
| `--pass-env` | none | environment variable names (comma separated, or repeat the flag) that the commands Claude runs may see, on top of the list below. `BRIDGE_TOKEN` is refused |
| `--state-dir` | `$XDG_STATE_HOME/tamaclaude-bridge`, else `~/.local/state/tamaclaude-bridge` | where the session id lives (directory 0700, file 0600) |
| `--new-session` | off | forget the saved session and start a fresh conversation |
| `--ask-ttl-sec` | `90` | how long the player has to answer one ask (1 to 3600) |
| `--grace-sec` | `15` | how long an open ask survives a lost connection |
| `--setting-sources` | `project,local` | which Claude Code settings files are read: `user`, `project`, `local`, a list, or `none` |

`SIGINT` and `SIGTERM` close gracefully: connected devices get a 1001 close, the Claude
session is closed, the port is released. A second signal exits immediately.

## Security model, in plain words

A WebSocket that can drive a coding agent is a remote-control surface. What the bridge does
about it, and what it does not:

- **Approvals only by tap, in the default configuration.** A tool call is allowed only when
  the bridge receives `ask_rsp` with `ok: true` and the id of the ask currently on the panel,
  from the current device. Typed text, speech, a transcript of "yes approve it" and the
  model's own words cannot grant anything; one ask is shown at a time; an id works once; an
  answer for an ask that has ended is refused, so a late tap can never land on the next
  question. Two layers make this true even when the project says otherwise (below).
- **Exactly these calls run without a tap: `Read`, `Glob`, `Grep`, `LS` and `NotebookRead`,
  inside the working directory** (symbolic links followed, so a link out of the project is
  outside), when the path is not a credential store (`/proc`, `~/.ssh`, `~/.claude.json`,
  shell histories, `.git/config`, `.claude/settings.local.json` and the like) and contains no
  look-alike characters. **Everything else asks the device**: every `Bash` command (even
  `ls`), every write and edit, `WebFetch`, `WebSearch`, sub-agents, and every MCP tool. A read
  outside the working directory asks. The banner prints this set.
- **It fails closed.** No answer within the time, a device gone longer than the grace period,
  an abort, an error anywhere in the approval path (including a crash in the analysis of a
  command), more than 8 asks open at once, or a bridge restart: all of them deny the call.
  Nothing is approved by default.
- **The panel shows the real call.** The label and summary come from the tool's actual input,
  never from the model's description of it, and are reduced to printable ASCII. A character
  that ASCII folding would have disguised is shown as `?` and makes the call at least `high`.
  Limits of what 96 characters can show: the content of a `Write` or `Edit` is not shown (the
  path is), an MCP tool shows its target and the size of its input, not all of it.
- **Hard-deny is a backstop, not a guarantee.** Some calls (deleting the home directory,
  piping a download into a shell, editing Claude's own configuration) are refused without
  ever asking, and in real mode the same rules also run inside the SDK's own hook. They are
  pattern rules over a language that is Turing complete: `test/tools.test.ts` lists the gaps
  it knows about (a destructive command written through an interpreter, a computed path), and
  approving is still a judgement the person makes. The model is also not offered the tools a
  voice device cannot serve (`AskUserQuestion`, `ScheduleWakeup`, `Cron*`, `Monitor`).

### Settings files cannot skip the ask

The project's `.claude/settings.json`, `settings.local.json` and the user's settings are read
only for what is not security (CLAUDE.md, environment). The driver locks them out two ways,
and either alone is enough:

1. the Claude Code **managed settings** tier is set to ignore permission rules and command
   hooks from every other file, so an `allow` rule in the repository does nothing;
2. the driver's own PreToolUse hook answers "ask" for every call the bridge does not itself
   rate as free, which overrides any allow rule and the CLI's own auto-allow.

MCP servers from the repository's `.mcp.json` are not started, and its `apiKeyHelper`, API
endpoint and proxy settings are pinned in a private file, so a repository cannot redirect the
API key or run a command to produce one. What a repository **can** still do: its `env` setting
sets environment variables for the commands you approve (`BASH_ENV`, `PATH`, `LD_PRELOAD`), so
**do not point `--cwd` at a repository you do not trust**, as you would not run its build.
`--setting-sources none` reads none of it (and loses CLAUDE.md).

### What the commands Claude runs can see

The Claude child process gets an **allowlist** of this process's environment, not a copy:
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `TZ`, `HTTP_PROXY`,
`HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (and the lower-case spellings), `SSL_CERT_FILE`,
`NODE_EXTRA_CA_CERTS`, `CLAUDE_CONFIG_DIR`, every `LC_*` and every `XDG_*`, plus
`ANTHROPIC_API_KEY`, plus the names you give with `--pass-env`. `BRIDGE_TOKEN`, cloud and
source-host credentials and everything else stay behind. Use `--pass-env ANTHROPIC_BASE_URL`
for a gateway. **The API key itself is visible to any command you approve**, because the CLI
passes its own environment on: approving a command is trusting it with the key.

### Who may connect

- **A device on this machine is refused in real mode** (HTTP 403 before any WebSocket) unless
  `--allow-local-device`; this covers loopback and this machine's own network addresses.
- **A browser is refused**: an upgrade with an `Origin` header gets a 403, so a web page
  cannot use the bridge to guess tokens.
- **The token** is compared in constant time (as SHA-256 digests, so the length does not leak
  either). A wrong token waits half a second before it is refused, and wrong tokens are counted
  per address across connections: after five, the address is paused for 2 seconds, doubling
  with each further failure to 5 minutes (restart the bridge to clear it). During a pause even
  the right token is not looked at. The token is never written to the log.
- **Connections are capped** (32 in all, 8 per address, whether or not they ever speak), a
  socket must finish its HTTP request within 5 seconds and say `hello` within 10, a device that
  stops reading is dropped rather than queued for, and refusals are logged as a count rather
  than a line each.
- **A takeover is loud.** A new valid connection replaces the current device (close code
  4001), and the log line says `WARNING takeover` with where both came from.
- **`ws://` is plaintext.** There is no TLS in this version. On a network, anyone who can read
  the traffic sees the token and every approval and can inject their own. Use `--host` with
  something other than loopback only on a home LAN, a phone hotspot you control, or a VPN, and
  never expose the port to the internet. The banner warns about a non-loopback host.

### Sessions and background work

- A saved session id the CLI can no longer find (it expires) is forgotten and the same prompt is
  retried **once** on a fresh session; the new id replaces the saved one. The player sees an
  ordinary answer.
- Background and delegated work is switched off for the voice session, and every result is tied
  to the prompt that caused it, so a turn the CLI starts on its own is never reported as the
  answer to something the player said. (The voice rules told to the model say so too; a
  resumed session keeps its old system prompt, so use `--new-session` after upgrading.)
- Dictated or typed text is sent to Claude as words: `/clear` does not reset the conversation
  and `@/etc/hostname` does not read a file.
- An API error that retrying cannot fix (a rejected key, no such model) ends the turn within
  about a second with a short sentence. Transient errors (rate limits, overload) still show as
  `thinking` for as long as the CLI backs off, up to a few minutes.

## What is verified, and what is not

Verified by tests on every run (`npm test`, a few seconds, no network, no key):

- the protocol codec, the golden fixtures and PROTOCOL.md's numbers, close codes, timings and
  worked example (replayed against a live bridge);
- the server end to end on real loopback sockets: the handshake and everything that can go
  wrong in it, takeover, the grace period, keepalive with the shipped timings, push-to-talk,
  abort, and that nothing but a matching `ask_rsp` ever grants an approval;
- the real Claude driver, the real approval manager, the real permission handler and the real
  server composed together over a scripted stand-in for the CLI;
- `main.ts`'s wiring, line by line (key, settings, hard-deny, the tap rule, bind address,
  recognizer, timings, local-device rule).

Verified only by an opt-in run: `BRIDGE_REAL_CLI=1 node --test test/real-cli.integration.test.ts`
(about 30 s, needs no key and no network) runs the real driver over the **real Claude Code CLI
bundled with the SDK** against a local fake of the Anthropic API. It pins what the CLI actually
does with permission hooks, settings, session resume and interrupts. Run it after every SDK bump.

**Not verified**: a real turn against `api.anthropic.com` with a real key (the fake API decides
what a rejected key looks like); the SDK's sandbox auto-allow (no `bubblewrap` here); anything
on a real handheld or a real network (no firmware exists yet); whether the bridge's pattern
rules catch a particular dangerous command (they are a backstop); content-sensitive files
inside the working directory (`config/database.yml` reads without a tap, only named
credential stores are protected).

## Running the tests

```bash
npm test                  # the whole suite, a few seconds, no network, no API key
npm run typecheck         # tsc --noEmit
node --test --test-reporter=spec test/server.e2e.test.ts     # one file
BRIDGE_REAL_CLI=1 node --test test/real-cli.integration.test.ts   # the real CLI, offline
```

The end-to-end test starts the real server on a loopback socket and drives it with the real
device client against the fake Claude. Time-dependent behaviour (ask lifetime, reconnect
grace, hello deadline, the abort watchdog, keepalive) runs on an injected clock, so nothing
sleeps. Its teardown fails any test whose server sent a frame that is not printable ASCII,
skipped or repeated a state, showed two asks at once, said no ask was open while one was on
the screen, wrote the token to the log, or left a timer armed after `close()`.
`test/main.test.ts` also runs the real program and the fake-device CLI as child processes,
including `SIGTERM`/`SIGINT`.

## Where things are

| file | what |
|---|---|
| `PROTOCOL.md` | the wire protocol, written for the firmware author; `fixtures/` holds the byte-exact conformance frames |
| `src/types.ts` | the shared contract: limits, close codes, message types, driver and clock interfaces |
| `src/protocol.ts` | the strict codec (the only code that turns bytes into messages and back) |
| `src/text.ts` | everything that reaches the panel passes through here: ASCII folding, truncation, summaries |
| `src/state.ts` | the pet's phase as a pure function of what the session reported |
| `src/approvals.ts`, `src/permission.ts` | the approval queue and the glue from a tool call to it |
| `src/tools.ts` | what the panel says about a tool call, which calls are refused outright, and which run without a tap |
| `src/drivers/claude.ts`, `claude-adapter.ts` | the real Agent SDK driver and the SDK-message-to-event adapter |
| `src/drivers/fake.ts` | the scripted Claude |
| `src/voice-prompt.ts` | rules appended to Claude's system prompt for a tiny screen |
| `src/server.ts` | the WebSocket server: admission, handshake, keepalive, turn lifecycle, push-to-talk, abort |
| `src/store.ts` | the saved session id |
| `src/stt.ts` | speech-to-text adapters: the default that says "not set up", and a scripted one |
| `src/main.ts` | flags, the wiring of the real driver and the server, banner, signals |
| `src/device-client.ts` | a strict typed client of the protocol, used by the tests and the CLI |
| `tools/fake-device.ts` | the interactive terminal stand-in for the handheld |
| `tools/gen-fixtures.ts` | regenerates `fixtures/` from the real encoders |

## What is not done

- **No microphone and no speech-to-text.** The push-to-talk path is complete on the bridge
  side (audio in, transcript shown, prompt sent on the player's tap) but ships no engine: by
  default `listen stop` answers `stt_unavailable`. A real adapter (whisper.cpp or a vendor API)
  implements `SttAdapter` in `src/types.ts`. The ES7210 microphone is unproven on the board
  (plan, Phase 1).
- **No spoken replies.** The `speaking` phase and binary TTS frames exist in the protocol and
  are never sent (plan, Phase 7).
- **No TLS.** `ws://` only, by decision (plan, decision 1).
- **No firmware client.** Nothing here has talked to a board (plan, Phases 3 to 6).
- **Transient API errors are not shown.** A rate limit or an overloaded API shows as `thinking`
  until the CLI gives up; the protocol has no state for "retrying".
- One device at a time, one project per process, one session per process.
