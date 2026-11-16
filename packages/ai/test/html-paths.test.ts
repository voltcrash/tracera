import { expect, test } from "vite-plus/test";
import { extractStructuredHtml } from "../src/analysis/ingestion/html";

test("wide HTML documents retain exact per-tag paths and source spans", () => {
  const html = `<article><h1>Results</h1>${Array.from({ length: 2_000 }, (_, i) => `<p>Paragraph ${i}</p><aside>Other ${i}</aside>`).join("")}<blockquote><p>Nested</p></blockquote></article>`;
  const result = extractStructuredHtml(html, "https://example.com");
  const paragraphs = result.locators.filter(({ kind }) => kind === "paragraph");
  expect(paragraphs).toHaveLength(2_001);
  for (let i = 0; i < 2_000; i++) {
    const locator = paragraphs[i]!;
    expect(locator.path).toBe(`/html[1]/body[1]/article[1]/p[${i + 1}]`);
    expect(result.normalizedText.slice(locator.span.start, locator.span.end)).toBe(
      `Paragraph ${i}`,
    );
  }
  expect(paragraphs.at(-1)!.path).toBe("/html[1]/body[1]/article[1]/blockquote[1]/p[1]");
  expect(
    extractStructuredHtml("<article><p>Fresh</p></article>", "https://other.example").locators[0]!
      .path,
  ).toBe("/html[1]/body[1]/article[1]/p[1]");
});
