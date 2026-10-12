import { createFileRoute } from "@tanstack/react-router";
import { RunDetail } from "./-components/run-detail";

export const Route = createFileRoute("/_workspace/run/$id")({
  component: AnalysisRunPage,
});

function AnalysisRunPage() {
  const { id } = Route.useParams();
  return <RunDetail id={id} />;
}
