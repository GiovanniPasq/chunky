"""
PDF to Markdown converter module.
This module provides a modular interface for converting PDFs to Markdown.
The default implementation uses pymupdf4llm, but can be easily replaced.
"""

from pathlib import Path
from typing import Optional
import pymupdf4llm


class PDFConverter:
    """Base class for PDF converters. Extend this to implement custom converters."""

    def convert(self, pdf_path: Path) -> str:
        """
        Convert a PDF file to Markdown.

        Args:
            pdf_path: Path to the PDF file

        Returns:
            Markdown content as a string
        """
        raise NotImplementedError("Subclasses must implement convert()")


class PyMuPDFConverter(PDFConverter):
    """PDF converter using pymupdf4llm library."""

    def convert(self, pdf_path: Path) -> str:
        """
        Convert a PDF file to Markdown using pymupdf4llm.

        Args:
            pdf_path: Path to the PDF file

        Returns:
            Markdown content as a string
        """
        if not pdf_path.exists():
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")

        # Convert PDF to Markdown using pymupdf4llm
        md_text = pymupdf4llm.to_markdown(str(pdf_path))

        return md_text


# Default converter instance
_default_converter: Optional[PDFConverter] = None


def set_default_converter(converter: PDFConverter):
    """Set the default PDF converter to use."""
    global _default_converter
    _default_converter = converter


def get_default_converter() -> PDFConverter:
    """Get the default PDF converter."""
    global _default_converter
    if _default_converter is None:
        _default_converter = PyMuPDFConverter()
    return _default_converter


def pdf_to_markdown(pdf_path: Path, converter: Optional[PDFConverter] = None) -> str:
    """
    Convert a PDF file to Markdown.

    Args:
        pdf_path: Path to the PDF file
        converter: Optional custom converter. If None, uses default converter.

    Returns:
        Markdown content as a string

    Example:
        # Use default converter (pymupdf4llm)
        markdown = pdf_to_markdown(Path("document.pdf"))

        # Use custom converter
        custom_converter = MyCustomConverter()
        markdown = pdf_to_markdown(Path("document.pdf"), converter=custom_converter)
    """
    if converter is None:
        converter = get_default_converter()

    return converter.convert(pdf_path)
