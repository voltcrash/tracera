import {
  formatBytes,
  formatCount,
  MAX_TEXT_CHARACTERS,
  MAX_URL_CHARACTERS,
  type Reading,
} from "@/lib/submission";

export type AttachedImage = { name: string; bytes: number; width?: number; height?: number };

/**
 * The composer's margin note: it names what the reader has given Tracera and
 * says plainly what Tracera will do with it, the way the report annotates claims.
 */
export function SubmissionMargin({
  reading,
  image,
  starting,
}: {
  reading: Reading | null;
  image: AttachedImage | null;
  starting: boolean;
}) {
  const note = starting
    ? STARTING
    : image
      ? imageNote(image)
      : reading
        ? readingNote(reading)
        : null;
  if (!note) return null;

  return (
    <aside className="sheet-margin" data-tone={note.tone} aria-label="About this submission">
      <p className="sheet-margin-name" role={starting ? "status" : undefined} aria-live="polite">
        {note.name}
      </p>
      {note.subject ? <p className="sheet-margin-subject">{note.subject}</p> : null}
      {note.lines.map((line) => (
        <p key={line} className="sheet-margin-line">
          {line}
        </p>
      ))}
      {note.warning ? <p className="sheet-margin-warning">{note.warning}</p> : null}
    </aside>
  );
}

type Note = {
  name: string;
  tone: "idle" | "ready" | "blocked" | "busy";
  subject?: string;
  lines: string[];
  warning?: string;
};

const STARTING: Note = {
  name: "Starting the trace",
  tone: "busy",
  lines: ["The report opens as soon as the run is saved, and fills in while Tracera works."],
};

const TEXT_NAMES = { claim: "One claim", passage: "A passage", article: "An article" };

const PICKS =
  "Tracera picks up to three checkable claims and checks each against sources it can name.";

function readingNote(reading: Reading): Note {
  switch (reading.kind) {
    case "empty":
      return {
        name: "Text, a link, or a screenshot",
        tone: "idle",
        lines: [PICKS],
      };
    case "link":
      return {
        name: "A public link",
        tone: reading.tooLong ? "blocked" : "ready",
        subject: reading.host,
        lines: [
          ...(reading.path ? [reading.path] : []),
          "Tracera reads the page at this address. Pages behind a sign-in can’t be read.",
        ],
        warning: reading.tooLong
          ? `Links can be up to ${MAX_URL_CHARACTERS.toLocaleString("en-US")} characters.`
          : undefined,
      };
    default: {
      const size =
        reading.kind === "article"
          ? `${formatCount(reading.paragraphs, "paragraph")}, about ${formatCount(reading.words, "word")}.`
          : reading.kind === "passage"
            ? `${formatCount(reading.sentences, "sentence")}, ${formatCount(reading.words, "word")}.`
            : `${formatCount(reading.words, "word")}.`;
      const lines = [
        size,
        reading.kind === "claim" ? "Tracera checks the factual claims inside it." : PICKS,
      ];
      if (reading.containsLink) {
        lines.push("The link is read as text. Paste it on its own to check the page.");
      }
      return {
        name: TEXT_NAMES[reading.kind],
        tone: reading.tooLong ? "blocked" : "ready",
        lines,
        warning: reading.tooLong
          ? `${formatCount(-reading.remaining, "character")} over. Trim the text to ${MAX_TEXT_CHARACTERS.toLocaleString("en-US")} characters.`
          : reading.nearLimit
            ? `${formatCount(reading.remaining, "character")} left.`
            : undefined,
      };
    }
  }
}

function imageNote(image: AttachedImage): Note {
  const size =
    image.width && image.height
      ? `${image.width} × ${image.height}, ${formatBytes(image.bytes)}.`
      : `${formatBytes(image.bytes)}.`;
  return {
    name: "A screenshot",
    tone: "ready",
    lines: [
      size,
      "Tracera reads the text in the image. Whether the image itself is authentic is not assessed.",
    ],
  };
}
