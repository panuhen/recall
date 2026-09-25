import { NextRequest } from "next/server";
import { vi } from "vitest";

// Modules read AUTH_MODE once at load, so each case sets the env and then
// imports a fresh copy.
export async function withMode<T>(mode: string | undefined, load: () => Promise<T>): Promise<T> {
  vi.resetModules();
  if (mode === undefined) vi.stubEnv("AUTH_MODE", undefined as unknown as string);
  else vi.stubEnv("AUTH_MODE", mode);
  return load();
}

export function req(url: string, cookie?: string): NextRequest {
  const headers = new Headers();
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(new URL(url, "http://localhost:3000"), { headers });
}
