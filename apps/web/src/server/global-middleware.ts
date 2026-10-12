import { isNotFound, isRedirect } from "@tanstack/react-router";
import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { env as workerEnv } from "cloudflare:workers";
import {
  ClientInputError,
  GENERIC_ERROR_MESSAGE,
  logServerError,
  requestIdFor,
} from "./error-handling";
import { errorEnvelope, securedResponse } from "./response-policy";

export const securityMiddleware = createMiddleware({ type: "request" }).server(
  async ({ request, next }) => {
    let response: Response;
    try {
      response = (await next()).response;
    } catch (error) {
      if (isRedirect(error) || isNotFound(error)) throw error;
      response = errorEnvelope(request, error);
    }
    return securedResponse(response, request, workerEnv.MODE === "dev");
  },
);

/** Server function failures reach the browser as the generic message with a request ID. */
export const serverFunctionErrors = createMiddleware({ type: "function" }).server(
  async ({ next }) => {
    try {
      return await next();
    } catch (error) {
      if (isRedirect(error) || isNotFound(error) || error instanceof ClientInputError) throw error;
      const request = getRequest();
      logServerError("Server function failed", error, request);
      throw new Error(`${GENERIC_ERROR_MESSAGE} Reference: ${requestIdFor(request)}.`);
    }
  },
);
