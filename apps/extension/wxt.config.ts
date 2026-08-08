import { defineConfig } from "wxt";

export default defineConfig({
  manifest: () => {
    const configuredApiHost = apiHostPermission(import.meta.env.WXT_TRACERA_API_URL);
    return {
      name: "Tracera",
      description: "Trace the evidence behind the article you are reading.",
      permissions: ["activeTab", "scripting", "storage"],
      // Reading an article from the side panel needs an explicit page host grant.
      // `activeTab` alone is not reliably retained after Chrome opens a side panel.
      // Tracera analyzes public news pages, so support both public web schemes.
      host_permissions: [
        "http://*/*",
        "https://*/*",
        ...(configuredApiHost ? [configuredApiHost] : []),
      ],
      action: {
        default_title: "Analyze this page with Tracera",
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
