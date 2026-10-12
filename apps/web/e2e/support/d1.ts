import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function executeLocalSql(sql: string) {
  const directory = mkdtempSync(join(tmpdir(), "tracera-browser-"));
  const path = join(directory, "query.sql");
  try {
    writeFileSync(path, sql, { mode: 0o600 });
    const result = execFileSync(
      "vp",
      ["exec", "wrangler", "d1", "execute", "tracera-staging", "--local", "--file", path, "--json"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLOUDFLARE_CF_FETCH_ENABLED: "false",
          WRANGLER_SEND_METRICS: "false",
        },
      },
    );
    return JSON.parse(result) as { results: Record<string, unknown>[] }[];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value !== "string")
    throw new TypeError("SQL values must be strings, numbers, or null.");
  return "'" + value.replaceAll("'", "''") + "'";
}

export function cleanBrowserUsers() {
  const owners = "SELECT id FROM users WHERE email IN ('ada@tracera.local','grace@tracera.local')";
  const tables = [
    "core_decisions",
    "core_evidence_assessments",
    "core_provenance_edges",
    "core_report_claims",
    "core_report_snapshots",
    "core_report_versions",
    "core_stage_attempts",
    "core_stage_checkpoints",
    "core_snapshots",
    "core_runs",
  ];
  executeLocalSql(
    tables.map((table) => `DELETE FROM ${table} WHERE owner_user_id IN (${owners});`).join("\n") +
      `\nDELETE FROM users WHERE id IN (${owners});`,
  );
}
