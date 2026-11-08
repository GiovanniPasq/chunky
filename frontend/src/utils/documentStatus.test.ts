import { describe, expect, it } from 'vitest'
import { getDocumentStatus } from './documentStatus'

describe('document workflow status', () => {
  it('keeps partial and interrupted documents actionable even if Markdown exists', () => {
    expect(getDocumentStatus('report.pdf', { hasMarkdown: true, hasFailures: true }).stage).toBe('review')
    expect(getDocumentStatus('report.pdf', { hasMarkdown: true, hasCheckpoint: true }).stage).toBe('resume')
    expect(getDocumentStatus('report.pdf', { hasMarkdown: true, hasFailures: true, processing: true }).stage).toBe('processing')
  })
  it('recognizes uploaded Markdown before metadata arrives', () => {
    expect(getDocumentStatus('NOTES.MD', { hasMarkdown: false }).stage).toBe('ready')
    expect(getDocumentStatus('report.pdf', { hasMarkdown: false }).stage).toBe('needs-conversion')
  })
})
