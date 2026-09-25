import { NextRequest, NextResponse } from "next/server";

import { unlessAuthMode } from "@/lib/auth";

// The connecting OAuth client's self-reported name, so the consent page can say
// "Claude wants to connect" instead of an opaque client_id. Reads only the
// display name that Better Auth stored at dynamic registration, never a
// secret. A static segment, so it resolves ahead of the /api/auth/[...all]
// catch-all. Betterauth mode only; 404 otherwise.
export async function GET(req: NextRequest) {
  const gated = unlessAuthMode("betterauth");
  if (gated) return gated;
  const clientId = req.nextUrl.searchParams.get("client_id");
  if (!clientId) {
    return NextResponse.json({ name: null }, { status: 400 });
  }
  try {
    const { getAuth } = await import("@/lib/betterauth");
    const ctx = await getAuth().$context;
    const client = await ctx.adapter.findOne<{ name?: string }>({
      model: "oauthApplication",
      where: [{ field: "clientId", value: clientId }],
    });
    return NextResponse.json({ name: client?.name ?? null });
  } catch {
    // A missing name only costs the page its label; never block consent.
    return NextResponse.json({ name: null });
  }
}
