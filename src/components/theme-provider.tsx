'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

type Theme = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  theme: Theme
  resolvedTheme: ResolvedTheme
  setTheme: (theme: Theme) => void
}

const STORAGE_KEY = 'theme'

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => undefined,
})

function getSystemTheme(): ResolvedTheme {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyTheme(theme: Theme): ResolvedTheme {
  const resolvedTheme = theme === 'system' ? getSystemTheme() : theme
  const root = document.documentElement

  root.classList.toggle('dark', resolvedTheme === 'dark')
  root.style.colorScheme = resolvedTheme

  return resolvedTheme
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>('system')
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('light')

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(STORAGE_KEY)
    const initialTheme: Theme = storedTheme === 'light' || storedTheme === 'dark'
      ? storedTheme
      : 'system'

    setThemeState(initialTheme)
    setResolvedTheme(applyTheme(initialTheme))

    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    const handleSystemThemeChange = () => {
      if (initialTheme === 'system') setResolvedTheme(applyTheme('system'))
    }

    mediaQuery.addEventListener('change', handleSystemThemeChange)
    return () => mediaQuery.removeEventListener('change', handleSystemThemeChange)
  }, [])

  const setTheme = useCallback((nextTheme: Theme) => {
    window.localStorage.setItem(STORAGE_KEY, nextTheme)
    setThemeState(nextTheme)
    setResolvedTheme(applyTheme(nextTheme))
  }, [])

  const value = useMemo(
    () => ({ theme, resolvedTheme, setTheme }),
    [theme, resolvedTheme, setTheme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  return useContext(ThemeContext)
}
