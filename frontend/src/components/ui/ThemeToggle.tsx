import type { ReactElement } from 'react'
import { useTheme, THEMES, type ThemeId } from '../../ThemeContext'

// Inline SVGs (no icon dependency). They inherit currentColor, so they theme automatically
// via the surrounding button token styles. One entry per theme id in THEMES.
const ICONS: Record<ThemeId, ReactElement> = {
  dark: (
    // Moon
    <path d="M12.5 2.5A6.5 6.5 0 0 0 8 14a6.5 6.5 0 0 1-1-11.5 6.5 6.5 0 0 0 5.5.5Z" />
  ),
  light: (
    // Sun
    <g>
      <circle cx="8" cy="8" r="3.2" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M13 3l-1.4 1.4M4.4 11.6 3 13"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
    </g>
  ),
}

/** Header icon button that cycles through the registered themes on click. */
export default function ThemeToggle() {
  const { theme, cycleTheme } = useTheme()
  const idx = THEMES.findIndex((t) => t.id === theme)
  const next = THEMES[(idx + 1) % THEMES.length]
  const label = `Switch to ${next.label}`

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={cycleTheme}
      title={label}
      aria-label={label}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
        {ICONS[theme]}
      </svg>
    </button>
  )
}
