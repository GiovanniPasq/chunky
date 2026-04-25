"""
Central capability registry for chunkers and converters.

Usage
-----
Decorate each chunker method with @register_chunker and each converter
class with @register_converter. The registry then exposes get_capabilities()
which is served by the /api/capabilities endpoint — no frontend changes
needed when new strategies or libraries are added.

Example
-------
    @register_chunker(library="langchain", library_label="LangChain", strategy="token", label="Token")
    def _split_token(self, request): ...

    @register_converter(name="pymupdf", label="PyMuPDF", description="Fast, lightweight")
    class PyMuPDFConverter(PDFConverter): ...
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class ChunkerStrategyMeta:
    strategy: str          # enum value, e.g. "token"
    label: str             # human-readable, e.g. "Token"
    description: str = ""


@dataclass
class ChunkerLibraryMeta:
    library: str           # enum value, e.g. "langchain"
    label: str             # human-readable, e.g. "LangChain"
    strategies: list[ChunkerStrategyMeta] = field(default_factory=list)


@dataclass
class ConverterMeta:
    name: str              # enum value, e.g. "pymupdf"
    label: str             # human-readable, e.g. "PyMuPDF"
    description: str = ""


# ---------------------------------------------------------------------------
# Registry singleton
# ---------------------------------------------------------------------------


class _CapabilityRegistry:
    """Singleton that accumulates registered chunkers and converters."""

    def __init__(self) -> None:
        # library_key → ChunkerLibraryMeta
        self._chunkers: dict[str, ChunkerLibraryMeta] = {}
        # converter_name → ConverterMeta
        self._converters: dict[str, ConverterMeta] = {}

    # ------------------------------------------------------------------
    # Registration API
    # ------------------------------------------------------------------

    def add_chunker_strategy(
        self,
        library: str,
        library_label: str,
        strategy: str,
        label: str,
        description: str = "",
    ) -> None:
        if library not in self._chunkers:
            self._chunkers[library] = ChunkerLibraryMeta(
                library=library, label=library_label
            )
        lib_meta = self._chunkers[library]
        # Avoid duplicates
        if not any(s.strategy == strategy for s in lib_meta.strategies):
            lib_meta.strategies.append(
                ChunkerStrategyMeta(strategy=strategy, label=label, description=description)
            )

    def add_converter(
        self,
        name: str,
        label: str,
        description: str = "",
    ) -> None:
        if name not in self._converters:
            self._converters[name] = ConverterMeta(
                name=name, label=label, description=description
            )

    # ------------------------------------------------------------------
    # Query API
    # ------------------------------------------------------------------

    def get_capabilities(self) -> dict[str, Any]:
        """Return the full capabilities dict served to the frontend."""
        return {
            "chunkers": [
                {
                    "library": lib.library,
                    "label": lib.label,
                    "strategies": [
                        {
                            "strategy": s.strategy,
                            "label": s.label,
                            "description": s.description,
                        }
                        for s in lib.strategies
                    ],
                }
                for lib in self._chunkers.values()
            ],
            "converters": [
                {
                    "name": c.name,
                    "label": c.label,
                    "description": c.description,
                }
                for c in self._converters.values()
            ],
        }


# Module-level singleton — import this everywhere.
registry = _CapabilityRegistry()


# ---------------------------------------------------------------------------
# Decorators
# ---------------------------------------------------------------------------


def register_chunker(
    library: str,
    library_label: str,
    strategy: str,
    label: str,
    description: str = "",
):
    """Decorator for chunker *methods* — registers the strategy on import.

    Apply to the individual strategy methods inside a TextChunker subclass::

        @register_chunker(
            library="langchain", library_label="LangChain",
            strategy="token", label="Token",
            description="Splits on token boundaries via tiktoken.",
        )
        def _split_token(self, request: ChunkRequest) -> List[ChunkItem]:
            ...
    """
    def decorator(fn):
        registry.add_chunker_strategy(
            library=library,
            library_label=library_label,
            strategy=strategy,
            label=label,
            description=description,
        )
        return fn
    return decorator


def register_converter(name: str, label: str, description: str = ""):
    """Class decorator for PDFConverter subclasses — registers on import.

    Apply to the converter class itself::

        @register_converter(
            name="pymupdf",
            label="PyMuPDF",
            description="Fast, lightweight. Best for standard digital PDFs.",
        )
        class PyMuPDFConverter(PDFConverter):
            ...
    """
    def decorator(cls):
        registry.add_converter(name=name, label=label, description=description)
        return cls
    return decorator
