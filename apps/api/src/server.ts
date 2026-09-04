import { TRACERA_AUTH_BASE_PATH } from "@repo/auth";
import { Hono } from "hono";
import { TRACERA_API_BASE_PATH } from "./base-path.js";
import { authRoutes } from "./auth-routes.js";
import { app as traceraApi, type Bindings } from "./index.js";

/**
 * Single entry point for the Vercel Function. Better Auth keeps its
 * `/api/auth` base path and the Hono API keeps the `/api/tracera` prefix the
 * web app and extension already call.
 */
export const server = new Hono<{ Bindings: Bindings }>();

server.route(TRACERA_AUTH_BASE_PATH, authRoutes);
server.route(TRACERA_API_BASE_PATH, traceraApi);
