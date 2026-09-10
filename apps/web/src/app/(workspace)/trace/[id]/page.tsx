import { TraceDetail } from "./_components/trace-detail";

export default async function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TraceDetail id={id} />;
}
