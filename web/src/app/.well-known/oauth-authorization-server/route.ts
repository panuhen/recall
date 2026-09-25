import { NextRequest } from "next/server";

import { unlessAuthMode } from "@/lib/auth";

// RFC 8414 authorization-server metadata for MCP clients, at the origin root
// where they look for it. The issuer is BETTER_AUTH_URL verbatim. Betterauth
// mode only; 404 otherwise.
export async function GET(req: NextRequest) {
  const gated = unlessAuthMode("betterauth");
  if (gated) return gated;
  const { getAuth } = await import("@/lib/betterauth");
  const { oAuthDiscoveryMetadata } = await import("better-auth/plugins");
  return oAuthDiscoveryMetadata(getAuth())(req);
}
