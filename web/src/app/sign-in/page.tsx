import { connection } from "next/server";

import { AuthShell } from "@/components/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import { AUTH_MODE } from "@/lib/auth";
import { cn } from "@/lib/utils";

import { GoogleSignIn } from "./google-sign-in";

// Mode-aware sign-in: Microsoft (MSAL) in entra, Google (Better Auth) in
// betterauth. In betterauth it doubles as the MCP OAuth login page, reached
// with the authorize query intact (see GoogleSignIn).
export default async function SignInPage() {
  // AUTH_MODE is a runtime setting; never prerender this page at build.
  await connection();

  return (
    <AuthShell>
      {AUTH_MODE === "betterauth" ? (
        <GoogleSignIn
          enabled={Boolean(
            process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
          )}
        />
      ) : AUTH_MODE === "entra" ? (
        <a
          href="/api/auth/signin"
          className={cn(buttonVariants({ size: "lg" }), "mt-8")}
        >
          Log in with Microsoft
        </a>
      ) : (
        // Dev mode is always signed in as the stub user.
        <a href="/" className={cn(buttonVariants({ size: "lg" }), "mt-8")}>
          Continue as dev user
        </a>
      )}
    </AuthShell>
  );
}
