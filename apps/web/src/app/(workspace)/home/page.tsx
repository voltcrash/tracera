"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, useState } from "react";
import { projectReport, type CoreV2ReportView } from "@repo/ai/core/report-view";
import Image from "next/image";
import { Check, ImagePlus, Loader2, Sparkles, Trash2 } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useHistoryRefresh } from "@/components/workspace/workspace-shell";
import { apiUrl } from "@/lib/api";
import { CoreV2Report } from "@/components/analysis/core-v2-report";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const example =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";
const MAX_IMAGE_BYTES = 5_000_000;
export default function Home() {
  const { apiFetch, isLoading: isAuthLoading, user } = useAuth();
  const [text, setText] = useState("");
  const [image, setImage] = useState<{
    dataUrl: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [result, setResult] = useState<CoreV2ReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("Preparing the evidence trace.");
  const refreshHistory = useHistoryRefresh();

  async function analyze(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!text.trim() && !image) return;
    if (!user) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setProgress("Preparing the evidence trace.");
    try {
      const value = text.trim();
      const request = image
        ? { image: image.dataUrl, imageMimeType: image.mimeType }
        : isHttpUrl(value)
          ? { url: value }
          : { text: value };
      const response = await apiFetch(`${apiUrl}/v2/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          ...request,
        }),
      });
      if (!response.ok) {
        const failure = (await response.json().catch(() => null)) as { error?: unknown } | null;
        throw new Error(
          typeof failure?.error === "string" ? failure.error : "Unable to start this analysis.",
        );
      }
      const data = (await response.json()) as {
        report?: unknown;
        error?: unknown;
      };
      if (!data.report) {
        throw new Error(
          typeof data.error === "string" ? data.error : "No focused report was saved.",
        );
      }
      const view = projectReport(data.report, apiUrl);
      if (view.schemaVersion !== 2) throw new Error("The focused report format was unavailable.");
      setResult(view);
      setProgress("Focused evidence trace saved.");
      refreshHistory();
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to analyze this text.",
      );
    } finally {
      setLoading(false);
    }
  }

  async function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    await addImage(file);
  }

  function pasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const file =
      Array.from(event.clipboardData.items)
        .find((item) => item.kind === "file" && item.type.startsWith("image/"))
        ?.getAsFile() ??
      Array.from(event.clipboardData.files).find((item) => item.type.startsWith("image/"));
    if (!file) return;

    event.preventDefault();
    void addImage(file, "Pasted image");
  }

  async function addImage(file: File, fallbackName = "Image") {
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file to analyze.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Choose an image smaller than 5 MB.");
      return;
    }
    try {
      setError(null);
      setImage({
        dataUrl: await readFileAsDataUrl(file),
        mimeType: file.type,
        name: file.name || fallbackName,
      });
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "The image could not be read.");
    }
  }

  return (
    <main className="home">
      <div className={cn("home-inner", (result || loading) && "home-inner-working")}>
        {!result && !loading && <h1 className="home-headline">What did you see?</h1>}

        <form onSubmit={analyze} className="composer">
          <label className="sr-only" htmlFor="story-input">
            Story or claim to analyze
          </label>
          {image ? (
            <div className="composer-image">
              <Image
                src={image.dataUrl}
                alt="Selected for analysis"
                width={800}
                height={400}
                unoptimized
                className="h-52 w-full rounded-lg object-contain"
              />
              <div className="mt-3 flex items-center justify-between gap-3 text-sm text-ink-soft">
                <span className="truncate">{image.name}</span>
                <Button type="button" variant="outline" size="sm" onClick={() => setImage(null)}>
                  <Trash2 />
                  Remove
                </Button>
              </div>
            </div>
          ) : (
            <Textarea
              id="story-input"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onPaste={pasteImage}
              disabled={loading}
              required={!image}
              rows={4}
              placeholder="Paste a headline, claim, article, public link, or image…"
              className="composer-input"
            />
          )}
          <div className="composer-bar">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                render={
                  <label htmlFor="trace-image" className="cursor-pointer" aria-label="Add image" />
                }
                nativeButton={false}
                variant="ghost"
                size="icon-sm"
                className="text-ink-faint hover:text-foreground"
              >
                <ImagePlus />
                <input
                  id="trace-image"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={selectImage}
                  disabled={loading}
                />
              </Button>
            </div>
            <Button
              type="submit"
              variant="brand"
              className="rounded-full px-5"
              disabled={loading || isAuthLoading || (!text.trim() && !image)}
            >
              {loading ? (
                <>
                  <Loader2 className="animate-spin" /> Tracing evidence
                </>
              ) : (
                "Analyze"
              )}
            </Button>
          </div>
        </form>

        {!result && !loading && !text && !image && (
          <div className="starters">
            <button type="button" className="starter" onClick={() => setText(example)}>
              <Sparkles />
              Try an example claim
            </button>
            <label htmlFor="trace-image" className="starter">
              <ImagePlus />
              Upload a screenshot
            </label>
          </div>
        )}

        {(text || image) && !result && !loading && (
          <p className="composer-note">Links are detected automatically. Images up to 5 MB.</p>
        )}

        {loading && <TraceProgress progress={progress} />}
        {error && (
          <Alert variant="destructive" className="mt-6">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <section className="pb-24 pt-10">
            <p className="mb-6 flex items-center gap-2.5 text-sm text-ink-soft">
              <Check className="size-4 text-brand-lime-ink" />
              {result.status === "complete"
                ? "Focused evidence trace assembled"
                : `Focused evidence trace saved · ${result.status}`}
            </p>
            <CoreV2Report view={result} />
          </section>
        )}
      </div>
    </main>
  );
}

const traceStages = [
  { label: "Prepare", detail: "Read submission" },
  { label: "Claims", detail: "Separate facts" },
  { label: "Evidence", detail: "Check sources" },
  { label: "Origin", detail: "Trace Ground Zero" },
  { label: "Complete", detail: "Save the trail" },
];

function TraceProgress({ progress }: { progress: string }) {
  const current = traceProgressIndex(progress);
  return (
    <section
      className="trace-progress-panel noise mt-6 overflow-hidden rounded-3xl bg-panel p-6 text-panel-foreground shadow-(--shadow-panel) sm:p-7"
      role="status"
      aria-live="polite"
    >
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
        <h2 className="text-xl font-bold tracking-[-.02em]">{progress}</h2>
        <Badge className="bg-white/10 text-white/60">
          <Loader2 className="animate-spin" /> Analyzing
        </Badge>
      </div>
      <ol className="relative z-10 mt-8 grid gap-y-4 sm:grid-cols-5 sm:gap-x-3">
        {traceStages.map((stage, index) => {
          const done = index < current;
          const active = index === current;
          return (
            <li
              key={stage.label}
              className={cn(
                "border-t-2 pt-3 transition-opacity",
                done && "border-brand-lime",
                active && "border-brand-lime",
                !done && !active && "border-white/15 opacity-45",
              )}
            >
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                {done && <Check className="size-3.5 text-brand-lime" />}
                {stage.label}
              </p>
              <p className="mt-0.5 text-xs text-white/45">{stage.detail}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function traceProgressIndex(progress: string) {
  const message = progress.toLowerCase();
  if (message.includes("saved") || message.includes("completed")) return 4;
  if (message.includes("earliest") || message.includes("publication")) return 3;
  if (message.includes("evidence") || message.includes("scored claim")) return 2;
  if (message.includes("separating") || message.includes("factual claims")) return 1;
  return 0;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol);
  } catch {
    return false;
  }
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("The image could not be read."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("The image could not be read."));
    };
    reader.readAsDataURL(file);
  });
}
