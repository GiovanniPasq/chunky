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
<img src="https://img.shields.io/badge/FastAPI-0.115+-009688?style=for-the-badge&logo=fastapi&logoColor=white"/>
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

**Chunky** is a local, open-source tool designed to make chunk validation the first-class citizen it should be in any RAG pipeline. Before you index a single vector, Chunky lets you **see exactly what your chunks look like** — and fix what's wrong.

The core workflow is simple: bring your document as a PDF or an existing Markdown file, pick a chunking strategy, and inspect every chunk side-by-side with the source. If the conversion or the split doesn't look right, you edit it directly in the UI. Only when the chunks are clean do you export them for indexing.

### Why validation matters

Chunking is one of the most underestimated steps in a RAG pipeline. As NVIDIA's research shows in [*Finding the Best Chunking Strategy for Accurate AI Responses*](https://developer.nvidia.com/blog/finding-the-best-chunking-strategy-for-accurate-ai-responses/), no single strategy wins universally — the right choice depends on content type and query characteristics, and poor chunking directly degrades retrieval quality and answer coherence. **Chunking is not a set-and-forget parameter**, yet most tools give you zero visibility into what your chunks actually look like. That's the gap Chunky fills.

> New to this space? Check out [**Agentic RAG for Dummies**](https://github.com/GiovanniPasq/agentic-rag-for-dummies) — a hands-on implementation of Agentic RAG, the natural evolution of a basic RAG system.

---

## How it works

1. **Bring your document** — upload a PDF and let Chunky convert it to Markdown, or upload a Markdown file directly if you already have one. Your existing conversion is never overwritten.
2. **Validate the Markdown** — review the converted text side-by-side with the original PDF before chunking. Catch conversion artifacts early.
3. **Chunk and inspect** — choose a splitting strategy and see every chunk color-coded and enumerable. Spot boundaries that are too aggressive or too loose at a glance.
4. **Edit and fix** — click any chunk to edit its content directly. No need to re-run a pipeline to fix one bad split.
5. **Export** — save clean, validated chunks as timestamped JSON, ready to feed into your vector store.

---

## Features

- 📄 Side-by-side PDF + Markdown viewer with synchronized scrolling
- ✨ PDF → Markdown conversion (powered by pymupdf4llm, swappable) — skipped if you upload an existing Markdown file
- ✂️ Four splitters: Token, Recursive Character, Character, Markdown Header
- 🎨 Color-coded chunk visualization with per-chunk editing
- 💾 Export chunks as timestamped JSON, ready for indexing

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

## Project Structure
```
chunky/
├── main.py
├── start_all.sh
├── Dockerfile
├── docker-compose.yml
├── backend/
│   ├── routers/         # documents_router, chunks_router
│   ├── services/        # document_service, chunking_service, chunk_storage_service
│   ├── models/          # schemas.py
│   └── utils/           # pdf_converter.py (pluggable), md_to_pdf.py
├── docs/
│   ├── pdfs/
│   └── mds/
├── chunks/
└── frontend/
    ├── Dockerfile
    └── src/
        ├── App.tsx
        ├── hooks/useDocument.ts
        └── components/
            ├── layout/      # Sidebar, Toolbar
            ├── viewer/      # PDFViewer, MarkdownViewer
            └── chunks/      # ChunkSettingsModal, ChunkEditModal
```

---

## Contributing

Contributions are welcome — feel free to open an issue or submit a PR!