import { TRACERA_AUTH_BASE_PATH } from "@repo/auth";
import { Hono } from "hono";
import { TRACERA_API_BASE_PATH } from "./base-path";
import { authRoutes } from "./auth-routes";
import { app as traceraApi, type Bindings } from "./index";

/**
 * Single Hono app behind the Next.js `/api/*` catch-all route. Better Auth
 * keeps its `/api/auth` base path and the application API uses `/api/tracera`.
 */
export const server = new Hono<{ Bindings: Bindings }>();

server.route(TRACERA_AUTH_BASE_PATH, authRoutes);
server.route(TRACERA_API_BASE_PATH, traceraApi);
