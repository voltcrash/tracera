import type {
  AnalysisResponse,
  ClaimResult,
  PageSnapshot,
} from "../../shared/contracts";
import { createClerkClient } from "@clerk/chrome-extension/client";
import "./style.css";

const API_URL = "https://api.tracera.voltcrash.com";
const appElement = document.querySelector<HTMLElement>("#app");

if (!appElement) throw new Error("Tracera side panel could not start.");
const app: HTMLElement = appElement;
const clerkPublishableKey = import.meta.env.WXT_CLERK_PUBLISHABLE_KEY;
const extensionUrl = chrome.runtime.getURL(".");
const sidePanelUrl = `${extensionUrl}sidepanel.html`;
const clerk = clerkPublishableKey
  ? createClerkClient({ publishableKey: clerkPublishableKey })
  : null;
let analysisStarted = false;
let reactiveEnabled = false;

void initialize();

async function initialize() {
  reactiveEnabled =
    (await chrome.storage.local.get("reactiveEnabled")).reactiveEnabled ===
    true;
  if (!clerk) {
    renderError(
      "Clerk is not configured. Add WXT_CLERK_PUBLISHABLE_KEY before building the extension.",
    );
    return;
  }
  try {
    await clerk.load({
      afterSignOutUrl: sidePanelUrl,
      signInForceRedirectUrl: sidePanelUrl,
      signUpForceRedirectUrl: sidePanelUrl,
      allowedRedirectProtocols: ["chrome-extension:"],
    });
    clerk.addListener(renderForAuthState);
    renderForAuthState();
  } catch (error) {
    renderError(
      error instanceof Error
        ? error.message
        : "Tracera could not initialize account access.",
    );
  }
}

function renderForAuthState() {
  if (clerk?.user) {
    if (!analysisStarted) void provisionAndStart();
    return;
  }
  analysisStarted = false;
  renderSignedOut();
}

async function provisionAndStart() {
  analysisStarted = true;
  const token = await getAuthToken();
  if (token) {
    void fetch(`${API_URL}/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }
  await startAnalysis();
}

function renderSignedOut() {
  app.innerHTML = `
    <header><div class="brand"><span class="brand-mark">T</span><span>tracera</span></div></header>
    <section class="state auth-state">
      <p class="eyebrow">YOUR TRACERA ACCOUNT</p>
      <h1>Keep this evidence trail attached to you.</h1>
      <p>Sign in to save private traces and use the same account as the web and mobile apps.</p>
      <button id="sign-in" type="button">Sign in</button>
      <button id="sign-up" class="secondary-button" type="button">Create account</button>
      <button id="continue-guest" class="quiet-button" type="button">Continue without an account</button>
    </section>`;
  document
    .querySelector<HTMLButtonElement>("#sign-in")
    ?.addEventListener("click", () => clerk?.openSignIn({}));
  document
    .querySelector<HTMLButtonElement>("#sign-up")
    ?.addEventListener("click", () => clerk?.openSignUp({}));
  document
    .querySelector<HTMLButtonElement>("#continue-guest")
    ?.addEventListener("click", () => {
      analysisStarted = true;
      void startAnalysis();
    });
}

async function startAnalysis(forceReanalysis = false) {
  renderLoading();
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    if (!tab?.id)
      throw new Error("No active browser tab is available to analyze.");

    const extracted = (await chrome.runtime.sendMessage({
      type: "tracera:extract-page",
      tabId: tab.id,
    })) as { snapshot?: PageSnapshot; error?: string };
    if (extracted.error || !extracted.snapshot) {
      throw new Error(extracted.error ?? "This page could not be read.");
    }

    const token = await getAuthToken();
    const headers = new Headers({ "Content-Type": "application/json" });
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(`${API_URL}/analyze`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        text: extracted.snapshot.text,
        sourceUrl: extracted.snapshot.url,
        ...(forceReanalysis ? { forceReanalysis: true } : {}),
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        readError(payload) ?? "Tracera could not analyze this page.",
      );
    }
    if (!isAnalysisResponse(payload)) {
      throw new Error(
        "Tracera received an incomplete analysis. Please try again.",
      );
    }

    await chrome.runtime.sendMessage({
      type: "tracera:highlight-claims",
      tabId: tab.id,
      claims: payload.claims,
    });
    renderResult(payload, extracted.snapshot);
  } catch (error) {
    renderError(
      error instanceof Error
        ? error.message
        : "Tracera could not analyze this page.",
    );
  }
}

async function getAuthToken() {
  const response = (await chrome.runtime.sendMessage({
    type: "tracera:auth-token",
  })) as { token?: string | null } | undefined;
  return response?.token ?? clerk?.session?.getToken() ?? null;
}

function renderLoading() {
  app.innerHTML = `
    <header><div class="brand"><span class="brand-mark">T</span><span>tracera</span></div></header>
    <section class="state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p class="eyebrow">TRACE IN PROGRESS</p>
      <h1>Checking this story against the evidence.</h1>
      <p>We are extracting claims, finding original sources, and weighing corroboration.</p>
    </section>`;
}

function renderError(message: string) {
  app.innerHTML = `
    <header><div class="brand"><span class="brand-mark">T</span><span>tracera</span></div></header>
    <section class="state error" role="alert">
      <p class="eyebrow">TRACE PAUSED</p>
      <h1>We could not check this page.</h1>
      <p>${escapeHtml(message)}</p>
      <button id="retry" type="button">Try again</button>
      <p class="hint">Make sure ${escapeHtml(API_URL)} is reachable.</p>
    </section>`;
  document
    .querySelector<HTMLButtonElement>("#retry")
    ?.addEventListener("click", () => void startAnalysis());
}

function renderResult(result: AnalysisResponse, page: PageSnapshot) {
  const score = Math.round(result.traceraScore.overall);
  const source = safeHostname(page.url);
  app.innerHTML = `
    <header>
      <div class="brand"><span class="brand-mark">T</span><span>tracera</span></div>
      <div class="header-actions">
        <button class="quiet-button ${reactiveEnabled ? "active" : ""}" id="reactive" type="button" aria-pressed="${reactiveEnabled}" title="When enabled, Tracera automatically checks public pages after navigation">Live ${reactiveEnabled ? "on" : "off"}</button>
        <button class="quiet-button" id="account" type="button">${clerk?.user ? "Sign out" : "Sign in"}</button>
        <button class="quiet-button" id="recheck" type="button">Re-check</button>
      </div>
    </header>
    <section class="story"><p class="eyebrow">${result.cached ? "RECENT TRACE" : "PAGE TRACE"}</p><h1>${escapeHtml(page.title || source)}</h1><p>${escapeHtml(source)}</p></section>
    <section class="score-card"><div><p class="eyebrow">TRACERA SCORE</p><strong>${score}</strong><span>/100</span></div><p>${scoreSummary(score)}</p></section>
    <section class="dimensions">
      ${dimension("Factual accuracy", result.traceraScore.factualAccuracy.score)}
      ${dimension("Corroboration", result.traceraScore.sourceCorroboration.score)}
      ${dimension("Evidence quality", result.traceraScore.evidenceQuality.score)}
      ${dimension("Source reputation", result.traceraScore.sourceReputation.score)}
    </section>
    ${renderGroundZero(result)}
    <section class="claims"><div class="section-heading"><p class="eyebrow">CLAIM BREAKDOWN</p><span>${result.claims.length} checked</span></div>${result.claims.map(renderClaim).join("")}</section>`;
  document
    .querySelector<HTMLButtonElement>("#reactive")
    ?.addEventListener("click", async () => {
      reactiveEnabled = !reactiveEnabled;
      await chrome.storage.local.set({ reactiveEnabled });
      if (!reactiveEnabled) {
        const [tab] = await chrome.tabs.query({
          active: true,
          lastFocusedWindow: true,
        });
        if (tab?.id) {
          await chrome.runtime.sendMessage({
            type: "tracera:highlight-claims",
            tabId: tab.id,
            claims: [],
          });
          await chrome.action.setBadgeText({ tabId: tab.id, text: "" });
        }
      }
      renderResult(result, page);
    });
  document
    .querySelector<HTMLButtonElement>("#recheck")
    ?.addEventListener("click", () => void startAnalysis(true));
  document
    .querySelector<HTMLButtonElement>("#account")
    ?.addEventListener("click", () => {
      if (clerk?.user) void clerk.signOut();
      else clerk?.openSignIn({});
    });
}

function renderGroundZero(result: AnalysisResponse) {
  const source = result.groundZero?.earliestSource;
  if (!source) return "";
  const sourceLabel = escapeHtml(source.publisher || source.title);
  const sourceUrl = externalUrl(source.url);
  const sourceLink = sourceUrl
    ? `<a href="${escapeAttribute(sourceUrl)}" target="_blank" rel="noreferrer">${sourceLabel} ↗</a>`
    : sourceLabel;
  return `<section class="ground-zero"><p class="eyebrow">GROUND ZERO</p><p>Earliest source found: ${sourceLink}</p></section>`;
}

function renderClaim(claim: ClaimResult) {
  const sources = [...claim.supportingSources, ...claim.contradictingSources]
    .slice(0, 2)
    .flatMap((source) => {
      const url = externalUrl(source.url);
      return url
        ? [
            `<a href="${escapeAttribute(url)}" target="_blank" rel="noreferrer">${escapeHtml(source.publisher || source.title)} ↗</a>`,
          ]
        : [];
    })
    .join("");
  const reasoning = claim.reasoning
    .slice(0, 2)
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  return `<article class="claim"><div class="claim-top"><span class="verdict ${claim.verdict}">${escapeHtml(verdictLabel(claim.verdict))}</span><span>${Math.round(claim.confidence * 100)}% confidence</span></div><h2>${escapeHtml(claim.claim.claimText)}</h2>${reasoning ? `<ul>${reasoning}</ul>` : ""}${sources ? `<div class="sources">${sources}</div>` : ""}</article>`;
}

function dimension(label: string, value: number) {
  const score = Math.max(0, Math.min(100, Math.round(value)));
  return `<div><span>${escapeHtml(label)}</span><strong>${score}</strong><i><b style="width:${score}%"></b></i></div>`;
}

function isAnalysisResponse(value: unknown): value is AnalysisResponse {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<AnalysisResponse>;
  return (
    Array.isArray(data.claims) && typeof data.traceraScore?.overall === "number"
  );
}

function readError(value: unknown) {
  return value &&
    typeof value === "object" &&
    typeof (value as { error?: unknown }).error === "string"
    ? (value as { error: string }).error
    : undefined;
}

function safeHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Current page";
  }
}

function externalUrl(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function scoreSummary(score: number) {
  if (score >= 80)
    return "The checked claims are well supported by the available evidence.";
  if (score >= 60)
    return "The story has support, but some evidence or context remains incomplete.";
  return "Treat this story carefully: the available evidence has significant gaps or conflicts.";
}

function verdictLabel(verdict: string) {
  return verdict.replace(/_/g, " ");
}

function escapeHtml(value: string) {
  const element = document.createElement("span");
  element.textContent = value;
  return element.innerHTML;
}

function escapeAttribute(value: string) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
