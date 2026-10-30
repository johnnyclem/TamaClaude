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
node --disable-sigusr1 src/main.ts --cwd ~/projects/the-repo --host 0.0.0.0 --token-file ~/.tamaclaude-token
```

`npm start` is `node --disable-sigusr1 src/main.ts`, so `npm start -- --cwd ... --token-file ...` is the same
command. The flag is half of a pair: the bridge also refuses the signal in code (see "What is not guaranteed").

An API key is **required** and the bridge says why if it is missing: this project does not
run a server that a handheld drives on a personal Claude subscription login.

`--cwd` is the project Claude works in; it is fixed for the life of the process (the plan
defers project switching). The session id is kept in the state directory and resumed on the
next start, per working directory; `--new-session` forgets it. Fake mode keeps no state, so
its made-up ids can never be resumed by a real run.

**The project's own settings are not read.** By default Claude Code is started with no
repository configuration and none of yours (`--setting-sources none`); see "Repository settings are
off by default" below for why. What a person usually wants from the repository, its `CLAUDE.md`, is
given to Claude by the bridge itself, as plain text: `CLAUDE.md` and `.claude/CLAUDE.md` in the working
directory (a link that leads out of the project, a file that is not UTF-8 text, a file past 40 KB in
total is not used, and an `@import` line is left as text, not followed). The banner says which files
were read and whether they were cut.

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
   about a file others can read, and about one inside the working directory; Claude is asked
   about, at high risk, a read of the token file and of the state directory wherever they are).
2. **Nothing**: a token is generated and printed once in the banner.
3. **`BRIDGE_TOKEN`** in the environment, or **`--token`**. The environment of a process is
   readable by everything running as your user (`/proc/<pid>/environ`), and a command-line
   argument by every user of the machine (`ps`). `--token` also warns.

The bridge checks the token's length and alphabet, nothing more: use a random one (the recipe
above, or let it generate one). Wrong guesses are rate-limited per address, but a guessable
token is still guessable.

Say it plainly: **anything running as your user can read the token**, including the commands
Claude runs once you approve them. Secrecy from them is not what keeps the asks safe; the
refusal of a device on this machine (above) is, and that has limits too (see "What is not
guaranteed").

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
| `--max-turns` | unlimited | most model turns one prompt may take. Claude reads files inside the project without asking, so with no limit a loop of reads costs API calls until `--turn-stall-sec` or you stop it; setting this is sensible |
| `--turn-stall-sec` | `300` | end a turn after this many seconds in which Claude showed no sign of life while no tool was running and no ask was open (0 to 3600; `0` never). A running tool or an ask on the panel is not silence |
| `--pass-env` | none | environment variable names (comma separated, or repeat the flag) that the commands Claude runs may see, on top of the list below. `BRIDGE_TOKEN` is refused |
| `--state-dir` | `$XDG_STATE_HOME/tamaclaude-bridge`, else `~/.local/state/tamaclaude-bridge` | where the session id lives (directory 0700, file 0600) |
| `--new-session` | off | forget the saved session and start a fresh conversation |
| `--ask-ttl-sec` | `90` | how long the player has to answer one ask (1 to 3600) |
| `--grace-sec` | `15` | how long an open ask survives a lost connection (0 to 3600) |
| `--setting-sources` | `none` | **opt-in**: which Claude Code settings files are read: `user`, `project`, `local`, a list, or `none`. Anything with `project` or `local` lets the repository run commands, and prints a loud warning; see "Repository settings are off by default" |

`SIGINT` and `SIGTERM` close gracefully: connected devices get a 1001 close, the Claude
session is closed, the port is released. A second signal exits immediately, without closing
anything (see "What is not guaranteed" for what that can leave behind).

## Security model, in plain words

A WebSocket that can drive a coding agent is a remote-control surface. This section says what
the bridge does about it, under which conditions that holds, and, in its own part, what it
does **not** do. If a sentence here is stronger than the code, that is a bug in the sentence:
the claims that carry a list or a number are held to the code by tests (`test/main.test.ts`).

### What holds in the default configuration

- **Approvals only by tap.** A tool call that is put to the device is allowed only when the
  bridge receives `ask_rsp` with `ok: true` and the id of the ask currently on the panel, from
  the current device. Typed text, speech, a transcript of "yes approve it" and the model's own
  words cannot grant anything; one ask is shown at a time; an id works once; an answer for an
  ask that has ended is refused, so a late tap can never land on the next question.
- **Exactly one tool runs without a tap in the Claude Code build this bridge ships with:
  `Read`, inside the working directory.** Symbolic links are followed (a link out of the project
  is outside), the path must not be a credential store (`/proc`, `~/.ssh`, `~/.claude.json`,
  shell histories, `.git/config`, `.claude/settings.local.json`, the bridge's own token file and
  state directory and the like) and must contain no look-alike characters. **Everything else
  asks the device first**: every `Bash` command (even `ls`; a search or a listing is a `Bash`
  call in this build), every write and edit, `WebFetch`, `WebSearch`, sub-agents, `ToolSearch`
  and every MCP tool. A read outside the working directory asks. The bridge's own rule is
  wider than this build: it also lets `Read`, `Glob`, `Grep`, `LS` and `NotebookRead` through
  when they are inside the project and not a credential store, so a Claude Code that offers the
  others behaves the same. The banner prints what this build has.
- **It fails closed.** No answer within the time, a device gone longer than the grace period,
  an abort, an error anywhere in the approval path (including a crash in the analysis of a
  command), more than 8 asks open at once, or a bridge restart: all of them deny the call.
  Nothing is approved by default.
- **The panel shows the real call.** The label and summary come from the tool's actual input,
  never from the model's description of it, and are reduced to printable ASCII. A character
  that ASCII folding would have disguised is shown as `?` and makes the call at least `high`.
  **Limits of what 96 characters can show, and what is therefore approved partly blind**: the
  content of a `Write` or `Edit` is not shown (the path is); an MCP tool shows its target and the
  size of its input, not all of it; a long `Bash` command is cut and rated `high`; and **a
  sub-agent's brief is not shown at all**: an `Agent` call shows only the kind of sub-agent, and is
  rated `high` for that reason. The person who taps ALLOW on it is trusting what the model wrote
  for the sub-agent, and the sub-agent's own calls ask as usual.
- **The model is not offered, and is refused if it asks for, the tools a voice device cannot
  serve:** `AskUserQuestion`, `ScheduleWakeup`, `CronCreate`, `CronDelete`, `CronList`,
  `Monitor`, `Workflow`, `Skill`, `EnterPlanMode`, `ExitPlanMode`, `SendMessage`, `ListAgents`,
  `TaskStop`, `EnterWorktree`, `ExitWorktree` and `ReportFindings`. One list in `src/tools.ts`
  serves both the part that hides them and the part that refuses them.
- **Hard-deny is a backstop, not a guarantee.** Some calls (deleting the home directory,
  piping a download into a shell, editing Claude's own configuration, a command too complex for
  the analysis to finish: over 1 MiB, or past its work budget) are refused without ever asking,
  and in real mode the same rules also run inside the SDK's own hook. A few more are rated
  `high` and asked about, never refused: running a container or a virtual machine, and commands
  that print stored credentials. They are pattern rules over a language that is Turing complete:
  `test/tools.test.ts` lists the gaps it knows about (a destructive command written through an
  interpreter, a computed path, shell syntax of other shells than bash, plus a little of zsh's),
  and approving is still a judgement the person makes.

### Repository settings are off by default

A repository's `.claude/settings.json` and `settings.local.json` are not a list of preferences.
They can name commands that Claude Code runs by itself when it starts (to produce cloud
credentials, or a proxy login), set environment variables for everything it runs, point it at a
different server (which then receives the conversation, and in one measured case the API key),
and switch features back on, **before any tool call exists for the device to be asked about**.
Blocking the keys that are known to do this (a denylist) was tried first and rots with every
Claude Code release, so the default is to read **none** of it:

- `--setting-sources none` is the default. No repository file and none of yours (`~/.claude`)
  changes how Claude runs, so none of the above can happen. The cost is only that the repository's
  `CLAUDE.md` does not arrive through the CLI; the bridge reads it and hands it over as text
  (see "Real mode"), headed by a note that it was written by whoever owns the repository and
  cannot approve anything.
- `--setting-sources project,local` (or any list with `project` or `local`) is an **opt-in** for a
  repository you trust as much as you trust its build scripts. The banner prints a boxed warning
  when it is on. **`none` is the only safe setting for a repository you do not trust.**
- In an opt-in mode the bridge still tries: the policy tier makes Claude Code ignore the
  repository's permission rules and hooks; the driver's own hook asks about every call that is not
  on the free list, whatever a rule says; and a private settings file in the highest-priority layer
  blanks the keys known to run commands, the provider switches and their endpoints, the proxies,
  and the variables that choose which program or library is loaded, and turns background work and
  hooks off. **All of that is best effort, and it is not a guarantee.** In particular: a repository
  can still replace `ANTHROPIC_API_KEY` with its own, set any variable or key not on the list, and
  its `deny` rules are discarded along with its `allow` rules; and **on a machine that has an
  administrator's policy tier (a managed-settings file, an MDM profile, server-managed settings)
  the bridge's lock is dropped by Claude Code and only the driver's hook and the pins remain.** The
  bridge asks Claude Code whether its lock is in force when a settings source is on and puts a
  warning in the banner if it is not, or cannot tell.

### What is not guaranteed

Read this before trusting the bridge with a machine you care about.

- **Anything running as your user can take over the bridge.** The commands you approve run as
  you. `--disable-sigusr1` (in `npm start`) and a handler in the code both stop `kill -USR1` from
  opening Node's unauthenticated inspector, which used to hand the process to any such command;
  that closes one road, not the class. A process of your user can still read the token and the API
  key from the environment, and may read this process's memory or attach to it where the system
  allows (`ptrace_scope`, `/proc/<pid>/mem`). The refusal of a device on this machine removes the
  WebSocket road to the asks and only that road.
- **That refusal is based on addresses, so it does not see across a boundary on the same host.**
  A container, a virtual machine or another network namespace connects from an address that is
  not one of this machine's own (a container on a Docker bridge arrives from `172.17.x.x`), so a
  command you approve that starts one, and knows the token, can connect as the device. The bridge
  rates `docker run`, `podman`, VM tools and the like `high` and asks, but does not refuse them.
  Conversely a TLS-terminating proxy on this machine always arrives from loopback and is refused;
  do not "fix" that with `--allow-local-device`, which hands the device role to every local
  process that knows the token.
- **An approved command can do what you can do.** It runs as you, with your `HOME`: `~/.aws`,
  `~/.ssh`, `~/.config/gh`, `~/.npmrc` and the like are reachable by any command you approve (only
  environment variables are held back, see the next section), and the API key is in its
  environment. Approving a command is trusting it with those.
- **Reads inside the project are free.** The bridge protects named credential stores, not the
  meaning of a file: `config/database.yml` inside the working directory is read without a tap, and
  what is read goes to the model. A file in the project (or the `CLAUDE.md` the bridge hands over)
  can carry instructions aimed at the model; the tap is the defence, and a tap on a summary that
  cannot show everything is a judgement (see "The panel shows the real call").
- **A loop of free reads costs money.** With no `--max-turns` the model can read files inside the
  project without a tap for as long as it likes. `--turn-stall-sec` ends a turn that goes silent,
  not one that is busy.
- **Secrets can outlive the process.** In an opt-in settings mode the proxy settings (which may
  contain a password) are written to a private file (`0600`, in a `0700` directory under the temp
  directory) that is removed when the bridge closes normally. A second signal ("Forced exit"), or
  `SIGKILL`, or a crash, leaves it behind. With the default `none` no such file is written.
- **Hard-deny and the summary are pattern rules,** as said above.
- **The device does not authenticate the bridge, and `ws://` is plaintext** (below).

### What the commands Claude runs can see

The Claude child process gets an **allowlist** of this process's environment, not a copy:
`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `TERM`, `TMPDIR`, `TZ`, `HTTP_PROXY`,
`HTTPS_PROXY`, `NO_PROXY`, `ALL_PROXY` (and the lower-case spellings), `SSL_CERT_FILE`,
`NODE_EXTRA_CA_CERTS`, `CLAUDE_CONFIG_DIR`, every `LC_*` and every `XDG_*` (whatever follows the
prefix), plus `ANTHROPIC_API_KEY`, plus the names you give with `--pass-env`. `BRIDGE_TOKEN` and
the other environment variables of this process **stay behind**. Use `--pass-env ANTHROPIC_BASE_URL`
for a gateway. **Only environment variables are withheld:** files under `HOME` are not, as said
above. **The API key itself is visible to any command you approve**, because the CLI passes its
own environment on.

### Who may connect

- **A device on this machine is refused in real mode** (HTTP 403 before any WebSocket) unless
  `--allow-local-device`; this covers loopback and this machine's own network addresses, and, as
  said above, nothing that arrives from another address on the same host.
- **A browser is refused**: an upgrade with an `Origin` header gets a 403, so a web page
  cannot use the bridge to guess tokens.
- **The token** is compared in constant time (as SHA-256 digests, so the length does not leak
  either). A wrong token waits half a second before it is refused, and wrong tokens are counted
  per address across connections: the first five are answered as usual, the sixth pauses the
  address for 2 seconds, and each further wrong token doubles the pause up to 5 minutes (restart
  the bridge to clear it). During a pause even the right token is not looked at. The token is
  never written to the log.
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
- Background work is switched off for the voice session (and the `Workflow` tool, which ignores
  that switch, is not offered), and every result is tied to the prompt that caused it, so a turn
  the CLI starts on its own is never reported as the answer to something the player said. A
  sub-agent (the `Agent` tool) still runs, in the foreground, and each of its own calls asks.
  (The voice rules told to the model say so too, and are rendered afresh on every request, so an
  edit takes effect in a resumed session as well.)
- Dictated or typed text is sent to Claude as words: `/clear` does not reset the conversation
  and `@/etc/hostname` does not read a file.
- An API error that retrying cannot fix (a rejected key, no such model) ends the turn within
  about a second with a short sentence, and text that looks like a key is replaced by
  `[redacted]` before it reaches the device. A turn in which Claude goes silent, with no tool
  running and no ask open, is ended after `--turn-stall-sec` (300 s) with "Claude is not
  responding."; the next prompt starts a new process on the same session. Transient errors (rate
  limits, overload) still show as `thinking` for as long as the CLI backs off.

## What is verified, and what is not

Verified by tests on every run (`npm test`, no network, no key):

- the protocol codec, the golden fixtures and PROTOCOL.md's numbers, field tables, close codes,
  timings and worked example (replayed against a live bridge);
- the server end to end on real loopback sockets: the handshake and everything that can go
  wrong in it, takeover, the grace period, keepalive with the shipped timings, push-to-talk
  (including the idle limit on a listen window), abort, and that nothing but a matching `ask_rsp`
  ever grants an approval;
- the real Claude driver, the real approval manager, the real permission handler and the real
  server composed together over a scripted stand-in for the CLI, **built by `main.ts`'s own
  `run()`**, so a one-line regression in the wiring (the veto stripped, the grace period forced,
  a canned recognizer in real mode) fails;
- `main.ts`: the flags, the banner, and what `run()` hands the driver and the server, field by field;
- the README's flag table, its list of tools that run without a tap, its list of tools that are
  refused, and the admission numbers.

**Not run by `npm test`:** `npm run test:real-cli` (about two minutes, no key, no network) runs the
real driver over the **real Claude Code CLI bundled with the SDK** against a local fake of the
Anthropic API. It is the only evidence for what the CLI does with permission hooks, settings, the
pins, session resume and interrupts, and for each guard in "Repository settings are off by
default", every one with a control run that removes the guard to show the exploit working. **Nothing
runs it automatically** (there is no CI in this repository): run it after every SDK bump and before
trusting a README sentence about the CLI. `npm test` fails when the installed SDK is not the one that
file was last recorded as passing against, which is the reminder.

**Not verified**: a real turn against `api.anthropic.com` with a real key (the fake API decides
what a rejected key looks like); the SDK's sandbox auto-allow (no `bubblewrap` here); anything
on a real handheld or a real network (no firmware exists yet); whether the bridge's pattern
rules catch a particular dangerous command (they are a backstop); content-sensitive files
inside the working directory (`config/database.yml` reads without a tap, only named
credential stores are protected); containers and virtual machines (no tooling here to start one);
and the IPv6 path of the local-device refusal (this kernel has none; only the address folding is
unit-tested).

## Running the tests

```bash
npm test                  # the whole suite, no network, no API key (each test is cut off after 2 minutes)
npm run typecheck         # tsc --noEmit
npm run test:real-cli     # the real CLI against a fake API, offline; not part of npm test
node --test --test-reporter=spec test/server.e2e.test.ts     # one file
```

The end-to-end test starts the real server on a loopback socket and drives it with the real
device client against the fake Claude. Time-dependent behaviour (ask lifetime, reconnect
grace, hello deadline, the abort watchdog, the listen idle limit, keepalive) runs on an injected
clock, so nothing sleeps. Its teardown fails any test whose server sent a frame that is not
printable ASCII, skipped or repeated a state, showed two asks at once, said no ask was open while
one was on the screen, wrote the token to the log, or left a timer armed after `close()`.
`test/main.test.ts` also runs the real program and the fake-device CLI as child processes,
including `SIGTERM`/`SIGINT` and a `SIGUSR1` sent to a real-mode bridge.

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
| `src/memory.ts` | the project's `CLAUDE.md` as capped plain text for Claude, read by the bridge (a link out of the project, a file that is not text and `@import` are refused) |
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
