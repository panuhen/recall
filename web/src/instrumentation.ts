// Runs once when the Next.js server starts (never during `next build`). In
// betterauth mode it constructs Better Auth, which applies the
// BETTER_AUTH_SECRET boot guard, and creates or updates the ba_* tables with
// Better Auth's own migrator (see lib/betterauth-startup.ts). entra and dev
// modes never load Better Auth.
//
// Keep the NEXT_RUNTIME check as an `if` wrapping the import, not an early
// return: Next also compiles this file for the Edge runtime, and the bundler
// only drops the import (and with it `pg`, which needs Node's fs/net) when it
// sits inside a branch that is statically false there.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.AUTH_MODE !== "betterauth") return;
    const { startBetterAuth } = await import("@/lib/betterauth-startup");
    await startBetterAuth();
  }
}
