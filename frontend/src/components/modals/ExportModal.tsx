import { useEffect, useState } from 'react'
import Modal from '../common/Modal'
import Button from '../common/Button'
import { exportDocuments, getExportDirectory, type ExportOptions } from '../../services/exportsApi'
import './ExportModal.css'

export default function ExportModal({ filenames, onClose }: { filenames: string[]; onClose: () => void }) {
  const [options, setOptions] = useState<Omit<ExportOptions, 'filenames'>>({
    destination: 'download', include_markdown: true, include_chunks: true,
    include_pdfs: false, versions: 'latest', folder: '',
  })
  const [directory, setDirectory] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    getExportDirectory(controller.signal).then(setDirectory).catch(() => {})
    return () => controller.abort()
  }, [])
  const set = <K extends keyof typeof options>(key: K, value: typeof options[K]) => {
    setOptions(previous => ({ ...previous, [key]: value }))
    setError('')
    setResult('')
  }
  const run = async () => {
    setBusy(true); setError(''); setResult('')
    try {
      const destination = await exportDocuments({ ...options, filenames })
      if (destination) setResult(destination)
      else onClose()
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) setError(err instanceof Error ? err.message : 'Export failed.')
    } finally { setBusy(false) }
  }
  return (
    <Modal open onClose={onClose} title="Export documents" dismissible={!busy} className="export-modal"
      description={`${filenames.length} document${filenames.length === 1 ? '' : 's'} selected. Exports include saved files only; your workspace stays in place.`}>
      <div className="ui-modal-body export-options">
        <fieldset disabled={busy}>
          <legend>Include</legend>
          <label><input type="checkbox" checked={options.include_markdown} onChange={e => set('include_markdown', e.target.checked)} /> Markdown</label>
          <label><input type="checkbox" checked={options.include_chunks} onChange={e => set('include_chunks', e.target.checked)} /> Saved chunks (JSON)</label>
          <label><input type="checkbox" checked={options.include_pdfs} onChange={e => set('include_pdfs', e.target.checked)} /> Original PDFs</label>
        </fieldset>
        <label htmlFor="export-versions">Versions</label>
        <select className="ui-field" id="export-versions" value={options.versions} disabled={busy} onChange={e => set('versions', e.target.value as 'latest' | 'all')}>
          <option value="latest">Latest Markdown and its latest saved chunks</option>
          <option value="all">All saved versions</option>
        </select>
        <label htmlFor="export-destination">Destination</label>
        <select className="ui-field" id="export-destination" value={options.destination} disabled={busy} onChange={e => set('destination', e.target.value as 'download' | 'folder')}>
          <option value="download">Download ZIP to this computer</option>
          <option value="folder">Folder on the backend machine</option>
        </select>
        {options.destination === 'folder' && <>
          <p className="export-help">Export root: <code>{directory || 'Configured EXPORTS_DIR'}</code>. For Docker, this is a path inside the backend container.</p>
          <label htmlFor="export-folder">Subfolder (optional)</label>
          <input className="ui-field" type="text" id="export-folder" value={options.folder} disabled={busy} onChange={e => set('folder', e.target.value)} placeholder="e.g. rag-dataset" />
          <small>Each export creates a new folder. Configure the root with EXPORTS_DIR on the backend.</small>
        </>}
        <p className="export-help">Latest is determined by save time. A manifest lists included files, missing outputs, and stale chunk warnings.</p>
        {error && <p role="alert" className="export-error">{error}</p>}
        {result && <p role="status">Export complete: <code>{result}</code></p>}
      </div>
      <div className="ui-modal-footer">
        <Button onClick={onClose} disabled={busy}>Close</Button>
        <Button variant="primary" loading={busy} onClick={run} disabled={!options.include_markdown && !options.include_chunks && !options.include_pdfs}>
          {busy ? 'Exporting…' : options.destination === 'download' ? 'Download ZIP' : 'Export to folder'}
        </Button>
      </div>
    </Modal>
  )
}
