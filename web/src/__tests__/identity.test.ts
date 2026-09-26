import { afterEach, describe, expect, it, vi } from "vitest";

import { req, withMode } from "./helpers";

const getSession = vi.fn();
let accessPolicy = { open: true, allowed: [] as string[] };
vi.mock("@/lib/betterauth", async (orig) => ({
  mayAccess: (await orig<typeof import("@/lib/betterauth")>()).mayAccess,
  currentAccessPolicy: () => accessPolicy,
  getAuth: () => ({ api: { getSession } }),
}));

afterEach(() => getSession.mockReset());

describe("resolveIdentity", () => {
  it("returns the stub user in dev mode without touching a session", async () => {
    const { resolveIdentity } = await withMode("dev", () => import("@/lib/identity"));
    const user = await resolveIdentity(req("/api/me"));
    expect(user).toEqual({
      id: "00000000-0000-0000-0000-000000000001",
      upn: "dev@example.com",
      name: "Dev User",
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("defaults to dev when AUTH_MODE is unset", async () => {
    const { resolveIdentity } = await withMode(undefined, () => import("@/lib/identity"));
    expect((await resolveIdentity(req("/api/me")))?.upn).toBe("dev@example.com");
  });

  it("reads the MSAL session cookie in entra mode", async () => {
    const { resolveIdentity } = await withMode("entra", () => import("@/lib/identity"));
    const { createSession, SESSION_COOKIE } = await import("@/lib/auth");
    const token = await createSession({
      oid: "11111111-2222-3333-4444-555555555555",
      upn: "ada@contoso.com",
      name: "Ada",
    });
    expect(await resolveIdentity(req("/api/me"))).toBeNull();
    expect(await resolveIdentity(req("/api/me", `${SESSION_COOKIE}=${token}`))).toEqual({
      id: "11111111-2222-3333-4444-555555555555",
      upn: "ada@contoso.com",
      name: "Ada",
    });
    expect(await resolveIdentity(req("/api/me", `${SESSION_COOKIE}=forged`))).toBeNull();
    expect(getSession).not.toHaveBeenCalled();
  });

  it("asks Better Auth in betterauth mode and ignores the MSAL cookie", async () => {
    const { resolveIdentity } = await withMode("betterauth", () => import("@/lib/identity"));
    getSession.mockResolvedValueOnce(null);
    expect(await resolveIdentity(req("/api/me", "recall_session=x"))).toBeNull();

    getSession.mockResolvedValueOnce({
      user: { id: "baUserId123", email: "Grace@Example.com", name: "Grace Hopper" },
      session: {},
    });
    const r = req("/api/me", "better-auth.session_token=abc");
    expect(await resolveIdentity(r)).toEqual({
      id: "baUserId123",
      upn: "grace@example.com",
      name: "Grace Hopper",
    });
    expect(getSession).toHaveBeenLastCalledWith({ headers: r.headers });
  });

  it("refuses a Better Auth session whose email left the access list", async () => {
    const { resolveIdentity } = await withMode("betterauth", () => import("@/lib/identity"));
    accessPolicy = { open: false, allowed: ["john@example.com"] };
    const session = (email: string) => ({ user: { id: "u", email, name: "N" }, session: {} });
    try {
      getSession.mockResolvedValueOnce(session("John@Example.com"));
      expect(await resolveIdentity(req("/api/me", "better-auth.session_token=a"))).toMatchObject({
        upn: "john@example.com",
      });
      getSession.mockResolvedValueOnce(session("bob@example.com"));
      expect(await resolveIdentity(req("/api/me", "better-auth.session_token=b"))).toBeNull();
    } finally {
      accessPolicy = { open: true, allowed: [] };
    }
  });

  it("identityHeaders carries the X-User-* contract", async () => {
    const { identityHeaders } = await withMode("dev", () => import("@/lib/identity"));
    const h = identityHeaders({ id: "u1", upn: "a@b.c", name: "A" });
    expect(h.get("x-user-id")).toBe("u1");
    expect(h.get("x-user-upn")).toBe("a@b.c");
    expect(h.get("x-user-name")).toBe("A");
  });
});
