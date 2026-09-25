# re:call

A self-hostable corporate "second brain" — an Obsidian-like markdown notes app with
semantic search, backlinks, and a knowledge graph, behind Entra ID (MSAL) SSO or Google
sign-in (Better Auth), with a first-class MCP interface so AI assistants read the same notes people write for each other.

> Your team's knowledge base is also your AI's memory.

## Features

- **Markdown notes** — a CodeMirror editor with live preview, wiki-style `[[links]]`,
  tags, and frontmatter properties, plus a clean reading view for consumption.
- **Workspaces & folders** — notes live in shared workspaces, organized into nested
  folders. Favorites and pinning keep the important things one click away.
- **Backlinks & graph** — every `[[link]]` is a two-way connection; a force-directed
  knowledge graph shows how notes relate across a workspace.
- **Diagrams** — ` ```mermaid ` fenced blocks render inline in both the editor and the
  reading view (flowchart, sequence, class, state, ER, gantt, mindmap, and more).
- **Semantic + keyword search** — find notes by meaning (Azure OpenAI embeddings +
  pgvector) or by exact text, from a fast command-palette dialog.
- **Sharing & roles** — invite teammates straight into a workspace under flat
  Viewer / Editor / Owner roles, plus org-wide workspaces for shared knowledge.
- **Version history** — saves snapshot revisions you can browse, diff, and restore.
- **Trash & retention** — deletes are soft and restorable, with optional scheduled
  auto-purge.
- **MCP interface** — ~35 tools (read/write notes, search, graph, organize, share,
  history, diagram validation) over Streamable HTTP, so Claude, Copilot, and other
  assistants work against the same data with the user's own identity (browser
  OAuth consent, no PATs).
- **Sign-in** — single-tenant Entra ID (MSAL) for M365 organizations, or Google via
  Better Auth for everyone else, through a Next.js BFF; a `dev` auth mode injects a
  stub user for local work.
- **Export** — download a workspace or folder as a zip of standard markdown files.
- **Installable PWA** — a web manifest and icons let the app install to the home
  screen and launch standalone, with a mobile-friendly, responsive UI throughout.

## Stack

- **Frontend:** Next.js 16 (App Router) + React 19 + shadcn/ui + Tailwind CSS v4, IBM Plex
  type, CodeMirror editing, react-markdown reading, react-force-graph-2d graph, Mermaid diagrams
- **Backend:** Python 3.12 + FastMCP — serves both REST `/api` and MCP `/mcp` from one app
- **Database:** PostgreSQL 16 + pgvector
- **Migrations:** Alembic · **Background jobs:** procrastinate
- **Embeddings:** Azure OpenAI `text-embedding-3-large` @ 1536 dims (no local model)
- **Auth:** MSAL / Entra ID (single-tenant) or Better Auth (Google). Local dev runs a stub
  user via `AUTH_MODE=dev`.

## Quick start (local, Docker)

```bash
cp .env.example .env      # already present for local dev
docker compose up -d      # postgres + backend + worker + web
```

| Service | URL / port |
|---|---|
| Web UI | http://localhost:3000 |
| Backend health | http://localhost:8004/health |
| MCP endpoint | http://localhost:8004/mcp |
| PostgreSQL | localhost:54324 (user/pass/db: `recall`) |

Local dev defaults to `AUTH_MODE=dev` (stub user, open MCP), so nothing external is
required to start. To exercise real SSO, MCP OAuth, and embeddings, set `AUTH_MODE=entra`
and fill in the Entra and Azure OpenAI values in `.env`, or use `AUTH_MODE=betterauth`
(below).

### Auth modes

`AUTH_MODE` picks one identity provider for the whole instance, web UI and MCP alike.

| Mode | For | Web sign-in | MCP (`/mcp`) auth |
|---|---|---|---|
| `entra` | An M365 / Entra ID organization | Microsoft (MSAL, single-tenant) | FastMCP `AzureProvider` OAuth proxy against your Entra app, plus delegated Entra tokens (below) |
| `betterauth` | Everyone else | Google, via [Better Auth](https://www.better-auth.com) in the web app | Better Auth is the OAuth 2.1 authorization server (dynamic client registration); the backend validates its access tokens |
| `dev` | Local only | None: a fixed stub user | Open, stub user |

Nothing Better Auth-related loads, or touches the database, unless
`AUTH_MODE=betterauth`. In `betterauth` mode, "org-wide" workspaces (`org_access =
viewer`) are visible to every signed-in user of the instance, since there is no tenant
to scope them to.

### Better Auth setup (`AUTH_MODE=betterauth`)

It runs on two public hosts: the web app (for example `https://recall.rapu.ai`), which
is also the OAuth issuer, and the backend's MCP endpoint (for example
`https://recall-mcp.rapu.ai`). MCP clients connect to `https://recall-mcp.rapu.ai/mcp`,
get a `401` pointing at its protected-resource metadata, and from there find Better
Auth on the web host to register and sign in.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), create
   an OAuth client ID of type *Web application*. Add the authorized redirect URI
   `{BETTER_AUTH_URL}/api/auth/callback/google`, e.g.
   `https://recall.rapu.ai/api/auth/callback/google` (or
   `http://localhost:3000/api/auth/callback/google` locally).
2. Set in `.env` (see the Better Auth block in `.env.example`):
   - `AUTH_MODE=betterauth`
   - `BETTER_AUTH_URL`: the public web origin, no trailing slash. Better Auth uses it
     verbatim as the issuer, and the backend advertises it byte for byte.
   - `BETTER_AUTH_SECRET`: `openssl rand -base64 32`. The web app refuses to start on
     an `https` origin with this empty or left at the dev placeholder.
   - `BETTER_AUTH_INTERNAL_URL`: where the backend reaches the web app to validate
     tokens (`http://web:3000` in compose; defaults to `BETTER_AUTH_URL`).
   - `MCP_PUBLIC_URL`: the MCP host, and add that host to `MCP_ALLOWED_HOSTS`.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` from step 1.
   - `BETTER_AUTH_SIGNUP`: `open` (default) lets any Google account register; `closed`
     admits only `BETTER_AUTH_ALLOWED_EMAILS`, a comma-separated list of addresses or
     `@domain` suffixes. The gate applies when an account is first created, so existing
     users keep signing in. A blocked sign-up lands back on `/sign-in` with a
     "Registration is closed" message.
3. The web app needs `DATABASE_URL` too. At startup it creates its own `ba_*` tables
   (`ba_user`, `ba_session`, `ba_oauth_application`, …) in recall's database, and exits
   if that fails.

A signed-in user's recall identity is their Better Auth user id, with Google's email
and name. The people picker searches recall's own users instead of a directory.

### MCP client config

```json
{ "mcpServers": { "recall": { "type": "http", "url": "http://localhost:8004/mcp" } } }
```

### MCP callers in `AUTH_MODE=entra`

Two kinds of caller can reach `/mcp`, and both act **as a signed-in user** — re:call
applies that user's workspace roles and records them as the author. There is no
service-account or API-key path.

| Caller | How it authenticates | Setup |
|---|---|---|
| Desktop / IDE assistants (Claude Desktop, Cursor, VS Code, …) | Standard MCP OAuth: the client discovers the server's metadata and the user signs in through a browser consent screen. FastMCP's `AzureProvider` proxies the flow against your Entra app. | Nothing beyond the Entra values in `.env`. |
| A backend that already holds the user's identity (an agent platform, a chat host, an automation server) | Presents a **delegated Entra access token** for this API directly as `Authorization: Bearer …`. The backend obtains it with the [On-Behalf-Of flow](https://learn.microsoft.com/entra/identity-platform/v2-oauth2-on-behalf-of-flow), exchanging the user's own token for one audienced to `api://<your-client-id>`. Validated against the tenant's JWKS; requires the app's `access` scope (or whatever `MCP_SCOPES` lists) in `scp`. | In Entra, the calling app needs the delegated permission `api://<your-client-id>/access` on this app, admin-consented. If the backend and re:call share one app registration, the backend's own user token already satisfies the verifier and no exchange is needed. |

Quick check of the second mode with a token you hold yourself:

```bash
TOKEN=$(az account get-access-token --resource api://<your-client-id> --query accessToken -o tsv)
curl -sS https://<your-recall-host>/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A `200` with a server description means the token was accepted as you. Tokens minted for
another audience, without the scope, or app-only (client-credentials) tokens are rejected.

## Deployment

Copy `infra/provision.example.sh` to `infra/provision.sh`, fill in its CONFIG block, and
run it to provision the stack on **Azure Container Apps** (MCP backend,
web BFF, worker, Postgres Flexible + pgvector, and Key Vault for secrets). CI/CD: copy
[`azure-pipelines.example.yml`](azure-pipelines.example.yml) to `azure-pipelines.yml`; it rebuilds both images and rolls out the new
tag on every push to `main`. See [`infra/README.md`](infra/README.md) for the full
resource list, required secrets, and gotchas.
