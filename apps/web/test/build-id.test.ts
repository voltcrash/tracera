import { expect, test } from "vite-plus/test";
import { resolveBuildId } from "../scripts/build-id";

test("deployment attempts use their source SHA, run and attempt without date allocation", () => {
  const sha = "a".repeat(40);
  expect(resolveBuildId(false, `${sha}-100-2`)).toBe(`${sha}-100-2`);
  expect(resolveBuildId(false, `${sha}-100-3`)).not.toBe(resolveBuildId(false, `${sha}-100-2`));
  expect(resolveBuildId(false, " manual-build ")).toBe("manual-build");
});

test("local builds get distinct IDs and development stays stable", () => {
  expect(resolveBuildId(true, "")).toBe("dev");
  expect(resolveBuildId(false, "")).not.toBe(resolveBuildId(false, ""));
});

test.each(["x".repeat(65), "build/id", "build\nvalue", "build value"])(
  "rejects invalid build ID %j",
  (id) => {
    expect(() => resolveBuildId(false, id)).toThrow("TRACERA_BUILD_ID");
  },
);
