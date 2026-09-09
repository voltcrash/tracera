"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, Loader2, Monitor, Moon, Shuffle, Sun, X } from "lucide-react";
import { accountLabel, useAuth } from "@/components/providers/auth-provider";
import { useTheme, type ThemePreference } from "@/components/providers/theme-provider";
import { authClient } from "@/lib/auth-client";
import { GoogleMark } from "@/components/auth/google-sign-in-button";
import { GitHubMark } from "@/components/brand/github-mark";
import { isPhotoUrl, shuffleAvatarId, TraceAvatar } from "@/components/brand/trace-avatar";
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
        <p className="settings-say">
          Who Tracera has you down as, and how it looks while you read.
        </p>

        <div className="settings-rows">
          <AccountRow />
          <AvatarRow />

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

type LinkedAccount = { providerId: string; createdAt: string };

function AccountRow() {
  const { isLoading, user } = useAuth();
  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null);

  useEffect(() => {
    if (!user) return;
    const controller = new AbortController();
    fetch("/api/auth/list-accounts", { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load your sign-in methods.");
        setAccounts((await response.json()) as LinkedAccount[]);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAccounts([]);
      });
    return () => controller.abort();
  }, [user]);

  const google = accounts?.find((account) => account.providerId === "google") ?? null;
  const pending = isLoading || !user || accounts === null;

  return (
    <section className="settings-row" aria-labelledby="settings-account">
      <div className="settings-margin">
        <span className="settings-margin-name" id="settings-account">
          Account
        </span>
        <span className="settings-margin-state">
          {pending ? "Loading" : google ? "Signed in with Google" : "Signed in by email"}
        </span>
      </div>

      <div>
        {pending ? (
          <Skeleton className="h-8 max-w-80 rounded-lg" aria-label="Loading your account" />
        ) : (
          <p className="settings-identity">{user.email}</p>
        )}
        <p className="settings-note">
          {pending
            ? "Reading your sign-in methods."
            : `You have been tracing claims here since ${longDate(user.createdAt)}.`}
        </p>

        <ul className="methods">
          <li className="method" data-state={google ? "linked" : "absent"}>
            <GoogleMark />
            <span className="method-body">
              <span className="method-name">Google</span>
              <span className="method-detail">
                {pending
                  ? "Checking"
                  : google
                    ? `Linked ${longDate(google.createdAt)}`
                    : "Not linked to this account"}
              </span>
            </span>
            <span className="method-state">{google ? "In use" : "Not in use"}</span>
          </li>
          <li className="method" data-state="soon">
            <GitHubMark className="size-4" />
            <span className="method-body">
              <span className="method-name">GitHub</span>
              <span className="method-detail">
                Sign in with GitHub is on the way. Your traces will follow you across both.
              </span>
            </span>
            <span className="method-state">Coming soon</span>
          </li>
        </ul>
      </div>
    </section>
  );
}

function AvatarRow() {
  const { isLoading, refreshUser, user } = useAuth();
  const [image, setImage] = useState<string | null>(null);
  const [syncedImage, setSyncedImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  if (user && user.image !== syncedImage) {
    setSyncedImage(user.image);
    setImage(user.image);
  }

  async function saveImage(next: string | null) {
    if (!user) return;
    const request = ++requestRef.current;
    const previous = image;
    setImage(next);
    setError(null);
    const { error: updateError } = await authClient.updateUser({ image: next });
    if (request !== requestRef.current) return;
    if (updateError) {
      setImage(previous);
      setError(updateError.message ?? "Unable to save your avatar.");
      return;
    }
    await refreshUser();
  }

  const pending = isLoading || !user;

  return (
    <section className="settings-row" aria-labelledby="settings-avatar">
      <div className="settings-margin">
        <span className="settings-margin-name" id="settings-avatar">
          Avatar
        </span>
        <span className="settings-margin-state">
          {pending
            ? "Loading"
            : isPhotoUrl(image)
              ? "Your Google picture"
              : image
                ? "A trace mark"
                : "Your initials"}
        </span>
      </div>

      <div className="avatar-row">
        <div>
          <p className="settings-ask">How should you show up?</p>
          <p className="settings-note">
            Every mark is built from the Tracera logo: one source, a few branches. Shuffle until one
            fits, or clear it to go back to your initials.
          </p>
          {error && (
            <Alert variant="destructive" className="settings-field">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {pending ? (
          <Skeleton className="size-18 shrink-0 rounded-full" aria-label="Loading your avatar" />
        ) : (
          <div className="avatar-picker">
            <button
              type="button"
              className="avatar-shuffle"
              onClick={() => void saveImage(shuffleAvatarId(image))}
              aria-label={image ? "Shuffle to a different avatar" : "Pick an avatar"}
            >
              <TraceAvatar image={image} label={accountLabel(user)} className="size-18" />
              <span className="avatar-shuffle-hint" aria-hidden="true">
                <Shuffle />
              </span>
            </button>
            {image && (
              <button
                type="button"
                className="avatar-clear"
                onClick={() => void saveImage(null)}
                aria-label="Clear avatar"
              >
                <X />
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function longDate(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
