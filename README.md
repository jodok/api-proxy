# api-proxy

Hono service for `api.namche.ai`.

## Purpose

- receive external webhooks
- validate app-specific incoming auth
- forward to OpenClaw agents over Tailscale HTTPS

## Current Endpoints

- `POST /v1/webhooks/apps/krisp`
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
- `roots` (optional boolean toggles for route roots, default `true`)
  - `roots.krisp`
  - `roots.github`
  - `roots.webform`
  - `roots.gmail`
- `WEBFORM_ALLOWED_ORIGINS` (array of allowed browser origins for `/v1/webhooks/agents/*`)
- `agents`:
  - keyed by shortname (for example `tashi`)
  - each agent defines:
    - `url`
    - `openclawHooksToken`
- `apps`:
  - currently `krisp`, optional `github`, optional `gmail`
  - defines:
    - `krisp.incomingAuthorization` (full Authorization header value)
    - `krisp.targetAgent` (agent shortname)
    - `github.targetAgent` (agent shortname)
    - `github.webhookSecret`
    - `github.sessionKey`

See:

- `docs/config.yaml.example`

Root toggle behavior:

- disabled roots are not registered
- requests to disabled paths fall through to wildcard handlers and return `invalid_path`
- when `roots.github` or `roots.gmail` is `false`, their `apps.*` config blocks are not required

## Krisp Forwarding

Incoming check:

- request `Authorization` must exactly match `apps.krisp.incomingAuthorization`

Forwarded request:

- `POST <agents.<targetAgent>.url>/hooks/agent`
- `Authorization: <agents.<targetAgent>.openclawHooksToken>`
- `Content-Type: application/json`

Forwarded payload:

```json
{
  "name": "notetaker:krisp",
  "message": "<raw body string>",
  "agentId": "notetaker",
  "sessionKey": "hook:notetaker:krisp",
  "deliver": false,
  "wakeMode": "next-heartbeat"
}
```

Expected upstream response:

- `202 { "status": "ok" }`

## GitHub Forwarding

Optional route — only active if `apps.github` is present in config.

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

Optional route — only active if `apps.gmail` is present in config.

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/gmail`
- auth: GCP Pub/Sub OIDC JWT (`Authorization: Bearer <jwt>`) — verified against Google's public keys

Forwarded request:

- `POST <apps.gmail.forwardUrl>` (raw Pub/Sub body, pass-through)
- target is `gog gmail watch serve` on the agent host

Config:

```yaml
apps:
  gmail:
    oidcEmail: <SERVICE_ACCOUNT>@<PROJECT>.iam.gserviceaccount.com
    targetAgent: tashi
    forwardUrl: https://<tashi-tailscale-host>/gmail-pubsub?token=<GOG_SERVE_TOKEN>
```

GCP Pub/Sub subscription — create with OIDC auth (no token in URL):

```bash
# 1. Create a dedicated service account for Pub/Sub push auth
gcloud iam service-accounts create pubsub-push \
  --display-name="Pub/Sub push auth" \
  --project=<PROJECT_ID>

# 2. Grant it permission to publish to the topic (so GCP accepts the OIDC token)
gcloud pubsub topics add-iam-policy-binding <TOPIC> \
  --member="serviceAccount:pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# 3. Update the push subscription with OIDC auth — clean URL, no token param
gcloud pubsub subscriptions modify-push-config <SUBSCRIPTION> \
  --push-endpoint="https://api.namche.ai/v1/webhooks/agents/tashi/gmail" \
  --push-auth-service-account="pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com"
# audience defaults to the push endpoint URL — matches what the proxy verifies
```

Set `oidcEmail` in config to `pubsub-push@<PROJECT_ID>.iam.gserviceaccount.com`.

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
