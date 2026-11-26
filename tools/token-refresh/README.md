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

## Inspect the refresh response (opt-in)

The prepared diagnostic supports `--inspect-response` and `--count N`. Count must
be a positive integer and defaults to two. Inspection is disabled by default and
does not change production logging, parsing, refresh scheduling, retry policy,
rejection handling, or the 2FA flow.

After deploying the reviewed diagnostic **and its matching compiled `dist` code**
to the Synology host, run from its installed package directory:

```sh
cd /volume1/homebridge/node_modules/homebridge-cync-app
node tools/token-refresh/check.mjs \
  --storage /volume1/homebridge \
  --inspect-response \
  --count 1
```

For a development checkout, build first (`npm run build`), or use:

```sh
npm run check:token-refresh -- --storage /absolute/homebridge/storage --inspect-response --count 1
```

**These commands perform live exchanges and modify saved credentials.** Stop the
Cync child bridge and other diagnostics, and close plugin settings before testing.
Run as the Homebridge service user with access to its storage. Restart the child
bridge afterward, including after a failed diagnostic. Do not restore old token
files: even if cloud verification fails, newly issued credentials have already
been saved. The shared lock and atomic persistence remain in use; inspection
never provides a refresh-without-saving mode. A competing writer produces an
`inconclusive` result rather than counting an adopted session as an exchange.
An unrecognized replacement field is reported but is **not** adopted speculatively.

This implementation has been tested with mock responses only. These flags are
available starting in 0.7.6-beta.2; beta.1 does not include them. Installing the
beta does not execute a live diagnostic; inspection requires the explicit command.

### Reading the additional events

`response_inspected` is emitted from the original decoded JSON, before credential
extraction or HTTP-error handling. It includes HTTP status, an allowlisted media
type (header parameters omitted), and every object's/array's field path and type.
Arrays use numeric indices. Known protocol keys retain their spelling; unknown
keys become `<fieldN>` because JSON property names can themselves contain emails,
IDs, or credentials. These placeholders identify a field's position within its
parent, not a token length. Token-like keys are classified internally even when
their names must be redacted. Detection is heuristic: an unfamiliar field name
can carry credentials without being recognizable as such, but its structure and
type are still included and its value remains hidden.

- `accessCredential` / `refreshCredential` summarize the top-level aliases selected
  by the current parser: `same`, `different`, `absent`, or `unrecognized`.
- Credential candidates have `matchesAccess` and `matchesRefresh`, comparing only
  internally with the saved credentials. Neither comparison discloses any part
  of a credential. Non-string/empty candidates are `unrecognized`.
- `parserRecognized` means the field name and location are supported; it does not
  mean the parser selected it or accepted its value.
- Only explicitly allowlisted expiration names may expose finite numeric values,
  including at nested paths. Units are not inferred. String expiration values
  show their type only, even if they contain digits.
- `response_parsed` lists the fields actually consumed and credential candidates
  not consumed in `ignoredCredentialFields`. HTTP and malformed-body failures
  report an outcome and no consumed fields. Container candidates may also appear
  in the ignored list; inspect their child paths to identify actual values.

No response string values, account identifiers, arbitrary numeric values,
credential lengths, prefixes, suffixes, raw bodies, cookies, or authorization
headers are printed. Status/API error codes remain allowlisted diagnostic
metadata. ConfigClient uses a silent logger in this tool; exceptions are reduced
to the existing safe failure fields. Observer callback errors are suppressed so
an output callback cannot interrupt credential persistence after an exchange.
A non-JSON response reports its sanitized HTTP metadata, not its text.

Example **synthetic excerpt**, representing an API that explicitly returns the
same refresh token (timestamps and unrelated structure entries omitted here):

```json
{"event":"response_inspected","attempt":1,"status":200,"contentType":"application/json","accessCredential":"different","refreshCredential":"same","fields":[{"path":"$","type":"object","parserRecognized":false},{"path":"$.access_token","type":"string","parserRecognized":true,"credential":true,"matchesAccess":"different","matchesRefresh":"different"},{"path":"$.refresh_token","type":"string","parserRecognized":true,"credential":true,"matchesAccess":"different","matchesRefresh":"same"},{"path":"$.expire_in","type":"number","parserRecognized":true,"expiration":true,"numericValue":604800}]}
{"event":"response_parsed","attempt":1,"outcome":"parsed","consumed":["$.access_token","$.refresh_token","$.expire_in"],"refreshCredential":"same","ignoredCredentialFields":[]}
```

The usual `refresh_saved`, `cloud_verified`, and `passed` events follow. For an
omitted refresh token, both credential summaries say `absent`. For an overlooked
nested replacement, the top-level summary says `absent` while a nested field
such as `$.data.refresh_token` has `matchesRefresh: "different"` and appears in
`ignoredCredentialFields`.

### Parser audit and limits of the evidence

The production parser currently reads only top-level `access_token` / `accessToken`
and `refresh_token` / `refreshToken`. It uses nullish precedence: a non-null but
invalid first alias (for example an empty string) masks a valid second alias.
A missing usable access token causes a failure. A missing usable refresh token
causes the store to retain the previous one with
`response.refreshToken ?? current.refreshToken`.

Consequently, a response with a recognized access token and a replacement refresh
credential nested elsewhere or under another name could silently retain the old
refresh token. A recognized replacement is persisted atomically and reloaded
before cloud verification. Tests characterize both cases, including the invalid
primary-alias case; they do not establish that Cync sends the unsupported shapes.

Expiry parsing recognizes top-level `expires_at` / `expiresAt`, or relative
`expire_in` / `expires_in` / `expireIn` / `expiresIn`. It does not recognize separate
refresh-token expiry metadata or nested expiration fields. An invalid string
absolute-expiry value also prevents fallback to relative expiry in the current
parser. No production parsing changes have been made without protocol evidence.

The previous `refreshChanged: false` history cannot distinguish omitted versus
explicitly identical credentials. These inspection events can, and can highlight
possible overlooked replacements. A fresh successful exchange with an omitted
or identical refresh token still **does not prove a 30-day refresh-token lifetime**.
That requires server metadata, protocol documentation, or additional observations
of rejection over time, accounting for other clients and session revocation.
