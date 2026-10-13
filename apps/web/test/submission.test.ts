import { expect, test } from "vite-plus/test";
import {
  formatBytes,
  formatCount,
  isHttpUrl,
  MAX_TEXT_CHARACTERS,
  readSubmission,
} from "../src/lib/submission";

test("an empty or blank draft reads as empty", () => {
  expect(readSubmission("")).toEqual({ kind: "empty" });
  expect(readSubmission("  \n\t ")).toEqual({ kind: "empty" });
});

test("a bare public link reads as a link with its host and path", () => {
  expect(readSubmission("  https://www.news.example/world/story?id=4  ")).toEqual({
    kind: "link",
    host: "news.example",
    path: "/world/story?id=4",
    tooLong: false,
  });
  expect(readSubmission("http://news.example/")).toMatchObject({ host: "news.example", path: "" });
});

test("a link inside a sentence stays text and is flagged", () => {
  const reading = readSubmission("Read this https://news.example/story before sharing.");
  expect(reading).toMatchObject({ kind: "claim", containsLink: true });
});

test("non-HTTP schemes are not links", () => {
  expect(isHttpUrl("ftp://files.example/a")).toBe(false);
  expect(isHttpUrl("javascript:alert(1)")).toBe(false);
  expect(isHttpUrl("https://news.example/a")).toBe(true);
});

test("one sentence reads as a claim", () => {
  expect(
    readSubmission("Drinking coffee after 2pm doubles the risk of insomnia for all adults."),
  ).toMatchObject({ kind: "claim", sentences: 1, words: 12, paragraphs: 1 });
});

test("several sentences read as a passage", () => {
  expect(
    readSubmission("The city opened a public library in 2026. The library has 20000 books."),
  ).toMatchObject({ kind: "passage", sentences: 2 });
});

test("decimals, initials, and abbreviations do not end sentences", () => {
  expect(readSubmission("Dr. Smith said U.S. inflation reached 3.4 percent in May.")).toMatchObject(
    { kind: "claim", sentences: 1 },
  );
});

test("a quoted sentence end still counts", () => {
  expect(readSubmission('He said "it is over." Then he left.')).toMatchObject({ sentences: 2 });
});

test("multiple paragraphs or long text read as an article", () => {
  expect(readSubmission("First paragraph here.\n\nSecond paragraph here.")).toMatchObject({
    kind: "article",
    paragraphs: 2,
  });
  expect(readSubmission(Array.from({ length: 130 }, () => "word").join(" "))).toMatchObject({
    kind: "article",
  });
});

test("text near and over the limit is counted down and flagged", () => {
  const near = readSubmission("a".repeat(MAX_TEXT_CHARACTERS - 10));
  expect(near).toMatchObject({ remaining: 10, nearLimit: true, tooLong: false });
  const over = readSubmission("a".repeat(MAX_TEXT_CHARACTERS + 1));
  expect(over).toMatchObject({ remaining: -1, tooLong: true });
});

test("sizes and counts are written for people", () => {
  expect(formatBytes(512)).toBe("512 bytes");
  expect(formatBytes(340_400)).toBe("340 KB");
  expect(formatBytes(1_250_000)).toBe("1.3 MB");
  expect(formatCount(1, "word")).toBe("1 word");
  expect(formatCount(1200, "word")).toBe("1,200 words");
  expect(formatCount(2, "paragraph")).toBe("2 paragraphs");
});
