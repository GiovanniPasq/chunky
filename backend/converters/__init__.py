"""
PDF-to-Markdown converters.

Available converters
--------------------
PyMuPDFConverter    — fast, lightweight (pymupdf4llm)
DoclingConverter    — advanced layout understanding (docling)
MarkItDownConverter — broad format support (markitdown)
LiteParseConverter  — fast, model-free PDF-to-Markdown parser (liteparse)
VLMConverter        — vision-language model via OpenAI-compatible API
CloudConverter      — generic HTTP PDF-to-Markdown endpoint
"""

from .base import PDFConverter
from .docling import DoclingConverter
from .liteparse import LiteParseConverter
from .markitdown import MarkItDownConverter
from .pymupdf import PyMuPDFConverter
from .vlm import VLMConverter
from .cloud import CloudConverter

__all__ = [
    "PDFConverter",
    "PyMuPDFConverter",
    "DoclingConverter",
    "MarkItDownConverter",
    "LiteParseConverter",
    "VLMConverter",
    "CloudConverter",
]
