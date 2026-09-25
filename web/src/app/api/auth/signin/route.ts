import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  getMsalClient,
  REDIRECT_URI,
  SCOPES,
  STATE_COOKIE,
  unlessAuthMode,
} from "@/lib/auth";

// Start the MSAL auth-code flow: redirect the browser to Entra ID. Entra mode
// only; 404 otherwise.
export async function GET(_req: NextRequest) {
  const gated = unlessAuthMode("entra");
  if (gated) return gated;
  const state = randomUUID();
  const authUrl = await getMsalClient().getAuthCodeUrl({
    scopes: SCOPES,
    redirectUri: REDIRECT_URI,
    state,
    responseMode: "query",
  });

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
