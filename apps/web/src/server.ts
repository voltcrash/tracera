import handler from "@tanstack/react-start/server-entry";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type AnalysisWorkflowParams = { runId: string };

/** Phase 2.5 replaces this placeholder with the analysis pipeline. */
export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  override async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep) {
    return await step.do("pending", async () => ({ runId: event.payload.runId }));
  }
}

export default {
  fetch(request) {
    return handler.fetch(request);
  },
  async scheduled() {},
} satisfies ExportedHandler<Env>;
