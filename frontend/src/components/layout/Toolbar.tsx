import './Toolbar.css'

interface Props {
  scrollSync: boolean
  chunkViz: boolean
  onToggleScrollSync: () => void
  onToggleChunkViz: () => void
  onOpenSettings: () => void
}

interface ToggleButtonProps {
  label: string
  icon: string
  active: boolean
  status: string
  onClick: () => void
  title?: string
}

function ToggleButton({ label, icon, active, status, onClick, title }: ToggleButtonProps) {
  return (
    <button
      className={`toolbar-btn ${active ? 'active' : ''}`}
      onClick={onClick}
      title={title}
    >
      <span className="btn-icon">{icon}</span>
      <span className="btn-label">{label}</span>
      <span className={`btn-status ${active ? 'on' : 'off'}`}>{status}</span>
    </button>
  )
}

export default function Toolbar({
  scrollSync, chunkViz,
  onToggleScrollSync, onToggleChunkViz, onOpenSettings,
}: Props) {
  return (
    <div className="toolbar">
      <div className="toolbar-left">
        <ToggleButton
          label="Synchronized Scroll"
          icon={scrollSync ? '🔗' : '⛓️‍💥'}
          active={scrollSync}
          status={scrollSync ? 'ON' : 'OFF'}
          onClick={onToggleScrollSync}
          title="Toggle scroll synchronization"
        />
        <ToggleButton
          label="Chunk Visualization"
          icon={chunkViz ? '🎨' : '📄'}
          active={chunkViz}
          status={chunkViz ? 'ON' : 'OFF'}
          onClick={onToggleChunkViz}
          title="Toggle chunk visualization"
        />
      </div>

      <div className="toolbar-right">
        <button className="toolbar-btn settings" onClick={onOpenSettings} title="Settings">
          <span className="btn-icon">⚙️</span>
          <span className="btn-label">Settings</span>
        </button>
      </div>
    </div>
  )
}