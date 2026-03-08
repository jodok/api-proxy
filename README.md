# api-proxy

Hono service for `api.namche.ai`.

## Purpose

- receive external webhooks
- validate app-specific incoming auth
- forward to OpenClaw agents over Tailscale HTTPS

## Current Endpoints

- `POST /v1/webhooks/agents/:agentId/notetaker/:notetakerId` (currently `:notetakerId` = `krisp`)
- `POST /v1/webhooks/apps/github/:owner/:repo` (optional, GitHub webhooks)
- `POST /v1/webhooks/agents/:agentId/webform/:formId`
- `POST /v1/webhooks/agents/:agentId/gmail` (optional, Gmail Pub/Sub push)

## Configuration

Config is loaded from YAML:

- default: `/etc/api-proxy/config.yaml`
- optional override: `CONFIG_PATH=/custom/path/config.yaml`

Current config shape:

- `listen` (`host`, `port`)
- `logLevel` (`error`, `warn`, `info`, `debug`)
- `WEBFORM_ALLOWED_ORIGINS` (array of allowed browser origins for `/v1/webhooks/agents/*`)
- `webform.enabled` (optional boolean route toggle, default `true`)
- `agents`:
  - keyed by shortname (for example `tashi`)
  - each agent defines:
    - `url`
    - `openclawHooksToken`
- `apps`:
  - currently `krisp`, optional `github`, optional `gmail`
  - defines:
    - `krisp.agents.<agentId>.incomingAuthorization` (required per-agent auth by URL `:agentId`)
    - `krisp.enabled` (optional boolean route toggle, default `true`)
    - `github.targetAgent` (agent shortname)
    - `github.webhookSecret`
    - `github.sessionKey`
    - `github.enabled` (optional boolean route toggle, default `true`)
    - `gmail.enabled` (optional boolean route toggle, default `true`)
    - `gmail.agents.<agentId>.oidcEmail` (GCP SA expected in OIDC JWT)
    - `gmail.agents.<agentId>.forwardUrl` (target `gog gmail watch serve` URL)

See:

- `docs/config.yaml.example`

Route toggle behavior:

- disabled routes are not registered
- requests to disabled paths fall through to wildcard handlers and return `invalid_path`
- when `apps.github.enabled` or `apps.gmail.enabled` is `false`, their required auth/target fields are not required

## Krisp Forwarding

Incoming check:

- endpoint: `POST /v1/webhooks/agents/:agentId/notetaker/:notetakerId` (`:notetakerId` must be `krisp`)
- request `Authorization` must exactly match `apps.krisp.agents.<agentId>.incomingAuthorization`

Forwarded request:

- `POST <agents.<agentId>.url>/hooks/agent`
- `Authorization: <agents.<agentId>.openclawHooksToken>`
- `Content-Type: application/json`

Forwarded payload:

```json
{
  "name": "notetaker:krisp",
  "message": "<raw body string>",
  "sessionKey": "hook:notetaker:krisp",
  "deliver": false,
  "wakeMode": "next-heartbeat"
}
```

Expected upstream response:

- `202 { "status": "ok" }`

## GitHub Forwarding

Optional route — active when `apps.github` exists and `apps.github.enabled` is not `false`.

Incoming endpoint:

- `POST /v1/webhooks/apps/github/:owner/:repo`
- auth: GitHub HMAC signature (`X-Hub-Signature-256`) using `apps.github.webhookSecret`

Routing model:

- `:owner` and `:repo` are validated and forwarded as metadata
- all events forward to `apps.github.targetAgent`
- all events use one configured session key: `apps.github.sessionKey`

Forwarded payload:

```json
{
  "name": "github:<owner>/<repo>",
  "message": "{\"source\":\"github\",\"owner\":\"<owner>\",\"repo\":\"<repo>\",\"repository\":\"<owner>/<repo>\",\"event\":\"<x-github-event>\",\"action\":\"<payload.action>\",\"delivery\":\"<x-github-delivery>\",\"payload\":{...}}",
  "sessionKey": "agent:main:discord:channel:<DISCORD_CHANNEL_ID>",
  "wakeMode": "now",
  "deliver": true
}
```

Config:

```yaml
apps:
  github:
    enabled: true
    targetAgent: tashi
    webhookSecret: <GITHUB_WEBHOOK_SECRET>
    sessionKey: agent:main:discord:channel:<DISCORD_CHANNEL_ID>
```

## Webform Forwarding

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/webform/:formId`
- browser CORS origin allowlist comes from `WEBFORM_ALLOWED_ORIGINS`

Forwarded payload:

```json
{
  "name": "webform:<formId>",
  "message": "<raw body string>",
  "sessionKey": "hook:webform:<formId>",
  "wakeMode": "next-heartbeat",
  "deliver": false
}
```

## Gmail Pub/Sub Forwarding

Optional route — active when `apps.gmail` exists and `apps.gmail.enabled` is not `false`.

Supports multiple agents, each with its own Gmail account and `gog gmail watch serve` endpoint.

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/gmail`
- auth: GCP Pub/Sub OIDC JWT (`Authorization: Bearer <jwt>`) — verified against Google's public keys
- `:agentId` must match an entry in `apps.gmail.agents`

Forwarded request:

- `POST <apps.gmail.agents.<agentId>.forwardUrl>` (raw Pub/Sub body, pass-through)
- target is `gog gmail watch serve` on the agent host

Config:

```yaml
apps:
  gmail:
    enabled: true
    agents:
      tashi:
        oidcEmail: pubsub-push@<PROJECT>.iam.gserviceaccount.com
        forwardUrl: https://<tashi-tailscale-host>/gmail-pubsub?token=<GOG_SERVE_TOKEN_TASHI>
      pema:
        oidcEmail: pubsub-push@<PROJECT>.iam.gserviceaccount.com
        forwardUrl: https://<pema-tailscale-host>/gmail-pubsub?token=<GOG_SERVE_TOKEN_PEMA>
```

All agents can share one GCP service account (same project) or use separate ones per agent.

GCP Pub/Sub setup — one topic, one subscription per agent:

```bash
PROJECT_ID=<PROJECT_ID>
SA=pubsub-push@${PROJECT_ID}.iam.gserviceaccount.com

# 1. Create a shared service account for Pub/Sub push auth (once per project)
gcloud iam service-accounts create pubsub-push \
  --display-name="Pub/Sub push auth" \
  --project=${PROJECT_ID}

# 2. Create a topic (once per project)
gcloud pubsub topics create gmail-hook --project=${PROJECT_ID}

# 3. For each agent: create a push subscription pointing to its endpoint
#    (audience defaults to the push endpoint URL — matches what the proxy verifies)
for AGENT in tashi pema nima; do
  gcloud pubsub subscriptions create gmail-watch-${AGENT} \
    --topic=gmail-hook \
    --push-endpoint="https://api.namche.ai/v1/webhooks/agents/${AGENT}/gmail" \
    --push-auth-service-account="${SA}" \
    --project=${PROJECT_ID}
done
```

Set `oidcEmail` per agent to `pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com`.

## Local Run

```bash
npm install
CONFIG_PATH=./docs/config.yaml.example npm start
```

## Deploy (bertrand.batlogg.com)

GitHub Actions deploy is defined in:

- `.github/workflows/deploy.yaml`

It deploys to:

- host: `bertrand.batlogg.com`
- path: `/home/deploy/apps/api-proxy`
- restart target: `api-proxy.service`

Nginx integration (from infra):

- `api.namche.ai` proxies to `http://127.0.0.1:3000`
- proxy headers come from `/etc/nginx/proxy_params`

Production files on Bertrand:

- `/etc/api-proxy/config.yaml`

Config contains secrets. Restrict file permissions accordingly.

See service template:

- `docs/api-proxy.service.example`
