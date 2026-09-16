import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  RELEASE_CALIBRATION_POLICY,
  evaluateCorrectnessCalibrator,
  fitCorrectnessCalibrator,
} from "../src/core/calibration/index.js";

const [command, ...rest] = process.argv.slice(2);
const options = parseOptions(rest);
const readJson = async (name: string) =>
  JSON.parse(await readFile(resolve(required(name)), "utf8")) as unknown;

if (command === "fit") {
  // Release fitting always uses the frozen policy; there is no option to lower minimums or admit synthetic labels.
  const result = fitCorrectnessCalibrator({
    dataset: await readJson("dataset"),
    observations: await readJson("observations"),
    policy: RELEASE_CALIBRATION_POLICY,
    seed: seed(),
    fittedAt: new Date().toISOString(),
  });
  if (result.status === "fitted") {
    await writeFile(
      resolve(required("output")),
      `${JSON.stringify(result.artifact, null, 2)}\n`,
      "utf8",
    );
  }
  report({
    command,
    status: result.status,
    policy: RELEASE_CALIBRATION_POLICY,
    ...(result.status === "fitted"
      ? {
          calibratorVersion: result.artifact.calibratorVersion,
          artifactHash: result.artifact.artifactHash,
          datasetHash: result.artifact.dataset.datasetHash,
          counts: result.counts,
          slices: result.artifact.slices,
          outOfFold: result.artifact.outOfFold,
        }
      : result),
    releaseApproved: false,
  });
  if (result.status !== "fitted") process.exitCode = 1;
} else if (command === "evaluate") {
  const split = required("split");
  if (split !== "development" && split !== "temporal" && split !== "test")
    throw new Error(
      "Calibration evaluation accepts only held-out development, temporal or test partitions.",
    );
  const result = evaluateCorrectnessCalibrator({
    dataset: await readJson("dataset"),
    observations: await readJson("observations"),
    artifact: await readJson("artifact"),
    split,
    seed: seed(),
    allowSealedTest: options.get("sealed-release-evaluation") === "true",
  });
  report({ command, ...result, releaseApproved: false });
  if (result.status !== "evaluated") process.exitCode = 1;
} else {
  throw new Error(
    "Usage: core-calibration.ts <fit|evaluate> --dataset PATH --observations PATH [...]",
  );
}

function parseOptions(values: string[]) {
  const parsed = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const name = values[index]!;
    if (!name.startsWith("--")) throw new Error(`Unexpected argument ${name}.`);
    const value = values[index + 1];
    if (value === undefined || value.startsWith("--")) parsed.set(name.slice(2), "true");
    else {
      parsed.set(name.slice(2), value);
      index += 1;
    }
  }
  return parsed;
}

function required(name: string) {
  const value = options.get(name);
  if (value === undefined || value === "true") throw new Error(`--${name} is required.`);
  return value;
}

function seed() {
  const value = Number(options.get("seed") ?? 20260910);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("--seed must be a non-negative integer.");
  return value;
}

function report(value: unknown) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
