import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

import { req, withMode } from "./helpers";

function redirected(res: Response): string | null {
  return res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
}

describe("proxy (sign-in redirect)", () => {
  it("never redirects in dev mode", async () => {
    await withMode("dev", async () => null);
    expect(redirected(proxy(req("/")))).toBeNull();
  });

  it("entra: gates on the recall_session cookie", async () => {
    await withMode("entra", async () => null);
    expect(redirected(proxy(req("/notes/1")))).toBe("http://localhost:3000/sign-in");
    expect(redirected(proxy(req("/notes/1", "recall_session=t")))).toBeNull();
    // A Better Auth cookie means nothing in entra mode.
    expect(redirected(proxy(req("/", "better-auth.session_token=t")))).not.toBeNull();
  });

  it("betterauth: gates on the Better Auth session cookie", async () => {
    await withMode("betterauth", async () => null);
    expect(redirected(proxy(req("/")))).toBe("http://localhost:3000/sign-in");
    expect(redirected(proxy(req("/", "recall_session=t")))).not.toBeNull();
    expect(redirected(proxy(req("/", "better-auth.session_token=t")))).toBeNull();
    expect(
      redirected(proxy(req("/", "__Secure-better-auth.session_token=t"))),
    ).toBeNull();
  });

  it("keeps /api, /sign-in public in both gated modes", async () => {
    for (const mode of ["entra", "betterauth"]) {
      await withMode(mode, async () => null);
      expect(redirected(proxy(req("/api/me")))).toBeNull();
      expect(redirected(proxy(req("/sign-in")))).toBeNull();
    }
  });

  it("keeps OAuth discovery public in betterauth mode only", async () => {
    await withMode("betterauth", async () => null);
    expect(
      redirected(proxy(req("/.well-known/oauth-authorization-server"))),
    ).toBeNull();
    await withMode("entra", async () => null);
    expect(
      redirected(proxy(req("/.well-known/oauth-authorization-server"))),
    ).not.toBeNull();
  });

  it("clears the query on redirect", async () => {
    await withMode("betterauth", async () => null);
    expect(redirected(proxy(req("/graph?x=1")))).toBe("http://localhost:3000/sign-in");
  });
});
