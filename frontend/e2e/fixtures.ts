import type { Page } from '@playwright/test'

export const markdown =
  '# Annual report\n\nDocument preparation and retrieval quality.\n\n## Findings\n\n- Preserve document structure.\n- Review chunks before indexing.\n'
const mdFilename = 'Annual report_pymupdf4llm.md'
const chunksFilename = 'Annual report_langchain_token_512_51.json'

export async function mockWorkspace(page: Page, chunkDelay = 0) {
  let content = markdown
  let saved = false
  let chunkRequests = 0
  const documents = [
    'Annual report.pdf',
    'Notes.md',
    'Unconverted.pdf',
    'Partial.pdf',
  ]
  const versions = () =>
    saved
      ? [
          {
            filename: chunksFilename,
            md_filename: mdFilename,
            md_source: 'pymupdf4llm',
            library: 'langchain',
            algorithm: 'token',
            chunk_size: 512,
            chunk_overlap: 51,
            source_hash: 'sample-hash',
            is_stale: false,
          },
        ]
      : []
  const chunks = () => [{ index: 0, content, start: 0, end: content.length }]
  await page.route('**/api/**', async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname)
    const json = (value: unknown) => route.fulfill({ json: value })
    if (path === '/api/export/config') return json({ directory: '/workspace/exports' })
    if (path === '/api/documents') return json(documents)
    if (path === '/api/documents/metadata')
      return json(
        documents.map((filename) => ({
          filename,
          has_markdown: filename !== 'Unconverted.pdf',
          has_failures: filename === 'Partial.pdf',
        })),
      )
    if (path === '/api/capabilities')
      return json({
        converters: [
          {
            name: 'pymupdf',
            page_mapping: true,
            label: 'PyMuPDF',
            description: 'Fast conversion for searchable PDFs.',
          },
        ],
        chunkers: [
          {
            library: 'langchain',
            label: 'LangChain',
            strategies: [
              {
                strategy: 'token',
                label: 'Token',
                description: 'Split on token boundaries.',
              },
              {
                strategy: 'recursive',
                label: 'Recursive',
                description: 'Preserve structural boundaries.',
              },
            ],
          },
        ],
      })
    if (path.startsWith('/api/pdf/'))
      return route.fulfill({
        contentType: 'application/pdf',
        body: samplePdf(),
      })
    if (path.startsWith('/api/document/')) {
      const filename = path.split('/').at(-1)!
      return json({
        pdf_filename: filename,
        md_filename: mdFilename,
        md_content: content,
        has_pdf: filename.endsWith('.pdf'),
        has_markdown: filename !== 'Unconverted.pdf',
      })
    }
    if (path.endsWith('/markdowns'))
      return json({
        versions: [
          {
            filename: mdFilename,
            source: 'converted',
            converter: 'pymupdf4llm',
          },
        ],
      })
    if (path.includes('/markdowns/')) {
      if (route.request().method() === 'PUT')
        content = route.request().postDataJSON().content
      return json({
        filename: mdFilename,
        content,
        source: 'converted',
        converter: 'pymupdf4llm',
      })
    }
    if (path.endsWith('/chunks')) return json({ versions: versions() })
    if (path === '/api/chunks/save') {
      saved = true
      return json({ path: chunksFilename })
    }
    if (path.includes('/chunks/'))
      return json({ chunks: chunks(), source_hash: 'sample-hash' })
    if (path === '/api/chunk') {
      chunkRequests += 1
      if (chunkDelay)
        await new Promise((resolve) => setTimeout(resolve, chunkDelay))
      const filename = route.request().postDataJSON().filenames[0]
      const events = [
        { type: 'file_start', filename, index: 1, total: 1 },
        {
          type: 'file_done',
          filename,
          success: true,
          chunks: chunks(),
          source_hash: 'sample-hash',
          md_filename: mdFilename,
        },
        { type: 'batch_done' },
      ]
      try {
        await route.fulfill({
          contentType: 'text/event-stream',
          body: events
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(''),
        })
      } catch {
        /* The cancellation test deliberately aborts this request. */
      }
      return
    }
    if (path.includes('/summary'))
      return route.fulfill({ status: 404, json: { detail: 'No summary' } })
    throw new Error(`Unmocked API request: ${route.request().method()} ${path}`)
  })
  return { chunkRequests: () => chunkRequests }
}

export async function openDocument(page: Page) {
  await page
    .getByRole('button', { name: 'Annual report.pdf', exact: true })
    .click()
  await page.locator('.markdown-content h1').first().waitFor()
}

export function samplePdf(heights = [792]): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${heights.map((_, index) => `${3 + index * 3} 0 R`).join(' ')}] /Count ${heights.length} >>`,
  ]
  heights.forEach((height, index) => {
    const first = 3 + index * 3
    const stream = 'BT /F1 22 Tf 50 720 Td (Annual report) Tj 0 -40 Td /F1 12 Tf (Document preparation and retrieval quality) Tj ET'
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 ${height}] /Resources << /Font << /F1 ${first + 1} 0 R >> >> /Contents ${first + 2} 0 R >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    )
  })
  let output = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((object, index) => {
    offsets.push(output.length)
    output += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = output.length
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(output)
}
