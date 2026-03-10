<p align="center">
  <img alt="Chunky Logo" src="assets/logo.png" width="350px">
</p>
<h1 align="center">Chunky</h1>
<p align="center">
<strong>Validate, visualize, edit, and export chunks for RAG pipelines.</strong>
</p>
<p align="center">
<img src="https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white"/>
<img src="https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white"/>
<img src="https://img.shields.io/badge/FastAPI-0.135+-009688?style=for-the-badge&logo=fastapi&logoColor=white"/>
<img src="https://img.shields.io/badge/React-18+-61DAFB?style=for-the-badge&logo=react&logoColor=black"/>
<img src="https://img.shields.io/badge/License-MIT-D2691E?style=for-the-badge"/>
</p>
<p align="center">
  <img src="assets/demo.gif" width="650">
</p>
<p align="center">
<strong>If you like this project, a star ⭐️ would mean a lot and keep you updated on new features :)</strong>
</p>

---

## Overview

**Chunky** is a local, open-source tool that makes chunk validation the first-class citizen it should be in any RAG pipeline. Before you index a single vector, Chunky lets you **see exactly what your chunks look like** — and fix what's wrong.

The core workflow is simple: bring your document as a PDF or an existing Markdown file, pick a conversion strategy and a chunking strategy, and inspect every chunk side-by-side with the source. If something looks off, edit it directly in the UI. Only when the chunks are clean do you export them for indexing.

### Why validation matters

Chunking is one of the most underestimated steps in a RAG pipeline. As NVIDIA's research shows in [*Finding the Best Chunking Strategy for Accurate AI Responses*](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/), no single strategy wins universally — the right choice depends on content type and query characteristics, and poor chunking directly degrades retrieval quality and answer coherence. **Chunking is not a set-and-forget parameter**, yet most tools give you zero visibility into what your chunks actually look like. That's the gap Chunky fills.

> New to this space? Check out [**Agentic RAG for Dummies**](https://github.com/GiovanniPasq/agentic-rag-for-dummies) — a hands-on implementation of Agentic RAG, the natural evolution of a basic RAG system.

---

## How it works

1. **Bring your document** — upload a PDF and let Chunky convert it to Markdown, or upload a Markdown file directly if you already have one. Your existing conversion is never overwritten.
2. **Choose your converter** — pick the PDF-to-Markdown engine that best fits your document type. Not happy with the result? Switch converter and re-run without losing your work.
3. **Validate the Markdown** — review the converted text side-by-side with the original PDF before chunking. Catch conversion artifacts early.
4. **Chunk and inspect** — choose a splitting strategy and see every chunk color-coded and enumerable. Spot boundaries that are too aggressive or too loose at a glance.
5. **Edit and fix** — click any chunk to edit its content directly. No need to re-run the whole pipeline to fix one bad split.
6. **Export** — save clean, validated chunks as timestamped JSON, ready to feed into your vector store.

---

## Features

- 📄 Side-by-side PDF + Markdown viewer with synchronized scrolling
- ✨ Four PDF → Markdown converters (pymupdf4llm, Docling, MarkItDown, VLM) — skipped if you upload an existing Markdown file
- 🔄 Re-convert on the fly — switch converter and regenerate Markdown without restarting the pipeline
- ✂️ Four splitters: Token, Recursive Character, Character, Markdown Header
- 🎨 Color-coded chunk visualization with per-chunk editing
- 🔌 Pluggable converter architecture — add a new engine in minutes
- 💾 Export chunks as timestamped JSON, ready for indexing

---

## PDF → Markdown Converters

Chunky ships with four converters out of the box. You can switch between them in the UI at any time and re-convert the document without losing your chunking settings.

| Converter | Library | Best for |
|-----------|---------|----------|
| **PyMuPDF** *(default)* | `pymupdf4llm` | Fast conversion of standard digital PDFs with selectable text |
| **Docling** | `docling` | Complex layouts: multi-column documents, tables, and figures |
| **MarkItDown** | `markitdown` | Broad-format documents, simple and deterministic output |
| **VLM** | `openai` + any vision model | Scanned PDFs, handwriting, diagrams — anything a human can read |

### VLM converter

The VLM converter sends each page as a rasterised image to any OpenAI-compatible vision model. By default it targets a **locally running Ollama instance** — no API key, no internet access required.

```python
# Default — Ollama (local, no API key needed)
VLMConverter()

# Different local model
VLMConverter(model="minicpm-v")

# OpenAI
VLMConverter(model="gpt-4o", base_url="https://api.openai.com/v1", api_key="sk-...")

# Google Gemini
VLMConverter(
    model="gemini-2.5-flash",
    base_url="https://generativelanguage.googleapis.com/v1beta/openai/",
    api_key="AIza...",
)
```

---

## Extending Chunky — Adding a New Converter

The conversion layer is designed to be extended. Every converter inherits from a single abstract base class defined in `backend/utils/base.py`:

```python
from abc import ABC, abstractmethod
from pathlib import Path

class PDFConverter(ABC):
    @abstractmethod
    def convert(self, pdf_path: Path) -> str:
        """Convert a PDF to a Markdown string."""

    def validate_path(self, pdf_path: Path) -> None:
        if not pdf_path.exists():
            raise FileNotFoundError(f"PDF file not found: {pdf_path}")
```

To add a new converter, you only need to do three things:

**1. Create a new file in `backend/utils/`**

```python
# backend/utils/my_converter.py
from pathlib import Path
from .base import PDFConverter

class MyConverter(PDFConverter):
    def __init__(self) -> None:
        # initialise your library here (lazy imports are encouraged)
        from my_library import MyParser
        self._parser = MyParser()

    def convert(self, pdf_path: Path) -> str:
        self.validate_path(pdf_path)
        # your conversion logic here
        return markdown_string
```

**2. Register it in `backend/utils/pdf_converter.py`**

```python
from .my_converter import MyConverter

CONVERTERS = {
    "pymupdf":     PyMuPDFConverter,
    "docling":     DoclingConverter,
    "markitdown":  MarkItDownConverter,
    "vlm":         VLMConverter,
    "my_converter": MyConverter,   # <-- add this line
}
```

**3. Done.** Add the new option to the frontend converter selector.

> **Tip:** Use lazy imports inside `__init__` (like Docling and MarkItDown do) to avoid slowing down startup when your converter is not selected.

---

## Getting Started

There are two ways to run Chunky: locally or with Docker.

### Option 1 — Local
```bash
git clone https://github.com/GiovanniPasq/chunky.git
cd chunky
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
./start_all.sh
```

### Option 2 — Docker
```bash
git clone https://github.com/GiovanniPasq/chunky.git
cd chunky
docker compose up --build
```

| Service  | URL                        |
|----------|----------------------------|
| Frontend | http://localhost:5173      |
| Backend  | http://localhost:8000      |
| Swagger  | http://localhost:8000/docs |

---

## Contributing

Contributions are welcome — feel free to open an issue or submit a PR!