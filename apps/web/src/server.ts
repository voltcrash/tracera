import handler from "@tanstack/react-start/server-entry";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runAnalysisWorkflow } from "./server/analysis-workflow-runner.server";
import { parseServerEnv } from "./server/env";
import { withNonce } from "./server/nonce";
import type { AnalysisWorkflowParams } from "./server/workflow-params";

export class AnalysisWorkflow extends WorkflowEntrypoint<Env, AnalysisWorkflowParams> {
  override async run(event: WorkflowEvent<AnalysisWorkflowParams>, step: WorkflowStep) {
    return runAnalysisWorkflow(parseServerEnv(this.env), event.payload, step);
  }
}

export default {
  fetch(request) {
    return handler.fetch(withNonce(request).request);
  },
  async scheduled() {},
} satisfies ExportedHandler<Env>;
