import './Toolbar.css'

interface Props {
  scrollSync: boolean
  chunkViz: boolean
  chunksReady: boolean
  onToggleScrollSync: () => void
  onToggleChunkViz: () => void
  onOpenSettings: () => void
  onSaveChunks: () => void
  savingChunks: boolean
}

interface ToggleProps {
  label: string
  icon: string
  active: boolean
  status?: string
  onClick: () => void
  disabled?: boolean
  title?: string
}

function ToggleButton({ label, icon, active, status, onClick, disabled, title }: ToggleProps) {
  return (
    <button
      className={`toolbar-btn ${active ? 'active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      <span className="btn-icon">{icon}</span>
      <span className="btn-label">{label}</span>
      {status !== undefined && <span className={`btn-status ${active ? 'on' : 'off'}`}>{status}</span>}
    </button>
  )
}

export default function Toolbar({
  scrollSync, chunkViz, chunksReady,
  onToggleScrollSync, onToggleChunkViz,
  onOpenSettings, onSaveChunks, savingChunks
}: Props) {
  return (
    <div className="toolbar">
      <ToggleButton
        label="Synchronized Scroll"
        icon={scrollSync ? '🔗' : '⛓️‍💥'}
        active={scrollSync}
        status={scrollSync ? 'ON' : 'OFF'}
        onClick={onToggleScrollSync}
      />
      <ToggleButton
        label="Chunk Visualization"
        icon={chunkViz ? '🎨' : '📄'}
        active={chunkViz}
        status={chunkViz ? 'ON' : 'OFF'}
        onClick={onToggleChunkViz}
      />

      <div className="toolbar-separator" />

      <button className="toolbar-btn settings" onClick={onOpenSettings} title="Chunk Settings">
        <span className="btn-icon">⚙️</span>
        <span className="btn-label">Chunk Settings</span>
      </button>

      <button
        className="toolbar-btn save"
        onClick={onSaveChunks}
        disabled={!chunksReady || savingChunks}
        title="Save chunks to disk"
      >
        <span className="btn-icon">💾</span>
        <span className="btn-label">{savingChunks ? 'Saving…' : 'Save Chunks'}</span>
      </button>
    </div>
  )
}