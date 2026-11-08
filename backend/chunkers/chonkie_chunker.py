"""
Text splitters backed by Chonkie.

Implements all chunkers available in chonkie[all] + optional extras.
Each strategy is lazily imported so missing optional dependencies only
raise at call time, not at module import time.

Install
-------
    pip install chonkie[semantic]    # + SemanticChunker
    pip install chonkie[neural]      # + NeuralChunker
    pip install "chonkie[code]"      # + CodeChunker (tree-sitter; requires Rust toolchain for installation)

Supported strategies (SplitterType enum values)
------------------------------------------------
    token     → TokenChunker
    fast      → FastChunker          (SIMD-accelerated byte-based)
    sentence  → SentenceChunker      (sentence-boundary split)
    recursive → RecursiveChunker     (delimiter-based recursive split; no chunk_overlap)
    table     → TableChunker         (markdown table rows)
    code      → CodeChunker          (AST-based code split)
    semantic  → SemanticChunker      (embedding similarity; requires chonkie[semantic])
    neural    → NeuralChunker        (fine-tuned BERT; requires chonkie[neural])
"""

from __future__ import annotations

from typing import Callable

from fastapi import HTTPException

from backend.models.schemas import ChunkItem, ChunkRequest, ChunkerType
from backend.registry import register_chunker
from .base import TextChunker
from .source_windows import fast_windows, token_windows
from .tables import table_chunks

_LIB = "chonkie"
_LIB_LABEL = "Chonkie"


class ChonkieChunker(TextChunker):
    """Text splitter delegating to the Chonkie library.

    Chunkers are instantiated fresh per request so that chunk_size and
    chunk_overlap are always respected without stale state.
    """

    def chunk(self, request: ChunkRequest) -> list[ChunkItem]:
        handler = self._DISPATCH.get(request.chunker_type)
        if handler is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"ChonkieChunker does not support "
                    f"chunker_type='{request.chunker_type}'"
                ),
            )
        try:
            return handler(self, request)
        except ImportError as exc:
            extras = {
                ChunkerType.code: 'code',
                ChunkerType.semantic: 'semantic',
                ChunkerType.neural: 'neural',
            }.get(request.chunker_type)
            if extras is None:
                raise
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{request.chunker_type.value.title()} chunking requires optional dependencies. "
                    f"Install 'chonkie[{extras}]' in the backend environment."
                ),
            ) from exc

    # ------------------------------------------------------------------
    # Strategies
    # ------------------------------------------------------------------

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="token", label="Token",
        description="GPT-2 token windows with Unicode-safe boundaries. Overlap may be smaller to keep characters intact.",
    )
    def _split_token(self, request: ChunkRequest) -> list[ChunkItem]:
        return token_windows(request.content, request.chunk_size, request.chunk_overlap)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="fast", label="Fast",
        description=(
            "SIMD-accelerated byte-based chunking. chunk_size is a byte target; "
            "chunk_overlap is not supported. UTF-8 boundaries may add up to 3 bytes to the target."
        ),
    )
    def _split_fast(self, request: ChunkRequest) -> list[ChunkItem]:
        return fast_windows(request.content, request.chunk_size)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="sentence", label="Sentence",
        description="Uses a character target while preserving whole sentences. Long sentences may exceed the target; overlap includes only whole sentences that fit.",
    )
    def _split_sentence(self, request: ChunkRequest) -> list[ChunkItem]:
        from chonkie import SentenceChunker

        chunker = SentenceChunker(
            tokenizer="character",
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="recursive", label="Recursive",
        description=(
            "Recursively splits using structural delimiters (paragraphs → sentences → words). "
            "Best for long, well-structured documents. "
            "Note: chunk_overlap is not supported by Chonkie's RecursiveChunker."
        ),
    )
    def _split_recursive(self, request: ChunkRequest) -> list[ChunkItem]:
        from chonkie import RecursiveChunker

        # chunk_overlap intentionally omitted — not a supported parameter.
        # See: https://docs.chonkie.ai/oss/chunkers/recursive-chunker
        chunker = RecursiveChunker(
            tokenizer="character",
            chunk_size=request.chunk_size,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="table", label="Table",
        description=(
            "Splits Markdown tables into groups of 3 data rows, repeats headers, and preserves surrounding prose. "
            "chunk_size and chunk_overlap are not used."
        ),
    )
    def _split_table(self, request: ChunkRequest) -> list[ChunkItem]:
        if request.content.lstrip().lower().startswith('<table'):
            from chonkie import TableChunker

            return self._chunks_from_chonkie(TableChunker(), request.content, map_source=True)
        return table_chunks(request.content)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="code", label="Code",
        description=(
            "Splits source code using AST-based structural analysis and chunk_size. "
            "chunk_overlap is not supported. Requires optional chonkie[code] dependencies."
        ),
    )
    def _split_code(self, request: ChunkRequest) -> list[ChunkItem]:
        from chonkie import CodeChunker

        # CodeChunker splits on AST node boundaries; chunk_overlap is not
        # a supported parameter (structural splits don't allow arbitrary overlap).
        chunker = CodeChunker(
            tokenizer="character",
            chunk_size=request.chunk_size,
        )
        # Tree-sitter's node coordinates are UTF-8 byte offsets. Remap the
        # returned text to character positions, as the application API expects.
        return self._chunks_from_chonkie(chunker, request.content, map_source=True)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="semantic", label="Semantic",
        description=(
            "Groups content by embedding similarity using the embedding model's token count as a target. Long sentences may exceed it. "
            "chunk_overlap is not supported."
        ),
    )
    def _split_semantic(self, request: ChunkRequest) -> list[ChunkItem]:
        from chonkie import SemanticChunker

        # Uses a lightweight default model. Can be overridden by subclassing
        # or by wiring embedding_model through ChunkRequest if needed.
        chunker = SemanticChunker(
            embedding_model="minishlab/potion-base-32M",
            chunk_size=request.chunk_size,
            threshold=0.5,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_chunker(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="neural", label="Neural",
        description=(
            "Uses a fine-tuned BERT model to detect semantic shifts. "
            "chunk_size and chunk_overlap are not used."
        ),
    )
    def _split_neural(self, request: ChunkRequest) -> list[ChunkItem]:
        from chonkie import NeuralChunker

        # NeuralChunker uses a fine-tuned BERT model to detect semantic shift
        # points; chunk boundaries are model-driven, so chunk_size and
        # chunk_overlap are not supported parameters.
        chunker = NeuralChunker(
            model="mirth/chonky_modernbert_base_1",
            device_map="cpu",
        )
        return self._chunks_from_chonkie(chunker, request.content)

    # ------------------------------------------------------------------
    # Shared helper
    # ------------------------------------------------------------------

    @staticmethod
    def _chunks_from_chonkie(chunker, content: str, *, map_source: bool = False) -> list[ChunkItem]:
        """Convert Chonkie Chunk objects to ChunkItem."""
        raw_chunks = chunker.chunk(content)
        if map_source:
            items = TextChunker.build_chunks(content, [chunk.text for chunk in raw_chunks], char_overlap=0)
            for item, raw in zip(items, raw_chunks):
                item.metadata['token_count'] = getattr(raw, 'token_count', None)
            return items
        items: list[ChunkItem] = []
        for i, chunk in enumerate(raw_chunks):
            start = getattr(chunk, "start_index", 0)
            end = getattr(chunk, "end_index", start + len(chunk.text))
            items.append(
                ChunkItem(
                    index=i,
                    content=chunk.text,
                    metadata={"token_count": getattr(chunk, "token_count", None)},
                    start=start,
                    end=end,
                )
            )
        return items

    # ------------------------------------------------------------------
    # Dispatch table
    # ------------------------------------------------------------------

    _DISPATCH: dict[ChunkerType, Callable[[ChonkieChunker, ChunkRequest], list[ChunkItem]]] = {
        ChunkerType.token: _split_token,
        ChunkerType.fast: _split_fast,
        ChunkerType.sentence: _split_sentence,
        ChunkerType.recursive: _split_recursive,
        ChunkerType.table: _split_table,
        ChunkerType.code: _split_code,
        ChunkerType.semantic: _split_semantic,
        ChunkerType.neural: _split_neural,
    }
