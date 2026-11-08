import asyncio
import hashlib
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from backend.services.enrichment_checkpoint import (
    EnrichmentCheckpointStore,
    hash_key,
)
from backend.services.enrichment_pipeline import run_enrichment_pipeline


class _FakeEnrichmentService:
    model_name = "shared-model"
    temperature = 0.3

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url
        self.calls = 0

    def effective_piece_system_prompt(self, *, with_summary: bool) -> str:
        return "shared prompt"

    async def enrich_piece(
        self,
        piece_content: str,
        previous_context: str = "",
        document_summary=None,
    ) -> str:
        self.calls += 1
        return f"{self.base_url}:{piece_content}"


class EnrichmentCheckpointTests(unittest.TestCase):
    def test_pre_fix_cached_corrections_are_not_reused(self) -> None:
        source = '```python\nprint("hello")\n```\n'
        service = _FakeEnrichmentService('local')
        legacy_key = hashlib.sha256('\x1e'.join([
            source, 'shared prompt', service.model_name, '0.300000', '', 'local', '',
        ]).encode()).hexdigest()
        with TemporaryDirectory() as folder:
            store = EnrichmentCheckpointStore('report', Path(folder))
            store.set(0, legacy_key, 'python\nprint("hello")\n')
            result = asyncio.run(run_enrichment_pipeline(
                source_markdown=source, service=service, checkpoint_store=store,
            ))
            self.assertEqual(service.calls, 1)
            self.assertEqual(result.cached_pieces, 0)
            self.assertIn('```python', result.corrected_markdown)

    def test_endpoint_change_does_not_reuse_checkpoint(self) -> None:
        async def _run() -> tuple[str, int, int]:
            with TemporaryDirectory() as tmp:
                store = EnrichmentCheckpointStore("report_vlm", Path(tmp))
                endpoint_a = _FakeEnrichmentService("http://endpoint-a/v1")
                endpoint_b = _FakeEnrichmentService("http://endpoint-b/v1")

                await run_enrichment_pipeline(
                    source_markdown="Body text.\n",
                    service=endpoint_a,
                    checkpoint_store=store,
                )
                second = await run_enrichment_pipeline(
                    source_markdown="Body text.\n",
                    service=endpoint_b,
                    checkpoint_store=store,
                )
                return second.corrected_markdown, second.cached_pieces, endpoint_b.calls

        content, cached, calls = asyncio.run(_run())

        self.assertEqual(content, "http://endpoint-b/v1:Body text.\n")
        self.assertEqual(cached, 0)
        self.assertEqual(calls, 1)

    def test_rolling_context_participates_in_cache_key(self) -> None:
        common = {
            "piece_content": "Same piece",
            "prompt": "Prompt",
            "model": "Model",
            "temperature": 0.3,
            "document_summary_hash": "",
            "base_url": "http://localhost:11434/v1",
        }

        first = hash_key(**common, previous_context="Earlier version A")
        second = hash_key(**common, previous_context="Earlier version B")

        self.assertNotEqual(first, second)


if __name__ == "__main__":
    unittest.main()
