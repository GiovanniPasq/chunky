#!/usr/bin/env python3
"""
Utility to convert Markdown files to PDF
Converts all .md files from docs/mds/ to PDF in docs/pdfs/
"""

import os
import sys
from pathlib import Path
import markdown
from weasyprint import HTML, CSS
from weasyprint.text.fonts import FontConfiguration

# Directories
MDS_DIR = Path("docs/mds")
PDFS_DIR = Path("docs/pdfs")

# CSS styling for better PDF appearance
CSS_STYLE = """
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


def markdown_to_html(md_content):
    """Convert markdown content to HTML"""
    md = markdown.Markdown(extensions=[
        'extra',      # Tables, fenced code blocks, etc.
        'codehilite', # Syntax highlighting
        'toc',        # Table of contents
        'nl2br',      # New line to break
    ])

    html_body = md.convert(md_content)

    # Wrap in a complete HTML document
    html = f"""
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <title>Document</title>
    </head>
    <body>
        {html_body}
    </body>
    </html>
    """

    return html


def convert_md_to_pdf(md_file_path, pdf_file_path):
    """Convert a single markdown file to PDF"""
    try:
        # Read markdown file
        with open(md_file_path, 'r', encoding='utf-8') as f:
            md_content = f.read()

        # Convert to HTML
        html_content = markdown_to_html(md_content)

        # Create PDF
        font_config = FontConfiguration()
        html = HTML(string=html_content)
        css = CSS(string=CSS_STYLE, font_config=font_config)

        html.write_pdf(
            pdf_file_path,
            stylesheets=[css],
            font_config=font_config
        )

        return True
    except Exception as e:
        print(f"Error converting {md_file_path}: {e}")
        return False


def main():
    """Main function to convert all markdown files to PDF"""

    # Check if directories exist
    if not MDS_DIR.exists():
        print(f"Error: Directory {MDS_DIR} does not exist!")
        return 1

    # Create PDFs directory if it doesn't exist
    PDFS_DIR.mkdir(parents=True, exist_ok=True)

    # Find all markdown files
    md_files = list(MDS_DIR.glob("*.md"))

    if not md_files:
        print(f"No markdown files found in {MDS_DIR}")
        return 0

    print(f"Found {len(md_files)} markdown file(s)")
    print("=" * 60)

    converted = 0
    failed = 0

    for md_file in md_files:
        # Generate PDF filename
        pdf_filename = md_file.stem + ".pdf"
        pdf_file_path = PDFS_DIR / pdf_filename

        print(f"Converting: {md_file.name} -> {pdf_filename}... ", end='')

        if convert_md_to_pdf(md_file, pdf_file_path):
            print("✓ Success")
            converted += 1
        else:
            print("✗ Failed")
            failed += 1

    print("=" * 60)
    print(f"Conversion complete!")
    print(f"  Successfully converted: {converted}")
    print(f"  Failed: {failed}")
    print(f"  PDFs saved in: {PDFS_DIR.absolute()}")

    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
