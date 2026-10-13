import { createFileRoute, useHydrated, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { ChangeEvent, ClipboardEvent, FormEvent, useState } from "react";
import { Check, ImagePlus, Loader2, Sparkles, X } from "lucide-react";
import { type AttachedImage, SubmissionMargin } from "@/components/compose/submission-margin";
import { useAuth } from "@/components/providers/auth-provider";
import { useHistoryRefresh } from "@/components/workspace/workspace-shell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { isHttpUrl, MAX_IMAGE_BYTES, readSubmission } from "@/lib/submission";
import { startAnalysis } from "@/server/analysis.functions";

const example =
  "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.";

export const Route = createFileRoute("/_workspace/home")({ component: Home });

function Home() {
  const hydrated = useHydrated();
  const { isLoading: isAuthLoading, user } = useAuth();
  const start = useServerFn(startAnalysis);
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [image, setImage] = useState<
    (AttachedImage & { dataUrl: string; mimeType: string }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("Preparing the evidence trace.");
  const refreshHistory = useHistoryRefresh();

  async function analyze(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const draft = readSubmission(text);
    if (!image && (draft.kind === "empty" || draft.tooLong)) return;
    if (!user) return;
    setLoading(true);
    setError(null);
    setProgress("Preparing claim checks.");
    try {
      const value = text.trim();
      const input = image
        ? { image: image.dataUrl, imageMimeType: image.mimeType }
        : isHttpUrl(value)
          ? { url: value }
          : { text: value };
      const { status, body } = await start({
        data: { idempotencyKey: crypto.randomUUID(), input },
      });
      if (status >= 400 || !body.runId) {
        throw new Error(body.error ?? "Unable to start this analysis.");
      }
      refreshHistory();
      await navigate({ to: "/run/$id", params: { id: body.runId } });
    } catch (requestError) {
      setError(
        requestError instanceof Error ? requestError.message : "Unable to analyze this text.",
      );
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
        bytes: file.size,
        ...(await readImageSize(file)),
      });
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : "The image could not be read.");
    }
  }

  const reading = image ? null : readSubmission(text);

  return (
    <main className="home">
      <div className="sheet">
        <h1 className="sr-only">New trace</h1>

        <form onSubmit={analyze} className="sheet-form">
          <div className="sheet-column">
            <label className="sr-only" htmlFor="story-input">
              Story or claim to analyze
            </label>
            {image ? (
              <figure className="clipping">
                <img
                  src={image.dataUrl}
                  alt="Screenshot selected for analysis"
                  width={image.width ?? 800}
                  height={image.height ?? 400}
                  className="clipping-image"
                />
                <figcaption className="clipping-caption">
                  <span className="truncate">{image.name}</span>
                  <button
                    type="button"
                    className="clipping-action"
                    disabled={loading}
                    onClick={() => setImage(null)}
                  >
                    <X />
                    Remove
                  </button>
                </figcaption>
              </figure>
            ) : (
              <textarea
                id="story-input"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onPaste={pasteImage}
                disabled={!hydrated || loading}
                required={!image}
                rows={1}
                placeholder="What did you see?"
                data-kind={reading?.kind}
                className="sheet-input"
              />
            )}
            <span className="sheet-rule" aria-hidden="true" />
            <div className="sheet-tools">
              <label htmlFor="trace-image" className="sheet-tool">
                <ImagePlus />
                {image ? "Replace screenshot" : "Add screenshot"}
                <input
                  id="trace-image"
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  onChange={selectImage}
                  disabled={!hydrated || loading}
                />
              </label>
              <Button
                type="submit"
                variant="outline"
                className="color-sweep-button theme-primary-cta sheet-submit rounded-full px-5"
                disabled={
                  !hydrated ||
                  loading ||
                  isAuthLoading ||
                  (!image && (!reading || reading.kind === "empty" || reading.tooLong))
                }
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
          </div>
          <SubmissionMargin reading={reading} image={image} />
        </form>

        {!loading && !text && !image && (
          <div className="starters">
            <button
              type="button"
              className="starter"
              disabled={!hydrated}
              onClick={() => setText(example)}
            >
              <Sparkles />
              Try an example claim
            </button>
            <label htmlFor="trace-image" className="starter">
              <ImagePlus />
              Upload a screenshot
            </label>
          </div>
        )}

        {loading && <TraceProgress progress={progress} />}
        {error && (
          <Alert variant="destructive" className="mt-6">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    </main>
  );
}

const traceStages = [
  { label: "Prepare", detail: "Read submission" },
  { label: "Claims", detail: "Separate facts" },
  { label: "Evidence", detail: "Check sources" },
  { label: "Provenance", detail: "Compare observed sources" },
  { label: "Complete", detail: "Save the report" },
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

async function readImageSize(file: File) {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return {};
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
