import asyncio
import json
import unittest

from backend.utils.sse import run_sse_event_loop


def _payload(frame: str) -> dict:
    return json.loads(frame.removeprefix("data: ").strip())


class _Request:
    def __init__(self, disconnected: bool = False) -> None:
        self.disconnected = disconnected

    async def is_disconnected(self) -> bool:
        return self.disconnected


class SseEventLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_disconnect_cancels_before_stream_exit(self) -> None:
        cancelled = asyncio.Event()

        async def cancel() -> None:
            cancelled.set()

        frames = [
            frame async for frame in run_sse_event_loop(
                queue=asyncio.Queue(),
                http_request=_Request(disconnected=True),
                on_cancel=cancel,
                handle_event=lambda event: ("", False),
                watchdog_s=0,
                queue_timeout_s=0.01,
                log_name="test",
            )
        ]

        self.assertTrue(cancelled.is_set())
        self.assertEqual([_payload(frame)["type"] for frame in frames], ["cancelled"])

    async def test_outer_task_cancellation_is_not_suppressed(self) -> None:
        cancelled = asyncio.Event()

        async def cancel() -> None:
            cancelled.set()

        stream = run_sse_event_loop(
            queue=asyncio.Queue(),
            http_request=_Request(),
            on_cancel=cancel,
            handle_event=lambda event: ("", False),
            watchdog_s=0,
            queue_timeout_s=60,
            log_name="test",
        )
        pending = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        pending.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await pending
        self.assertTrue(cancelled.is_set())
        await stream.aclose()

    async def test_clean_completion_emits_final_frame(self) -> None:
        queue: asyncio.Queue = asyncio.Queue()
        queue.put_nowait({"type": "progress"})
        queue.put_nowait(None)
        cancel_calls = 0

        async def cancel() -> None:
            nonlocal cancel_calls
            cancel_calls += 1

        frames = [
            frame async for frame in run_sse_event_loop(
                queue=queue,
                http_request=_Request(),
                on_cancel=cancel,
                handle_event=lambda event: (
                    f"data: {json.dumps(event)}\n\n",
                    False,
                ),
                watchdog_s=0,
                queue_timeout_s=0.01,
                log_name="test",
                on_complete=lambda: ['data: {"type": "done"}\n\n'],
            )
        ]

        self.assertEqual(
            [_payload(frame)["type"] for frame in frames],
            ["progress", "done"],
        )
        self.assertEqual(cancel_calls, 1)


if __name__ == "__main__":
    unittest.main()
