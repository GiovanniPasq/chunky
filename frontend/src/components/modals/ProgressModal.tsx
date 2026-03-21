import './ProgressModal.css'

interface Props {
  isOpen: boolean
  title: string
  detail?: string
  current: number
  /** 0 = indeterminate (pulsing bar) */
  total: number
  onInterrupt: () => void
  /** When set, the modal switches to an error state showing this message. */
  errorMessage?: string
}

export default function ProgressModal({ isOpen, title, detail, current, total, onInterrupt, errorMessage }: Props) {
  if (!isOpen) return null

  const indeterminate = total === 0
  const pct = indeterminate ? 0 : Math.min(100, Math.round((current / total) * 100))

  return (
    <div className="progress-overlay">
      <div className="progress-card" role="dialog" aria-modal="true" aria-label={title}>
        <div className="progress-card-header">
          <h3 className="progress-title">{title}</h3>
        </div>

        <div className="progress-card-body">
          {errorMessage ? (
            <p className="progress-error">⚠️ {errorMessage}</p>
          ) : (
            <>
              {detail && <p className="progress-detail">{detail}</p>}

              <div className="progress-track">
                <div
                  className={`progress-fill${indeterminate ? ' progress-fill--indeterminate' : ''}`}
                  style={!indeterminate ? { width: `${pct}%` } : undefined}
                />
              </div>

              <div className="progress-stats">
                {indeterminate
                  ? 'Processing…'
                  : `${current} / ${total} (${pct}%)`}
              </div>
            </>
          )}
        </div>

        <div className="progress-card-footer">
          <button className="progress-interrupt-btn" onClick={onInterrupt}>
            {errorMessage ? '✕ Close' : '✕ Interrupt'}
          </button>
        </div>
      </div>
    </div>
  )
}
