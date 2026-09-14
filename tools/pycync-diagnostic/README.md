# Standalone pycync comparison

This optional diagnostic tool was used for earlier protocol investigations. It
is not part of the plugin runtime or a required beta.8 test. See the
[current beta notes](../../docs/issue-41-rebuild.md) for the active validation path.

This uses the installed, unmodified **pycync 0.5.0** library. It does not require
Home Assistant, import Homebridge code, or read Homebridge's token store.
Python **3.13+** is required by this version of pycync.

From the repository directory, set up an isolated environment once:

```sh
python3.13 -m venv /tmp/cync-reference-venv
/tmp/cync-reference-venv/bin/python -m pip install -r tools/pycync-diagnostic/requirements.txt
```

On this Mac, Python is also available at `/opt/anaconda3/bin/python3.13` if the
short command is not on your PATH. The temporary environment may need recreating
after a reboot or temporary-directory cleanup.

Stop the Homebridge Cync child bridge and any Home Assistant Cync integration.
Leave the Cync app closed during the comparison. Then run:

```sh
/tmp/cync-reference-venv/bin/python tools/pycync-diagnostic/run.py --minutes 15 --controls
```

The program asks you to confirm the other clients are stopped, then privately
prompts for email, password, and an emailed verification code if required.
Credentials remain in memory and are not saved. Authentication may send a Cync
verification email. No device commands are sent during the idle phase: pycync
still performs its normal login, discovery, heartbeat and reconnection work.

After the idle phase, `--controls` opens a command prompt. Device names are shown
only in the terminal. Examples (replace `1` with the displayed device number):

```text
on 1
brightness 1 25
ct 1 50
rgb 1 255 0 0
off 1
status
quit
```

CT uses the reference library's native 1–100 scale, not mireds. Commands may fail
on devices that do not support a capability. Brightness zero is intentionally
excluded; use OFF. Each command has a 15-second harness timeout so the reference's
wait-for-login cannot block the prompt indefinitely. A completed send is **not**
proof of a physical change. Record physical results and their times separately.

The default log is `pycync-diagnostic.log` in the current directory (overwritten
on each run). Use `--log another-name.log` to preserve separate runs. It records
packet categories (1 login, 4 sync, 7 pipe, 10 probe, 13 heartbeat), readiness,
transport changes and counts. Upstream log messages are reduced to event
categories; raw payloads, credentials, device IDs and device names are excluded.
No raw exception text or traceback is written. The observer wraps a private
callback of this pinned version but does not change packet construction or
reconnection behavior. Disconnects are reported by the library logger because
its manager raises before forwarding disconnect packets to that callback.

Quit the harness before restarting Homebridge. Compare idle disconnect frequency
first, then physical control behavior. A stable standalone run points toward a
remaining Homebridge difference; failures in both clients do not, by themselves,
identify an account, network or cloud root cause. This test also uses a fresh
login, so stored authorization remains a possible difference.

## Observer version 2

Additional `wire` entries log actual transport writes (TX type 13 = heartbeat),
incoming framed messages (RX type 13 = heartbeat reply; type 14 = disconnect),
and the numeric disconnect code. Session numbers correlate those entries with
connection lifetime, local close requests, and connection-lost exception type
and OS errno. Exception messages and raw payloads are never printed. A write
means handed to the transport, not proof the server received it.

This also observes messages pycync's parser ignores, including heartbeat replies.
The earlier callback-only RX counts did not include those replies; their absence
was not proof of a heartbeat failure. The observer independently assembles split
frames for logging but passes the original chunks unchanged to pycync, preserving
its parser behavior. A connection loss with no exception and no disconnect frame
is an unspecified closure, not evidence of a particular cloud or network cause.

Use the same launch command; no dependency reinstall is necessary. Preserve old
logs with `--log pycync-observer2.log`. The first line should say `observer=2`.

## Observer version 3

Version 2 missed manager-originated writes and closes: asyncio returned the raw
transport to the manager even though the protocol held a proxy. Version 3 binds
the manager to that same proxy immediately after connection establishment,
before packet-processing and heartbeat tasks start. This is repeated on every
reconnect. It preserves the original transport calls and outgoing bytes.

Run (with Homebridge Cync and HA Cync stopped):

```sh
/tmp/cync-reference-venv/bin/python tools/pycync-diagnostic/run.py --minutes 15 --log pycync-observer3.log
```

No dependency reinstall or Homebridge build is needed. Verify `observer=3` in
the first line. TX type 13 now records manager heartbeat writes; local close
requests are recorded too. Sessions that end before the first heartbeat may
legitimately contain no TX type 13. Six offline tests cover forwarding, redaction,
and shared transport coverage across reconnections. Account behavior still
requires a live run.
