import type { ComponentProps } from 'react'
import { IconSpinner } from './Icons'
import './Controls.css'

type Props = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'sm' | 'md'
  loading?: boolean
}

export default function Button({
  variant = 'secondary',
  size = 'sm',
  loading = false,
  className = '',
  disabled,
  children,
  type = 'button',
  ...props
}: Props) {
  return (
    <button
      type={type}
      className={`ui-button ui-button--${variant} ui-button--${size} ${className}`.trim()}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <IconSpinner size={14} />}
      {children}
    </button>
  )
}
