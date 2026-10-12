import { expect, test } from "vite-plus/test";
import { createNonce, NONCE_HEADER, withNonce } from "../src/server/nonce";

test("nonces are 18 random bytes in base64 and differ per request", () => {
  const nonces = new Set(Array.from({ length: 50 }, () => createNonce()));
  expect(nonces.size).toBe(50);
  for (const nonce of nonces) expect(atob(nonce)).toHaveLength(18);
});

test("the Worker's nonce replaces a client-supplied header", () => {
  const { nonce, request } = withNonce(
    new Request("https://tracera.example/", { headers: { [NONCE_HEADER]: "attacker" } }),
  );
  expect(request.headers.get(NONCE_HEADER)).toBe(nonce);
  expect(nonce).not.toBe("attacker");
});
