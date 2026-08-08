import type { ClaimResult } from "../shared/contracts";

export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  main() {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "tracera:highlight-claims") return;
      applyHighlights(message.claims as ClaimResult[]);
    });
  },
});

function applyHighlights(claims: ClaimResult[]) {
  document.querySelectorAll("mark[data-tracera-claim]").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  });
  document
    .querySelectorAll(".tracera-claim-popover")
    .forEach((node) => node.remove());

  for (const claim of claims) {
    const phrase = claim.claim.claimText.trim();
    if (phrase.length < 20) continue;
    const node = findTextNode(phrase);
    if (!node?.parentElement) continue;
    const text = node.nodeValue ?? "";
    const start = text.toLowerCase().indexOf(phrase.toLowerCase());
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + phrase.length);
    const mark = document.createElement("mark");
    mark.dataset.traceraClaim = claim.verdict;
    mark.title = `Tracera: ${claim.verdict}`;
    mark.style.cssText = highlightStyle(claim.verdict);
    mark.addEventListener("click", (event) => {
      event.preventDefault();
      showPopover(mark, claim);
    });
    range.surroundContents(mark);
  }
}

function findTextNode(phrase: string) {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (
          !parent ||
          /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/i.test(parent.tagName)
        )
          return NodeFilter.FILTER_REJECT;
        return (node.nodeValue ?? "")
          .toLowerCase()
          .includes(phrase.toLowerCase())
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  return walker.nextNode() as Text | null;
}

function showPopover(anchor: HTMLElement, claim: ClaimResult) {
  document
    .querySelectorAll(".tracera-claim-popover")
    .forEach((node) => node.remove());
  const popover = document.createElement("aside");
  popover.className = "tracera-claim-popover";
  popover.style.cssText =
    "position:absolute;z-index:2147483647;max-width:300px;padding:12px 14px;border-radius:12px;background:#10221f;color:#fff;box-shadow:0 12px 35px rgba(0,0,0,.28);font:13px/1.45 system-ui,sans-serif;";
  popover.innerHTML = `<strong style="text-transform:capitalize">${escapeHtml(claim.verdict)} · ${Math.round(claim.confidence * 100)}%</strong><p style="margin:6px 0 0">${escapeHtml(claim.reasoning[0] ?? "See Tracera for the evidence trail.")}</p>`;
  const rect = anchor.getBoundingClientRect();
  popover.style.left = `${window.scrollX + rect.left}px`;
  popover.style.top = `${window.scrollY + rect.bottom + 8}px`;
  document.body.append(popover);
  setTimeout(
    () =>
      document.addEventListener("click", () => popover.remove(), {
        once: true,
      }),
    0,
  );
}

function highlightStyle(verdict: string) {
  const color =
    verdict === "supported"
      ? "rgba(74,222,128,.38)"
      : verdict === "contradicted"
        ? "rgba(251,113,133,.35)"
        : "rgba(251,191,36,.4)";
  return `background:${color};color:inherit;cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-decoration-thickness:2px;`;
}
function escapeHtml(value: string) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}
