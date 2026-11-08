import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import Button from './Button'
import { IconCheck, IconMore } from './Icons'
import './Controls.css'

export interface MenuAction {
  label: string
  onSelect: () => void
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  selected?: boolean
}

interface Props {
  label?: string
  icon?: ReactNode
  actions: MenuAction[]
  disabled?: boolean
}

export default function ActionMenu({
  label = 'More actions',
  icon = <IconMore size={16} />,
  actions,
  disabled,
}: Props) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          aria-label={label}
          title={label}
          disabled={disabled}
          className="action-menu-trigger"
        >
          {icon}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="action-menu"
          align="end"
          sideOffset={6}
          collisionPadding={12}
        >
          <DropdownMenu.Label className="action-menu-label">
            {label}
          </DropdownMenu.Label>
          {actions.map((action) => (
            <DropdownMenu.Item
              key={action.label}
              className={`action-menu-item${action.danger ? ' action-menu-item--danger' : ''}`}
              onSelect={action.onSelect}
              disabled={action.disabled}
            >
              {action.icon}
              <span>{action.label}</span>
              {action.selected && <IconCheck size={14} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}
