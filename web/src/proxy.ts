import { NextRequest, NextResponse } from "next/server";

const SESSION_COOKIE = "recall_session";

// Redirect unauthenticated page views to the dedicated /sign-in page.
// Only active in entra mode; dev mode is always "signed in".
// (Next 16 renamed the "middleware" file convention to "proxy".)
export function proxy(req: NextRequest) {
  if ((process.env.AUTH_MODE ?? "dev") !== "entra") {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // API routes return their own 401s; /sign-in must stay reachable (no loop).
  if (pathname.startsWith("/api") || pathname === "/sign-in") {
    return NextResponse.next();
  }

  if (!req.cookies.has(SESSION_COOKIE)) {
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
