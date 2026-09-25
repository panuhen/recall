import { NextRequest, NextResponse } from "next/server";

import { identityHeaders, resolveIdentity } from "@/lib/identity";

// BFF proxy: resolves identity, injects X-User-* headers, forwards to the
// backend. See lib/identity.ts for how each auth mode resolves the user.
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:8004";

async function proxy(req: NextRequest, path: string[]) {
  const user = await resolveIdentity(req);
  if (!user) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }

  const url = new URL(req.url);
  const target = `${BACKEND}/api/${path.join("/")}${url.search}`;

  const headers = identityHeaders(user);
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  const init: RequestInit = { method: req.method, headers, cache: "no-store" };
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  try {
    const res = await fetch(target, init);
    const headers = new Headers();
    headers.set(
      "content-type",
      res.headers.get("content-type") ?? "application/json",
    );
    // Preserve the download filename for exports.
    const disposition = res.headers.get("content-disposition");
    if (disposition) headers.set("content-disposition", disposition);
    // Stream the body through rather than re-encoding as text, so binary
    // responses (e.g. .zip exports) aren't corrupted.
    return new NextResponse(res.body, { status: res.status, headers });
  } catch {
    return NextResponse.json({ error: "backend unreachable" }, { status: 502 });
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function PATCH(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function PUT(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return proxy(req, (await ctx.params).path);
}
