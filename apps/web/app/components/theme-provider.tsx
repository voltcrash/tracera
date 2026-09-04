"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "tracera-theme";

/*
 * Runs before paint from the document head, so the first frame is already in the
 * right theme. Keep it in sync with applyTheme below.
 */
export const themeBootstrapScript = `(function(){try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");var d=s==="dark"||(s!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var r=document.documentElement;r.classList.toggle("dark",d);r.style.colorScheme=d?"dark":"light";}catch(e){}})();`;

type ThemeContextValue = {
  preference: ThemePreference;
  theme: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  toggleTheme: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>("system");
  const [theme, setTheme] = useState<ResolvedTheme>("light");

  useEffect(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const initial: ThemePreference = stored === "light" || stored === "dark" ? stored : "system";
    setPreferenceState(initial);
    setTheme(initial === "system" ? systemTheme() : initial);
  }, []);

  useEffect(() => {
    if (preference !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const next = media.matches ? "dark" : "light";
      setTheme(next);
      applyTheme(next);
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    const resolved = next === "system" ? systemTheme() : next;
    setPreferenceState(next);
    setTheme(resolved);
    applyTheme(resolved);
    if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      theme,
      setPreference,
      toggleTheme: () => setPreference(theme === "dark" ? "light" : "dark"),
    }),
    [preference, setPreference, theme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used within ThemeProvider.");
  return context;
}
