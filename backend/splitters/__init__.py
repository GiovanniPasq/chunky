"""
Text splitters for Chunky.

Available splitter libraries
-----------------------------
LangChainSplitter  — backed by langchain-text-splitters (token, recursive, character, markdown)
ChonkieSplitter    — backed by Chonkie (token, recursive, character, markdown)

Both libraries expose the same four splitting strategies via the
:class:`~backend.models.schemas.SplitterType` enum. Choose the library via
:class:`~backend.models.schemas.SplitterLibrary`.
"""

from .base import TextSplitter
from .chonkie_splitter import ChonkieSplitter
from .langchain_splitter import LangChainSplitter

__all__ = [
    "TextSplitter",
    "LangChainSplitter",
    "ChonkieSplitter",
]