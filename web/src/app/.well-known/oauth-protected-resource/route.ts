import { NextRequest } from "next/server";

import { unlessAuthMode } from "@/lib/auth";

// RFC 9728 protected-resource metadata for the web origin. The MCP resource
// itself (the backend's /mcp) serves its own copy; this one points clients
// that start from the web origin at the same authorization server. Betterauth
// mode only; 404 otherwise.
export async function GET(req: NextRequest) {
  const gated = unlessAuthMode("betterauth");
  if (gated) return gated;
  const { getAuth } = await import("@/lib/betterauth");
  const { oAuthProtectedResourceMetadata } = await import("better-auth/plugins");
  return oAuthProtectedResourceMetadata(getAuth())(req);
}
