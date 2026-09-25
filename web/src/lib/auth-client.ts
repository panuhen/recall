import { createAuthClient } from "better-auth/react";

// Browser client for Better Auth (betterauth mode only). Same-origin, default
// basePath /api/auth.
export const authClient = createAuthClient();
