import { isHttpUrl, readSubmission } from "./submission";

export type ComposerImage = {
  name: string;
  bytes: number;
  width?: number;
  height?: number;
  dataUrl: string;
  mimeType: string;
};

type Input = { text: string } | { url: string } | { image: string; imageMimeType: string };
type Request = { idempotencyKey: string; input: Input };
type Submission =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "failed"; error: string }
  | { status: "opening"; runId: string }
  | { status: "accepted"; runId: string; error?: string };

export type ComposerState = {
  text: string;
  image: ComposerImage | null;
  attachment: "idle" | "reading";
  attachmentError: string | null;
  submission: Submission;
};

type Start = (options: { data: Request }) => Promise<{
  status: number;
  body: { runId?: string; error?: string; code?: string; status?: string };
}>;
type Open = (runId: string) => Promise<unknown>;

export function savedAnalysisRunId({ status, body }: Awaited<ReturnType<Start>>) {
  if (!body.runId || body.code === "analysis_start_failed") return undefined;
  return status < 400 || body.status === "failed" ? body.runId : undefined;
}

export class Composer {
  private state: ComposerState = {
    text: "",
    image: null,
    attachment: "idle",
    attachmentError: null,
    submission: { status: "idle" },
  };
  private listeners = new Set<() => void>();
  private attachmentVersion = 0;
  private operationVersion = 0;
  private lastRequest: { ownerId: string; request: Request } | null = null;

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get locked() {
    return ["submitting", "opening", "accepted"].includes(this.state.submission.status);
  }

  edit(text: string) {
    if (this.locked) return;
    this.update({ text, attachmentError: null, submission: { status: "idle" } });
  }

  async attach(read: () => Promise<{ image: ComposerImage } | { error: string }>) {
    if (this.locked) return;
    const version = ++this.attachmentVersion;
    this.update({
      image: null,
      attachment: "reading",
      attachmentError: null,
      submission: { status: "idle" },
    });
    const result = await read();
    if (version !== this.attachmentVersion) return;
    this.update({
      image: "image" in result ? result.image : null,
      attachment: "idle",
      attachmentError: "error" in result ? result.error : null,
    });
  }

  removeImage() {
    if (this.locked) return;
    this.attachmentVersion += 1;
    this.update({
      image: null,
      attachment: "idle",
      attachmentError: null,
      submission: { status: "idle" },
    });
  }

  async submit(ownerId: string, start: Start, open: Open) {
    if (this.locked || this.state.attachment === "reading") return;
    const { text, image } = this.state;
    const reading = readSubmission(text);
    if (!image && (reading.kind === "empty" || reading.tooLong)) return;
    const value = text.trim();
    const input: Input = image
      ? { image: image.dataUrl, imageMimeType: image.mimeType }
      : isHttpUrl(value)
        ? { url: value }
        : { text: value };
    if (
      !this.lastRequest ||
      this.lastRequest.ownerId !== ownerId ||
      JSON.stringify(this.lastRequest.request.input) !== JSON.stringify(input)
    ) {
      this.lastRequest = { ownerId, request: { idempotencyKey: crypto.randomUUID(), input } };
    }
    const version = ++this.operationVersion;
    this.update({ submission: { status: "submitting" }, attachmentError: null });
    let runId: string;
    try {
      const result = await start({ data: this.lastRequest.request });
      const savedRunId = savedAnalysisRunId(result);
      if (!savedRunId) {
        if (result.body.code === "analysis_start_failed" && result.body.status === "failed") {
          this.lastRequest = null;
        }
        throw new Error(result.body.error ?? "Unable to start this analysis.");
      }
      runId = savedRunId;
    } catch (error) {
      if (version === this.operationVersion) {
        this.update({
          submission: {
            status: "failed",
            error: errorMessage(error, "Unable to start this analysis."),
          },
        });
      }
      return;
    }
    if (version !== this.operationVersion) return;
    this.update({ submission: { status: "accepted", runId } });
    await this.openRun(open);
  }

  async openRun(open: Open) {
    if (this.state.submission.status !== "accepted") return;
    const { runId } = this.state.submission;
    const version = ++this.operationVersion;
    this.update({ submission: { status: "opening", runId } });
    try {
      await open(runId);
      if (version === this.operationVersion) {
        this.update({ submission: { status: "accepted", runId } });
      }
    } catch {
      if (version === this.operationVersion) {
        this.update({
          submission: {
            status: "accepted",
            runId,
            error: "Your trace was saved, but the report could not open. Try opening it again.",
          },
        });
      }
    }
  }

  cancelPending() {
    this.attachmentVersion += 1;
    this.operationVersion += 1;
  }

  private update(changes: Partial<ComposerState>) {
    this.state = { ...this.state, ...changes };
    this.listeners.forEach((listener) => listener());
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
