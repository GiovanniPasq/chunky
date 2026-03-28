"""
Shared SSE formatting utility.

Usage::

    from backend.utils.sse import sse_event

    yield sse_event({"type": "start"})
"""

import json


def sse_event(data: dict) -> str:
    """Format a dict as a single SSE data frame (JSON-encoded, newline-terminated)."""
    return f"data: {json.dumps(data, ensure_ascii=False)}\n\n"
