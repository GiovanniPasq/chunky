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

# TODO (PERF): Token-based chunkers (TokenChunker, FastChunker, etc.) are
# pure-Python and hold the GIL, so concurrent requests via ThreadPoolExecutor
# serialise on the GIL.  SemanticChunker / NeuralChunker use PyTorch — the
# C/CUDA kernels release the GIL but Python orchestration does not, so
# parallelism is partial.  If profiling under 3+ simultaneous chunking
# requests confirms GIL contention as a bottleneck, switch the pure-Python
# strategies to a ProcessPoolExecutor in chunks_router.py.  ML-backed
# strategies may benefit from a dedicated worker process with the model
# pre-loaded to amortise initialisation cost.

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

Notes
-----
- RecursiveChunker does NOT accept chunk_overlap. This is a Chonkie API
  constraint; use OverlapRefinery post-processing if overlap is required.
- SemanticChunker and NeuralChunker download ML models on first use.
  They may be slow to initialise.
"""

from __future__ import annotations

from typing import Callable, Dict, List

from fastapi import HTTPException

from backend.models.schemas import ChunkItem, ChunkRequest, SplitterType
from backend.registry import register_splitter
from .base import TextSplitter

_LIB = "chonkie"
_LIB_LABEL = "Chonkie"


class ChonkieSplitter(TextSplitter):
    """Text splitter delegating to the Chonkie library.

    Chunkers are instantiated fresh per request so that chunk_size and
    chunk_overlap are always respected without stale state.
    """

    def split(self, request: ChunkRequest) -> List[ChunkItem]:
        handler = self._DISPATCH.get(request.splitter_type)
        if handler is None:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"ChonkieSplitter does not support "
                    f"splitter_type='{request.splitter_type}'"
                ),
            )
        return handler(self, request)

    # ------------------------------------------------------------------
    # Strategies
    # ------------------------------------------------------------------

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="token", label="Token",
        description="Splits on token boundaries. Fast, no external tokeniser needed.",
    )
    def _split_token(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import TokenChunker

        # tokenizer='gpt2' uses tiktoken's GPT-2 BPE encoding, making
        # chunk_size and chunk_overlap consistent with LangChain's
        # TokenTextSplitter (which also defaults to gpt2 via tiktoken).
        # The default tokenizer='character' would count characters instead,
        # producing ~4× smaller chunks than the label "tokens" implies.
        chunker = TokenChunker(
            tokenizer="gpt2",
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="fast", label="Fast",
        description=(
            "SIMD-accelerated byte-based chunking at 100+ GB/s. "
            "Best for high-throughput pipelines where byte-size limits are acceptable."
        ),
    )
    def _split_fast(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import FastChunker

        # FastChunker does not support chunk_overlap.
        chunker = FastChunker(
            chunk_size=request.chunk_size,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="sentence", label="Sentence",
        description="Splits at sentence boundaries. Preserves semantic completeness.",
    )
    def _split_sentence(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import SentenceChunker

        chunker = SentenceChunker(
            chunk_size=request.chunk_size,
            chunk_overlap=request.chunk_overlap,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="recursive", label="Recursive",
        description=(
            "Recursively splits using structural delimiters (paragraphs → sentences → words). "
            "Best for long, well-structured documents. "
            "Note: chunk_overlap is not supported by Chonkie's RecursiveChunker."
        ),
    )
    def _split_recursive(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import RecursiveChunker

        # chunk_overlap intentionally omitted — not a supported parameter.
        # See: https://docs.chonkie.ai/oss/chunkers/recursive-chunker
        chunker = RecursiveChunker(
            chunk_size=request.chunk_size,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="table", label="Table",
        description=(
            "Splits large Markdown tables by row while preserving headers. "
            "Ideal for tabular data in RAG pipelines."
        ),
    )
    def _split_table(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import TableChunker

        # TableChunker.chunk_size is in *rows* (default=3), not characters or
        # tokens.  Passing request.chunk_size (e.g. 512) would mean 512 rows
        # per chunk — effectively never splitting any real table.  Use the
        # library default so tables are split at sensible row boundaries.
        chunker = TableChunker()
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="code", label="Code",
        description=(
            "Splits source code using AST-based structural analysis. "
            "Ideal for chunking code files across multiple languages."
        ),
    )
    def _split_code(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import CodeChunker

        # CodeChunker splits on AST node boundaries; chunk_overlap is not
        # a supported parameter (structural splits don't allow arbitrary overlap).
        chunker = CodeChunker(
            chunk_size=request.chunk_size,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="semantic", label="Semantic",
        description=(
            "Groups content by embedding similarity. "
            "Best for preserving topical coherence. "
        ),
    )
    def _split_semantic(self, request: ChunkRequest) -> List[ChunkItem]:
        from chonkie import SemanticChunker

        # Uses a lightweight default model. Can be overridden by subclassing
        # or by wiring embedding_model through ChunkRequest if needed.
        chunker = SemanticChunker(
            embedding_model="minishlab/potion-base-32M",
            chunk_size=request.chunk_size,
            threshold=0.5,
        )
        return self._chunks_from_chonkie(chunker, request.content)

    @register_splitter(
        library=_LIB, library_label=_LIB_LABEL,
        strategy="neural", label="Neural",
        description=(
            "Uses a fine-tuned BERT model to detect semantic shifts. "
            "Great for topic-coherent chunks. "
        ),
    )
    def _split_neural(self, request: ChunkRequest) -> List[ChunkItem]:
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
    def _chunks_from_chonkie(chunker, content: str) -> List[ChunkItem]:
        """Convert Chonkie Chunk objects to ChunkItem."""
        raw_chunks = chunker.chunk(content)
        items: List[ChunkItem] = []
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

    _DISPATCH: Dict[SplitterType, Callable[[ChonkieSplitter, ChunkRequest], List[ChunkItem]]] = {
        SplitterType.token: _split_token,
        SplitterType.fast: _split_fast,
        SplitterType.sentence: _split_sentence,
        SplitterType.recursive: _split_recursive,
        SplitterType.table: _split_table,
        SplitterType.code: _split_code,
        SplitterType.semantic: _split_semantic,
        SplitterType.neural: _split_neural,
    }