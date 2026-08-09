export const apiUrl = (
  process.env.NEXT_PUBLIC_API_URL ?? "https://api.tracera.voltcrash.com"
).replace(/\/$/, "");
