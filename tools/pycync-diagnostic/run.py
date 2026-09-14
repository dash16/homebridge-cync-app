#!/usr/bin/env python3
"""Standalone pycync 0.5.0 comparison; never loads Homebridge credentials."""
import argparse
import asyncio
import getpass
import importlib.metadata
import logging
from pathlib import Path
import sys
import time
from wire_observer import WireObserver

LOG = logging.getLogger('diagnostic')

class SafeLibraryLog(logging.Handler):
    """Only emit event categories, never upstream exception text or payloads."""
    def emit(self, record):
        message = record.getMessage().lower()
        if 'reconnect' in message or 'connection closed' in message:
            LOG.warning('pycync reported connection loss/reconnect')
        elif 'strict tls' in message:
            LOG.info('pycync switching from strict to relaxed TLS')
        elif record.levelno >= logging.ERROR:
            LOG.error('pycync error (details suppressed to exclude credentials)')

async def prompt(label, secret=False):
    return await asyncio.to_thread(getpass.getpass if secret else input, label)

async def observe(manager, counts):
    original = manager._client_callback
    async def callback(packet):
        kind = packet.message_type
        counts[kind] = counts.get(kind, 0) + 1
        # No account IDs, names, auth values or packet payloads are logged.
        LOG.info('RX message_type=%s command_code=%s', kind, packet.command_code)
        await original(packet)
    manager._client_callback = callback
    previous = None
    while True:
        state = (id(manager._transport), manager._login_acknowledged)
        if state != previous:
            LOG.info('session transport_changed=%s login_acknowledged=%s',
                     previous is not None and state[0] != previous[0], state[1])
            previous = state
        await asyncio.sleep(0.25)

async def controls(client):
    devices = client.get_devices()
    print('\nDevices (names displayed here only, not written to the diagnostic log):')
    for number, device in enumerate(devices, 1):
        print(f'{number}: {device.name}')
    print('Commands: on N | off N | brightness N 1-100 | ct N 1-100 | rgb N R G B | status | quit')
    print('CT uses pycync’s native 1–100 scale, not HomeKit mireds. Check the physical device after each command.')
    cc = client._command_client
    while True:
        words = (await prompt('pycync> ')).split()
        if not words:
            continue
        if words == ['quit']:
            return
        try:
            command = words[0]
            if words == ['status']:
                await asyncio.wait_for(cc.update_mesh_devices(), 15)
                LOG.info('manual state query submitted')
                continue
            arity = {'on': 2, 'off': 2, 'brightness': 3, 'ct': 3, 'rgb': 5}
            if command not in arity or len(words) != arity[command]:
                raise ValueError()
            index = int(words[1])
            if not 1 <= index <= len(devices):
                raise ValueError()
            device = devices[index - 1]
            values = [int(v) for v in words[2:]]
            if command in ('brightness', 'ct') and not 1 <= values[0] <= 100:
                raise ValueError()
            if command == 'rgb' and any(not 0 <= v <= 255 for v in values):
                raise ValueError()
            if command in ('on', 'off'):
                operation = cc.set_power_state(device, command == 'on')
            elif command == 'brightness':
                operation = cc.set_brightness(device, values[0])
            elif command == 'ct':
                operation = cc.set_color_temp(device, values[0])
            else:
                operation = cc.set_rgb(device, tuple(values))
            LOG.info('command submitted kind=%s device_number=%s values=%s', command, index, values)
            await asyncio.wait_for(operation, 15)
            LOG.info('command send completed; physical success is NOT confirmed')
        except ValueError:
            print('Invalid command, device number, or value.')
        except Exception as exc:
            LOG.warning('command failed exception_type=%s', type(exc).__name__)

async def run(args):
    from aiohttp import ClientSession
    from pycync.auth import Auth
    from pycync.cync import Cync
    from pycync.exceptions import TwoFactorRequiredError
    if importlib.metadata.version('pycync') != '0.5.0':
        raise RuntimeError('Use the pinned requirements: pycync 0.5.0 is required')
    print('Stop the Homebridge Cync child bridge and any HA Cync integration before proceeding.')
    if (await prompt('Type stopped when they are stopped: ')).strip().lower() != 'stopped':
        return
    username = await prompt('Cync email (hidden): ', True)
    password = await prompt('Cync password: ', True)
    counts = {}
    async with ClientSession() as session:
        auth = Auth(session, username=username, password=password)
        try:
            await auth.login()
        except TwoFactorRequiredError:
            await auth.login(await prompt('Email verification code: ', True))
        LOG.info('authentication succeeded; credentials are memory-only')
        client = await Cync.create(auth)
        manager = client._command_client._tcp_manager
        observer = asyncio.create_task(observe(manager, counts))
        started = time.monotonic()
        try:
            LOG.info('idle test started duration_minutes=%s; no control commands or periodic queries', args.minutes)
            deadline = started + args.minutes * 60
            while time.monotonic() < deadline:
                await asyncio.sleep(min(30, max(0, deadline - time.monotonic())))
                LOG.info('idle elapsed_seconds=%d login_acknowledged=%s RX_counts=%s',
                         time.monotonic() - started, manager._login_acknowledged, counts)
            LOG.info('idle test completed; inspect disconnect events, not just final readiness')
            if args.controls:
                await controls(client)
        finally:
            observer.cancel()
            await asyncio.gather(observer, return_exceptions=True)
            # The reference schedules reconnect tasks internally. Cancel all of
            # this dedicated process's tasks before closing its transport.
            current = asyncio.current_task()
            tasks = [t for t in asyncio.all_tasks() if t is not current]
            for task in tasks:
                task.cancel()
            if manager._transport:
                manager._transport.close()
            await asyncio.gather(*tasks, return_exceptions=True)
            LOG.info('test ended RX_counts=%s', counts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--minutes', type=float, default=15)
    parser.add_argument('--controls', action='store_true', help='interactive controls after idle phase')
    parser.add_argument('--log', type=Path, default=Path('pycync-diagnostic.log'))
    args = parser.parse_args()
    if not 0 < args.minutes <= 120:
        parser.error('--minutes must be greater than zero and at most 120')
    if sys.version_info < (3, 13):
        parser.error('pycync 0.5.0 requires Python 3.13 or newer')
    logging.getLogger().handlers = [SafeLibraryLog()]
    logging.getLogger().setLevel(logging.INFO)
    LOG.propagate = False
    LOG.setLevel(logging.INFO)
    for handler in (logging.StreamHandler(), logging.FileHandler(args.log, mode='w')):
        handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(message)s'))
        LOG.addHandler(handler)
    LOG.info('standalone pycync diagnostic observer=3 version=0.5.0 Python=%s', sys.version.split()[0])
    try:
        from pycync.tcp.tcp_manager import CyncTcpProtocol, TcpManager
        with WireObserver(CyncTcpProtocol, TcpManager):
            asyncio.run(run(args))
    except (KeyboardInterrupt, EOFError):
        LOG.info('stopped by user')
    except Exception as exc:
        LOG.error('test stopped exception_type=%s; no exception payload logged', type(exc).__name__)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
