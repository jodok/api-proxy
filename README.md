# namche-api-proxy

Hono service for `api.namche.ai`.

## Purpose

- receive external webhooks
- validate source-specific authentication
- forward webhooks to OpenClaw hosts over Tailscale HTTPS

## Endpoints

- `GET /healthz`
- `POST /v1/webhooks/apps/...`
- `POST /v1/webhooks/hosts/...`

Accepted path shapes:

- `POST /v1/webhooks/apps/:source/hosts/:host`
- `POST /v1/webhooks/apps/:source/:host`
- `POST /v1/webhooks/hosts/:host/apps/:source`
- `POST /v1/webhooks/hosts/:host/:source`

Optional extra segment sets webhook topic sent upstream:

- `POST /v1/webhooks/apps/:source/hosts/:host/:topic`
- `POST /v1/webhooks/hosts/:host/apps/:source/:topic`

## Baked-In Matrix

Sources:

- `github` (auth via `X-Hub-Signature-256` with `GITHUB_WEBHOOK_SECRET`)
- `krisp` (auth via `Authorization: Bearer <KRISP_WEBHOOK_SECRET>`)

Hosts (via Tailscale serve HTTPS):

- `tashi` -> `https://tashi.silverside-mermaid.ts.net`
- `pema` -> `https://pema.silverside-mermaid.ts.net`
- `nima` -> `https://nima.silverside-mermaid.ts.net`

## Krisp Forwarding

Incoming check:

- `Authorization: Bearer <KRISP_WEBHOOK_SECRET>`

Forwarded request (to selected host):

- `POST https://<host>.silverside-mermaid.ts.net/hooks/agent`
- `Authorization: Bearer <OPENCLAW_HOOKS_TOKEN_TASHI>`
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

## Local Run

```bash
npm install
npm start
```

## Deploy (bertrand.batlogg.com)

GitHub Actions deploy is defined in:

- `.github/workflows/deploy.yaml`

It deploys to:

- host: `bertrand.batlogg.com`
- path: `/home/deploy/apps/namche-api-proxy`
- restart target: `namche-api-proxy.service`

Required GitHub settings:

- secret: `DEPLOY_SSH_KEY`
- variable: `DEPLOY_KNOWN_HOSTS` (for example from `ssh-keyscan bertrand.batlogg.com`)

Nginx integration (from infra):

- `api.namche.ai` proxies to `http://127.0.0.1:3000`
- proxy headers come from `/etc/nginx/proxy_params`

So the systemd env on Bertrand must set:

- `HOST=127.0.0.1`
- `PORT=3000`

See examples:

- `docs/proxy.env.example`
- `docs/namche-api-proxy.service.example`

## Env Variables

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8787`)
- `GITHUB_WEBHOOK_SECRET`
- `KRISP_WEBHOOK_SECRET`
- `OPENCLAW_HOOKS_TOKEN_TASHI` (used only for krisp -> tashi)

See examples:

- `docs/proxy.env.example`
