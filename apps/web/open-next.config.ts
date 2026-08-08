import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// The application currently does not use ISR, so it needs no R2 cache binding.
// Add the R2 incremental-cache override here if/when revalidation is enabled.
export default defineCloudflareConfig();
