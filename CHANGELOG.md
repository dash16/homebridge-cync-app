# Changelog

## v0.6.0

**Release Date:** 2026-06-21

### Added
- Added APK-derived product categorization and dimming, color-temperature, RGB, fan-speed, and segmented-control capabilities for **156** known device types.
- Added support for additional APK-listed plugs, switches, dimmers, and fan controllers without requiring individual device reports.

### Fixed
- Prevented known lights from exposing unsupported Brightness, Color Temperature, Hue, or Saturation controls.
- Removed stale HomeKit services when an APK-derived device category differs from a previously cached classification.
- Configured all physical Cync devices before optional show accessories so bridge-capacity limits cannot prevent later lights, switches, outlets, or fans from initializing.
- Stopped optional show discovery cleanly when Homebridge reaches its 149-accessory bridge limit instead of aborting discovery and reporting a misleading cloud-login failure.

### Changed
- Corrected capability-table attribution from SDK-derived to decompiled APK-derived.

## v0.5.3

**Release Date:** 2026-06-20

### Added
- Expanded Light Show support to **73** device types using capability data derived from the Cync APK.
- Expanded Music Show support to the **16** compatible device types identified by the Cync APK.

### Fixed
- Separated Light Show and Music Show capability checks so light-only devices, including 6-inch recessed fixtures, no longer expose unsupported Music Show or Segment scene accessories.

## v0.5.2

**Release Date:** 2026-06-18

### Fixed
- Preserved the last non-zero brightness level for supported dimmable devices when powered off.
- Prevented HomeKit companion brightness updates from overriding restored brightness with 100% after power-on.
- Corrected RGBIC Segment scene state tracking when Segment scenes share numeric indexes with Light Shows or Custom Shows.
- Automatically clears active Light Show, Music Show, Custom Show, and Segment scene accessories when the parent light is turned off.
- Applied the same scene cleanup behavior to Off states reported via LAN updates from the Cync app or physical controls.

### Changed
- Improved synchronization between RGBIC scenes and the primary light accessory across HomeKit, the Cync app, and direct device control.

## v0.5.1

**Release Date:** 2026-06-17

### Added
- Added support for Cync RGBIC saved segment scenes as HomeKit switch accessories.
- Added discovery for Cync `multiColorSchemes` and per-device `savedMultiColorSchemesCrcMap`.
- Added LAN activation for saved segment scenes using the Cync MultiColor run mode.

### Changed
- Updated RGBIC show accessory naming to avoid parentheses and use a safer `Show - Device - Type` format.

### Fixed
- Improved dimmer behavior for supported Cync dimmer devices.

## v0.5.0

**Release Date:** 2026-06-15

### Added

* RGBIC Light Show support for compatible Cync devices.
* HomeKit accessories for built-in Cync Light Shows.
* Configuration options to selectively enable Light Show accessories.
* Support for built-in Light Shows including Rainbow, Fireworks, Aurora, Party Time, Power Up, Cyber, and many others.

### Changed

* Light Show activation now uses native Cync LAN TCP commands.
* Improved controller resolution and routing for RGBIC command delivery.
* Activating a Light Show automatically synchronizes accessory state across related show accessories.
* Accessory naming updated to better differentiate Light Show accessories from their parent devices.

### Internal

* Removed unused experimental Light Show upload code paths.
* Removed unused Light Show parsing and CRC activation plumbing.
* Consolidated accessory cleanup logic.
* Updated RGBIC implementation documentation and reverse-engineering notes.
* General code cleanup, linting, and maintenance improvements.

## v0.4.7

**Release Date:** 2026-06-14

### Fixed
- Fixed Cync Paddle Dimmer switches, device type 125, appearing as on/off-only accessories in HomeKit.
- Exposed Cync Paddle Dimmer devices through the HomeKit Lightbulb service so brightness controls appear correctly.
- Restored cached brightness when turning Cync Paddle Dimmer devices back on, preventing them from returning to 100% brightness after power cycling.

### Changed
- Removed unsupported brightness handling from HomeKit Switch accessories, since HomeKit does not expose brightness controls for Switch services.

## v0.4.6
**Release Date:** 2026-06-13

### Added
- Added brightness control support for supported Cync switch devices.
- Added cached brightness restore behavior for Cync paddle dimmer switches.

### Fixed
- Fixed Cync paddle dimmer switches returning to 100% brightness after being turned off and back on from HomeKit.

## v0.4.5

**Release Date:** 2026-06-10

### Added
- Added device classification support for Cync Gen 1 Paddle Dimmer switches (device type 125).
- Introduced native switch accessory handling for supported Cync switch devices.

### Changed
- Unsupported device types are now skipped instead of being automatically exposed as HomeKit switches.
- Improved device classification accuracy by requiring explicit switch classification before creating switch accessories.

### Fixed
- Prevented unknown or unsupported Cync devices from appearing as incorrect HomeKit switch accessories.

## v0.4.4

**Release Date:** 2026-06-08

### Fixed

- Fixed color temperature brightness adjustments using an inverted CT conversion.
- Fixed brightness adjustments after Homebridge restart when color state had not yet been fully restored.

## v0.4.3

**Release Date:** 2026-06-08

### Fixed

- Fixed colored Cync bulbs turning white when brightness is adjusted from Apple Home.
  - Brightness commands now preserve the currently selected RGB color instead of sending a hardcoded white value.

- Fixed brightness adjustments for color temperature (white mode) bulbs.
  - Brightness changes now preserve the current color temperature and use the appropriate control path for CT-capable devices.

- Fixed brightness state reporting after Homebridge startup.
  - Devices now report their actual brightness level immediately instead of sometimes defaulting to 100% until a non-trivial dim level is observed.

### Internal

- Simplified LAN brightness state handling by removing legacy brightness filtering logic.
- Improved preservation of cached light state during brightness-only operations.

## v0.4.2

**Release Date:** 2026-06-03

### Added

* Added light classification for deviceType `76` — Outdoor 48" Dynamic Effects Light Strip.
* Added light classification for deviceType `174` — 4" Full Color Wafer Downlight.

### Changed

* Added explicit ignored-device handling for deviceType `115` Bluetooth remotes/controllers.
* Known controller devices are now skipped instead of being exposed as fallback Switch accessories.

### Fixed
* Improved controller resolution logic for certain Cync devices.
* Corrected device-to-controller association issues that could prevent devices from responding to HomeKit commands.
* Added additional validation and hardening around controller selection.
* Improved diagnostic logging used to identify controller resolution problems.
* Resolves #21.
* Resolves #23.
* Resolves #24.
* Resolves #25 for basic whole-device light support.

### Notes

DeviceType `76` appears to support dynamic scene and RGBIC-style functionality within the Cync app. This release enables standard HomeKit light controls while deeper RGBIC capabilities remain under investigation.

## v0.4.1 — Maintenance Sweep

**Release Date:** 2026-05-29

### Changed
- Reduced routine LAN device update logging from **info** to **debug**.
- Kept device classification behavior centralized in `device-classifier.ts` while simplifying catalog metadata to descriptive model information.

### Fixed
- Removed unused accessory scaffolding, TCP helper state, LAN update bridge code, and obsolete catalog classification metadata.
- Corrected package lockfile version metadata to match the published package version.

### Notes
- No device support or configuration changes are included in this release.
- Unknown or partially supported devices continue to use the existing classifier fallback behavior.

# v0.4.0 — Capability Classifier & Fan Support

**Release Date:** 2026-05-27

## Added
- Added support for Cync fan switch devices (deviceType 81) using HomeKit `Fanv2`
- Added dedicated `cync-fan-accessory.ts` accessory handler
- Added centralized `device-classifier.ts` subsystem for accessory classification
- Added classification debug logging showing:
  - device name
  - device ID
  - resolved device type
  - detected capabilities
  - selected accessory type
  - classification reason
- Added unsupported device fallback logging to improve future device onboarding

## Changed
- Refactored accessory selection to use capability-aware classification instead of relying solely on static device type lists
- Improved separation of concerns by moving classification logic out of `platform.ts`
- Expanded known Cync device catalogs using data cross-referenced from the Home Assistant Cync integration

## Fixed
- Fixed fan switches incorrectly appearing as Lightbulb accessories in HomeKit
- Restored proper handling for several light and outlet device types after classifier integration
- Improved accessory fallback behavior for unknown or partially supported devices

## Developer Notes
- Classification decisions are now centralized in `src/cync/device-classifier.ts`
- Future device onboarding should require significantly less modification to `platform.ts`
- New debug logs should make community issue reports substantially easier to triage

## 0.3.4 — Composite Switch ID Crash Fix

**Release Date:** 2026-05-22

### Fixed
- Fixed a crash affecting some Cync mesh/controller devices where large composite switchID values exceeded the uint32 range expected by LAN packet builders.
- Added support for preserving the original API-provided switchID while deriving a LAN-safe controller identifier for mesh state requests and topology handling.
- Added defensive validation around composite switch ID parsing using Number.isSafeInteger() to harden against malformed or unexpected API values.

### Acknowledgements
- Thanks to @vhvhxksc4t-sudo for identifying the composite switchID pattern, and submitting the initial fix in PR #17.
- Additional hardening and validation improvements were applied during merge review to preserve raw API identifiers while safely handling LAN controller IDs.

## v0.3.3

### Fixed
- Improved LAN startup state sync by querying Cync mesh state after TCP login and after LAN topology is available.
- Fixed HomeKit accessories sometimes showing stale startup state until manually toggled.
- Added mesh-state parsing for paginated status responses so on/off, brightness, color temperature, and RGB state can refresh through the existing LAN update path.
- Reduced noisy non-command `0x78` TCP ACK warnings by logging routine ACKs at debug level instead.
- Added preventative TCP recovery behavior

### Thanks
- Thanks to @falkobuttler for the pull request to add these features!

## v0.3.2

**Release Date:** 2026-05-19

### Fixed
- Restores proper light classification for Cync device types 46 and 123, which were unintentionally omitted during capability catalog expansion in v0.3.1.

## v0.3.1 - Bluetooth Mesh Routing

**Release Date:** 2026-05-19

### Fixed
- Fixed controller routing for Bluetooth-mesh bulbs bridged through a Wi-Fi mesh controller device.
- Prevented commands from being sent with controller `0x00000000` when a valid mesh controller can be resolved from home membership.
- Added fallback controller resolution using mesh/home device membership for BT-only bulbs that report `switchID=0`.
- Preserved preferred-controller ordering during controller candidate selection.
- Filtered invalid controller candidates from retry routing logic.

### Improved
- Added targeted controller-resolution debug logging to simplify future mesh/network troubleshooting.
- Expanded device capability allowlists using mappings identified from the Home Assistant Cync integration.
- Restored support for additional switch/downlight/light strip device types that were unintentionally omitted during the v0.3.0 capability refactor.

### Thanks
- Thanks to @falkobuttler for identifying the Bluetooth mesh routing issue, providing detailed diagnostic analysis, and contributing the initial fix proposal in #15.

## v0.3.0

**Release Date:** 2026-05-18

### Fixes

- Fixed widespread LAN control failures where accessories appeared responsive in HomeKit but did not physically turn on or off.
- Added resilient controller failover for Cync LAN commands.
- Learned and reused working controller routes per device to avoid repeatedly sending through failing controllers.
- Applied the routing fix across power, brightness, color temperature, and RGB color commands.

### Notes

- This resolves issue #9.
- This release improves compatibility with older Cync accessories that no longer respond reliably through their originally reported controller route.

## v0.2.9 — Direct Connect Bulb Support

**Release Date:** 2026-05-18

### Improvements

- Added support for Cync device type `10` as a dimmable lightbulb
- Added support for Cync device type `30` as a full-color lightbulb
- Updated platform routing so device types `10` and `30` are configured as Lightbulb accessories instead of Switch accessories
- Added catalog entries for device types `10` and `30` with appropriate default capabilities
- Enabled brightness and color temperature support for device type `10`
- Enabled brightness, color, and color temperature support for device type `30`

### Notes

- Existing cached Switch accessories for these bulbs should be automatically cleaned up and recreated as Lightbulb accessories by the platform

## v0.2.8

**Release Date:** 2026-05-11

### Fixes

- Prevented stale Cync 2FA verification codes from being reused after a refresh token failure.
- Improved login failure behavior when a stored refresh token is no longer accepted by Cync.

### Notes

- If a refresh token has expired or been invalidated, users may need to remove the old `twoFactor` value from config, restart Homebridge, request a fresh Cync verification code, and restart again.

## v0.2.7

**Release Date:** 2026-04-27

### ✨ Added
- Support for new Cync light device type (PR #13>)
- Expanded device type detection for light accessories

### 🧪 Notes
- Users with the new device type should see it automatically discovered after restart
- If devices do not appear correctly, restart Homebridge or clear cached accessories

## v0.2.4 — Direct Connect Bulb Support

**Release Date:** 2026-03-11

### Improvements

- Added support for Cync device type `128` as a dimmable lightbulb
- Added support for Cync device type `131` as a full-color lightbulb
- Updated platform routing so device types `128` and `131` are configured as Lightbulb accessories instead of Switch accessories
- Added catalog entries for device types `128` and `131` with appropriate default capabilities
- Enabled brightness support for device type `128`
- Enabled brightness, color, and color temperature support for device type `131`

### Notes

- Existing cached Switch accessories for these bulbs should be automatically cleaned up and recreated as Lightbulb accessories by the platform
- Device type `131` is exposed with color temperature support to allow Home app white swatches, even if the native bulb behavior is closer to color-based white matching

## v0.2.5

**Release Date:** 2026-03-06

### Improvements
- Added support for Cync dimmer switches reported as device type `48`
- Routed device type `48` through the light accessory path so dimmer switches are exposed to HomeKit as lights instead of simple on/off switches
- Added catalog metadata for device type `48` so supported dimmer switches identify more cleanly in HomeKit

### Notes
- This release adds support for dimming on Cync dimmer switches that report as device type `48`
- Existing accessories that were previously cached as switches may need to be removed and re-added in Home/Homebridge so they can be recreated with brightness support
- Related issue: #11

## v0.2.4

**Release Date:** 2026-03-02

### Fixes
- Corrected classification of Cync plug device types (64, 65, 172) to use HomeKit `Outlet` service instead of `Switch`
- Resolved issue where plugs displayed “Display As Light/Fan/Switch” in Home.app
- Fixed HomeKit control regression caused by service-type mismatch

### Improvements
- Added dedicated `cync-outlet-accessory.ts` module
- Improved LAN update handling to support `Service.Outlet`
- Ensured proper context initialization and device mapping for Outlet accessories
- Mirrored `OutletInUse` characteristic for improved Home.app consistency

## v0.2.3

**Release Date:** 2026-03-01

### Improvements
- Added support for Cync deviceType `72` (Indoor 32ft Premium Light Strip)
- Updated device classification so deviceType `72` is configured as a Lightbulb accessory (instead of a Switch)

### Notes
- After updating, restart Homebridge (or the Cync child bridge) so the accessory can be reconfigured.
- If the device was previously bridged as a Switch, it should automatically migrate to a Lightbulb on restart. If it does not, remove the accessory from Home and restart Homebridge.

## v0.2.1

**Release Date:** 2026-01-09

### Fixes
- Fixed accessory discovery / classification so the Direct Connect Smart Light Strip (deviceType=123) is configured as a Lightbulb rather than a Switch.
- Fixed TypeScript build issues around device catalog typing and Homebridge `Categories` imports.

### Improvements
- Introduced capability-based detection scaffolding:
  - Added a capability profile to accessory context.
  - Promotes capabilities at runtime based on observed LAN state (brightness and RGB).
- Expanded device catalog metadata for light strip support (model/marketing details).

### Notes
- Capability detection is conservative and may promote features after first LAN updates; HomeKit characteristics are only updated when present on the service.

## v0.2.0

**Release Date:** 2026-01-09

### Improvements
- Added first-class **Cync access token refresh** support using the official refresh endpoint.
- Tokens are now refreshed automatically before expiry, reducing forced logins and downtime.
- LAN login credentials are preserved and restored correctly across token refreshes.
- Improved resilience when calling cloud APIs by retrying once after token refresh.
- Added **Color Temperature (CT)** support for compatible lights, enabling Home.app to control warm/cool white where supported.

### Fixes
- Fixed incorrect refresh endpoint usage that resulted in 404 and non-JSON errors.
- Removed unreliable password-only background login fallback that caused
  `user version error` responses.
- Improved handling of devices that do not support the properties endpoint
  (`device property not exists`) and reduced noisy log output.
- Replaced `[object Object]` error logging with structured, readable error messages.

### Notes
- **One-time user action required:**
  Existing users must **sign out and sign back in** (or delete the stored token)
  once after upgrading to generate a token that includes refresh credentials.
- If a refresh token is missing or invalid, the plugin will fall back to
  **interactive 2FA login**.
- **CT support details:**
  CT is exposed only on devices that report CT capability. On devices without CT,
  Home.app will not show the Color Temperature control (expected behavior).

## v0.1.11

**Release Date:** 2026-01-02

### Reliability
- Improved access token refresh behavior and persistence

### Notes
- After updating, sign out of the Cync account in Homebridge UI (or remove the stored token file) and sign back in to generate a fresh refresh token.

## v0.1.10

**Release Date:** 2025-12-26

### Fixes
- Fixed GE Cync A19 full-color smart bulbs (deviceType 137 / 171) incorrectly appearing as Switch accessories in Home.app
- Full-color A19 bulbs are now correctly exposed as Lightbulb accessories with on/off, brightness, and color controls

### Improvements
- Expanded light accessory detection logic to support additional Cync bulb device types
- Added device catalog entries for A19 Full Color Direct Connect Smart Bulbs (3-in-1)
- Improved logging consistency when classifying devices by `deviceType`

### Migration Notes
- Existing accessories will automatically migrate from Switch → Lightbulb
- In rare cases, a Homebridge restart or Home.app refresh may be required for the new service type to appear correctly

### Internal
- Centralized light device-type classification for easier future expansion
- No breaking changes; no config updates required

## v0.1.9

**Release Date:** 2025-12-22

### Improvements
- Added a device catalog to map Cync `deviceType` values to accurate model names in Home.app
- Improved accessory identification and metadata population (model, firmware, identifiers)
- Refactored accessory configuration logic for clearer separation by accessory type
- Hardened accessory reconfiguration to safely remove stale HomeKit services when device roles change

### Reliability
- Improved polling behavior to better detect and mark unreachable devices
- Reduced false-positive “responsive” states when devices stop reporting
- More consistent recovery when devices come back online

### Internal
- Code cleanup and lint fixes following accessory refactors
- Reduced unused imports and improved definition ordering
- No breaking changes; no config updates required

## v0.1.8

**Release Date:** 2025-12-11

### Added
- Automatic background re-authentication using username/password when access tokens expire
- Support for password-based login fallback when refresh tokens are unavailable
- Improved handling of expired Cync cloud tokens without requiring Homebridge restarts

### Fixed
- Devices becoming unresponsive after Cync access token expiration
- Cloud login failures caused by non-refreshable legacy tokens

## 0.1.7 – Token refresh & accessory polling

**Release Date:** 2025-12-10

### Added
- Automatic Cync token refresh so cloud sessions stay valid longer without manual re-login.
- Accessory state polling so Homebridge periodically refreshes device state from Cync, reducing stale states and missed updates.

## 0.1.6 – Cync lights with LAN color + dimming

**Release Date:** 2025-12-05

### Added
- **Cync Lightbulb accessory support**
  - Discover and expose color-capable Cync devices as native HomeKit `Lightbulb` accessories.
  - Implemented LAN-backed `On`, `Brightness`, `Hue`, and `Saturation` characteristics using the Cync TCP transport.
  - Per-accessory state is cached so HomeKit reads reflect the last known LAN state.

- **Accessory metadata from Cync**
  - Populate the Accessory Information service with data from the Cync cloud:
    - `Manufacturer` → `GE Lighting`
    - `Model` → derived from the Cync device display name and device type (for example, `Downlight (Type 46)`).
    - `SerialNumber` → derived from Wi-Fi MAC, MAC, or device ID.
    - `FirmwareRevision` → firmware version string reported by Cync.

### Changed
- Devices that were previously exposed as `Switch` are now migrated to `Lightbulb`:
  - Any stale `Switch` service is removed before configuring the `Lightbulb` service.
  - Accessory category is set to `LIGHTBULB` so HomeKit and other apps treat these as lights.

## v0.1.5 – Custom 2FA UI & Token Locking
**Release Date:** 2025-11-29

- Added a custom Homebridge UI for Cync login:
  - Email, password, and verification code (OTP) now live in a single guided flow.
  - “Request Verification Code” button triggers the Cync 2FA email from the settings UI.
- Implemented a Homebridge UI server:
  - `/request-otp` endpoint uses the existing `ConfigClient.sendTwoFactorCode()` flow.
  - `/status` endpoint reports whether a stored token exists.
  - `/sign-out` endpoint clears the stored token file.
- Token-aware UI behavior:
  - When a valid token exists, credential and OTP fields are disabled to prevent accidental edits.
  - “Sign Out” clears the token, blanks credentials, and unlocks the form.
- Fixed 2FA variable drift:
  - Standardised on `username`, `password`, and `twoFactor` in config and UI.
  - Ensured `CyncClient.ensureLoggedIn()` correctly picks up `twoFactor` and writes `cync-tokens.json`.
- General cleanup:
  - Removed redundant client-side save button; now using the Homebridge “Save” button for persistence.
  - Minor logging and UI text improvements.

## v0.1.4 – “Rollback to sanity”

**Release Date:** 2025-11-28

- Reset codebase to v0.1.0 (last known good 2FA behavior).
- Reintroduced LAN command serialization (fixes issues with multiple commands at once).
- Marked v0.1.3 as experimental/dead branch.

## 0.1.0 – LAN Control Preview

- Implemented TCP client for Cync LAN bridge using the cloud-provided login code.
- Added real on/off control for Cync smart plugs directly from HomeKit.
- Wired HomeKit `On` characteristic handlers to TCP transport.
- Subscribed to Cync device updates and propagate state changes back into HomeKit.
- Improved logging around cloud configuration loading, LAN login, and TCP connection lifecycle.
- Known scope: tested only with Cync smart plugs; other device types are currently untested and may not appear or function correctly.

## v0.0.2 – Cloud 2FA + device discovery

**Release Date:** 2025-11-23

### Added
- Cync cloud 2FA login flow using email + password + one-time code.
- Persistent token storage and automatic session restore on Homebridge restart.
- Cloud configuration fetch via `/user/{userId}/subscribe/devices`.
- Per-mesh property probe via `/product/{productId}/device/{meshId}/property`.
- Device discovery from `bulbsArray` and mapping into Homebridge accessories.
- Accessory UUIDs seeded from mesh ID + stable device ID for consistent caching.
- Automatic accessory naming using Cync `displayName` (e.g. “Lower Outlet”, “Upper Outlet”).

### Changed
- Replaced the previous “dummy switch” with real Cync devices from the cloud.
- Tightened logging around login, token restore, and cloud configuration loading.
- Ensured all new TypeScript code is lint-clean (`no-explicit-any`, strict typing).

### Known limitations
- LAN / TCP control path is still stubbed: `On` characteristic logs requests but does not yet send real commands to devices.
- Only basic on/off outlets have been exercised; lights/scenes/groups are not yet modelled as HomeKit accessories.
- Token expiry / refresh is not yet implemented; a full re-login may be required if the token is revoked or expires.

## 0.0.1 – Initial Cync scaffold
**Release Date:** 2025-11-22

### Added
- Initial Homebridge platform plugin scaffold for controlling Cync devices via the Cync app account.
- Basic TypeScript project setup (ESLint, `tsconfig`, build scripts).
- Platform registration and minimal logging to verify plugin loads correctly in Homebridge.
- Configuration schema wiring for the Homebridge UI (basic fields for Cync account and options).
