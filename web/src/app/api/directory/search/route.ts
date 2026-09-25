import { NextRequest, NextResponse } from "next/server";

import { AUTH_MODE, getSessionUser } from "@/lib/auth";
import { searchDirectory, type DirectoryHit } from "@/lib/graph";
import { identityHeaders, resolveIdentity } from "@/lib/identity";

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8004";

// People picker for the ShareDialog. Lives outside the /api/[...path] BFF proxy
// because the source depends on the auth mode: entra searches the tenant
// directory through Graph (a web-tier concern); betterauth has no directory,
// so it searches recall's own users via the backend's /api/users/search.
// Session-gated in both; dev mode returns [] (no tenant).
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q") ?? "";

  if (AUTH_MODE === "betterauth") {
    const user = await resolveIdentity(req);
    if (!user) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
    return NextResponse.json({ results: await searchUsers(q, identityHeaders(user)) });
  }

  if (AUTH_MODE !== "dev") {
    const user = await getSessionUser(req);
    if (!user) {
      return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
    }
  }
  const results = await searchDirectory(q);
  return NextResponse.json({ results });
}

// recall's own user table, as the signed-in user. Like the Graph path, any
// failure degrades to [] and the dialog falls back to typing a full email.
async function searchUsers(query: string, headers: Headers): Promise<DirectoryHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const res = await fetch(
      `${BACKEND}/api/users/search?q=${encodeURIComponent(q)}`,
      { headers, cache: "no-store" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: DirectoryHit[] };
    return data.results ?? [];
  } catch {
    return [];
  }
}
