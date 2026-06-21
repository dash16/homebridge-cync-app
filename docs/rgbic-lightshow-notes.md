# Cync RGBIC Light Show LAN Notes

## Current Implementation

RGBIC Light Show and Music Show activation uses the same LAN run-mode packet shape as the Cync app appears to use for selecting an already-known show slot.

The live Homebridge path only sends:

```text
mode = 1 for Light Show
mode = 2 for Music Show
mode = 0 to exit show mode
index = selected built-in or saved show index
```

The current implementation does not upload or edit show definitions. Saved Custom Shows are discovered from mesh properties and exposed by index when the user enables them.

## Supported Built-In Light Shows

```text
1  Candle
2  Rainbow
3  Fireworks
4  Volcanic
5  Aurora
6  Happy Holidays
7  Red White Blue
8  Vegas
9  Party Time
65 Power Up
67 Cyber
```

## Supported Built-In Music Shows

```text
1 Midnight
2 Earth Tones
3 Heat Wave
4 Solar Flare
5 Breeze
6 Tropical
7 Spectrum
8 Supernova
```

## Compatible Device Types

Show support is derived from the `DeviceType` capability table found in a
decompiled Cync Android APK. `Capability.C` identifies Light Show support and `Capability.E`
identifies Music Show support. The plugin keeps these lists separate because
many full-color devices support Light Shows without supporting Music Shows.

Music Show-capable device types (also Light Show capable):

```text
71, 72, 73, 74, 75, 76, 110, 123, 141, 155, 157, 158, 159, 166, 167, 168
```

The complete APK-derived lists live in `src/cync/device-capabilities.ts`.
Custom Light Shows use the Light Show capability, while Custom Music Shows and
multicolor Segment schemes use their corresponding APK-derived capabilities.

## Notes For Future Show Editing

Decompiled app research suggests custom show editing uses XLink device command blocks with separate commands for basic show data, extended show data, and show checks. That editing path is outside this branch; only activation of existing show indexes is included.
