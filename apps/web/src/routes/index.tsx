import { createFileRoute } from "@tanstack/react-router";
import { getRuntimeStatus } from "@/server/runtime-status";

export const Route = createFileRoute("/")({
  loader: () => getRuntimeStatus(),
  component: Placeholder,
});

function Placeholder() {
  const status = Route.useLoaderData();
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-8">
      <h1 className="font-serif text-4xl">Tracera</h1>
      <p className="text-ink-soft">Tracera is moving to Cloudflare Workers.</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-sm">
        <dt>Mode</dt>
        <dd>{status.mode}</dd>
        <dt>Version</dt>
        <dd>{status.version}</dd>
        <dt>D1 migrations</dt>
        <dd data-testid="d1-migrations">{status.migrations}</dd>
      </dl>
    </main>
  );
}
