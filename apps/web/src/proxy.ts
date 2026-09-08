import { getSessionCookie } from "better-auth/cookies";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/" || getSessionCookie(request, { cookiePrefix: "tracera" })) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/", request.url));
}

export const config = {
  matcher: [
    "/((?!api(?:/|$)|_next(?:/|$)|brand(?:/|$)|favicon\\.ico$|icon\\.png$|apple-icon\\.png$|og\\.png$).*)",
  ],
};
