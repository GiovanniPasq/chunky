"""
Document-level summary store + map-reduce orchestrator.

The summary is the "what is this document about" reference block that gets
attached to every per-piece correction prompt and chunk-enrichment prompt.
Generating it once and caching it keeps the marginal
cost of a re-run negligible: ``topic_hints`` are unioned across pieces in
pure Python, and a single LLM reduce call picks a final ``topic`` and
synthesises a ~200-word ``narrative``.

Storage shape — one JSON sibling **per source PDF** (not per converter),
``mds/{doc_stem}.summary.json``::

    {
        "source_hash": "sha256(<PDF bytes>, or cleaned MD for bare-MD uploads)",
        "summary": {
            "topic":     "<one short phrase>",
            "narrative": "<~200-word paragraph>"
        },
        "generated_at": "2026-05-21T14:22:00Z",
        "user_edited":  false
    }

Per-piece extractions are NOT persisted: a Regenerate rebuilds from
scratch.  The runtime ``PieceExtraction`` dataclass only carries
``topic_hints`` and a one-sentence ``narrative`` — see ``PieceExtraction``
below.  This is intentionally a thinner schema than the original design
notes (no entities / terms / document_type fields); those fields turned
out to be unreliable to extract and were dropped along with their
persistence layer.

Lifecycle:
    * Created on first markdown-enrichment run via the SummaryReviewModal
      → /api/enrich/summary/generate. Chunk enrichment only attaches an
      existing cached summary; it never generates one on its own.
    * The summary is keyed by the source PDF itself: ``source_hash`` is
      the SHA-256 of the PDF bytes when one exists on disk (the common
      case), or — when only an uploaded ``.md`` exists — of the cleaned
      markdown.  Switching converters (e.g. running enrichment on the
      Cloud variant after the VLM variant) therefore reuses the cached
      summary without any LLM calls.
    * ``user_edited=True`` makes a stored summary authoritative: future
      runs return it verbatim until an explicit Regenerate, a PDF
      re-upload, or a document delete wipes the file.
    * Cascade-deleted alongside the .md / chunks / checkpoint dirs on PDF
      re-upload and document delete (see ``document_service``).

Map-reduce flow:
    1. Cache check.  Source-hash match AND non-empty summary ⇒ return
       cached, zero LLM calls.  User-edited records short-circuit even
       on hash mismatch unless ``force_regenerate=True``.
    2. Map: extract ``PieceExtraction(topic_hints, narrative)`` from each
       piece in parallel (semaphore bounded by ``concurrency``).  Failed
       extractions yield an empty ``PieceExtraction`` so the reduce step
       still receives the same number of slots.
    3. Reduce — possibly tiered:
         * ``len(extractions) <= REDUCE_TIER_THRESHOLD`` (30): single
           reduce call over all extractions.
         * Otherwise: groups of ``REDUCE_TIER_SIZE`` (10) reduce in
           parallel to ``DocumentSummary`` partials, then a final reduce
           across the partials.  Keeps the reduce prompt within any
           reasonable context window regardless of document length.
       Each ``_reduce_once`` first unions topic hints in pure Python
       (case-insensitive, order-preserving), then asks the LLM for
       final ``topic`` + ``narrative``.  On LLM failure it returns an
       empty summary so the run still completes.
    4. Persist atomically via tmp + ``os.replace``.

Failure handling:
    * Per-piece extraction failure → empty extraction in its slot;
      logged at WARNING.
    * Reduce failure → empty ``{"topic": "", "narrative": ""}`` so the
      downstream pipeline still runs (just without document-level
      context).  Logged at WARNING.
    * Cancellation is checked before every LLM call.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from .enrichment_service import EnrichmentService
    from backend.utils.markdown import Piece

logger = logging.getLogger(__name__)

from backend.utils.files import atomic_write_text


# Threshold above which the reduce step is tiered (group-of-N partials
# followed by a final reduce across partials).  Picked to keep the reduce
# prompt comfortably inside any reasonable model's context window even when
# every per-piece extraction is dense.
REDUCE_TIER_SIZE = 10
REDUCE_TIER_THRESHOLD = 30


# ---------------------------------------------------------------------------
# Hash helpers
# ---------------------------------------------------------------------------

def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _sha256_file(path: Path, *, chunk_bytes: int = 1 << 20) -> str | None:
    """Stream-hash ``path``.  Returns ``None`` when the file is missing
    or unreadable so the caller can fall back to a content-based hash.

    Streamed so a 100 MB PDF doesn't get loaded into memory.  Used as the
    summary's source-of-truth fingerprint when a PDF exists, which makes
    the cached summary survive a converter switch (the PDF is the same
    bytes regardless of which variant we are about to enrich).
    """
    try:
        h = hashlib.sha256()
        with path.open("rb") as f:
            while True:
                buf = f.read(chunk_bytes)
                if not buf:
                    break
                h.update(buf)
        return h.hexdigest()
    except (OSError, FileNotFoundError) as exc:
        logger.warning("Could not hash source file '%s': %s — falling back", path, exc)
        return None


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class PieceExtraction:
    """Map-step output for a single piece.  In-memory only — never persisted.

    The fields are deliberately minimal: ``topic_hints`` feed the reduce
    step's topic-selection decision and ``narrative`` is concatenated
    across pieces to drive the prose synthesis.
    """

    topic_hints: list[str] = field(default_factory=list)
    narrative: str = ""


@dataclass(slots=True)
class DocumentSummary:
    """The final per-document reference block passed to downstream prompts."""

    topic: str = ""
    narrative: str = ""

    def as_dict(self) -> dict:
        return {"topic": self.topic, "narrative": self.narrative}

    @classmethod
    def from_dict(cls, data: dict) -> "DocumentSummary":
        if not isinstance(data, dict):
            return cls()
        return cls(
            topic=str(data.get("topic", "")),
            narrative=str(data.get("narrative", "")),
        )

    def to_prompt_block(self) -> str:
        lines: list[str] = []
        if self.topic:
            lines.append(f"TOPIC: {self.topic}")
        if self.narrative:
            lines.append(f"NARRATIVE: {self.narrative}")
        return "\n".join(lines)

    @property
    def content_hash(self) -> str:
        """SHA-256 of the canonical JSON encoding.  Used as a component of
        the per-piece correction cache key so a summary change propagates
        cleanly to every downstream entry.
        """
        canonical = json.dumps(self.as_dict(), sort_keys=True, ensure_ascii=False)
        return _sha256_text(canonical)

    def is_empty(self) -> bool:
        return not (self.topic or self.narrative)


@dataclass(slots=True)
class StoredSummary:
    """Top-level on-disk record persisted by :class:`DocumentSummaryStore`.

    Minimal schema by design — only the source fingerprint, the summary
    content, the generation timestamp, and the ``user_edited`` lifecycle
    flag are persisted.  Per-piece extractions are NOT kept on disk:
    a Regenerate rebuilds from scratch.

    ``user_edited`` protects manual edits from being silently overwritten
    by future runs.  When ``True``, the summary builder treats the
    record as authoritative until an explicit Regenerate (or PDF
    re-upload, which wipes the file via cascade cleanup).
    """

    source_hash: str
    summary: DocumentSummary
    generated_at: str
    user_edited: bool = False

    def as_dict(self) -> dict:
        return {
            "source_hash": self.source_hash,
            "summary": self.summary.as_dict(),
            "generated_at": self.generated_at,
            "user_edited": self.user_edited,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "StoredSummary":
        return cls(
            source_hash=str(data.get("source_hash", "")),
            summary=DocumentSummary.from_dict(data.get("summary", {})),
            generated_at=str(data.get("generated_at", "")),
            user_edited=bool(data.get("user_edited", False)),
        )


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

SUMMARY_SUFFIX = ".summary.json"


def summary_path_for(doc_stem: str, mds_dir: Path) -> Path:
    """Resolve the on-disk path of the summary for a document.

    One summary record per source PDF — every converter variant shares
    it.  Public helper so cleanup paths in ``document_service`` can
    enumerate summaries via the same convention used by the store.
    """
    return mds_dir / f"{doc_stem}{SUMMARY_SUFFIX}"


class DocumentSummaryStore:
    """Filesystem-backed cache for one ``(document)`` pair.

    Single-writer assumption matches the rest of the enrichment subsystem:
    callers should avoid launching two summary-generation runs for the same
    document at once. Atomic writes protect the JSON file from corruption, but
    this store does not implement its own per-document lock.
    """

    def __init__(self, doc_stem: str, mds_dir: Path) -> None:
        self._path = summary_path_for(doc_stem, mds_dir)

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> StoredSummary | None:
        """Return the stored record, or ``None`` on absence / corruption.

        Corruption (bad JSON, missing top-level fields, hand-edited junk)
        is treated as a clean miss: the caller falls back to regeneration,
        and the next successful save overwrites the bad record.
        """
        if not self._path.is_file():
            return None
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("Discarding unreadable document summary %s: %s", self._path, exc)
            return None
        try:
            return StoredSummary.from_dict(data)
        except Exception as exc:  # noqa: BLE001 — defensive: never break load on bad data
            logger.warning("Discarding malformed document summary %s: %s", self._path, exc)
            return None

    def save(self, record: StoredSummary) -> None:
        """Atomically persist ``record``.

        Writes to a sibling ``.tmp`` then ``os.replace``s it into place so
        a crash mid-write leaves either the previous record intact or no
        file at all — never a truncated JSON document.
        """
        atomic_write_text(
            self._path,
            json.dumps(record.as_dict(), ensure_ascii=False, indent=2),
        )

    def discard(self) -> None:
        """Remove the on-disk record.  Safe when the file does not exist."""
        try:
            self._path.unlink()
        except FileNotFoundError:
            return
        except OSError as exc:
            logger.warning("Failed to remove document summary '%s': %s", self._path, exc)


def discard_all_for_stem(stem: str, mds_dir: Path) -> None:
    """Delete the summary record for ``stem``.

    The current naming uses a single ``{stem}.summary.json`` per document
    (shared across converter variants).  We also delete any legacy
    per-variant files (``{stem}_{converter}.summary.json``) that may be
    left over from an older build so the cleanup is idempotent across
    versions.  Called from document delete / re-upload flows alongside
    the VLM and enrichment checkpoint cleanups.
    """
    if not mds_dir.exists():
        return
    candidates: list[Path] = []
    target = mds_dir / f"{stem}{SUMMARY_SUFFIX}"
    if target.exists():
        candidates.append(target)
    # Legacy per-variant files (from earlier builds): glob requires the
    # literal ``{stem}_`` prefix, so other documents whose stems just
    # happen to start with ``{stem}`` are not touched.
    candidates.extend(mds_dir.glob(f"{stem}_*{SUMMARY_SUFFIX}"))
    for path in candidates:
        try:
            path.unlink()
        except FileNotFoundError:
            continue
        except OSError as exc:
            logger.warning("Failed to remove document summary '%s': %s", path, exc)


# ---------------------------------------------------------------------------
# Union helpers (pure-Python, no LLM)
# ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    return s.strip().lower()


def _union_strings(values: list[list[str]]) -> list[str]:
    """Order-preserving case-insensitive union.

    Keeps the first-seen casing of each value so the model can later
    decide that "ARR" and "Arr" represent the same thing without us
    having to pick.  Empty strings are dropped.
    """
    seen: dict[str, str] = {}
    for group in values:
        for raw in group:
            if not isinstance(raw, str):
                continue
            v = raw.strip()
            if not v:
                continue
            k = _norm(v)
            if k not in seen:
                seen[k] = v
    return list(seen.values())


def _union_extractions(extractions: list[PieceExtraction]) -> dict:
    """Produce the unioned ``topic_hints`` and per-piece narratives that
    feed the reduce step.  Pure Python so the result is never corrupted
    by an LLM hallucination.
    """
    return {
        "topic_hints": _union_strings([e.topic_hints for e in extractions]),
        "narratives": [e.narrative for e in extractions if e.narrative],
    }


# ---------------------------------------------------------------------------
# Public orchestrator
# ---------------------------------------------------------------------------

async def get_or_generate_summary(
    *,
    pieces: list["Piece"],
    cleaned_source: str,
    doc_stem: str,
    mds_dir: Path,
    pdf_path: Path | None,
    service: "EnrichmentService",
    on_progress: Callable[[dict], None] | None = None,
    stop_check: Callable[[], bool] | None = None,
    concurrency: int = 2,
    force_regenerate: bool = False,
) -> DocumentSummary:
    """Resolve or generate the per-document summary.

    The summary is keyed on the SOURCE PDF (not the cleaned markdown), so
    re-running enrichment against a different converter variant of the
    same document reuses the cached summary with zero LLM calls.  When
    no PDF exists on disk (standalone ``.md`` upload) the cleaned
    markdown's hash is used instead — that path is degraded but still
    correct.

    Args:
        pieces:           Output of ``backend.utils.markdown.split_markdown``.
        cleaned_source:   The post-cleanup markdown used to drive the splitter.
                          Hashed only as the fallback fingerprint when no
                          PDF exists; otherwise unused for invalidation.
        doc_stem:         Source-document stem (e.g. ``"report"``).  The
                          summary lives at ``mds/{doc_stem}.summary.json``.
        mds_dir:          Directory containing markdown variants and the
                          summary record.
        pdf_path:         Path to the source PDF on disk, or ``None`` for
                          bare-``.md`` uploads.  When provided and readable,
                          its byte hash becomes the cache fingerprint.
        service:          Configured ``EnrichmentService``.
        on_progress:      Optional progress callback.  Receives dicts of
                          shape ``{"type": "summary_progress", "current": i,
                          "total": N, "cached": bool}`` after each piece
                          extraction, and ``{"type": "summary_ready",
                          "cached": bool}`` at the end.
        stop_check:       Zero-arg predicate; when it returns ``True``
                          between extractions the function raises
                          ``InterruptedError`` so the pipeline can wind
                          down cleanly.
        concurrency:      Max pieces extracted in parallel.
        force_regenerate: When ``True``, ignore any existing cache and
                          rebuild from scratch.

    Returns:
        A :class:`DocumentSummary`.  On full failure (every extraction
        and the reduce step) returns an empty summary so callers can
        continue without context.
    """
    def _emit(event: dict) -> None:
        if on_progress is None:
            return
        try:
            on_progress(event)
        except Exception as exc:  # noqa: BLE001 — progress must never abort the pipeline
            logger.warning("Summary on_progress callback raised: %s", exc)

    store = DocumentSummaryStore(doc_stem, mds_dir)
    # Fingerprint precedence: PDF bytes (stable across converter variants)
    # → cleaned markdown (the only thing we have for bare-MD uploads).
    source_hash: str | None = None
    if pdf_path is not None:
        source_hash = _sha256_file(pdf_path)
    if source_hash is None:
        source_hash = _sha256_text(cleaned_source)

    existing = None if force_regenerate else store.load()

    # User-edited summaries are authoritative.  Source-hash mismatch
    # alone does NOT trigger regeneration — only an explicit
    # ``force_regenerate=True`` (the modal's Regenerate button) or a
    # PDF re-upload (cascade cleanup wipes the file) replaces them.
    if existing is not None and existing.user_edited and not force_regenerate:
        _emit({"type": "summary_ready", "cached": True, "user_edited": True})
        return existing.summary

    total = len(pieces)
    if total == 0:
        empty = DocumentSummary()
        _emit({"type": "summary_ready", "cached": False})
        return empty

    # Document-level cache: source hash matches AND the cached summary is
    # non-empty.  No per-piece cache anymore (the simplified file schema
    # no longer persists piece_extractions), so a partial run rebuilds
    # from scratch on the next attempt.
    if (
        existing is not None
        and existing.source_hash == source_hash
        and not existing.summary.is_empty()
    ):
        _emit({"type": "summary_ready", "cached": True})
        return existing.summary

    # ── Map step ──────────────────────────────────────────────────────────
    extractions: list[PieceExtraction] = [PieceExtraction() for _ in pieces]
    semaphore = asyncio.Semaphore(max(1, concurrency))
    completed = 0
    completed_lock = asyncio.Lock()

    async def _extract(i: int) -> None:
        nonlocal completed
        if stop_check and stop_check():
            raise InterruptedError("Summary cancelled before piece extraction")

        async with semaphore:
            if stop_check and stop_check():
                raise InterruptedError("Summary cancelled before LLM call")
            try:
                extractions[i] = await service.extract_piece_summary(pieces[i].content)
            except (asyncio.CancelledError, InterruptedError):
                raise
            except Exception as exc:  # noqa: BLE001 — degrade gracefully
                logger.warning(
                    "Summary extraction failed for piece %d/%d (continuing with empty): %s",
                    i + 1, total, exc,
                )
                extractions[i] = PieceExtraction()

        async with completed_lock:
            completed += 1
            _emit({
                "type": "summary_progress",
                "current": completed,
                "total": total,
                "cached": False,
            })

    tasks = [asyncio.create_task(_extract(i)) for i in range(total)]
    try:
        await asyncio.gather(*tasks)
    except (Exception, asyncio.CancelledError):
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if stop_check and stop_check():
            raise InterruptedError("Summary cancelled")
        raise

    # ── Reduce step ───────────────────────────────────────────────────────
    summary = await _reduce_with_tiering(
        extractions=extractions,
        service=service,
        stop_check=stop_check,
    )

    # Give a queued cancellation a chance to run before publishing the final
    # durable record, then re-check the cooperative flag.
    await asyncio.sleep(0)
    if stop_check and stop_check():
        raise InterruptedError("Summary cancelled before saving")

    record = StoredSummary(
        source_hash=source_hash,
        summary=summary,
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        user_edited=False,
    )
    try:
        store.save(record)
    except OSError as exc:
        logger.warning("Failed to persist document summary to %s: %s", store.path, exc)

    _emit({"type": "summary_ready", "cached": False})
    return summary


def save_user_edit(
    *,
    doc_stem: str,
    mds_dir: Path,
    edited_summary: DocumentSummary,
) -> StoredSummary:
    """Persist a user-edited summary while preserving its source revision.

    The source hash is carried over from the stored record. The summary
    content changes and ``user_edited`` flips to ``True`` so subsequent
    enrichment runs treat the edit as authoritative.

    If no prior record exists (the user shouldn't reach this path
    because the modal can only save what it loaded, but be defensive)
    we create a fresh record with an empty source hash.
    """
    store = DocumentSummaryStore(doc_stem, mds_dir)
    existing = store.load()
    record = StoredSummary(
        source_hash=existing.source_hash if existing else "",
        summary=edited_summary,
        generated_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        user_edited=True,
    )
    store.save(record)
    return record


async def _reduce_with_tiering(
    *,
    extractions: list[PieceExtraction],
    service: "EnrichmentService",
    stop_check: Callable[[], bool] | None,
) -> DocumentSummary:
    """Run the reduce step, possibly in two tiers for very long documents.

    Up to ``REDUCE_TIER_THRESHOLD`` extractions: single reduce call.
    Above that: groups of ``REDUCE_TIER_SIZE``, each producing a partial
    DocumentSummary in parallel, then a final reduce across the partials.
    """
    if stop_check and stop_check():
        raise InterruptedError("Summary cancelled before reduce")

    if not extractions:
        return DocumentSummary()

    if len(extractions) <= REDUCE_TIER_THRESHOLD:
        return await _reduce_once(extractions, service)

    # Two-tier reduce.  Each group's partial is itself a DocumentSummary;
    # we synthesise the partials back into PieceExtraction-like records so
    # the same reduce path can fold them into the final summary.
    groups: list[list[PieceExtraction]] = [
        extractions[i:i + REDUCE_TIER_SIZE]
        for i in range(0, len(extractions), REDUCE_TIER_SIZE)
    ]

    async def _partial(group: list[PieceExtraction]) -> DocumentSummary:
        if stop_check and stop_check():
            raise InterruptedError("Summary cancelled during tiered reduce")
        return await _reduce_once(group, service)

    partial_summaries = await asyncio.gather(*[_partial(g) for g in groups])

    # Hoist partial summaries back into PieceExtraction shape so the second
    # reduce call gets the same input contract as the first.
    bridged: list[PieceExtraction] = [
        PieceExtraction(
            topic_hints=[ps.topic] if ps.topic else [],
            narrative=ps.narrative,
        )
        for ps in partial_summaries
    ]
    return await _reduce_once(bridged, service)


async def _reduce_once(
    extractions: list[PieceExtraction],
    service: "EnrichmentService",
) -> DocumentSummary:
    """Single reduce call: union topic hints in Python, ask LLM to pick
    the final topic and synthesise the narrative from per-piece
    narratives.  Falls back to an empty summary if the LLM call fails.
    """
    unioned = _union_extractions(extractions)
    try:
        chosen = await service.reduce_extractions(
            topic_hints=unioned["topic_hints"],
            narratives=unioned["narratives"],
        )
    except (asyncio.CancelledError, InterruptedError):
        raise
    except Exception as exc:  # noqa: BLE001 — degrade gracefully
        logger.warning("Reduce step failed (returning empty summary): %s", exc)
        chosen = {"topic": "", "narrative": ""}

    return DocumentSummary(
        topic=str(chosen.get("topic", "")).strip(),
        narrative=str(chosen.get("narrative", "")).strip(),
    )
