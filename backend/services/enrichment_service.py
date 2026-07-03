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
from typing import TYPE_CHECKING, Any, Callable

import httpx

from backend.utils.retry import async_retry_with_backoff

if TYPE_CHECKING:
    from .document_summary import DocumentSummary, PieceExtraction
    from .chunk_context import ChunkSurroundingContext

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

# ---------------------------------------------------------------------------
# Conservative prompts for the per-piece pipeline
# ---------------------------------------------------------------------------
# Used by ``enrich_piece`` (called from the pipeline orchestrator).  The
# language is deliberately heavy-handed about NOT rewriting: the cleanup
# regex stage upstream has already fixed the easy artifacts, so anything
# remaining is either a hard problem (OCR, fragmented sentences) or
# already-correct prose the LLM should leave alone.  Over-correction is
# the bigger risk than under-correction at this point in the pipeline.
#
# Two variants because the user message can arrive with or without a
# ``<<<DOCUMENT SUMMARY>>>`` block:
#
#   ``_PIECE_SYSTEM``               — no summary attached; the prompt
#                                     never references one (mentioning a
#                                     non-existent block tends to make
#                                     the model invent context).
#   ``_PIECE_SYSTEM_WITH_SUMMARY``  — same conservative repair rules plus
#                                     a clause telling the model how to
#                                     use the DOCUMENT SUMMARY block.
#
# Both versions feed the per-piece cache key, so a run that toggles
# ``use_summary`` cleanly invalidates the old cache (the prompts
# differ).
_PIECE_SYSTEM_BASE = (
    "You repair markdown that was converted from a PDF. You are conservative: "
    "if the text already reads cleanly, return it byte-for-byte unchanged. "
    "Only fix obvious conversion artifacts:\n"
    "  - OCR errors that produce nonsensical character sequences\n"
    "  - Sentences fragmented across line breaks mid-word or mid-clause\n"
    "  - Misordered fragments from multi-column layout\n"
    "  - Broken markdown syntax (unclosed tables, malformed lists)\n"
    "\nNEVER:\n"
    "  - Rephrase, summarise, or expand correct content\n"
    "  - Fix grammar, style, or capitalization choices in the source\n"
    "  - Add information not present in the source\n"
    "  - Remove information present in the source (including unusual "
    "formatting, dates, numbers, names)\n"
    "  - Change heading levels, code blocks, or table structure\n"
    "  - Translate or modernise the language\n"
    "\nIf unsure whether something is an error or intentional, LEAVE IT "
    "UNCHANGED. Under-correction is preferred over over-correction.\n"
)

_PIECE_SYSTEM_OUTPUT_FOOTER = (
    "\nReturn ONLY the corrected markdown of the SECTION provided. Do not "
    "include the preceding context in your output. No commentary. No code "
    "fences around the result."
)

_PIECE_SYSTEM_SUMMARY_CLAUSE = (
    "\nYou may use the DOCUMENT SUMMARY block to disambiguate terms or "
    "proper nouns, but NEVER use it to add information that is not "
    "already present in the SECTION.\n"
)

_PIECE_SYSTEM = _PIECE_SYSTEM_BASE + _PIECE_SYSTEM_OUTPUT_FOOTER
_PIECE_SYSTEM_WITH_SUMMARY = (
    _PIECE_SYSTEM_BASE + _PIECE_SYSTEM_SUMMARY_CLAUSE + _PIECE_SYSTEM_OUTPUT_FOOTER
)


# ---------------------------------------------------------------------------
# Document-summary prompts (used by the map-reduce summary builder)
# ---------------------------------------------------------------------------

_PIECE_EXTRACT_SYSTEM = (
    "You extract a compact reference for a section of a longer document. "
    "Return ONLY valid JSON with EXACTLY these two fields:\n"
    '  "topic_hints":  array of short phrases describing what this section is about\n'
    '  "narrative":    one-sentence summary of what this section covers\n'
    "\nReturn an empty array / empty string when a field has nothing to "
    "report — never invent content.  No commentary.  No code fences."
)

_REDUCE_SYSTEM = (
    "You synthesise a document-level summary from per-section extractions. "
    "Return ONLY valid JSON with EXACTLY these two fields:\n"
    '  "topic":      one short phrase capturing what the whole document is about\n'
    '  "narrative":  a single coherent paragraph (~200 words) summarising the '
    "document in source order.  Give equal weight to early and late sections — "
    "do not over-index on the final pieces.  No commentary.  No code fences."
)


# Boundary-whitespace matchers used by ``enrich_piece`` to keep piece joins
# byte-identical to the source.  Compiled once at import time.
_LEADING_WS_RE = re.compile(r"^\s*")
_TRAILING_WS_RE = re.compile(r"\s*$")


def _build_piece_user_message(
    piece_content: str,
    previous_context: str,
    document_summary_block: str = "",
) -> str:
    """Construct the user message for ``enrich_piece``.

    The previous-context block is rendered as a fenced quote so the model
    sees an unambiguous boundary between "context (read but don't return)"
    and "section to correct".  When there is no previous context (first
    piece), the context block is omitted entirely.

    When ``document_summary_block`` is non-empty it is prepended in its
    own fenced section so the model can use the document-level context to
    disambiguate terms and proper nouns without confusing it for content
    to repeat.
    """
    parts: list[str] = []
    if document_summary_block:
        parts.append(
            "<<<DOCUMENT SUMMARY — for context only, do not include in your output>>>\n"
            f"{document_summary_block}\n"
            "<<<END DOCUMENT SUMMARY>>>"
        )
    if previous_context:
        parts.append(
            "<<<PREVIOUS CONTEXT — for reference only, do not include in your output>>>\n"
            f"{previous_context}\n"
            "<<<END PREVIOUS CONTEXT>>>"
        )
    parts.append(
        "<<<SECTION TO CORRECT>>>\n"
        f"{piece_content}\n"
        "<<<END SECTION TO CORRECT>>>"
    )
    return "\n\n".join(parts)

_CHUNK_SYSTEM = (
    "You are a document analysis specialist. Analyze only the provided chunk "
    "and return one JSON object with EXACTLY these fields: "
    '"cleaned_chunk" (conservatively cleaned and normalized chunk text; preserve facts, numbers, names, and meaning), '
    '"title" (short descriptive title for the chunk), '
    '"context" (one concise sentence explaining where this chunk fits in the broader document), '
    '"summary" (one sentence summary of the chunk content), '
    '"keywords" (array of relevant keyword strings, including important named entities, acronyms, products, methods, and domain terms), '
    '"questions" (array of realistic user questions answerable primarily from this chunk). '
    "If document-summary or surrounding-context blocks are provided, use them "
    "only to disambiguate the chunk and improve the context field. Do not copy "
    "neighboring text into the output, and do not invent information that is not "
    "supported by the chunk. Return ONLY valid JSON — no commentary, no code fences."
)

# Same task and JSON shape as ``_CHUNK_SYSTEM``, but with one extra
# clause explaining how to consume the ``<<<DOCUMENT SUMMARY>>>`` block
# the user message will prepend.  Used only when the chunks router was
# able to load a cached summary; falls back to the bare prompt
# otherwise so we don't dangle a reference to a block that isn't there.
_CHUNK_SYSTEM_WITH_SUMMARY = (
    _CHUNK_SYSTEM
    + "\n\nThe user message begins with a <<<DOCUMENT SUMMARY>>> block "
    "describing the document-level topic and narrative. Use it to "
    "disambiguate proper nouns and to write a more accurate ``context`` "
    "field — but never use it to invent information that is not present "
    "in the chunk."
)


def _build_chunk_user_message(
    content: str,
    *,
    document_summary_block: str = "",
    surrounding_context_block: str = "",
) -> str:
    parts: list[str] = []
    if document_summary_block:
        parts.append(
            "<<<DOCUMENT SUMMARY — for context only, do not include in your output>>>\n"
            f"{document_summary_block}\n"
            "<<<END DOCUMENT SUMMARY>>>"
        )
    if surrounding_context_block:
        parts.append(
            "<<<SURROUNDING CONTEXT — for context only, do not include in your output>>>\n"
            f"{surrounding_context_block}\n"
            "<<<END SURROUNDING CONTEXT>>>"
        )
    parts.append(
        "<<<CHUNK TO ANALYSE>>>\n"
        f"{content}\n"
        "<<<END CHUNK TO ANALYSE>>>"
    )
    return "\n\n".join(parts)


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
    # Public accessors (used by the pipeline orchestrator for cache keys)
    # ------------------------------------------------------------------

    @property
    def model_name(self) -> str:
        """The OpenAI-compatible model identifier this service calls."""
        return self._model

    @property
    def user_prompt(self) -> str | None:
        """The user-supplied override for the built-in system prompt, if any."""
        return self._user_prompt

    @property
    def temperature(self) -> float:
        """The sampling temperature used for every LLM call."""
        return self._temperature

    @property
    def base_url(self) -> str:
        """Normalized LLM base URL used to scope persisted results."""
        return str(self._client.base_url).rstrip("/")

    def effective_chunk_system_prompt(self, *, with_summary: bool) -> str:
        """Return the system prompt that ``enrich_chunk`` will use for
        the given ``with_summary`` flag.  Same precedence rules as the
        piece-level helper: a user-supplied override wins; otherwise
        we pick between the bare and summary-aware default prompts.
        """
        if self._user_prompt:
            return self._user_prompt
        return _CHUNK_SYSTEM_WITH_SUMMARY if with_summary else _CHUNK_SYSTEM

    def effective_piece_system_prompt(self, *, with_summary: bool) -> str:
        """Return the system prompt that ``enrich_piece`` will actually
        send for the given ``with_summary`` flag.

        Surfaced as a method (rather than computed inline) so the
        pipeline can mix the very same string into the per-piece cache
        key — guaranteeing that toggling ``use_summary`` produces a
        different hash and therefore a clean cache miss rather than a
        stale reuse.

        Precedence:
            1. A user-supplied override (Settings → user_prompt) wins
               unconditionally.  The override is the user's
               responsibility; we do not splice the summary clause into
               it because we cannot know whether they want it.
            2. Otherwise return ``_PIECE_SYSTEM_WITH_SUMMARY`` when a
               summary is attached, ``_PIECE_SYSTEM`` when not.
        """
        if self._user_prompt:
            return self._user_prompt
        return _PIECE_SYSTEM_WITH_SUMMARY if with_summary else _PIECE_SYSTEM

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

    async def _complete(self, messages: list, *, temperature: float | None = None) -> Any:
        """Call chat.completions.create with retry, returning the raw response.

        ``temperature`` overrides the instance default for this single call.
        Used by the summary methods to pin temperature to a lower value
        than the user-configured correction temperature, since reference
        summaries benefit from less stochastic output.
        """
        effective_temp = self._temperature if temperature is None else temperature
        def _factory():
            return self._client.chat.completions.create(
                model=self._model,
                temperature=effective_temp,
                messages=messages,
            )
        return await self._call_with_retry(_factory)

    @property
    def _summary_temperature(self) -> float:
        """Temperature used for summary extraction and reduce calls.

        Caps the user-configured value at 0.2 so summaries stay roughly
        deterministic regardless of how creative the user wants the
        per-piece corrections to be.
        """
        return min(self._temperature, 0.2)

    @staticmethod
    def _parse_strict_json(raw: str) -> dict | None:
        """Best-effort JSON parse with the same recovery ladder used by
        ``enrich_chunk``.  Returns ``None`` when nothing salvageable was
        found — caller falls back to its own degraded path.
        """
        cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip(), flags=re.IGNORECASE)
        cleaned = re.sub(r"\s*```$", "", cleaned).strip()
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError:
            pass
        repaired = _repair_truncated_json(cleaned)
        if repaired is not None:
            return repaired
        return None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def enrich_piece(
        self,
        piece_content: str,
        previous_context: str = "",
        document_summary: "DocumentSummary | None" = None,
    ) -> str:
        """Correct a single pipeline-produced markdown piece.

        Used by the pipeline orchestrator (``enrichment_pipeline``).  The
        prompt enforces conservative behaviour — the model is told
        explicitly to return content byte-for-byte unchanged when it has
        no improvement to make.  Previous-piece context is sent as a
        reference but the model is instructed not to repeat it in the
        output.

        Args:
            piece_content:     The markdown segment to correct.
            previous_context:  Tail of the *original* preceding piece(s),
                               used to give the model situational
                               awareness.  Pass an empty string for the
                               first piece in a document.
            document_summary:  Optional pre-computed document-level summary
                               (see :mod:`document_summary`).  When
                               provided, its prompt block is prepended to
                               the user message so the model has access to
                               topic, key terms, and entities while
                               correcting the piece.  Has no effect when
                               ``None`` or empty.

        Returns:
            The corrected markdown for *this* piece only — never includes
            the previous-context preamble.  Code-fence wrappers some
            models add ("```markdown ... ```") are stripped before return.
        """
        # Whitespace-only input has nothing to correct.  Return it as-is
        # so callers outside the pipeline get the same fast-path behaviour
        # the pipeline applies before reaching this method.  Crucially
        # this also dodges the boundary-whitespace re-anchoring below,
        # which doubles content when leading and trailing matches both
        # cover the entire string.
        if not piece_content.strip():
            return piece_content

        # Honour a user-supplied prompt override, mirroring enrich_chunk.
        # The cache key in the pipeline hashes whichever system prompt is
        # actually sent, so changing this string from settings invalidates
        # the cache cleanly.
        #
        # When the user has supplied a custom system prompt we DO NOT
        # inject the document-summary block into the user message: the
        # user has taken responsibility for the prompt contract and may
        # not have prepared their prompt to handle a wrapped
        # ``<<<DOCUMENT SUMMARY>>> … <<<SECTION TO CORRECT>>>``
        # structure.  Silently changing the user-message shape under
        # them tends to make their custom prompt produce worse output
        # than the unwrapped contract they tested against.  The default
        # ``_PIECE_SYSTEM_WITH_SUMMARY`` path remains unaffected.
        summary_block = (
            document_summary.to_prompt_block()
            if document_summary is not None
                and not document_summary.is_empty()
                and not self._user_prompt
            else ""
        )
        system_content = self.effective_piece_system_prompt(with_summary=bool(summary_block))
        user_message = _build_piece_user_message(
            piece_content, previous_context, summary_block,
        )
        response = await self._complete([
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_message},
        ])
        if not response.choices:
            raise ValueError("LLM returned an empty choices list — no content to extract")

        result = response.choices[0].message.content or ""
        # Strip code-fence wrappers that some models add around the body.
        result = re.sub(r"^\s*```(?:markdown)?\n?", "", result)
        result = re.sub(r"\n?```\s*$", "", result)
        # Empty / whitespace-only model output would, after re-anchoring,
        # collapse the piece to just its boundary whitespace and silently
        # wipe its body.  Treat this as "no correction" and return the
        # original piece verbatim — same fall-back behaviour as a piece
        # the pipeline never sent to the LLM.
        if not result.strip():
            return piece_content
        # Re-anchor the boundary whitespace.  The structure-aware splitter
        # produced pieces that join byte-for-byte into the original source
        # — every piece's trailing whitespace is exactly what separates
        # it from the next piece (typically ``\n`` or ``\n\n``).  Most
        # models confidently strip leading/trailing whitespace from their
        # output, which would silently glue piece N's last line onto
        # piece N+1's first line in the reassembled document (e.g. a
        # heading concatenated onto the previous paragraph).  Restoring
        # the original piece's leading and trailing whitespace keeps the
        # join invariant intact regardless of what the model returns.
        leading = _LEADING_WS_RE.match(piece_content)
        trailing = _TRAILING_WS_RE.search(piece_content)
        return (
            (leading.group(0) if leading else "")
            + result.strip()
            + (trailing.group(0) if trailing else "")
        )

    async def extract_piece_summary(self, piece_content: str) -> "PieceExtraction":
        """Map step of the document-summary pipeline.

        Asks the model for structured reference information about a
        single piece.  Output is parsed defensively — a malformed or
        truncated response degrades to an empty extraction rather than
        raising, so one bad piece never aborts the whole map step.
        """
        from .document_summary import PieceExtraction  # local import: avoid cycles

        if not piece_content.strip():
            return PieceExtraction()

        user_message = (
            "<<<SECTION TO ANALYSE>>>\n"
            f"{piece_content}\n"
            "<<<END SECTION TO ANALYSE>>>\n\n"
            "Return ONE JSON object with EXACTLY the fields topic_hints "
            "and narrative.  Do not describe the section.  No commentary, "
            "preamble, or code fences.  Output JSON only."
        )
        response = await self._complete(
            [
                {"role": "system", "content": _PIECE_EXTRACT_SYSTEM},
                {"role": "user", "content": user_message},
            ],
            temperature=self._summary_temperature,
        )
        if not response.choices:
            raise ValueError("LLM returned an empty choices list — no extraction to parse")

        raw = response.choices[0].message.content or ""
        parsed = self._parse_strict_json(raw)
        if parsed is None:
            logger.warning(
                "extract_piece_summary: unparseable JSON, returning empty extraction. Raw: %.200s",
                raw,
            )
            return PieceExtraction()
        hints_raw = parsed.get("topic_hints", [])
        topic_hints = (
            [str(v).strip() for v in hints_raw if isinstance(v, (str, int, float)) and str(v).strip()]
            if isinstance(hints_raw, list) else []
        )
        return PieceExtraction(
            topic_hints=topic_hints,
            narrative=str(parsed.get("narrative", "")).strip(),
        )

    async def reduce_extractions(
        self,
        *,
        topic_hints: list[str],
        narratives: list[str],
    ) -> dict[str, str]:
        """Reduce step of the document-summary pipeline.

        Given the unioned per-piece topic hints and per-piece narratives
        (in source order), asks the model to pick a final ``topic`` and
        synthesise a single ~200-word ``narrative``.

        Returns a dict with exactly ``topic`` and ``narrative`` string
        fields (possibly empty on parse failure).
        """
        def _list_block(label: str, values: list[str], limit: int = 60) -> str:
            if not values:
                return ""
            shown = values[:limit]
            line = f"{label}: " + ", ".join(shown)
            if len(values) > limit:
                line += f" (+ {len(values) - limit} more)"
            return line

        narrative_block = ""
        if narratives:
            joined = "\n".join(f"- {n}" for n in narratives)
            narrative_block = f"PER-SECTION NARRATIVES (in source order):\n{joined}"

        sections = [
            _list_block("TOPIC HINTS", topic_hints, limit=30),
            narrative_block,
        ]
        user_message = "\n\n".join(s for s in sections if s)
        if not user_message:
            return {"topic": "", "narrative": ""}

        user_message += (
            "\n\nReturn ONE JSON object with EXACTLY the fields topic and "
            "narrative.  No commentary, no code fences.  Output JSON only."
        )

        response = await self._complete(
            [
                {"role": "system", "content": _REDUCE_SYSTEM},
                {"role": "user", "content": user_message},
            ],
            temperature=self._summary_temperature,
        )
        if not response.choices:
            raise ValueError("LLM returned an empty choices list — no reduce result to parse")

        raw = response.choices[0].message.content or ""
        parsed = self._parse_strict_json(raw)
        if parsed is None:
            logger.warning(
                "reduce_extractions: unparseable JSON, returning empty reduce. Raw: %.200s",
                raw,
            )
            return {"topic": "", "narrative": ""}
        return {
            "topic": str(parsed.get("topic", "")).strip(),
            "narrative": str(parsed.get("narrative", "")).strip(),
        }

    async def enrich_chunk(
        self,
        content: str,
        document_summary: "DocumentSummary | None" = None,
        surrounding_context: "ChunkSurroundingContext | None" = None,
    ) -> dict[str, Any]:
        """Enrich a single chunk and return a dict of enriched fields.

        Args:
            content:           Raw chunk text.
            document_summary:  Optional pre-built document-level summary
                               (see :mod:`document_summary`).  When
                               provided and non-empty, its prompt block
                               is prepended to the user message so the
                               model can write a more accurate
                               ``context`` field and disambiguate proper
                               nouns.  Has no effect when ``None`` or
                               empty.
            surrounding_context:
                               Optional source-markdown text immediately
                               before / after this chunk. Used only as
                               read-only context for disambiguation.

        Returns:
            Dict with keys: cleaned_chunk, title, context, summary,
            keywords, questions.

        Notes:
            If the LLM returns invalid JSON the original content is preserved
            and all enrichment fields are returned as empty defaults rather
            than raising, so the chunk is never silently dropped from the batch.
        """
        # See the matching comment in ``enrich_piece`` — when the user
        # has supplied a custom system prompt we do not auto-wrap the
        # user message in summary markers.  The custom prompt was
        # written against the raw-chunk contract; silently changing it
        # to wrap the chunk in ``<<<CHUNK TO ANALYSE>>>`` boundaries
        # makes the model's JSON output less reliable for that prompt.
        summary_block = (
            document_summary.to_prompt_block()
            if document_summary is not None
                and not document_summary.is_empty()
                and not self._user_prompt
            else ""
        )
        surrounding_context_block = (
            surrounding_context.to_prompt_block()
            if surrounding_context is not None
                and not surrounding_context.is_empty()
                and not self._user_prompt
            else ""
        )
        system_content = self.effective_chunk_system_prompt(with_summary=bool(summary_block))
        user_content = (
            _build_chunk_user_message(
                content,
                document_summary_block=summary_block,
                surrounding_context_block=surrounding_context_block,
            )
            if summary_block or surrounding_context_block
            else content
        )
        response = await self._complete([
            {"role": "system", "content": system_content},
            {"role": "user", "content": user_content},
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
