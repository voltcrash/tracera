import { load, type CheerioAPI } from "cheerio";
import type { DocumentSnapshot } from "@repo/contracts/analysis";

type Locator = DocumentSnapshot["locators"][number];
type TimestampAssertion = DocumentSnapshot["timestampAssertions"][number];

export interface StructuredHtmlResult {
  normalizedText: string;
  locators: Locator[];
  canonicalUrl: string | null;
  language: string | null;
  timestamps: TimestampAssertion[];
  blocked: boolean;
}

const BLOCKED_PAGE_PATTERN =
  /\b(access denied|attention required|captcha|verify (?:that )?you are human|checking your browser|page not found|error\s*40[134]|request blocked|security challenge)\b/i;

export function extractStructuredHtml(html: string, finalUrl: string): StructuredHtmlResult {
  const $ = load(html);
  $("script,style,noscript,template,svg").remove();
  const title = clean($("title").first().text());
  const bodyText = clean($("body").text());
  const blocked =
    BLOCKED_PAGE_PATTERN.test(title) ||
    (bodyText.length < 2_000 && BLOCKED_PAGE_PATTERN.test(bodyText.slice(0, 500)));
  const builder = new TextBuilder();
  if (title) builder.add(title, "title", "/html[1]/head[1]/title[1]");
  const article = $("article").first();
  const main = $("main").first();
  const root = article.length ? article : main.length ? main : $("body").first();

  root
    .find("h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, caption, table, img[alt]")
    .each((_, element) => {
      const tag = element.tagName.toLowerCase();
      const node = $(element);
      if (tag !== "table" && node.closest("table").length > 0) return;
      if (tag === "table") {
        addTable($, node, builder, domPath($, element));
        return;
      }
      const value = tag === "img" ? clean(node.attr("alt") ?? "") : clean(node.text());
      if (!value) return;
      const kind: Locator["kind"] = /^h[1-6]$/.test(tag)
        ? "heading"
        : tag === "li"
          ? "list_item"
          : tag === "blockquote"
            ? "quote"
            : tag === "figcaption" || tag === "caption"
              ? "caption"
              : tag === "img"
                ? "alt_text"
                : "paragraph";
      builder.add(value, kind, domPath($, element));
    });

  return {
    normalizedText: builder.text,
    locators: builder.locators,
    canonicalUrl: canonicalUrl($, finalUrl),
    language: clean($("html").attr("lang") ?? "") || null,
    timestamps: timestamps($),
    blocked,
  };
}

function addTable(
  $: CheerioAPI,
  table: ReturnType<CheerioAPI>,
  builder: TextBuilder,
  path: string,
) {
  const caption = clean(table.children("caption").first().text());
  const rows: Array<{ text: string; cells: Array<{ text: string; start: number }> }> = [];
  table.find("tr").each((_, row) => {
    const cells: Array<{ text: string; start: number }> = [];
    let rowText = "";
    $(row)
      .children("th,td")
      .each((__, cell) => {
        const text = clean($(cell).text());
        if (!text) return;
        if (rowText) rowText += "\t";
        cells.push({ text, start: rowText.length });
        rowText += text;
      });
    if (rowText) rows.push({ text: rowText, cells });
  });
  const tableBody = rows.map((row) => row.text).join("\n");
  const text = [caption, tableBody].filter(Boolean).join("\n");
  if (!text) return;
  const tableSpan = builder.add(text, "table", path);
  if (caption) {
    builder.addLocator({
      kind: "caption",
      path: `${path}/caption[1]`,
      start: tableSpan.start,
      end: tableSpan.start + caption.length,
    });
  }
  let rowOffset = caption ? caption.length + 1 : 0;
  rows.forEach((row, rowIndex) => {
    row.cells.forEach((cell, cellIndex) => {
      builder.addLocator({
        kind: "table_cell",
        path: `${path}/row[${rowIndex + 1}]/cell[${cellIndex + 1}]`,
        start: tableSpan.start + rowOffset + cell.start,
        end: tableSpan.start + rowOffset + cell.start + cell.text.length,
      });
    });
    rowOffset += row.text.length + 1;
  });
}

class TextBuilder {
  text = "";
  locators: Locator[] = [];
  private nextId = 1;

  add(value: string, kind: Locator["kind"], path: string) {
    if (this.text) this.text += "\n\n";
    const start = this.text.length;
    this.text += value;
    const span = { start, end: this.text.length };
    this.addLocator({ kind, path, ...span });
    return span;
  }

  addLocator(input: { kind: Locator["kind"]; path: string; start: number; end: number }) {
    this.locators.push({
      id: `loc_${this.nextId++}`,
      kind: input.kind,
      path: input.path,
      span: { start: input.start, end: input.end },
      boundingBox: null,
      transcriptionUncertain: false,
    });
  }
}

function clean(value: string) {
  return value.replace(/[\t\n\f\r ]+/g, " ").trim();
}

function canonicalUrl($: CheerioAPI, finalUrl: string) {
  const href = $("link[rel~='canonical']").first().attr("href");
  if (!href) return null;
  try {
    const url = new URL(href, finalUrl);
    return /^https?:$/.test(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function timestamps($: CheerioAPI): TimestampAssertion[] {
  const selectors: Array<{ selector: string; type: TimestampAssertion["type"] }> = [
    { selector: "meta[property='article:published_time']", type: "published" },
    { selector: "meta[name='date']", type: "published" },
    { selector: "meta[property='article:modified_time']", type: "updated" },
  ];
  const result: TimestampAssertion[] = [];
  for (const { selector, type } of selectors) {
    const content = $(selector).first().attr("content");
    if (!content) continue;
    const parsed = Date.parse(content);
    if (!Number.isFinite(parsed)) continue;
    const instant = new Date(parsed).toISOString();
    result.push({
      type,
      interval: { earliest: instant, latest: instant, precision: "second", timezone: "UTC" },
      source: "html_meta",
      locatorId: null,
    });
  }
  return result;
}

function domPath($: CheerioAPI, element: ReturnType<CheerioAPI>[number]) {
  const parts: string[] = [];
  let current = $(element);
  while (current.length && current[0] && "tagName" in current[0]) {
    const tag = current[0].tagName.toLowerCase();
    const siblings = current.parent().children(tag);
    const index = siblings.index(current) + 1;
    parts.unshift(`${tag}[${Math.max(index, 1)}]`);
    if (tag === "html") break;
    current = current.parent();
  }
  return `/${parts.join("/")}`;
}
