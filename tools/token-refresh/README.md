# Live refresh check

Run against the dev Homebridge storage directory after signing in:

```sh
npm run check:token-refresh -- --storage /Users/dustinn/.homebridge
```

This performs two real refresh exchanges, reloading the saved session between
attempts, and verifies cloud configuration access after each exchange. It uses
ConfigClient and the shared token-store refresh lock. Replacement credentials
are saved immediately, before cloud verification. No device commands or 2FA
requests are sent. A rejected refresh is marked for reauthentication; transient
failures preserve the session. It never prints credentials or upstream response
bodies. Close the plugin settings while testing; any running plugin must use the
shared refresh lock added with this diagnostic work.

A `passed` result proves that two consecutive refreshes and persistence work now.
It does not establish Cync's refresh-token lifetime or behavior after access-token
expiry. `inconclusive` means another process refreshed before this one acquired
the lock; the tool does not count that as its own successful exchange.

A failed cloud check leaves the freshly saved credentials in place. Do not restore
an older token file after a refresh, since its refresh token may have been rotated.

## Dev result — September 21, 2026

At 21:07:49–21:07:50 UTC, both live exchanges passed. Each changed the access
token, persisted it, and successfully fetched cloud configuration (nine meshes).
The saved refresh token was unchanged after both exchanges. The final reported
access-token expiry was September 28, 2026 at 21:07:50 UTC.

This verifies the request/response and persistence path with a fresh session.
It does not explain the older token's rejection or prove refresh-token longevity.

## Automatic refresh

Homebridge schedules refresh at 85% of the lifetime returned by Cync. Each login
and successful refresh saves `issuedAt`, `expiresAt`, and `refreshAt`. Restarting
restores the deadline; an overdue session refreshes during startup. Older token
files use their modification time as an approximate issuance time until the next
successful refresh persists explicit metadata.

Temporary scheduled failures retry after 30 seconds, doubling up to 30 minutes.
A successful refresh resets backoff. Explicit rejection stops scheduled retries
and logs instructions to sign in again. The timer reloads storage before acting
so a newer UI or diagnostic session can move the next refresh date. Missing
expiry metadata disables proactive scheduling; cloud-error refresh remains.
The running child bridge must be restarted after installing this change.

Token-file read and parse errors are reported and retried by the scheduler;
only a missing file is treated as signed out. Invalid file contents are retained
for recovery and excluded from error messages. Sign-out shares the credential
mutation lock with refresh, waits for an active exchange to finish, and then
removes its saved result. Deletion failures are surfaced rather than reported as
a successful sign-out.
