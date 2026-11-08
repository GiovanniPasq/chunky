import * as Dialog from '@radix-ui/react-dialog'
import { useId, useRef, type ReactNode } from 'react'
import Button from './Button'
import { IconClose } from './Icons'
import './Controls.css'

interface Props {
  open: boolean
  onClose: () => void
  title: ReactNode
  description?: string
  className?: string
  children: ReactNode
  dismissible?: boolean
}

export default function Modal({
  open,
  onClose,
  title,
  description,
  className = '',
  children,
  dismissible = true,
}: Props) {
  const descriptionId = useId()
  const previousFocus = useRef<HTMLElement | null>(null)
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && dismissible) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-modal-overlay">
          <Dialog.Content
            className={`ui-modal ${className}`}
            aria-describedby={description ? descriptionId : undefined}
            onOpenAutoFocus={() => {
              previousFocus.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null
            }}
            onCloseAutoFocus={(event) => {
              if (previousFocus.current?.isConnected) {
                event.preventDefault()
                previousFocus.current.focus()
              }
            }}
            onEscapeKeyDown={(e) => {
              if (!dismissible) e.preventDefault()
            }}
            onPointerDownOutside={(e) => {
              if (!dismissible) e.preventDefault()
            }}
          >
            <div className="ui-modal-header">
              <Dialog.Title className="ui-modal-title">{title}</Dialog.Title>
              {dismissible && (
                <Dialog.Close asChild>
                  <Button
                    variant="ghost"
                    aria-label={`Close ${typeof title === 'string' ? title.toLowerCase() : 'dialog'}`}
                  >
                    <IconClose size={16} />
                  </Button>
                </Dialog.Close>
              )}
            </div>
            {description && (
              <Dialog.Description
                id={descriptionId}
                className="ui-modal-description"
              >
                {description}
              </Dialog.Description>
            )}
            {children}
          </Dialog.Content>
        </Dialog.Overlay>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
