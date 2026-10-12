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
import { constants, runInThisContext } from "node:vm";
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
const require = createRequire(import.meta.url);
let cwd;
let context;
let github;

function git(...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function commit(message) {
  git("commit", "--quiet", "--allow-empty", "-m", message);
  context.sha = git("rev-parse", "HEAD");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-05T00:17:00Z"));
  cwd = mkdtempSync(join(tmpdir(), "tracera-workflow-contract-"));
  mkdirSync(join(cwd, "apps/web"), { recursive: true });
  mkdirSync(join(cwd, "packages/release"), { recursive: true });
  mkdirSync(join(cwd, ".runner"));
  mkdirSync(join(cwd, ".tools"));
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
fs.appendFileSync(process.env.TRACERA_TASK_LOG, JSON.stringify({ args, mode }) + '\\n');
if (args.includes(process.env.TRACERA_FAIL_TASK)) process.exit(27);
`,
    { mode: 0o755 },
  );
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Workflow Tests");
  git("config", "user.email", "workflow-tests@example.com");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  context = {
    repo: { owner: "voltcrash", repo: "tracera" },
    eventName: "workflow_dispatch",
    sha: "",
  };
  commit("feat: previously deployed snapshot");
  git("tag", "v26.10.04");
  github = {
    paginate: vi.fn().mockResolvedValue([
      {
        tag_name: "v26.10.04",
        body: "<!-- tracera-production-release -->",
        draft: false,
        prerelease: false,
      },
    ]),
    rest: {
      repos: {
        listReleases: vi.fn(),
        createRelease: vi.fn().mockResolvedValue({
          data: { name: "26.10.05", html_url: "https://example.test/release" },
        }),
      },
    },
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(cwd, { recursive: true, force: true });
});

async function runWorkflow({ failTask, missingCredentials = false } = {}) {
  const outputs = {};
  const summary = {
    addRaw: vi.fn().mockReturnThis(),
    addLink: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  const core = {
    setOutput: (key, value) => {
      outputs[key] = String(value);
    },
    summary,
  };
  const base = {
    ...process.env,
    GITHUB_WORKSPACE: cwd,
    RUNNER_TEMP: join(cwd, ".runner"),
    PATH: `${join(cwd, ".tools")}:${process.env.PATH}`,
    TRACERA_TASK_LOG: join(cwd, ".runner/tasks.jsonl"),
    TRACERA_FAIL_TASK: failTask ?? "",
    CLOUDFLARE_API_TOKEN: missingCredentials ? "" : "ci-only-token",
    PRODUCTION_WORKER_ENV:
      "BETTER_AUTH_SECRET=ci-only-private-canary\nAI_API_KEY=ci-only-provider-canary\n",
  };
  vi.stubEnv("GITHUB_WORKSPACE", cwd);
  vi.stubEnv("RUNNER_TEMP", base.RUNNER_TEMP);
  let failed = false;
  const executed = [];
  for (const step of production.jobs.release.steps) {
    if (step.if !== "always()" && (failed || (step.if && outputs.shouldDeploy !== "true")))
      continue;
    executed.push(step.name);
    const environment = { ...base };
    for (const [key, value] of Object.entries(step.env ?? {})) {
      const output = /^\$\{\{ steps\.plan\.outputs\.(\w+) \}\}$/.exec(value)?.[1];
      environment[key] = output ? outputs[output] : base[key];
    }
    try {
      if (step.with?.script) {
        for (const key of ["RELEASE_VERSION", "RELEASE_TAG", "RELEASE_SHA"])
          if (environment[key] !== undefined) vi.stubEnv(key, environment[key]);
        const script = runInThisContext(
          `(async (github, context, core, require) => { ${step.with.script}\n })`,
          { importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER },
        );
        await script(github, context, core, require);
      } else if (step.run) {
        execFileSync("bash", ["-e", "-c", step.run], { cwd, env: environment, stdio: "pipe" });
      }
    } catch {
      failed = true;
    }
  }
  const log = base.TRACERA_TASK_LOG;
  const tasks = existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
  return { outputs, executed, tasks, failed };
}

test("unchanged main skips setup, install, builds, migrations, deploy, and publication", async () => {
  const result = await runWorkflow();
  expect(result.failed).toBe(false);
  expect(result.outputs.shouldDeploy).toBe("false");
  expect(result.tasks).toEqual([]);
  expect(result.executed).not.toContain("Set up Vite+");
  expect(result.executed.at(-1)).toBe("Remove private settings");
  expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
  expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
});

test("changed main migrates and deploys its planned version before publishing and cleans credentials", async () => {
  commit("feat: evidence viewer");
  const result = await runWorkflow();
  expect(result.failed).toBe(false);
  expect(result.tasks.map(({ args }) => args)).toEqual([
    ["install", "--frozen-lockfile"],
    ["run", "check:production"],
    ["run", "deploy:production-dry-run"],
    ["run", "db:migrate:production"],
    ["run", "deploy:production", "--var", "VERSION:26.10.05"],
  ]);
  expect(result.tasks.every(({ mode }) => mode === 0o600)).toBe(true);
  expect(result.executed.indexOf("Publish GitHub release after deployment")).toBeGreaterThan(
    result.executed.indexOf("Deploy production with Wrangler"),
  );
  expect(github.rest.repos.createRelease).toHaveBeenCalledWith(
    expect.objectContaining({
      target_commitish: context.sha,
      tag_name: "v26.10.05",
      name: "26.10.05",
    }),
  );
  expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
  expect(existsSync(join(cwd, "apps/web/release.json"))).toBe(false);
});

test.each([
  "check:production",
  "deploy:production-dry-run",
  "db:migrate:production",
  "deploy:production",
])("failure in %s prevents publication and always removes credentials", async (failTask) => {
  commit("fix: pending release");
  const result = await runWorkflow({ failTask });
  expect(result.failed).toBe(true);
  expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
  expect(result.executed.at(-1)).toBe("Remove private settings");
  expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
});

test("missing credentials stop before install and never publish", async () => {
  commit("fix: pending release");
  const result = await runWorkflow({ missingCredentials: true });
  expect(result.failed).toBe(true);
  expect(result.tasks).toEqual([]);
  expect(github.rest.repos.createRelease).not.toHaveBeenCalled();
  expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
});

test("workflow gates keep production on main and validate both configs without hosted credentials", () => {
  expect(production.on.schedule).toEqual([{ cron: "17 0 * * *" }]);
  expect(production.on).toHaveProperty("workflow_dispatch");
  expect(production.jobs.release.if).toBe(
    "github.repository == 'voltcrash/tracera' && github.ref == 'refs/heads/main'",
  );
  expect(production.jobs.release.environment.name).toBe("production");
  expect(production.concurrency["cancel-in-progress"]).toBe(false);
  const steps = production.jobs.release.steps;
  for (const step of steps.slice(2, -1))
    expect(step.if, step.name).toBe("steps.plan.outputs.shouldDeploy == 'true'");
  expect(steps.at(-1).if).toBe("always()");
  expect(JSON.stringify(production)).not.toMatch(/db:reset|bootstrap|releaseHistory/);
  expect(ci.on.push.branches).toContain("migrate/cloudflare");
  expect(ci.jobs.validate.steps.map((step) => step.run ?? "").join("\n")).toContain(
    "scripts/ci/with-network-denied.sh vp test --run",
  );
  expect(ci.jobs.validate.steps.map((step) => step.run ?? "").join("\n")).toContain(
    "scripts/ci/with-network-denied.sh vp run test:browser",
  );
  expect(JSON.stringify(ci)).not.toMatch(/docker|secrets\./i);
});
