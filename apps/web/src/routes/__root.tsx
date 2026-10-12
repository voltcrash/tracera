import { createRootRoute, HeadContent, Outlet, Scripts, useRouter } from "@tanstack/react-router";
import { AuthProvider } from "@/components/providers/auth-provider";
import { ThemeProvider, themeBootstrapScript } from "@/components/providers/theme-provider";
import globals from "../styles/globals.css?url";

const SITE = "https://tracera.voltcrash.com";
const TITLE = "Tracera - trace a story to its source";
const DESCRIPTION =
  "Tracera takes a story apart one claim at a time, checks each against sources it can name, and marks the ones that don’t hold up.";
const SHARE_DESCRIPTION =
  "Tracera marks the claims in a story, traces them to the earliest observed source within the searched scope, and shows the evidence behind each one.";
const SHARE_IMAGE = `${SITE}/og.png`;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "darkreader-lock" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: SHARE_DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:image", content: SHARE_IMAGE },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      {
        property: "og:image:alt",
        content: "A news excerpt with its factual claims underlined and annotated in the margin",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: SHARE_DESCRIPTION },
      { name: "twitter:image", content: SHARE_IMAGE },
    ],
    links: [
      { rel: "stylesheet", href: globals },
      { rel: "icon", href: "/favicon.ico", sizes: "any" },
      { rel: "icon", href: "/icon.svg", type: "image/svg+xml" },
      { rel: "apple-touch-icon", href: "/apple-icon.png" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  const nonce = useRouter().options.ssr?.nonce;
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        {/* HeadContent keeps one meta per name, so the per-scheme colors render here. */}
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f5f5f4" />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#000000" />
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeBootstrapScript }}
        />
      </head>
      <body className="font-sans">
        <ThemeProvider>
          <AuthProvider>
            <Outlet />
          </AuthProvider>
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}
