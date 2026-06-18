# homebridge-cync-app
<p align="center">
  <img src="homebridge-ui/public/icon.png" width="256" alt="Cync App">
</p>

[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=flat)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)
![platform](https://img.shields.io/badge/type-platform-lightgrey)
[![npm](https://img.shields.io/npm/v/homebridge-cync-app.svg)](https://www.npmjs.com/package/homebridge-cync-app)
[![npm downloads](https://img.shields.io/npm/dm/homebridge-cync-app.svg)](https://www.npmjs.com/package/homebridge-cync-app)
![node-lts](https://img.shields.io/badge/node%20LTS-20%7C22%7C24-6aa84f)
[![license](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

[![issues](https://img.shields.io/github/issues/dash16/homebridge-cync-app.svg)](https://github.com/dash16/homebridge-cync-app/issues)
![last commit](https://img.shields.io/github/last-commit/dash16/homebridge-cync-app.svg)
![typescript](https://img.shields.io/badge/language-typescript-3178c6)

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
	- RGBIC Light Show support for compatible devices
	- RGBIC Music Show support for compatible devices
	- Optional HomeKit accessories for supported built-in shows
- Local LAN control for supported devices
	- Reduced cloud dependency
	- Faster state updates and command execution
- Child bridge compatible
- Homebridge UI configuration support
- Debug logging support for troubleshooting

---

## Supported Devices

The plugin supports most common Wi-Fi Cync lighting and power devices, including:

- White bulbs
- Tunable white bulbs
- Full-color bulbs
- Dynamic RGBIC light strips
- Smart plugs and outlets
- Smart switches
- Smart dimmers
- Fan switches

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


### Authentication Issues

If the **Request Verification Code** button appears unresponsive, verify that content blockers, privacy extensions, or similar browser protections are not blocking requests from the Homebridge UI.

Some users have reported that Safari's built-in content blocking features can prevent authentication actions from completing. If the button does not appear to do anything:

1. Temporarily disable content blockers for the Homebridge UI
2. Refresh the page
3. Request a new verification code again

If problems persist, try a different browser and review the browser developer console for errors.

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
- Community members who provided device access, logs, testing, and protocol captures

---

## Disclaimer

This project is not affiliated with or endorsed by GE Lighting or Savant.

HomeKit is a trademark of Apple Inc.
