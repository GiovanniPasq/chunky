import { useEffect, useRef } from 'react'
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
    <div className={`toast toast--${type}`}>
      <div className="toast-content">
        <span className="toast-icon">{type === 'success' ? '✅' : '❌'}</span>
        <span className="toast-message">{message}</span>
      </div>
      <button className="toast-close" onClick={onClose}>✕</button>
    </div>
  )
}