import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants, runInNewContext, runInThisContext } from "node:vm";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { parse } from "yaml";

const production = parse(
  readFileSync(
    new URL("../../../.github/workflows/production-release.yml", import.meta.url),
    "utf8",
  ),
);
const ci = parse(
  readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"),
);
const web = JSON.parse(
  readFileSync(new URL("../../../apps/web/package.json", import.meta.url), "utf8"),
);
const require = createRequire(import.meta.url);
const successfulCI = {
  event: "push",
  head_branch: "main",
  head_repository: { full_name: "voltcrash/tracera" },
  conclusion: "success",
};
let cwd;
let event;
let github;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tracera-deployment-"));
  for (const path of ["apps/web", "packages/release", ".tools"])
    mkdirSync(join(cwd, path), { recursive: true });
  cpSync(new URL("../src/", import.meta.url), join(cwd, "packages/release/src"), {
    recursive: true,
  });
  writeFileSync(join(cwd, "package.json"), '{"type":"module"}');
  writeFileSync(join(cwd, ".tools/package.json"), '{"type":"commonjs"}');
  writeFileSync(
    join(cwd, ".tools/vp"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = 'apps/web/.dev.vars.production';
const mode = fs.existsSync(path) ? fs.statSync(path).mode & 0o777 : null;
fs.appendFileSync(process.env.TRACERA_TASK_LOG, JSON.stringify({ args, mode, buildId: process.env.TRACERA_BUILD_ID }) + '\\n');
if (args.includes(process.env.TRACERA_FAIL_TASK)) process.exit(27);
`,
    { mode: 0o755 },
  );
  event = {
    repository: "voltcrash/tracera",
    ref: "refs/heads/main",
    event_name: "workflow_dispatch",
    sha: "a".repeat(40),
    run_id: "100",
    run_attempt: "1",
    event: {},
  };
  github = {
    rest: {
      actions: {
        listWorkflowRuns: vi.fn().mockImplementation(async () => ({
          data: {
            workflow_runs: [
              {
                ...successfulCI,
                id: 42,
                head_sha: event.event.workflow_run?.head_sha ?? event.sha,
                status: "completed",
                html_url: "https://example.test/ci",
              },
            ],
          },
        })),
      },
    },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(cwd, { recursive: true, force: true });
});

async function runWorkflow({ failTask, missingCredentials = false } = {}) {
  const jobEnv = {};
  const secrets = {
    CLOUDFLARE_API_TOKEN: missingCredentials ? "" : "synthetic-token",
    PRODUCTION_WORKER_ENV: "BETTER_AUTH_SECRET=synthetic-private-canary\n",
  };
  const resolve = (value) =>
    value.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression) =>
      runInNewContext(expression, { github: event, env: jobEnv, secrets }),
    );
  jobEnv.DEPLOYMENT_SHA = resolve(production.jobs.deploy.env.DEPLOYMENT_SHA);
  const log = join(cwd, "tasks.jsonl");
  rmSync(log, { force: true });
  const base = {
    ...process.env,
    ...jobEnv,
    ...secrets,
    GITHUB_WORKSPACE: cwd,
    PATH: `${join(cwd, ".tools")}:${process.env.PATH}`,
    TRACERA_TASK_LOG: log,
    TRACERA_FAIL_TASK: failTask ?? "",
  };
  vi.stubEnv("GITHUB_WORKSPACE", cwd);
  vi.stubEnv("DEPLOYMENT_SHA", jobEnv.DEPLOYMENT_SHA);
  const context = {
    repo: { owner: "voltcrash", repo: "tracera" },
    eventName: event.event_name,
    sha: event.sha,
    payload: event.event,
  };
  const summary = {
    addLink: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  let failed = false;
  const executed = [];
  for (const step of production.jobs.deploy.steps) {
    if (failed && step.if !== "always()") continue;
    executed.push(step.name);
    const environment = {
      ...base,
      ...Object.fromEntries(
        Object.entries(step.env ?? {}).map(([key, value]) => [key, resolve(value)]),
      ),
    };
    try {
      if (step.with?.script) {
        const script = runInThisContext(
          `(async (github, context, core, require) => { ${step.with.script}\n })`,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
        );
        await script(github, context, { summary }, require);
      } else if (step.run)
        execFileSync("bash", ["-e", "-c", step.run], { cwd, env: environment, stdio: "pipe" });
    } catch {
      failed = true;
    }
  }
  const tasks = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { failed, tasks, executed };
}

test.each([
  { name: "successful main CI", allowed: true },
  ...["failure", "cancelled", "skipped", "neutral", "timed_out", null].map((conclusion) => ({
    name: `CI ${conclusion}`,
    run: { conclusion },
    allowed: false,
  })),
  { name: "pull request CI", run: { event: "pull_request" }, allowed: false },
  { name: "other branch", run: { head_branch: "feature" }, allowed: false },
  { name: "fork CI", run: { head_repository: { full_name: "fork/tracera" } }, allowed: false },
  { name: "fork repository", repository: "fork/tracera", allowed: false },
  { name: "direct push", eventName: "push", allowed: false },
  { name: "manual main", eventName: "workflow_dispatch", allowed: true },
  {
    name: "manual feature",
    eventName: "workflow_dispatch",
    ref: "refs/heads/feature",
    allowed: false,
  },
])("gates production: $name", ({ allowed, ...scenario }) => {
  const github = {
    repository: scenario.repository ?? "voltcrash/tracera",
    ref: scenario.ref ?? "refs/heads/main",
    event_name: scenario.eventName ?? "workflow_run",
    event: { workflow_run: { ...successfulCI, ...scenario.run } },
  };
  expect(runInNewContext(production.jobs.deploy.if, { github })).toBe(allowed);
});

test("deploys unchanged commits and allows another attempt the same day", async () => {
  for (const attempt of ["1", "2"]) {
    event.run_attempt = attempt;
    const result = await runWorkflow();
    expect(result.failed).toBe(false);
    expect(result.tasks.map(({ args }) => args)).toEqual([
      ["install", "--frozen-lockfile"],
      ["run", "build:production"],
      ["run", "deploy:production-dry-run"],
      ["run", "db:migrate:production"],
      ["run", "deploy:production"],
    ]);
    expect(result.tasks.every(({ mode }) => mode === 0o600)).toBe(true);
    expect(result.tasks.find(({ args }) => args.includes("build:production")).buildId).toBe(
      `${event.sha}-100-${attempt}`,
    );
    expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
  }
});

test("validates and labels the CI snapshot when main has advanced", async () => {
  event.event_name = "workflow_run";
  event.event.workflow_run = { ...successfulCI, head_sha: "b".repeat(40) };
  const result = await runWorkflow();
  expect(result.failed).toBe(false);
  expect(production.jobs.deploy.steps[0].with.ref).toBe("${{ env.DEPLOYMENT_SHA }}");
  expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(
    expect.objectContaining({ head_sha: "b".repeat(40) }),
  );
  expect(result.tasks.find(({ args }) => args.includes("build:production")).buildId).toBe(
    `${"b".repeat(40)}-100-1`,
  );
});

test.each([
  "build:production",
  "deploy:production-dry-run",
  "db:migrate:production",
  "deploy:production",
])("failure in %s stops subsequent tasks and cleans credentials", async (failTask) => {
  const result = await runWorkflow({ failTask });
  expect(result.failed).toBe(true);
  expect(result.tasks.at(-1).args).toContain(failTask);
  expect(result.executed.at(-1)).toBe("Remove private settings");
  expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
});

test("failed CI stops before preparing credentials or running commands", async () => {
  github.rest.actions.listWorkflowRuns.mockResolvedValue({ data: { workflow_runs: [] } });
  const result = await runWorkflow();
  expect(result.failed).toBe(true);
  expect(result.executed).not.toContain("Prepare production credentials");
  expect(result.tasks).toEqual([]);
});

test("missing credentials stop before install", async () => {
  const result = await runWorkflow({ missingCredentials: true });
  expect(result.failed).toBe(true);
  expect(result.tasks).toEqual([]);
  expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
});

test("production follows main CI with read-only GitHub permissions and no release machinery", () => {
  expect(Object.keys(production.on)).toEqual(["workflow_run", "workflow_dispatch"]);
  expect(production.on.workflow_run).toEqual({
    workflows: [ci.name],
    types: ["completed"],
    branches: ["main"],
  });
  expect(production.permissions).toEqual({ contents: "read", actions: "read" });
  expect(production.jobs.deploy.steps[0].with["persist-credentials"]).toBe(false);
  expect(production.concurrency["cancel-in-progress"]).toBe(false);
  expect(production.jobs.deploy.environment.name).toBe("production");
  expect(JSON.stringify(production)).not.toMatch(
    /shouldDeploy|RELEASE_VERSION|createRelease|createRef|production-release\.js|db:reset|bootstrap/,
  );
  expect(production.jobs.deploy.steps.at(-1).if).toBe("always()");
  expect(JSON.stringify(ci)).not.toMatch(/docker|secrets\./i);
});

test("checks and deployments reuse the built artifact, and dry runs never mutate D1", () => {
  expect(web.scripts["check:production"]).not.toContain("build");
  expect(web.scripts["deploy:production"]).toBe(
    "vp run check:production && vp run db:replication:production && wrangler deploy --config dist/server/wrangler.json --secrets-file .dev.vars.production",
  );
  expect(web.scripts["deploy:production-dry-run"]).not.toMatch(/build:|db:/);
  for (const environment of ["production", "staging"]) {
    expect(web.scripts[`db:migrate:${environment}`]).toContain(
      `&& vp run db:optimize:${environment}`,
    );
    expect(web.scripts[`db:optimize:${environment}`]).toContain("PRAGMA optimize");
    expect(web.scripts[`db:replication:${environment}`]).toContain(
      `enable-d1-read-replication.ts ${environment}`,
    );
  }
  const steps = production.jobs.deploy.steps;
  expect(steps.filter(({ run = "" }) => run.includes("run build:production"))).toHaveLength(1);
  expect(steps.findIndex(({ id }) => id === "validate-ci")).toBeLessThan(
    steps.findIndex(({ name }) => name === "Prepare production credentials"),
  );
  expect(steps.findIndex(({ run }) => run === "vp run deploy:production-dry-run")).toBeLessThan(
    steps.findIndex(({ run }) => run === "vp run db:migrate:production"),
  );
});
