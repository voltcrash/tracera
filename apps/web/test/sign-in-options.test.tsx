import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vite-plus/test";
import { SignInOptions } from "../src/components/auth/sign-in-options";

const render = (options: Parameters<typeof SignInOptions>[0]["options"]) =>
  renderToStaticMarkup(<SignInOptions options={options} />);

test("a GitHub-only deployment offers GitHub sign-in alone", () => {
  const html = render({ providers: ["github"], identities: null });
  expect(html).toContain("Continue with GitHub");
  expect(html).not.toContain("Google");
});

test("a deployment with both pairs offers Google and GitHub", () => {
  const html = render({ providers: ["google", "github"], identities: null });
  expect(html.indexOf("Continue with Google")).toBeGreaterThan(-1);
  expect(html.indexOf("Continue with GitHub")).toBeGreaterThan(
    html.indexOf("Continue with Google"),
  );
});

test("local development offers the dev identities instead of OAuth", () => {
  const html = render({
    providers: ["github"],
    identities: [
      { id: "ada", name: "Ada" },
      { id: "grace", name: "Grace" },
    ],
  });
  expect(html).toContain('href="/api/auth/dev-login?identity=ada"');
  expect(html).toContain("Continue as Grace");
  expect(html).not.toContain("Continue with GitHub");
});

test("without any configured method the page says sign-in is unavailable", () => {
  expect(render({ providers: [], identities: null })).toContain("Sign-in is not available");
});
