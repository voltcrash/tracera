/** Vitest stand-in for the `cloudflare:workers` module; tests assign bindings to `env`. */
export const env: Record<string, unknown> = {};

export function setTestEnv(values: Record<string, unknown>) {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, values);
}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  declare readonly params?: Params;
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}

export class NonRetryableError extends Error {
  override name = "NonRetryableError";
}

export const backgroundTasks: Promise<unknown>[] = [];
export function waitUntil(promise: Promise<unknown>) {
  backgroundTasks.push(promise);
}
