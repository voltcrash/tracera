"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "@/components/providers/theme-provider";

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggleTheme}
      aria-pressed={isDark}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      className={cn("theme-toggle rounded-full text-muted-foreground", className)}
    >
      <span className="theme-toggle-icons" aria-hidden="true">
        <Sun className="theme-toggle-sun" />
        <Moon className="theme-toggle-moon" />
      </span>
      <span className="sr-only">{isDark ? "Switch to light theme" : "Switch to dark theme"}</span>
    </Button>
  );
}
