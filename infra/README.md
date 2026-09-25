# infra — Azure Container Apps

Provisions recall onto **Azure Container Apps**. Copy `provision.example.sh` to
`provision.sh`, fill in the CONFIG block (subscription, resource group,
globally-unique names, Entra app, Azure OpenAI endpoint), then run it from the
repo root.

| Resource | Example name | Notes |
|---|---|---|
| Container Registry | `recallacr` | Basic; **admin user enabled** for image pulls (ACR names allow no hyphens) |
| Managed identity | `recall-id` | Key Vault read (via access policy) |
| Key Vault | `recall-kv` | **access-policy mode**; holds DB URL + secrets |
| Postgres Flexible | `recall-pg` | B1ms, PG16, pgvector, public + firewall |
| Container Apps env | `recall-env` | |
| MCP backend | `recall-mcp` | public `:8765`, `AUTH_MODE=entra` |
| Web BFF | `recall-web` | public `:3000`, MSAL |
| Worker | `recall-worker` | background, no ingress |

Embeddings use `text-embedding-3-large` @ 1536 dims on your Azure OpenAI
resource. All apps run **min-replicas = 1** (always-on, no cold starts).

## Run

```bash
cp infra/provision.example.sh infra/provision.sh    # then edit the CONFIG block
export AZURE_CLIENT_SECRET='<your Entra app client secret>'
export AZURE_OPENAI_API_KEY='<your embeddings key>'
bash infra/provision.sh
```

Requires `az login` and Azure CLI ≥ 2.77. Cloud-builds the images, so no local
Docker is needed. Takes ~15 min (Postgres is the slow part).

## Notes / gotchas

- **Idempotent + retry-wrapped** — safe to re-run: existing resources are
  skipped and transient ARM errors are retried. Tear down with
  `az group delete -n <your-rg>`.
- **No role assignments needed** — image pulls use the ACR admin credential and
  the app reads Key Vault via an access policy, so the script works even where
  you lack rights to create role assignments. If you can create them, the
  cleaner path is a managed identity with `AcrPull` + `Key Vault Secrets User`.
- **Globally-unique names** (ACR, Key Vault, Postgres) — if one is taken, change
  the prefix at the top of `provision.sh`.
- **Entra redirect URI** — the script tries to register the web callback on the
  app registration; if you lack rights it prints the URL to add by hand.
- **`sslmode=require`** is set on `DATABASE_URL` (Azure enforces TLS).
- **Embedding dims** — 3-large is requested at 1536 (Matryoshka) to stay under
  pgvector's 2000-dim HNSW limit. The embedding call must send `dimensions=1536`.
- **MCP OAuth state is in Postgres** (`mcp_oauth_kv`, Fernet-encrypted; see
  `src/oauth_storage.py`) — client registrations, in-flight consent/token
  transactions, and token metadata are shared across replicas and survive
  deploys, so the MCP app can safely run multiple replicas. Rotating
  `AZURE_CLIENT_SECRET` (the encryption-key material) invalidates the state and
  clients re-consent on next use. A daily worker task sweeps expired rows.
- **Logs** — the template creates the env with `--logs-destination none` to
  avoid requiring a Log Analytics workspace. Live logs still work via
  `az containerapp logs show -g <your-rg> -n <app> --follow`; attach a workspace
  to persist them.
- **Windows ACR build** — `az acr build` can crash streaming logs on Windows
  (cp1252); the script tolerates it and polls run status instead. Also, `-f` is
  relative to the CWD, so the web image uses `-f web/Dockerfile`.
- **Cost** ≈ €40–55/mo (Postgres B1ms + always-on replicas + ACR Basic).

## CI/CD (Azure DevOps → Container Apps)

`../azure-pipelines.example.yml` is a template: copy it to `azure-pipelines.yml`
in the repo your Azure DevOps project builds from. It builds both images in ACR and rolls the new tag out to
the three container apps on every push to `main`, gated behind a Test stage
(lint + typecheck + tests). Set the pipeline `variables` (service connection,
resource group, ACR name, app names) to your own — either in the YAML or as
Azure DevOps pipeline variables.

1. **Grant the service connection's SP `Contributor` on the resource group**
   (covers `az acr build` + `az containerapp update`).
2. **Register the pipeline** pointing at your `/azure-pipelines.yml`.
3. **Authorize** the pipeline to use the service connection on its first run,
   and approve creating the deployment Environment. Add approvals/gates on that
   Environment later if desired.

Rollback = re-run the pipeline at an older commit, or
`az containerapp update -g <your-rg> -n <app> --image <acr>/<repo>:<oldBuildId>`.
