import { AUTH_MODE, getMsalClient, TENANT_ID } from "@/lib/auth";

// A directory match surfaced in the ShareDialog's people picker.
export type DirectoryHit = { oid: string; upn: string; name: string };

// The app-only Graph token, cached in-module until shortly before it expires
// (client-credentials tokens last ~1h). Reused across requests in this process.
let cachedToken: { value: string; expiresAt: number } | null = null;

async function graphToken(): Promise<string | null> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  try {
    const res = await getMsalClient().acquireTokenByClientCredential({
      scopes: ["https://graph.microsoft.com/.default"],
    });
    if (!res?.accessToken) return null;
    cachedToken = {
      value: res.accessToken,
      expiresAt: res.expiresOn?.getTime() ?? Date.now() + 3_000_000,
    };
    return cachedToken.value;
  } catch {
    return null;
  }
}

// Search the org directory (name or email) for the invite picker, app-only via
// the configured Entra app registration. Returns [] in dev, when the app lacks
// the Graph User.ReadBasic.All permission, or on any error — the dialog always
// falls back to free-typing a full email address.
export async function searchDirectory(query: string): Promise<DirectoryHit[]> {
  const q = query.trim();
  if (AUTH_MODE === "dev" || !TENANT_ID || q.length < 2) return [];

  const token = await graphToken();
  if (!token) return [];

  // Strip quotes/backslashes so they can't break the quoted $search term, which
  // matches across displayName + mail (requires ConsistencyLevel: eventual).
  const safe = q.replace(/["\\]/g, " ");
  const search = encodeURIComponent(`"displayName:${safe}" OR "mail:${safe}"`);
  const select = encodeURIComponent("id,displayName,userPrincipalName,mail");
  const url =
    `https://graph.microsoft.com/v1.0/users?$search=${search}` +
    `&$select=${select}&$top=8`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: "eventual" },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      value?: {
        id: string;
        displayName?: string;
        userPrincipalName?: string;
        mail?: string;
      }[];
    };
    return (data.value ?? [])
      .map((u) => ({
        oid: u.id,
        upn: (u.mail || u.userPrincipalName || "").toLowerCase(),
        name: u.displayName || u.userPrincipalName || "",
      }))
      .filter((h) => h.upn);
  } catch {
    return [];
  }
}
