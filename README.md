# namche-api-proxy

Hono service for `api.namche.ai`.

## Purpose

- receive external webhooks
- route by agent path (`/webhooks/:agent/:source`)
- forward webhooks to agent machines over Tailscale

## Endpoints

- `GET /healthz`
- `POST /webhooks/:agent/:source`

Example:

- `POST /webhooks/tashi/github`

## Baked-In Routing

Routing is built into `index.mjs`.
Current default config contains only:

- agent: `tashi`
- target base URL: `http://100.64.0.11:8787`
- ingress secret env: `WEBHOOK_SECRET_TASHI_IN`
- forward secret env: `WEBHOOK_SECRET_TASHI_OUT`

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
- `WEBHOOK_SECRET_TASHI_IN`
- `WEBHOOK_SECRET_TASHI_OUT`

See examples:

- `docs/proxy.env.example`
