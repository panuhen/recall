import { NextResponse } from "next/server";

// BFF proxy: the browser calls /api/health, we forward to the backend
// (reachable only inside the compose network in dev).
export async function GET() {
  const backend = process.env.BACKEND_URL ?? "http://localhost:8004";
  try {
    const res = await fetch(`${backend}/health`, { cache: "no-store" });
    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { status: "error", service: "recall", db: false, pgvector: false },
      { status: 502 },
    );
  }
}
