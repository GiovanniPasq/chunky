import asyncio
import logging
import time
import unittest
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

from backend.utils.executor import terminate_process_pool


def _sleep_then_return(delay: float, value: int) -> int:
    time.sleep(delay)
    return value


class ExecutorCancellationTests(unittest.TestCase):
    def test_terminates_only_the_owned_pool(self) -> None:
        cancelled_pool = ProcessPoolExecutor(max_workers=1)
        other_pool = ProcessPoolExecutor(max_workers=1)
        cancelled_future = cancelled_pool.submit(_sleep_then_return, 10.0, 1)
        other_future = other_pool.submit(_sleep_then_return, 0.05, 2)
        time.sleep(0.2)
        cancelled_processes = list(cancelled_pool._processes.values())

        asyncio.run(
            terminate_process_pool(
                cancelled_pool,
                [cancelled_future],
                label="test worker",
                logger=logging.getLogger(__name__),
            )
        )

        self.assertFalse(any(process.is_alive() for process in cancelled_processes))
        with self.assertRaises((BrokenProcessPool, RuntimeError)):
            cancelled_future.result(timeout=2)
        self.assertEqual(other_future.result(timeout=2), 2)
        other_pool.shutdown(wait=True)


if __name__ == "__main__":
    unittest.main()
