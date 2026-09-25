"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

import { AuthShell } from "@/components/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// OAuth consent for MCP connections (betterauth mode). Better Auth sends the
// user here after sign-in with consent_code / client_id / scope in the query
// (mcp() oidcConfig.consentPage in lib/betterauth.ts). Allow POSTs the consent
// code back and follows the returned redirect to finish the OAuth hand-off;
// Deny returns access_denied to the client.
function ConsentInner() {
  const params = useSearchParams();
  const clientId = params.get("client_id") ?? "";
  const consentCode = params.get("consent_code") ?? "";

  const [clientName, setClientName] = useState("An application");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The client's self-reported name from its dynamic registration. A failure
  // keeps the generic label and never blocks the decision.
  useEffect(() => {
    if (!clientId) return;
    fetch(`/api/auth/mcp/client-info?client_id=${encodeURIComponent(clientId)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.name) setClientName(data.name);
      })
      .catch(() => {});
  }, [clientId]);

  async function decide(accept: boolean) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accept, consent_code: consentCode }),
      });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { redirectURI?: string };
      // A full navigation: the redirect leaves this origin for the client.
      if (data.redirectURI) {
        window.location.href = data.redirectURI;
        return;
      }
      throw new Error();
    } catch {
      setError("Couldn't complete the connection. Start again from your AI client.");
      setPending(false);
    }
  }

  return (
    <AuthShell>
      <div className="mt-8 w-72 text-center sm:w-80">
        <p className="text-base">
          <span className="font-semibold">{clientName}</span> wants to connect
          to your re:call account.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          It will be able to search, read and write the notes you have access
          to, with your permissions.
        </p>

        {error && (
          <p className="mt-4 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => decide(true)}
            disabled={pending || !consentCode}
            className={cn(buttonVariants({ size: "lg" }), "w-full")}
          >
            {pending ? "Connecting…" : "Allow"}
          </button>
          <button
            type="button"
            onClick={() => decide(false)}
            disabled={pending || !consentCode}
            className={cn(
              buttonVariants({ size: "lg", variant: "outline" }),
              "w-full",
            )}
          >
            Deny
          </button>
        </div>
      </div>
    </AuthShell>
  );
}

export default function ConsentPage() {
  return (
    <Suspense>
      <ConsentInner />
    </Suspense>
  );
}
