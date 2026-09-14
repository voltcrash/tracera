import { spawn } from "node:child_process";
import {
  assertEnvironmentConfiguration,
  redactedEnvironmentDiagnostic,
} from "../../packages/environment/src/index.js";

process.on("uncaughtException", failCleanly);

const separator = process.argv.indexOf("--");
const roleIndex = process.argv.indexOf("--role");
const role = roleIndex === -1 ? undefined : process.argv[roleIndex + 1];
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

if (!role || command.length === 0) {
  throw new Error("Usage: node scripts/environment/guard.mjs --role <role> -- <command> [args...]");
}

assertEnvironmentConfiguration(process.env, role);
console.error(redactedEnvironmentDiagnostic(process.env));

const child = spawn(command[0], command.slice(1), { env: process.env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(`Unable to start ${command[0]}: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});

function failCleanly(error) {
  console.error(
    `Tracera environment error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
