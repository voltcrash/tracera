import { spawn } from "node:child_process";
import { redactedEnvironmentDiagnostic } from "../../packages/environment/src/index.js";
import { loadProfileEnvironment } from "../../packages/environment/src/loader.js";
import { containerTarget, requireHealthyTarget } from "../database/container.mjs";
import { rootDirectory } from "./worktree.mjs";

process.on("uncaughtException", failCleanly);
process.on("unhandledRejection", failCleanly);
const separator = process.argv.indexOf("--");
const argumentsBeforeCommand =
  separator === -1 ? process.argv.slice(2) : process.argv.slice(2, separator);
const command = separator === -1 ? [] : process.argv.slice(separator + 1);
const profile = optionValue("--profile");
const role = optionValue("--role");

if (!profile || !role || command.length === 0) {
  throw new Error(
    "Usage: node scripts/environment/run.mjs --profile <local|test> --role <role> -- <command> [args...]",
  );
}

const selected = loadProfileEnvironment({
  rootDirectory,
  profile,
  role,
  inheritedEnv: process.env,
});
console.error(redactedEnvironmentDiagnostic(selected));
if (argumentsBeforeCommand.includes("--require-database")) {
  await requireHealthyTarget(containerTarget(selected));
}

const child = spawn(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: { ...unmanagedEnvironment(process.env), ...selected },
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Unable to start ${command[0]}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

function optionValue(name) {
  const index = argumentsBeforeCommand.indexOf(name);
  return index === -1 ? undefined : argumentsBeforeCommand[index + 1];
}

function unmanagedEnvironment(environment) {
  const result = { ...environment };
  for (const key of Object.keys(selected)) delete result[key];
  return result;
}

function failCleanly(error) {
  console.error(
    `Tracera environment error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
