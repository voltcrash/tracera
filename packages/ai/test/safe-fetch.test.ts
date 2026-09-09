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
