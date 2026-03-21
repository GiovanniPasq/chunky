#!/usr/bin/env python3
"""
Utility script: convert all Markdown files in docs/mds/ to PDF in docs/pdfs/.

Usage:
    python -m backend.utils.md_to_pdf

Dependencies:
    pip install markdown weasyprint
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

logger = logging.getLogger(__name__)

import markdown
from weasyprint import CSS, HTML
from weasyprint.text.fonts import FontConfiguration

MDS_DIR = Path("docs/mds")
PDFS_DIR = Path("docs/pdfs")

_CSS = """
@page {
    size: A4;
    margin: 2cm;
}

body {
    font-family: 'DejaVu Sans', Arial, sans-serif;
    font-size: 11pt;
    line-height: 1.6;
    color: #333;
}

h1 {
    font-size: 24pt;
    color: #1a1a1a;
    border-bottom: 2px solid #e1e4e8;
    padding-bottom: 10px;
    margin-top: 20px;
    margin-bottom: 16px;
}

h2 {
    font-size: 20pt;
    color: #1a1a1a;
    border-bottom: 1px solid #e1e4e8;
    padding-bottom: 8px;
    margin-top: 18px;
    margin-bottom: 14px;
}

h3 {
    font-size: 16pt;
    color: #1a1a1a;
    margin-top: 16px;
    margin-bottom: 12px;
}

h4 {
    font-size: 14pt;
    color: #1a1a1a;
    margin-top: 14px;
    margin-bottom: 10px;
}

p {
    margin: 12px 0;
    text-align: justify;
}

ul, ol {
    margin: 12px 0;
    padding-left: 30px;
}

li {
    margin: 6px 0;
}

code {
    background-color: #f6f8fa;
    padding: 2px 6px;
    border-radius: 3px;
    font-family: 'DejaVu Sans Mono', 'Courier New', monospace;
    font-size: 10pt;
}

pre {
    background-color: #f6f8fa;
    padding: 16px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 12px 0;
}

pre code {
    background-color: transparent;
    padding: 0;
}

blockquote {
    border-left: 4px solid #dfe2e5;
    padding-left: 16px;
    margin: 12px 0;
    color: #6a737d;
    font-style: italic;
}

table {
    border-collapse: collapse;
    margin: 12px 0;
    width: 100%;
}

table th,
table td {
    border: 1px solid #dfe2e5;
    padding: 8px 12px;
}

table th {
    background-color: #f6f8fa;
    font-weight: 600;
}

a {
    color: #0366d6;
    text-decoration: none;
}

img {
    max-width: 100%;
    height: auto;
}
"""


def _md_to_html(md_content: str) -> str:
    """Convert a Markdown string to a complete HTML document."""
    md = markdown.Markdown(
        extensions=["extra", "codehilite", "toc", "nl2br"],
    )
    body = md.convert(md_content)
    return (
        "<!DOCTYPE html><html><head>"
        '<meta charset="utf-8"><title>Document</title>'
        f"</head><body>{body}</body></html>"
    )


def _convert_file(md_path: Path, pdf_path: Path) -> bool:
    """Convert a single Markdown file to PDF. Returns True on success."""
    try:
        md_content = md_path.read_text(encoding="utf-8")
        html_content = _md_to_html(md_content)

        font_config = FontConfiguration()
        HTML(string=html_content).write_pdf(
            pdf_path,
            stylesheets=[CSS(string=_CSS, font_config=font_config)],
            font_config=font_config,
        )
        return True
    except Exception as exc:
        logger.error("MD→PDF conversion failed for '%s': %s", md_path.name, exc)
        return False


def main() -> int:
    if not MDS_DIR.exists():
        logger.error("Source directory '%s' does not exist.", MDS_DIR)
        return 1

    PDFS_DIR.mkdir(parents=True, exist_ok=True)

    md_files = sorted(MDS_DIR.glob("*.md"))
    if not md_files:
        logger.info("No Markdown files found in '%s'.", MDS_DIR)
        return 0

    logger.info("Converting %d file(s)…", len(md_files))

    converted = failed = 0
    for md_file in md_files:
        pdf_path = PDFS_DIR / f"{md_file.stem}.pdf"
        logger.info("  %s  →  %s", md_file.name, pdf_path.name)
        if _convert_file(md_file, pdf_path):
            converted += 1
        else:
            failed += 1

    logger.info("Done — converted: %d, failed: %d", converted, failed)
    logger.info("PDFs saved in: %s", PDFS_DIR.resolve())
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
