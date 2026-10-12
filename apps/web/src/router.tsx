import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import { routeTree } from "./routeTree.gen";
import { NONCE_HEADER } from "./server/nonce";

const getNonce = createIsomorphicFn()
  .server(() => getRequestHeader(NONCE_HEADER))
  .client(() => document.querySelector<HTMLMetaElement>('meta[property="csp-nonce"]')?.content);

export function getRouter() {
  return createRouter({ routeTree, ssr: { nonce: getNonce() }, scrollRestoration: true });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
