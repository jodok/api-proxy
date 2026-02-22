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
- `krisp` (auth via `Authorization` header matching `KRISP_AUTHORIZATION`)

Hosts (via Tailscale serve HTTPS):

- `tashi` -> `https://tashi.silverside-mermaid.ts.net`
- `pema` -> `https://pema.silverside-mermaid.ts.net`
- `nima` -> `https://nima.silverside-mermaid.ts.net`

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
- `KRISP_AUTHORIZATION`
- `WEBHOOK_SECRET_TASHI_OUT` (optional)
- `WEBHOOK_SECRET_PEMA_OUT` (optional)
- `WEBHOOK_SECRET_NIMA_OUT` (optional)

See examples:

- `docs/proxy.env.example`
