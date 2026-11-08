from pathlib import Path
from tempfile import TemporaryDirectory
from types import ModuleType, SimpleNamespace
import sys
import unittest
from unittest.mock import patch

from backend.converters.liteparse import LiteParseConverter


class LiteParseConverterTests(unittest.TestCase):
    def test_requests_markdown_output(self) -> None:
        constructor_options = {}
        parsed_paths = []

        class FakeLiteParse:
            def __init__(self, **options) -> None:
                constructor_options.update(options)

            def parse(self, path: str):
                parsed_paths.append(path)
                return SimpleNamespace(pages=[SimpleNamespace(page_num=1, markdown="# Markdown")], total_pages=1)

        fake_module = ModuleType("liteparse")
        fake_module.LiteParse = FakeLiteParse

        with TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "report.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")

            with patch.dict(sys.modules, {"liteparse": fake_module}):
                result = LiteParseConverter().convert(pdf_path)

        self.assertEqual(constructor_options, {"output_format": "markdown", "keep_headers_footers": True})
        self.assertEqual(parsed_paths, [str(pdf_path)])
        self.assertEqual(result, "<!-- page-marker:1 -->\n# Markdown")

    def test_preserves_text_on_short_pages_with_repeated_headings(self) -> None:
        import pymupdf

        with TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "short.pdf"
            with pymupdf.open() as document:
                for index in range(2):
                    page = document.new_page()
                    page.insert_text((72, 72), "Document preparation audit", fontsize=22)
                    page.insert_text((72, 120), f"Page {index + 1}: Preserve searchable text.")
                document.save(pdf_path)
            result = LiteParseConverter().convert(pdf_path)
        self.assertIn("Document preparation audit", result)
        self.assertIn("Page 1", result)
        self.assertIn("Page 2", result)


if __name__ == "__main__":
    unittest.main()
