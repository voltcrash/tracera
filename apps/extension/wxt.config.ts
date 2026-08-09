import { defineConfig } from "wxt";

export default defineConfig({
  manifest: () => {
    const configuredApiHost = apiHostPermission(
      import.meta.env.WXT_TRACERA_API_URL,
    );
    const clerkFrontendHost = apiHostPermission(
      import.meta.env.WXT_CLERK_FRONTEND_API_URL,
    );
    return {
      name: "Tracera",
      description: "Trace the evidence behind the article you are reading.",
      permissions: ["activeTab", "cookies", "scripting", "storage"],
      ...(import.meta.env.WXT_EXTENSION_PUBLIC_KEY
        ? { key: import.meta.env.WXT_EXTENSION_PUBLIC_KEY }
        : {}),
      // Reading an article from the side panel needs an explicit page host grant.
      // `activeTab` alone is not reliably retained after Chrome opens a side panel.
      // Tracera analyzes public news pages, so support both public web schemes.
      host_permissions: [
        "http://*/*",
        "https://*/*",
        ...(configuredApiHost ? [configuredApiHost] : []),
        ...(clerkFrontendHost ? [clerkFrontendHost] : []),
      ],
      action: {
        default_title: "Analyze this page with Tracera",
        default_icon: {
          16: "icons/16.png",
          32: "icons/32.png",
          48: "icons/48.png",
          128: "icons/128.png",
        },
      },
      icons: {
        16: "icons/16.png",
        32: "icons/32.png",
        48: "icons/48.png",
        128: "icons/128.png",
      },
    };
  },
});

function apiHostPermission(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return undefined;
  }
}
