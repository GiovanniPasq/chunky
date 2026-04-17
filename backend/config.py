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
    MAX_CONCURRENT_CONVERSIONS: int = 2
    """Max PDF→Markdown conversions that may run concurrently (single + batch)."""

    CPU_CONVERTER_MAX_TASKS_PER_CHILD: int = 50
    """Number of jobs a CPU converter worker process handles before being recycled.
    Recycling forces the OS to reclaim accumulated ML memory (e.g. PyTorch caches
    from Docling). Set to 0 to disable recycling."""

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
    SSE_WATCHDOG_TIMEOUT_S: int = 600
    """Seconds of SSE silence before an operation is automatically cancelled.
    Increase for very slow models (e.g. large VLMs on CPU). Set to 0 to disable."""

    # ── HTTP timeouts ──────────────────────────────────────────
    HTTP_CONNECT_TIMEOUT_S: float = 10.0
    """Seconds to wait while establishing a TCP connection to any external service."""

    HTTP_POOL_TIMEOUT_S: float = 5.0
    """Seconds to wait for a free connection from the httpx connection pool."""

    VLM_READ_TIMEOUT_S: float = 120.0
    """Seconds to wait for a VLM page-transcription response.
    Increase for large models running on CPU (e.g. 34B+ parameter models)."""

    CLOUD_READ_TIMEOUT_S: float = 120.0
    """Seconds to wait for the cloud conversion endpoint to return Markdown."""

    CLOUD_WRITE_TIMEOUT_S: float = 30.0
    """Seconds allowed for uploading the PDF to the cloud endpoint.
    Raise for very large files on slow upload links."""

    ENRICH_READ_TIMEOUT_S: float = 120.0
    """Seconds to wait for an enrichment LLM response.
    Also used as the read timeout for the shared httpx client in app.state."""

    # ── Retry ──────────────────────────────────────────
    HTTP_MAX_RETRY_ATTEMPTS: int = 3
    """Max number of attempts for transient HTTP/LLM errors (VLM, Cloud, Enrichment).
    Set to 1 to disable retries (first attempt only)."""

    HTTP_RETRY_BASE_DELAY_S: float = 1.0
    """Initial back-off delay in seconds before the first retry.
    Each subsequent retry doubles the delay (1 s, 2 s, 4 s, …)."""

    # ── VLM concurrency ───────────────────────────────
    VLM_MAX_CONCURRENT_PAGES: int = 1
    """Max VLM page-transcription API calls in flight at once per conversion.
    Increase for fast remote endpoints; decrease for single-GPU local models."""

    VLM_RENDER_DPI: int = 300
    """DPI used when rasterising PDF pages for the VLM converter.
    Higher values improve OCR accuracy at the cost of larger image payloads."""

    VLM_DEFAULT_MODEL: str = "qwen3-vl:4b-instruct-q4_K_M"
    """Default model for VLM conversion."""

    VLM_DEFAULT_BASE_URL: str = "http://localhost:11434/v1"
    """Default base URL for the VLM (Ollama-compatible) API endpoint.
    Also readable via the OLLAMA_BASE_URL environment variable."""

    VLM_DEFAULT_API_KEY: str = "ollama"
    """Default API key for the VLM endpoint (no auth required for local Ollama)."""

    VLM_DEFAULT_TEMPERATURE: float = 0.1
    """Default sampling temperature for VLM page transcription."""

    VLM_WRITE_TIMEOUT_S: float = 10.0
    """Seconds allowed for sending the PDF page image to the VLM endpoint."""

    # ── Cloud converter ────────────────────────────────
    CLOUD_DEFAULT_BASE_URL: str = "http://localhost:8080/convert"
    """Default endpoint for the Cloud PDF→Markdown converter."""

    # ── Enrichment ────────────────────────────────────
    ENRICHMENT_MAX_CONCURRENT_CHUNKS: int = 2
    """Max concurrent LLM calls for chunk enrichment across all active requests.
    Set to 1 for single-GPU local models (e.g. Ollama) to avoid request queuing."""

    ENRICHMENT_DEFAULT_MODEL: str = "qwen3-vl:4b-instruct-q4_K_M"
    """Default LLM model for enrichment (same endpoint as VLM by default)."""

    ENRICHMENT_DEFAULT_BASE_URL: str = "http://localhost:11434/v1"
    """Default base URL for the enrichment LLM endpoint."""

    ENRICHMENT_DEFAULT_API_KEY: str = "ollama"
    """Default API key for the enrichment LLM endpoint."""

    ENRICHMENT_DEFAULT_TEMPERATURE: float = 0.3
    """Default sampling temperature for enrichment calls."""

    ENRICH_WRITE_TIMEOUT_S: float = 10.0
    """Seconds allowed for sending the enrichment request body."""

    # ── SSE keepalive ──────────────────────────────────
    SSE_HEARTBEAT_INTERVAL_S: float = 30.0
    """Seconds between SSE heartbeat comments (': heartbeat') sent to keep the
    connection alive through proxies and load balancers."""

    # ── App ────────────────────────────────────────────────────
    APP_VERSION: str = "0.3.0"


@lru_cache
def get_settings() -> Settings:
    """Return the cached Settings singleton."""
    return Settings()
