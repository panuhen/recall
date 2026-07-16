import { NextResponse } from "next/server";

// Public MCP endpoint the user points their AI assistant at. Read at request
// time (not baked at build) so the same image works across environments. In
// prod MCP is its own public host; in dev it's the host-published backend port.
export async function GET() {
  const base = (process.env.MCP_PUBLIC_URL ?? "http://localhost:8004").replace(
    /\/+$/,
    "",
  );
  const authMode = process.env.AUTH_MODE ?? "dev";
  return NextResponse.json({ url: `${base}/mcp`, authMode });
}
