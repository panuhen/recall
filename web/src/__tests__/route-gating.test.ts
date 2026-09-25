import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import { req, withMode } from "./helpers";

// No network: MSAL builds a fixed auth URL, Better Auth answers every call.
vi.mock("@azure/msal-node", () => ({
  ConfidentialClientApplication: class {
    async getAuthCodeUrl() {
      return "https://login.microsoftonline.com/t/oauth2/v2.0/authorize";
    }
  },
}));
const handler = vi.fn(async () => new Response("better-auth", { status: 200 }));
vi.mock("@/lib/betterauth", () => ({
  getAuth: () => ({
    handler,
    api: {
      getMcpOAuthConfig: async () => ({ issuer: "http://localhost:3000" }),
      getMCPProtectedResource: async () => ({ resource: "http://localhost:3000" }),
    },
    $context: Promise.resolve({ adapter: { findOne: async () => ({ name: "Claude" }) } }),
  }),
}));

type Handler = (req: NextRequest) => Promise<Response>;

const MSAL: Record<string, () => Promise<{ GET: Handler }>> = {
  "/api/auth/signin": () => import("@/app/api/auth/signin/route"),
  "/api/auth/callback": () => import("@/app/api/auth/callback/route"),
  "/api/auth/signout": () => import("@/app/api/auth/signout/route"),
};

const BETTER_AUTH: Record<string, () => Promise<{ GET: Handler }>> = {
  "/api/auth/get-session": () => import("@/app/api/auth/[...all]/route"),
  "/.well-known/oauth-authorization-server": () =>
    import("@/app/.well-known/oauth-authorization-server/route"),
  "/.well-known/oauth-protected-resource": () =>
    import("@/app/.well-known/oauth-protected-resource/route"),
  "/api/auth/mcp/client-info?client_id=c": () =>
    import("@/app/api/auth/mcp/client-info/route"),
};

async function status(mode: string, path: string, load: () => Promise<{ GET: Handler }>) {
  const { GET } = await withMode(mode, load);
  return (await GET(req(path))).status;
}

describe("route gating by AUTH_MODE", () => {
  for (const [path, load] of Object.entries(MSAL)) {
    it(`${path} is live only in entra mode`, async () => {
      expect(await status("entra", path, load)).not.toBe(404);
      expect(await status("betterauth", path, load)).toBe(404);
      expect(await status("dev", path, load)).toBe(404);
    });
  }

  for (const [path, load] of Object.entries(BETTER_AUTH)) {
    it(`${path} is live only in betterauth mode`, async () => {
      expect(await status("betterauth", path, load)).toBe(200);
      expect(await status("entra", path, load)).toBe(404);
      expect(await status("dev", path, load)).toBe(404);
    });
  }

  it("the Better Auth catch-all forwards POSTs in betterauth mode only", async () => {
    const load = () => import("@/app/api/auth/[...all]/route");
    const post = async (mode: string) => {
      const { POST } = await withMode(mode, load);
      return (await POST(req("/api/auth/sign-out"))).status;
    };
    handler.mockClear();
    expect(await post("entra")).toBe(404);
    expect(handler).not.toHaveBeenCalled();
    expect(await post("betterauth")).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
