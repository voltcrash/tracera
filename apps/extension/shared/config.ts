const configuredApiUrl = import.meta.env.WXT_TRACERA_API_URL;

export const apiUrl = (
  configuredApiUrl || "https://api.tracera.voltcrash.com"
).replace(/\/$/, "");

export const clerkPublishableKey = import.meta.env.WXT_CLERK_PUBLISHABLE_KEY;
