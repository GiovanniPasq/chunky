"""
Shared ProcessPoolExecutor cancellation utility.

Handles the cancel-futures → SIGTERM → swap-executor → SIGKILL escalation
pattern that is common to every CPU-bound SSE endpoint.
"""

from __future__ import annotations

import asyncio
import logging
from concurrent.futures import ProcessPoolExecutor
from typing import Any, Callable

from backend.config import get_settings


async def escalate_kill(procs: list, label: str = "Worker process") -> None:
    """Send SIGKILL to any worker still alive 3 s after SIGTERM."""
    await asyncio.sleep(3.0)
    for p in procs:
        if p.is_alive():
            try:
                p.kill()
                logging.getLogger(__name__).warning(
                    "%s %d ignored SIGTERM — sent SIGKILL", label, p.pid
                )
            except Exception as exc:
                logging.getLogger(__name__).debug(
                    "Failed to SIGKILL %s %d: %s", label, p.pid, exc
                )


async def cancel_cpu_executor(
    cpu_futures: list,
    app_state: Any,
    executor_attr: str,
    max_workers: int,
    initializer: Callable,
    label: str,
    logger: logging.Logger,
) -> None:
    """Cancel in-flight ProcessPoolExecutor futures, SIGTERM worker processes,
    and atomically replace the broken executor on app_state.

    Queued futures (not yet picked up by a worker) are cancelled via
    Future.cancel(). Futures already running in a worker cannot be cancelled
    without killing the process; those workers receive SIGTERM, with SIGKILL
    escalated after 3 s if they do not exit.

    The old executor is immediately replaced on app_state so concurrent
    requests get a fresh pool without waiting for teardown.
    """
    still_running: list = []
    for f in list(cpu_futures):
        if not f.cancel():
            still_running.append(f)

    if not still_running:
        return

    old_executor: ProcessPoolExecutor = getattr(app_state, executor_attr)
    worker_procs = list(getattr(old_executor, "_processes", {}).values())

    for proc in worker_procs:
        try:
            proc.terminate()
        except Exception as exc:
            logger.debug("Failed to send SIGTERM to %s %d: %s", label, proc.pid, exc)

    s = get_settings()
    try:
        setattr(
            app_state,
            executor_attr,
            ProcessPoolExecutor(
                max_workers=max_workers,
                initializer=initializer,
                max_tasks_per_child=s.CPU_WORKER_MAX_TASKS_PER_CHILD or None,
            ),
        )
    finally:
        try:
            app_state.retired_executors.append(old_executor)
            old_executor.shutdown(wait=False, cancel_futures=True)
        except Exception as exc:
            logger.warning("Failed to retire old %s executor: %s", label, exc)

    asyncio.create_task(escalate_kill(worker_procs, label))
