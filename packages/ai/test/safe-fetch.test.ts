import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { createSafeFetch, isBlockedAddress } from "../src/index.js";

test("blocks special-use IPv4 and IPv6 addresses, including mapped forms", () => {
  const blocked = [
    "0.0.0.0",
    "10.42.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "168.63.129.16",
    "169.254.169.254",
    "172.31.255.254",
    "192.168.1.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:ffff:7f00:1",
    "::ffff:169.254.169.254",
  ];

  for (const address of blocked) assert.equal(isBlockedAddress(address), true, address);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("2001:4860:4860::8888"), false);
  assert.equal(isBlockedAddress("::ffff:8.8.8.8"), false);
});

test("blocks canonicalized IPv4 URL spellings before calling the transport", async () => {
  let requests = 0;
  const safeFetch = createSafeFetch({
    fetchImplementation: async () => {
      requests += 1;
      return new Response("unexpected");
    },
  });

  for (const url of [
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.0.0.1/",
    "http://127.1/",
  ]) {
    await assert.rejects(safeFetch(url), /private network hosts/);
  }
  assert.equal(requests, 0);
});

test("rejects a hostname when any resolved family reaches a blocked address", async () => {
  let requests = 0;
  const safeFetch = createSafeFetch({
    resolveHostAddresses: async () => ["8.8.8.8", "0:0:0:0:0:ffff:7f00:1"],
    fetchImplementation: async () => {
      requests += 1;
      return new Response("unexpected");
    },
  });

  await assert.rejects(safeFetch("https://rebound.example/"), /private network hosts/);
  assert.equal(requests, 0);
});

test("validates redirect targets before following them", async () => {
  const requestedUrls: string[] = [];
  const safeFetch = createSafeFetch({
    resolveHostAddresses: async (hostname) => {
      assert.equal(hostname, "public.example");
      return ["8.8.8.8"];
    },
    fetchImplementation: async (input) => {
      requestedUrls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { location: "http://[::ffff:7f00:1]/metadata" },
      });
    },
  });

  await assert.rejects(safeFetch("https://public.example/start"), /private network hosts/);
  assert.deepEqual(requestedUrls, ["https://public.example/start"]);
});

test("rejects unsafe protocols, ports, credentials and private hostnames before fetching", async () => {
  let requests = 0;
  const safeFetch = createSafeFetch({
    fetchImplementation: async () => {
      requests += 1;
      return new Response("unexpected");
    },
  });
  for (const url of [
    "file:///etc/passwd",
    "ftp://public.example/file",
    "https://public.example:8080/",
    "http://public.example:443/",
    "https://user:password@public.example/",
    "http://localhost./",
    "https://metadata.google.internal/",
    "http://host.home.arpa/",
  ])
    await assert.rejects(safeFetch(url));
  assert.equal(requests, 0);
});

test("follows only validated redirects with manual transport and strips cross-origin credentials", async () => {
  const requests: RequestInit[] = [];
  const safeFetch = createSafeFetch({
    resolveHostAddresses: async () => ["8.8.8.8"],
    fetchImplementation: async (_url, init) => {
      requests.push(init!);
      return requests.length === 1
        ? new Response(null, { status: 302, headers: { location: "https://second.example/end" } })
        : new Response("done");
    },
  });
  const response = await safeFetch("https://first.example/start", {
    method: "POST",
    body: "payload",
    headers: {
      authorization: "Bearer secret",
      cookie: "session=secret",
      "proxy-authorization": "secret",
      "content-type": "text/plain",
    },
  });
  assert.equal(await response.text(), "done");
  assert.equal(response.url, "https://second.example/end");
  assert.equal(response.redirected, true);
  assert.equal(requests[0]!.redirect, "manual");
  assert.equal(requests[1]!.redirect, "manual");
  assert.equal(requests[1]!.method, "GET");
  assert.equal(requests[1]!.body, undefined);
  const headers = new Headers(requests[1]!.headers);
  for (const name of ["authorization", "cookie", "proxy-authorization", "content-type"])
    assert.equal(headers.has(name), false);
});

test("cancels a redirect body when destination validation fails", async () => {
  let cancelled = false;
  const safeFetch = createSafeFetch({
    fetchImplementation: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        {
          status: 307,
          headers: { location: "https://public.example:8000/" },
        },
      ),
  });
  await assert.rejects(safeFetch("https://public.example/start"), /ports/);
  assert.equal(cancelled, true);
});

test("honors abort signals without starting a transport request", async () => {
  let fetched = false;
  const safeFetch = createSafeFetch({
    fetchImplementation: async () => {
      fetched = true;
      return new Response();
    },
  });
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  await assert.rejects(
    safeFetch("https://public.example/", { signal: controller.signal }),
    /stopped/,
  );
  assert.equal(fetched, false);
});

test("cross-origin redirects never forward Gemini or Anthropic API-key headers", async () => {
  let calls = 0;
  const safeFetch = createSafeFetch({
    fetchImplementation: async (_url, init) => {
      calls += 1;
      const headers = new Headers(init?.headers);
      if (calls === 1) {
        assert.equal(headers.get("x-api-key"), "anthropic-secret");
        assert.equal(headers.get("x-goog-api-key"), "gemini-secret");
        return new Response(null, {
          status: 307,
          headers: { location: "https://different.example/" },
        });
      }
      assert.equal(headers.has("x-api-key"), false);
      assert.equal(headers.has("x-goog-api-key"), false);
      return new Response("done");
    },
  });
  assert.equal(
    await (
      await safeFetch("https://first.example/", {
        headers: { "x-api-key": "anthropic-secret", "x-goog-api-key": "gemini-secret" },
      })
    ).text(),
    "done",
  );
});
