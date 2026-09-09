"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, useState } from "react";
import type { AnalysisResponse, AnalysisReuse, ImageMetadata } from "@repo/contracts";
import dynamic from "next/dynamic";
import Image from "next/image";
import { Check, ExternalLink, ImagePlus, Loader2, Newspaper, Sparkles, Trash2 } from "lucide-react";
import { useAuth } from "@/components/providers/auth-provider";
import { useHistoryRefresh } from "@/components/workspace/workspace-shell";
import { apiUrl } from "@/lib/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import Link from "next/link";
import { cn } from "@/lib/utils";

const TraceReport = dynamic(() =>
  import("@/components/analysis/trace-report").then((module) => module.TraceReport),
);
const TraceAside = dynamic(() =>
  import("@/components/analysis/trace-report").then((module) => module.TraceAside),
);

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
  const [publishPublicly, setPublishPublicly] = useState(false);
  const refreshHistory = useHistoryRefresh();

  async function analyze(event?: FormEvent<HTMLFormElement>, forceReanalysis = false) {
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
      const response = await apiFetch(`${apiUrl}/analyze/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          ...(forceReanalysis ? { forceReanalysis: true } : {}),
          visibility: publishPublicly ? "public" : "private",
          ...(publishPublicly ? { publishConsent: true } : {}),
        }),
      });
      if (!response.ok) throw new Error("Unable to start this analysis.");
      setResult(await readAnalysisStream(response, setProgress));
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
              {user && (
                <div className="flex min-w-0 items-start gap-2">
                  <Checkbox
                    id="publish-trace"
                    checked={publishPublicly}
                    onCheckedChange={(checked) => setPublishPublicly(checked === true)}
                    disabled={loading}
                    aria-describedby="publish-consent-note"
                  />
                  <div className="min-w-0">
                    <Label htmlFor="publish-trace" className="text-xs font-semibold leading-5">
                      Publish this analysis publicly (optional)
                    </Label>
                    <p id="publish-consent-note" className="text-[11px] leading-4 text-ink-faint">
                      Analyses are private by default. I agree to publish the submitted text,
                      images, metadata, and analysis results publicly.
                    </p>
                  </div>
                </div>
              )}
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
            <Link href="/hub" className="starter">
              <Newspaper />
              Browse traces others have run
            </Link>
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
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2.5 text-sm text-ink-soft">
                <Check className="size-4 text-brand-lime-ink" />
                Evidence trail assembled
              </p>
              <div className="flex items-center gap-3">
                <ReuseNotice reuse={result.reuse} cached={result.cached} />
                {result.reuse?.state === "reused_exact" && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void analyze(undefined, true)}
                    disabled={loading}
                  >
                    Check again with today&rsquo;s evidence
                  </Button>
                )}
              </div>
            </div>
            <TraceReport
              claims={result.claims}
              score={result.traceraScore}
              framing={result.framingAnalysis}
              groundZero={result.groundZero}
            >
              {result.inputMetadata && <ImageProvenance metadata={result.inputMetadata} />}
            </TraceReport>
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
      value:
        metadata.textExtractionProvider === "ai_provider" ? "Selected AI provider" : "Unavailable",
    },
    { label: "File type", value: metadata.mimeType ?? "Unknown" },
    ...exif.slice(0, 4).map(([label, value]) => ({ label, value })),
  ];

  return (
    <TraceAside margin="The file" gloss="Metadata carried inside the image itself.">
      <h2 className="trace-section-title">The file leaves clues too</h2>
      <p className="trace-section-say">
        Visible text and embedded metadata were inspected alongside the claims.
      </p>
      <dl className="mt-6 max-w-[38rem]">
        {details.map((detail) => (
          <ProvenanceMetric key={detail.label} label={detail.label} value={detail.value} />
        ))}
        {!exif.length && (
          <p className="pt-3 text-sm text-ink-faint">
            No embedded camera or location data was present.
          </p>
        )}
      </dl>
      {metadata.reverseSearchUrl && (
        <a
          href={metadata.reverseSearchUrl}
          target="_blank"
          rel="noreferrer"
          className="trace-external mt-4 inline-flex text-sm"
        >
          Search this image with Google Lens
          <ExternalLink />
        </a>
      )}
    </TraceAside>
  );
}

function ProvenanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-t border-line-weak py-2.5">
      <dt className="text-sm capitalize text-ink-faint">{label}</dt>
      <dd className="truncate text-sm font-semibold" title={value}>
        {value}
      </dd>
    </div>
  );
}

function ReuseNotice({ reuse, cached }: { reuse?: AnalysisReuse; cached: boolean }) {
  if (reuse?.state === "reused_exact" && reuse.expiresAt) {
    return (
      <Badge variant="lime">
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
