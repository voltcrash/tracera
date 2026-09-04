import { TraceDetail } from "./trace-detail";

export default async function CheckDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TraceDetail id={id} />;
}
