import { Response } from "miniflare";
import { expect, test } from "vite-plus/test";
import { createWorkerRuntime } from "./support/workerd-runtime";

test("workerd blocks private DNS answers before sending HTTP traffic", async () => {
  let requests = 0;
  const testRuntime = await createWorkerRuntime(
    async () => {
      requests += 1;
      return new Response("unexpected");
    },
    (_hostname, ipv6) => [ipv6 ? "::ffff:127.0.0.1" : "8.8.8.8"],
  );
  try {
    const response = await testRuntime.runtime.dispatchFetch(
      "http://worker/fetch?url=https%3A%2F%2Frebound.example%2F",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Links to private network hosts are not supported.",
    });
    expect(requests).toBe(0);
  } finally {
    await testRuntime.dispose();
  }
});

test("workerd rejects redirects into a private network without following them", async () => {
  const calls: string[] = [];
  const testRuntime = await createWorkerRuntime(async (request) => {
    calls.push(request.url);
    return new Response(null, {
      status: 302,
      headers: { location: "http://169.254.169.254/metadata" },
    });
  });
  try {
    const response = await testRuntime.runtime.dispatchFetch(
      "http://worker/fetch?url=https%3A%2F%2Fpublic.example%2F",
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Links to private network hosts are not supported.",
    });
    expect(calls).toEqual(["https://public.example/"]);
  } finally {
    await testRuntime.dispose();
  }
});

test("workerd resolves each public redirect hop and preserves the final response URL", async () => {
  const testRuntime = await createWorkerRuntime(async (request) =>
    request.url === "https://first.example/"
      ? new Response(null, { status: 307, headers: { location: "https://second.example/final" } })
      : new Response("final bytes"),
  );
  try {
    const response = await testRuntime.runtime.dispatchFetch(
      "http://worker/fetch?url=https%3A%2F%2Ffirst.example%2F",
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("final bytes");
    expect(response.headers.get("x-final-url")).toBe("https://second.example/final");
    expect(testRuntime.requests.filter((url) => url.includes("dns-query"))).toHaveLength(4);
  } finally {
    await testRuntime.dispose();
  }
});
