import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import AsyncMock

from backend.converters.pages import page_markdown
from backend.services.document_summary import (
    DocumentSummary, DocumentSummaryStore, PieceExtraction, StoredSummary,
    _reduce_with_tiering, get_or_generate_summary,
)
from backend.utils.markdown import split_markdown


class DocumentSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_summary_excludes_markers_and_blank_pages_and_reuses_cache(self):
        source = page_markdown([(1, 'First section.'), (3, 'Last section.')], 3)
        service = AsyncMock()
        service.extract_piece_summary.return_value = PieceExtraction(['Report'], 'A section.')
        service.reduce_extractions.return_value = {'topic': 'Report', 'narrative': 'First and last sections.'}
        events = []
        with TemporaryDirectory() as folder:
            arguments = dict(pieces=split_markdown(source), cleaned_source=source, doc_stem='report',
                             mds_dir=Path(folder), pdf_path=None, service=service, on_progress=events.append)
            first = await get_or_generate_summary(**arguments)
            second = await get_or_generate_summary(**arguments)
            self.assertEqual(first, second)
            self.assertEqual(service.extract_piece_summary.await_count, 2)
            self.assertEqual(service.reduce_extractions.await_count, 1)
            inputs = [call.args[0] for call in service.extract_piece_summary.call_args_list]
            self.assertTrue(all('page-marker:' not in text and text.strip() for text in inputs))
            self.assertEqual([e['total'] for e in events if e['type'] == 'summary_progress'], [2, 2])
            self.assertTrue(events[-1]['cached'])

    async def test_failed_map_or_reduce_preserves_previous_summary_on_regeneration(self):
        source = page_markdown([(1, 'First section.'), (2, 'Last section.')])
        for failure in ('map', 'reduce'):
            with self.subTest(failure=failure), TemporaryDirectory() as folder:
                store = DocumentSummaryStore('report', Path(folder))
                previous = StoredSummary('old', DocumentSummary('Old topic', 'Reviewed narrative'), 'yesterday', True)
                store.save(previous)
                original_bytes = store.path.read_bytes()
                service = AsyncMock()
                service.extract_piece_summary.side_effect = [
                    PieceExtraction(['Report'], 'First section.'),
                    ValueError('Invalid JSON') if failure == 'map' else PieceExtraction(['Report'], 'Last section.'),
                ]
                service.reduce_extractions.side_effect = ValueError('Invalid JSON')
                with self.assertRaises(ValueError):
                    await get_or_generate_summary(
                        pieces=split_markdown(source), cleaned_source=source, doc_stem='report',
                        mds_dir=Path(folder), pdf_path=None, service=service, force_regenerate=True,
                    )
                self.assertEqual(store.path.read_bytes(), original_bytes)
                if failure == 'map':
                    service.reduce_extractions.assert_not_awaited()

    async def test_tiered_reduce_obeys_concurrency_and_checks_cancel_before_final_call(self):
        class Service:
            active = 0
            peak = 0
            calls = 0
            async def reduce_extractions(self, **kwargs):
                self.active += 1
                self.peak = max(self.peak, self.active)
                self.calls += 1
                await asyncio.sleep(0)
                self.active -= 1
                return {'topic': 'Report', 'narrative': 'Combined sections.'}
        extractions = [PieceExtraction(['Report'], 'A section.') for _ in range(41)]
        service = Service()
        summary = await _reduce_with_tiering(extractions=extractions, service=service, stop_check=None, concurrency=2)
        self.assertFalse(summary.is_empty())
        self.assertEqual(service.peak, 2)
        self.assertEqual(service.calls, 6)
        service = Service()
        with self.assertRaises(InterruptedError):
            await _reduce_with_tiering(extractions=extractions, service=service,
                                       stop_check=lambda: service.calls == 5 and service.active == 0, concurrency=2)
        self.assertEqual(service.calls, 5)

    async def test_cancelled_summary_is_not_persisted(self):
        service = AsyncMock()
        service.extract_piece_summary.return_value = PieceExtraction(['Report'], 'A section.')
        service.reduce_extractions.return_value = {'topic': 'Report', 'narrative': 'A narrative.'}
        with TemporaryDirectory() as folder:
            with self.assertRaises(InterruptedError):
                await get_or_generate_summary(
                    pieces=split_markdown('Body.'), cleaned_source='Body.', doc_stem='report',
                    mds_dir=Path(folder), pdf_path=None, service=service,
                    stop_check=lambda: service.reduce_extractions.await_count > 0,
                )
            self.assertFalse(DocumentSummaryStore('report', Path(folder)).path.exists())


if __name__ == '__main__':
    unittest.main()
