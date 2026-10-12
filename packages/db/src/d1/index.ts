import type { D1Database } from "@cloudflare/workers-types";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema.js";

export function createD1Database(binding: D1Database): DrizzleD1Database<typeof schema> {
  return drizzle(binding, { schema });
}

export { schema };
export {
  createD1AnalysisRepository,
  D1AnalysisRepository,
  AnalysisStorageConflictError,
  AnalysisStorageAccessError,
  StaleWorkerError,
  type D1RepositoryOptions,
  type D1RunAttempt,
} from "./repository.js";
export { createD1AdmissionRepository, D1AdmissionRepository } from "./admission.js";
export { createD1SpendRepository, D1SpendRepository, type D1SpendAdmission } from "./spend.js";
export { D1PayloadStore, D1PayloadError, type StoredProjection } from "./payloads.js";
export { createD1MaintenanceRepository } from "./maintenance.js";
