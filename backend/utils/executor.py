"""Lifecycle helpers for request-owned process pools."""

from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import Future, ProcessPoolExecutor

from backend.config import get_settings


async def terminate_process_pool(
    executor: ProcessPoolExecutor,
    futures: list[Future],
    *,
    label: str,
    logger: logging.Logger,
) -> None:
    """Hard-stop one request-owned pool and wait for its workers to exit."""
    for future in list(futures):
        future.cancel()

    processes = list(getattr(executor, "_processes", {}).values())
    for process in processes:
        try:
            process.terminate()
        except Exception as exc:
            logger.debug("Failed to terminate %s %d: %s", label, process.pid, exc)

    executor.shutdown(wait=False, cancel_futures=True)

    deadline = time.monotonic() + max(0.0, get_settings().WORKER_SIGKILL_DELAY_S)
    while any(process.is_alive() for process in processes) and time.monotonic() < deadline:
        await asyncio.sleep(0.05)

    for process in processes:
        if not process.is_alive():
            continue
        try:
            process.kill()
            logger.warning("%s %d ignored SIGTERM — sent SIGKILL", label, process.pid)
        except Exception as exc:
            logger.debug("Failed to kill %s %d: %s", label, process.pid, exc)

    await asyncio.gather(
        *(asyncio.to_thread(process.join, 1.0) for process in processes),
    )
