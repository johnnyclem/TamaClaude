# TamaClaude bridge wire protocol

Protocol version **1**.

This is the specification the handheld's firmware is written from. The reference
implementation is `src/protocol.ts` (the codec) and `src/server.ts` (the behaviour). What
a test holds this document to, on every run:

- the numbers: the limits table, the size budgets, the close-code table and the timings
  table are compared with the constants in the code (`LIMITS`, `CLOSE`, `DEFAULTS`);
- the shapes: every message has a field table, and its keys and their order are compared
  with what the encoder writes; every message type, phase, enum value and error code must be
  named here;
- the conversation: the worked example at the end is **replayed against a live bridge** and
  every frame it lists must be exactly what the bridge sends, in that order, including the
  order of the `state` messages that surround an `ask`;
- the bytes: the files in `fixtures/` are the conformance suite for any other
  implementation (the firmware's test should read that directory).

What no test compares is the *prose*: the sentences about what the bridge does in a corner
(the "Input rules" table, the error table, the reconnect rules) are each covered by an
end-to-end test of the bridge, but nothing checks that the sentence and the test agree. When
a sentence here and the bridge's behaviour differ, the behaviour is the bug if a test
pins it and the sentence is the bug if none does: report it.

Words in capitals (MUST, SHOULD, MAY) mean what they mean in RFC 2119. The **device** is
the handheld, the **bridge** is the server it connects to, and the **player** is the
person holding the device.

## What this is

A device connects to a bridge over a WebSocket. The bridge drives one long-lived Claude
Code session. The device sends typed or dictated prompts and the player's answers to
permission requests. The bridge streams back what the session is doing (which drives the
pet's animation), permission requests, a transcript of dictated speech, and a short final
summary. Audio travels in binary frames in both directions; everything else is a small
flat JSON object per text frame.

The protocol is built for a microcontroller: every string has a small fixed cap, every
message has a fixed set of keys (none optional), there is no nesting, and every frame the
bridge sends fits in 1024 bytes.

## Security model

State this plainly, because the transport is plaintext.

- **Authentication is a shared secret.** The `token` in `hello` (16 to 64 characters) is
  compared against the token the bridge is configured with, in constant time. It is sent
  in clear. A lost device is revoked by removing its token from the bridge's
  configuration.
- **`ws://` is for a trusted network only.** Version 1 has no TLS. Anyone who can read
  the traffic sees the token and every ask id, and can inject frames, which includes
  approving tool calls. Use a home LAN, a phone hotspot you control, or a VPN. Do not
  expose the bridge to the internet. TLS (`wss://`) is a later protocol decision, not
  something to bolt on per deployment.
- **The device does not authenticate the bridge.** Nothing in version 1 lets the device
  tell the real bridge from something that answers on the same address.
- **Only a tap can approve.** A tool call is allowed only if the bridge receives
  `ask_rsp` with `ok: true` and an `id` that matches the ask currently presented to the
  player, on the current authenticated connection. The bridge presents one ask at a time
  and accepts only the id of the one on screen, so a late tap for an ask that already
  ended can never land on the next one. Nothing else can grant it: not the text of a
  `say`, not audio or its transcript, not any other message or field. Every other outcome
  is a denial: `ok: false`, a timeout, `abort`, a disconnect that outlasts the grace
  period, a bridge restart, an answer that does not decode, an answer with an unknown id.
  The bridge fails closed.
- **An answer is single use.** The first valid `ask_rsp` for an id closes that ask. A
  second one for the same id gets `err` with `unknown_ask`.
- **Ids are handles, not secrets.** An ask id is 8 hex characters, random for every ask
  and different from every other ask open at the time. It exists so an answer cannot be
  applied to the wrong question; it is visible to anyone who can see the traffic.
- **The ask describes the real call.** `tl` and `sum` are built by the bridge from the
  tool's actual input, never from the model's own description of what it is doing. The
  bridge also refuses some calls outright without asking.
- **A failed handshake changes nothing.** A connection that does not pass `hello` never
  displaces the current connection, never receives a state, an ask or a result (the only
  frame it can ever be sent is the refusal itself), cannot answer, abort or speak, and is
  closed.
- **Who may even connect.** Before a WebSocket exists the bridge may turn a connection
  away: it refuses an upgrade that carries an `Origin` header (a browser sends one, a device
  never does, so a web page cannot use the bridge), it refuses an upgrade from the bridge's
  own machine when it runs the real Claude (the commands Claude runs there could otherwise
  connect as the device and approve themselves; an emulator needs the bridge started with
  `--allow-local-device`), it caps how many connections one address and everyone together
  may hold, and after repeated wrong tokens from one address it stops answering that address
  for a while. A device sees these as an HTTP error status on the upgrade (403) or as a
  connection that is dropped with no answer; see "Transport".
- **Decoding is strict on purpose.** Duplicate keys, extra keys, fractional or negative
  numbers and unprintable characters are errors, not things to be interpreted. A message
  that two parsers could read two ways (a duplicated `ok`, for instance) is exactly how
  an approval would be forged.

## Transport

- WebSocket (RFC 6455) over plain TCP: `ws://<host>:<port>/`. The path is `/` and
  nothing else. Host and port are configuration on both ends; the protocol fixes neither.
- No sub-protocol is negotiated and `permessage-deflate` is not used.
- The device is the client and the bridge is the server. The bridge serves one device at
  a time (see "Reconnect and takeover").
- A **text** frame carries exactly one JSON object. A **binary** frame carries exactly one
  audio frame. Messages are never split across frames or packed several to a frame, and a
  device that cannot reassemble fragmented WebSocket messages must still hold a whole
  message in memory (the largest is in "Size budgets").
- Control frames (ping, pong, close) are ordinary RFC 6455. See "Keepalive".
- **Before the WebSocket exists** the bridge may answer the upgrade request with an HTTP
  status instead of `101`: `403` (a browser `Origin` header, or a device on the bridge's own
  machine and the bridge is not set up for one) or `404` (a path other than `/`). Or it may
  drop the TCP connection without a word (too many
  connections, or the address is locked out after repeated wrong tokens). A `403` will not
  get better by retrying. A dropped connection is treated like any other drop (see
  "Reconnect and takeover"), except that a device which keeps retrying a wrong token makes
  the lockout longer. The upgrade request itself must be complete within **5 seconds** of
  the TCP connection opening, or the bridge hangs up.

### Close codes

Every close the bridge sends or the transport sends on its behalf, and the one a device sees
when nobody sent a close at all:

| code | sent by | meaning |
|---|---|---|
| 1000 | either | normal close: the answer to a close the other side started |
| 1001 | bridge | the bridge is shutting down; reconnect with a backoff like any other drop |
| 1006 | nobody | not a code on the wire: what a device's library reports when the connection ended with no close frame (a Wi-Fi drop, or the bridge terminated a connection that went silent) |
| 1007 | transport | a text frame that is not valid UTF-8. No `err`, and before the handshake no `hello_ack`: the protocol never saw a message |
| 1008 | bridge | five undecodable or invalid frames in a row after the handshake (the fifth is answered with `err` `bad_msg` first) |
| 1009 | transport | a message above 2048 bytes. The same, before or after the handshake: no `err`, no `hello_ack` |
| 4001 | bridge | this connection was replaced by a newer valid one ("takeover") |
| 4002 | bridge | the handshake failed: the hello was refused (a `hello_ack` with `ok: false` was sent first) or no hello arrived in time (nothing was sent) |

Two limits matter for sizes. The protocol's frame limit is 1024 bytes of text for a message in
either direction. The transport admits up to 2048 bytes so that a frame between the two is
answered with `err` `bad_msg` ("frame too big") on a connection that stays open, instead of a
close the player could not explain. Above 2048 the transport closes with 1009.

A connection that goes silent is dropped without a close frame (see "Keepalive").

## Encoding

The rules below are exactly what `src/protocol.ts` enforces.

**What the bridge sends** is canonical: compact JSON (no whitespace), keys in exactly the
order of the field tables below with `t` first, strings containing only the two escapes
`\"` and `\\`, numbers as plain decimal digits. A firmware parser MAY rely on that for
frames from the bridge and nothing else. For `hello_ack` the order is `t`, `v`, `ok`,
then `sid` or `why`.

**What the bridge accepts** is any frame matching this grammar and the rules after it. A
device SHOULD send the canonical form too, but is not required to:

```
frame   = ws "{" ws [ member { ws "," ws member } ] ws "}" ws
member  = string ws ":" ws value
value   = string | uint | "true" | "false" | "null"
uint    = "0" | digit1-9 { digit0-9 }
string  = '"' { char | escape } '"'
char    = any byte 0x20-0xFF except '"' and '\'      (bytes below 0x20 are not allowed)
escape  = '\' ( '"' | '\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' | 'u' hex hex hex hex )
ws      = { 0x20 | 0x09 | 0x0A | 0x0D }
```

A frame is **refused** (`bad_msg`) unless all of these hold:

1. It is one object followed by nothing but whitespace. Arrays, bare values, trailing
   bytes and nested objects or arrays are refused. (`null` parses, but no field accepts
   it.)
2. Its size in UTF-8 bytes is within the frame limit of its direction ("Limits").
3. It has a string `t` naming a message type of the right direction, and **exactly** the
   keys that type defines: none missing, none extra, none repeated. Keys are compared
   after unescaping, case-sensitively, and in any order. The key `__proto__` is just an
   unknown key like any other.
4. Every value has the type its table says. Numbers are `uint` as above: no sign, no
   fraction, no exponent, no leading zero, at most 15 digits, and **at most
   2147483647**. That excludes `-0`, `1.0`, `1e2`, `1e999`, `01`, `+1`, `NaN` and
   `Infinity`. Booleans are the literals `true` and `false` only (not `1`, not `"true"`).
5. Every string, **after unescaping**, is printable ASCII, 0x20 to 0x7E, and within its
   length limits. So no NUL, no control characters (an escaped `\n` or `\u0000` is
   refused), no DEL, nothing above 0x7E (an escaped `\u00e9` is refused), no lone
   surrogates. This is why an accepted frame is always pure 7-bit ASCII.
6. Enumerated values are exact, case-sensitive members of the list in their table.

The firmware SHOULD apply the same rules to what it receives from the bridge. The invalid
bridge fixtures exist to test exactly that.

**For a C++ parser:** every string field has a maximum length, so a fixed buffer of
`max + 1` bytes always suffices and nothing needs the heap. No field is a float. The
largest number is `2147483647`, which fits `int32_t`.

## Limits

These are the values in `src/types.ts` (`LIMITS`) plus two this document pins itself.
Lengths of strings are in characters, which for printable ASCII are also bytes.

<!-- LIMITS_TABLE -->

| name | value | meaning |
|---|---|---|
| `deviceFrameMax` | 1024 | largest text frame the device may send, bytes |
| `bridgeFrameMax` | 1024 | largest text frame the bridge sends, bytes: size the receive buffer to this |
| `tokenMin` | 16 | shortest `token` |
| `tokenMax` | 64 | longest `token` |
| `devMax` | 32 | longest `dev` |
| `fwMax` | 16 | longest `fw` |
| `labelMax` | 16 | longest `tl` (tool label) |
| `idLen` | 8 | an ask id is exactly this many lowercase hex characters |
| `sayMax` | 400 | longest `say` text |
| `sttMax` | 240 | longest `stt` text |
| `resultMax` | 240 | longest `result` text |
| `summaryMax` | 96 | longest `sum` |
| `errMax` | 64 | longest `err` `msg` |
| `audioPayloadMax` | 1280 | largest audio payload, bytes: 40 ms of 16 kHz s16le mono |
| `utteranceMaxBytes` | 1120000 | the bridge's ceiling on one dictated utterance (35 s of audio) |
| `sidMax` | 64 | longest `sid` (not in `LIMITS`; fixed by this document and the codec) |
| `intMax` | 2147483647 | largest value of any integer on the wire |

## Connection lifecycle

```
device                                   bridge
  |  open ws://host:port/                    |
  |----------------------------------------->|
  |  hello                                   |   within 10 s of opening the socket
  |----------------------------------------->|
  |                      hello_ack ok:true   |
  |<-----------------------------------------|
  |                      state  (seq 1)      |
  |<-----------------------------------------|
  |                      ask ... (if one is open)
  |<-----------------------------------------|
  |  ...normal traffic...                    |
```

### Handshake

`hello` MUST be the first frame the device sends, and the bridge expects it within **10
seconds** of the socket opening; otherwise it closes the connection with 4002 (there is
no hello to answer, so no `hello_ack` is sent). The bridge checks the hello in this
order and stops at the first failure:

1. The frame is a valid `hello` (any decode failure, a non-text first frame, an
   oversized frame, or any other message type first): `hello_ack` with `why: bad_hello`.
2. `v` equals the bridge's protocol version, **1**: otherwise `why: version`.
3. `token` equals the configured token: otherwise `why: token`.
4. `rate` is 16000, `bits` is 16 and `ch` is 1: otherwise `why: bad_hello`. (The codec
   checks that these are integers; whether they are the right integers is the bridge's
   job, so a device with other audio parameters is refused here, not by the codec.)

On any failure the bridge sends `hello_ack` with `ok: false` (its `v` is always the
bridge's own version, so a device can report which version the bridge speaks), then closes
with 4002. A wrong token is answered only after **half a second**, so a device's own wait for
the `hello_ack` must be longer than that. Once a connection has been refused it is finished:
anything else it sends, in the same burst or later, is ignored, and cannot become a second
attempt. One socket gets one answer to one `hello`; a second `hello` that arrives while a
wrong token is being answered is not looked at.

After several wrong tokens from the same address (counted across connections) the bridge
stops answering that address for a while, and the pause doubles with each further failure up
to five minutes; a right token resets the count. A device that is told `why: token` should
stop and ask the player, not retry.

On success the bridge takes over any existing connection (below) and then sends, in
this order:

1. `hello_ack` with `ok: true`.
2. `state`, with `seq` 1 and the bridge's current phase.
3. The ask that is currently presented, if there is one, with its **remaining** `ttl`.

`hello` is valid exactly once per connection. A second one is `bad_msg`.

Until the handshake succeeds the connection receives nothing except the refusal.

## Device to bridge

Every table lists every key; there are no optional keys. "String" means printable ASCII.

### `hello`

The first frame of every connection.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `hello` | |
| `v` | integer | 0 to `intMax` | protocol version; MUST be 1 |
| `token` | string | `A-Z a-z 0-9 . _ ~ -` only | 16 to 64 characters; the shared secret |
| `dev` | string | any printable ASCII | 0 to 32 characters; a label for logs, e.g. the device name |
| `fw` | string | any printable ASCII | 0 to 16 characters; firmware version, for logs |
| `rate` | integer | 0 to `intMax` | sample rate of the audio this device sends and accepts; MUST be 16000 |
| `bits` | integer | 0 to `intMax` | bits per sample; MUST be 16 |
| `ch` | integer | 0 to `intMax` | channels; MUST be 1 |

### `say`

A typed prompt. Also how a dictated one is sent once the player has accepted the
transcript: **a transcript never starts a turn by itself**. After `stt` the bridge rests at
`idle` and waits; the device shows the text and, when the player taps SEND, sends it back as a
`say`. Claude then gets exactly the text that was sent.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `say` | |
| `text` | string | any printable ASCII | 0 to 400 characters |

Sent while a turn is running, or while the bridge is `listening` or `transcribing`, it is
answered with `err` `busy` (and a listen window stays open). Text that is empty or only
spaces is answered with `err` `empty`. The text of a `say` has no power to approve anything.

### `listen`

Push-to-talk control.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `listen` | |
| `m` | string | `start`, `stop`, `cancel` | |

`start` opens a listen window: the bridge reports phase `listening` and accepts MIC audio
frames. `stop` closes it and the bridge transcribes what it received (phase
`transcribing`, then an `stt` message, then `idle`). `cancel` closes it and discards the audio,
or abandons a transcription that is still running (its result, if it arrives later, is thrown
away). The device caps an utterance at 30 seconds; the bridge refuses more than 1120000 bytes
(35 seconds) with `err` `too_long` and closes the window. `start` while a turn is running or
while a transcription is in flight is `busy`; `start` inside an open window starts it over.
`stop` with no window open is `err` `not_listening`.

### `ask_rsp`

The player's answer to an `ask`. **The only message that can approve a tool call.**

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `ask_rsp` | |
| `id` | string | `0-9 a-f` only | exactly 8 characters; the `id` of the `ask` being answered |
| `ok` | boolean | `true`, `false` | `true` allows the call, `false` denies it |

Only the id of the ask currently presented is accepted. Any other (never asked, already
answered, expired, still waiting its turn, or from before a bridge restart) is answered
with `err` `unknown_ask` and changes nothing.

### `abort`

Stop the running turn. Takes no fields.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `abort` | |

Every open ask is denied and the turn is interrupted. The ask that is being presented ends
with `ask_end` `abort`; asks still waiting behind it end silently, because they were never
shown. The turn then ends with a `result` whose `ok` is `false` (text "Stopped." unless the
session said something else), and the phase goes to `idle`, not `done` or `error`: a stop is
not a failure. The device MUST treat the next `state` as the truth about what happened.

`abort` with no turn running does not stop anything, but it still ends every open ask in the
same way (an ask can outlive its turn, and "stop everything" must not leave an approval on
the panel). It does nothing else, and it is never answered: no `err`, no `state` unless an
ask ended. In particular it does **not** close a listen window or abandon a transcription;
send `listen` `cancel` for that.

### `ping`

Application-level keepalive. See "Keepalive".

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `ping` | |
| `n` | integer | 0 to `intMax` | any value; echoed in the `pong` |

## Bridge to device

### `hello_ack`

The answer to `hello`. It has two forms, chosen by `ok`; each form has exactly the keys
listed for it, and the other form's key is an error.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `hello_ack` | |
| `v` | integer | 0 to `intMax` | the bridge's protocol version (1), in both forms |
| `ok` | boolean | `true`, `false` | selects the form |
| `sid` | string | any printable ASCII | only when `ok` is `true`; 0 to 64 characters; an opaque identifier of the bridge's current session, for logs. The device MUST NOT interpret it. |
| `why` | string | `token`, `version`, `bad_hello` | only when `ok` is `false`; why the hello was refused |

`token` is a wrong token, `version` a protocol version the bridge does not speak, and
`bad_hello` anything else wrong with the hello. After a refusal the bridge closes with
4002 and the device SHOULD NOT retry in a loop: none of the three can fix itself.

### `state`

What the session is doing now. Drives the pet's animation.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `state` | |
| `seq` | integer | 0 to `intMax` | 1 on the first state of a connection, then +1 for each state sent on it |
| `ph` | string | `idle`, `listening`, `transcribing`, `thinking`, `tool`, `asking`, `speaking`, `done`, `error` | the phase |
| `tl` | string | any printable ASCII | 0 to 16 characters; the tool label: empty unless `ph` is `tool` or `asking` |
| `pend` | integer | 0 to `intMax` | the number of asks open: the one being presented plus any waiting behind it |

The bridge sends a `state` whenever the phase, the label or the pending count changes.
The phases mean:

| phase | meaning |
|---|---|
| `idle` | nothing is running; ready for `say` or `listen` `start` |
| `listening` | a listen window is open; MIC audio is being accepted |
| `transcribing` | the audio is being turned into text |
| `thinking` | the session is working and no tool is running |
| `tool` | a tool call is running; `tl` names it |
| `asking` | at least one ask is open and the session is waiting for the player; `tl` names the tool asked about |
| `speaking` | the bridge is streaming TTS audio (only when it has a voice) |
| `done` | a turn has just finished normally |
| `error` | a turn has just failed |

Treat each `state` as a complete snapshot that replaces the last one. The device MUST NOT
depend on which phases occur between two others, or on the order of a `state` relative to
the `ask`, `ask_end` or `result` that goes with it. A receiver SHOULD ignore `tl` unless
`ph` is `tool` or `asking` (both decoders accept a non-empty `tl` in other phases, so a
receiver that shows it would show a stale label).

`done` and `error` are **transient**: the bridge follows each with `idle` in the same instant,
so the device cannot wait for `idle` to end a celebration or an error face; it must time
that itself. `pend` is the number of asks open **right now**, and it is never `0` while an
ask is on the screen: the bridge ends an ask (`ask_end`) before it reports the count without
it. An ask can outlive the turn that raised it, so `asking` with `pend` above zero can follow
a `result`; the phase is `idle` only when nothing is open.

### `stt`

The bridge's transcript of the last dictated utterance. Informational: the device shows
it and, if the player accepts, sends it back as a `say`.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `stt` | |
| `text` | string | any printable ASCII | 0 to 240 characters |

### `ask`

A permission request: Claude wants to use a tool and the bridge needs the player's yes or
no.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `ask` | |
| `id` | string | `0-9 a-f` only | exactly 8 characters; quote it back in `ask_rsp` |
| `tl` | string | any printable ASCII | 0 to 16 characters; the tool's name |
| `risk` | string | `low`, `med`, `high` | how dangerous the bridge judges the call; the device decides how loudly to show it |
| `sum` | string | any printable ASCII | 0 to 96 characters; what the call does, built from the real tool input |
| `ttl` | integer | 0 to `intMax` | whole **seconds** the player has left to answer, rounded up |

The bridge presents **one ask at a time**: when Claude wants several tools at once, the
others wait in a queue, are counted in `pend`, and are presented in turn as each one ends.
An ask's clock starts when it is presented, not when it was requested. The bridge sends at
least 1 in `ttl`; 0 is nonetheless valid on the wire and a device MUST accept it.

The bridge's own timer is authoritative. When it runs out, the call is denied and the
bridge sends `ask_end` `timeout`; the device SHOULD stop showing the ask at `ttl` zero
without waiting, and MUST NOT answer an ask it believes is expired. A device SHOULD
ignore a tap for a short moment after an ask appears, so a tap already in flight cannot
answer a question the player has not read.

What `sum` and `risk` hold is the bridge's business and may change between bridge versions;
a device shows them and MUST NOT parse them. Today: for a shell command, the command itself
(cut at 96 characters, and a cut or multi-line command is at least `high`); for a file tool,
the path (the content of a write is not shown); for a web fetch, host, path and query; for any
tool the bridge does not know (an MCP tool), the tool's name, the fields that identify its
target, and the size of its input, always `high`. Any character that is not printable ASCII
is shown as `?` and rates the call at least `high`. A call whose arguments look like a
catastrophe is not asked about at all.

An `ask` **replaces** whatever ask the device is showing, whatever its `id`: the bridge
never presents two at once on a connection (it sends the old one's `ask_end` first), so a
second `ask` arriving means the first is gone. The device keys what it shows by `id` and
shows the newest.

The bridge holds at most **8** asks open (the presented one plus those waiting). A call that
would be the ninth is refused at once, with a message the model reads, and the device is not
bothered with it.

### `ask_end`

An ask is no longer open. The device MUST stop showing it.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `ask_end` | |
| `id` | string | `0-9 a-f` only | exactly 8 characters; the ask that ended |
| `why` | string | `answered`, `timeout`, `abort`, `disconnect` | why it ended |

When an ask ends and another is waiting, the `ask_end` for the old one is sent before the
`ask` for the next, so the device never shows two at once. (The `state` carrying the new
`pend` follows them, but see the rule about `state` ordering above.)

`answered`: an `ask_rsp` was applied (it is the only reason the device causes, and it is
sent whether the answer was yes or no). `timeout`: no answer in time; the call was denied.
`abort`: the turn was aborted; denied. `disconnect`: reserved. The device being away longer
than the grace period denies the ask, but that can only happen while no device is connected,
so there is nobody to tell and the bridge **never sends this reason**; a device MUST still
accept it. What a device that was away learns instead is in "Reconnect and takeover": an ask
that is not re-sent after the handshake is gone.

Only the ask being presented is announced. Asks waiting behind it have no id on the wire yet
and end silently if they end before their turn comes (an `abort`, for instance).

### `result`

The turn is over. **Every turn ends with exactly one `result`**, whatever ended it: the
session's answer, an error, a stop, or the session failing outright. (A session that fails
outright also gets an `err` `driver` just before its `result`, which has `ok` `false`; the
`err` is the short reason for logs and the `result` is the end of the turn.) A device that
releases its input on `result` therefore never waits for something that is not coming. It is
not replayed: a device that was away when it was sent learns the outcome from the `state` it
gets on reconnecting, which is `idle` or the turn still in progress.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `result` | |
| `ok` | boolean | `true`, `false` | whether the turn succeeded |
| `text` | string | any printable ASCII | 0 to 240 characters; a short summary, already reduced to whole sentences where they fit |

### `err`

Something the device did, or something that went wrong, that is not fatal to the
connection. An `err` does not close the connection, with one exception: the fifth frame in a
row that cannot be decoded is answered with `err` `bad_msg` and then closed with 1008. Any
frame that decodes resets that count.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `err` | |
| `code` | string | `bad_msg`, `busy`, `unknown_ask`, `not_listening`, `too_long`, `empty`, `stt_unavailable`, `stt_failed`, `driver`, `internal` | what happened; see "Errors" |
| `msg` | string | any printable ASCII | 0 to 64 characters; a reason for logs. Never parse it; the wording may change. |

### `pong`

The reply to `ping`.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `pong` | |
| `n` | integer | 0 to `intMax` | the `n` of the `ping` it answers |

## Binary frames

```
byte 0       kind    0x01 = MIC (device to bridge)    0x02 = TTS (bridge to device)
bytes 1..N   PCM     signed 16-bit little-endian samples, mono, 16000 Hz
```

- The payload (everything after the kind byte) is **2 to 1280 bytes and an even number of
  bytes**: whole samples only, at most 640 samples, which is 40 ms. A frame of 640 bytes
  (20 ms) is a good size, and 50 of them make a second of audio. The largest binary frame
  is 1281 bytes.
- Any other kind, an empty payload, an odd payload or a longer one is refused. A device
  frame refused for this is answered with `err` `bad_msg`.
- The **direction** is part of the rule and is not visible in the frame: the device MUST
  send only kind `0x01`, and the bridge only kind `0x02`. A frame of the wrong kind for
  its direction is a protocol violation (`bad_msg` from the bridge; the device SHOULD
  drop it). The fixtures do not test this, because the frame decoder does not know the
  direction.
- MIC frames are accepted only inside a listen window (between `listen` `start` and
  `stop` or `cancel`); outside it the bridge answers `err` `not_listening` and discards
  them. TTS frames are sent only while the phase is `speaking`; the end of speech is the
  `state` that leaves `speaking`.
- Frames carry no sequence number; the WebSocket is ordered and reliable.

## Sequences

A typed turn that needs an approval:

```
device                                  bridge
  | say "run the unit tests"               |
  |--------------------------------------->|
  |                  state thinking        |
  |<---------------------------------------|
  |                  state asking, pend 1  |
  |                  ask id=a3f09c1e ...   |   (these two arrive back to back,
  |<---------------------------------------|    in either order)
  |  (the player taps ALLOW)               |
  | ask_rsp id=a3f09c1e ok=true            |
  |--------------------------------------->|
  |                  ask_end answered      |
  |                  state tool, pend 0    |
  |<---------------------------------------|
  |                  ...                   |
  |                  result ok=true        |
  |                  state done, then idle |
  |<---------------------------------------|
```

A dictated turn. The transcript is shown first; only the player's tap sends it:

```
device                                  bridge
  | listen start                           |
  |--------------------------------------->|
  |                  state listening       |
  |<---------------------------------------|
  | MIC audio frames ...                   |
  |--------------------------------------->|
  | listen stop                            |
  |--------------------------------------->|
  |                  state transcribing    |
  |                  stt "run the unit tests"
  |<---------------------------------------|
  |  (the player reads it and taps SEND)   |
  | say "run the unit tests"               |
  |--------------------------------------->|   ... as a typed turn
```

An ask nobody answers: the bridge sends `ask_end` `timeout` when `ttl` runs out and the
call is denied. An `abort` while an ask is open ends it with `ask_end` `abort`. A
`listen` `cancel` leaves no transcript.

## Errors

An `err` is about what the device did or what the bridge could not do; a refused hello is a
`hello_ack`, not an `err`. It never closes the connection, except as described under `err`
(five undecodable frames in a row).

| code | when | what the device should do |
|---|---|---|
| `bad_msg` | a frame that does not decode, is oversized (1025 to 2048 bytes), is of an unknown or wrong-direction type, or is out of sequence (a second `hello`, an audio frame with a bad kind or length) | log `msg`; it is a firmware bug |
| `busy` | `say` while a turn is running or the bridge is listening or transcribing; `listen` `start` while a turn is running or a transcription is in flight | tell the player to wait, or `abort` / `listen` `cancel` |
| `unknown_ask` | `ask_rsp` for an id that is not the ask being presented | drop that ask from the screen |
| `not_listening` | a MIC frame outside a listen window (at most one reply a second); `listen` `stop` with no window open | stop sending audio |
| `too_long` | the utterance passed 1120000 bytes; the window is closed and the audio discarded | tell the player; the device's own 30 s cap should prevent it |
| `empty` | `say` with empty or blank text, or nothing intelligible in the audio | ask the player to try again |
| `stt_unavailable` | the bridge has no speech-to-text configured | fall back to typed input |
| `stt_failed` | speech-to-text failed | ask the player to try again |
| `driver` | the Claude session failed; a `result` with `ok` false follows | show an error; a new `say` starts again |
| `internal` | a bug in the bridge | log it |

`msg` is for people reading logs. Do not branch on it.

A device that receives a frame it cannot decode from the bridge SHOULD log it and ignore it:
the bridge's frames are all canonical, so an undecodable one is a bug on one side, and the
next `state` restores what matters.

## Input rules

What the bridge does with each input in each phase. Nothing here is a guess: each row is a
case the bridge's end-to-end tests drive.

| input | phase | result |
|---|---|---|
| `say` with text | `idle` (also `done`, `error`) | starts a turn: `state` `thinking` |
| `say` with empty or blank text | any | `err` `empty`; nothing starts |
| `say` | `thinking`, `tool`, `asking` (a turn is running) | `err` `busy`; the turn is untouched |
| `say` | `listening`, `transcribing` | `err` `busy`; the window or transcription is untouched |
| `listen` `start` | `idle` | opens a window: `state` `listening` |
| `listen` `start` | `listening` | starts the window over; the audio so far is discarded |
| `listen` `start` | a turn running, or `transcribing` | `err` `busy` |
| MIC audio | `listening` | collected |
| MIC audio | any other phase | `err` `not_listening` (at most one a second); the audio is discarded |
| `listen` `stop` | `listening` | `state` `transcribing`, then `stt` and `state` `idle` (or an `err`, then `idle`) |
| `listen` `stop` | no window open | `err` `not_listening` |
| `listen` `cancel` | `listening` or `transcribing` | discards the audio or abandons the transcription: `state` `idle`. Nothing is said if nothing was open |
| `abort` | a turn running | denies every open ask, interrupts the turn, ends with `result` (ok false) and `idle` |
| `abort` | no turn, an ask open | ends the ask(s) with `ask_end` `abort`; no `result` |
| `abort` | `listening`, `transcribing`, or nothing open | nothing, and no reply. Use `listen` `cancel` |
| `ask_rsp` | the id of the ask being presented | applied once: `ask_end` `answered` |
| `ask_rsp` | any other id, including one that was already answered | `err` `unknown_ask`; nothing changes |
| `ping` | any | `pong` with the same `n` |
| `hello` | after the handshake | `err` `bad_msg` ("hello sent twice") |

The way to cancel a transcription is `listen` `cancel`, and the way to stop a turn is `abort`:
each is ignored in the other's phase, so that a stray tap cannot do the wrong thing.

## Reconnect and takeover

- **One device at a time.** A new connection that passes the handshake takes over: the
  bridge closes the old connection with code **4001**, then sends the new one
  `hello_ack`, a fresh `state` with `seq` 1, and the ask that is currently presented (if
  any) again with its **remaining** `ttl` (not the original). A connection that fails the handshake takes
  over nothing.
- **A device that is closed with 4001 SHOULD NOT reconnect by itself.** Something else
  took its place; reconnecting at once would take it back and the two would evict each
  other forever. Wait for the player.
- **Any other drop** (Wi-Fi, a sleeping access point, a restarted bridge): reconnect with
  a backoff, for example 1 s doubling up to 30 s, and run the handshake again.
- **Open asks survive a short disconnect.** They stay open for a **grace period** set in
  the bridge's configuration (the device MUST NOT assume a value; the default is 15 seconds).
  If the device is back and has passed the handshake inside it, the ask is re-sent and can
  still be answered, with the `ttl` that is left. After the grace period the call is denied
  and the ask is gone: it is not re-sent, nothing is said about it, and an answer for it gets
  `unknown_ask`.
- **The device's view is rebuilt from the handshake, and the rule is: on every handshake,
  discard any ask you are showing that is not sent again.** `seq` restarts at 1 and `state`
  is a snapshot, so the device replaces what it believed. The first `state` of a connection
  says how many asks are open: **`pend` 0 means none**, and a device that sees it MUST take
  down any ask it still has on the screen. If `pend` is above zero the bridge sends the
  presented ask right behind the `state`, and an ask the device was showing under another
  `id` is replaced by it. An ask is identified by its `id`, so showing the same ask a second
  time is harmless: the device SHOULD key what it shows by `id`. There is no end-of-handshake
  marker; `pend` in the first `state` is the signal.
- **Nothing else is replayed.** The bridge makes no promise to repeat an `stt`, `result`,
  `ask_end` or `err` that was sent while the device was away. In particular the bridge does
  not send `ask_end` `disconnect` for an ask that expired while the device was gone.
- **Close events are per socket.** A device that has already opened a new connection may
  still receive the old one's close (a late 4001 from a half-open socket): handle `close` on
  the socket it belongs to, and let it stop a reconnect only if it is the current socket's.

## Keepalive

- The bridge sends a WebSocket **ping** every **10 seconds**. The device's WebSocket
  library MUST answer with a pong (every common one does this on its own).
- Any frame from the device, including that pong, counts as activity. The bridge looks at
  each connection **every 5 seconds**; at the first look that finds **more than 25 seconds**
  of silence it drops the connection, without a close frame. A silent device is therefore
  dropped between 25 and 30 seconds after its last frame (more than 25, at most 30).
- The device MAY send an application `ping` at any time; the bridge answers with a
  `pong` carrying the same `n`. That tells the device the bridge's code is alive, not
  merely its socket. A device that has not heard from the bridge in about 25 seconds
  SHOULD treat the link as dead and reconnect; pinging every 10 seconds makes that
  detectable.

### Timings in one place

Every default the bridge ships with, from `DEFAULTS` in `src/server.ts`; a test compares this
table with that object row for row, so a number cannot change on one side only. A deployment
may override any of them (`askTtlMs` and `graceMs` are the two an operator sets from the
command line); a device MUST NOT assume the defaults for those two.

<!-- TIMINGS_TABLE -->

| setting | default | what it is |
|---|---|---|
| `helloTimeoutMs` | 10 s | time to send `hello` after the socket opens; otherwise 4002 |
| `headersTimeoutMs` | 5 s | time to finish the HTTP upgrade request after the TCP connection opens |
| `authFailDelayMs` | 0.5 s | a wrong token is answered only after this long |
| `authFreeFailures` | 5 | wrong tokens from one address before it is paused |
| `authLockoutBaseMs` | 2 s | the first pause; each further wrong token doubles it |
| `authLockoutMaxMs` | 5 min | the longest pause |
| `authForgetMs` | 10 min | an address with no wrong token for this long is forgotten |
| `pingIntervalMs` | 10 s | WebSocket ping interval |
| `keepaliveCheckMs` | 5 s | how often a connection is looked at for silence |
| `deadAfterMs` | 25 s | silence beyond this, found at a look, drops the connection |
| `askTtlMs` | 90 s | time to answer an ask (its `ttl` counts down from this) |
| `graceMs` | 15 s | how long an ask outlives a disconnect |
| `maxConnections` | 32 | TCP connections the bridge holds, from anyone |
| `maxConnectionsPerAddress` | 8 | TCP connections from one address |
| `maxBufferedBytes` | 64 KiB | bytes queued for a device that is not reading, beyond which it is dropped |
| `maxOpenAsks` | 8 | asks open at once, the presented one included |

One utterance is capped at 30 s on the device and 35 s on the bridge (`utteranceMaxBytes`).

## Versioning

The protocol version is the integer `v`, currently **1**, and it is exact: the bridge
speaks one version, and a `hello` with any other `v` is refused with `why: version`.
There is no negotiation and no "compatible" range, because decoding is strict: adding a
key, a message type, an enum member or tightening a limit makes a frame the old side
would refuse, so every such change is a new version. A firmware in somebody's pocket
cannot be patched by pulling, which is why a mismatch is a clear message
(`hello_ack` `version`) and not a silent misreading.

## Size budgets

Worst case, with every string at its maximum length and made entirely of characters that
JSON escapes (`"` or `\`, which cost two bytes each) and every number at its largest, the
frames are:

<!-- WORST_CASE_TABLE -->

| type | worst-case frame, bytes | direction |
|---|---|---|
| `hello` | 268 | device |
| `say` | 821 | device |
| `listen` | 27 | device |
| `ask_rsp` | 42 | device |
| `abort` | 13 | device |
| `ping` | 27 | device |
| `hello_ack` | 179 | bridge |
| `state` | 108 | bridge |
| `stt` | 501 | bridge |
| `ask` | 299 | bridge |
| `ask_end` | 50 | bridge |
| `result` | 515 | bridge |
| `err` | 173 | bridge |
| `pong` | 27 | bridge |

The largest text frame is 821 bytes, under both 1024-byte limits, so no valid message can
be refused for size. The largest binary frame is 1281 bytes (one kind byte and 1280 bytes
of audio). A receive buffer of 1024 bytes for text and 1281 for binary is always enough.
A typical `ask` is about 80 bytes and a typical `state` about 55.

Audio is 32000 bytes per second each way. At 20 ms per frame that is 50 frames a second,
each 641 bytes on the wire.

## Conformance fixtures

`fixtures/` holds one file per wire frame, with `manifest.json` listing them. A firmware
test needs nothing else:

```
{ "file": "bridge-ask-high.txt", "dir": "bridge", "kind": "text", "expect": "valid", "note": "..." }
{ "file": "invalid-device-extra-key-ping.txt", "dir": "device", "kind": "text", "expect": "invalid", "code": "bad_msg", "note": "..." }
```

- `file`: the exact bytes of one frame. A `.txt` file is one WebSocket **text** frame
  with no trailing newline; a `.bin` file is one **binary** frame. A zero-byte file is a
  zero-length frame.
- `dir`: who sent it. `device` means the device sent it (the bridge decodes it); `bridge`
  means the bridge sent it (the device decodes it).
- `expect`: `valid` frames MUST decode, and every field MUST hold the value the frame
  says. `invalid` frames MUST be refused. `code` is then always `bad_msg`.
- `canonical`: present only as `false`, on a valid device frame that the bridge accepts but
  no encoder would write (whitespace, keys in another order, an escape such as `\/` or
  `\u0041`, a key spelled with an escape). Re-encoding it gives different bytes, so the
  "decode and re-encode to the same bytes" check does not apply to it. A firmware never has to
  produce these; another implementation of the bridge has to accept them. Every other valid
  fixture is canonical, and a manifest entry has no `canonical` key.
- The valid fixtures cover every message type, both forms of `hello_ack`, every phase,
  risk, `ask_end` reason, `err` code and refusal, and audio frames of 2, 640 and 1280
  bytes in both directions, plus the largest possible frame of each text type (the sizes in
  "Size budgets"; a test compares them). The valid `bridge` text fixtures are exactly what
  the bridge's encoder produces today, so they are also the firmware's reference input.
- The invalid fixtures each contain a single defect on top of an otherwise valid frame:
  an unknown type, a missing key, an extra key, a duplicated key, a wrong type, a bad
  number, a bad enum value, non-ASCII, an over-long string, an oversized frame, a bad id,
  a short token, an array or `null` instead of an object, a `__proto__` key, and bad
  audio (odd length, unknown kind, empty).

The fixtures are regenerated by `node tools/gen-fixtures.ts` from the real encoders, and
`test/fixtures.test.ts` fails if the committed bytes drift from them.

## Worked example

A complete conversation. Lines starting with `D>` are text frames the device sends, lines
starting with `B>` are frames the bridge sends, lines starting with `#@` are things that
happen that are not frames (audio, time passing, the connection dropping), and lines
starting with `#` are commentary.

This is not an illustration: `test/server.e2e.test.ts` **replays it against a live bridge**.
It sends each `D>` line, performs each `#@` action, and compares what the bridge sends with
the `B>` lines that follow, byte for byte and in order, so the order of the `state` messages
around an `ask` is the order a real bridge produces. (The bridge here asks for 60 seconds, not
the default 90, and a scripted Claude asks to run `npm test` and then `rm -rf build`.)
`test/protocol.test.ts` also decodes every line and re-encodes it to prove it is canonical.

```transcript
# 1. Connect. The device speaks first; its token is a placeholder here.
D> {"t":"hello","v":1,"token":"example.token_0123456789~abcdef","dev":"tamaclaude-a1b2","fw":"0.1.0","rate":16000,"bits":16,"ch":1}
B> {"t":"hello_ack","v":1,"ok":true,"sid":"c0ffee00-1234-4abc-8def-0123456789ab"}
B> {"t":"state","seq":1,"ph":"idle","tl":"","pend":0}
# 2. Keepalive at the application level (optional; see Keepalive).
D> {"t":"ping","n":1}
B> {"t":"pong","n":1}
# 3. Push to talk. Between start and stop the device sends binary MIC frames.
D> {"t":"listen","m":"start"}
B> {"t":"state","seq":2,"ph":"listening","tl":"","pend":0}
#@ mic 25 frames of 640 bytes (20 ms each)
D> {"t":"listen","m":"stop"}
B> {"t":"state","seq":3,"ph":"transcribing","tl":"","pend":0}
B> {"t":"stt","text":"run the unit tests"}
B> {"t":"state","seq":4,"ph":"idle","tl":"","pend":0}
# 4. Nothing runs yet: a transcript is only shown. The player reads it and taps SEND,
#    so the device sends it as a say. Only now does a turn start.
D> {"t":"say","text":"run the unit tests"}
B> {"t":"state","seq":5,"ph":"thinking","tl":"","pend":0}
# 5. Claude starts a command, so the phase is `tool`, and then asks. The ask comes before the
#    state that reports it, and only the tap can allow it.
B> {"t":"state","seq":6,"ph":"tool","tl":"Bash","pend":0}
B> {"t":"ask","id":"a3f09c1e","tl":"Bash","risk":"med","sum":"npm test","ttl":60}
B> {"t":"state","seq":7,"ph":"asking","tl":"Bash","pend":1}
D> {"t":"ask_rsp","id":"a3f09c1e","ok":true}
B> {"t":"ask_end","id":"a3f09c1e","why":"answered"}
B> {"t":"state","seq":8,"ph":"tool","tl":"Bash","pend":0}
B> {"t":"state","seq":9,"ph":"thinking","tl":"","pend":0}
# 6. The turn ends: one result, and the phase settles back to idle via done. `done` is
#    followed by `idle` at once; the device times its own celebration.
B> {"t":"result","ok":true,"text":"All 42 tests pass."}
B> {"t":"state","seq":10,"ph":"done","tl":"","pend":0}
B> {"t":"state","seq":11,"ph":"idle","tl":"","pend":0}
# 7. A second turn asks about a risky command; then the Wi-Fi drops with the ask still open.
D> {"t":"say","text":"delete the build folder"}
B> {"t":"state","seq":12,"ph":"thinking","tl":"","pend":0}
B> {"t":"state","seq":13,"ph":"tool","tl":"Bash","pend":0}
B> {"t":"ask","id":"b7d24e90","tl":"Bash","risk":"high","sum":"rm -rf build","ttl":60}
B> {"t":"state","seq":14,"ph":"asking","tl":"Bash","pend":1}
#@ wait 10 seconds
#@ drop the connection
#@ wait 9 seconds
# 8. Reconnect, 19 seconds after the ask appeared. A fresh state with seq 1 (pend 1: an ask is
#    open), then the ask again with its REMAINING ttl.
#@ reconnect
D> {"t":"hello","v":1,"token":"example.token_0123456789~abcdef","dev":"tamaclaude-a1b2","fw":"0.1.0","rate":16000,"bits":16,"ch":1}
B> {"t":"hello_ack","v":1,"ok":true,"sid":"c0ffee00-1234-4abc-8def-0123456789ab"}
B> {"t":"state","seq":1,"ph":"asking","tl":"Bash","pend":1}
B> {"t":"ask","id":"b7d24e90","tl":"Bash","risk":"high","sum":"rm -rf build","ttl":41}
D> {"t":"ask_rsp","id":"b7d24e90","ok":false}
B> {"t":"ask_end","id":"b7d24e90","why":"answered"}
B> {"t":"state","seq":2,"ph":"tool","tl":"Bash","pend":0}
B> {"t":"state","seq":3,"ph":"thinking","tl":"","pend":0}
B> {"t":"result","ok":true,"text":"I did not delete anything because you denied it."}
B> {"t":"state","seq":4,"ph":"done","tl":"","pend":0}
B> {"t":"state","seq":5,"ph":"idle","tl":"","pend":0}
# 9. The same id answered again is unknown now.
D> {"t":"ask_rsp","id":"b7d24e90","ok":true}
B> {"t":"err","code":"unknown_ask","msg":"no open ask with that id"}
```
