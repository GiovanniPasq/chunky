import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cancelPreviewConversion,
  deleteDocumentsByName,
  previewConversion,
  saveMarkdownFile,
  summariseUploadResponse,
  uploadDocumentFiles,
} from './documentsApi'

function mockFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('documentsApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('surfaces backend upload detail messages', async () => {
    mockFetch(new Response(JSON.stringify({ detail: 'too large' }), { status: 422 }))

    await expect(uploadDocumentFiles([
      new File(['pdf'], 'report.pdf', { type: 'application/pdf' }),
    ])).rejects.toThrow('too large')
  })

  it('returns per-file upload results for partial failures', async () => {
    const response = {
      uploaded: 1,
      failed: 1,
      results: [
        { filename: 'ok.pdf', success: true, message: 'Uploaded successfully' },
        { filename: 'bad.pdf', success: false, message: 'not a PDF' },
      ],
    }
    mockFetch(new Response(JSON.stringify(response), { status: 200 }))

    await expect(uploadDocumentFiles([
      new File(['pdf'], 'ok.pdf', { type: 'application/pdf' }),
      new File(['bad'], 'bad.pdf', { type: 'application/pdf' }),
    ])).resolves.toEqual(response)

    expect(summariseUploadResponse(response)).toBe('Uploaded 1; bad.pdf: not a PDF')
  })

  it('fails markdown saves when the document-scoped endpoint fails', async () => {
    mockFetch(new Response(JSON.stringify({ detail: 'write failed' }), { status: 500 }))

    await expect(saveMarkdownFile('report.md', 'report.md', '# Updated')).rejects.toThrow('HTTP 500')
  })

  it('saves markdown through the document-scoped endpoint', async () => {
    const fetchMock = mockFetch(new Response('{}', { status: 200 }))

    await saveMarkdownFile('report.md', 'report.md', '# Updated')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/documents/report.md/markdowns/report.md')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ content: '# Updated' })
  })

  it('returns structured partial document deletion results', async () => {
    const response = {
      success: false,
      deleted: ['docs/pdfs/ok.pdf'],
      deleted_documents: ['ok.pdf'],
      failed: { 'missing.pdf': 'not found' },
      message: 'Deleted 1 document; 1 failed',
    }
    mockFetch(new Response(JSON.stringify(response), { status: 200 }))

    await expect(deleteDocumentsByName(['ok.pdf', 'missing.pdf'])).resolves.toEqual(response)
  })

  it('posts converter preview requests without persisting document data', async () => {
    const fetchMock = mockFetch(new Response(JSON.stringify({
      success: true,
      filename: 'report.pdf',
      converter: 'liteparse',
      start_page: 2,
      end_page: 3,
      page_count: 10,
      md_content: '# Preview',
    }), { status: 200 }))

    await expect(previewConversion({
      filename: 'report.pdf',
      converter: 'liteparse',
      start_page: 2,
      end_page: 3,
    })).resolves.toMatchObject({ md_content: '# Preview' })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/convert/preview')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      filename: 'report.pdf',
      converter: 'liteparse',
      start_page: 2,
      end_page: 3,
    })
  })

  it('posts explicit converter preview cancellation', async () => {
    const fetchMock = mockFetch(new Response('{}', { status: 200 }))

    await cancelPreviewConversion('preview-123')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/convert/preview/preview-123/cancel')
    expect(init.method).toBe('POST')
  })

  it('surfaces converter preview validation details', async () => {
    mockFetch(new Response(JSON.stringify({ detail: 'Preview is limited to 20 pages.' }), { status: 422 }))

    await expect(previewConversion({
      filename: 'report.pdf',
      converter: 'pymupdf',
      start_page: 1,
      end_page: 10,
    })).rejects.toThrow('Preview is limited to 20 pages.')
  })
})
