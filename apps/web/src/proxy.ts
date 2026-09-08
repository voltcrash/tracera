import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request, { cookiePrefix: "tracera" });

  if (request.nextUrl.pathname === "/") {
    return sessionCookie
      ? NextResponse.redirect(new URL("/home", request.url))
      : NextResponse.next();
  }

  if (sessionCookie) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/", request.url));
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next(?:/|$)|brand(?:/|$)|favicon\\.ico$|icon\\.\\w+$|apple-icon\\.\\w+$|og\\.png$).*)",
  ],
};
