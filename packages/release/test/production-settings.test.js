import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, expect, test } from "vite-plus/test";
import { writeProductionWorkerEnv } from "../src/production-settings.js";

let cwd;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tracera-private-settings-"));
  mkdirSync(join(cwd, "apps/web"), { recursive: true });
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));
const configured = {
  CLOUDFLARE_API_TOKEN: "ci-token-canary",
  PRODUCTION_WORKER_ENV:
    'BETTER_AUTH_SECRET="private $value with quotes"\nAI_API_KEY=ci-key-canary\n',
};

test("writes exact private file bytes with mode 0600", () => {
  const path = writeProductionWorkerEnv({ cwd, environment: configured });
  expect(readFileSync(path, "utf8")).toBe(configured.PRODUCTION_WORKER_ENV);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(existsSync(join(cwd, "package.json"))).toBe(false);
});

test.each(["CLOUDFLARE_API_TOKEN", "PRODUCTION_WORKER_ENV"])(
  "fails before writing when %s is absent",
  (name) => {
    const environment = { ...configured, [name]: "  " };
    expect(() => writeProductionWorkerEnv({ cwd, environment })).toThrow(name);
    expect(existsSync(join(cwd, "apps/web/.dev.vars.production"))).toBe(false);
  },
);

test("refuses to overwrite an existing private file", () => {
  const path = join(cwd, "apps/web/.dev.vars.production");
  writeFileSync(path, "existing-owner-values", { mode: 0o600 });
  expect(() => writeProductionWorkerEnv({ cwd, environment: configured })).toThrow("EEXIST");
  expect(readFileSync(path, "utf8")).toBe("existing-owner-values");
});
