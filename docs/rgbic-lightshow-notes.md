//docs/rgbic-lightshow-notes.md

# Cync RGBIC Light Show LAN Notes

## Status

Current research indicates Cync RGBIC Light Shows are LAN-capable and use the same XLink device command framework as normal device control.

This replaces the earlier guessed `buildLightShowPacket()` approach with a more concrete model based on Android app decompilation.

## High-Level Flow

```text
ShowServiceDefault
  -> SetLightShowCommand / SetLightShowExtendedCommand / ShowCheckCommand
    -> DeviceCommand.sendBlocks(...)
      -> XlinkCommandDelegate.h(...)
        -> Xlink.a(...)
          -> TCP payload
```

## Command Opcodes

```text
F7 11 02 43 = SetLightShowCommand
F7 11 02 57 = SetLightShowExtendedCommand
F7 11 02 4D = ShowCheckCommand
```

Music shows likely have parallel command classes, but this document currently focuses on Light Shows.

## Light Show Type IDs

```text
1 = Light Show
2 = Music Show
```

These values are used by `ShowCheckCommand`.

## Preview Slot

The app appears to use show index:

```text
32 = preview / temporary show slot
```

Persisted/custom shows likely occupy lower indexes.

## Light Show Effects

```text
1  PULSE
2  FLICKER
3  WAVE
4  ALTERNATING
5  FILL
6  POP
7  STATIC
8  RHYTHM
9  ERRATIC
10 ROLLING
11 STACKING
```

The effect byte may be OR’d with `0x80` in some transport modes.

## Color Order

```text
random
inOrder
```

Needs byte mapping verification.

## Basic Light Show Payload

`SetLightShowCommand` uses opcode:

```text
F7 11 02 43
```

Payload before chunking:

```text
showIndex
effectByte
fadeSpeedByte
brightnessByte
speedByte
colorOrderByte
lowerBrightnessByte
colorInfo
```

`colorInfo`:

```text
colorCount | 0x80 if palette flag enabled
R G B
R G B
R G B
...
```

Compact numeric encoding:

```text
double byte = round(value * 10)
```

Examples:

```text
speed 4.2     -> 42 / 0x2A
fadeSpeed 1.5 -> 15 / 0x0F
```

## Extended Light Show Payload

`SetLightShowExtendedCommand` uses opcode:

```text
F7 11 02 57
```

Payload before chunking:

```text
showIndex
xlinkFlag
fadeSpeedShortLE
lowerFadeSpeedShortLE
speedShortLE
lowerSpeedShortLE
smoothingEnabled
smoothingFadeWidth
smoothingColorWidth
```

Extended numeric encoding:

```text
short LE = round(value * 100)
```

Examples:

```text
speed 4.25      -> 425 -> A9 01
fadeSpeed 1.50  -> 150 -> 96 00
```

## ShowCheck Payload

`ShowCheckCommand` uses opcode:

```text
F7 11 02 4D
```

Payload shape:

```text
showType
showIndex
basicCrc[2]
01
extendedCrc[2]
tileCrc[2]
```

CRC is CRC16/Modbus-style using polynomial:

```text
0xA001
```

The check command verifies whether the device has the expected show definition loaded.

## CRC Inputs

For Light Shows, CRCs are calculated over serialized outputs from:

```text
SetLightShowCommandKt.a(...)
SetLightShowExtendedCommandKt.a(...)
SetLightShowTileSpecificParameterCommandKt.d(...)
```

Meaning a complete show can have three separately validated payloads:

```text
basic show definition
extended show definition
tile-specific parameters
```

## XLink Block Sending

Show commands are sent in blocks.

Known call pattern:

```text
DeviceCommand.t(opcodeBytes, payloadBytes, blockSize = 9, blockDelayMillis = 0, sendBlockCallback)
```

Likely command body per block:

```text
opcodeBytes + payloadChunk
```

For basic Light Show:

```text
F7 11 02 43 + 9-byte chunk
```

For extended Light Show:

```text
F7 11 02 57 + 9-byte chunk
```

Exact `DeviceCommand.t(...)` behavior still needs verification.

## XLink Command Delegate Wrapping

`XlinkCommandDelegate.h(...)` sends through command type:

```text
0x8E
```

Before `Xlink.a(...)`, the wrapped body is:

```text
blockIndex[3 bytes little-endian]
00 00
destinationMeshAddress[2 bytes little-endian]
commandBody
```

So for one block:

```text
blockIndex[3]
00 00
meshAddress[2 LE]
F7 11 02 43
payloadChunk
```

## Final XLink Frame

`Xlink.a(commandType, data, messageId)` builds the final XLink frame:

```text
7E
  messageId
  constantByte
  commandType
  payloadLength
  payload
  checksum
7E
```

Checksum:

```text
sum(commandType + payloadLength + payload) % 256
```

Escaping:

```text
7D -> 7D 5D
7E -> 7D 5E
```

Known command type for show blocks:

```text
0x8E
```

## Open Questions

1. Exact `WriteBuffer.c(i)` encoding for `messageId`.
2. Exact `WriteBuffer.d(length)` encoding for payload length.
3. Exact constant byte value in `Xlink.a(...)`.
4. Exact `DeviceCommand.t(...)` chunk format and block index start value.
5. Whether Homebridge’s existing Cync TCP `73` wrapper still surrounds this XLink frame.
6. Exact byte mapping for `ShowColorOrder.random` vs `ShowColorOrder.inOrder`.
7. Whether tile-specific command can be omitted for strips or must be sent with zero/default CRC.
8. Whether command sequence must be:

   * set basic
   * set extended
   * set tile-specific
   * show check
   * activate/run mode

## Implementation Plan

Add a new experimental path rather than replacing existing light-show code immediately:

```text
buildXlinkFrame(...)
buildXlinkShowBlock(...)
buildSetLightShowPayload(...)
buildSetLightShowExtendedPayload(...)
buildShowCheckPayload(...)
```

Then compare generated bytes against tcpdump captures from the Cync app before trying to send from Homebridge.

## First Candidate Test

Use preview slot:

```text
showIndex = 32
```

Use a simple static or pulse show with a tiny palette:

```text
effect = STATIC or PULSE
brightness = 100
speed = 1.0
fadeSpeed = 1.0
colors = red, green, blue
```

Goal is not final UI support yet. Goal is first to produce a valid LAN packet that the strip accepts.
