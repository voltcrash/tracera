import { LocalTime } from "@/components/ui/local-time";
import { createFileRoute } from "@tanstack/react-router";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Check, Loader2, Shuffle } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { GoogleMark } from "@/components/auth/social-sign-in-button";
import { GitHubMark } from "@/components/brand/github-mark";
import { shuffleAvatarId } from "@repo/contracts/avatar";
import { TraceAvatar } from "@/components/brand/trace-avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useResource } from "@/lib/use-resource";
import { PersonalProviderKeys } from "@/components/settings/personal-provider-keys";
import type { ProfileSaveResult } from "@/lib/profile-editor";

export const Route = createFileRoute("/_workspace/settings")({
  component: SettingsPage,
});

const MAX_DISPLAY_NAME = 60;
const ACCOUNT_CACHE_AGE = 10 * 60_000;

function SettingsPage() {
  const { isLoading, saveProfile, isProfilePending, user } = useAuth();
  const [displayName, setDisplayName] = useState("");
  const [syncedName, setSyncedName] = useState<string | null>(null);
  const saving = isProfilePending("name");
  const [feedback, setFeedback] = useState<ProfileSaveResult | { status: "idle" }>({
    status: "idle",
  });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* The session arrives after the first render, so the field re-syncs to it. */
  if (user && user.name !== syncedName) {
    setSyncedName(user.name);
    if (syncedName === null || displayName === syncedName) setDisplayName(user.name);
  }

  async function saveDisplayName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!user || isProfilePending("name")) return;
    const name = displayName.trim();
    setFeedback({ status: "idle" });
    const result = await saveProfile({ field: "name", value: name });
    if (!mounted.current) return;
    setFeedback(result);
    if (result.status === "saved") {
      setDisplayName(name);
    } else if (result.status === "failed") {
      setSyncedName(user.name);
      setDisplayName(name);
    }
  }

  return (
    <main className="settings">
      <div className="settings-inner">
        <h1 className="settings-headline">Settings</h1>

        <div className="settings-rows">
          <AccountRow />
          <AvatarRow />
          {user ? <PersonalProviderKeys key={user.id} /> : null}

          <section className="settings-row" aria-labelledby="settings-name">
            <div className="settings-margin">
              <span className="settings-margin-name" id="settings-name">
                Display name
              </span>
              <span className="settings-margin-state">
                {isLoading || !user
                  ? "Loading"
                  : user.name.trim()
                    ? "currently active"
                    : "currently inactive"}
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
                      setFeedback({ status: "idle" });
                    }}
                    maxLength={MAX_DISPLAY_NAME}
                    placeholder={user.email}
                    autoComplete="off"
                    data-bwignore="true"
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
                    {feedback.status === "saved" && (
                      <p className="settings-saved" role="status">
                        <Check />
                        Saved
                      </p>
                    )}
                  </div>
                  {feedback.status === "failed" && (
                    <Alert variant="destructive" className="settings-field">
                      <AlertDescription>{feedback.error}</AlertDescription>
                    </Alert>
                  )}
                </form>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

type LinkedAccount = { providerId: string; createdAt: string };

async function loadAccounts(): Promise<LinkedAccount[]> {
  const response = await fetch("/api/auth/list-accounts", { credentials: "include" });
  if (!response.ok) throw new Error("Unable to load your sign-in methods.");
  return response.json();
}

function AccountRow() {
  const { isLoading, user } = useAuth();
  const { state, refresh } = useResource(user?.id ?? null, loadAccounts, {
    key: "accounts",
    maxAge: ACCOUNT_CACHE_AGE,
  });
  const accounts = state.data;

  const google = accounts?.find((account) => account.providerId === "google") ?? null;
  const github = accounts?.find((account) => account.providerId === "github") ?? null;
  const pending = isLoading || !user || (accounts === null && state.status === "loading");

  return (
    <section className="settings-row" aria-labelledby="settings-account">
      <div className="settings-margin">
        <span className="settings-margin-name" id="settings-account">
          Account
        </span>
        <span className="settings-margin-state">Manage how you sign in</span>
      </div>

      <div>
        {pending ? (
          <Skeleton className="h-8 max-w-80 rounded-lg" aria-label="Loading your account" />
        ) : (
          <p className="settings-identity">{user.email}</p>
        )}
        <p className="settings-note">
          {pending ? (
            "Reading your sign-in methods."
          ) : (
            <>
              You have been tracing claims here since <LocalTime value={user.createdAt} dateOnly />.
            </>
          )}
        </p>

        {state.status === "error" ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>
              Unable to load your sign-in methods.
              <Button type="button" variant="ghost" onClick={() => void refresh()}>
                Retry sign-in methods
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}

        <ul className="methods">
          <li
            className="method"
            data-state={accounts === null ? "unknown" : google ? "linked" : "absent"}
          >
            <GoogleMark />
            <span className="method-body">
              <span className="method-name">Google</span>
              <span className="method-detail">
                {pending ? (
                  "Checking"
                ) : accounts === null ? (
                  "Unavailable"
                ) : google ? (
                  <>
                    Linked <LocalTime value={google.createdAt} dateOnly />
                  </>
                ) : (
                  "Not linked to this account"
                )}
              </span>
            </span>
            <span className="method-state">
              {accounts === null ? "Unknown" : google ? "In use" : "Not in use"}
            </span>
          </li>
          <li
            className="method"
            data-state={accounts === null ? "unknown" : github ? "linked" : "absent"}
          >
            <GitHubMark className="size-4" />
            <span className="method-body">
              <span className="method-name">GitHub</span>
              <span className="method-detail">
                {pending ? (
                  "Checking"
                ) : accounts === null ? (
                  "Unavailable"
                ) : github ? (
                  <>
                    Linked <LocalTime value={github.createdAt} dateOnly />
                  </>
                ) : (
                  "Not linked to this account"
                )}
              </span>
            </span>
            <span className="method-state">
              {accounts === null ? "Unknown" : github ? "In use" : "Not in use"}
            </span>
          </li>
        </ul>
      </div>
    </section>
  );
}

function AvatarRow() {
  const { isLoading, saveProfile, isProfilePending, user } = useAuth();
  const saving = isProfilePending("image");
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function saveImage(next: string) {
    if (!user || isProfilePending("image")) return;
    setError(null);
    const result = await saveProfile({ field: "image", value: next });
    if (mounted.current && result.status === "failed") setError(result.error);
  }

  const pending = isLoading || !user;

  return (
    <section className="settings-row" aria-labelledby="settings-avatar">
      <div className="settings-margin">
        <span className="settings-margin-name" id="settings-avatar">
          Avatar
        </span>
        <span className="settings-margin-state">Customize your appearance</span>
      </div>

      <div className="avatar-row">
        <div>
          <p className="settings-ask">How should you show up?</p>
          <p className="settings-note">Click the avatar to shuffle and select a new one</p>
          {error && (
            <Alert variant="destructive" className="settings-field">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {pending ? (
          <Skeleton className="size-18 shrink-0 rounded-full" aria-label="Loading your avatar" />
        ) : (
          <button
            type="button"
            className="avatar-shuffle"
            onClick={() => void saveImage(shuffleAvatarId(user.image))}
            disabled={saving}
            aria-label="Shuffle to a different mark"
          >
            <TraceAvatar image={user.image} seed={user.id} className="size-18" />
            <span className="avatar-shuffle-hint" aria-hidden="true">
              <Shuffle />
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
