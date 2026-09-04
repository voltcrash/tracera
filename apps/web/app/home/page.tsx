"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, useState } from "react";
import type { AnalysisResponse, AnalysisReuse, ImageMetadata } from "@repo/contracts";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ExternalLink,
  ImagePlus,
  Loader2,
  Sparkles,
  Trash2,
} from "lucide-react";
import { AnalysisResult } from "../components/analysis-result";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";
import { GroundZeroCard } from "../components/ground-zero-card";
import { apiUrl } from "../lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("Preparing the evidence trace.");
  const [privateTrace, setPrivateTrace] = useState(false);
  const [showAuthPrompt, setShowAuthPrompt] = useState(false);

  async function analyze(event?: FormEvent<HTMLFormElement>, forceReanalysis = false) {
    event?.preventDefault();
    if (!text.trim() && !image) return;
    if (!user) {
      setShowAuthPrompt(true);
      return;
    }
    setShowAuthPrompt(false);
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
      const response = await apiFetch(`${apiUrl}/analyze/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          ...(forceReanalysis ? { forceReanalysis: true } : {}),
          ...(privateTrace ? { visibility: "private" } : {}),
        }),
      });
      if (!response.ok) throw new Error("Unable to start this analysis.");
      setResult(await readAnalysisStream(response, setProgress));
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
    <main className="app-enter paper-grid min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="home" />
        <section
          className={`mx-auto flex max-w-4xl flex-col justify-center ${result || loading ? "py-12 sm:py-16" : "min-h-[calc(100vh-10rem)] py-16 sm:py-24"}`}
        >
          <div className="text-center">
            <h1 className="text-4xl font-black leading-[.94] tracking-[-.07em] sm:text-6xl">
              Trace a story to its source.
            </h1>
            <p className="mx-auto mt-5 max-w-[52ch] text-base leading-relaxed text-muted-foreground">
              Paste what you&apos;ve seen. Tracera separates the claims, retrieves the evidence, and
              shows how the verdict was built.
            </p>
          </div>

          <form
            onSubmit={analyze}
            className="analyze-composer mt-10 overflow-hidden rounded-3xl border border-border bg-card shadow-[0_28px_75px_-46px_rgba(16,34,31,.62)]"
          >
            <label className="sr-only" htmlFor="story-input">
              Story or claim to analyze
            </label>
            {image ? (
              <div className="relative m-3 overflow-hidden rounded-2xl bg-muted p-4 sm:m-4">
                <Image
                  src={image.dataUrl}
                  alt="Selected for analysis"
                  width={800}
                  height={400}
                  unoptimized
                  className="h-56 w-full rounded-xl object-contain"
                />
                <div className="mt-3 flex items-center justify-between gap-3 text-sm font-semibold text-muted-foreground">
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
                rows={5}
                placeholder="Paste a headline, claim, article, public link, or image…"
                className="min-h-44 resize-none rounded-none border-0 bg-transparent p-6 text-base font-medium leading-7 shadow-none focus-visible:ring-0 sm:min-h-48 sm:p-7"
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border bg-muted/60 px-5 py-4 sm:px-6">
              <div className="flex items-center gap-1">
                <Button type="button" variant="link" size="sm" onClick={() => setText(example)}>
                  <Sparkles />
                  Try an example
                </Button>
                <Button asChild variant="link" size="sm">
                  <label className="cursor-pointer">
                    <ImagePlus />
                    Add image
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      onChange={selectImage}
                      disabled={loading}
                    />
                  </label>
                </Button>
              </div>
              <Button
                type="submit"
                variant="brand"
                size="lg"
                disabled={loading || isAuthLoading || (!text.trim() && !image)}
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" /> Tracing evidence…
                  </>
                ) : (
                  <>
                    Analyze <ArrowRight />
                  </>
                )}
              </Button>
            </div>
            {user && (
              <div className="flex items-center gap-2.5 border-t border-border px-6 py-3.5">
                <Checkbox
                  id="private-trace"
                  checked={privateTrace}
                  onCheckedChange={(checked) => setPrivateTrace(checked === true)}
                  disabled={loading}
                />
                <Label htmlFor="private-trace" className="text-xs text-muted-foreground">
                  Keep this trace private
                </Label>
              </div>
            )}
          </form>
          {showAuthPrompt && !user && (
            <Alert variant="info" className="mt-5">
              <Check />
              <AlertTitle>Sign in to start this fact-check.</AlertTitle>
              <AlertDescription>
                <p>Log in or create an account to trace it against the evidence.</p>
                <div className="mt-3 flex gap-2">
                  <Button asChild size="sm">
                    <Link href="/login">Log in</Link>
                  </Button>
                  <Button asChild size="sm" variant="outline">
                    <Link href="/signup">Create account</Link>
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}
          <p className="mt-4 text-center text-xs text-muted-foreground">
            Links are detected automatically. Images up to 5 MB.
          </p>

          {loading && <TraceProgress progress={progress} />}
          {error && (
            <Alert variant="destructive" className="mt-6">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </section>
        {result && (
          <section className="pb-20">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
              <p className="flex items-center gap-2.5 text-sm font-semibold">
                <Check className="size-4 text-brand-emerald" />
                Evidence trail assembled
              </p>
              <ReuseNotice reuse={result.reuse} cached={result.cached} />
            </div>
            <AnalysisResult
              claims={result.claims}
              score={result.traceraScore}
              framing={result.framingAnalysis}
            />
            {result.reuse?.state === "reused_exact" && (
              <Button
                type="button"
                variant="outline"
                className="mt-4"
                onClick={() => void analyze(undefined, true)}
                disabled={loading}
              >
                Analyze again with current evidence
              </Button>
            )}
            {result.groundZero && <GroundZeroCard trace={result.groundZero} />}
            {result.inputMetadata && <ImageProvenance metadata={result.inputMetadata} />}
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
      className="trace-progress-panel noise mt-6 overflow-hidden rounded-3xl bg-brand-deep p-6 text-white shadow-[0_28px_65px_-36px_rgba(6,78,59,.8)] sm:p-7"
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
                done && "border-brand-mint",
                active && "border-brand-mint",
                !done && !active && "border-white/15 opacity-45",
              )}
            >
              <p className="flex items-center gap-1.5 text-sm font-semibold">
                {done && <Check className="size-3.5 text-brand-mint" />}
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

async function readAnalysisStream(
  response: Response,
  onProgress: (message: string) => void,
): Promise<AnalysisResponse> {
  if (!response.body) throw new Error("The analysis stream was unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let completed: AnalysisResponse | undefined;

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = frame.match(/^event:\s*(.+)$/m)?.[1];
      const rawData = frame.match(/^data:\s*(.+)$/m)?.[1];
      if (!event || !rawData) continue;
      const data = JSON.parse(rawData) as {
        message?: unknown;
        error?: unknown;
      } & Partial<AnalysisResponse>;
      if (event === "progress" && typeof data.message === "string") {
        onProgress(data.message);
      } else if (event === "error") {
        throw new Error(typeof data.error === "string" ? data.error : "Analysis failed.");
      } else if (event === "complete") {
        completed = data as AnalysisResponse;
      }
    }
    if (done) break;
  }
  if (!completed) throw new Error("The analysis stream ended unexpectedly.");
  return completed;
}

function ImageProvenance({ metadata }: { metadata: ImageMetadata }) {
  const exif = Object.entries(metadata.exif ?? {});
  const details = [
    {
      label: "Text extraction",
      value: metadata.ocrProvider === "configured" ? "Provider verified" : "Model fallback",
    },
    { label: "File type", value: metadata.mimeType ?? "Unknown" },
    ...exif.slice(0, 4).map(([label, value]) => ({ label, value })),
  ];

  return (
    <section className="mt-8 border-t border-border pt-8">
      <div className="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <div>
          <h2 className="text-2xl font-extrabold tracking-[-.03em]">The file leaves clues too</h2>
          <p className="mt-2 max-w-[46ch] text-sm leading-relaxed text-muted-foreground">
            Visible text and embedded metadata were inspected alongside the claims.
          </p>
          {metadata.reverseSearchUrl && (
            <Button asChild variant="link" size="sm" className="mt-2 -ml-3">
              <a href={metadata.reverseSearchUrl} target="_blank" rel="noreferrer">
                Search this image with Google Lens
                <ExternalLink />
              </a>
            </Button>
          )}
        </div>
        {exif.length || details.length ? (
          <dl className="divide-y divide-border">
            {details.map((detail) => (
              <ProvenanceMetric key={detail.label} label={detail.label} value={detail.value} />
            ))}
            {!exif.length && (
              <div className="py-2.5 text-sm text-muted-foreground">
                No embedded camera or location data was present.
              </div>
            )}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

function ProvenanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 py-2.5">
      <dt className="text-sm capitalize text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm font-semibold" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ReuseNotice({ reuse, cached }: { reuse?: AnalysisReuse; cached: boolean }) {
  if (reuse?.state === "reused_exact" && reuse.expiresAt) {
    return (
      <Badge variant="emerald">
        Recent trace reused · {new Date(reuse.expiresAt).toLocaleDateString()}
      </Badge>
    );
  }
  if (reuse?.state === "reanalyzed") return <Badge variant="violet">Freshly re-analyzed</Badge>;
  if (reuse && reuse.relatedContextClaims)
    return (
      <Badge variant="amber">
        {reuse.relatedContextClaims} related claim
        {reuse.relatedContextClaims === 1 ? "" : "s"} used
      </Badge>
    );
  return cached ? <Badge variant="slate">Recent matching check</Badge> : null;
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
