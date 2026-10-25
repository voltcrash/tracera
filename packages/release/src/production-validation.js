/** Require the latest main-push CI result for the exact deployment snapshot. */
export async function requireSuccessfulProductionCI({ github, context, sha }) {
  // workflow_run's context.sha points at current main, not necessarily the CI commit.
  const deploymentSha =
    context.eventName === "workflow_run" ? context.payload?.workflow_run?.head_sha : context.sha;
  if (!sha || sha !== deploymentSha) {
    throw new Error("CI validation must match the deployment workflow's commit");
  }
  const { data } = await github.rest.actions.listWorkflowRuns({
    ...context.repo,
    workflow_id: "ci.yml",
    branch: "main",
    event: "push",
    head_sha: sha,
    per_page: 100,
  });
  const run = data.workflow_runs
    .filter(
      (candidate) =>
        candidate.head_sha === sha &&
        candidate.head_branch === "main" &&
        candidate.event === "push",
    )
    .sort((a, b) => b.id - a.id)[0];
  if (run === undefined) {
    throw new Error(`No main-push CI run for ${sha}; retry after CI succeeds`);
  }
  if (run.status !== "completed" || run.conclusion !== "success") {
    throw new Error(
      `CI ${run.id} is ${run.status}/${run.conclusion ?? "pending"} for ${sha}; retry after CI succeeds`,
    );
  }
  return run;
}
