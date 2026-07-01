import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

// Registry: the single source of truth for available themes.
// Adding a scheme = append an entry here + a matching [data-theme="<id>"] block in
// styles/tokens.css + an icon in components/ui/ThemeToggle.tsx. The cycle order, persistence,
// and OS-default logic below then pick it up automatically.
// eslint-disable-next-line react-refresh/only-export-components
export const THEMES = [
  { id: 'dark', label: 'Dark' },
  { id: 'light', label: 'Light' },
] as const

export type ThemeId = (typeof THEMES)[number]['id']

const THEME_KEY = 'mosaic.theme'

const isThemeId = (v: string | null): v is ThemeId => THEMES.some((t) => t.id === v)

function prefersLight(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch {
    return false
  }
}

/** Saved choice if valid, otherwise resolve from the OS preference (fallback dark). */
function initialTheme(): ThemeId {
  try {
    const saved = localStorage.getItem(THEME_KEY)
    if (isThemeId(saved)) return saved
  } catch {
    // Fall through to OS preference.
  }
  return prefersLight() ? 'light' : 'dark'
}

function hasSavedChoice(): boolean {
  try {
    return isThemeId(localStorage.getItem(THEME_KEY))
  } catch {
    return false
  }
}

interface ThemeState {
  theme: ThemeId
  themes: typeof THEMES
  setTheme: (theme: ThemeId) => void
  cycleTheme: () => void
}

const Ctx = createContext<ThemeState | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>(() => initialTheme())

  // Reflect the active theme onto <html> so tokens.css selectors apply.
  // Suppress every transition for the duration of the swap so the whole page
  // repaints in the new theme in one frame (no staggered per-element fades).
  useEffect(() => {
    const css = document.createElement('style')
    css.appendChild(
      document.createTextNode('*,*::before,*::after{transition:none !important}'),
    )
    document.head.appendChild(css)
    document.documentElement.setAttribute('data-theme', theme)
    // Force a reflow so the new theme is painted with transitions still off...
    document.body.getBoundingClientRect()
    // ...then re-enable transitions on the next tick.
    const id = window.setTimeout(() => document.head.removeChild(css), 0)
    return () => {
      window.clearTimeout(id)
      if (css.parentNode) document.head.removeChild(css)
    }
  }, [theme])

  // Follow the OS while the user hasn't made an explicit choice.
  useEffect(() => {
    if (hasSavedChoice()) return
    let mql: MediaQueryList
    try {
      mql = window.matchMedia('(prefers-color-scheme: light)')
    } catch {
      return
    }
    const onChange = (e: MediaQueryListEvent) => {
      if (hasSavedChoice()) return
      setThemeState(e.matches ? 'light' : 'dark')
    }
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next)
    try {
      localStorage.setItem(THEME_KEY, next)
    } catch {
      // In-memory theme still works if localStorage is unavailable.
    }
  }, [])

  const cycleTheme = useCallback(() => {
    setThemeState((current) => {
      const idx = THEMES.findIndex((t) => t.id === current)
      const next = THEMES[(idx + 1) % THEMES.length].id
      try {
        localStorage.setItem(THEME_KEY, next)
      } catch {
        // In-memory theme still works if localStorage is unavailable.
      }
      return next
    })
  }, [])

  const value = useMemo<ThemeState>(
    () => ({ theme, themes: THEMES, setTheme, cycleTheme }),
    [theme, setTheme, cycleTheme],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeState {
  const value = useContext(Ctx)
  if (!value) throw new Error('useTheme outside ThemeProvider')
  return value
}
