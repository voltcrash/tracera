import { request, type RequestOptions } from "node:https";
import { expect, test, vi } from "vite-plus/test";
import { createSafeFetch } from "../src/safe-fetch";

vi.mock("node:https", () => ({
  request: vi.fn(() => {
    throw new Error("stopped before connecting");
  }),
}));

test("the default Node transport pins the socket lookup to the validated DNS addresses", async () => {
  const resolver = vi.fn(async () => ["8.8.8.8", "2001:4860:4860::8888"]);
  const safeFetch = createSafeFetch({ resolveHostAddresses: resolver });
  await expect(safeFetch("https://rebound.example/evidence")).rejects.toThrow(
    "stopped before connecting",
  );
  expect(request).toHaveBeenCalledOnce();
  expect(resolver).toHaveBeenCalledExactlyOnceWith("rebound.example");
  const options = vi.mocked(request).mock.calls[0]![0] as RequestOptions;
  expect(options.agent).toBe(false);
  expect(options.servername).toBe("rebound.example");
  expect(options.path).toBe("/evidence");
  await new Promise<void>((resolve, reject) => {
    options.lookup!("rebound.example", { family: 4, all: false }, (error, address, family) => {
      if (error) {
        reject(error);
        return;
      }
      expect(address).toBe("8.8.8.8");
      expect(family).toBe(4);
      resolve();
    });
  });
  expect(resolver).toHaveBeenCalledOnce();
});
