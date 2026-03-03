# Changelog

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
