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
from typing import Any, Callable

import httpx

from backend.utils.retry import async_retry_with_backoff

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# JSON repair helpers
# ---------------------------------------------------------------------------

def _repair_truncated_json(raw: str) -> dict | None:
    """Return the last complete JSON object found in *raw*, or None.

    Walks the string once tracking string/escape/brace state to find the
    position of the closing brace that brings the outermost object back to
    depth 0, then attempts to parse everything up to that point.  Handles
    the most common truncation pattern: the model is cut off mid-value
    (string, array, or nested object) but an earlier version of the object
    was already fully closed.
    """
    in_string = False
    escaped = False
    depth = 0
    last_close = -1

    for i, ch in enumerate(raw):
        if escaped:
            escaped = False
            continue
        if ch == "\\" and in_string:
            escaped = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                last_close = i + 1

    if last_close <= 0:
        return None
    try:
        return json.loads(raw[:last_close])
    except json.JSONDecodeError:
        return None


def _extract_fields_regex(raw: str, original_content: str) -> dict | None:
    """Extract individual fields from a truncated JSON string via regex.

    Only fields whose value is fully present in *raw* are extracted; the
    rest fall back to safe empty defaults so the chunk is never dropped.
    Returns None if nothing useful was found.
    """
    result: dict = {
        "cleaned_chunk": original_content,
        "title": "",
        "context": "",
        "summary": "",
        "keywords": [],
        "questions": [],
    }
    found_any = False

    for field in ("cleaned_chunk", "title", "context", "summary"):
        m = re.search(
            rf'"{re.escape(field)}"\s*:\s*"((?:[^"\\]|\\.)*)"',
            raw,
            re.DOTALL,
        )
        if m:
            try:
                result[field] = json.loads(f'"{m.group(1)}"')
            except (json.JSONDecodeError, ValueError):
                result[field] = m.group(1)
            found_any = True

    for field in ("keywords", "questions"):
        m = re.search(
            rf'"{re.escape(field)}"\s*:\s*(\[.*?\])',
            raw,
            re.DOTALL,
        )
        if m:
            try:
                result[field] = json.loads(m.group(1))
                found_any = True
            except (json.JSONDecodeError, ValueError):
                pass

    return result if found_any else None


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
        model: str = "",
        base_url: str = "",
        api_key: str = "",
        temperature: float | None = None,
        user_prompt: str | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        from openai import AsyncOpenAI
        from backend.config import get_settings as _get_settings
        _s = _get_settings()

        self._model = model or _s.ENRICHMENT_DEFAULT_MODEL
        self._temperature = temperature if temperature is not None else _s.ENRICHMENT_DEFAULT_TEMPERATURE
        self._user_prompt = user_prompt
        self._max_retry_attempts = _s.HTTP_MAX_RETRY_ATTEMPTS
        self._retry_base_delay_s = _s.HTTP_RETRY_BASE_DELAY_S

        client_kwargs: dict[str, Any] = dict(
            base_url=base_url or _s.ENRICHMENT_DEFAULT_BASE_URL,
            api_key=api_key or _s.ENRICHMENT_DEFAULT_API_KEY,
        )
        if http_client is not None:
            client_kwargs["http_client"] = http_client
        else:
            client_kwargs["timeout"] = httpx.Timeout(
                connect=_s.HTTP_CONNECT_TIMEOUT_S,
                read=_s.ENRICH_READ_TIMEOUT_S,
                write=_s.ENRICH_WRITE_TIMEOUT_S,
                pool=_s.HTTP_POOL_TIMEOUT_S,
            )

        self._client = AsyncOpenAI(**client_kwargs)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _is_retryable(self, exc: Exception) -> bool:
        from openai import APIConnectionError, APIStatusError, APITimeoutError
        if isinstance(exc, (APITimeoutError, APIConnectionError)):
            return True
        if isinstance(exc, APIStatusError):
            return exc.status_code >= 500 or exc.status_code == 429
        return False

    async def _call_with_retry(self, coro_factory: Callable[[], Any]) -> Any:
        """Call ``coro_factory()`` up to HTTP_MAX_RETRY_ATTEMPTS times with exponential back-off."""
        return await async_retry_with_backoff(
            coro_factory,
            is_retryable=self._is_retryable,
            max_attempts=self._max_retry_attempts,
            base_delay_s=self._retry_base_delay_s,
            logger=logger,
            context={"model": self._model, "base_url": str(self._client.base_url)},
            operation="LLM call",
        )

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
        if not response.choices:
            raise ValueError("LLM returned an empty choices list — no content to extract")
        result = (response.choices[0].message.content or "").strip()
        result = re.sub(r"^```(?:markdown)?\n?", "", result)
        result = re.sub(r"\n?```$", "", result)
        return result.strip()

    async def enrich_chunk(self, content: str) -> dict[str, Any]:
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
        if not response.choices:
            raise ValueError("LLM returned an empty choices list — no content to extract")
        raw = (response.choices[0].message.content or "").strip()
        raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.IGNORECASE)
        raw = re.sub(r"\s*```$", "", raw).strip()

        # Attempt 1: parse the response as-is.
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning(
                "enrich_chunk: JSON parse failed (%s) — attempting repair. Raw: %.120s",
                exc,
                raw,
            )

        # Attempt 2: find the last fully-closed JSON object in the response.
        # Handles the common case where the model is cut off mid-field but an
        # earlier, complete version of the object exists in the stream.
        repaired = _repair_truncated_json(raw)
        if repaired is not None:
            logger.warning("enrich_chunk: recovered via truncation repair.")
            return repaired

        # Attempt 3: extract whichever individual fields completed before cut-off.
        extracted = _extract_fields_regex(raw, content)
        if extracted is not None:
            logger.warning("enrich_chunk: recovered partial fields via regex extraction.")
            return extracted

        # Final fallback: nothing could be salvaged — raise so the caller emits chunk_error.
        logger.error(
            "enrich_chunk: could not recover JSON — aborting chunk. Raw: %.200s",
            raw,
        )
        raise ValueError("LLM returned unparseable JSON after all recovery attempts")
