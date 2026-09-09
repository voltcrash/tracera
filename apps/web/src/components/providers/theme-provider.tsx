"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";

type ResolvedTheme = "light" | "dark";
export type ThemePreference = ResolvedTheme | "system";

export const THEME_STORAGE_KEY = "tracera-theme";

/*
 * Runs before paint from the document head, so the first frame is already in the
 * right theme. Keep it in sync with applyTheme below.
 */
export const themeBootstrapScript = `(function(){try{var p=localStorage.getItem("${THEME_STORAGE_KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

type ThemeContextValue = {
  theme: ResolvedTheme;
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

const preferenceListeners = new Set<() => void>();

function subscribePreference(listener: () => void) {
  preferenceListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    preferenceListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readPreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function subscribeSystemTheme(listener: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

function readSystemTheme(): ResolvedTheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/* The server cannot know either preference, so it renders the neutral defaults. */
const serverPreference = (): ThemePreference => "system";
const serverSystemTheme = (): ResolvedTheme => "light";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const preference = useSyncExternalStore(subscribePreference, readPreference, serverPreference);
  const systemTheme = useSyncExternalStore(
    subscribeSystemTheme,
    readSystemTheme,
    serverSystemTheme,
  );

  const theme = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    try {
      if (next === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
      else window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // The choice is lost on reload if browser storage is disabled.
    }
    for (const listener of preferenceListeners) listener();
  }, []);

  const toggleTheme = useCallback(
    () => setPreference(theme === "dark" ? "light" : "dark"),
    [setPreference, theme],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      preference,
      setPreference,
      toggleTheme,
    }),
    [preference, setPreference, theme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider.");
  return context;
}
