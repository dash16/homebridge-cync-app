# 0.7.6-beta.4 — Sanitized password-login rejection messages

This beta exposes limited authentication-related wording from rejected password-login responses so we can investigate Cync error `4001381`. Its meaning is not yet established; this release does not assume that it means 2FA is required.

- Add a diagnostic-only `password_login_error` event containing status, code, `sanitizedMessage`, and `messageRedacted`.
- Remove known credentials first, retain only allowlisted authentication vocabulary, and redact unknown text, numbers, names, URLs, and opaque values.
- Keep raw messages out of normal logs and exceptions. Sanitized text is a lossy rendering, not a verbatim quote; redaction may remove meaning.
- Retain beta.3's single password attempt, verification-before-save, credential locking, and LAN authorization rebuilding. No automatic retries, OTP requests, or automatic reauthentication are added.

## Install and test on Synology

Install **homebridge-cync-app@0.7.6-beta.4** through Homebridge UI and restart Homebridge. Stop the Cync child bridge, close plugin settings, and stop other diagnostics. Run as the Homebridge service user:

```sh
cd /volume1/homebridge/node_modules/homebridge-cync-app
node tools/password-reauth/check.mjs --storage /volume1/homebridge
```

This makes one real password-login attempt. A complete replacement is saved only after validation and cloud verification; rejection preserves the existing local credentials. Server-side session changes cannot be undone by preserving a local file.

Share the sanitized output, especially the new `password_login_error` event. Restart the child bridge afterward, even if the diagnostic fails. Installation alone does not run the experiment. See the [diagnostic guide](../tools/password-reauth/README.md) for details and limitations.

## Validation

Build, lint, and all 78 mocked tests pass, including authentication-message redaction, known credentials that are ordinary words, hostile message contents, and rejection without credential replacement. No live authentication was performed for this release. Stable remains 0.7.5.
