import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "recall_session";

// Redirect unauthenticated page views to the dedicated /sign-in page.
// Active in entra and betterauth modes; dev mode is always "signed in".
// Cookie presence is only routing, never authentication: the BFF verifies the
// session on every API call. (Next 16 renamed the "middleware" file convention
// to "proxy".)
export function proxy(req: NextRequest) {
  const mode = process.env.AUTH_MODE ?? "dev";
  if (mode !== "entra" && mode !== "betterauth") {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // API routes return their own 401s; /sign-in must stay reachable (no loop).
  if (pathname.startsWith("/api") || pathname === "/sign-in") {
    return NextResponse.next();
  }
  // OAuth discovery metadata is fetched by MCP clients with no session.
  if (mode === "betterauth" && pathname.startsWith("/.well-known/")) {
    return NextResponse.next();
  }

  // getSessionCookie also finds the __Secure- prefixed name Better Auth uses on
  // https origins.
  const signedIn =
    mode === "betterauth"
      ? Boolean(getSessionCookie(req))
      : req.cookies.has(SESSION_COOKIE);

  if (!signedIn) {
    const url = req.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Assets that must stay public: the OG card (social crawlers are never
  // authenticated) and the PWA manifest + icons (the browser/OS fetch these
  // without a session, e.g. at install time) — gating them would break link
  // previews and app installation.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|icon-\\d+(?:-maskable)?\\.png|apple-icon.png|manifest.webmanifest|og-card.png).*)",
  ],
};
