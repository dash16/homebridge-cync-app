import asyncio
import importlib.util
import logging
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('harness', Path(__file__).with_name('run.py'))
h = importlib.util.module_from_spec(spec)
spec.loader.exec_module(h)

class HarnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_observer_forwards_original_packet_without_changes(self):
        original = AsyncMock()
        manager = SimpleNamespace(_client_callback=original, _transport=None, _login_acknowledged=False)
        counts = {}
        task = asyncio.create_task(h.observe(manager, counts))
        await asyncio.sleep(0)
        packet = SimpleNamespace(message_type=13, command_code=None, data='secret')
        with self.assertLogs(h.LOG, level='INFO') as output:
            await manager._client_callback(packet)
        original.assert_awaited_once_with(packet)
        self.assertEqual(counts, {13: 1})
        self.assertNotIn('secret', str(output.output))
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    async def test_manual_controls_dispatch_to_reference_api(self):
        device = SimpleNamespace(name='test lamp')
        cc = SimpleNamespace(set_power_state=AsyncMock(), set_color_temp=AsyncMock())
        client = SimpleNamespace(get_devices=lambda: [device], _command_client=cc)
        with patch.object(h, 'prompt', AsyncMock(side_effect=['on 1', 'ct 1 50', 'quit'])):
            await h.controls(client)
        cc.set_power_state.assert_awaited_once_with(device, True)
        cc.set_color_temp.assert_awaited_once_with(device, 50)

    async def test_library_error_does_not_leak_exception_message(self):
        record = logging.LogRecord('pycync', logging.ERROR, '', 0, 'secret-password secret-token', (), None)
        with self.assertLogs(h.LOG, level='ERROR') as output:
            h.SafeLibraryLog().emit(record)
        self.assertNotIn('secret', str(output.output))

if __name__ == '__main__':
    unittest.main()
