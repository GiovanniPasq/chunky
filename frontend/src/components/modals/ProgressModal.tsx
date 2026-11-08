import { IconWarning } from '../common/Icons'
import Modal from '../common/Modal'
import Button from '../common/Button'
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
    <Modal open={isOpen} onClose={onInterrupt} title={title} className="progress-card" dismissible={false}>

        <div className="progress-card-body">
          {errorMessage ? (
            <p className="progress-error"><IconWarning size={14} /> {errorMessage}</p>
          ) : (
            <>
              {detail && <p className="progress-detail">{detail}</p>}

              <div className="progress-track" role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : pct}>
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
          <Button size="md" variant="danger" onClick={onInterrupt}>
            {errorMessage ? 'Close' : 'Interrupt'}
          </Button>
        </div>
    </Modal>
  )
}
