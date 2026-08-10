"use client";

import { ChangeEvent, ClipboardEvent, FormEvent, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
  AnalysisResult,
  type ClaimResult,
  type TraceraScore,
} from "../components/analysis-result";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";
import {
  GroundZeroCard,
  type GroundZeroTrace,
} from "../components/ground-zero-card";
import { apiUrl } from "../lib/api";

const example =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";
const MAX_IMAGE_BYTES = 5_000_000;
type ReuseState = {
  state: "reused_exact" | "fresh" | "reanalyzed" | "scheduled_recheck";
  expiresAt?: string;
  relatedContextClaims?: number;
};
type ImageMetadata = {
  mimeType?: string;
  reverseSearchUrl?: string;
  exif?: Record<string, string>;
  ocrProvider?: "configured" | "model_fallback";
};
type AnalysisResponse = {
  claims: ClaimResult[];
  traceraScore: TraceraScore;
  cached: boolean;
  groundZero?: GroundZeroTrace;
  reuse?: ReuseState;
  inputMetadata?: ImageMetadata;
};

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

  async function analyze(
    event?: FormEvent<HTMLFormElement>,
    forceReanalysis = false,
  ) {
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
        requestError instanceof Error
          ? requestError.message
          : "Unable to analyze this text.",
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
      Array.from(event.clipboardData.files).find((item) =>
        item.type.startsWith("image/"),
      );
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
      setError(
        readError instanceof Error
          ? readError.message
          : "The image could not be read.",
      );
    }
  }

  return (
    <main className="app-enter paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-7xl px-5 sm:px-8">
        <AppHeader active="home" />
        <section
          className={`mx-auto flex max-w-4xl flex-col justify-center ${result || loading ? "py-12 sm:py-16" : "min-h-[calc(100vh-10rem)] py-16 sm:py-24"}`}
        >
          <div className="text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-emerald-950/10 bg-white/70 px-3 py-1.5 text-[10px] font-black tracking-[.17em] text-emerald-700 shadow-sm">
              <span className="size-1.5 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.12)]" />
              START A TRACE
            </p>
            <h1 className="mt-5 text-4xl font-black leading-[.94] tracking-[-.07em] sm:text-6xl">
              Trace a story to its source.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-emerald-950/58">
              Paste what you&apos;ve seen. Tracera will separate the claims,
              retrieve the evidence, and show exactly how the verdict was built.
            </p>
          </div>

          <form
            onSubmit={analyze}
            className="analyze-composer mt-10 overflow-hidden rounded-[2rem] border border-emerald-950/10 bg-white shadow-[0_28px_75px_-46px_rgba(16,34,31,.62)]"
          >
            <label className="sr-only" htmlFor="story-input">
              Story or claim to analyze
            </label>
            {image ? (
              <div className="relative m-3 overflow-hidden rounded-[1.35rem] bg-[#f3f7f3] p-4 sm:m-4">
                <Image
                  src={image.dataUrl}
                  alt="Selected for analysis"
                  width={800}
                  height={400}
                  unoptimized
                  className="h-56 w-full rounded-xl object-contain"
                />
                <div className="mt-3 flex items-center justify-between gap-3 text-sm font-semibold text-emerald-950/70">
                  <span className="truncate">{image.name}</span>
                  <button
                    type="button"
                    onClick={() => setImage(null)}
                    className="shrink-0 rounded-lg border border-emerald-950/8 bg-white px-3 py-1.5 text-xs font-black text-emerald-800 shadow-sm"
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <textarea
                id="story-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onPaste={pasteImage}
                disabled={loading}
                required={!image}
                rows={5}
                placeholder="Paste a headline, claim, article, public link, or image…"
                className="min-h-44 w-full resize-none bg-transparent p-6 text-base font-medium leading-7 outline-none placeholder:text-emerald-950/28 disabled:bg-slate-50 sm:min-h-48 sm:p-7"
              />
            )}
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-emerald-950/8 bg-[#f7f9f6] px-5 py-4 sm:px-6">
              <div className="flex items-center gap-4">
                <button
                  type="button"
                  onClick={() => setText(example)}
                  className="text-xs font-black text-emerald-800 transition hover:text-emerald-600"
                >
                  ✦ Try an example
                </button>
                <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs font-black text-emerald-800 transition hover:text-emerald-600">
                  <ImageIcon />
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
              </div>
              <button
                type="submit"
                disabled={loading || isAuthLoading || (!text.trim() && !image)}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-950 px-5 py-3.5 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5 hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
              >
                {loading ? (
                  <>
                    <Spinner /> Tracing evidence…
                  </>
                ) : (
                  <>
                    Analyze <span>→</span>
                  </>
                )}
              </button>
            </div>
            {user && (
              <label className="flex cursor-pointer items-center gap-2 border-t border-emerald-950/8 px-6 py-3 text-[10px] font-bold text-emerald-950/48">
                <input
                  type="checkbox"
                  checked={privateTrace}
                  onChange={(event) => setPrivateTrace(event.target.checked)}
                  disabled={loading}
                  className="accent-emerald-800"
                />
                Keep this trace private
              </label>
            )}
          </form>
          {showAuthPrompt && !user && (
            <div
              className="mt-5 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 text-center text-sm text-emerald-950"
              role="status"
            >
              <p className="font-bold">Sign in to start this fact-check.</p>
              <p className="mt-1 text-emerald-950/65">
                Log in or create an account to trace it against the evidence.
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Link
                  href="/login"
                  className="rounded-xl bg-emerald-950 px-4 py-2.5 font-black text-white transition hover:bg-emerald-800"
                >
                  Log in
                </Link>
                <Link
                  href="/signup"
                  className="rounded-xl border border-emerald-950/15 bg-white px-4 py-2.5 font-black text-emerald-950 transition hover:bg-emerald-100"
                >
                  Create account
                </Link>
              </div>
            </div>
          )}
          <p className="mt-4 text-center text-[10px] font-bold tracking-[.04em] text-emerald-950/38">
            LINKS DETECT AUTOMATICALLY · IMAGES UP TO 5 MB · PRIVATE BY CHOICE
          </p>

          {loading && <TraceProgress progress={progress} />}
          {error && (
            <p
              className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
              role="alert"
            >
              {error}
            </p>
          )}
        </section>
        {result && (
          <section className="pb-20">
            <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-emerald-950/10 bg-white/70 px-5 py-4 shadow-[0_16px_40px_-34px_rgba(16,34,31,.6)]">
              <div className="flex items-center gap-3">
                <span className="grid size-9 place-items-center rounded-xl bg-emerald-950 text-[#9cf0d1]">
                  ✓
                </span>
                <div>
                  <p className="text-[9px] font-black tracking-[.16em] text-emerald-700">
                    TRACE COMPLETE
                  </p>
                  <p className="mt-0.5 text-sm font-black text-emerald-950">
                    Evidence trail assembled
                  </p>
                </div>
              </div>
              <ReuseNotice reuse={result.reuse} cached={result.cached} />
            </div>
            <AnalysisResult
              claims={result.claims}
              score={result.traceraScore}
            />
            {result.reuse?.state === "reused_exact" && (
              <button
                type="button"
                onClick={() => void analyze(undefined, true)}
                disabled={loading}
                className="mt-4 rounded-xl border border-emerald-900/15 bg-white px-4 py-2.5 text-sm font-black text-emerald-800 transition hover:bg-emerald-50 disabled:opacity-50"
              >
                Analyze again with current evidence
              </button>
            )}
            {result.groundZero && <GroundZeroCard trace={result.groundZero} />}
            {result.inputMetadata && (
              <ImageProvenance metadata={result.inputMetadata} />
            )}
          </section>
        )}
      </div>
    </main>
  );
}

function ImageIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
    </svg>
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
      className="trace-progress-panel noise mt-6 overflow-hidden rounded-[2rem] bg-[#0e3028] p-6 text-white shadow-[0_28px_65px_-36px_rgba(6,78,59,.8)] sm:p-7"
      role="status"
      aria-live="polite"
    >
      <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[9px] font-black tracking-[.18em] text-[#9cf0d1]">
            LIVE EVIDENCE TRACE
          </p>
          <h2 className="mt-2 text-xl font-black tracking-[-.035em]">
            {progress}
          </h2>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-white/8 px-3 py-1.5 text-[9px] font-black text-white/58">
          <Spinner /> ANALYZING
        </span>
      </div>
      <ol className="relative z-10 mt-7 grid gap-2 sm:grid-cols-5">
        {traceStages.map((stage, index) => {
          const state =
            index < current ? "done" : index === current ? "active" : "waiting";
          return (
            <li
              key={stage.label}
              className={`trace-progress-step trace-progress-step-${state}`}
            >
              <span className="trace-progress-number">
                {state === "done" ? "✓" : String(index + 1).padStart(2, "0")}
              </span>
              <span>
                <strong>{stage.label}</strong>
                <small>{stage.detail}</small>
              </span>
            </li>
          );
        })}
      </ol>
      <div className="relative z-10 mt-5 h-1 overflow-hidden rounded-full bg-white/10">
        <span
          className="trace-progress-bar block h-full rounded-full bg-[#9cf0d1]"
          style={{ width: `${((current + 1) / traceStages.length) * 100}%` }}
        />
      </div>
    </section>
  );
}

function traceProgressIndex(progress: string) {
  const message = progress.toLowerCase();
  if (message.includes("saved") || message.includes("completed")) return 4;
  if (message.includes("earliest") || message.includes("publication")) return 3;
  if (message.includes("evidence") || message.includes("scored claim"))
    return 2;
  if (message.includes("separating") || message.includes("factual claims"))
    return 1;
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
        throw new Error(
          typeof data.error === "string" ? data.error : "Analysis failed.",
        );
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
  return (
    <section className="landing-view-reveal mt-5 overflow-hidden rounded-[2rem] border border-violet-950/10 bg-[#eee8fb] p-6 shadow-[0_24px_60px_-46px_rgba(16,34,31,.5)] sm:p-8">
      <div className="grid gap-7 sm:grid-cols-[.75fr_1.25fr] sm:items-start">
        <div>
          <p className="text-[10px] font-black tracking-[.18em] text-violet-700">
            IMAGE PROVENANCE
          </p>
          <h2 className="mt-3 text-2xl font-black leading-tight tracking-[-.045em] text-violet-950">
            The file leaves clues too.
          </h2>
          <p className="mt-3 text-sm leading-6 text-violet-950/55">
            Visible text and embedded metadata were inspected alongside the
            claims.
          </p>
        </div>
        <div className="rounded-2xl border border-violet-950/8 bg-white/65 p-4">
          <div className="grid gap-2 sm:grid-cols-2">
            <ProvenanceMetric
              label="OCR"
              value={
                metadata.ocrProvider === "configured"
                  ? "Provider verified"
                  : "Model fallback"
              }
            />
            <ProvenanceMetric
              label="File type"
              value={metadata.mimeType ?? "Unknown"}
            />
            {exif.slice(0, 4).map(([key, value]) => (
              <ProvenanceMetric key={key} label={key} value={value} />
            ))}
          </div>
          {!exif.length && (
            <p className="mt-3 rounded-xl bg-violet-50 px-3 py-2.5 text-xs font-semibold text-violet-950/52">
              No embedded EXIF details were available.
            </p>
          )}
          {metadata.reverseSearchUrl && (
            <a
              href={metadata.reverseSearchUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-2 text-xs font-black text-violet-800 transition hover:gap-3"
            >
              Search with Google Lens <span>↗</span>
            </a>
          )}
        </div>
      </div>
    </section>
  );
}

function ProvenanceMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/80 px-3 py-2.5">
      <p className="text-[8px] font-black uppercase tracking-[.12em] text-violet-950/35">
        {label}
      </p>
      <p
        className="mt-1 truncate text-[10px] font-black text-violet-950/72"
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function ReuseNotice({
  reuse,
  cached,
}: {
  reuse?: ReuseState;
  cached: boolean;
}) {
  if (reuse?.state === "reused_exact" && reuse.expiresAt) {
    return (
      <span className="rounded-full bg-emerald-100 px-3 py-1.5 text-[9px] font-black text-emerald-800">
        RECENT TRACE REUSED · {new Date(reuse.expiresAt).toLocaleDateString()}
      </span>
    );
  }
  if (reuse?.state === "reanalyzed")
    return (
      <span className="rounded-full bg-violet-100 px-3 py-1.5 text-[9px] font-black text-violet-800">
        FRESHLY RE-ANALYZED
      </span>
    );
  if (reuse && reuse.relatedContextClaims)
    return (
      <span className="rounded-full bg-amber-100 px-3 py-1.5 text-[9px] font-black text-amber-800">
        {reuse.relatedContextClaims} RELATED CLAIM
        {reuse.relatedContextClaims === 1 ? "" : "S"} USED
      </span>
    );
  return cached ? (
    <span className="rounded-full bg-slate-100 px-3 py-1.5 text-[9px] font-black text-slate-700">
      RECENT MATCHING CHECK
    </span>
  ) : null;
}

function Spinner() {
  return (
    <span className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
  );
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
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}
