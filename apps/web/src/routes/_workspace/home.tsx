import { createFileRoute, useHydrated, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { CircleAlert, ImagePlus, Loader2, X } from "lucide-react";
import { type AttachedImage, SubmissionMargin } from "@/components/compose/submission-margin";
import { useAuth } from "@/components/providers/auth-provider";
import { useHistoryRefresh } from "@/components/workspace/workspace-shell";
import { Button } from "@/components/ui/button";
import { isHttpUrl, MAX_IMAGE_BYTES, readSubmission } from "@/lib/submission";
import { startAnalysis } from "@/server/analysis.functions";

const examples = [
  {
    kind: "Statistic",
    text: "A new study found that drinking coffee after 2pm doubles the risk of insomnia for all adults.",
  },
  {
    kind: "Popular belief",
    text: "The Great Wall of China is the only human-made structure visible from space with the naked eye.",
  },
  {
    kind: "Passage",
    text: "The Eiffel Tower was completed in 1889 for the World’s Fair. It stayed the tallest structure in the world until 1930, and it grows about 15 centimetres taller in summer.",
  },
];

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
  const [dropping, setDropping] = useState(false);
  const canvas = useRef<HTMLElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const modifier = hydrated ? shortcutModifier() : null;
  const refreshHistory = useHistoryRefresh();

  async function analyze(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const draft = readSubmission(text);
    if (!image && (draft.kind === "empty" || draft.tooLong)) return;
    if (!user) return;
    setLoading(true);
    setError(null);
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

  function applyExample(value: string) {
    setText(value);
    const target = field.current;
    if (!target) return;
    target.focus();
    requestAnimationFrame(() => target.setSelectionRange(value.length, value.length));
  }

  function submitOnShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
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
    const attached = await readAttachment(file, fallbackName);
    setError("error" in attached ? attached.error : null);
    if ("image" in attached) setImage(attached.image);
  }

  // A pointer user arrives to write, so the sheet takes focus; on touch screens
  // that would throw up the keyboard before anything has been chosen.
  useEffect(() => {
    if (!hydrated || !window.matchMedia("(pointer: fine)").matches) return;
    field.current?.focus();
  }, [hydrated]);

  useEffect(() => {
    const target = canvas.current;
    if (!target || loading) return;
    let depth = 0;

    function enter(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDropping(true);
    }
    function over(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      event.dataTransfer!.dropEffect = "copy";
    }
    function leave(event: DragEvent) {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDropping(false);
    }
    function drop(event: DragEvent) {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDropping(false);
      const files = Array.from(event.dataTransfer!.files);
      const file = files.find((item) => item.type.startsWith("image/")) ?? files[0];
      if (!file) return;
      void readAttachment(file, "Dropped image").then((attached) => {
        setError("error" in attached ? attached.error : null);
        if ("image" in attached) setImage(attached.image);
      });
    }

    target.addEventListener("dragenter", enter);
    target.addEventListener("dragover", over);
    target.addEventListener("dragleave", leave);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragenter", enter);
      target.removeEventListener("dragover", over);
      target.removeEventListener("dragleave", leave);
      target.removeEventListener("drop", drop);
      setDropping(false);
    };
  }, [loading]);

  const reading = image ? null : readSubmission(text);
  const canSubmit =
    hydrated &&
    !loading &&
    !isAuthLoading &&
    (image !== null || (reading !== null && reading.kind !== "empty" && !reading.tooLong));

  return (
    <main className="home" ref={canvas} data-dropping={dropping || undefined}>
      {dropping ? (
        <div className="drop-veil" aria-hidden="true">
          <p>Drop the screenshot to attach it</p>
        </div>
      ) : null}
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
                onChange={(event) => {
                  setText(event.target.value);
                  setError(null);
                }}
                aria-invalid={reading?.kind !== "empty" && reading?.tooLong ? true : undefined}
                onPaste={pasteImage}
                onKeyDown={submitOnShortcut}
                ref={field}
                disabled={!hydrated || loading}
                required={!image}
                rows={1}
                placeholder="What did you see?"
                data-kind={reading?.kind}
                className="sheet-input"
              />
            )}
            <span className="sheet-rule" data-busy={loading || undefined} aria-hidden="true" />
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
              <span className="sheet-send">
                {modifier && canSubmit ? (
                  <kbd className="sheet-shortcut" aria-hidden="true">
                    {modifier} Enter
                  </kbd>
                ) : null}
                <Button
                  type="submit"
                  variant="outline"
                  className="color-sweep-button theme-primary-cta sheet-submit rounded-full px-5"
                  aria-keyshortcuts={modifier ? "Meta+Enter Control+Enter" : undefined}
                  disabled={!canSubmit}
                  aria-busy={loading || undefined}
                >
                  {loading ? (
                    <>
                      <Loader2 className="animate-spin" /> Starting
                    </>
                  ) : (
                    "Analyze"
                  )}
                </Button>
              </span>
            </div>
            {error ? (
              <p className="sheet-error" role="alert">
                <CircleAlert aria-hidden="true" />
                {error}
              </p>
            ) : null}
          </div>
          <SubmissionMargin reading={reading} image={image} starting={loading} />
        </form>

        {!loading && !text && !image && (
          <section className="examples" aria-labelledby="examples-title">
            <p id="examples-title" className="examples-title">
              Not sure where to start? Try one of these.
            </p>
            <ul>
              {examples.map((example) => (
                <li key={example.kind}>
                  <button
                    type="button"
                    className="example"
                    disabled={!hydrated}
                    onClick={() => applyExample(example.text)}
                  >
                    <span className="example-kind">{example.kind}</span>
                    <span className="example-text">{example.text}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

type SelectedImage = AttachedImage & { dataUrl: string; mimeType: string };

async function readAttachment(
  file: File,
  fallbackName: string,
): Promise<{ image: SelectedImage } | { error: string }> {
  if (!file.type.startsWith("image/")) return { error: "Choose an image file to analyze." };
  if (file.size > MAX_IMAGE_BYTES) return { error: "Choose an image smaller than 5 MB." };
  try {
    return {
      image: {
        dataUrl: await readFileAsDataUrl(file),
        mimeType: file.type,
        name: file.name || fallbackName,
        bytes: file.size,
        ...(await readImageSize(file)),
      },
    };
  } catch (readError) {
    return {
      error: readError instanceof Error ? readError.message : "The image could not be read.",
    };
  }
}

/** Touch screens have no shortcut to offer, so they get no hint. */
function shortcutModifier() {
  if (!window.matchMedia("(pointer: fine)").matches) return null;
  return /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
}

function carriesFiles(event: DragEvent) {
  return event.dataTransfer?.types.includes("Files") ?? false;
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
