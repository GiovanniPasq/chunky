import { afterEach, describe, expect, it, vi } from 'vitest'
import { listChunksVersions } from './chunksApi'
import { listMarkdownVersions } from './markdownsApi'

function mockFetch(response: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
}

describe('version list APIs', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not disguise a Markdown lookup failure as an empty list', async () => {
    mockFetch(new Response('unavailable', { status: 503 }))

    await expect(listMarkdownVersions('report.pdf')).rejects.toThrow('HTTP 503')
  })

  it('does not disguise a chunks lookup failure as an empty list', async () => {
    mockFetch(new Response('broken', { status: 500 }))

    await expect(listChunksVersions('report.pdf')).rejects.toThrow('HTTP 500')
  })

  it('rejects malformed successful responses', async () => {
    mockFetch(new Response('{}', { status: 200 }))

    await expect(listMarkdownVersions('report.pdf')).rejects.toThrow('Invalid Markdown versions response')
  })
})
