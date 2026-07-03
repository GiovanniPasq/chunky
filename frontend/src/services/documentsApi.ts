import type { CloudSettings, ConverterType, DocumentData, VLMSettings } from '../types'
import { API_BASE } from './apiService'

export interface UploadFileResult {
  filename: string
  success: boolean
  message: string
}

export interface UploadFilesResponse {
  uploaded: number
  failed: number
  results: UploadFileResult[]
}

export async function listDocuments(): Promise<string[]> {
  const res = await fetch(`${API_BASE}/documents`)
  if (!res.ok) throw new Error(`List documents failed: HTTP ${res.status}`)
  return res.json()
}

export async function getDocument(filename: string, signal?: AbortSignal): Promise<DocumentData> {
  const res = await fetch(
    `${API_BASE}/document/${encodeURIComponent(filename)}`,
    { signal },
  )
  if (!res.ok) throw new Error(`Get document failed: HTTP ${res.status}`)
  return res.json()
}

export interface ConversionPreviewRequest {
  filename: string
  converter: ConverterType
  start_page: number
  end_page: number
  preview_id?: string
  vlm?: VLMSettings
  cloud?: CloudSettings
}

export interface ConversionPreviewResponse {
  success: boolean
  filename: string
  converter: ConverterType
  start_page: number
  end_page: number
  page_count: number
  md_content: string
}

async function uploadErrorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => '')
  let detail = 'Upload failed'
  try {
    const parsed = JSON.parse(text) as { detail?: string }
    detail = parsed.detail ?? (text || detail)
  } catch {
    detail = text || detail
  }
  return detail
}

async function apiErrorMessage(res: Response, fallback: string): Promise<string> {
  const text = await res.text().catch(() => '')
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text) as { detail?: unknown }
    if (typeof parsed.detail === 'string') return parsed.detail
    if (Array.isArray(parsed.detail) && parsed.detail.length > 0) {
      const first = parsed.detail[0] as { msg?: unknown }
      if (typeof first?.msg === 'string') return first.msg
    }
  } catch {
    // Plain-text error body.
  }
  return text || fallback
}

export async function previewConversion(
  request: ConversionPreviewRequest,
  signal?: AbortSignal,
): Promise<ConversionPreviewResponse> {
  const res = await fetch(`${API_BASE}/convert/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  })
  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Preview failed: HTTP ${res.status}`))
  }
  const data = await res.json().catch(() => null) as ConversionPreviewResponse | null
  if (!data || typeof data.md_content !== 'string') {
    throw new Error('Invalid preview response')
  }
  return data
}

export async function cancelPreviewConversion(previewId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/convert/preview/${encodeURIComponent(previewId)}/cancel`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(await apiErrorMessage(res, `Preview cancel failed: HTTP ${res.status}`))
  }
}

export async function uploadDocumentFiles(files: File[], signal?: AbortSignal): Promise<UploadFilesResponse> {
  const formData = new FormData()
  files.forEach(file => formData.append('files', file))
  const res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData, signal })
  if (!res.ok) throw new Error(await uploadErrorMessage(res))
  const data = await res.json().catch(() => null) as UploadFilesResponse | null
  if (!data || !Array.isArray(data.results)) {
    throw new Error('Invalid upload response')
  }
  return data
}

function uploadFailureMessage(response: UploadFilesResponse): string {
  const failures = response.results.filter(r => !r.success)
  if (failures.length === 0) return ''
  if (failures.length === 1) {
    const failure = failures[0]
    return `${failure.filename}: ${failure.message}`
  }
  return `${failures.length} uploads failed: ${failures.slice(0, 3).map(f => f.filename).join(', ')}`
}

export interface DeleteDocumentsResponse {
  success: boolean
  deleted: string[]
  deleted_documents: string[]
  failed: Record<string, string>
  message: string
}

export async function deleteDocumentsByName(
  filenames: string[],
): Promise<DeleteDocumentsResponse> {
  const res = await fetch(`${API_BASE}/documents`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(filenames),
  })
  if (!res.ok) throw new Error(`Delete documents failed: HTTP ${res.status}`)
  return res.json()
}

export async function convertMarkdownToPdf(
  documentName: string,
  mdFilename: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(
    `${API_BASE}/documents/${encodeURIComponent(documentName)}/markdowns/${encodeURIComponent(mdFilename)}/pdf`,
    { method: 'POST', signal },
  )
  if (!res.ok) throw new Error(`MD to PDF conversion failed: HTTP ${res.status}`)
  const data = await res.json()
  if (typeof data.pdf_filename !== 'string') {
    throw new Error('Invalid response: missing pdf_filename')
  }
  return data.pdf_filename
}

export async function deleteMarkdownVariant(
  documentName: string,
  mdFilename: string,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/documents/${encodeURIComponent(documentName)}/markdowns/${encodeURIComponent(mdFilename)}`,
    { method: 'DELETE' },
  )
  if (!res.ok) throw new Error(`Delete Markdown failed: HTTP ${res.status}`)
}

export async function saveMarkdownFile(
  documentName: string,
  mdFilename: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(
    `${API_BASE}/documents/${encodeURIComponent(documentName)}/markdowns/${encodeURIComponent(mdFilename)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal,
    },
  )
  if (!res.ok) throw new Error(`Save Markdown failed: HTTP ${res.status}`)
}

export function summariseUploadResponse(response: UploadFilesResponse): string {
  if (response.failed === 0) {
    return `Uploaded ${response.uploaded} file${response.uploaded === 1 ? '' : 's'}`
  }
  if (response.uploaded === 0) {
    return uploadFailureMessage(response) || 'Upload failed'
  }
  return `Uploaded ${response.uploaded}; ${uploadFailureMessage(response)}`
}
