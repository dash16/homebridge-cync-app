# homebridge-cync-app

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
![platform](https://img.shields.io/badge/type-platform-lightgrey)
[![npm](https://img.shields.io/npm/v/homebridge-cync-app.svg)](https://www.npmjs.com/package/homebridge-cync-app)
[![npm downloads](https://img.shields.io/npm/dm/homebridge-cync-app.svg)](https://www.npmjs.com/package/homebridge-cync-app)
![node-lts](https://img.shields.io/badge/node%20LTS-20%7C22%7C24-6aa84f)
![license](https://img.shields.io/github/license/dash16/homebridge-cync-app.svg)

[![issues](https://img.shields.io/github/issues/dash16/homebridge-cync-app.svg)](https://github.com/dash16/homebridge-cync-app/issues)
![last commit](https://img.shields.io/github/last-commit/dash16/homebridge-cync-app.svg)
![typescript](https://img.shields.io/badge/language-typescript-3178c6)


# homebridge-cync-app

Homebridge plugin for integrating GE Cync devices with Apple HomeKit.

This plugin connects to your Cync account, discovers supported devices automatically, and exposes them to HomeKit through Homebridge. Where supported, communication is performed locally over LAN for improved responsiveness and reliability.

---

## Features

- HomeKit support for GE Cync devices
- Automatic device discovery
- Support for lights, dimmers, switches, outlets, and light strips
- Brightness support
- Color temperature support
- RGB color support where available
- LAN-based device communication
- Child bridge compatible
- Homebridge UI configuration support
- Debug logging support for troubleshooting

---

## Supported Devices

The plugin currently supports many common Cync device families, including:

- White bulbs
- Tunable white bulbs
- Full-color bulbs
- Light strips
- Smart plugs / outlets
- Smart switches
- Dimmers

New device types can often be supported quickly once identified.

If a device appears incorrectly in HomeKit or is missing functionality, please open an issue with:
- The device type
- A screenshot or product link from the Cync app
- Debug logs

---

## Requirements

- Node.js 20 or newer
- Homebridge v1.8.0 or newer
- A GE Cync account
- At least one compatible Cync Wi-Fi device on the network

---

## Installation

Install through the Homebridge UI or manually with npm:

```bash
npm install -g homebridge-cync-app
```

After installation:

1. Open the Homebridge UI
2. Add and configure the plugin
3. Enter your Cync account email
4. Complete the login flow using the one-time verification code sent by Cync
5. Restart Homebridge

Devices should appear automatically after startup.

Tokens are cached locally to reduce repeated login prompts.


---

## Device Notes

### Color and Color Temperature

Some Cync devices expose both RGB color and color temperature controls. HomeKit may present these differently depending on the accessory category and Home app behavior.

### Outlets and Switches

Certain Cync device types are exposed as outlets instead of generic switches to improve HomeKit behavior and Siri integration.

### LAN Communication

The plugin attempts to communicate with supported devices locally over the network for improved responsiveness compared to cloud-only control.

---

## Troubleshooting

### Device not responding

1. Confirm the device still responds in the official Cync app
2. Restart Homebridge
3. Enable debug logging
4. Check Homebridge logs for TCP or authentication errors
5. Power cycle the affected device if needed

### Missing devices

If a device is not discovered:

1. Verify it appears in the Cync app
2. Restart Homebridge
3. Enable debug logging
4. Open an issue with:
   - Device type
   - Product screenshot or link
   - Relevant logs

## Contributing

Issues and pull requests are welcome.

When reporting bugs, please include:
- Homebridge version
- Node.js version
- Device type(s)
- Relevant logs
- Steps to reproduce

---

## Credits

This project builds on community research and prior work surrounding the GE Cync ecosystem.

Special thanks to:

- [Homebridge](https://homebridge.io)
- [nikshriv/cync_lights](https://github.com/nikshriv/cync_lights) for extensive device support research and protocol implementation reference work
- The Homebridge community and contributors

---

## Disclaimer

This project is not affiliated with or endorsed by GE Lighting or Savant.

HomeKit is a trademark of Apple Inc.
