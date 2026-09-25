import { NextRequest, NextResponse } from "next/server";

import {
  appOrigin,
  AUTH_MODE,
  getLogoutUrl,
  SESSION_COOKIE,
  TENANT_ID,
  unlessAuthMode,
} from "@/lib/auth";

// Clears the recall session cookie. In entra mode it then redirects to the
// Entra global sign-out so the SSO session ends too (federated logout).
// Entra mode only; 404 otherwise (Better Auth signs out via
// POST /api/auth/sign-out).
export async function GET(req: NextRequest) {
  const gated = unlessAuthMode("entra");
  if (gated) return gated;
  const dest =
    AUTH_MODE === "entra" && TENANT_ID
      ? getLogoutUrl()
      : new URL("/", appOrigin(req)).toString();

  const res = NextResponse.redirect(dest);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
