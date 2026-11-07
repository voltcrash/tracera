const recovery = {
  blocked: "Eligibility could not be established. No production mutation was started.",
  superseded: "A newer main commit replaced this candidate. No production mutation was started.",
  preflight_incomplete:
    "Preparation did not finish. Fix the failure and retry current main after CI succeeds.",
  migration_incomplete:
    "D1 may contain applied migrations. Inspect migration state and retry forward from current main; do not roll back the database automatically.",
  deployment_incomplete:
    "Migrations succeeded, but Worker activation is unconfirmed. Verify the active Worker and retry forward from current main; do not assume the previous schema or Worker is active.",
  deployed: "The migration and Worker deployment commands succeeded.",
};

export function productionReleaseState({ eligibility, cutover, migration, deployment }) {
  let state;
  if (migration === "failure" || migration === "cancelled") state = "migration_incomplete";
  else if (migration === "success")
    state = deployment === "success" ? "deployed" : "deployment_incomplete";
  else if (eligibility === "superseded" || cutover === "superseded") state = "superseded";
  else state = eligibility === "eligible" ? "preflight_incomplete" : "blocked";
  return { state, recovery: recovery[state] };
}
