"""
Enrichment service — LLM-powered markdown and chunk enrichment.

Uses AsyncOpenAI so callers can await methods directly in the event loop
without asyncio.to_thread, enabling proper task cancellation and connection
pool reuse via the shared httpx.AsyncClient from app.state.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Retry config
# ---------------------------------------------------------------------------

_MAX_RETRY_ATTEMPTS = 3
_RETRY_BASE_DELAY_S = 1.0  # seconds; doubles each attempt (1 s, 2 s, 4 s)

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

_MARKDOWN_SYSTEM = (
    "You are a markdown document quality specialist. Your task is to improve "
    "markdown documents that were converted from PDFs. Correct conversion "
    "artifacts, fix broken formatting, remove duplicate or garbled content, "
    "and improve readability while strictly preserving all original information. "
    "Return ONLY the corrected markdown — no commentary, no code fences."
)

_CHUNK_SYSTEM = (
    "You are a document analysis specialist. Analyze the provided text chunk "
    "and return a JSON object with EXACTLY these fields: "
    '"cleaned_chunk" (cleaned normalized text), '
    '"title" (short descriptive title), '
    '"context" (one sentence describing the surrounding document context), '
    '"summary" (one sentence summary), '
    '"keywords" (array of keyword strings), '
    '"questions" (array of questions this chunk could answer). '
    "Return ONLY valid JSON — no commentary, no code fences."
)


class EnrichmentService:
    """Async LLM-powered enrichment service using any OpenAI-compatible endpoint.

    The underlying HTTP transport is shared across requests via the
    ``http_client`` parameter.  Pass ``app.state.http_client_async`` so all
    requests reuse one connection pool instead of creating a new one per call.

    Provider examples::

        # Ollama (default)
        svc = EnrichmentService(model="llama3.2", http_client=shared_client)

        # OpenAI
        svc = EnrichmentService(
            model="gpt-4o",
            base_url="https://api.openai.com/v1",
            api_key="sk-...",
            http_client=shared_client,
        )
    """

    def __init__(
        self,
        model: str = "qwen3-vl:4b-instruct-q4_K_M",
        base_url: str = "http://localhost:11434/v1",
        api_key: str = "ollama",
        temperature: float = 0.3,
        user_prompt: Optional[str] = None,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        from openai import AsyncOpenAI

        self._model = model
        self._temperature = temperature
        self._user_prompt = user_prompt

        # If a shared client is provided its timeout settings apply.
        # Otherwise fall back to a conservative per-request timeout.
        client_kwargs: Dict[str, Any] = dict(base_url=base_url, api_key=api_key)
        if http_client is not None:
            client_kwargs["http_client"] = http_client
        else:
            client_kwargs["timeout"] = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=5.0)

        self._client = AsyncOpenAI(**client_kwargs)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _call_with_retry(self, coro_factory) -> Any:
        """Call ``coro_factory()`` up to _MAX_RETRY_ATTEMPTS times.

        Retries on ``APITimeoutError`` with exponential back-off.
        Raises the final exception when all attempts are exhausted.
        """
        from openai import APITimeoutError

        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRY_ATTEMPTS):
            try:
                return await coro_factory()
            except APITimeoutError as exc:
                last_exc = exc
                if attempt < _MAX_RETRY_ATTEMPTS - 1:
                    delay = _RETRY_BASE_DELAY_S * (2 ** attempt)
                    logger.warning(
                        "LLM call timed out (attempt %d/%d), retrying in %.0fs",
                        attempt + 1,
                        _MAX_RETRY_ATTEMPTS,
                        delay,
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        "LLM call timed out after %d attempts — marking as failed",
                        _MAX_RETRY_ATTEMPTS,
                    )
        raise last_exc or RuntimeError("All LLM retry attempts exhausted")

    async def _complete(self, messages: list) -> Any:
        """Call chat.completions.create with retry, returning the raw response."""
        def _factory():
            return self._client.chat.completions.create(
                model=self._model,
                temperature=self._temperature,
                messages=messages,
            )
        return await self._call_with_retry(_factory)

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def enrich_markdown(self, content: str) -> str:
        """Send markdown content to the LLM for cleanup and improvement.

        Args:
            content: Raw markdown text.

        Returns:
            Enriched markdown string.
        """
        system_content = self._user_prompt if self._user_prompt else _MARKDOWN_SYSTEM
        response = await self._complete([
            {"role": "system", "content": system_content},
            {"role": "user", "content": content},
        ])
        result = (response.choices[0].message.content or "").strip()
        result = re.sub(r"^```(?:markdown)?\n?", "", result)
        result = re.sub(r"\n?```$", "", result)
        return result.strip()

    async def enrich_chunk(self, content: str) -> Dict[str, Any]:
        """Enrich a single chunk and return a dict of enriched fields.

        Args:
            content: Raw chunk text.

        Returns:
            Dict with keys: cleaned_chunk, title, context, summary,
            keywords, questions.

        Notes:
            If the LLM returns invalid JSON the original content is preserved
            and all enrichment fields are returned as empty defaults rather
            than raising, so the chunk is never silently dropped from the batch.
        """
        system_content = self._user_prompt if self._user_prompt else _CHUNK_SYSTEM
        response = await self._complete([
            {"role": "system", "content": system_content},
            {"role": "user", "content": content},
        ])
        raw = (response.choices[0].message.content or "").strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw).strip()
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.error(
                "enrich_chunk: failed to parse LLM JSON response — %s. Raw: %.200s. "
                "Returning original content with empty enrichment fields.",
                exc,
                raw,
            )
            return {
                "cleaned_chunk": content,
                "title": "",
                "context": "",
                "summary": "",
                "keywords": [],
                "questions": [],
            }
