# Donner STARRYPAD — Connection & Configuration Protocol

Specification of how a host talks to the Donner STARRYPAD (DPD-16) pad controller: USB/MIDI
transport, the performance messages it sends, and the SysEx protocol used to read and write its
stored configuration (pad notes, knobs, faders, buttons, **pad LED colours**).

| | |
|---|---|
| Status | Connection, handshake, read, write and colour encoding **verified on hardware**. Fields marked *hypothesis* are not. |
| Unit tested | USB serial / firmware string `V20210207` |
| Sources | Static analysis of Donner's **STARRYPAD Editor v1.0.3 for macOS** (`com.kalezo.STARRYPADEditor`, JUCE, symbols not stripped, class `DeviceDPD16`); traffic captured between that editor and the pad (`captures/editor-session-1.log`); direct tests with `lib/starrypad.js`; a Wireshark USB capture of the Windows editor (May 2025). |
| Date | 2026-10-16 |
| Implementation | `lib/starrypad.js` (protocol + transport), `lib/connection.js` (auto-reconnect, queued writes, quirks of §7), `tools/pad-colors.js` (CLI), `tools/midi-proxy.js` (traffic logger), `tools/midi-monitor.js` (decoded input), `tools/pad-probe.js` (LED feedback test) |

Not affiliated with or endorsed by Donner. The protocol was worked out for interoperability.

---

## 1. Layers

```
 host app ──► OS MIDI API (CoreMIDI / node-midi / WebMIDI) ──► USB-MIDI class driver ──► USB bulk ──► pad firmware
             └──── whole MIDI messages ────┘                  └── 4-byte USB-MIDI event packets ──┘
```

Always talk to the pad through an OS MIDI API and send **complete** messages (`F0 … F7`). The OS
does the USB-MIDI packetising. Only touch the USB layer (§2.3) when bypassing the MIDI stack.

## 2. Transport

### 2.1 USB

| Property | Value |
|---|---|
| Vendor / Product ID | `0x04D9` (Holtek) / `0xE000` |
| Product string | `STARRYPAD` |
| Serial | `V20210207` (on the tested unit; doubles as firmware date) |
| Interface 0 | Audio Control (class 1, subclass 1) |
| Interface 1 | MIDI Streaming (class 1, subclass 3) |
| HID | none — the LEDs can only be reached through MIDI |
| Driver | class compliant, no vendor driver |

### 2.2 MIDI ports

One input and one output port, both named **`STARRYPAD`** (USB-MIDI cable 0).
Open them by exact name; tools such as `tools/midi-proxy.js` add ports like `STARRYPAD Proxy`,
so substring matching can pick the wrong one.

### 2.3 USB-MIDI 1.0 event packets (for raw-USB access only)

Every 4-byte packet = `[cable<<4 | CIN] [b1] [b2] [b3]`. SysEx uses these Code Index Numbers:

| CIN | Meaning |
|---|---|
| `0x4` | SysEx starts or continues — 3 data bytes |
| `0x5` | SysEx ends with 1 byte (`F7`) |
| `0x6` | SysEx ends with 2 bytes |
| `0x7` | SysEx ends with 3 bytes |

Example — handshake `F0 43 56 05 12 37 F7` on the wire:

```
04 F0 43 56 | 04 05 12 37 | 05 F7 00 00
```

The CIN bytes are framing, not data. The 2025 attempts failed because hex copied from a Wireshark
USB capture still contained them (e.g. `f0 43 56 04 05 12 37 05 f7`), so the pad received garbage.

## 3. Performance messages (pad → host)

Observed while hitting Pad 1 with factory settings:

```
99 24 06         Note On, channel 10, note 36, velocity 6
d9 01 … d9 79 …  Channel Pressure (aftertouch) stream, channel 10, while the pad is held
89 24 00         Note Off, channel 10, note 36
```

| Control | Factory mapping |
|---|---|
| Pads, bank A | notes 36–51, channel 10 |
| Pads, bank B | notes 52–67, channel 10 |
| Pads, bank C | notes 68–83, channel 10 |
| Knobs K1/K2 (banks A/B/C) | CC 28/9, 12/13, 14/15 |
| Faders F1/F2 (banks A/B/C) | CC 20/21, 22/23, 24/25 |
| Buttons | CC 26, 27, 60 (Play), 62 (Rec) |

Knobs, faders and buttons send on **MIDI channel 1** over the full range 0–127 (verified with
`tools/midi-monitor.js`). Buttons 1 and 2 are momentary: 127 on press, 0 on release.
Pad velocities are low for a light touch: about 20 % of the hits recorded during rehearsals
arrived below 16, so scale velocity up rather than mapping it linearly to volume.

Pad numbering used throughout this spec (= editor's Pad1…Pad16), note = bank base + pad − 1:

```
 13  14  15  16      top
  9  10  11  12
  5   6   7   8
  1   2   3   4      bottom (Pad1 = bottom-left)
```

## 4. SysEx framing

```
F0 43 56 <cmd> <payload…> F7
```

- `43` is Yamaha's manufacturer ID, reused by the OEM; `56` identifies this product family.
  The editor recognises pad replies by these two bytes.
- All payload bytes are 7-bit (0x00–0x7F).
- The pad does **not** answer the universal Identity Request `F0 7E 7F 06 01 F7`.

## 5. Command reference

| cmd | Direction | Message | Purpose |
|---|---|---|---|
| `05` | host → pad | `F0 43 56 05 a b F7` | Handshake challenge |
| `06` | pad → host | `F0 43 56 06 x y F7` | Handshake response |
| `03` | host → pad | `F0 43 56 03 00 F7` | Request config dump (editor: GET FROM DEVICE) |
| `02` | pad → host | `F0 43 56 02 00 <idx> <data> F7` | One config block (dump response) |
| `02` | host → pad | `F0 43 56 02 00 <idx> <data> F7` | Write one config block (editor: SEND TO DEVICE) |

The byte after `02`/`03` was always `00` in every observed message. Never send other command
bytes: the editor uses none, and their effect on the firmware is unknown.

### 5.1 Handshake (`05` → `06`)

The host sends two random 7-bit values `a`, `b`; the pad answers with values derived from them:

```js
x = Math.trunc(((a + 3) * a + 10) / (b + 1)) & 0x7f;
y = Math.trunc(((b + 5) * b + 7) / (a + 2)) & 0x7f;
```

Captured example: `05 6b 75` → `06 63 03` (a=107, b=117 → x=99, y=3). The reply arrives within 5–8 ms.

- The editor sends it after the user picks the ports, and enables its SEND/GET buttons only if the
  reply matches. The editor never auto-connects.
- **Not required by the pad**: a dump request without a prior handshake is answered normally
  (verified). Writes were always preceded by a handshake in testing; `lib/starrypad.js` keeps
  sending one.

### 5.2 Read configuration (`03 00` → 13 × `02`)

```
host                                pad
 │ F0 43 56 03 00 F7  ──────────────►│
 │◄────────────── F0 43 56 02 00 01 …│   +3 ms
 │◄────────────── F0 43 56 02 00 02 …│   +57 ms
 │                 …                 │   ≈51 ms apart
 │◄────────────── F0 43 56 02 00 0D …│   +620 ms
```

The read is complete once blocks 1–13 have all arrived. Use a timeout of about 1.5 s.

### 5.3 Write configuration (13 × `02`)

```
host                                pad
 │ (optional) handshake               │
 │ F0 43 56 02 00 01 <12 bytes> F7 ──►│
 │      wait 50 ms                    │
 │ F0 43 56 02 00 02 <32 bytes> F7 ──►│
 │      …                             │
 │ F0 43 56 02 00 0D <16 bytes> F7 ──►│   no acknowledgement
```

- The editor always writes **all 13 blocks in order 1→13**, 50 ms apart (`nanosleep(50 ms)` in
  the binary), even when only one value changed. A lone block write is **ignored** (verified:
  sending only block 11, once or 3× back-to-back, left the read-back unchanged). A config change
  therefore costs a full 13-block write (≈0.65 s), so animating the LEDs this way is limited to
  about 1.5 frames/s. The pad also paces its own dump at about 50 ms per block, which suggests
  each block goes to flash.
- The pad sends **no acknowledgement**. Verify a write by reading the configuration back.
- New values take effect immediately (LED colours change at once). The config is stored on the
  device, presumably in flash (survival across a power cycle not yet tested), so don't write it
  in a loop.
- Safe procedure: **read → change only the bytes you mean to change → write all 13 → read back and compare.**
- The editor's FACTORY RESET sends nothing by itself. It loads the table in §8 into the editor,
  and the user then presses SEND.

### 5.4 Captured editor session (excerpt)

```
207.757  APP -> PAD  f0 43 56 05 6b 75 f7                        handshake
207.765  PAD -> APP  f0 43 56 06 63 03 f7
356.356  APP -> PAD  f0 43 56 03 00 f7                           GET FROM DEVICE
356.360  PAD -> APP  f0 43 56 02 00 01 48 43 44 38 38 38 38 38 00 01 00 00 f7
   …                 (blocks 02–0C)
356.976  PAD -> APP  f0 43 56 02 00 0d 33 33 33 33 33 33 33 33 22 55 22 55 55 22 55 22 f7
424.826  APP -> PAD  f0 43 56 02 00 01 …                         SEND TO DEVICE (13 blocks)
   …
425.335  APP -> PAD  f0 43 56 02 00 0b 12 11 11 11 11 11 11 11 77 21 12 01 63 65 56 56 65 65 56 56 f7
425.437  APP -> PAD  f0 43 56 02 00 0d …
```

Full log: `captures/editor-session-1.log`.

## 6. Configuration blocks

`data` = the bytes after `<idx>`. Lengths are fixed.

| idx | data bytes | Content |
|---|---|---|
| 1 | 12 | Global settings |
| 2–7 | 32 each | Pads: 8 pads per block, 4 bytes per pad. Blocks 2–3 = bank A, 4–5 = bank B, 6–7 = bank C |
| 8 | 24 | Knobs: K1, K2 × banks A, B, C, 4 bytes each |
| 9 | 24 | Faders: F1, F2 × banks A, B, C, 4 bytes each |
| 10 | 20 | Assignable buttons (4 × 4 bytes) + 4 bytes misc |
| 11 | 20 | Bank A colours: `[0..7]` hit, `[8..11]` other settings, `[12..19]` idle |
| 12 | 16 | Bank B colours: `[0..7]` hit, `[8..15]` idle |
| 13 | 16 | Bank C colours: `[0..7]` hit, `[8..15]` idle |

### 6.1 Pad LED colours (verified)

Each pad has two colours per bank: **hit** (shown while the pad is pressed; the editor's top-right
swatch, "triggered state") and **idle** (shown otherwise; the bottom-left swatch, "edited state").

Each 8-byte colour set = 16 pads × 4 bits, read as a little-endian 64-bit integer: pad *n*
(1–16) occupies bits `4(n−1) … 4(n−1)+3`. Byte *j* of the set therefore holds pad `2j+1` in the
**low nibble** and pad `2j+2` in the **high nibble**.

| Value | Colour | | Value | Colour |
|---|---|---|---|---|
| 0 | off | | 4 | yellow |
| 1 | red | | 5 | purple |
| 2 | green | | 6 | cyan |
| 3 | blue | | 7 | white |

The palette is fixed: the editor's colour table has exactly 8 entries (32 bytes, ARGB), and the pad
**rejects a whole config write if any colour nibble is 8–15** (verified: a write with idle values
8–15 on pads 1–8 left the read-back completely unchanged, including the valid values on pads 9–16;
the same pattern with those pads set to 0 was accepted). There is no RGB or brightness field.

Verification: setting Pad 1 to hit = green, idle = blue in the editor changed block 11 byte 0
from `11` to `12` and byte 12 from `65` to `63`, and the pad lit accordingly.
Factory default: hit = bank colour (A red `11…`, B green `22…`, C blue `33…`), idle = off.

Whether incoming Note On/CC messages drive the LEDs directly (live feedback) is **untested**;
`tools/pad-probe.js` runs that test while someone watches the pad.

### 6.2 Pad entries (blocks 2–7)

4 bytes per pad: `P0 P1 P2 P3`. The editor exposes Note, CN (channel 1–16), AT (Off/Channel/Poly)
and MODE (Momentary/Toggle) per pad.

| Byte | Meaning | Evidence |
|---|---|---|
| P1 | MIDI note (verified) | `24`…`53` = notes 36–83 across the 48 pads |
| P0 | *hypothesis*: channel/type | always `28` in factory and observed configs (pads send on channel 10) |
| P2 | *hypothesis*: aftertouch mode (0 off, 1 channel, 2 poly) | factory pads 1–4 of bank A have `01`, and Pad 1 sent a Channel Pressure stream |
| P3 | *hypothesis*: mode (0 momentary, 1 toggle) | one pad on the tested unit holds `02 01` |

### 6.3 Knobs, faders, buttons (blocks 8–10)

| Block | Entry (factory) | Verified | *Hypothesis* |
|---|---|---|---|
| 8 knobs | `04 <cc> 01 00` | byte 1 = CC | byte 0 type/channel; byte 2 speed (Linear/200%/300%) |
| 9 faders | `04 <cc> 00 7f` | byte 1 = CC | bytes 2–3 = min/max |
| 10 buttons | `05 1a 7f 00`, `05 1b 7f 00`, `05 3c 7f 00`, `04 3e 7f 00` + `00 04 0c 00` | byte 1 = CC | byte 0 encodes mode (MOM/toggle); the tested unit has `04 3c` for the third button |

### 6.4 Global (block 1)

Factory: `48 43 44 38 38 38 38 38 00 01 00 00`. The editor's global fields are Name, Tempo (30–300),
Time Division, Swing (off/56/58/60 %), Pad Curve (1–3), Octave (−4…+4) and Transpose (−12…+12).
The byte layout is not decoded; the first bytes read as ASCII `HCD88888`.

## 7. Behaviour notes and quirks

- **Silent pad**: at the start of one session the pad sent notes normally but ignored all SysEx
  (no handshake reply, no dump). After Donner's editor had connected once, it answered every
  request, including the scripts that had failed before. If reads time out, replug the pad or open
  the editor once.
- **Reboot on SysEx while sending**: if SysEx (even a dump request) reaches the pad while it is
  sending itself, e.g. a fader is still moving, the pad restarts. Wait until it has been silent
  for about 1.5 s before any SysEx; while it is idle, handshake, dump request and writes are safe
  (verified). `StarrypadConnection.waitForIdle()` does this.
- **First request ignored**: after a quiet spell the pad sometimes ignores the first dump
  request. Ask a second time before giving up.
- **Replug**: after unplugging and replugging, open ports stay stale. Poll the port list, close
  the old ports and open them again.
- **No write ACK**: only a read-back proves a write.
- **Concurrent clients**: CoreMIDI lets several apps open the ports at the same time. Serialise
  config read/write sequences yourself; blocks from two overlapping reads are indistinguishable.
- **node-midi**: keep `midi.Input` objects alive for the process lifetime. Garbage-collecting a
  closed Input aborted Node with `Assertion failed: (handle->flags & UV_HANDLE_CLOSING)`.

## 8. Factory default table

As extracted from the editor binary (address `0x1001d4096`, 337 bytes, index byte + data):

```
01: 48 43 44 38 38 38 38 38 00 01 00 00
02: 28 24 01 00 28 25 01 00 28 26 01 00 28 27 01 00 28 28 00 00 28 29 00 00 28 2a 00 00 28 2b 00 00
03: 28 2c 00 00 28 2d 00 00 28 2e 00 00 28 2f 00 00 28 30 00 00 28 31 00 00 28 32 00 00 28 33 00 00
04: 28 34 00 00 28 35 00 00 28 36 00 00 28 37 00 00 28 38 00 00 28 39 00 00 28 3a 00 00 28 3b 00 00
05: 28 3c 00 00 28 3d 00 00 28 3e 00 00 28 3f 00 00 28 40 00 00 28 41 00 00 28 42 00 00 28 43 00 00
06: 28 44 00 00 28 45 00 00 28 46 00 00 28 47 00 00 28 48 00 00 28 49 00 00 28 4a 00 00 28 4b 00 00
07: 28 4c 00 00 28 4d 00 00 28 4e 00 00 28 4f 00 00 28 50 00 00 28 51 00 00 28 52 00 00 28 53 00 00
08: 04 1c 01 00 04 09 01 00 04 0c 01 00 04 0d 01 00 04 0e 01 00 04 0f 01 00
09: 04 14 00 7f 04 15 00 7f 04 16 00 7f 04 17 00 7f 04 18 00 7f 04 19 00 7f
0a: 05 1a 7f 00 05 1b 7f 00 05 3c 7f 00 04 3e 7f 00 00 04 0c 00
0b: 11 11 11 11 11 11 11 11 77 21 12 01 00 00 00 00 00 00 00 00
0c: 22 22 22 22 22 22 22 22 00 00 00 00 00 00 00 00
0d: 33 33 33 33 33 33 33 33 00 00 00 00 00 00 00 00
```

`StarrypadConfig.factory()` in `lib/starrypad.js` reproduces this table (checked byte-for-byte
against the binary). The tested unit's config before any write from this project:
`captures/config-backup-2026-10-16.json`.

## 9. Extending this spec

To decode a field marked *hypothesis*:

1. `npm run proxy` — creates the `STARRYPAD Proxy` port and logs all traffic to `captures/`.
2. In Donner's STARRYPAD Editor, set Options › Device Setup to
   `STARRYPAD Proxy` for both MIDI In and Out.
3. GET FROM DEVICE, change **one** setting, SEND TO DEVICE, then repeat with the next setting.
4. Diff consecutive SEND dumps in the log; each change shows up as a single byte.

Editor internals for deeper work: `DeviceDPD16::sendAllArg2Device` (write),
`handleSysexMessage` (dump parsing), `setDeviceConnect` (handshake), `buttonClicked` (GET / SEND /
FACTORY RESET), `handleMessage` (colour nibble updates, message ids `0x4000+`).
