"use client";

import { FormEvent, useState } from "react";
import { Check, Loader2, Monitor, Moon, Sun } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useTheme, type ThemePreference } from "@/components/providers/theme-provider";
import { authClient } from "@/lib/auth-client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const MAX_DISPLAY_NAME = 60;

const themeOptions: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const themeState: Record<ThemePreference, string> = {
  light: "Always light",
  dark: "Always dark",
  system: "Following this device",
};

export default function SettingsPage() {
  const { isLoading, refreshUser, user } = useAuth();
  const { preference, setPreference } = useTheme();
  const [displayName, setDisplayName] = useState("");
  const [syncedName, setSyncedName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* The session arrives after the first render, so the field re-syncs to it. */
  if (user && user.name !== syncedName) {
    setSyncedName(user.name);
    setDisplayName(user.name);
  }

  async function saveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user) return;
    const name = displayName.trim();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const { error: updateError } = await authClient.updateUser({ name });
      if (updateError) throw new Error(updateError.message ?? "Unable to save your display name.");
      await refreshUser();
      setDisplayName(name);
      setSaved(true);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : "Unable to save your display name.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings">
      <div className="settings-inner">
        <h1 className="settings-headline">Settings</h1>
        <p className="settings-say">What Tracera calls you, and how it looks while you read.</p>

        <div className="settings-rows">
          <section className="settings-row" aria-labelledby="settings-name">
            <div className="settings-margin">
              <span className="settings-margin-name" id="settings-name">
                Display name
              </span>
              <span className="settings-margin-state">
                {isLoading || !user
                  ? "Loading"
                  : user.name.trim()
                    ? `Showing ${user.name.trim()}`
                    : "Showing your email address"}
              </span>
            </div>

            <div>
              <p className="settings-ask">What should we call you?</p>
              {isLoading || !user ? (
                <Skeleton className="settings-field h-10 rounded-xl" aria-label="Loading" />
              ) : (
                <form onSubmit={saveDisplayName}>
                  <Label htmlFor="display-name" className="sr-only">
                    Display name
                  </Label>
                  <Input
                    id="display-name"
                    className="settings-field"
                    value={displayName}
                    onChange={(event) => {
                      setDisplayName(event.target.value);
                      setSaved(false);
                    }}
                    maxLength={MAX_DISPLAY_NAME}
                    placeholder={user.email}
                    autoComplete="name"
                    disabled={saving}
                  />
                  <p className="settings-note">
                    This replaces your email address everywhere your account appears. Leave it empty
                    to go back to showing the email.
                  </p>
                  <div className="settings-actions">
                    <Button
                      type="submit"
                      variant="brand"
                      className="rounded-full px-5"
                      disabled={saving || displayName.trim() === user.name.trim()}
                    >
                      {saving ? (
                        <>
                          <Loader2 className="animate-spin" /> Saving
                        </>
                      ) : (
                        "Save name"
                      )}
                    </Button>
                    {saved && (
                      <p className="settings-saved" role="status">
                        <Check />
                        Saved
                      </p>
                    )}
                  </div>
                  {error && (
                    <Alert variant="destructive" className="settings-field">
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                  )}
                </form>
              )}
            </div>
          </section>

          <section className="settings-row" aria-labelledby="settings-appearance">
            <div className="settings-margin">
              <span className="settings-margin-name" id="settings-appearance">
                Appearance
              </span>
              <span className="settings-margin-state">{themeState[preference]}</span>
            </div>

            <div>
              <p className="settings-ask">How should Tracera look?</p>
              <ToggleGroup
                value={[preference]}
                onValueChange={(value) => value[0] && setPreference(value[0] as ThemePreference)}
                aria-labelledby="settings-appearance"
                className="settings-field"
              >
                {themeOptions.map((option) => (
                  <ToggleGroupItem key={option.value} value={option.value}>
                    <option.icon />
                    {option.label}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="settings-note">
                Saved on this device only. System follows whatever light or dark mode your browser
                is set to.
              </p>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
