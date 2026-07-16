import { NextRequest, NextResponse } from "next/server";

import {
  appOrigin,
  createSession,
  getMsalClient,
  REDIRECT_URI,
  SCOPES,
  SESSION_COOKIE,
  STATE_COOKIE,
  TENANT_ID,
} from "@/lib/auth";

// Entra redirects here with an auth code. Exchange it, verify the tenant,
// mint a session cookie, and send the user home.
export async function GET(req: NextRequest) {
  const origin = appOrigin(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = req.cookies.get(STATE_COOKIE)?.value;

  if (!code || !state || state !== expectedState) {
    return NextResponse.redirect(new URL("/?error=auth_state", origin));
  }

  try {
    const result = await getMsalClient().acquireTokenByCode({
      code,
      scopes: SCOPES,
      redirectUri: REDIRECT_URI,
    });

    const claims = (result.idTokenClaims ?? {}) as Record<string, unknown>;

    // Pin to our tenant — the robust "only our organization" gate.
    if (TENANT_ID && String(claims.tid ?? "") !== TENANT_ID) {
      return NextResponse.redirect(new URL("/?error=wrong_tenant", origin));
    }

    const token = await createSession({
      oid: String(claims.oid ?? ""),
      upn: String(claims.preferred_username ?? claims.upn ?? ""),
      name: String(claims.name ?? ""),
    });

    const res = NextResponse.redirect(new URL("/", origin));
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 8 * 3600,
    });
    res.cookies.delete(STATE_COOKIE);
    return res;
  } catch {
    return NextResponse.redirect(new URL("/?error=auth_failed", origin));
  }
}
