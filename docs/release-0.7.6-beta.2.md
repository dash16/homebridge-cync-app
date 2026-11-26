# 0.7.6-beta.2 — Inspect refresh responses safely

This beta adds evidence gathering to distinguish nonrotating refresh credentials from replacement credentials the current parser might overlook. It does not claim to fix the recurring refresh rejection or establish a 30-day session lifetime.

- Add optional `--inspect-response` to inspect decoded refresh responses before credential extraction, including nested objects and arrays.
- Report sanitized HTTP metadata, field paths and types, credential comparisons, expiration metadata, parser-consumed fields, and ignored credential candidates.
- Redact unknown field names and string values; never print credentials, account identifiers, raw bodies, cookies, authorization headers, or credential lengths.
- Add `--count N`; the default remains two exchanges.
- Retain shared locking, atomic persistence, reload verification, and cloud verification after every exchange.
- Retain beta.1's persistent authentication history and 2FA error-handling fix. Production parsing, renewal schedules, retry policy, and rejection handling are unchanged.

## Install and test on Synology

Install **homebridge-cync-app@0.7.6-beta.2** through Homebridge UI's plugin version selector and restart Homebridge. Keep the existing valid Cync session.

For the live diagnostic, stop the Cync child bridge and other diagnostics, close plugin settings, and run as the Homebridge service user:

```sh
cd /volume1/homebridge/node_modules/homebridge-cync-app
node tools/token-refresh/check.mjs \
  --storage /volume1/homebridge \
  --inspect-response \
  --count 1
```

This command performs a real refresh and saves credentials; installing the beta alone does not run it. Restart the child bridge afterward, even if the diagnostic fails. Do not restore old token files after an exchange. Share the sanitized diagnostic output, not `cync-tokens.json` or `config.json`.

See the [diagnostic guide](../tools/token-refresh/README.md#inspect-the-refresh-response-opt-in) for interpretation, synthetic examples, and parser limitations. Persistent `auth-history.jsonl` capture continues automatically.

## Validation

Build, lint, and all 55 automated tests pass. Tests use mocked responses and temporary credential stores, including actual CLI execution, nested/alternate fields, omitted/same/rotated credentials, sanitization, failure handling, and persistence. No live Cync exchange was performed for this release.
