import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import globals from "../styles/globals.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Tracera - trace a story to its source" },
    ],
    links: [{ rel: "stylesheet", href: globals }],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body className="font-sans">
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
