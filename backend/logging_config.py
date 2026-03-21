"""
Logging configuration — call configure_logging() once at startup.

Text format (development / default):
    2024-05-10 14:32:07  INFO      backend.services.document_service — Starting conversion…

JSON format (production, LOG_FORMAT=json):
    {"timestamp":"2024-05-10T14:32:07","level":"INFO","logger":"backend.services.document_service",
     "message":"Conversion complete","operation":"convert","file_name":"doc.pdf","duration_ms":1234}

Usage
-----
Add extra fields to any log call via the ``extra`` keyword:

    logger.info(
        "Conversion complete",
        extra={"operation": "convert", "file_name": filename, "duration_ms": elapsed_ms},
    )
"""

from __future__ import annotations

import json
import logging
from typing import Any

# Well-known structured fields forwarded to JSON output.
_EXTRA_FIELDS = ("operation", "file_name", "duration_ms", "status_code")


class _JSONFormatter(logging.Formatter):
    """Emit each log record as a single-line JSON object."""

    def format(self, record: logging.LogRecord) -> str:
        obj: dict[str, Any] = {
            "timestamp": self.formatTime(record, "%Y-%m-%dT%H:%M:%S"),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        if record.exc_info:
            obj["exc_info"] = self.formatException(record.exc_info)
        for key in _EXTRA_FIELDS:
            val = record.__dict__.get(key)
            if val is not None:
                obj[key] = val
        return json.dumps(obj, ensure_ascii=False)


def configure_logging(level: str = "INFO", fmt: str = "text") -> None:
    """Configure the root logger.

    Should be called exactly once before the first request is handled.
    All module-level loggers inherit this configuration automatically.

    Args:
        level: Log level name (DEBUG / INFO / WARNING / ERROR / CRITICAL).
        fmt:   ``"text"`` for human-readable output (development),
               ``"json"`` for structured JSON output (production).
    """
    numeric_level = getattr(logging, level.upper(), logging.INFO)

    root = logging.getLogger()
    root.setLevel(numeric_level)
    root.handlers.clear()

    handler = logging.StreamHandler()
    handler.setLevel(numeric_level)

    if fmt.lower() == "json":
        handler.setFormatter(_JSONFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )

    root.addHandler(handler)
