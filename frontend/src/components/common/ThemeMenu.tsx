import { useTheme } from '../../context/ThemeContext'
import ActionMenu from './ActionMenu'
import { IconMoon, IconSun, IconMonitor } from './Icons'

export default function ThemeMenu() {
  const { preference, theme, setPreference } = useTheme()
  return (
    <ActionMenu
      label="Appearance"
      icon={theme === 'dark' ? <IconMoon size={16} /> : <IconSun size={16} />}
      actions={[
        {
          label: 'Light theme',
          icon: <IconSun size={16} />,
          selected: preference === 'light',
          onSelect: () => setPreference('light'),
        },
        {
          label: 'Dark theme',
          icon: <IconMoon size={16} />,
          selected: preference === 'dark',
          onSelect: () => setPreference('dark'),
        },
        {
          label: 'Use system theme',
          icon: <IconMonitor size={16} />,
          selected: preference === 'system',
          onSelect: () => setPreference('system'),
        },
      ]}
    />
  )
}
