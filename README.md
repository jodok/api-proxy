# namche-api-proxy

Hono service for `api.namche.ai`.

## Purpose

- receive external webhooks
- validate app-specific incoming auth
- forward to OpenClaw agents over Tailscale HTTPS

## Current Endpoints

- `POST /v1/webhooks/apps/krisp`
- `POST /v1/webhooks/agents/:agentId/complaint`
- `POST /v1/webhooks/agents/:agentId/gmail` (optional, Gmail Pub/Sub push)

## Configuration

Config is loaded from YAML:

- default: `/etc/namche-api-proxy/config.yaml`
- optional override: `CONFIG_PATH=/custom/path/config.yaml`

Current config shape:

- `listen` (`host`, `port`)
- `logLevel` (`error`, `warn`, `info`, `debug`)
- `WEBFORM_ALLOWED_ORIGINS` (array of allowed browser origins for `/v1/webhooks/agents/*`)
- `agents`:
  - keyed by shortname (for example `tashi`)
  - each agent defines:
    - `url`
    - `openclawHooksToken`
- `apps`:
  - currently `krisp`
  - defines:
    - `incomingAuthorization` (full Authorization header value)
    - `targetAgent` (agent shortname)

See:

- `docs/config.yaml.example`

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
  "deliver": true,
  "wakeMode": "now"
}
```

Expected upstream response:

- `202 { "status": "ok" }`

## Webform Complaint Forwarding

Incoming endpoint:

- `POST /v1/webhooks/agents/:agentId/complaint`
- browser CORS origin allowlist comes from `WEBFORM_ALLOWED_ORIGINS`

Forwarded payload:

```json
{
  "name": "complaint:webform",
  "message": "<raw body string>",
  "deliver": true,
  "wakeMode": "now",
  "agentId": "main"
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
gcloud pubsub subscriptions modify-push-config gog-gmail-watch-push \
  --push-endpoint="https://api.namche.ai/v1/webhooks/agents/tashi/gmail" \
  --push-auth-service-account=<SERVICE_ACCOUNT>@<PROJECT>.iam.gserviceaccount.com \
  --push-auth-token-format=oidc_token
```

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
- path: `/home/deploy/apps/namche-api-proxy`
- restart target: `namche-api-proxy.service`

Nginx integration (from infra):

- `api.namche.ai` proxies to `http://127.0.0.1:3000`
- proxy headers come from `/etc/nginx/proxy_params`

Production files on Bertrand:

- `/etc/namche-api-proxy/config.yaml`

Config contains secrets. Restrict file permissions accordingly.

See service template:

- `docs/namche-api-proxy.service.example`
