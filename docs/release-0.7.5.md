# 0.7.5 — Scene control and session reliability

This release brings the light-control improvements tested in the 0.7.5 betas to the stable channel and adds proactive token renewal and startup recovery. Scenes generate fewer redundant commands, and temporary authentication failures no longer leave the plugin waiting indefinitely for a restart.

## Light control and device state

- Combine power, brightness, and color/temperature changes received within a fixed 50 ms window into one command per light. Explicit OFF and zero brightness remain respected.
- Restore nonzero brightness before companion color/temperature writes when turning an off light on.
- Decode escaped mesh-status payloads so multi-device responses retain correct record offsets.
- Clarify debug logging when a command has been sent but no matching ON/OFF feedback arrives; missing feedback alone is not reported as a command failure.
- Restore the custom UI controls for unreachable-accessory behavior and timeout. The five-minute mesh polling interval is unchanged.

## Token renewal and recovery

- Schedule access-token renewal at 85% of the lifetime returned by Cync, rather than waiting for a later cloud request or restart.
- Persist renewal deadlines across restarts and refresh overdue sessions at startup.
- Retry temporary startup failures after 30 seconds and scheduled renewal failures with exponential backoff up to 30 minutes.
- Coordinate UI, runtime, and diagnostic refreshes using a shared token-store lock and atomic credential writes.
- Keep storage read/parse errors retryable, preserve the file for recovery, and report storage problems in the settings UI.
- Coordinate sign-out with in-flight refreshes so completed sign-out cannot be undone by a late refresh write.
- Install unavailable handlers on cached controls before authentication, preventing saved HomeKit values from silently appearing live when startup fails.
- Provide clear reauthentication instructions when Cync rejects a refresh token.

## Upgrading

Install **homebridge-cync-app@0.7.5** through Homebridge UI or npm and restart Homebridge to load the plugin and settings server. Existing valid credentials are retained; no routine sign-out is required. If Cync rejects the stored refresh token, sign out, request a fresh verification code, save the updated settings, and restart.

## Validation and remaining limitations

- Build, lint, and 35 automated tests pass, including scene replay, persisted refresh scheduling, retry recovery, and sign-out concurrency.
- The five-light scene replay sends five commands over 1.2 simulated seconds instead of fifteen over 4.2 seconds. This measures the replay, not guaranteed physical response time.
- Two consecutive live refreshes successfully saved/reloaded credentials and fetched cloud configuration. Restart logs confirmed that the proactive schedule was restored.
- Multi-day unattended renewal remains to be validated. Cync can still revoke sessions independently of access-token expiry.
- Certain purple color commands near 49–50% brightness failed in local hardware testing. Their cause remains unconfirmed and is not fixed in this release.

Thanks to the Issue #41 reporter for the logs and beta testing that helped refine scene behavior.
