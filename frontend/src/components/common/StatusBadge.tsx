import type { ReactNode } from 'react'
import './Controls.css'

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export default function StatusBadge({
  children,
  tone = 'neutral',
  title,
}: {
  children: ReactNode
  tone?: StatusTone
  title?: string
}) {
  return (
    <span className={`status-badge status-badge--${tone}`} title={title}>
      {children}
    </span>
  )
}
