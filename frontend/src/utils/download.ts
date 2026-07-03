export function safeDownloadFilename(name: string | null | undefined, fallback: string): string {
  const cleaned = (name ?? '')
    .replace(/[\u0000-\u001F\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

export function replaceExtension(filename: string, extension: string): string {
  const cleanExt = extension.startsWith('.') ? extension : `.${extension}`
  const withoutExt = filename.replace(/\.[^/.]+$/, '')
  return `${withoutExt}${cleanExt}`
}

export function filenameStem(filename: string): string {
  return filename.replace(/\.[^/.]+$/, '') || filename
}

export function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8',
): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()

  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}
