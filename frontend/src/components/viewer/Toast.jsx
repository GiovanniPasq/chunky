import { useEffect } from 'react'
import './Toast.css'

function Toast({ message, onClose, duration = 3000 }) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose()
    }, duration)

    return () => clearTimeout(timer)
  }, [duration, onClose])

  return (
    <div className="toast">
      <div className="toast-content">
        <span className="toast-icon">⚠️</span>
        <span className="toast-message">{message}</span>
      </div>
    </div>
  )
}

export default Toast
