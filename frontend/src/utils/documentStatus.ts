export interface DocumentStatusInput {
  hasMarkdown: boolean
  hasFailures?: boolean
  hasCheckpoint?: boolean
  processing?: boolean
}

export type DocumentStage =
  'processing' | 'review' | 'resume' | 'ready' | 'needs-conversion'
export function getDocumentStatus(
  filename: string,
  input: DocumentStatusInput,
): {
  stage: DocumentStage
  label: string
  tone: 'neutral' | 'success' | 'warning' | 'info'
} {
  if (input.processing)
    return { stage: 'processing', label: 'Processing', tone: 'info' }
  if (input.hasFailures)
    return { stage: 'review', label: 'Needs review', tone: 'warning' }
  if (input.hasCheckpoint)
    return { stage: 'resume', label: 'Resume conversion', tone: 'info' }
  if (input.hasMarkdown || filename.toLowerCase().endsWith('.md'))
    return { stage: 'ready', label: 'Markdown ready', tone: 'success' }
  return {
    stage: 'needs-conversion',
    label: 'Needs conversion',
    tone: 'neutral',
  }
}
