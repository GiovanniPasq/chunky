import { describe, expect, it } from 'vitest'
import { parseDocumentPages } from './documentPages'
import { positionAt, scrollTarget } from './viewerPosition'

describe('source page mapping', () => {
  it('preserves empty pages, content before markers, and code indentation', () => {
    const pages = parseDocumentPages('Preface\n<!-- page-marker:1 -->\n    code\n\n---\n\n<!-- page-marker:2 -->\n')
    expect(pages).toEqual([{ page: 1, content: 'Preface\n\n    code' }, { page: 2, content: '' }])
  })
  it('does not interpret fenced or inline marker examples as provenance', () => {
    expect(parseDocumentPages('```md\n<!-- page-marker:1 -->\n```')).toBeNull()
    expect(parseDocumentPages('Text <!-- page-marker:1 -->')).toBeNull()
    expect(parseDocumentPages('~~~md\n<!-- page-marker:1 -->\n~~~')).toBeNull()
  })
  it('rejects missing or duplicate physical page numbers', () => {
    for (const source of ['<!-- page-marker:2 -->', '<!-- page-marker:1 -->\n<!-- page-marker:1 -->', '<!-- page-marker:1 -->\n<!-- page-marker:3 -->']) {
      expect(parseDocumentPages(source)).toBeNull()
    }
  })
  it('recognizes CRLF source pages and keeps Unicode text', () => {
    expect(parseDocumentPages('<!-- page-marker:1 -->\r\n你好 😀\r\n\r\n---\r\n\r\n<!-- page-marker:2 -->\r\nCafé'))
      .toEqual([{ page: 1, content: '你好 😀' }, { page: 2, content: 'Café' }])
  })
})

describe('page-relative scrolling', () => {
  it('maps within a page instead of using the unrelated whole-document percentage', () => {
    const position = positionAt(1500, 4000, [{ page: 1, top: 0, height: 1000 }, { page: 2, top: 1000, height: 2000 }, { page: 3, top: 3000, height: 1800 }])
    expect(position).toEqual({ percentage: 0.375, page: 2, progress: 0.25 })
    expect(scrollTarget(position, 8000, [{ page: 1, top: 0, height: 4000 }, { page: 2, top: 4000, height: 800 }, { page: 3, top: 4800, height: 4000 }])).toBe(4200)
  })
  it('uses bounded percentage fallback only when page geometry is unavailable', () => {
    expect(scrollTarget({ percentage: 0.5, page: 2 }, 1000, [])).toBe(500)
    expect(scrollTarget({ percentage: 2 }, 1000, [])).toBe(1000)
    expect(positionAt(0, 0, [])).toEqual({ percentage: 0 })
  })
})
