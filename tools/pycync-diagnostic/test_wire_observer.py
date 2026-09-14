import logging
import unittest
from unittest.mock import Mock
from wire_observer import Frames, WireObserver

class WireTests(unittest.TestCase):
    def test_split_frames_codes_and_secrets(self):
        frames = Frames(1, 'RX')
        secret = b'password-token'
        login = bytes([0x13]) + len(secret).to_bytes(4, 'big') + secret
        with self.assertLogs('diagnostic', logging.INFO) as output:
            frames.feed(login[:3])
            frames.feed(login[3:] + bytes.fromhex('d800000000e00000000103'))
        text = '\n'.join(output.output)
        self.assertIn('type=13', text)
        self.assertIn('disconnect_code=3', text)
        self.assertNotIn('password', text)
        self.assertEqual(len(output.output), 3)
        self.assertEqual(frames.buffer, b'')

    def test_original_bytes_callbacks_and_restore(self):
        class Protocol:
            def connection_made(self, transport):
                self.transport = transport
                transport.write(bytes.fromhex('d300000000'))
            def data_received(self, data):
                self.received = data
            def connection_lost(self, exc):
                self.exc = exc
        original = Protocol.connection_made
        transport = Mock()
        chunk = bytes.fromhex('e00000000103')
        error = OSError(54, 'secret-token')
        with self.assertLogs('diagnostic', logging.INFO) as output:
            with WireObserver(Protocol):
                protocol = Protocol()
                protocol.connection_made(transport)
                protocol.data_received(chunk)
                protocol.transport.close()
                protocol.connection_lost(error)
        self.assertIs(Protocol.connection_made, original)
        self.assertIs(protocol.received, chunk)
        self.assertIs(protocol.exc, error)
        transport.write.assert_called_once_with(bytes.fromhex('d300000000'))
        transport.close.assert_called_once()
        text = '\n'.join(output.output)
        self.assertIn('direction=TX type=13', text)
        self.assertIn('errno=54', text)
        self.assertNotIn('secret-token', text)

if __name__ == '__main__':
    unittest.main()

class ManagerWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_manager_and_protocol_share_proxy_on_every_connection(self):
        class Protocol:
            def connection_made(self, transport):
                self._transport = transport
                transport.write(bytes.fromhex('1300000000'))
            def data_received(self, data):
                pass
            def connection_lost(self, exc):
                pass
        class Manager:
            async def _establish_tcp_connection(self):
                self.raw = Mock()
                self._protocol = Protocol()
                self._protocol.connection_made(self.raw)
                self._transport = self.raw
                return 'connected'
        original = Manager._establish_tcp_connection
        manager = Manager()
        with self.assertLogs('diagnostic', logging.INFO) as output:
            with WireObserver(Protocol, Manager):
                for session in (1, 2):
                    self.assertEqual(await manager._establish_tcp_connection(), 'connected')
                    self.assertIs(manager._transport, manager._protocol._transport)
                    heartbeat = bytes.fromhex('d300000000')
                    manager._transport.write(heartbeat)
                    manager._transport.close()
                    self.assertEqual(manager.raw.write.call_count, 2)
                    self.assertIs(manager.raw.write.call_args.args[0], heartbeat)
                    manager.raw.close.assert_called_once()
        self.assertIs(Manager._establish_tcp_connection, original)
        for session in (1, 2):
            lines = [line for line in output.output if f'session={session} ' in line]
            self.assertEqual(sum('direction=TX type=1 ' in line for line in lines), 1)
            self.assertEqual(sum('direction=TX type=13 ' in line for line in lines), 1)
            self.assertEqual(sum('local_close_requested' in line for line in lines), 1)
