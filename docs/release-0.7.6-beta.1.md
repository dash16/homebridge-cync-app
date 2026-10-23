# 0.7.6-beta.1 — Persistent authentication diagnostics

This beta captures the history needed to investigate sessions that work initially and later require another sign-in. It does not claim to resolve the underlying intermittent refresh rejection or establish whether separate Cync clients invalidate one another's sessions.

- Automatically record startup, saved-session reads, renewal schedules, timer execution, refresh responses and failures, retries, credential saves, and sign-out/rejection deletions.
- Identify plugin, settings UI, and diagnostic writers by source, process ID, and per-instance run ID; include plugin version and UTC timestamps.
- Keep history across restart and sign-out, using a 4 MiB current file and up to seven rotated archives (about 32 MiB total). Retention is size-based, not a guaranteed number of days.
- Permit only selected timestamps, booleans, numeric HTTP/Cync codes, and recognized system error codes. Never include credentials, account identifiers, verification codes, arbitrary error messages, or API response bodies in this journal.
- Treat journal failures as best-effort: warn once per writer and continue authentication.
- Preserve HTTP status and Cync codes from the real 2FA login parser so a rejected verification code stops automatic retries. Temporary server failures remain retryable.
- Replace the constructor's verification-code debug output with a presence flag.

## Install and collect on the Synology Homebridge package

Install `homebridge-cync-app@0.7.6-beta.1` through the Homebridge UI's plugin version selector, then restart Homebridge to reload both the plugin and settings server. Keep the existing Cync session; signing out is not required for this update.

History is written automatically, without enabling debug logging, to:

`<Homebridge storage>/homebridge-cync-app/auth-history.jsonl`

For the Homebridge shared folder already mounted on the Mac, look under `/Volumes/homebridge/homebridge-cync-app/`. In DSM File Station, open the corresponding Homebridge shared folder and its `homebridge-cync-app` subfolder.

Copy `auth-history.jsonl` and any `auth-history.jsonl.1` through `.7` files when a failure occurs, together with the normal Homebridge log. `.1` is the newest archive. Do not include `cync-tokens.json` or `config.json`; those contain credentials. History remains available after manual reauthentication. A process crash or storage failure can still leave gaps in this best-effort journal.

For the competing-session experiment, stop the dev Cync child bridge and diagnostic clients, leave NAS production running, and observe at least two scheduled renewals. Note any manual logins or restarts and their times. If production remains healthy, reintroduce development with capture still enabled.

## Validation

Build, lint, and 42 tests cover scheduling, authentication recovery, redaction, concurrent journal writers, bounded rotation, persistence across sign-out, and operation when journal writes fail. Multi-day behavior on the NAS still requires observation.
