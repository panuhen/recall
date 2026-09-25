import type { NextRequest } from "next/server";

import { AUTH_MODE, getSessionUser } from "@/lib/auth";

// The identity the BFF forwards to the backend as X-User-* headers. Dev mode
// uses a fixed stub user; entra reads the MSAL session; betterauth reads the
// Better Auth session (id = Better Auth user id, upn = email).
export type Identity = { id: string; upn: string; name: string };

export async function resolveIdentity(
  req: NextRequest,
): Promise<Identity | null> {
  if (AUTH_MODE === "dev") {
    return {
      id: process.env.DEV_USER_OID ?? "00000000-0000-0000-0000-000000000001",
      upn: process.env.DEV_USER_UPN ?? "dev@example.com",
      name: process.env.DEV_USER_NAME ?? "Dev User",
    };
  }
  const user = await getSessionUser(req);
  if (!user) return null;
  return { id: user.oid, upn: user.upn, name: user.name };
}

export function identityHeaders(user: Identity): Headers {
  const headers = new Headers();
  headers.set("x-user-id", user.id);
  headers.set("x-user-upn", user.upn);
  headers.set("x-user-name", user.name);
  return headers;
}
