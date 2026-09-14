"""Metadata-only observer. Original receive chunks and outgoing bytes pass unchanged."""
import logging
import time
from unittest.mock import patch
from contextlib import ExitStack

LOG = logging.getLogger('diagnostic')

class Frames:
    def __init__(self, session, direction):
        self.session, self.direction = session, direction
        self.buffer = bytearray()

    def feed(self, data):
        self.buffer.extend(data)
        while len(self.buffer) >= 5:
            size = int.from_bytes(self.buffer[1:5], 'big')
            if size > 1024 * 1024:
                LOG.warning('wire session=%s direction=%s invalid_length=%s observer_stopped', self.session, self.direction, size)
                self.buffer.clear()
                return
            if len(self.buffer) < 5 + size:
                return
            kind = self.buffer[0] >> 4
            code = self.buffer[5] if kind == 14 and size else None
            LOG.info('wire session=%s direction=%s type=%s bytes=%s disconnect_code=%s',
                     self.session, self.direction, kind, size + 5, code)
            del self.buffer[:5 + size]

class TransportObserver:
    def __init__(self, transport, session):
        self.transport, self.session = transport, session
        self.frames = Frames(session, 'TX')

    def write(self, data):
        self.transport.write(data)
        self.frames.feed(data)

    def close(self):
        LOG.info('wire session=%s local_close_requested', self.session)
        return self.transport.close()

    def __getattr__(self, name):
        return getattr(self.transport, name)

class WireObserver:
    def __init__(self, protocol_class, manager_class=None):
        self.protocol_class = protocol_class
        self.manager_class = manager_class
        self.stack = ExitStack()
        self.count = 0

    def __enter__(self):
        cls = self.protocol_class
        made, received, lost = cls.connection_made, cls.data_received, cls.connection_lost
        def connection_made(protocol, transport):
            self.count += 1
            protocol._diagnostic_session = self.count
            protocol._diagnostic_started = time.monotonic()
            protocol._diagnostic_frames = Frames(self.count, 'RX')
            LOG.info('wire session=%s connected', self.count)
            protocol._diagnostic_transport = TransportObserver(transport, self.count)
            return made(protocol, protocol._diagnostic_transport)
        def data_received(protocol, data):
            protocol._diagnostic_frames.feed(data)
            try:
                return received(protocol, data)
            except Exception as exc:
                LOG.warning('wire session=%s receive_callback_exception=%s', protocol._diagnostic_session, type(exc).__name__)
                raise
        def connection_lost(protocol, exc):
            LOG.warning('wire session=%s connection_lost age_seconds=%.3f exception_type=%s errno=%s',
                        protocol._diagnostic_session, time.monotonic() - protocol._diagnostic_started,
                        type(exc).__name__ if exc else 'none',
                        exc.errno if isinstance(exc, OSError) and isinstance(exc.errno, int) else None)
            return lost(protocol, exc)
        for name, value in [('connection_made', connection_made), ('data_received', data_received), ('connection_lost', connection_lost)]:
            self.stack.enter_context(patch.object(cls, name, value))
        if self.manager_class is not None:
            establish = self.manager_class._establish_tcp_connection
            async def establish_observed(manager):
                result = await establish(manager)
                # create_connection returns the raw transport separately from
                # protocol.connection_made. Bind the manager before its caller
                # starts packet processing and heartbeat tasks, on every connect.
                proxy = manager._protocol._diagnostic_transport
                if manager._transport is not proxy.transport and manager._transport is not proxy:
                    raise RuntimeError('Unexpected pycync transport wiring')
                manager._transport = proxy
                return result
            self.stack.enter_context(patch.object(self.manager_class, '_establish_tcp_connection', establish_observed))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)
