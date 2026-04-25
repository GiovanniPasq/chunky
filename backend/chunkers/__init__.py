"""
Text chunkers for the backend.

Available chunker libraries
-----------------------------
LangChainChunker  — backed by langchain-text-splitters (token, recursive, character, markdown)
ChonkieChunker    — backed by Chonkie (token, recursive, sentence, fast, semantic, neural, table, code)
DoclingChunker    — backed by Docling (hybrid, line_based)
"""

from .base import TextChunker
from .chonkie_chunker import ChonkieChunker
from .docling_chunker import DoclingChunker
from .langchain_chunker import LangChainChunker

__all__ = [
    "TextChunker",
    "LangChainChunker",
    "ChonkieChunker",
    "DoclingChunker",
]
