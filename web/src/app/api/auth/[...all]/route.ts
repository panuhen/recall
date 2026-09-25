import { NextRequest } from "next/server";

import { unlessAuthMode } from "@/lib/auth";

// Better Auth's handler (sign-in/social, callback/google, sign-out, the mcp()
// OAuth endpoints, ...) under its default basePath /api/auth. Betterauth mode
// only; 404 otherwise. The MSAL routes (/api/auth/signin, /callback, /signout)
// are exact-match files, so Next routes them ahead of this catch-all.
async function handle(req: NextRequest): Promise<Response> {
  const gated = unlessAuthMode("betterauth");
  if (gated) return gated;
  const { getAuth } = await import("@/lib/betterauth");
  return getAuth().handler(req);
}

export async function GET(req: NextRequest) {
  return handle(req);
}
export async function POST(req: NextRequest) {
  return handle(req);
}
