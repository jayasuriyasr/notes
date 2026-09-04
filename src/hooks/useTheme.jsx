import { createContext, useContext, useEffect, useState, useCallback, useMemo } from 'react';

const ThemeContext = createContext(null);
const STORAGE_KEY = 'theme';

/** 'light' | 'dark' | 'system' — system is the default and is not stored. */
export function ThemeProvider({ children }) {
  const [theme, setThemeState] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'system';
    } catch {
      return 'system';
    }
  });

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
    };
    apply();
    // Follow the OS while on 'system'.
    if (theme === 'system') {
      media.addEventListener('change', apply);
      return () => media.removeEventListener('change', apply);
    }
  }, [theme]);

  const setTheme = useCallback((next) => {
    setThemeState(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode: the class still applies for this session */
    }
  }, []);

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
