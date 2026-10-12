import { createFileRoute } from "@tanstack/react-router";
import { getRun } from "@/server/analysis.functions";
import { RunDetail } from "./-components/run-detail";

export const Route = createFileRoute("/_workspace/run/$id")({
  loader: ({ params }) => getRun({ data: { runId: params.id } }),
  component: AnalysisRunPage,
});

function AnalysisRunPage() {
  const { id } = Route.useParams();
  return <RunDetail key={id} id={id} initial={Route.useLoaderData()} />;
}
