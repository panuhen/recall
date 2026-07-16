import { ConfidentialClientApplication } from "@azure/msal-node";
import { SignJWT, jwtVerify } from "jose";
import type { NextRequest } from "next/server";

export const AUTH_MODE = process.env.AUTH_MODE ?? "dev";
export const SESSION_COOKIE = "recall_session";
export const STATE_COOKIE = "recall_oauth_state";
export const SCOPES = ["openid", "profile", "email"];
export const REDIRECT_URI =
  process.env.AUTH_REDIRECT_URI ?? "http://localhost:3000/api/auth/callback";
export const TENANT_ID = process.env.AZURE_TENANT_ID ?? "";

const CLIENT_ID = process.env.AZURE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET ?? "";

let _cca: ConfidentialClientApplication | null = null;

export function getMsalClient(): ConfidentialClientApplication {
  if (!_cca) {
    _cca = new ConfidentialClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        clientSecret: CLIENT_SECRET,
      },
    });
  }
  return _cca;
}

export type SessionUser = { oid: string; upn: string; name: string };

function sessionKey(): Uint8Array {
  return new TextEncoder().encode(
    process.env.SESSION_SECRET ?? "dev-insecure-session-secret-change-me",
  );
}

export async function createSession(user: SessionUser): Promise<string> {
  return new SignJWT({ oid: user.oid, upn: user.upn, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("8h")
    .sign(sessionKey());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, sessionKey());
    return {
      oid: String(payload.oid ?? ""),
      upn: String(payload.upn ?? ""),
      name: String(payload.name ?? ""),
    };
  } catch {
    return null;
  }
}

export async function getSessionUser(
  req: NextRequest,
): Promise<SessionUser | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

// Absolute origin of the app from the request (Host header), so redirects go
// to localhost:3000 rather than the container's 0.0.0.0 bind address.
export function appOrigin(req: NextRequest): string {
  const host = req.headers.get("host") ?? "localhost:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

// Entra global sign-out endpoint (ends the SSO session). A post-logout redirect
// back to the app is added only if AUTH_POST_LOGOUT_REDIRECT_URI is set AND
// registered on the app registration; otherwise Entra shows its own page.
export function getLogoutUrl(): string {
  const base = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout`;
  const redirect = process.env.AUTH_POST_LOGOUT_REDIRECT_URI;
  return redirect
    ? `${base}?post_logout_redirect_uri=${encodeURIComponent(redirect)}`
    : base;
}
