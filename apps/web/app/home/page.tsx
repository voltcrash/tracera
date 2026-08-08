"use client";

import { ChangeEvent, FormEvent, useState } from "react";
import Image from "next/image";
import {
  AnalysisResult,
  type ClaimResult,
  type TraceraScore,
} from "../components/analysis-result";
import { AppHeader } from "../components/app-header";
import { useAuth } from "../components/auth-provider";

const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const example =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";
const MAX_IMAGE_BYTES = 5_000_000;
type GroundZero = {
  status: "candidate" | "not_found" | "inconclusive";
  confidence: "low" | "moderate" | "high";
  earliestSource: { title: string; url?: string; publisher?: string } | null;
  signals: string[];
};
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

export default function Home() {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [image, setImage] = useState<{
    dataUrl: string;
    mimeType: string;
    name: string;
  } | null>(null);
  const [result, setResult] = useState<{
    claims: ClaimResult[];
    traceraScore: TraceraScore;
    cached: boolean;
    groundZero?: GroundZero;
    reuse?: ReuseState;
    inputMetadata?: ImageMetadata;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [privateTrace, setPrivateTrace] = useState(false);

  async function analyze(
    event?: FormEvent<HTMLFormElement>,
    forceReanalysis = false,
  ) {
    event?.preventDefault();
    if (!text.trim() && !image) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const value = text.trim();
      const request = image
        ? { image: image.dataUrl, imageMimeType: image.mimeType }
        : isHttpUrl(value)
          ? { url: value }
          : { text: value };
      const response = await fetch(`${apiUrl}/analyze`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...request,
          ...(forceReanalysis ? { forceReanalysis: true } : {}),
          ...(privateTrace ? { visibility: "private" } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error ?? "Unable to analyze this text.");
      setResult(data);
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
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file to analyze.");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("Choose an image smaller than 5 MB.");
      return;
    }
    setError(null);
    setImage({
      dataUrl: await readFileAsDataUrl(file),
      mimeType: file.type,
      name: file.name,
    });
  }

  return (
    <main className="paper-grid min-h-screen bg-[#f4f6f2] text-emerald-950">
      <div className="mx-auto max-w-6xl px-5 sm:px-8">
        <AppHeader active="home" />
        <section className="mx-auto flex min-h-[calc(100vh-10rem)] max-w-3xl flex-col justify-center py-16 sm:py-24">
          <div className="text-center">
            <p className="text-[10px] font-black tracking-[.2em] text-emerald-700">
              START A TRACE
            </p>
            <h1 className="mt-4 text-4xl font-black tracking-[-.065em] sm:text-6xl">
              What would you like to check?
            </h1>
            <p className="mx-auto mt-4 max-w-lg text-base leading-7 text-emerald-950/60">
              Paste a claim, headline, article, or link. We’ll trace it back to
              the evidence.
            </p>
          </div>

          <form
            onSubmit={analyze}
            className="mt-10 rounded-[2rem] border border-emerald-950/10 bg-white p-3 shadow-[0_25px_70px_-42px_rgba(16,34,31,.55)] sm:p-4"
          >
            <label className="sr-only" htmlFor="story-input">
              Story or claim to analyze
            </label>
            {image ? (
              <div className="relative overflow-hidden rounded-[1.35rem] bg-[#f8faf7] p-4">
                <Image
                  src={image.dataUrl}
                  alt="Selected for analysis"
                  width={800}
                  height={400}
                  unoptimized
                  className="h-52 w-full rounded-xl object-contain"
                />
                <div className="mt-3 flex items-center justify-between gap-3 text-sm font-semibold text-emerald-950/70">
                  <span className="truncate">{image.name}</span>
                  <button
                    type="button"
                    onClick={() => setImage(null)}
                    className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-emerald-800 shadow-sm"
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
                disabled={loading}
                required={!image}
                rows={5}
                placeholder="Paste a story, claim, or link…"
                className="w-full resize-none rounded-[1.35rem] bg-[#f8faf7] p-5 text-base leading-7 outline-none placeholder:text-emerald-950/30 focus:bg-white focus:ring-4 focus:ring-emerald-100 disabled:bg-slate-100 sm:p-6"
              />
            )}
            <div className="flex items-center justify-between gap-4 px-2 pb-2 pt-3 sm:px-3">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setText(example)}
                  className="text-sm font-bold text-emerald-800 transition hover:text-emerald-600"
                >
                  Try an example
                </button>
                <label className="cursor-pointer text-sm font-bold text-emerald-800 transition hover:text-emerald-600">
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
                disabled={loading || (!text.trim() && !image)}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-950 px-5 py-3 text-sm font-black text-white shadow-[3px_3px_0_#8ee8cb] transition hover:-translate-y-0.5 hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:shadow-none"
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
              <label className="mt-1 flex cursor-pointer items-center gap-2 px-3 pb-2 text-xs font-semibold text-emerald-950/60">
                <input
                  type="checkbox"
                  checked={privateTrace}
                  onChange={(event) => setPrivateTrace(event.target.checked)}
                  disabled={loading}
                />{" "}
                Keep this trace private
              </label>
            )}
          </form>
          <p className="mt-4 text-center text-xs font-medium text-emerald-950/45">
            Links are detected automatically. Images up to 5 MB can be checked
            for visible text.
          </p>

          {loading && (
            <div
              className="mt-6 flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950"
              role="status"
            >
              <Spinner />
              <span>
                <strong>Tracing sources and checking claims.</strong>
                <br />
                We&apos;re separating evidence from assertion.
              </span>
            </div>
          )}
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
          <section className="pb-16">
            <div className="mb-2 flex items-center gap-2 text-sm font-bold text-emerald-700">
              <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.15)]" />{" "}
              Analysis complete{" "}
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

function ImageProvenance({ metadata }: { metadata: ImageMetadata }) {
  const exif = Object.entries(metadata.exif ?? {});
  return (
    <section className="mt-6 rounded-3xl border border-emerald-950/10 bg-white p-6 text-sm text-emerald-950/70 shadow-[0_8px_30px_-18px_rgba(16,34,31,.3)]">
      <p className="text-[10px] font-black tracking-[.18em] text-emerald-800">
        IMAGE PROVENANCE
      </p>
      <p className="mt-2">
        OCR:{" "}
        {metadata.ocrProvider === "configured"
          ? "configured OCR provider"
          : "local model fallback"}{" "}
        · {metadata.mimeType ?? "unknown image type"}
      </p>
      {exif.length ? (
        <dl className="mt-3 grid gap-1">
          {exif.map(([key, value]) => (
            <div key={key}>
              <dt className="inline font-bold">{key}: </dt>
              <dd className="inline">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-emerald-950/50">
          No embedded EXIF details were available.
        </p>
      )}
      {metadata.reverseSearchUrl && (
        <a
          href={metadata.reverseSearchUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block font-bold text-emerald-800 underline"
        >
          Search this image on Google Lens →
        </a>
      )}
    </section>
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
      <span className="font-medium text-emerald-950/50">
        · identical recent trace reused until{" "}
        {new Date(reuse.expiresAt).toLocaleString()}
      </span>
    );
  }
  if (reuse?.state === "reanalyzed")
    return (
      <span className="font-medium text-emerald-950/50">
        · freshly re-analyzed on request
      </span>
    );
  if (reuse && reuse.relatedContextClaims)
    return (
      <span className="font-medium text-emerald-950/50">
        · analyzed fresh with {reuse.relatedContextClaims} related verified
        claim{reuse.relatedContextClaims === 1 ? "" : "s"} as context
      </span>
    );
  return cached ? (
    <span className="font-medium text-emerald-950/50">
      · recent matching check
    </span>
  ) : null;
}

function GroundZeroCard({ trace }: { trace: GroundZero }) {
  const tone =
    trace.confidence === "high"
      ? "bg-emerald-100 text-emerald-800"
      : trace.confidence === "moderate"
        ? "bg-amber-100 text-amber-800"
        : "bg-slate-100 text-slate-700";
  return (
    <section className="mt-6 rounded-3xl border border-emerald-950/10 bg-white p-6 shadow-[0_8px_30px_-18px_rgba(16,34,31,.3)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black tracking-[.18em] text-emerald-800">
            GROUND ZERO
          </p>
          <h2 className="mt-1 text-xl font-black tracking-tight">
            {trace.earliestSource
              ? "Earliest origin candidate"
              : "Origin not yet established"}
          </h2>
        </div>
        <span
          className={`rounded-full px-3 py-1.5 text-xs font-black capitalize ${tone}`}
        >
          {trace.confidence} confidence
        </span>
      </div>
      {trace.earliestSource && (
        <a
          className="mt-4 block font-bold text-emerald-800 underline decoration-emerald-300 underline-offset-4"
          href={trace.earliestSource.url}
          rel="noreferrer"
          target="_blank"
        >
          {trace.earliestSource.title}
          {trace.earliestSource.publisher
            ? ` · ${trace.earliestSource.publisher}`
            : ""}
        </a>
      )}
      <ul className="mt-4 space-y-2 text-sm leading-6 text-emerald-950/65">
        {trace.signals.map((signal) => (
          <li key={signal} className="flex gap-2">
            <span className="text-emerald-600">•</span>
            {signal}
          </li>
        ))}
      </ul>
    </section>
  );
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
