import { createCsrfMiddleware, createStart } from "@tanstack/react-start";
import { securityMiddleware, serverFunctionErrors } from "./server/global-middleware";

export const startInstance = createStart(() => ({
  requestMiddleware: [
    securityMiddleware,
    createCsrfMiddleware({ filter: (context) => context.handlerType === "serverFn" }),
  ],
  functionMiddleware: [serverFunctionErrors],
}));
