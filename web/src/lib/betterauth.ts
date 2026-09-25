import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { mcp } from "better-auth/plugins";
import { Pool } from "pg";

// Better Auth identity mode (AUTH_MODE=betterauth): Google sign-in for the web
// UI, and the OAuth 2.1 authorization server (with dynamic client
// registration) for MCP clients. The Python backend is a resource server that
// validates MCP access tokens against /api/auth/mcp/get-session.
//
// Everything here is lazy: nothing is constructed, and no Postgres pool is
// opened, until getAuth() is first called. entra and dev deployments never
// call it, so they need neither a database connection from the web tier nor
// any BETTER_AUTH_* variable. Other modules import this file dynamically
// (await import) for the same reason.

// BETTER_AUTH_SECRET signs session cookies and OAuth artifacts; a weak or
// public value means any session can be forged. The placeholder is fine on
// http://localhost and catastrophic on a real origin, so refuse to start when
// the public origin is https and the secret is missing or still the
// placeholder.
export const DEV_SECRET_PLACEHOLDER = "dev-only-secret-change-in-production-0000";

export function assertBetterAuthEnv(
  env: Record<string, string | undefined> = process.env,
): void {
  const url = env.BETTER_AUTH_URL ?? "";
  const secret = env.BETTER_AUTH_SECRET ?? "";
  if (!url) {
    throw new Error("BETTER_AUTH_URL must be set when AUTH_MODE=betterauth");
  }
  if (
    url.startsWith("https://") &&
    (secret === "" || secret === DEV_SECRET_PLACEHOLDER)
  ) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set to a real secret when BETTER_AUTH_URL is https",
    );
  }
}

// Who may create an account. BETTER_AUTH_SIGNUP=open (the default) lets any
// Google account register; closed admits only BETTER_AUTH_ALLOWED_EMAILS, a
// comma-separated list of addresses or "@domain" suffixes. The gate runs only
// when a user is first created: existing accounts keep signing in either way.
export type SignupPolicy = { open: boolean; allowed: string[] };

export function signupPolicy(
  env: Record<string, string | undefined> = process.env,
): SignupPolicy {
  const mode = (env.BETTER_AUTH_SIGNUP ?? "open").trim().toLowerCase() || "open";
  if (mode !== "open" && mode !== "closed") {
    throw new Error(`BETTER_AUTH_SIGNUP must be "open" or "closed", got "${mode}"`);
  }
  const allowed = (env.BETTER_AUTH_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return { open: mode === "open", allowed };
}

export function maySignUp(policy: SignupPolicy, email: string): boolean {
  if (policy.open) return true;
  const e = email.trim().toLowerCase();
  return policy.allowed.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a));
}

// Every Better Auth table lives in recall's own database under a ba_ prefix,
// so it can't collide with recall's tables (recall already has `users`). The
// backend reads ba_user by id to resolve an MCP token's email and name.
export const BA_MODEL_NAMES = {
  user: "ba_user",
  session: "ba_session",
  account: "ba_account",
  verification: "ba_verification",
  rateLimit: "ba_rate_limit",
  oauthApplication: "ba_oauth_application",
  oauthAccessToken: "ba_oauth_access_token",
  oauthConsent: "ba_oauth_consent",
} as const;

// The mcp() plugin (better-auth 1.6) returns the oidc-provider schema as-is and
// ignores oidcConfig.schema, so its tables can't be renamed through options.
// Re-key the plugin's own schema instead: the adapter maps the logical model
// ("oauthApplication") to whatever modelName the schema carries, including in
// foreign-key references.
function mcpPlugin() {
  const plugin = mcp({
    loginPage: "/sign-in",
    oidcConfig: {
      loginPage: "/sign-in",
      // The interstitial a connecting MCP client is sent to after sign-in when
      // it asks for consent. Better Auth redirects here with consent_code /
      // client_id / scope in the query.
      consentPage: "/consent",
      // Remote MCP clients (Claude.ai among them) self-register via RFC 7591;
      // without this the MCP surface is unreachable.
      allowDynamicClientRegistration: true,
      storeClientSecret: "hashed",
    },
  });
  const s = plugin.schema;
  return {
    ...plugin,
    schema: {
      oauthApplication: {
        ...s.oauthApplication,
        modelName: BA_MODEL_NAMES.oauthApplication,
      },
      oauthAccessToken: {
        ...s.oauthAccessToken,
        modelName: BA_MODEL_NAMES.oauthAccessToken,
      },
      oauthConsent: {
        ...s.oauthConsent,
        modelName: BA_MODEL_NAMES.oauthConsent,
      },
    },
  };
}

// Better Auth uses this as the OAuth issuer verbatim, and the backend's
// protected-resource metadata must match it byte for byte: no trailing slash.
function baseURL(): string {
  return (process.env.BETTER_AUTH_URL ?? "").replace(/\/+$/, "");
}

export function buildOptions(pool: Pool) {
  const base = baseURL();
  const policy = signupPolicy();
  // Google sign-in, offered only when its credentials are configured. recall
  // keeps Google's real name and email: invitations, membership and
  // authorship are keyed on them.
  const socialProviders =
    process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
      ? {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined;

  return {
    appName: "re:call",
    baseURL: base,
    secret: process.env.BETTER_AUTH_SECRET || DEV_SECRET_PLACEHOLDER,
    trustedOrigins: [base],
    database: pool,
    socialProviders,
    user: { modelName: BA_MODEL_NAMES.user },
    session: { modelName: BA_MODEL_NAMES.session },
    verification: { modelName: BA_MODEL_NAMES.verification },
    account: {
      modelName: BA_MODEL_NAMES.account,
      // One email is one person: link a second Google sign-in to the existing
      // user instead of the default account_not_linked refusal. Google verifies
      // email ownership, so trusting it is safe.
      accountLinking: {
        enabled: true,
        trustedProviders: ["google"],
      },
    },
    // Better Auth's own limiter, persisted to Postgres so the limit holds
    // across restarts and instances. Active in production only (the default).
    // The custom rules tighten sign-in and client registration well below the
    // 100-requests-per-window global default.
    rateLimit: {
      storage: "database",
      modelName: BA_MODEL_NAMES.rateLimit,
      customRules: {
        "/sign-in/social": { window: 60, max: 10 },
        "/mcp/register": { window: 60, max: 10 },
        "/mcp/token": { window: 60, max: 30 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Better Auth turns this message into the OAuth callback's
          // ?error=signup_disabled, the same code as its own disableSignUp.
          before: async (user) => {
            if (!maySignUp(policy, user.email)) {
              throw new APIError("FORBIDDEN", { message: "signup disabled" });
            }
          },
        },
      },
    },
    plugins: [mcpPlugin()],
  } satisfies BetterAuthOptions;
}

function createAuth() {
  assertBetterAuthEnv();
  signupPolicy(); // fail at boot on a bad BETTER_AUTH_SIGNUP, not at first sign-up
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return betterAuth(buildOptions(pool));
}

export type Auth = ReturnType<typeof createAuth>;

let _auth: Auth | null = null;

export function getAuth(): Auth {
  if (!_auth) _auth = createAuth();
  return _auth;
}

// Create or alter the ba_* tables with Better Auth's own migrator. Called once
// at server start (instrumentation.ts), only in betterauth mode.
export async function runBetterAuthMigrations(): Promise<void> {
  const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
    getAuth().options,
  );
  if (toBeCreated.length === 0 && toBeAdded.length === 0) return;
  await runMigrations();
  console.log(
    `[better-auth] migrated: created ${toBeCreated.map((t) => t.table).join(", ") || "none"}; ` +
      `altered ${toBeAdded.map((t) => t.table).join(", ") || "none"}`,
  );
}
