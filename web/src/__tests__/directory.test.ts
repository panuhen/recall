import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { req, withMode } from "./helpers";

const searchDirectory = vi.fn(async (_q: string) => [
  { oid: "g1", upn: "graph@contoso.com", name: "From Graph" },
]);
vi.mock("@/lib/graph", () => ({ searchDirectory }));

const getSession = vi.fn();
vi.mock("@/lib/betterauth", () => ({
  getAuth: () => ({ api: { getSession } }),
}));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  getSession.mockReset();
  searchDirectory.mockClear();
});

const load = () => import("@/app/api/directory/search/route");

describe("GET /api/directory/search", () => {
  it("entra: 401 without a session, Graph with one", async () => {
    const { GET } = await withMode("entra", load);
    expect((await GET(req("/api/directory/search?q=ad"))).status).toBe(401);

    const { createSession, SESSION_COOKIE } = await import("@/lib/auth");
    const token = await createSession({ oid: "o", upn: "u@contoso.com", name: "U" });
    const res = await GET(req("/api/directory/search?q=ad", `${SESSION_COOKIE}=${token}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      results: [{ oid: "g1", upn: "graph@contoso.com", name: "From Graph" }],
    });
    expect(searchDirectory).toHaveBeenCalledWith("ad");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("betterauth: 401 without a session", async () => {
    const { GET } = await withMode("betterauth", load);
    getSession.mockResolvedValueOnce(null);
    expect((await GET(req("/api/directory/search?q=ad"))).status).toBe(401);
    expect(searchDirectory).not.toHaveBeenCalled();
  });

  it("betterauth: searches the backend's users as the signed-in user", async () => {
    vi.stubEnv("BACKEND_URL", "http://backend:8765");
    const { GET } = await withMode("betterauth", load);
    getSession.mockResolvedValueOnce({
      user: { id: "ba1", email: "me@example.com", name: "Me" },
    });
    const hit = { oid: "ba2", upn: "ada@example.com", name: "Ada" };
    fetchMock.mockResolvedValueOnce(Response.json({ results: [hit] }));

    const res = await GET(req("/api/directory/search?q=ad a"));
    expect(await res.json()).toEqual({ results: [hit] });
    expect(searchDirectory).not.toHaveBeenCalled();

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://backend:8765/api/users/search?q=ad%20a");
    const h = new Headers(init.headers);
    expect(h.get("x-user-id")).toBe("ba1");
    expect(h.get("x-user-upn")).toBe("me@example.com");
    expect(h.get("x-user-name")).toBe("Me");
  });

  it("betterauth: short queries and backend failures yield []", async () => {
    const { GET } = await withMode("betterauth", load);
    const user = { user: { id: "ba1", email: "me@example.com", name: "Me" } };

    getSession.mockResolvedValueOnce(user);
    expect(await (await GET(req("/api/directory/search?q=a"))).json()).toEqual({ results: [] });
    expect(fetchMock).not.toHaveBeenCalled();

    getSession.mockResolvedValueOnce(user);
    fetchMock.mockResolvedValueOnce(new Response("boom", { status: 500 }));
    expect(await (await GET(req("/api/directory/search?q=ada"))).json()).toEqual({ results: [] });

    getSession.mockResolvedValueOnce(user);
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await (await GET(req("/api/directory/search?q=ada"))).json()).toEqual({ results: [] });
  });

  it("dev: no session needed, delegates to searchDirectory", async () => {
    const { GET } = await withMode("dev", load);
    const res = await GET(req("/api/directory/search?q=ad"));
    expect(res.status).toBe(200);
    expect(searchDirectory).toHaveBeenCalledWith("ad");
    expect(getSession).not.toHaveBeenCalled();
  });
});
