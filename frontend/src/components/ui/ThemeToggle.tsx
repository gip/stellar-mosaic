import { Moon, Sun, type LucideIcon } from 'lucide-react'
import { useTheme, THEMES, type ThemeId } from '../../ThemeContext'

// Icons inherit currentColor, so they theme automatically via the surrounding button token
// styles. One entry per theme id in THEMES.
const ICONS: Record<ThemeId, LucideIcon> = {
  dark: Moon,
  light: Sun,
}

/** Header icon button that cycles through the registered themes on click. */
export default function ThemeToggle() {
  const { theme, cycleTheme } = useTheme()
  const idx = THEMES.findIndex((t) => t.id === theme)
  const next = THEMES[(idx + 1) % THEMES.length]
  const label = `Switch to ${next.label}`
  const Icon = ICONS[theme]

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycleTheme}
      title={label}
      aria-label={label}
    >
      <Icon size={16} strokeWidth={1.75} aria-hidden="true" />
    </button>
  )
}
