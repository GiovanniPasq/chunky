<p align="center">
  <img alt="Chunky Logo" src="frontend/src/assets/logo.png" width="180px">
</p>
<h1 align="center">Chunky</h1>
<p align="center">
    <strong>See what happens to your documents before they enter your RAG pipeline.</strong>
</p>
<p align="center">
  A local, open-source workspace to inspect PDF conversion, refine Markdown, compare chunking strategies, and review chunks before indexing.
</p>
<p align="center">
<img src="https://img.shields.io/badge/Python-3.11+-3776AB?style=for-the-badge&logo=python&logoColor=white"/>
<img src="https://img.shields.io/badge/Node.js-24+-339933?style=for-the-badge&logo=node.js&logoColor=white"/>
<img src="https://img.shields.io/badge/FastAPI-0.162+-009688?style=for-the-badge&logo=fastapi&logoColor=white"/>
<img src="https://img.shields.io/badge/React-19+-61DAFB?style=for-the-badge&logo=react&logoColor=white"/>
<img src="https://img.shields.io/badge/Vite-8+-646CFF?style=for-the-badge&logo=vite&logoColor=white"/>
<img src="https://img.shields.io/badge/License-MIT-D2691E?style=for-the-badge"/>
</p>
<p align="center">
  <img src="assets/demo.gif" width="800" alt="Chunky demo: upload a PDF, convert and edit Markdown, configure chunks, and enrich them with a local model">
</p>

---

## Overview

Chunky is a local, open-source workspace for preparing documents for Retrieval-Augmented Generation (RAG). It combines PDF-to-Markdown conversion, Markdown cleanup, chunk visualization, chunking strategy comparison, and LLM-powered enrichment in one workflow.

Broken tables, scrambled layouts, noisy Markdown, and poor chunk boundaries can undermine retrieval. Chunky makes those problems visible so you can inspect and fix the document before it reaches your vector store.

As [NVIDIA's research](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/) shows, no chunking strategy wins universally. Chunky helps you compare strategies on the actual document instead of treating chunking as a hidden parameter.

<p align="center">
  <img src="assets/pipeline.svg" width="700">
</p>

> New to RAG? Check out [**Agentic RAG for Dummies**](https://github.com/GiovanniPasq/agentic-rag-for-dummies) — a hands-on implementation of Agentic RAG.

---

## Features

| | |
|---|---|
| **Document review workspace** | Compare PDF, Markdown, and chunks side by side before indexing |
| **Multiple conversion engines** | PyMuPDF, Docling, MarkItDown, LiteParse, VLM, and Cloud API support |
| **Linked page navigation** | Navigate PDF and Markdown pages together, with page-aware scroll synchronization |
| **Bulk export** | Export selected documents or the whole workspace as a ZIP or to a backend folder |
| **Batch processing** | Convert, enrich, and chunk multiple documents from the sidebar |
| **Chunking strategy comparison** | Test LangChain, Chonkie, and Docling splitters with configurable size and overlap |
| **Saved chunk versions** | Persist and reload chunk sets by Markdown source and splitter configuration |
| **Markdown enrichment** | Clean conversion artifacts with deterministic cleanup plus LLM correction |
| **Chunk enrichment** | Generate context-aware titles, summaries, keywords, and retrieval questions |
| **Pluggable backend** | Discover registered converters and splitters dynamically through the capabilities API |

Saved chunks retain the SHA-256 revision of the Markdown that produced them.
If the Markdown changes, the saved set remains available for inspection but
must be regenerated before it can overwrite a current chunk version.

---

## Getting Started

Two ways to run Chunky: locally or with Docker.

### Option 1 — Local

macOS, Linux, or WSL:

```bash
git clone https://github.com/GiovanniPasq/chunky.git
cd chunky
./start_all.sh
```

Windows PowerShell:

```powershell
git clone https://github.com/GiovanniPasq/chunky.git
cd chunky
.\start_all.ps1
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

If Chunky is useful to you, a star on GitHub helps others discover the project.

---

## Exporting saved outputs

Use **Export all**, or **Select → Export selected**, for a ZIP download or a folder
on the backend machine. Choose Markdown, saved chunk JSON, optional PDFs, and
latest matching outputs or all versions. Save active edits first. Each export
includes a manifest with missing-file and stale-chunk warnings.

Folder exports use `EXPORTS_DIR` (default `docs/exports`), with an optional child
folder and a unique directory per export. Set an absolute `EXPORTS_DIR` in the
backend environment to change the root; mount it explicitly when using Docker.
Workspace files stay in place. Downloads use a location picker where supported.

## Development checks

Run the backend regression suite from the repository root:

```bash
# Using uv (recommended):
uv run python -m unittest discover -s tests

# Or using the local virtual environment:
./.venv/bin/python -m unittest discover -s tests
```

Run frontend type checking and production build from `frontend/`:

```bash
npm test
npm run typecheck
npm run build

# Browser regression tests (install the browser once):
npx playwright install chromium
npm run test:e2e
# To use an installed Google Chrome instead:
PLAYWRIGHT_CHANNEL=chrome npm run test:e2e
```

---

## PDF to Markdown Converters

No single converter wins on every document type. Chunky ships with six — switch between them in the UI and re-convert whenever you want to replace a converter's existing output.

| Converter | Library | Best for |
|-----------|---------|----------|
| **PyMuPDF** | `pymupdf4llm` | Fast conversion of standard digital PDFs with selectable text |
| **Docling** | `docling` | Complex layouts: multi-column documents, tables, and figures |
| **MarkItDown** | `markitdown[pdf]` | Simple, deterministic conversion of standard PDFs |
| **LiteParse** | `liteparse` | Fast, model-free PDF-to-Markdown parsing by LlamaIndex |
| **VLM** | `openai` + any vision model | Scanned PDFs, handwriting, diagrams — anything a human can read |
| **Cloud API** | `httpx` | POSTs the PDF to a configurable external endpoint and returns the Markdown response body directly |

Standalone Markdown names that match the generated
`{pdf_stem}_{converter}.md` pattern are reserved when the corresponding PDF
exists. Chunky rejects that ambiguous upload instead of silently treating it
as converter output.

PyMuPDF, Docling, LiteParse, and VLM preserve physical source-page numbers with
`<!-- page-marker:N -->` comments, including blank pages. Docling compound items
such as merged tables remain attached to their first provenance page. Page markers
stay outside model-editable enrichment pieces. Reconvert older Markdown to add
page mapping. MarkItDown and arbitrary Cloud API responses can still be used;
page mapping is available only when the resulting Markdown contains valid markers.

Use Previous/Next or enter a page number in either viewer to navigate linked
pages. **Page sync** follows the source page and relative position within it;
it does not promise paragraph-level alignment. **Approx. sync** uses document
scroll percentages when page mapping is unavailable, including chunk views.
Turn sync off for independent navigation. Page labels in Markdown still jump to
the corresponding PDF page explicitly. **Link pages…** offers reconversion for
older output without a page map; reconversion replaces that converter's Markdown.

### VLM converter

The VLM converter rasterises each page at 300 DPI by default and sends it to any OpenAI-compatible vision model. By default it targets a **locally running Ollama instance** — no API key, no internet access required.

Through the frontend, you can configure the model name, base URL, and API key directly in the UI before requesting a conversion — no code changes needed.

> **Note:** Conversion speed with Docling or a locally running Ollama instance depends heavily on available hardware. On CPU-only machines, both can be significantly slower than on systems with a dedicated GPU.

> **Ollama configuration:** when using a local Ollama instance, the most relevant environment variables are `OLLAMA_NUM_PARALLEL`, `OLLAMA_MAX_LOADED_MODELS`, `OLLAMA_KEEP_ALIVE`, and `OLLAMA_MAX_QUEUE`. See the [Ollama FAQ](https://docs.ollama.com/faq#how-does-ollama-handle-concurrent-requests) for setup instructions.

---

## Chunking Strategies

Chunky supports three splitting libraries, each exposing multiple strategies. The library and strategy are selected independently in the UI; size and overlap controls apply where the selected strategy supports them.

### LangChain (`langchain-text-splitters`)

| Strategy | Description |
|----------|-------------|
| **Token** | GPT-2 token windows with Unicode-safe boundaries and matching source offsets. |
| **Recursive** | Tries Markdown structures, paragraphs, lines, words, and finally characters. Size and overlap are in characters. |
| **Character** | Splits on `\n\n` paragraphs, falls back to `chunk_size` characters. |
| **Markdown** | Two-phase split: H1/H2/H3 headers first, then optional size cap via `RecursiveCharacterTextSplitter`. |

### Chonkie

| Strategy | Description |
|----------|-------------|
| **Token** | GPT-2 token windows with Unicode-safe boundaries and matching source offsets. |
| **Fast** | SIMD-accelerated byte-based chunking. Uses a byte target; keeping a UTF-8 character intact may add up to 3 bytes. No overlap. |
| **Sentence** | Uses a character target and keeps whole sentences. A long sentence can exceed the target; overlap includes only whole sentences that fit. |
| **Recursive** | Splits using structural delimiters (paragraphs → sentences → words) and a character target. No overlap. |
| **Table** | Splits Markdown tables into 3 data rows per chunk, repeats headers, and preserves surrounding prose. Size and overlap controls do not apply. |
| **Code** | Splits source code using AST structure and a character target; overlap does not apply. Requires optional `chonkie[code]` dependencies. |
| **Semantic** | Groups content by embedding similarity with a token target measured by the embedding model's tokenizer. Long sentences may exceed it. No overlap. |
| **Neural** | Uses a fine-tuned BERT model to detect semantic shifts; size and overlap controls do not apply. |

> **Note:** The **Semantic** and **Neural** strategies download ML models on first use and may be slow to initialise. Code chunking may also download parser grammars on first use.

Token overlap is a target: boundaries move to keep complete Unicode characters, so actual overlap can be smaller. Both Token implementations use the same GPT-2 encoding, which may differ from your embedding model's tokenizer.

### Docling (`docling`)

| Strategy | Description |
|----------|-------------|
| **Hybrid** | Document-structure-aware chunking that respects headings, tables, and lists while enforcing a token limit. |
| **Line-Based** | Preserves line boundaries while enforcing a token limit. Best for tables, code, and logs where line integrity matters. |

> **Note:** Hybrid operates on a parsed `DoclingDocument`; Line-Based uses the original source lines. Both require `docling` and may download their tokenizer on first use.

Some serializers transform content, such as converting a table into descriptive text. When no contiguous source span can be located, chunks use `start: 0`, `end: 0` and `metadata.source_span_available: false` instead of guessed offsets. Regenerate previously saved chunks to apply updated splitting and source-span behavior.

### Cancellation behavior

VLM, Cloud, and enrichment requests support cooperative interruption. CPU
conversion and chunking batches run in request-owned process pools. Pressing
Interrupt cancels queued jobs and terminates every running worker in that
batch; another request uses a different pool and is unaffected.

---

## Enrichment

Chunky includes an LLM-powered enrichment layer that operates at two levels of the pipeline.

### Markdown enrichment

Before chunking, you can run enrichment directly on the converted Markdown. The pipeline:

1. **Deterministic cleanup** — removes likely pagination noise, repeated headers/footers, invisible characters, mojibake, and conservative line-wrap artifacts while preserving fenced code
2. **LLM correction** — splits the document into pieces and sends each to an LLM for contextual cleanup, producing coherent, well-structured Markdown
3. **Summary** *(optional)* — generates a document-level summary used as context during LLM correction

Markdown enrichment is available for both single files and **bulk operations**, so you can clean an entire batch of converted PDFs in one pass.

### Chunk enrichment

After chunking, selected chunks can be enriched via LLM calls. Sidebar bulk enrichment can also enrich saved chunk sets, or chunk first when no matching saved set exists.

Each call analyzes the selected chunk itself and, when available, also receives:

- the cached document-level summary, generated by the Markdown enrichment flow
- a small read-only window of Markdown immediately before and after the chunk

Those extra inputs help the model disambiguate names, acronyms, headings, and section intent without copying neighboring text into the enriched chunk. The pipeline populates the following fields:

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

The capability registry supplies converter/library/strategy choices and labels.
Request validation, worker dispatch, saved-file naming, and parameter semantics
still need the registrations below. Registering a decorator alone does not make
an implementation executable.

### Adding a new converter

Create a `PDFConverter` subclass in `backend/converters/`. Keep heavy imports and
parser initialization lazy. `convert(pdf_path, total_pages=None)` must return the
complete Markdown string and call `validate_path` before reading the PDF.

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
        from my_library import MyParser  # replace with your library's actual API
        self._parser = MyParser()

    def convert(self, pdf_path: Path, total_pages: int | None = None) -> str:
        self.validate_path(pdf_path)
        return self._parser.to_markdown(str(pdf_path))
```

1. Add `my_converter = "my_converter"` to `ConverterType` in
   `backend/models/schemas.py`.
2. Import the class and add `ConverterType.my_converter: MyConverter` to
   `_CONVERTER_MAP` in `backend/services/document_service.py`. Converters needing
   request-specific options also need schema fields and `_build_converter` wiring.
3. Add `"my_converter": "myconverter"` to `CONVERTER_NORMALIZATION` in
   `backend/utils/naming.py`. This keeps Markdown variants, ownership checks,
   saved chunks, and bulk export associated with the original document.
4. Import the module in `backend/routers/capabilities_router.py` so its decorator
   runs before capability discovery. The worker must also import the class
   through its dispatch module; a router-only import does not wire execution.
5. Add required dependencies to `pyproject.toml` and `requirements.txt`, update
   `uv.lock`, and test conversion, preview, variant listing, and export.

For page-aware output, use `page_markdown` from `backend/converters/pages.py` with
`(physical_page_number, markdown)` pairs and the total source-page count. It adds
`<!-- page-marker:N -->` comments and preserves blank or missing pages. Advertise
`page_mapping=True` in `@register_converter` only when the adapter produces this
mapping. Actual linking is checked against the saved Markdown; the flag enables
reconversion of older output. Keep structured items on their source pages without
duplicating their text across page boundaries.

### Adding a strategy to an existing chunker

Add a decorated method **inside** the existing chunker class. For example, this
character-based strategy belongs inside `LangChainChunker` and uses its existing
imports and `build_chunks` helper:

```python
@register_chunker(
    library="langchain",
    library_label="LangChain",
    strategy="custom_recursive",
    label="Custom Recursive",
    description="Splits paragraphs and lines using a character budget.",
)
def _split_custom_recursive(self, request: ChunkRequest) -> list[ChunkItem]:
    splitter = RecursiveCharacterTextSplitter(
        separators=["\n\n", "\n", " ", ""],
        chunk_size=request.chunk_size,
        chunk_overlap=request.chunk_overlap,
    )
    return self.build_chunks(
        request.content, splitter.split_text(request.content),
        char_overlap=request.chunk_overlap,
    )
```

Add `custom_recursive = "custom_recursive"` to `ChunkerType`, then add
`ChunkerType.custom_recursive: _split_custom_recursive` to that class's `_DISPATCH`
table. Existing chunker modules are already imported by capability discovery.

### Adding a chunker library

Implement `TextChunker.chunk(request)` in `backend/chunkers/`, then add the library
to `ChunkerLibrary`, export its class from `backend/chunkers/__init__.py`, and wire
it into `_LIBRARY_MAP` in `backend/services/chunking_service.py`. Import its module
in `capabilities_router.py` and add its token to `KNOWN_LIBRARIES` in
`backend/utils/naming.py`. Use a lowercase alphanumeric library token such as
`mylib`; filenames separate the library and algorithm with a hyphen.

For any new strategy or library, keep `params_used_by` in `backend/utils/naming.py`
and `chunkingOptions` in `frontend/src/utils/chunkingOptions.ts` consistent with
its actual size units and supported overlap. Those rules control validation,
settings inputs, cache signatures, and saved-version matching. The example above
uses the existing LangChain character/overlap defaults; token-, row-, or
model-defined strategies need corresponding rules and tests.

Chunk offsets must be Python character indices into the original Markdown,
with an exclusive `end`. `build_chunks` accepts **character** overlap, not token
or byte counts. Token/byte strategies must map boundaries back to the source.
If no contiguous span is available, preserve `metadata.source_span_available:
false` with `start: 0, end: 0`; merge extra metadata instead of replacing it.
Test Unicode, overlap, source spans, ignored parameters, and saved-version reloads.

Frontend actions use `FeatureIcon`: Markdown for conversion, scissors for
chunking, and sparkles for enrichment. Reuse it when adding new actions.
