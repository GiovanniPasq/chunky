"""
Orchestrator for the markdown enrichment pipeline.

Composes the four stages defined in the design:

    1. ``backend.utils.markdown.clean_markdown`` — deterministic regex pass.
    2. ``backend.utils.markdown.split_markdown`` — structure-aware split.
    3. ``EnrichmentService.enrich_piece`` — conservative LLM correction
       per piece, with rolling context from the *original* (pre-LLM)
       text and per-piece checkpointing.
    4. Reassemble corrected pieces in order.

The whole pipeline runs concurrently (up to ``concurrency`` pieces in
flight at once).  Cancellation is respected at every await point.
Per-piece failures are surfaced via the progress callback but never
abort the entire run: failed pieces fall back to the original
post-cleanup text. The caller decides whether to retry.

Why piece-level checkpointing here:
    A 200-piece enrichment is 200 LLM calls.  Re-running after a network
    blip without resuming would waste anywhere from minutes to hours.
    The checkpoint key (see ``enrichment_checkpoint.hash_key``) covers
    every input that determines a piece's output, so reusing the cache
    is always safe — and unchanged inputs after a parameter tweak (e.g.
    user retries with the same prompt+model) become essentially free.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Callable

from .document_summary import DocumentSummary
from .enrichment_checkpoint import EnrichmentCheckpointStore, hash_key
from .enrichment_service import EnrichmentService
from backend.utils.markdown import CleanupReport, Piece, clean_markdown, rolling_context, split_markdown

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Progress events
# ---------------------------------------------------------------------------

# The orchestrator calls a single ``on_progress(event)`` callback with a
# small dict-like payload after every state transition.  The SSE router
# wraps these into ``yield _sse(...)`` events.  Keeping the shape stable
# here makes the router a pure passthrough.

@dataclass(slots=True)
class PipelineResult:
    """Final return value of :func:`run_enrichment_pipeline`."""

    corrected_markdown: str
    pieces: int
    cached_pieces: int          # served from checkpoint, no API call
    failed_pieces: list[int]    # 1-indexed
    cleanup_report: CleanupReport
    document_summary: DocumentSummary | None = None  # the summary actually used (caller-provided)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

async def run_enrichment_pipeline(
    *,
    source_markdown: str,
    service: EnrichmentService,
    checkpoint_store: EnrichmentCheckpointStore | None,
    document_summary: DocumentSummary | None = None,
    on_progress: Callable[[dict], None] | None = None,
    stop_check: Callable[[], bool] | None = None,
    target_chars: int = 4000,
    max_chars: int = 8000,
    rolling_context_chars: int = 800,
    concurrency: int = 2,
) -> PipelineResult:
    """Run the four-stage enrichment pipeline.

    Args:
        source_markdown:        Raw markdown to enrich.
        service:                Pre-configured LLM client.  The pipeline
                                derives ``model`` / ``user_prompt`` from
                                its internals to compute checkpoint
                                hashes.
        checkpoint_store:       Optional store.  When provided, completed
                                pieces are persisted and re-runs reuse
                                them whenever hashes match.  Pass ``None``
                                to disable caching (e.g. trial runs).
        document_summary:       Optional pre-built reference summary
                                (see :mod:`document_summary`).  When
                                provided and non-empty, its prompt block
                                is attached to every piece correction
                                AND its content hash is mixed into the
                                per-piece cache key so a different
                                summary cleanly invalidates cached
                                corrections.  Pass ``None`` to run
                                without document-level context.  The
                                pipeline never generates a summary on
                                its own — that responsibility lives in
                                the ``/summary/generate`` endpoint, so
                                the user can review / edit before the
                                pipeline runs.
        on_progress:            Called with dict events:
                                  ``{"type": "cleanup_done", "report": {...}}``
                                  ``{"type": "split_done", "pieces": N}``
                                  ``{"type": "piece_start", "index": i, "total": N}``
                                  ``{"type": "piece_done", "index": i, "total": N,
                                     "cached": bool, "succeeded": bool, "error": str?}``
                                  Indices are 1-based for UI consumption.
        stop_check:             Optional zero-arg predicate.  When it
                                returns True between piece awaits, the
                                pipeline raises ``InterruptedError`` and
                                cancels in-flight tasks.  The checkpoint
                                survives so a future call resumes work.
        target_chars / max_chars: Forwarded to the splitter.
        rolling_context_chars:  Forwarded to the rolling-context helper.
        concurrency:            Max pieces processed in flight at once.

    Returns:
        A :class:`PipelineResult` containing the reassembled corrected
        markdown plus stats useful for the UI (cache hit count, list of
        pieces that failed).

    Raises:
        InterruptedError:       When ``stop_check`` reported cancellation
                                between awaits.  All in-flight tasks are
                                drained cleanly before the raise.
        ValueError:             For invalid configuration (handled upstream).
    """
    def _emit(event: dict) -> None:
        if on_progress is not None:
            try:
                on_progress(event)
            except Exception as exc:
                # Progress reporting must never abort the pipeline.
                logger.warning("on_progress callback raised: %s", exc)

    # ── Stage 1: regex cleanup ────────────────────────────────────────────
    cleaned, report = clean_markdown(source_markdown)
    _emit({"type": "cleanup_done", "report": report.as_dict()})

    # ── Stage 2: structure-aware split ────────────────────────────────────
    pieces = split_markdown(cleaned, target_chars=target_chars, max_chars=max_chars)
    total = len(pieces)
    _emit({"type": "split_done", "pieces": total})

    if total == 0:
        return PipelineResult(
            corrected_markdown="",
            pieces=0,
            cached_pieces=0,
            failed_pieces=[],
            cleanup_report=report,
            document_summary=document_summary,
        )

    # The summary is caller-provided.  Treat an empty / missing summary
    # the same way as before the summary feature existed — no context
    # block in the piece prompts, no hash component in the cache key.
    summary_for_prompt = (
        document_summary
        if document_summary is not None and not document_summary.is_empty()
        else None
    )
    document_summary_hash = (
        summary_for_prompt.content_hash if summary_for_prompt is not None else ""
    )

    # ── Hash key precomputation ──────────────────────────────────────────
    # The full prompt the model sees is ``effective_piece_system_prompt``
    # (which itself branches on whether a summary is attached) plus the
    # user message.  Mixing the resolved system prompt into the cache
    # key guarantees that:
    #   * Toggling ``use_summary`` between runs invalidates cache
    #     entries cleanly (different prompt → different key).
    #   * A user prompt override invalidates the cache too.
    # The document_summary_hash captures the other variable input.
    # Together they invalidate the per-piece cache exactly when the LLM
    # would produce different output and never spuriously.
    model = service.model_name
    base_url = service.base_url
    prompt_for_hash = service.effective_piece_system_prompt(
        with_summary=summary_for_prompt is not None,
    )
    temperature_for_hash = service.temperature

    # Precompute the rolling context for every piece from the ORIGINAL
    # cleaned markdown.  Computing all of them up-front lets pieces
    # process in parallel — the context for piece N never waits on
    # piece N-1 to finish, because it doesn't depend on piece N-1's
    # corrected output.  This is the invariant that protects against
    # drift across the pipeline.
    contexts = [
        rolling_context(cleaned, p, context_chars=rolling_context_chars)
        for p in pieces
    ]

    # ── Stage 3: per-piece LLM correction ────────────────────────────────
    corrected: list[str] = [""] * total
    cached_pieces = 0
    failed_pieces: list[int] = []
    semaphore = asyncio.Semaphore(max(1, concurrency))
    _lock = asyncio.Lock()

    async def _process(piece: Piece, ctx: str) -> None:
        nonlocal cached_pieces

        if stop_check and stop_check():
            raise InterruptedError("Enrichment cancelled before piece")

        # Whitespace-only pieces (e.g. a stray blank-line block the
        # splitter promoted into its own piece) have nothing for the
        # LLM to correct.  Return the original verbatim — saves an API
        # call and side-steps the whitespace re-anchoring corner case
        # in ``enrich_piece`` where leading and trailing matches would
        # both grab the whole content and double it on reassembly.
        if not piece.content.strip():
            async with _lock:
                corrected[piece.index] = piece.content
            _emit({
                "type": "piece_done",
                "index": piece.index + 1,
                "total": total,
                "cached": False,
                "succeeded": True,
            })
            return

        # Checkpoint fast path: identical inputs ⇒ return cached output
        # with zero API cost.  The hash covers everything the LLM sees,
        # including the document-summary block that gets prepended to
        # every piece prompt — so a regenerated summary invalidates
        # downstream piece corrections without requiring an explicit
        # discard.
        key = hash_key(
            piece.content,
            prompt_for_hash,
            model,
            temperature_for_hash,
            document_summary_hash,
            base_url,
            ctx,
        )
        if checkpoint_store is not None:
            cached = checkpoint_store.get(piece.index, key)
            if cached is not None:
                async with _lock:
                    corrected[piece.index] = cached
                    cached_pieces += 1
                _emit({
                    "type": "piece_done",
                    "index": piece.index + 1,
                    "total": total,
                    "cached": True,
                    "succeeded": True,
                })
                return

        _emit({"type": "piece_start", "index": piece.index + 1, "total": total})

        async with semaphore:
            if stop_check and stop_check():
                raise InterruptedError("Enrichment cancelled before LLM call")
            try:
                result = await service.enrich_piece(
                    piece.content,
                    previous_context=ctx,
                    document_summary=summary_for_prompt,
                )
            except (asyncio.CancelledError, InterruptedError):
                raise
            except Exception as exc:
                # Per-piece failure: keep the post-cleanup original so
                # the assembled document still covers this region.  The
                # piece is NOT checkpointed (so a retry re-attempts it).
                async with _lock:
                    corrected[piece.index] = piece.content
                    failed_pieces.append(piece.index + 1)
                logger.warning(
                    "Enrichment piece %d failed: %s — falling back to original",
                    piece.index + 1, exc,
                )
                _emit({
                    "type": "piece_done",
                    "index": piece.index + 1,
                    "total": total,
                    "cached": False,
                    "succeeded": False,
                    "error": f"{type(exc).__name__}: {str(exc)[:200]}",
                })
                return

        # Successful LLM call — persist before reporting progress so a
        # crash between checkpoint and progress can't lose work.
        if checkpoint_store is not None:
            try:
                checkpoint_store.set(piece.index, key, result)
            except OSError as exc:
                logger.warning(
                    "Failed to checkpoint enrichment piece %d: %s",
                    piece.index + 1, exc,
                )
        async with _lock:
            corrected[piece.index] = result
        _emit({
            "type": "piece_done",
            "index": piece.index + 1,
            "total": total,
            "cached": False,
            "succeeded": True,
        })

    tasks = [
        asyncio.create_task(_process(p, ctx))
        for p, ctx in zip(pieces, contexts)
    ]
    try:
        await asyncio.gather(*tasks)
    except (Exception, asyncio.CancelledError):
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if stop_check and stop_check():
            raise InterruptedError("Enrichment cancelled")
        raise

    # ── Stage 4: reassemble ──────────────────────────────────────────────
    corrected_markdown = "".join(corrected)
    failed_pieces.sort()

    return PipelineResult(
        corrected_markdown=corrected_markdown,
        pieces=total,
        cached_pieces=cached_pieces,
        failed_pieces=failed_pieces,
        cleanup_report=report,
        document_summary=summary_for_prompt,
    )
