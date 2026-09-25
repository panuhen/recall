import { getAuthTables } from "better-auth/db";
import { afterEach, describe, expect, it, vi } from "vitest";

const poolCtor = vi.fn();
vi.mock("pg", async (orig) => {
  const actual = await orig<typeof import("pg")>();
  class Pool extends actual.Pool {
    constructor(config?: import("pg").PoolConfig) {
      super(config);
      poolCtor(config);
    }
  }
  return { ...actual, default: { ...actual, Pool }, Pool };
});

afterEach(() => poolCtor.mockReset());

async function fresh() {
  vi.resetModules();
  return import("@/lib/betterauth");
}

describe("boot guard", () => {
  it("requires BETTER_AUTH_URL", async () => {
    const { assertBetterAuthEnv } = await fresh();
    expect(() => assertBetterAuthEnv({})).toThrow(/BETTER_AUTH_URL/);
  });

  it("refuses an https origin with an empty or placeholder secret", async () => {
    const { assertBetterAuthEnv, DEV_SECRET_PLACEHOLDER } = await fresh();
    const url = "https://recall.example.com";
    expect(() => assertBetterAuthEnv({ BETTER_AUTH_URL: url })).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      assertBetterAuthEnv({ BETTER_AUTH_URL: url, BETTER_AUTH_SECRET: DEV_SECRET_PLACEHOLDER }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      assertBetterAuthEnv({ BETTER_AUTH_URL: url, BETTER_AUTH_SECRET: "a-real-32-byte-secret-value-here!!" }),
    ).not.toThrow();
  });

  it("allows the placeholder on plain-http localhost", async () => {
    const { assertBetterAuthEnv } = await fresh();
    expect(() => assertBetterAuthEnv({ BETTER_AUTH_URL: "http://localhost:3000" })).not.toThrow();
  });

  it("getAuth() applies the guard", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://recall.example.com");
    vi.stubEnv("BETTER_AUTH_SECRET", "");
    const { getAuth } = await fresh();
    expect(() => getAuth()).toThrow(/BETTER_AUTH_SECRET/);
    expect(poolCtor).not.toHaveBeenCalled();
  });
});

describe("Better Auth instance", () => {
  it("is lazy: importing the module opens no pool", async () => {
    await fresh();
    expect(poolCtor).not.toHaveBeenCalled();
  });

  it("names every table with the ba_ prefix", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    vi.stubEnv("DATABASE_URL", "postgresql://x:y@127.0.0.1:1/none");
    const { getAuth } = await fresh();
    const auth = getAuth();
    expect(poolCtor).toHaveBeenCalledTimes(1);
    expect(getAuth()).toBe(auth);

    const tables = Object.values(getAuthTables(auth.options)).map((t) => t.modelName);
    expect(tables.sort()).toEqual(
      [
        "ba_account",
        "ba_oauth_access_token",
        "ba_oauth_application",
        "ba_oauth_consent",
        "ba_rate_limit",
        "ba_session",
        "ba_user",
        "ba_verification",
      ].sort(),
    );
  });

  it("advertises BETTER_AUTH_URL verbatim as the issuer (no trailing slash)", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000/");
    vi.stubEnv("DATABASE_URL", "postgresql://x:y@127.0.0.1:1/none");
    const { getAuth } = await fresh();
    const res = await getAuth().handler(
      new Request("http://localhost:3000/api/auth/.well-known/oauth-authorization-server"),
    );
    const meta = (await res.json()) as Record<string, string>;
    expect(meta.issuer).toBe("http://localhost:3000");
    expect(meta.registration_endpoint).toBe("http://localhost:3000/api/auth/mcp/register");
  });

  it("offers Google only when both credentials are set", async () => {
    vi.stubEnv("BETTER_AUTH_URL", "http://localhost:3000");
    const { buildOptions } = await fresh();
    const { Pool } = await import("pg");
    expect(buildOptions(new Pool()).socialProviders).toBeUndefined();
    vi.stubEnv("GOOGLE_CLIENT_ID", "id");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "secret");
    const opts = buildOptions(new Pool());
    expect(opts.socialProviders?.google.clientId).toBe("id");
    // No email/password sign-in.
    expect("emailAndPassword" in opts).toBe(false);
  });
});

describe("sign-up policy", () => {
  it("defaults to open", async () => {
    const { signupPolicy, maySignUp } = await fresh();
    const policy = signupPolicy({});
    expect(policy.open).toBe(true);
    expect(maySignUp(policy, "anyone@example.com")).toBe(true);
  });

  it("closed admits only listed addresses and @domain suffixes", async () => {
    const { signupPolicy, maySignUp } = await fresh();
    const policy = signupPolicy({
      BETTER_AUTH_SIGNUP: "closed",
      BETTER_AUTH_ALLOWED_EMAILS: " Owner@Example.com , @rapu.ai ,",
    });
    expect(maySignUp(policy, "owner@example.com")).toBe(true);
    expect(maySignUp(policy, "OWNER@example.com")).toBe(true);
    expect(maySignUp(policy, "someone@rapu.ai")).toBe(true);
    expect(maySignUp(policy, "other@example.com")).toBe(false);
    // A suffix match needs the @: "evilrapu.ai" is not in @rapu.ai.
    expect(maySignUp(policy, "x@evilrapu.ai")).toBe(false);
  });

  it("closed with no list admits nobody", async () => {
    const { signupPolicy, maySignUp } = await fresh();
    expect(maySignUp(signupPolicy({ BETTER_AUTH_SIGNUP: "closed" }), "a@b.c")).toBe(false);
  });

  it("rejects an unknown mode", async () => {
    const { signupPolicy } = await fresh();
    expect(() => signupPolicy({ BETTER_AUTH_SIGNUP: "invite" })).toThrow(/BETTER_AUTH_SIGNUP/);
  });

  it("the user-create hook refuses a sign-up outside the policy", async () => {
    vi.stubEnv("BETTER_AUTH_SIGNUP", "closed");
    vi.stubEnv("BETTER_AUTH_ALLOWED_EMAILS", "owner@example.com");
    const { buildOptions } = await fresh();
    const before = buildOptions({} as import("pg").Pool).databaseHooks.user.create.before;
    const user = (email: string) => ({ email }) as Parameters<typeof before>[0];
    await expect(before(user("owner@example.com"))).resolves.toBeUndefined();
    await expect(before(user("stranger@example.com"))).rejects.toMatchObject({
      message: "signup disabled",
    });
  });
});
