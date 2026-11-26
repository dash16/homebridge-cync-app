# 0.7.6-beta.3 — One-shot password reauthentication diagnostic

This beta adds an opt-in experiment to determine whether Cync permits password-only authentication and returns usable replacement credentials. Automatic password reauthentication remains disabled. Neither password-only acceptance nor a renewed refresh-token lifetime has been established by a live test.

- Make exactly one password-login request when explicitly invoked; no retries or OTP requests.
- Read credentials from the single configured Cync platform, without command-line passwords or sensitive output.
- Inspect sanitized response structure, credential comparisons, and expiration metadata.
- Require a complete matching-account session, future access-token expiry, valid LAN authorization material, and successful cloud verification before replacing credentials.
- Rebuild LAN login credentials from the new session; coordinate verification and atomic persistence with the existing token-store lock.
- Preserve existing credentials on authentication or validation failure. Store `authenticatedAt` after a verified full login and preserve it across later access-token refreshes.
- Retain prior beta authentication history and refresh-response inspection. Production authentication scheduling and recovery policies are unchanged.

## Install and test on Synology

Install **homebridge-cync-app@0.7.6-beta.3** through Homebridge UI's version selector and restart Homebridge. Installation alone does not run the experiment.

Stop the Cync child bridge, close plugin settings, and stop other diagnostics. Run as the Homebridge service user:

```sh
cd /volume1/homebridge/node_modules/homebridge-cync-app
node tools/password-reauth/check.mjs --storage /volume1/homebridge
```

This command performs one real password login using the existing Homebridge configuration and conditionally saves a verified replacement session. It requires an existing saved session for comparison. Capture its sanitized output, then restart the child bridge and check accessory control.

A server login might invalidate the old server session even if later verification fails; preserving the local file cannot undo that. Keep access to interactive sign-in for recovery, and do not blindly restore old token files. LAN connection behavior and refresh-token longevity require subsequent testing.

See the [full diagnostic guide](../tools/password-reauth/README.md) for output interpretation, failure handling, and the separately invoked follow-up refresh test. Do not share `config.json` or `cync-tokens.json`.

## Validation

Build, lint, and all 74 mocked automated tests pass, including success, rejection, malformed responses, cloud verification failure, atomic persistence failure, credential preservation, locking/sign-out coordination, sanitized logging, and full-authentication timestamp retention. No live Cync authentication was performed for this release.
