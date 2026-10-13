import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";

const [path, ...extra] = process.argv.slice(2);
if (!path || extra.length) {
  console.error("Usage: vp run web#provider-keys:generate-secret /PRIVATE_DIR/byok.env");
  process.exitCode = 1;
} else {
  try {
    const ring = JSON.stringify({
      activeVersion: 1,
      keys: { 1: randomBytes(32).toString("base64") },
    });
    writeFileSync(path, `PROVIDER_KEYS_ENCRYPTION_KEY='${ring}'\n`, { mode: 0o600, flag: "wx" });
    console.log(
      "Wrote a new encryption keyring to the private file. Preserve it across deployments.",
    );
  } catch (error) {
    console.error(
      error.code === "EEXIST"
        ? "The file already exists. Existing encryption keys were preserved; choose a new path."
        : "Could not write the encryption keyring. Check the private directory and its permissions.",
    );
    process.exitCode = 1;
  }
}
