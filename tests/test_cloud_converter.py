import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import threading
import unittest

from backend.converters.cloud import CloudConverter


class _SlowCloudConverter(CloudConverter):
    async def _call_api_with_retry_async(self, _http, _pdf_path: Path) -> str:
        await asyncio.sleep(5)
        return "late markdown"


class CloudConverterTests(unittest.TestCase):
    def test_stop_event_cancels_in_flight_request(self) -> None:
        async def run() -> None:
            with TemporaryDirectory() as tmp:
                pdf_path = Path(tmp) / "report.pdf"
                pdf_path.write_bytes(b"%PDF-1.4\n")

                stop_event = threading.Event()
                converter = _SlowCloudConverter(stop_event=stop_event)

                task = asyncio.create_task(converter._async_convert(pdf_path))
                await asyncio.sleep(0.05)
                stop_event.set()

                with self.assertRaises(InterruptedError):
                    await asyncio.wait_for(task, timeout=1)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
