"""
Router for health and metrics endpoints.

GET /api/health   → liveness probe + version info
GET /api/metrics  → operational counters, active jobs, disk usage
"""

from __future__ import annotations

import time
from pathlib import Path

from fastapi import APIRouter

from backend.config import get_settings

# Monotonic clock at import time — used for uptime calculation.
_START_TIME = time.monotonic()

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health():
    """Liveness probe — returns HTTP 200 with version and uptime."""
    settings = get_settings()
    return {
        "status": "ok",
        "version": settings.APP_VERSION,
        "uptime_seconds": int(time.monotonic() - _START_TIME),
    }


@router.get("/metrics")
async def metrics():
    """Operational metrics snapshot.

    Returns:
        pdf_documents    — PDFs on disk
        md_documents     — Markdown files on disk
        cache_size_bytes — total size of the chunks directory
        uptime_seconds   — seconds since the process started
        config           — key runtime limits for observability
    """
    settings = get_settings()

    pdf_dir = Path(settings.PDFS_DIR)
    md_dir = Path(settings.MDS_DIR)
    chunks_dir = Path(settings.CHUNKS_DIR)

    pdf_count = len(list(pdf_dir.glob("*.pdf"))) if pdf_dir.exists() else 0
    md_count = len(list(md_dir.glob("*.md"))) if md_dir.exists() else 0
    cache_bytes = (
        sum(f.stat().st_size for f in chunks_dir.rglob("*") if f.is_file())
        if chunks_dir.exists()
        else 0
    )

    return {
        "pdf_documents": pdf_count,
        "md_documents": md_count,
        "cache_size_bytes": cache_bytes,
        "uptime_seconds": int(time.monotonic() - _START_TIME),
        "config": {
            "max_concurrent_conversions": settings.MAX_CONCURRENT_CONVERSIONS,
            "max_file_size_mb": settings.MAX_FILE_SIZE_MB,
            "max_page_count": settings.MAX_PAGE_COUNT,
        },
    }
