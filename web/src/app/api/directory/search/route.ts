import { NextRequest, NextResponse } from "next/server";

import { AUTH_MODE, getSessionUser } from "@/lib/auth";
import { searchDirectory } from "@/lib/graph";

// People picker for the ShareDialog. Lives outside the /api/[...path] BFF proxy
// because it resolves in the web tier (an Entra/Graph concern) rather than the
// Python backend. Session-gated in entra mode; dev mode returns [] (no tenant).
export async function GET(req: NextRequest) {
  if (AUTH_MODE !== "dev") {
    const user = await getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
  }
  const q = req.nextUrl.searchParams.get("q") ?? "";
  const results = await searchDirectory(q);
  return NextResponse.json({ results });
}
