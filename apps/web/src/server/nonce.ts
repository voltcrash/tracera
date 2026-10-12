/** Internal header carrying this request's CSP nonce from the Worker entry to Start. */
export const NONCE_HEADER = "x-tracera-nonce";

export function createNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
}

/** Overwrites any client-supplied value, so only the Worker can choose the nonce. */
export function withNonce(request: Request, nonce = createNonce()) {
  const headers = new Headers(request.headers);
  headers.set(NONCE_HEADER, nonce);
  return { nonce, request: new Request(request, { headers }) };
}
