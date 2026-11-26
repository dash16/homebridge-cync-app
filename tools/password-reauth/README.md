# One-shot password reauthentication experiment

This command tests whether Cync accepts password-only authentication and returns a
complete usable replacement session. It does **not** enable automatic login or
prove that a refresh token's lifetime resets. This implementation has only been
tested with mocked responses; no live password authentication was performed.

## Existing behavior and evidence

Before this diagnostic, `ConfigClient.loginWithPassword()` had no callers in the
runtime, custom UI, or existing diagnostics/tests. There was no condition that
triggered it automatically. Its old comment described an intended background
recovery use, not verified Cync protocol behavior. The provided live evidence
covers refresh and 2FA login, not this endpoint.

The method posts `corp_id`, email, password, and a new random resource identifier
to `/v2/user_auth`. It sends no existing token, trusted-device cookie, or 2FA code.
Therefore this experiment tests **this exact existing request shape**, not every
possible trusted-session protocol. A failure does not prove that no other Cync
reauthentication mechanism exists.

The parser accepts top-level access-token and refresh-token snake/camel aliases,
`user_id` / `userId`, `authorize`, and the existing access-expiration aliases.
It does not parse nested credentials or separate refresh-token expiry. The
optional inspection traverses nested structures without exposing values and can
highlight such metadata. Unknown property names are redacted because names can
contain personal information. Only allowlisted expiration fields expose numeric
values; unknown strings and arbitrary numeric values remain hidden.

Runtime recovery still loads existing credentials, exchanges refresh tokens when
due, and uses the interactive 2FA flow when necessary. The UI requests OTPs,
reports session status, refreshes for discovery, and signs out; it does not call
password login. Those flows and their retry/rejection policies are unchanged.

## Running on Synology

Install **0.7.6-beta.3 or later** through Homebridge UI and restart Homebridge.
Earlier betas do not include this command. Installing the beta does not run the
experiment or enable automatic password reauthentication. From a source checkout,
run `npm run build` before invoking the diagnostic.

1. Stop the Cync child bridge, close its settings page, and stop other diagnostics.
2. Run as the Homebridge service user with read/write access to its storage:

```sh
cd /volume1/homebridge/node_modules/homebridge-cync-app
node tools/password-reauth/check.mjs --storage /volume1/homebridge
```

3. Capture the sanitized standard output. Restart the child bridge afterward so
   it adopts any new cloud and LAN credentials. Verify actual accessory control.

The command reads username/password from the **single** `CyncAppPlatform` entry in
`/volume1/homebridge/config.json`. It rejects missing/ambiguous configuration and
requires an existing saved session for account/credential comparisons. It never
prints configuration contents and does not accept passwords as command-line
arguments. The configured verification code is ignored.

**Invocation authorizes one real password-authentication attempt and a conditional
credential replacement.** It does not request an OTP, retry authentication, send
device commands, or perform an additional refresh exchange. Cync may independently
require or send verification during a login attempt; the tool makes no OTP request.
A successful server login could invalidate the previous server session even if
later validation fails. Preserving the old local file cannot undo a server-side
invalidation. Have access to the normal interactive sign-in flow for recovery.

## Transaction and verification

- Load the current session, acquire the existing credential-mutation lock, and
  re-read it. If it changed, stop without logging in or overwriting it.
- Make exactly one password request, using `ConfigClient`; inspect the sanitized
  original response before parsing. Password and cloud requests have 15-second
  timeouts, below the lock's 120-second stale-lock recovery threshold.
- Require access token, refresh token, matching numeric account ID, future
  access-token expiry, and nonempty ASCII `authorize` material that the existing
  LAN encoder can represent. Missing fields stop the experiment; old authorization
  material is never mixed into the new session.
- Rebuild the LAN login blob using the returned user ID and `authorize`.
- Verify cloud access with the returned access token. Require a recognized cloud
  response shape; a 200 response with an unrelated/error object is insufficient.
- Only then atomically save the complete session under the same lock. Reload it
  and confirm that all saved fields match. A concurrent sign-out uses that lock
  too and cannot be undone by a late diagnostic write.

Pre-save authentication/validation/cloud failures preserve the original token
file. An atomic-write failure is reported at `persist`; inspect the result rather
than assuming a new session was saved. `sessionSaved: "unconfirmed"` acknowledges
that a persistence/lock-release failure can make the final write state uncertain.
Never restore an old token file blindly after server authentication.

Successful replacement records `authenticatedAt`, the time of this full login,
as well as the existing access-token schedule metadata. Later refreshes preserve
`authenticatedAt` while updating `issuedAt`/`refreshAt`. Older sessions can lack
`authenticatedAt`; no original-login date is guessed for them. No scheduler uses
this new optional field. It is evidence for future observation, not a claim about
server expiry.

LAN material is validated and rebuilt, but this command does not establish a LAN
connection or test TCP/device commands. Restarting the child bridge is required
to replace live connections. Cloud verification alone cannot prove uninterrupted
LAN operation or server allowance for simultaneous sessions on other hosts.

## Interpreting output

The `response_inspected` event uses the same safe serializer as refresh inspection
and labels the operation `password_login`. `password_login_received` compares the
returned access, refresh, and authorization credentials with the saved session,
using only `same`, `different`, or `absent`. It reports account equality as a
boolean and exposes only recognized access-expiration metadata, never IDs.

A synthetic successful summary looks like:

```json
{"event":"password_login_received","accessCredential":"different","refreshCredential":"different","authorizeCredential":"different","accountMatches":true,"expirationChanged":true,"expiresAt":1800000000000}
{"event":"cloud_verified","meshCount":9}
{"event":"passed","passwordAttempts":1,"cloudChecks":1,"refreshExchangeTested":false,"lifetimeResetProven":false}
```

Actual output also includes timestamps, response structure, and `session_saved`
metadata. A failed attempt exposes only its phase, numeric HTTP/API codes, timeout
flag, and persistence state. `4001379` is labeled `verification_code_error`, based
on prior observed 2FA failures. Other codes remain `undetermined`; a generic 400 or
401 does not distinguish unsupported password auth from required 2FA or invalid
credentials. Password-client normal logging and exceptions were also sanitized
so response bodies and account identifiers are not exposed through debug logs.

## Follow-up and production recommendation

If this succeeds with a different refresh token, it proves that **this request
issued a distinct credential and a cloud-usable access token at that moment**.
It does not establish a new 30-day refresh lifetime. If the refresh token is the
same, password acceptance alone is not evidence of lifetime extension either.

To test the saved refresh token, separately and explicitly invoke the existing
diagnostic while the child bridge remains stopped:

```sh
node tools/token-refresh/check.mjs \
  --storage /volume1/homebridge --inspect-response --count 1
```

That separate command performs a real refresh and saves any replacement. This
password diagnostic deliberately does not do it automatically. Check the observed
expiry/relative-expiry metadata for the seven-day access lifetime; do not infer
that lifetime from success alone. Inspect any separate refresh-expiry metadata
and observe the new session across the previously suspected failure window.

For now, retain the current access-token scheduler and interactive recovery.
Do not implement a day-25–27 automatic password-login policy based on one success.
If repeated password experiments are accepted without new 2FA, credentials refresh
successfully afterward, LAN behavior is verified, and longer observation supports
renewal, consider one coordinated proactive reauthentication attempt using a
separately persisted full-authentication timestamp. It should preserve working
credentials on transient failure and fall back to interactive 2FA without loops.

If password login requires 2FA or cannot yield a verified replacement, prefer
advance **estimated** session-age warnings and a clear user-assisted reauth flow.
Neither production approach is introduced here. Remaining unknowns include Cync's
actual refresh-token lifetime, whether password login resets it, revocation of
other sessions, trusted-device requirements, and long-term LAN/cloud behavior.
