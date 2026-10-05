# Chatwoot (self-hosted) for fazer.ai

The inbox fazer.ai agents plugs into. The onboarding installs Chatwoot as part of the journey, in one of
**two editions**, chosen by whether the operator has a subscription on the fazer.ai hub:

| Edition | Image | When | Extra features |
| --- | --- | --- | --- |
| **Pro** | `harbor.fazer.ai/chatwoot/fazer-ai/chatwoot-pro` (private Harbor) | operator **has a hub license** | Kanban (+ other Pro-image features) |
| **OSS** | `ghcr.io/fazer-ai/chatwoot` (our public fork) | **no** hub subscription | standard Chatwoot + WhatsApp (native) |

**Both editions work with fazer.ai agents**: the integration is the standard Chatwoot Agent Bot + API
(see `docs/chatwoot.md`). OSS is **not** a downgrade of compatibility, only of
Pro-exclusive features (Kanban). WhatsApp (native) ships in **both** editions.

**Edition source (in order).** The onboarding CLI captures the operator's choice up front and writes it to
`~/.fazer-ai/onboarding.json` (`{ "chatwootTier": "pro" | "community", "chatwootLicenseId": "<id>" }`).
Read that marker **first**: `"pro"` → deploy the Pro image and license it at step 9b (use
`chatwootLicenseId`); `"community"` → deploy OSS (the operator deliberately chose to skip Pro). Only if the
marker is **absent** (token fallback or a non-CLI entry point) fall back to the hub (`list_licenses` /
`whoami`): a `CHATWOOT` license → Pro; otherwise OSS. The marker wins because "proceed without Pro" is an
intent the hub can't express: an operator may own a license yet still pick OSS for this box.

## Files

| File | Use |
| --- | --- |
| `docker-compose.yml` | **Generic**: Portainer / EasyPanel / Dokploy / plain Docker. ONE file, both editions via env. |
| `docker-compose.coolify.yml` | **Coolify** (magic vars; secrets auto-generated). Pro image by default. |
| `.env.example` | Template for the generic flavor. `cp .env.example .env`, fill every `CHANGE_ME`. |

Topology (both): `chatwoot` (web) + `sidekiq` + `postgres` (pgvector) + `redis`. WhatsApp (native) runs
inside `sidekiq`: the image starts its connector next to the worker, on by default, with a database of its own
(`<POSTGRES_DB>_whatsapp_connector`) that it creates on the first start, so the PostgreSQL user must be able to
create databases. It has no service, port or secret of its own. `WHATSAPP_CONNECTOR_ENABLED=false` on both
Chatwoot containers turns it off.

Baileys and Z-API still work but show as legacy in Chatwoot; a new stack does not ship `baileys-api`. An
existing stack that already runs one keeps it (its inboxes depend on it), and one that runs the connector as a
service of its own must set `WHATSAPP_CONNECTOR_EMBEDDED=false` on both Chatwoot containers **before** moving
to an image that embeds it, or a second connector competes for the same sessions.

## Deploy (generic: Portainer / plain Docker)

```sh
cp .env.example .env        # fill every CHANGE_ME (openssl rand -hex 64 / -hex 24)

# OSS (no subscription):
docker compose up -d

# Pro (hub subscription): authenticate to Harbor first, then set the Pro image.
docker login harbor.fazer.ai          # username + secret from the hub (generate_install_script)
CHATWOOT_IMAGE=harbor.fazer.ai/chatwoot/fazer-ai/chatwoot-pro:latest \
docker compose up -d
```

**Portainer**: paste `docker-compose.yml` as a Stack and provide the same variables in the Stack env
editor (for Pro, add `CHATWOOT_IMAGE` and register the Harbor credential under
Registries first, or `Registries:[<id>]` in the API). Front `chatwoot.<domain>` with a TLS proxy: the
fazer.ai agents [`docker-compose.portainer.yml`](../docker-compose.portainer.yml) bundled Caddy can do
this (point a Caddy site at the published `CHATWOOT_PORT`); see the `agents-onboarding` skill (`references/deploy-b-portainer.md`).

## Wire into fazer.ai agents

After both are up (see `docs/chatwoot.md`): create a Chatwoot admin, mint an
admin token, then from the agents register the deployment (`POST /v1/chatwoot/deployment {baseUrl, adminToken}`),
sync the account inbox, and bind an inbox to an agent (`PATCH /v1/chatwoot/inboxes/:id {agentId}`), which
auto-provisions the Agent Bot. The bind is identical for Pro and OSS.

## First admin

In the real flow the operator creates the first Chatwoot admin **in the browser** at `CHATWOOT_URL/app`.
The agent never creates the account or the admin; it waits for the operator, then reads the admin token
(`scripts/chatwoot-admin.py provision`, Rails runner read-only) to connect the deployment.
