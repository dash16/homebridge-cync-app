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

The branch currently exposes show switches for:

```text
76  Outdoor 48" dynamic light strip
123 Light strip
```

Additional RGBIC-capable device types can be added to `CYNC_LIGHT_SHOW_DEVICE_TYPES` after validation.

## Notes For Future Show Editing

Decompiled app research suggests custom show editing uses XLink device command blocks with separate commands for basic show data, extended show data, and show checks. That editing path is outside this branch; only activation of existing show indexes is included.
