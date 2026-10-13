import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { expect, test } from "vite-plus/test";
import { validateProviderKeyEncryptionConfiguration } from "@repo/ai";

const script = fileURLToPath(new URL("../scripts/create-provider-key-secret.mjs", import.meta.url));
test("the setup CLI creates independent private keyrings without printing their values", () => {
  const directory = mkdtempSync(join(tmpdir(), "tracera-byok-keyring-"));
  try {
    const rings: string[] = [];
    for (const name of ["staging", "production"]) {
      const path = join(directory, `${name}.env`);
      const result = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const secret = parseEnv(readFileSync(path, "utf8")).PROVIDER_KEYS_ENCRYPTION_KEY!;
      expect(() => validateProviderKeyEncryptionConfiguration(secret)).not.toThrow();
      expect(result.stdout).not.toContain(secret);
      rings.push(secret);
      const again = spawnSync(process.execPath, [script, path], { encoding: "utf8" });
      expect(again.status).toBe(1);
      expect(again.stderr).toContain("Existing encryption keys were preserved");
      expect(parseEnv(readFileSync(path, "utf8")).PROVIDER_KEYS_ENCRYPTION_KEY).toBe(secret);
    }
    expect(rings[0]).not.toBe(rings[1]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
