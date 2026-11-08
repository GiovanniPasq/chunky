export interface DocumentPage {
  page: number
  content: string
}

/** Only standalone, ordered provenance comments outside fenced code are pages. */
export function parseDocumentPages(markdown: string): DocumentPage[] | null {
  const markers: { page: number; start: number; end: number }[] = []
  let fence: { char: string; length: number } | null = null
  let offset = 0
  for (const raw of markdown.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g) ?? []) {
    if (!raw) continue
    const line = raw.replace(/[\r\n]+$/, '')
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (delimiter) {
      const [, run, suffix] = delimiter
      if (!fence) fence = { char: run[0], length: run.length }
      else if (run[0] === fence.char && run.length >= fence.length && !suffix.trim()) fence = null
    } else if (!fence) {
      const marker = line.match(/^ {0,3}<!--\s*page-marker:(\d+)\s*-->[ \t]*$/)
      if (marker) markers.push({ page: Number(marker[1]), start: offset, end: offset + raw.length })
    }
    offset += raw.length
  }
  if (!markers.length || markers.some((marker, index) => marker.page !== index + 1)) return null
  return markers.map((marker, index) => {
    let content = markdown.slice(marker.end, markers[index + 1]?.start ?? markdown.length)
      .replace(/(?:\r?\n){2}---(?:\r?\n){2}$/, '')
      .replace(/^[\r\n]+|[\r\n]+$/g, '')
    const prefix = index === 0 ? markdown.slice(0, marker.start).trim() : ''
    if (prefix) content = `${prefix}\n\n${content}`
    return { page: marker.page, content }
  })
}
