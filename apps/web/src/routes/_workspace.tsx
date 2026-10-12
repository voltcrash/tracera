import { createFileRoute, Outlet } from "@tanstack/react-router";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { requireUser } from "@/lib/route-guards";
import { getSession } from "@/server/session";

export const Route = createFileRoute("/_workspace")({
  beforeLoad: async () => ({ user: requireUser(await getSession()) }),
  component: WorkspaceLayout,
});

function WorkspaceLayout() {
  return (
    <WorkspaceShell>
      <Outlet />
    </WorkspaceShell>
  );
}
