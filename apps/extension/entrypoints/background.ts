import type { PageSnapshot } from "../shared/contracts";
import { apiUrl } from "../shared/config";

const reactiveTimers = new Map<number, ReturnType<typeof setTimeout>>();
const reactiveControllers = new Map<number, AbortController>();

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

  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status !== "complete" || !isPublicPage(tab.url)) return;
    scheduleReactiveAnalysis(tabId);
  });
  chrome.tabs.onActivated.addListener(({ tabId }) =>
    scheduleReactiveAnalysis(tabId),
  );
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || changes.reactiveEnabled?.newValue !== true) return;
    void chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then(([tab]) => {
        if (tab?.id) scheduleReactiveAnalysis(tab.id, 0);
      });
  });

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
});

function scheduleReactiveAnalysis(tabId: number, delayMs = 1_200) {
  reactiveControllers.get(tabId)?.abort();
  const previous = reactiveTimers.get(tabId);
  if (previous) clearTimeout(previous);
  reactiveTimers.set(
    tabId,
    setTimeout(() => {
      reactiveTimers.delete(tabId);
      void analyzeTabReactively(tabId);
    }, delayMs),
  );
}

async function analyzeTabReactively(tabId: number) {
  const { reactiveEnabled } = await chrome.storage.local.get("reactiveEnabled");
  if (reactiveEnabled !== true) return;
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!isPublicPage(tab?.url) || !tab?.active) return;

  try {
    const controller = new AbortController();
    reactiveControllers.set(tabId, controller);
    const extracted = await extractPage(tabId);
    if (!extracted.snapshot) return;
    const fingerprint = await pageFingerprint(extracted.snapshot);
    const cacheKey = `reactive-page:${tabId}`;
    const cached = await chrome.storage.session.get(cacheKey);
    if (cached[cacheKey] === fingerprint) return;

    await setBadge(tabId, "…", "#146b50");
    const token = await authToken();
    if (!token) {
      await chrome.tabs
        .sendMessage(tabId, {
          type: "tracera:highlight-claims",
          claims: [],
        })
        .catch(() => undefined);
      await chrome.action.setBadgeText({ tabId, text: "" });
      return;
    }
    const headers = new Headers({ "content-type": "application/json" });
    headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${apiUrl}/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: extracted.snapshot.text,
        sourceUrl: extracted.snapshot.url,
      }),
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as {
      claims?: unknown[];
    } | null;
    if (!response.ok || !Array.isArray(payload?.claims)) {
      throw new Error(`Reactive analysis failed with HTTP ${response.status}.`);
    }
    const currentTab = await chrome.tabs.get(tabId).catch(() => undefined);
    if (currentTab?.url !== extracted.snapshot.url) return;
    await chrome.tabs.sendMessage(tabId, {
      type: "tracera:highlight-claims",
      claims: payload.claims,
    });
    await chrome.storage.session.set({ [cacheKey]: fingerprint });
    await setBadge(tabId, "✓", "#146b50");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return;
    console.warn("Tracera reactive analysis paused", { tabId, error });
    await setBadge(tabId, "!", "#a16207");
  } finally {
    reactiveControllers.delete(tabId);
  }
}

async function pageFingerprint(snapshot: PageSnapshot) {
  const data = new TextEncoder().encode(`${snapshot.url}\n${snapshot.text}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function setBadge(tabId: number, text: string, color: string) {
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
  ]);
}

function isPublicPage(url: string | undefined): url is string {
  return Boolean(url && /^https?:\/\//i.test(url));
}

async function authToken(): Promise<string | null> {
  return null;
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
