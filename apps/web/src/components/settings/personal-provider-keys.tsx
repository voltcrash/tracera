import { useEffect, useRef, useState, type FormEvent } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Check, Loader2 } from "lucide-react";
import type { AiProviderName } from "@repo/ai";
import {
  activateProviderKey,
  deleteProviderKey,
  listProviderKeys,
  saveProviderKey,
} from "@/server/provider-keys.functions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LocalTime } from "@/components/ui/local-time";
import { Skeleton } from "@/components/ui/skeleton";

import { useAuth } from "@/components/providers/auth-provider";
import { useResource } from "@/lib/use-resource";

const PROVIDERS: Record<AiProviderName, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  "openai-compatible": "OpenAI-compatible",
};
type KeyMutation =
  | { status: "idle" | "pending" }
  | { status: "failed"; error: string }
  | { status: "succeeded"; message: string };
const selectClass = "h-10 w-full rounded-lg border border-input bg-background px-3 text-sm";

export function PersonalProviderKeys() {
  const load = useServerFn(listProviderKeys);
  const save = useServerFn(saveProviderKey);
  const remove = useServerFn(deleteProviderKey);
  const activate = useServerFn(activateProviderKey);
  const { user } = useAuth();
  const { state: metadata, refresh } = useResource(user?.id ?? null, load);
  const data = metadata.data;
  const [provider, setProvider] = useState<AiProviderName>("gemini");
  const [embeddingProvider, setEmbeddingProvider] =
    useState<Exclude<AiProviderName, "anthropic">>("gemini");
  const [separateEmbedding, setSeparateEmbedding] = useState(false);
  const [mutation, setMutation] = useState<KeyMutation>({ status: "idle" });
  const locked = useRef(false);
  const mounted = useRef(true);
  const busy = mutation.status === "pending" || metadata.status !== "ready";
  const error = mutation.status === "failed" ? mutation.error : null;
  const message = mutation.status === "succeeded" ? mutation.message : null;
  const separate = separateEmbedding || provider === "anthropic";

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function runMutation(
    request: () => Promise<{ ok: boolean; error?: string }>,
    success: string,
    failure: string,
    confirmed?: () => void,
  ) {
    if (locked.current || metadata.status !== "ready") return;
    locked.current = true;
    setMutation({ status: "pending" });
    try {
      let result;
      try {
        result = await request();
      } catch {
        if (mounted.current) setMutation({ status: "failed", error: failure });
        return;
      }
      if (!mounted.current) return;
      if (!result.ok) {
        setMutation({
          status: "failed",
          error: result.error ?? "This key is no longer available. Please reload and try again.",
        });
        return;
      }
      confirmed?.();
      setMutation({ status: "succeeded", message: success });
      await refresh();
    } finally {
      locked.current = false;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const value = (name: string) => {
      const field = values.get(name);
      return typeof field === "string" ? field.trim() : "";
    };
    void runMutation(
      () =>
        save({
          data: {
            provider,
            apiKey: value("apiKey"),
            model: value("model"),
            embeddingModel: value("embeddingModel"),
            ...(provider === "openai-compatible" ? { baseUrl: value("baseUrl") } : {}),
            ...(separate
              ? {
                  embeddingProvider,
                  embeddingApiKey: value("embeddingApiKey"),
                  ...(embeddingProvider === "openai-compatible"
                    ? { embeddingBaseUrl: value("embeddingBaseUrl") }
                    : {}),
                }
              : {}),
          },
        }),
      "Key verified and saved. New analyses will use it.",
      "Could not save your provider key. Please try again.",
      () => {
        for (const name of ["apiKey", "embeddingApiKey"]) {
          const field = form.elements.namedItem(name);
          if (field instanceof HTMLInputElement) field.value = "";
        }
      },
    );
  }

  function updateKey(keyProvider: AiProviderName, action: "activate" | "delete") {
    return runMutation(
      () => (action === "activate" ? activate : remove)({ data: { provider: keyProvider } }),
      action === "activate" ? "New analyses will use this key." : "Provider key removed.",
      "Could not update your provider key. Please try again.",
    );
  }

  const active = data?.keys.find((key) => key.status === "active");
  return (
    <section className="settings-row" aria-labelledby="settings-provider-keys">
      <div className="settings-margin">
        <span className="settings-margin-name" id="settings-provider-keys">
          AI provider
        </span>
        <span className="settings-margin-state">
          {active
            ? `${PROVIDERS[active.provider]} ${active.health === "rejected" ? "needs attention" : "in use"}`
            : "Use your own key"}
        </span>
      </div>
      <div className="min-w-0">
        <p className="settings-ask">Choose who powers your traces.</p>
        <p className="settings-note">
          Your active key pays for generation and embeddings. Keys are stored encrypted, and only
          the last four characters are shown here. Rate and concurrency limits still apply.
          Switching affects new traces. Removing a key blocks further requests from unfinished
          traces.
        </p>
        {metadata.status === "error" ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>
              Unable to load your provider keys.
              {data ? " Previously loaded information is shown below." : null}
              <Button type="button" variant="ghost" onClick={() => void refresh()}>
                Retry provider keys
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive" className="mt-4">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {message ? (
          <p className="settings-saved mt-4" role="status">
            <Check />
            {message}
          </p>
        ) : null}
        {!data && metadata.status === "loading" ? (
          <Skeleton className="mt-5 h-24 rounded-lg" aria-label="Loading your provider keys" />
        ) : null}
        {data ? (
          <>
            {data.keys.length > 0 ? (
              <ul className="mt-5 divide-y divide-border" aria-label="Saved provider keys">
                {data.keys.map((key) => (
                  <li key={key.provider} className="py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">
                          {PROVIDERS[key.provider]} ·{" "}
                          <span className="font-mono">••••{key.fingerprint}</span>
                        </p>
                        <p className="mt-1 break-all text-xs text-muted-foreground">
                          {key.model} · {key.embeddingModel}
                        </p>
                        {key.baseUrl ? (
                          <p className="mt-1 break-all text-xs text-muted-foreground">
                            {key.baseUrl}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {key.lastUsedAt ? (
                            <>
                              Last used <LocalTime value={key.lastUsedAt.toISOString()} />
                            </>
                          ) : (
                            "Not used for an analysis yet"
                          )}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {key.health === "rejected" ? (
                          <span className="text-sm text-destructive">
                            Key rejected. Replace it to continue.
                          </span>
                        ) : key.status === "active" ? (
                          <span className="settings-saved">
                            <Check />
                            Active
                          </span>
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={busy || !data.available}
                            onClick={() => void updateKey(key.provider, "activate")}
                          >
                            Use {PROVIDERS[key.provider]} key
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={busy}
                          onClick={() => void updateKey(key.provider, "delete")}
                          aria-label={`Remove ${PROVIDERS[key.provider]} key`}
                        >
                          Remove
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="settings-note">
                No personal keys saved. Tracera uses its platform provider when one is available.
              </p>
            )}
            {data.available ? (
              <form className="mt-6 max-w-96 space-y-4" onSubmit={submit}>
                <fieldset className="space-y-4" disabled={busy}>
                  <div className="space-y-2">
                    <Label htmlFor="personal-provider">Provider</Label>
                    <select
                      id="personal-provider"
                      className={selectClass}
                      value={provider}
                      onChange={(event) => setProvider(event.target.value as AiProviderName)}
                    >
                      {Object.entries(PROVIDERS).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <KeyField name="apiKey" label="Provider API key" secret />
                  {provider === "openai-compatible" ? (
                    <KeyField
                      name="baseUrl"
                      label="HTTPS base URL"
                      type="url"
                      placeholder="https://provider.example/v1"
                    />
                  ) : null}
                  <KeyField name="model" label="Generation model" />
                  <KeyField name="embeddingModel" label="Embedding model" />
                  <p className="settings-note">
                    Choose a generation model with structured output support and an embedding model
                    that supports 1024 dimensions.
                  </p>
                  {provider === "anthropic" ? (
                    <p className="settings-note">
                      Anthropic needs a separate provider for embeddings.
                    </p>
                  ) : (
                    <Label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={separateEmbedding}
                        onChange={(event) => setSeparateEmbedding(event.target.checked)}
                      />
                      Use a separate embedding provider
                    </Label>
                  )}
                  {separate ? (
                    <>
                      <div className="space-y-2">
                        <Label htmlFor="personal-embedding-provider">Embedding provider</Label>
                        <select
                          id="personal-embedding-provider"
                          className={selectClass}
                          value={embeddingProvider}
                          onChange={(event) =>
                            setEmbeddingProvider(
                              event.target.value as Exclude<AiProviderName, "anthropic">,
                            )
                          }
                        >
                          {Object.entries(PROVIDERS)
                            .filter(([id]) => id !== "anthropic")
                            .map(([id, label]) => (
                              <option key={id} value={id}>
                                {label}
                              </option>
                            ))}
                        </select>
                      </div>
                      <KeyField name="embeddingApiKey" label="Embedding API key" secret />
                      {embeddingProvider === "openai-compatible" ? (
                        <KeyField
                          name="embeddingBaseUrl"
                          label="Embedding HTTPS base URL"
                          type="url"
                        />
                      ) : null}
                    </>
                  ) : null}
                  <p className="settings-note">
                    Verifying sends a tiny generation request and an embedding request. Your
                    provider may charge for these checks. Saving replaces this provider’s key and
                    makes it active for new analyses.
                  </p>
                  <Button type="submit" variant="brand" className="rounded-full px-5">
                    {mutation.status === "pending" ? (
                      <>
                        <Loader2 className="animate-spin" />
                        Verifying…
                      </>
                    ) : (
                      "Verify and save key"
                    )}
                  </Button>
                </fieldset>
              </form>
            ) : (
              <p className="settings-note">
                Personal provider keys are not enabled on this site yet.
              </p>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

function KeyField({
  name,
  label,
  secret = false,
  type = "text",
  placeholder,
}: {
  name: string;
  label: string;
  secret?: boolean;
  type?: "text" | "url";
  placeholder?: string;
}) {
  const id = `personal-${name}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        name={name}
        type={secret ? "password" : type}
        required
        minLength={secret ? 8 : 1}
        maxLength={secret ? 4096 : type === "url" ? 2048 : 200}
        autoComplete={secret ? "new-password" : "off"}
        spellCheck={false}
        data-bwignore="true"
        placeholder={placeholder}
      />
    </div>
  );
}
