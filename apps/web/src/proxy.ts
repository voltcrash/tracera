import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  applySecurityHeaders,
  contentSecurityPolicy,
  PRIVATE_NO_STORE_CACHE,
} from "./security-headers";

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request, { cookiePrefix: "tracera" });
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy({
    nonce,
    isDevelopment: process.env.NODE_ENV === "development",
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const nextResponse = NextResponse.next({ request: { headers: requestHeaders } });
  applySecurityHeaders(nextResponse, policy);
  if (sessionCookie) nextResponse.headers.set("Cache-Control", PRIVATE_NO_STORE_CACHE);

  if (request.nextUrl.pathname === "/" || request.nextUrl.pathname === "/auth/error") {
    return nextResponse;
  }

  if (sessionCookie) return nextResponse;

  const redirect = NextResponse.redirect(new URL("/", request.url));
  applySecurityHeaders(redirect, policy);
  return redirect;
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next(?:/|$)|brand(?:/|$)|favicon\\.ico$|icon\\.\\w+$|apple-icon\\.\\w+$|og\\.png$).*)",
  ],
};
