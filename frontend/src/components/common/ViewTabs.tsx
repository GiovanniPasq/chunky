import type { ReactNode } from 'react'
import './Controls.css'

interface Props<T extends string> {
  label: string
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<{
    value: T
    label: ReactNode
    icon?: ReactNode
    disabled?: boolean
  }>
  className?: string
  variant?: 'pill' | 'segmented'
}

export default function ViewTabs<T extends string>({
  label,
  value,
  onChange,
  items,
  className = '',
  variant = 'pill',
}: Props<T>) {
  return (
    <div
      className={`view-tabs view-tabs--${variant} ${className}`}
      role="group"
      aria-label={label}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`panel-view-tab${item.value === value ? ' active' : ''}`}
          aria-pressed={item.value === value}
          disabled={item.disabled}
          onClick={() => onChange(item.value)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  )
}
