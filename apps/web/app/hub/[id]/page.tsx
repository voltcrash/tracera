import { TraceDetail } from "./trace-detail";

// The static export prerenders a single shell; Vercel routes every
// `/hub/<check id>` request to it and the client resolves the id at runtime.
export const TRACE_SHELL_ID = "trace";

export function generateStaticParams() {
  return [{ id: TRACE_SHELL_ID }];
}

export default function CheckDetailPage() {
  return <TraceDetail />;
}
