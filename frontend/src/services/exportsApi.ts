import { downloadBlob } from '../utils/download'

export interface ExportOptions {
  filenames: string[]
  destination: 'download' | 'folder'
  include_markdown: boolean
  include_chunks: boolean
  include_pdfs: boolean
  versions: 'latest' | 'all'
  folder: string
}

async function checked(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : `Export failed (HTTP ${response.status}).`)
  }
  return response
}

export async function getExportDirectory(signal: AbortSignal): Promise<string> {
  const response = await checked(await fetch('/api/export/config', { signal }))
  return (await response.json()).directory
}

export async function exportDocuments(options: ExportOptions): Promise<string | null> {
  // Ask synchronously from the click gesture, before the potentially long export.
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<{ createWritable(): Promise<WritableStream> }> }).showSaveFilePicker
  const handle = options.destination === 'download' && picker
    ? await picker.call(window, { suggestedName: 'chunky-export.zip', types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }] })
    : null
  const response = await checked(await fetch('/api/export', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options),
  }))
  if (options.destination === 'folder') return (await response.json()).directory
  if (handle && response.body) {
    await response.body.pipeTo(await handle.createWritable())
  } else {
    downloadBlob('chunky-export.zip', await response.blob())
  }
  return null
}
