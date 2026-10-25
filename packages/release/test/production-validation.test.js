import { expect, it, vi } from "vite-plus/test";
import { requireSuccessfulProductionCI } from "../src/production-validation.js";

const context = {
  repo: { owner: "voltcrash", repo: "tracera" },
  sha: "deployment-sha",
};
function run(fields = {}) {
  return {
    id: 42,
    head_sha: context.sha,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/voltcrash/tracera/actions/runs/42",
    ...fields,
  };
}
function validation(runs) {
  const listWorkflowRuns = vi.fn().mockResolvedValue({ data: { workflow_runs: runs } });
  return {
    github: { rest: { actions: { listWorkflowRuns } } },
    context,
    sha: context.sha,
  };
}
it("requires successful CI for the exact main-push snapshot", async () => {
  const options = validation([run()]);
  expect(await requireSuccessfulProductionCI(options)).toEqual(run());
  expect(options.github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith({
    ...context.repo,
    workflow_id: "ci.yml",
    branch: "main",
    event: "push",
    head_sha: context.sha,
    per_page: 100,
  });
});
it.each([
  { name: "missing", runs: [] },
  { name: "other commit", runs: [run({ head_sha: "other-sha" })] },
  { name: "pull request", runs: [run({ event: "pull_request" })] },
  { name: "other branch", runs: [run({ head_branch: "feature" })] },
])("rejects $name CI", async ({ runs }) => {
  await expect(requireSuccessfulProductionCI(validation(runs))).rejects.toThrow("No main-push");
});
it.each([
  ["queued", null],
  ["in_progress", null],
  ["completed", "failure"],
  ["completed", "cancelled"],
  ["completed", "skipped"],
  ["completed", "neutral"],
  ["completed", "timed_out"],
])("rejects %s/%s CI", async (status, conclusion) => {
  await expect(
    requireSuccessfulProductionCI(validation([run({ status, conclusion })])),
  ).rejects.toThrow("retry after CI succeeds");
});
it("cannot use older success when a newer run fails", async () => {
  await expect(
    requireSuccessfulProductionCI(validation([run(), run({ id: 43, conclusion: "failure" })])),
  ).rejects.toThrow("CI 43");
});
it("allows a successful rerun of the latest snapshot", async () => {
  const latest = run({ id: 43 });
  expect(
    await requireSuccessfulProductionCI(validation([run({ conclusion: "failure" }), latest])),
  ).toEqual(latest);
});
it("validates the completed CI commit even when main has advanced", async () => {
  const options = validation([run()]);
  options.context = {
    ...context,
    eventName: "workflow_run",
    sha: "newer-main-sha",
    payload: { workflow_run: { head_sha: context.sha } },
  };
  expect(await requireSuccessfulProductionCI(options)).toEqual(run());
  expect(options.github.rest.actions.listWorkflowRuns).toHaveBeenCalledWith(
    expect.objectContaining({ head_sha: context.sha }),
  );
  await expect(
    requireSuccessfulProductionCI({ ...options, sha: "newer-main-sha" }),
  ).rejects.toThrow("must match");
  expect(options.github.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(1);
});
it.each([{}, { workflow_run: {} }])(
  "rejects workflow-run events missing the CI snapshot (%j)",
  async (payload) => {
    const options = validation([run()]);
    options.context = { ...context, eventName: "workflow_run", payload };
    await expect(requireSuccessfulProductionCI(options)).rejects.toThrow("must match");
    expect(options.github.rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
  },
);
it("fails closed when the deployment snapshot differs or the API is unavailable", async () => {
  const options = validation([run()]);
  await expect(requireSuccessfulProductionCI({ ...options, sha: "wrong-sha" })).rejects.toThrow(
    "must match",
  );
  expect(options.github.rest.actions.listWorkflowRuns).not.toHaveBeenCalled();
  options.github.rest.actions.listWorkflowRuns.mockRejectedValue(new Error("API unavailable"));
  await expect(requireSuccessfulProductionCI(options)).rejects.toThrow("API unavailable");
});
