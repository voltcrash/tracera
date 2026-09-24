import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { checkDatabase, configureDatabase } from "@repo/db";
import { authenticatedUser, type AuthBindings } from "./auth";
import { apiRelativePath } from "./base-path";
import { coreV2App } from "./core-v2";
import { allowedCorsOrigin } from "./cors-origin";
import {
  healthErrorResponse,
  internalErrorResponse,
  requestIdMiddleware,
  REQUEST_ID_HEADER,
} from "./error-handling";

export type Bindings = AuthBindings & {
  DATABASE_URL?: string;
  [key: string]: string | undefined;
};

export const app = new Hono<{ Bindings: Bindings }>();
const currentUserByRequest = new WeakMap<Request, ReturnType<typeof authenticatedUser>>();

app.use("*", requestIdMiddleware);
app.onError((error, context) =>
  internalErrorResponse(context, error, "Unhandled Tracera API error"),
);

app.use("*", async (context, next) => {
  if (apiRelativePath(context.req.path) !== "/") {
    configureDatabase(context.env.DATABASE_URL, context.env);
  }
  await next();
});
app.use("/*", async (context, next) =>
  cors({
    origin: (origin) => allowedCorsOrigin(origin, context.req.url),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Idempotency-Key"],
    exposeHeaders: [
      "Retry-After",
      "X-Idempotency-Replayed",
      "X-RateLimit-Limit",
      "X-RateLimit-Remaining",
      "X-RateLimit-Reset",
      REQUEST_ID_HEADER,
    ],
    credentials: true,
  })(context, next),
);

app.get("/", (context) => context.json({ message: "Hello from Tracera API." }));

app.get("/auth/me", async (context) => {
  const user = await currentUser(context);
  return user ? context.json({ user }) : context.json({ error: "Not authenticated." }, 401);
});

app.get("/health", async (context) => {
  try {
    const database = await checkDatabase();
    return context.json({ status: "ok", services: { database } });
  } catch (error) {
    return healthErrorResponse(context, error);
  }
});

app.route("/v2", coreV2App);

function currentUser(context: Context<{ Bindings: Bindings }>) {
  const request = context.req.raw;
  const cached = currentUserByRequest.get(request);
  if (cached) return cached;
  const environment = context.env.TRACERA_PROFILE ? context.env : process.env;
  const user = authenticatedUser(request, environment);
  currentUserByRequest.set(request, user);
  return user;
}
