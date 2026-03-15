"""
PDF-to-Markdown converter using MiniMax Vision Models.

MiniMax provides high-performance multimodal models with a 204,800 token
context window.  This converter wraps the VLM converter with MiniMax-specific
defaults so that users only need to set the ``MINIMAX_API_KEY`` environment
variable to get started.
"""

from __future__ import annotations

import os
from typing import Callable, Optional

from backend.registry import register_converter
from .vlm import VLMConverter


@register_converter(
    name="minimax",
    label="MiniMax",
    description=(
        "MiniMax vision models with 204K context window. "
        "Requires MINIMAX_API_KEY env var or api_key parameter."
    ),
)
class MinimaxConverter(VLMConverter):
    """PDF-to-Markdown converter using MiniMax vision models.

    Inherits all rendering and transcription logic from
    :class:`~backend.converters.vlm.VLMConverter`, but defaults to the MiniMax
    API endpoint (``https://api.minimax.io/v1``) and the ``MiniMax-M2.5``
    model.

    Available models::

        MiniMax-M2.5           – standard, 204K context window
        MiniMax-M2.5-highspeed – faster variant, same context window

    Install::

        pip install openai pymupdf
        export MINIMAX_API_KEY="your-key-here"

    Usage::

        converter = MinimaxConverter()                          # env key
        converter = MinimaxConverter(api_key="sk-...")           # explicit
        converter = MinimaxConverter(model="MiniMax-M2.5-highspeed")
    """

    def __init__(
        self,
        model: str = "MiniMax-M2.5",
        base_url: str = "https://api.minimax.io/v1",
        api_key: Optional[str] = None,
        on_progress: Optional[Callable[[int, int], None]] = None,
    ) -> None:
        """Initialise the MiniMax converter.

        Args:
            model:       MiniMax model identifier
                         (default ``MiniMax-M2.5``).
            base_url:    MiniMax API endpoint
                         (default ``https://api.minimax.io/v1``).
            api_key:     API key.  Falls back to the ``MINIMAX_API_KEY``
                         environment variable when *None*.
            on_progress: Optional callback with ``(current_page, total_pages)``.
        """
        if api_key is None:
            api_key = os.environ.get("MINIMAX_API_KEY", "")
        if not api_key:
            raise ValueError(
                "MiniMax API key not found. Set the MINIMAX_API_KEY environment "
                "variable or pass api_key to the converter."
            )
        super().__init__(
            model=model,
            base_url=base_url,
            api_key=api_key,
            on_progress=on_progress,
        )
