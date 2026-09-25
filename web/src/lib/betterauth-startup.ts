import { runBetterAuthMigrations } from "@/lib/betterauth";

// Node-only half of instrumentation.ts, kept in its own module so the Edge
// bundle of the instrumentation hook never sees process.exit. Next only logs a
// rejected register() and keeps serving, so exit instead: a loud boot failure
// (bad secret, unreachable database) beats sign-in failing on first request.
export async function startBetterAuth(): Promise<void> {
  try {
    await runBetterAuthMigrations();
  } catch (err) {
    console.error("[better-auth] startup failed:", err);
    process.exit(1);
  }
}
