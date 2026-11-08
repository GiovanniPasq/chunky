from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import pymupdf

from backend.converters.pymupdf import PyMuPDFConverter


class PyMuPDFConverterTests(unittest.TestCase):
    def test_converts_searchable_pdf_with_current_pymupdf_api(self):
        with TemporaryDirectory() as tmp:
            path = Path(tmp) / "sample.pdf"
            with pymupdf.open() as document:
                page = document.new_page()
                page.insert_text((72, 72), "Document preparation and retrieval quality")
                document.save(str(path))
            markdown = PyMuPDFConverter().convert(path)
            self.assertIsInstance(markdown, str)
            self.assertIn("Document preparation and retrieval quality", markdown)


if __name__ == "__main__":
    unittest.main()
