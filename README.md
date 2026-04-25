<p align="center">
  <img alt="Chunky Logo" src="assets/logo.png" width="350px">
</p>
<h1 align="center">Chunky</h1>
<p align="center">
    <strong>Validate your Markdown. Validate your chunks. Ship RAG pipelines that actually work.</strong>
</p>
<p align="center">
<img src="https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white"/>
<img src="https://img.shields.io/badge/Node.js-22+-339933?style=for-the-badge&logo=node.js&logoColor=white"/>
<img src="https://img.shields.io/badge/FastAPI-0.135+-009688?style=for-the-badge&logo=fastapi&logoColor=white"/>
<img src="https://img.shields.io/badge/React-18+-61DAFB?style=for-the-badge&logo=react&logoColor=white"/>
<img src="https://img.shields.io/badge/License-MIT-D2691E?style=for-the-badge"/>
</p>
<p align="center">
  <img src="assets/demo.gif" width="600">
</p>
<p align="center">
<strong>If you like this project, a star ⭐️ would mean a lot and keep you updated on new features :)</strong>
</p>

---

## Why Chunky?

Most RAG pipelines fail silently — and when they do, the cause is often bad Markdown, bad chunking, or both. When PDFs are converted, tables collapse, layouts scramble, and artifacts bleed into your text. You never see it. You just get hallucinations downstream. Chunky is a local, open-source tool that gives you full visibility at both stages — validate your Markdown, validate your chunks, fix what's wrong before it reaches your vector store.

As [NVIDIA's research](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/) shows, the importance of choosing the right chunking strategy cannot be overstated — no single approach wins universally, and treating it as a set-and-forget parameter leads to silent retrieval failures. Yet most tools give you zero visibility into what your chunks actually look like. That's the gap Chunky fills.

<p align="center">
  <img src="assets/pipeline.svg" width="700">
</p>

> 🚧 Chunky is in early development and actively evolving. Bugs may exist — if you find one, please open an [issue](https://github.com/GiovanniPasq/chunky/issues).

> New to RAG? Check out [**Agentic RAG for Dummies**](https://github.com/GiovanniPasq/agentic-rag-for-dummies) — a hands-on implementation of Agentic RAG.

---

## Features

| | |
|---|---|
| 📄 **Side-by-side viewer** | PDF and Markdown side by side for easy comparison and validation |
| ✨ **Six PDF → Markdown converters** | PyMuPDF, Docling, MarkItDown, LiteParse, VLM, Cloud API |
| 🔄 **Re-convert on the fly** | Switch converter and regenerate without restarting the pipeline |
| 📦 **Bulk PDF conversion** | Convert multiple PDFs to Markdown in a single batch operation |
| ✂️ **14 chunking strategies** | LangChain (4 strategies), Chonkie (8 strategies) and Docling (2 strategies) |
| 📚 **Bulk chunking** | Chunk multiple Markdown files at once with the same configuration |
| 🧠 **Markdown enrichment** *(beta)* | Clean conversion artifacts before chunking |
| ✨ **Chunk enrichment** *(beta)* | LLM-generated titles, summaries, keywords, and questions per chunk |
| 🔌 **Pluggable architecture** | Add a converter or splitter in minutes — zero frontend changes |
| 💾 **Export** | Timestamped JSON chunks, ready for your vector store |

---

## Getting started

Two ways to run Chunky: locally or with Docker.

### Option 1 — Local
```bash
git clone https://github.com/GiovanniPasq/chunky.git
cd chunky
python -m venv .venv
source venv/bin/activate
pip install -r requirements.txt
npm install -g @llamaindex/liteparse  # optional — only needed for the LiteParse converter
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

## PDF → Markdown Converters

No single converter wins on every document type. Chunky ships with six — switch between them in the UI and re-convert without losing your settings.

| Converter | Library | Best for |
|-----------|---------|----------|
| **PyMuPDF** | `pymupdf4llm` | Fast conversion of standard digital PDFs with selectable text |
| **Docling** | `docling` | Complex layouts: multi-column documents, tables, and figures |
| **MarkItDown** | `markitdown[all]` | Broad-format documents, simple and deterministic output |
| **LiteParse** | `liteparse` | Fast, lightweight parsing by LlamaIndex — good for standard documents |
| **VLM** | `openai` + any vision model | Scanned PDFs, handwriting, diagrams — anything a human can read |
| **Cloud API** | `httpx` | POSTs the PDF to a configurable external endpoint and returns the Markdown response body directly |

> **Note:** The **LiteParse** converter requires Node.js and the CLI installed separately: `npm install -g @llamaindex/liteparse`

### VLM converter

The VLM converter rasterises each page at 300 DPI and sends it to any OpenAI-compatible vision model. By default it targets a **locally running Ollama instance** — no API key, no internet access required.

Through the frontend, you can configure the model name, base URL, and API key directly in the UI before requesting a conversion — no code changes needed.

> **Note:** Conversion speed with Docling or a locally running Ollama instance depends heavily on available hardware. On CPU-only machines, both can be significantly slower than on systems with a dedicated GPU.

> **Ollama configuration:** when using a local Ollama instance, the most relevant environment variables are `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE`, and `OLLAMA_MAX_QUEUE`. See the [Ollama FAQ](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests) for setup instructions.

---

## Chunking Strategies

Chunky supports two splitting libraries, each exposing multiple strategies. The library and strategy are selected independently in the UI.

### LangChain (`langchain-text-splitters`)

| Strategy | Description |
|----------|-------------|
| **Token** | Splits on token boundaries via tiktoken. Ideal for LLM context-window management. |
| **Recursive** | Tries paragraph → sentence → word boundaries in order. |
| **Character** | Splits on `\n\n` paragraphs, falls back to `chunk_size` characters. |
| **Markdown** | Two-phase split: H1/H2/H3 headers first, then optional size cap via `RecursiveCharacterTextSplitter`. |

### Chonkie

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

### Docling (`docling`)

| Strategy | Description |
|----------|-------------|
| **Hybrid** | Hierarchical document-aware chunking with tokenization-aware refinements. Merges undersized chunks and supports header repetition across table splits. |
| **Line-Based** | Preserves line boundaries with optional repeated prefix per chunk (e.g. table headers). Best for tables, code, and logs where line integrity matters. |

> **Note:** Both **Docling** strategies operate on `DoclingDocument` objects and require the `docling` library. The **Hybrid** strategy downloads a tokenizer model on first use.

---

## Enrichment *(beta)*

> ⚠️ Enrichment features are currently in beta and may change in future releases.

Chunky includes an LLM-powered enrichment layer that operates at two levels of the pipeline.

### Markdown enrichment

Before chunking, you can run enrichment directly on the converted Markdown. This step cleans up residual conversion artifacts — noise, formatting inconsistencies, extraction errors — producing a polished document that leads to cleaner, more coherent chunks downstream.

### Chunk enrichment

After chunking, each chunk can be enriched independently via an LLM call. The pipeline populates the following fields:

| Field | Description |
|-------|-------------|
| `cleaned_chunk` | Cleaned and normalized version of the original text |
| `title` | Short descriptive title for the chunk |
| `context` | One sentence describing where the chunk fits within the broader document |
| `summary` | One sentence summary of the chunk content |
| `keywords` | Array of relevant keyword strings |
| `questions` | Array of questions this chunk could answer |

The `context` field is inspired by Anthropic's [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) technique, which shows that prepending a short chunk-specific context can reduce retrieval failure rates by up to 49%.

The `questions` field addresses a complementary problem: pre-generating the questions a chunk can answer produces embeddings much closer to real user queries at retrieval time, as highlighted in the [Microsoft Azure RAG enrichment guide](https://learn.microsoft.com/en-us/azure/architecture/ai-ml/guide/rag/rag-enrichment-phase).

---

## Extending Chunky

The converter and chunker layers use a **decorator-based registry**: adding a new converter or chunker automatically exposes it through the `/api/capabilities` endpoint and the UI — no frontend changes needed.

### Adding a new converter

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

**1. Create a new file in `backend/converters/` and decorate the class:**

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
        from my_library import MyParser
        self._parser = MyParser()

    def convert(self, pdf_path: Path) -> str:
        self.validate_path(pdf_path)
        return self._parser.to_markdown(str(pdf_path))
```

**2. Import it in `capabilities_router.py`:**

```python
import backend.converters.my_converter  # noqa: F401 — side-effect import
```

Done. The new converter appears automatically in `/api/capabilities` and the UI.

### Adding a new chunker strategy

```python
from backend.registry import register_chunker

@register_chunker(
    library="my_lib",
    library_label="My Library",
    strategy="my_strategy",
    label="My Strategy",
    description="Short description shown in the UI.",
)
def _chunk_my_strategy(self, request: ChunkRequest) -> list[ChunkItem]:
    splits = my_chunker.split(request.content, request.chunk_size)
    return self.build_chunks(request.content, splits, request.chunk_overlap)
```

Import the module in `capabilities_router.py` and add the strategy to the chunker's `_DISPATCH` table. The strategy appears in the UI automatically.

---

## Storage layout

```
docs/
  pdfs/          # uploaded PDF files
  mds/           # converted / uploaded Markdown files
chunks/
  <stem>/        # one directory per document
    <stem>_<library>-<strategy>_<HH-MM-SS>.json
```