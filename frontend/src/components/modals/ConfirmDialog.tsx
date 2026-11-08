import type { ReactNode } from 'react'
import Modal from '../common/Modal'
import Button from '../common/Button'

/**
 * A single action button rendered in the dialog's footer.
 *
 * ``label`` accepts ReactNode so callers can swap to a loading
 * indicator (e.g. ``"Saving…"`` while a request is in flight) without
 * recreating the whole dialog.
 */
export interface ConfirmDialogAction {
  label: ReactNode
  onClick: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
}

interface Props {
  isOpen: boolean
  title?: string
  /** Called when the user clicks the dimmed backdrop (acts as Cancel). */
  onDismiss: () => void
  /** Dialog body — typically a single ``<p>`` with the question. */
  children: ReactNode
  /** Footer buttons, left-to-right.  Most dialogs have 2 (cancel + confirm). */
  actions: ConfirmDialogAction[]
  dismissible?: boolean
}

/** Shared confirmation flow with managed focus, dismissal, and actions. */
export default function ConfirmDialog({ isOpen, title = 'Confirm changes', onDismiss, children, actions, dismissible = true }: Props) {
  return (
    <Modal open={isOpen} onClose={onDismiss} title={title} dismissible={dismissible}>
      <div className="ui-modal-body">{children}</div>
      <div className="ui-modal-footer">
        {actions.map((action, index) => (
          <Button key={index} size="md" variant={action.variant ?? 'secondary'} onClick={action.onClick} disabled={action.disabled}>
            {action.label}
          </Button>
        ))}
      </div>
    </Modal>
  )
}
