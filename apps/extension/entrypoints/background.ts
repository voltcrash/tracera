import type { PageSnapshot } from "../shared/contracts";
import { createClerkClient } from "@clerk/chrome-extension/client";

const clerkPublishableKey = import.meta.env.WXT_CLERK_PUBLISHABLE_KEY;

export default defineBackground(() => {
  // Let Chrome own the toolbar-click behavior. This is more reliable than
  // manually calling sidePanel.open() from an action listener, whose rejected
  // promise was previously ignored and made the extension look unresponsive.
  const enableActionClick = () =>
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((error) =>
        console.error("Unable to enable Tracera side panel", error),
      );

  void enableActionClick();
  chrome.runtime.onInstalled.addListener(enableActionClick);
  chrome.runtime.onStartup.addListener(enableActionClick);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "tracera:extract-page") return;

    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (!tabId) {
      sendResponse({ error: "No browser tab is available to analyze." });
      return;
    }

    void extractPage(tabId).then(sendResponse);
    return true;
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "tracera:highlight-claims") return;
    const tabId =
      typeof message.tabId === "number" ? message.tabId : sender.tab?.id;
    if (!tabId) return sendResponse({ error: "No browser tab is available." });
    void chrome.tabs
      .sendMessage(tabId, message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ error: String(error) }));
    return true;
  });
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "tracera:auth-token") return;
    void freshClerkToken()
      .then((token) => sendResponse({ token }))
      .catch((error) => {
        console.error("Unable to refresh the Clerk session", error);
        sendResponse({ token: null });
      });
    return true;
  });
});

async function freshClerkToken() {
  if (!clerkPublishableKey) return null;
  const clerk = await createClerkClient({
    publishableKey: clerkPublishableKey,
    background: true,
  });
  return clerk.session?.getToken() ?? null;
}

async function extractPage(
  tabId: number,
): Promise<{ snapshot?: PageSnapshot; error?: string }> {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: readCurrentPage,
    });
    const snapshot = result?.result;

    if (!snapshot?.text || !snapshot.url) {
      return {
        error: "This page does not contain enough readable text to check.",
      };
    }

    return { snapshot };
  } catch (error) {
    console.error("Tracera page extraction failed", { tabId, error });
    return {
      error:
        "Tracera needs permission to read this page. Reload the extension and allow it to access this site, then try again.",
    };
  }
}

// This function is injected into the active page, so it must remain self-contained.
function readCurrentPage(): PageSnapshot | null {
  const root =
    document.querySelector("article") ??
    document.querySelector("main") ??
    document.querySelector('[role="main"]') ??
    document.body;
  const title =
    document
      .querySelector("meta[property='og:title']")
      ?.getAttribute("content") || document.title;
  const text = `${title}\n\n${root.innerText}`
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, 50_000);

  return text.length >= 120 ? { title, text, url: location.href } : null;
}
