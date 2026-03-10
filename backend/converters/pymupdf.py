"""
PDF-to-Markdown converter backed by pymupdf4llm.
"""

from pathlib import Path

import pymupdf4llm

from .base import PDFConverter


class PyMuPDFConverter(PDFConverter):
    """Fast, lightweight converter using pymupdf4llm.

    Best suited for standard digital PDFs with selectable text.
    Produces clean Markdown with good table support.

    Install:
        pip install pymupdf4llm
    """

    def convert(self, pdf_path: Path) -> str:
        self.validate_path(pdf_path)
        return pymupdf4llm.to_markdown(str(pdf_path))