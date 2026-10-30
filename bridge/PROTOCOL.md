# TamaClaude bridge wire protocol

Protocol version **1**.

This is the specification the handheld's firmware is written from. The reference
implementation is `src/protocol.ts`. The two are held together by
`test/protocol.test.ts`: the limits, the size budgets and the worked example below are
checked against the code on every test run, and the byte-exact files in `fixtures/` are
the conformance suite for any other implementation (the firmware's test should read that
directory). If this document and the code ever disagree, one of them is wrong and a test
is red.

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
  displaces the current connection, never receives state, and is closed.
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

### Close codes

| code | sent by | meaning |
|---|---|---|
| 1000 | either | normal close |
| 1009 | transport | a frame was larger than the receiver's limit (the transport library does this before the protocol sees it) |
| 4001 | bridge | this connection was replaced by a newer valid one ("takeover") |
| 4002 | bridge | the handshake failed: the hello was refused (a `hello_ack` with `ok: false` was sent first) or no hello arrived in time |

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
  |  hello                                   |   within 10 s of opening
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
with 4002. On success it takes over any existing connection (below) and then sends, in
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
transcript: a transcript never starts a turn by itself.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `say` | |
| `text` | string | any printable ASCII | 0 to 400 characters |

Sent while a turn is running it is answered with `err` `busy`. The text of a `say` has no
power to approve anything.

### `listen`

Push-to-talk control.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `listen` | |
| `m` | string | `start`, `stop`, `cancel` | |

`start` opens a listen window: the bridge reports phase `listening` and accepts MIC audio
frames. `stop` closes it and the bridge transcribes what it received (phase
`transcribing`, then an `stt` message). `cancel` closes it and discards the audio. The
device caps an utterance at 30 seconds; the bridge refuses more than 1120000 bytes (35
seconds) with `err` `too_long`. `start` while a turn is running is `busy`.

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

Every open ask ends with `ask_end` `abort` (the calls are denied) and the turn is
interrupted. The device MUST treat the next `state` as the truth about what happened.

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
`ph` is `tool` or `asking`.

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
`abort`: the turn was aborted; denied. `disconnect`: the device was away longer than the
grace period; denied. A device that was away usually learns that one only by not seeing
the ask again after reconnecting.

### `result`

The turn is over. Sent once per turn.

| key | type | allowed | notes |
|---|---|---|---|
| `t` | string | `result` | |
| `ok` | boolean | `true`, `false` | whether the turn succeeded |
| `text` | string | any printable ASCII | 0 to 240 characters; a short summary, already reduced to whole sentences where they fit |

### `err`

Something the device did, or something that went wrong, that is not fatal to the
connection. `err` never closes the connection by itself.

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

`err` never closes the connection. Everything here is about what the device did or what
the bridge could not do; a refused hello is a `hello_ack`, not an `err`.

| code | when | what the device should do |
|---|---|---|
| `bad_msg` | a frame that does not decode, is oversized, is of an unknown or wrong-direction type, or is out of sequence (a second `hello`, an audio frame with a bad kind or length) | log `msg`; it is a firmware bug |
| `busy` | `say` or `listen` while a turn is running | tell the player to wait, or `abort` |
| `unknown_ask` | `ask_rsp` for an id that is not open | drop that ask from the screen |
| `not_listening` | a MIC frame outside a listen window | stop sending audio |
| `too_long` | the utterance passed 1120000 bytes; the audio is discarded | tell the player; the device's own 30 s cap should prevent it |
| `empty` | nothing intelligible in the audio | ask the player to try again |
| `stt_unavailable` | the bridge has no speech-to-text configured | fall back to typed input |
| `stt_failed` | speech-to-text failed | ask the player to try again |
| `driver` | the Claude session failed | show an error; a new `say` starts again |
| `internal` | a bug in the bridge | log it |

`msg` is for people reading logs. Do not branch on it.

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
  the bridge's configuration (the device MUST NOT assume a value). If the device is back
  and has passed the handshake inside it, the ask is re-sent and can still be answered,
  with the `ttl` that is left. After the grace period the call is denied and the ask is
  gone: it is not re-sent, and an answer for it gets `unknown_ask`.
- **The device's view is rebuilt from the handshake.** `seq` restarts at 1 and `state` is
  a snapshot, so the device replaces what it believed. An ask is identified by its `id`,
  so showing the same ask a second time is harmless: the device SHOULD key what it shows
  by `id`.
- **Nothing else is replayed.** The bridge makes no promise to repeat an `stt`, `result`,
  `ask_end` or `err` that was sent while the device was away.

## Keepalive

- The bridge sends a WebSocket **ping** every **10 seconds**. The device's WebSocket
  library MUST answer with a pong (every common one does this on its own).
- Any frame from the device, including that pong, counts as activity. If the bridge sees
  **no frame at all for 25 seconds** it drops the connection, without a close frame.
- The device MAY send an application `ping` at any time; the bridge answers with a
  `pong` carrying the same `n`. That tells the device the bridge's code is alive, not
  merely its socket. A device that has not heard from the bridge in about 25 seconds
  SHOULD treat the link as dead and reconnect; pinging every 10 seconds makes that
  detectable.

### Timings in one place

| what | value | enforced by |
|---|---|---|
| time to send `hello` after the socket opens | 10 s | bridge |
| WebSocket ping interval | 10 s | bridge |
| silence before the connection is dropped | 25 s | bridge |
| time to answer an ask | its `ttl`, in seconds | the bridge, authoritatively |
| how long an ask outlives a disconnect | the bridge's grace period (configuration) | bridge |
| one utterance | 30 s on the device, 35 s on the bridge | both |

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
- The valid fixtures cover every message type, both forms of `hello_ack`, every phase,
  risk, `ask_end` reason, `err` code and refusal, and audio frames of 2, 640 and 1280
  bytes in both directions, plus the largest possible frame of each text type. The valid
  `bridge` text fixtures are exactly what the bridge's encoder produces today, so they
  are also the firmware's reference input.
- The invalid fixtures each contain a single defect on top of an otherwise valid frame:
  an unknown type, a missing key, an extra key, a duplicated key, a wrong type, a bad
  number, a bad enum value, non-ASCII, an over-long string, an oversized frame, a bad id,
  a short token, an array or `null` instead of an object, a `__proto__` key, and bad
  audio (odd length, unknown kind, empty).

The fixtures are regenerated by `node tools/gen-fixtures.ts` from the real encoders, and
`test/fixtures.test.ts` fails if the committed bytes drift from them.

## Worked example

A complete conversation. Lines starting with `D>` are text frames the device sends, lines
starting with `B>` are frames the bridge sends, and lines starting with `#` are
commentary. The bytes are exactly what the encoders produce; `test/protocol.test.ts`
decodes every line and re-encodes it to prove it.

```transcript
# 1. Connect. The device speaks first; its token is a placeholder here.
D> {"t":"hello","v":1,"token":"example.token_0123456789~abcdef","dev":"tamaclaude-a1b2","fw":"0.1.0","rate":16000,"bits":16,"ch":1}
B> {"t":"hello_ack","v":1,"ok":true,"sid":"c0ffee00-1234-4abc-8def-0123456789ab"}
B> {"t":"state","seq":1,"ph":"idle","tl":"","pend":0}
# 2. Keepalive at the application level (optional; see Keepalive).
D> {"t":"ping","n":1}
B> {"t":"pong","n":1}
# 3. Push to talk. Between start and stop the device sends binary MIC frames (not shown).
D> {"t":"listen","m":"start"}
B> {"t":"state","seq":2,"ph":"listening","tl":"","pend":0}
D> {"t":"listen","m":"stop"}
B> {"t":"state","seq":3,"ph":"transcribing","tl":"","pend":0}
B> {"t":"stt","text":"run the unit tests"}
B> {"t":"state","seq":4,"ph":"idle","tl":"","pend":0}
# 4. The player reads the transcript and taps SEND, so the device sends it as a say.
D> {"t":"say","text":"run the unit tests"}
B> {"t":"state","seq":5,"ph":"thinking","tl":"","pend":0}
# 5. Claude wants to run a command. The bridge asks; only the tap can allow it.
B> {"t":"state","seq":6,"ph":"asking","tl":"Bash","pend":1}
B> {"t":"ask","id":"a3f09c1e","tl":"Bash","risk":"med","sum":"npm test","ttl":60}
D> {"t":"ask_rsp","id":"a3f09c1e","ok":true}
B> {"t":"ask_end","id":"a3f09c1e","why":"answered"}
B> {"t":"state","seq":7,"ph":"tool","tl":"Bash","pend":0}
B> {"t":"state","seq":8,"ph":"thinking","tl":"","pend":0}
# 6. The turn ends: one result, and the phase settles back to idle via done.
B> {"t":"result","ok":true,"text":"All 42 tests pass."}
B> {"t":"state","seq":9,"ph":"done","tl":"","pend":0}
B> {"t":"state","seq":10,"ph":"idle","tl":"","pend":0}
# 7. A second turn asks about a risky command; then the Wi-Fi drops with the ask still open.
D> {"t":"say","text":"delete the build folder"}
B> {"t":"state","seq":11,"ph":"thinking","tl":"","pend":0}
B> {"t":"state","seq":12,"ph":"asking","tl":"Bash","pend":1}
B> {"t":"ask","id":"b7d24e90","tl":"Bash","risk":"high","sum":"rm -rf build","ttl":60}
#    (19 seconds pass, the connection is lost, the device reconnects)
# 8. Reconnect. A fresh state with seq 1, then the open ask again with its REMAINING ttl.
D> {"t":"hello","v":1,"token":"example.token_0123456789~abcdef","dev":"tamaclaude-a1b2","fw":"0.1.0","rate":16000,"bits":16,"ch":1}
B> {"t":"hello_ack","v":1,"ok":true,"sid":"c0ffee00-1234-4abc-8def-0123456789ab"}
B> {"t":"state","seq":1,"ph":"asking","tl":"Bash","pend":1}
B> {"t":"ask","id":"b7d24e90","tl":"Bash","risk":"high","sum":"rm -rf build","ttl":41}
D> {"t":"ask_rsp","id":"b7d24e90","ok":false}
B> {"t":"ask_end","id":"b7d24e90","why":"answered"}
B> {"t":"state","seq":2,"ph":"thinking","tl":"","pend":0}
# 9. The same id answered again is unknown now.
D> {"t":"ask_rsp","id":"b7d24e90","ok":true}
B> {"t":"err","code":"unknown_ask","msg":"no open ask with that id"}
B> {"t":"result","ok":false,"text":"I did not delete anything because you denied it."}
B> {"t":"state","seq":3,"ph":"done","tl":"","pend":0}
B> {"t":"state","seq":4,"ph":"idle","tl":"","pend":0}
```
