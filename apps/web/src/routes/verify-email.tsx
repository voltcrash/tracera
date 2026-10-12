import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/verify-email")({
  beforeLoad: () => {
    throw redirect({ to: "/", replace: true });
  },
});
