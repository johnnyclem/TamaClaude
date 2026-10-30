# Claude pet: scoped plan

Goal: turn this fork into a handheld, voice-driven Claude Code client. The device
captures speech, a bridge (your laptop or an owned VM) runs the Claude Code session,
the device plays a short spoken reply, and the pet shows what the session is doing.

This is the output of a read-only investigation (8 area readers plus a critic).
**Nothing here compiled or flashed the real firmware.** The sandbox has no
`arduino-cli` and no SDL2; only the 48 host test suites were run (in a scratch
copy: 1155 PASS, 0 FAIL). Treat firmware-side numbers as estimates until Phase 0.

## Verdict

Feasible if the product is a **Claude Code desk pet**: it shows session state, asks
for approval with a big tap target, takes push-to-talk, and speaks a short summary.
It is not an always-listening assistant (no wake word, no barge-in, no echo
cancellation in v1).

Biggest reality checks, most important first:

1. **The microphone is not on the codec this firmware drives.** Both mics are on a
   separate ES7210 ADC (I2C 0x40, data out on GPIO10). The repo only initialises the
   ES8311 DAC (`audio.cpp`); there is no ES7210 code, no mic read, nothing. The I2S RX
   channel is already created (`audio.cpp:310`) but never read. This is the one item
   that can kill voice-in, so it goes first.
2. **The kit has no speaker**, only an MX1.25 connector. No speaker means no spoken
   replies; the product degrades to state plus tap-to-approve.
3. **"Mobile" is undecided.** The ESP32-S3 is 2.4 GHz only. `ws://` to a laptop works
   on a home LAN or a phone hotspot (iPhone: "Maximize Compatibility" on). Anything
   public needs `wss://`, i.e. TLS on the device, which is unmeasured (est. 22-42 KB
   internal heap).
4. **"Cloud" means your own VM running the bridge.** Claude Code on the web has no
   documented stream/poll API, so it cannot carry a live voice loop.
5. **Animation ceiling.** The full-frame flush is ~10 fps by the original author's
   comment (`TamaDigi.ino:1074`, "~56ms at 40MHz"). That number is unmeasured. Until
   it is, "quality" comes from effect design, latency-masking and a rim layer,
   not frame rate.
6. **Two famous numbers are one unmeasured comment each**: "NVS write freezes both
   cores ~1 s" (`TamaDigi.ino:~1266`) and the flush time above. Five reports cited
   them; that is one source, not five. Do not build mitigations until measured.

## Decisions needed (defaults in brackets)

| # | Decision | Default |
|---|---|---|
| 1 | Topology for "mobile": home LAN, phone hotspot, or public bridge | home LAN + iPhone hotspot; **no TLS in v1** |
| 2 | Bridge language | TypeScript (Agent SDK's primary, simplest `canUseTool`) |
| 3 | Bridge auth | `ANTHROPIC_API_KEY`; docs don't settle personal-bridge use of a subscription login |
| 4 | Does the care game stay? | yes, as downtime content; don't extend it; PTT/approvals independent of sleep/egg states |
| 5 | Speaker fitted? | needs a yes before Phase 7 |
| 6 | Dev machine | macOS: `say` for TTS, whisper.cpp for STT |

## Phases (each independently demoable)

**Phase 0: measure the current firmware (about 2 h, board).** HEALTH heap / min heap /
largest internal block / PSRAM; `micros()` around render, flush and `pet.save()`;
I2C scan for 0x18, 0x34, 0x40, 0x20; confirm the boot jingle through a speaker;
`arduino-cli compile` for `app.bin` vs the 3 MB slot. Output: one table of real numbers.

**Phase 1: ES7210 mic spike (board, parallel with 2).** A throwaway serial `MICREC`
command: init ES7210 (16 kHz, standard I2S on the existing 4.096 MHz MCLK), read 3 s
from RX, downmix, play back or dump a WAV. If silent, retry with AXP2101 ALDO1 enabled
(xiaozhi does; this repo enables only BLDO1, `rtcbat.cpp:58`). Fail case: voice-in
becomes typed/phone-side input and nothing else changes.

**Phase 2: desktop bridge, no hardware.** TS bridge on the Agent SDK (streaming input,
partial messages, `canUseTool` raced against a 60-120 s deny timer, fail closed on
disconnect). One wire protocol document with golden byte fixtures (the repo's
`golden.tpsave` pattern). `--fake-claude` mode and a fake device CLI. Demo: type a
request, watch state events, approve a Bash call.

**Phase 3: pet reacts, in the emulator only.** A pure companion reducer (message in,
effects out) behind one `onSessionEvent(kind)` boundary so game code never sees Wi-Fi.
Session states drive RAM-only sprite overrides, SFX/cries and a rim effect.
This is where animation and delight iterate, at zero hardware cost.

**Phase 4: board on the network, state only.** Wi-Fi STA + `ws://` client in its own
task; only a ring buffer and a state enum cross into `loop()`. Creds (SSID, password,
host, token) go in a **new NVS namespace** via serial `NET` commands, with
`WiFi.persistent(false)`; that keeps them out of EXPORT, `.tpsave` and WIPE. LAN
battles stay mutually exclusive (`linknow.cpp` pins channel 1 and turns Wi-Fi off).

**Phase 5: on-device approval.** Claude tile left of PET; 94 px ALLOW/DENY with a dead
guard band, tap lockout, `askId` binding, timeout = deny, wake the panel first,
force-navigate (precedent: forced party screen, `TamaDigi.ino:~1229`). The bridge
builds the prompt from the real `tool_input`, not the model's description, and
hard-blocks dangerous patterns in a PreToolUse hook. Voice can never grant approval.

**Phase 6: push-to-talk uplink.** Tap-to-toggle with a 30 s cap and an always-visible
mic indicator (not hold: the 3 s pet hold and 4 s PWR power-off already exist, and a
finger sliding off leaves the mic stuck open). Mic gated while the speaker plays; drop
the first 120-150 ms after any chirp. 16 kHz PCM in 20 ms frames; whisper.cpp on
release with a project keyword prompt; show the transcript with tap-to-send.

**Phase 7: spoken replies.** TTS to a PSRAM ring mixed inside `pump()` (the only path
to the codec). Speak nothing mid-turn; cover the wait with earcons and animation.
After the final result, speak a 1-3 sentence summary, sentence by sentence. Voice
rules go in the system prompt append; start a fresh session when they change.

## Defer on purpose

Opus/ADPCM, barge-in, AEC, wake word, `wss`/TLS, streaming STT, vendor TTS beyond one
adapter, an on-device keyboard or captive portal, partial flush / dirty rects,
transcript scrolling (the 5x7 font gives ~25 chars per line, so voice carries content
and the screen carries state), multi-project switching (fix `cwd` in bridge config),
any change to the pet/player checkpoint layout, the web-installer release machinery.

## Things to know about this checkout

- CLAUDE.md describes a **later** version than this tree (here: v1.0.0, one squashed
  commit). Its counts (DEX_COUNT, REGION_COUNT) and the release flow are stale.
  `check_release.py` and the release workflow cannot pass for this fork as written;
  develop and flash with `arduino-cli upload`.
- A new `.cpp` has to be added to four hand-kept source lists (emulator build, host
  tests, native tests, mutation build). Header-only modules avoid this.
- Blocking network calls in `loop()` freeze touch and render on both host and board.
- Copy the `link.cpp` / `linknow.cpp` split: pure protocol + state machine with an
  injected `send` (emulator-tested) and a thin radio transport (stubbed on desktop).
- The emulator can run against a real bridge over loopback and, with SDL2 audio,
  capture the desktop mic and play replies, so most of the loop is demoable without a
  board. `delay()` is a no-op there; run e2e at `--fast 1`.
- Firmware strings are ASCII-only (the bitmap font has no accents), and sanitise
  anything coming from the bridge before it reaches the panel.

## Load-bearing assumptions and the cheapest check for each

| Assumption | Check (time) |
|---|---|
| ES7210 mics work from Arduino at 16 kHz standard I2S | Phase 1 spike (about 1 h) |
| Enough internal heap and flash for Wi-Fi + WebSocket (later TLS) | read HEALTH + `heap_caps_get_largest_free_block`, then a throwaway `ws://` sketch (30 min) |
| Flash writes don't stall audio/socket long enough to matter | time `pet.save()` while a tone plays (15 min) |
| Headroom for the animations you want at ~10 fps | `micros()` around draw/flush on 3 screens, 40 vs 80 MHz (10 min) |
| SDK holds a pending `canUseTool` for a device answer | TS script, API key, stdin y/n with 60 s timer (30 min) |
| Board and bridge can reach each other in your "mobile" topology | echo server on laptop, iPhone hotspot, throwaway sketch (30 min) |
| Wi-Fi tasks (core 0) don't starve the priority-1 audio task | stream a tone from a ring while receiving 32 KB/s; compare priorities (20 min) |

## Security notes

A WebSocket that can drive a coding agent is an RCE-adjacent surface. Per-device
bearer token in `hello`, bridge bound to LAN or VPN, `wss` for anything off-LAN,
approvals only by an on-device tap, transcript shown before send. Wi-Fi creds and
the token sit in unencrypted NVS (flash encryption would mean a partition change
CLAUDE.md warns against), so make the token revocable per device. Bandai owns the
sprites; sharing publicly needs a decision.
