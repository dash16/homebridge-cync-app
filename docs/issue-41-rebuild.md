# Issue 41: beta.8 and beta.7 development history

These are historical beta notes. The tested light-control changes are included in
[0.7.5](release-0.7.5.md), alongside token-renewal and startup-recovery fixes.

## Beta.8 candidate: scene consolidation

Light accessory setters now share a fixed 50 ms window per accessory. Power,
brightness and CT/RGB changes within that window become one command using the
latest requested values. Explicit OFF and zero brightness are preserved. The
existing TCP queue, 300 ms send completion and standalone power path remain.
Requests after the window form a separate batch, even while an earlier send is pending.

The September 14 scene replay keeps the reporter's 15-setter ordering. It now
records five ON packets over 1200 simulated ms, with Light 1 sent at 1250 ms
including batching, instead of 15 packets over 4200 ms. The log does not contain
subsecond setter arrival times; this is an ordered burst replay, not a claim of
identical network timing. Eleven tests cover the replay and regression cases.
Local hardware testing confirmed consolidation but found an unresolved purple-color failure near 49–50% brightness. Failed examples contain RGB byte 0x7D; this correlation is not yet a proven cause. Beta.8 retains this limitation for focused Issue 41 scene testing.

## Beta.7 baseline

Base: git tag `v0.7.4`. The two functional changes are: normalize the
OFF brightness cache on explicit ON before companion color/CT writes, and decode
escaped inner status bytes before reading mesh records. A subsequent explicit
brightness zero is preserved.

Missing ON/OFF feedback is now a debug diagnostic, not a warning implying command
failure. It does not verify temperature, color or brightness. The send message
also distinguishes absence of an immediate transport rejection from confirmation.

Endpoint, login packet, outgoing packet builders, heartbeat interval, reconnect
policy, confirmation handling and 300ms send completion are the 0.7.4 versions.
The pre-rebuild beta write coordinator and confirmation-gated queues are excluded.
Beta.8 adds the accessory-level batching described above. This is
a small candidate for hardware validation, not a claim that Issue 41 is solved.

Previous tracked and untracked source is preserved in
`artifacts/beta6-preserved-20260913/checkout.tar.gz`; `changes.patch` and `head.txt`
record its working-tree diff and base commit. Beta-only source and tests are also
preserved alongside the archive. Artifacts are excluded from Git, npm packaging
and lint. Diagnostic tools remain available but are not used by the plugin.

Run `npm test` (or `npm run test:issue41`) and `npm run lint`. For linked dev,
run `npm run build` and restart the child bridge. Verify version 0.7.5-beta.8.
First compare ordinary controls with 0.7.4; test Issue 41 hardware only after the
baseline control behavior holds. These notes describe the local candidate; npm
publication and git commit status must be checked separately.
