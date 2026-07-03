import asyncio
import tempfile
import threading
import time
import unittest
from concurrent.futures import Future
from pathlib import Path
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from backend.models.schemas import ConvertPreviewRequest, ConvertRequest, ConverterType
from backend.routers import documents_router
from backend.services.document_service import publish_pdf_without_overwrite


class _DisconnectedRequest:
    async def is_disconnected(self) -> bool:
        return True


class _ConnectedRequest:
    async def is_disconnected(self) -> bool:
        return False


class _ConversionRequest:
    def __init__(self, started: threading.Event) -> None:
        self.started = started
        self.app = type("App", (), {})()
        self.app.state = type("State", (), {})()
        self.app.state.conversion_semaphore = asyncio.Semaphore(1)

    async def is_disconnected(self) -> bool:
        return self.started.is_set()


class _FakeExecutor:
    def __init__(self, *args, **kwargs) -> None:
        self.future: Future = Future()
        self.shutdown_calls: list[tuple[bool, bool]] = []

    def submit(self, *args, **kwargs) -> Future:
        return self.future

    def shutdown(self, wait=True, *, cancel_futures=False) -> None:
        self.shutdown_calls.append((wait, cancel_futures))


class _SubmitNotifyingExecutor(_FakeExecutor):
    def __init__(self, started: threading.Event) -> None:
        super().__init__()
        self.started = started

    def submit(self, *args, **kwargs) -> Future:
        self.started.set()
        return super().submit(*args, **kwargs)


class MarkdownToPdfCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_terminates_owned_worker_and_discards_temp(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            md_path = root / "report.md"
            pdf_path = root / "report.pdf"
            md_path.write_text("# report", encoding="utf-8")
            fake_executor = _FakeExecutor()
            terminate = AsyncMock()

            with (
                patch.object(
                    documents_router._svc,
                    "prepare_md_to_pdf",
                    return_value=(md_path, pdf_path),
                ),
                patch.object(
                    documents_router,
                    "create_pdf_temp_path",
                    side_effect=lambda _: root / ".report.tmp.pdf",
                ),
                patch.object(
                    documents_router,
                    "ProcessPoolExecutor",
                    return_value=fake_executor,
                ),
                patch.object(documents_router, "terminate_process_pool", terminate),
            ):
                with self.assertRaises(HTTPException) as raised:
                    await documents_router.convert_md_to_pdf(
                        _DisconnectedRequest(),
                        "report.md",
                        "report.md",
                    )

            self.assertEqual(raised.exception.status_code, 499)
            terminate.assert_awaited_once()
            self.assertFalse((root / ".report.tmp.pdf").exists())

    async def test_io_conversion_disconnect_waits_for_worker_thread(self) -> None:
        started = threading.Event()
        finished = threading.Event()

        def cooperative_conversion(*args, **kwargs):
            stop = kwargs["stop_event"]
            started.set()
            while not stop.is_set():
                time.sleep(0.005)
            time.sleep(0.05)
            finished.set()
            raise InterruptedError("cancelled")

        request = _ConversionRequest(started)
        with patch.object(
            documents_router._svc,
            "convert_to_markdown",
            side_effect=cooperative_conversion,
        ):
            response = await documents_router.convert_pdfs(
                request,
                ConvertRequest(
                    filenames=["report.pdf"],
                    converter=ConverterType.cloud,
                ),
            )
            frames = [frame async for frame in response.body_iterator]

        self.assertTrue(finished.is_set())
        self.assertTrue(any("cancelled" in frame for frame in frames))

    async def test_cpu_batch_conversion_disconnect_terminates_owned_worker(self) -> None:
        started = threading.Event()
        fake_executor = _SubmitNotifyingExecutor(started)
        terminate = AsyncMock()

        request = _ConversionRequest(started)
        with (
            patch.object(
                documents_router,
                "ProcessPoolExecutor",
                return_value=fake_executor,
            ),
            patch.object(documents_router, "terminate_process_pool", terminate),
        ):
            response = await documents_router.convert_pdfs(
                request,
                ConvertRequest(
                    filenames=["report.pdf"],
                    converter=ConverterType.pymupdf,
                ),
            )
            frames = [frame async for frame in response.body_iterator]

        terminate.assert_awaited_once()
        self.assertTrue(fake_executor.future.cancelled())
        self.assertTrue(any("file_start" in frame for frame in frames))
        self.assertTrue(any("cancelled" in frame for frame in frames))

    async def test_preview_conversion_delegates_to_service(self) -> None:
        with patch.object(
            documents_router._svc,
            "preview_conversion",
            return_value={
                "success": True,
                "filename": "report.pdf",
                "converter": ConverterType.pymupdf,
                "start_page": 1,
                "end_page": 1,
                "page_count": 3,
                "md_content": "preview",
            },
        ) as preview:
            result = await documents_router.preview_conversion(
                _ConnectedRequest(),
                ConvertPreviewRequest(
                    filename="report.pdf",
                    converter=ConverterType.cloud,
                    start_page=1,
                    end_page=1,
                )
            )

        preview.assert_called_once()
        self.assertEqual(result["md_content"], "preview")

    async def test_cpu_preview_disconnect_terminates_owned_worker(self) -> None:
        fake_executor = _FakeExecutor()
        terminate = AsyncMock()

        with (
            patch.object(
                documents_router,
                "ProcessPoolExecutor",
                return_value=fake_executor,
            ),
            patch.object(documents_router, "terminate_process_pool", terminate),
        ):
            with self.assertRaises(HTTPException) as raised:
                await documents_router.preview_conversion(
                    _DisconnectedRequest(),
                    ConvertPreviewRequest(
                        filename="report.pdf",
                        converter=ConverterType.pymupdf,
                        start_page=1,
                        end_page=1,
                    ),
                )

        self.assertEqual(raised.exception.status_code, 499)
        terminate.assert_awaited_once()

    async def test_explicit_preview_cancel_terminates_owned_worker(self) -> None:
        fake_executor = _FakeExecutor()
        terminate = AsyncMock()

        with (
            patch.object(
                documents_router,
                "ProcessPoolExecutor",
                return_value=fake_executor,
            ),
            patch.object(documents_router, "terminate_process_pool", terminate),
        ):
            task = asyncio.create_task(documents_router.preview_conversion(
                _ConnectedRequest(),
                ConvertPreviewRequest(
                    filename="report.pdf",
                    converter=ConverterType.pymupdf,
                    start_page=1,
                    end_page=1,
                    preview_id="preview-test",
                ),
            ))
            await asyncio.sleep(0)

            result = await documents_router.cancel_preview_conversion("preview-test")

            with self.assertRaises(HTTPException) as raised:
                await task

        self.assertEqual(result, {"success": True, "cancelled": True})
        self.assertEqual(raised.exception.status_code, 499)
        terminate.assert_awaited_once()

    async def test_explicit_io_preview_cancel_is_not_reported_as_500(self) -> None:
        started = threading.Event()
        finished = threading.Event()

        def cooperative_preview(*args, **kwargs):
            stop = kwargs["stop_event"]
            started.set()
            while not stop.is_set():
                time.sleep(0.005)
            finished.set()
            raise InterruptedError("Conversion cancelled")

        with patch.object(
            documents_router._svc,
            "preview_conversion",
            side_effect=cooperative_preview,
        ):
            task = asyncio.create_task(documents_router.preview_conversion(
                _ConnectedRequest(),
                ConvertPreviewRequest(
                    filename="report.pdf",
                    converter=ConverterType.vlm,
                    start_page=1,
                    end_page=1,
                    preview_id="io-preview-test",
                ),
            ))

            while not started.is_set():
                await asyncio.sleep(0.005)

            result = await documents_router.cancel_preview_conversion("io-preview-test")

            with self.assertRaises(HTTPException) as raised:
                await task

        self.assertEqual(result, {"success": True, "cancelled": True})
        self.assertTrue(finished.is_set())
        self.assertEqual(raised.exception.status_code, 499)

    async def test_preview_worker_wait_timeout_does_not_cancel_worker_wrapper(self) -> None:
        future = asyncio.get_running_loop().create_future()

        done = await documents_router._wait_for_worker_future(future, 0.001)

        self.assertFalse(done)
        self.assertFalse(future.cancelled())
        future.set_exception(InterruptedError("Conversion cancelled"))
        documents_router._consume_future_exception(future)


class PdfPublicationTests(unittest.TestCase):
    def test_publish_refuses_to_replace_existing_pdf(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            final = root / "report.pdf"
            temp = root / ".report.tmp.pdf"
            final.write_bytes(b"existing")
            temp.write_bytes(b"new")

            with self.assertRaises(HTTPException) as raised:
                publish_pdf_without_overwrite(temp, final)

            self.assertEqual(raised.exception.status_code, 409)
            self.assertEqual(final.read_bytes(), b"existing")
            self.assertFalse(temp.exists())


if __name__ == "__main__":
    unittest.main()
