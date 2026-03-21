"""
Application-wide settings loaded from environment variables / .env file.

All settings have sensible defaults so the app runs without any configuration.
Override any value with an environment variable of the same name:

    MAX_CONCURRENT_CONVERSIONS=5 uvicorn backend.main:app --reload
    LOG_FORMAT=json uvicorn backend.main:app
"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # ── Concurrency ────────────────────────────────────────────
    MAX_CONCURRENT_CONVERSIONS: int = 3
    """Max PDF→Markdown conversions that may run concurrently (single + batch)."""

    # ── Upload / validation ────────────────────────────────────
    MAX_FILE_SIZE_MB: int = 100
    """Maximum allowed upload size in megabytes. 0 = unlimited."""

    MAX_PAGE_COUNT: int = 0
    """Maximum PDF page count accepted for conversion. 0 = unlimited."""

    # ── Storage ────────────────────────────────────────────────
    PDFS_DIR: str = "docs/pdfs"
    MDS_DIR: str = "docs/mds"
    CHUNKS_DIR: str = "chunks"

    # ── Logging ────────────────────────────────────────────────
    LOG_LEVEL: str = "INFO"
    """Python log-level name: DEBUG, INFO, WARNING, ERROR, CRITICAL."""

    LOG_FORMAT: str = "text"
    """Output format: 'text' (human-readable) or 'json' (structured, for production)."""

    # ── SSE watchdog ───────────────────────────────────────────
    SSE_WATCHDOG_TIMEOUT_S: int = 60
    """Seconds of SSE silence before an operation is automatically cancelled.
    Increase for very slow models (e.g. large VLMs on CPU). Set to 0 to disable."""

    # ── App ────────────────────────────────────────────────────
    APP_VERSION: str = "0.2.0"


@lru_cache
def get_settings() -> Settings:
    """Return the cached Settings singleton."""
    return Settings()
