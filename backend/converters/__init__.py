"""
PDF-to-Markdown converters.

Available converters
--------------------
PyMuPDFConverter    — fast, lightweight (pymupdf4llm)
DoclingConverter    — advanced layout understanding (docling)
MarkItDownConverter — broad format support (markitdown)
LiteParseConverter  — high-performance Node.js engine (liteparse)
VLMConverter        — vision-language model via OpenAI-compatible API
"""

from .base import PDFConverter
from .docling import DoclingConverter
from .liteparse import LiteParseConverter
from .markitdown import MarkItDownConverter
from .pymupdf import PyMuPDFConverter
from .vlm import VLMConverter

__all__ = [
    "PDFConverter",
    "PyMuPDFConverter",
    "DoclingConverter",
    "MarkItDownConverter",
    "LiteParseConverter",
    "VLMConverter",
]