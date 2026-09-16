import { CoreRunDetail } from "./_components/core-run-detail";

export default async function CoreRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CoreRunDetail id={id} />;
}
