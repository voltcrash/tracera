import { RunDetail } from "./_components/run-detail";

export default async function AnalysisRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RunDetail id={id} />;
}
