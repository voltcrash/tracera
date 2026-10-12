import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/auth/complete")({
  beforeLoad: () => {
    throw redirect({ to: "/home" });
  },
});
