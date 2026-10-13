import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { setResponseHeaders } from "@tanstack/react-start/server";
import { personalProviderSchema } from "@repo/ai";
import { authMiddleware } from "./auth-middleware";
import { serverEnv } from "./env";
import { ClientInputError } from "./error-handling";
import {
  listProviderKeysForUser,
  providerKeyStorage,
  saveProviderKeyForUser,
  validateProviderKeyInput,
} from "./provider-keys.server";
import { PRIVATE_NO_STORE_CACHE } from "../security-headers";

const privacy = createMiddleware({ type: "function" }).server(async ({ next }) => {
  setResponseHeaders(new Headers({ "cache-control": PRIVATE_NO_STORE_CACHE }));
  return next();
});
const middleware = [privacy, authMiddleware] as const;

function providerInput(data: unknown) {
  const parsed = personalProviderSchema.safeParse(
    (data as { provider?: unknown } | null)?.provider,
  );
  if (!parsed.success) throw new ClientInputError("Choose a supported provider.");
  return { provider: parsed.data };
}

export const listProviderKeys = createServerFn({ method: "GET" })
  .middleware(middleware)
  .handler(({ context }) => listProviderKeysForUser(serverEnv(), context.user.id));

export const saveProviderKey = createServerFn({ method: "POST" })
  .middleware(middleware)
  .validator(validateProviderKeyInput)
  .handler(({ context, data }) => saveProviderKeyForUser(serverEnv(), context.user.id, data));

export const deleteProviderKey = createServerFn({ method: "POST" })
  .middleware(middleware)
  .validator(providerInput)
  .handler(async ({ context, data }) => {
    await providerKeyStorage(serverEnv()).delete(context.user.id, data.provider);
    return { ok: true as const };
  });

export const activateProviderKey = createServerFn({ method: "POST" })
  .middleware(middleware)
  .validator(providerInput)
  .handler(async ({ context, data }) => ({
    ok: await providerKeyStorage(serverEnv()).activate(context.user.id, data.provider),
  }));
