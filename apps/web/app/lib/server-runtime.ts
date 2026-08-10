import { getCloudflareContext } from "@opennextjs/cloudflare";
import type { AuthRuntimeEnv } from "@repo/auth";

export type WebRuntimeEnv = AuthRuntimeEnv & {
  DATABASE_URL?: string;
  TRACERA_API_URL?: string;
};

export function webRuntimeEnv(): WebRuntimeEnv {
  try {
    return getCloudflareContext().env as unknown as WebRuntimeEnv;
  } catch {
    return process.env as unknown as WebRuntimeEnv;
  }
}
