import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest

import pymupdf

from backend.converters.docling import DoclingConverter
from backend.converters.liteparse import LiteParseConverter
from backend.converters.pages import page_markdown
from backend.converters.pymupdf import PyMuPDFConverter
from backend.services.enrichment_pipeline import run_enrichment_pipeline
from backend.utils.markdown import split_markdown


class ConverterPageTests(unittest.TestCase):
    def test_capabilities_advertise_page_mapping_for_supported_converters(self):
        from backend.registry import registry
        capabilities = {item['name']: item['page_mapping'] for item in registry.get_capabilities()['converters']}
        self.assertEqual({name for name, enabled in capabilities.items() if enabled}, {'pymupdf', 'docling', 'liteparse', 'vlm'})
        self.assertFalse(capabilities['markitdown'])
        self.assertFalse(capabilities['cloud'])

    def test_native_converters_keep_blank_pages_and_original_page_numbers(self):
        with TemporaryDirectory() as folder:
            filename = Path(folder)/'three.pdf'
            with pymupdf.open() as document:
                for number in range(1, 4):
                    page = document.new_page()
                    if number != 2:
                        page.insert_text((72, 72), f'Unique text from page {number}')
                document.save(filename)
            for converter in (PyMuPDFConverter(), LiteParseConverter()):
                with self.subTest(converter=type(converter).__name__):
                    output = converter.convert(filename, total_pages=3)
                    for number in (1, 2, 3):
                        self.assertEqual(output.count(f'<!-- page-marker:{number} -->'), 1)
                    self.assertIn('Unique text from page 1', output)
                    self.assertIn('Unique text from page 3', output)
                    self.assertLess(output.index('<!-- page-marker:2 -->'), output.index('Unique text from page 3'))

    def test_docling_serializes_real_document_provenance_by_page(self):
        from docling_core.types.doc import BoundingBox, DocItemLabel, DoclingDocument, ProvenanceItem, Size
        doc = DoclingDocument(name='pages')
        for number in range(1, 4):
            doc.add_page(number, Size(width=612, height=792))
            if number != 2:
                text = f'Unique text from page {number}'
                doc.add_text(label=DocItemLabel.TEXT, text=text, prov=ProvenanceItem(
                    page_no=number, bbox=BoundingBox(l=10, t=10, r=200, b=30), charspan=(0, len(text)),
                ))
        converter = object.__new__(DoclingConverter)
        converter._converter = SimpleNamespace(convert=lambda _: SimpleNamespace(document=doc))
        with TemporaryDirectory() as folder:
            filename = Path(folder)/'test.pdf'
            filename.write_bytes(b'%PDF-1.4')
            output = converter.convert(filename, total_pages=3)
        self.assertEqual(output, page_markdown([(1, 'Unique text from page 1'), (3, 'Unique text from page 3')], 3))

    def test_enrichment_cannot_remove_page_markers_or_cross_page_boundaries(self):
        source = page_markdown([(1, 'First page body.'), (2, 'Second page body.')])
        pieces = split_markdown(source)
        self.assertEqual(''.join(piece.content for piece in pieces), source)
        for piece in pieces:
            self.assertEqual(source[piece.start:piece.end], piece.content)
            self.assertFalse('First page body' in piece.content and 'Second page body' in piece.content)

        class Model:
            model_name = 'test-model'
            base_url = 'local'
            temperature = 0
            calls = []

            def effective_piece_system_prompt(self, **kwargs):
                return 'Conservative cleanup'

            async def enrich_piece(self, piece_content, **kwargs):
                self.calls.append(piece_content)
                return piece_content.replace('body', 'content')

        model = Model()
        output = asyncio.run(run_enrichment_pipeline(source_markdown=source, service=model, checkpoint_store=None))
        self.assertIn('<!-- page-marker:1 -->', output.corrected_markdown)
        self.assertIn('<!-- page-marker:2 -->', output.corrected_markdown)
        self.assertTrue(all('page-marker:' not in content for content in model.calls))
        self.assertIn('First page content', output.corrected_markdown)


if __name__ == '__main__':
    unittest.main()
