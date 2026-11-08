import { useEffect, useRef } from 'react'
import { IconCheck, IconClose } from './common/Icons'
import './Toast.css'

interface Props {
  message: string
  type?: 'success' | 'error'
  duration?: number
  onClose: () => void
}

export default function Toast({ message, type = 'success', duration = 3000, onClose }: Props) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    const timer = setTimeout(() => onCloseRef.current(), duration)
    return () => clearTimeout(timer)
  }, [duration])

  return (
    <div className={`toast toast--${type}`} role={type === 'error' ? 'alert' : 'status'}>
      <div className="toast-content">
        <span className="toast-icon">{type === 'success' ? <IconCheck size={18} /> : <IconClose size={18} />}</span>
        <span className="toast-message">{message}</span>
      </div>
      <button className="toast-close" onClick={onClose} aria-label="Dismiss notification"><IconClose size={14} /></button>
    </div>
  )
}