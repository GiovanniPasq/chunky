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

> 🚧 Chunky is in early development and actively evolving — new features and improvements are on the way!

### Why validation matters

Chunking is one of the most underestimated steps in a RAG pipeline. As NVIDIA's research shows in [*Finding the Best Chunking Strategy for Accurate AI Responses*](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/), no single strategy wins universally — the right choice depends on content type and query characteristics, and poor chunking directly degrades retrieval quality and answer coherence. **Chunking is not a set-and-forget parameter**, yet most tools give you zero visibility into what your chunks actually look like. That's the gap Chunky fills.

> New to this space? Check out [**Agentic RAG for Dummies**](https://github.com/GiovanniPasq/agentic-rag-for-dummies) — a hands-on implementation of Agentic RAG, the natural evolution of a basic RAG system.

---

## How it works

1. **Bring your document** — upload a PDF and let Chunky convert it to Markdown, or upload a Markdown file directly if you already have one. Your existing conversion is never overwritten.
2. **Choose your converter** — pick the PDF-to-Markdown engine that best fits your document type. Not happy with the result? Switch converter and re-run without losing your work.
3. **Validate the Markdown** — review the converted text side-by-side with the original PDF before chunking. Catch conversion artifacts early.
4. **Chunk and inspect** — choose a splitting library and strategy, and see every chunk color-coded and enumerable. Spot boundaries that are too aggressive or too loose at a glance.
5. **Edit and fix** — click any chunk to edit its content directly. No need to re-run the whole pipeline to fix one bad split.
6. **Export** — save clean, validated chunks as timestamped JSON, ready to feed into your vector store.

---

## Features

- 📄 Side-by-side PDF + Markdown viewer with synchronized scrolling
- ✨ Four PDF → Markdown converters (PyMuPDF, Docling, MarkItDown, VLM) — skipped if you upload an existing Markdown file
- 🔄 Re-convert on the fly — switch converter and regenerate Markdown without restarting the pipeline
- ✂️ Two splitting libraries — **LangChain** (4 strategies) and **Chonkie** (8 strategies)
- 🎨 Color-coded chunk visualization with per-chunk editing
- 🔌 Pluggable, decorator-based architecture — add a new converter or splitter in minutes with zero frontend changes
- 💾 Export chunks as timestamped JSON, ready for indexing
- 📡 Dynamic `/api/capabilities` endpoint — the frontend discovers all available converters and strategies automatically at startup

---

## PDF → Markdown Converters

Chunky ships with four converters out of the box. You can switch between them in the UI at any time and re-convert the document without losing your chunking settings.

| Converter | Library | Best for |
|-----------|---------|----------|
| **PyMuPDF** *(default)* | `pymupdf4llm` | Fast conversion of standard digital PDFs with selectable text |
| **Docling** | `docling` | Complex layouts: multi-column documents, tables, and figures |
| **MarkItDown** | `markitdown[all]` | Broad-format documents, simple and deterministic output |
| **VLM** | `openai` + any vision model | Scanned PDFs, handwriting, diagrams — anything a human can read |

### VLM converter

The VLM converter rasterises each page at 300 DPI and sends it to any OpenAI-compatible vision model. By default it targets a **locally running Ollama instance** — no API key, no internet access required.

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

VLM conversions report per-page progress, which the frontend polls via `GET /api/convert-progress/{filename}`.

---

## Chunking Strategies

Chunky supports two splitting libraries, each exposing multiple strategies. The library and strategy are selected independently in the UI.

### LangChain (`langchain-text-splitters`)

Install: `pip install langchain-text-splitters tiktoken`

| Strategy | Description |
|----------|-------------|
| **Token** | Splits on token boundaries via tiktoken. Ideal for LLM context-window management. |
| **Recursive** | Tries paragraph → sentence → word boundaries in order. |
| **Character** | Splits on `\n\n` paragraphs, falls back to `chunk_size` characters. |
| **Markdown** | Two-phase split: H1/H2/H3 headers first, then optional size cap via `RecursiveCharacterTextSplitter` (activate with `enable_markdown_sizing`). |

### Chonkie

Install: `pip install chonkie[all]`

| Strategy | Description |
|----------|-------------|
| **Token** | Splits on token boundaries. Fast, no external tokeniser needed. |
| **Fast** | SIMD-accelerated byte-based chunking at 100+ GB/s. Best for high-throughput pipelines. |
| **Sentence** | Splits at sentence boundaries. Preserves semantic completeness. |
| **Recursive** | Recursively splits using structural delimiters (paragraphs → sentences → words). Note: `chunk_overlap` is not supported. |
| **Table** | Splits large Markdown tables by row while preserving headers. Ideal for tabular data. |
| **Code** | Splits source code using AST-based structural analysis. Supports multiple languages. |
| **Semantic** | Groups content by embedding similarity. Best for preserving topical coherence. |
| **Neural** | Uses a fine-tuned BERT model to detect semantic shifts. Great for topic-coherent chunks. |

> **Note:** The **Semantic** and **Neural** strategies download ML models on first use and may be slow to initialise. 

---

## Extending Chunky

The converter and splitter layers are designed to be extended with minimal boilerplate. Both use a **decorator-based registry**: adding a new converter or splitter strategy automatically exposes it through the `/api/capabilities` endpoint and the UI — no frontend changes needed.

### Adding a New Converter

Every converter inherits from `PDFConverter` (`backend/converters/base.py`):

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

To add a new converter, you only need to do two things:

**1. Create a new file in `backend/converters/` and decorate the class**

```python
# backend/converters/my_converter.py
from pathlib import Path
from backend.registry import register_converter
from .base import PDFConverter

@register_converter(
    name="my_converter",
    label="My Converter",
    description="Short description shown in the UI.",
)
class MyConverter(PDFConverter):
    def __init__(self) -> None:
        # Lazy imports are encouraged to avoid slowing down startup
        from my_library import MyParser
        self._parser = MyParser()

    def convert(self, pdf_path: Path) -> str:
        self.validate_path(pdf_path)
        return self._parser.to_markdown(str(pdf_path))
```

**2. Import it in `capabilities_router.py`**

```python
import backend.converters.my_converter  # noqa: F401 — side-effect import
```

**Done.** The new converter appears automatically in `/api/capabilities` and the UI.

### Adding a New Splitter Strategy

Every splitter inherits from `TextSplitter` (`backend/splitters/base.py`). Strategies are individual methods decorated with `@register_splitter`:

```python
# Inside an existing or new TextSplitter subclass
from backend.registry import register_splitter

@register_splitter(
    library="my_lib",
    library_label="My Library",
    strategy="my_strategy",
    label="My Strategy",
    description="Short description shown in the UI.",
)
def _split_my_strategy(self, request: ChunkRequest) -> List[ChunkItem]:
    # your splitting logic here
    splits = my_splitter.split(request.content, request.chunk_size)
    return self.build_chunks(request.content, splits, request.chunk_overlap)
```

Import the module in `capabilities_router.py` and add the strategy to the splitter's `_DISPATCH` table. The strategy will appear in the UI automatically.

---

## Storage Layout

```
docs/
  pdfs/          # uploaded PDF files
  mds/           # converted / uploaded Markdown files
chunks/
  <stem>/        # one directory per document
    <stem>_<UTC-ISO8601>.json   # timestamped chunk exports
```

Chunk files are stored in a normalised enriched format with placeholder fields for `CleanedChunk`, `Title`, `Context`, `Summary`, `Keywords`, and `Questions`, ready for a downstream enrichment pipeline.

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/capabilities` | All registered converters and splitter strategies |
| `GET` | `/api/documents` | List all available documents |
| `GET` | `/api/document/{filename}` | Metadata + Markdown content for a document |
| `GET` | `/api/pdf/{filename}` | Serve a PDF for inline viewing |
| `POST` | `/api/upload` | Upload one or more PDF / Markdown files |
| `POST` | `/api/convert/{filename}` | Convert a PDF to Markdown |
| `GET` | `/api/convert-progress/{filename}` | Poll VLM conversion progress |
| `POST` | `/api/md-to-pdf/{filename}` | Convert Markdown back to PDF |
| `DELETE` | `/api/documents` | Delete one or more documents and derived files |
| `POST` | `/api/chunk` | Split text into chunks |
| `POST` | `/api/chunks/save` | Persist a chunk set to disk |
| `GET` | `/api/chunks/load/{filename}` | Load the latest chunk set for a document |

Full interactive documentation is available at `http://localhost:8000/docs`.

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