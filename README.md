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

## Config

Default config file:

- `routes.config.json`

Override with env:

- `NAMCHE_PROXY_CONFIG=/path/to/routes.config.json`

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

- `docs/examples/env/namche-api-proxy.bertrand.env.example`
- `docs/examples/systemd/namche-api-proxy.service.example`

## Env Variables

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8787`)
- ingress secret env vars referenced by `ingressSecretEnv`
- forwarding secret env vars referenced by `forwardSecretEnv`

See examples:

- `docs/examples/config/routes.config.json.example`
- `docs/examples/env/namche-api-proxy.env.example`
