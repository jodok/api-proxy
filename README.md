# webhook-proxy

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

## Env Variables

- `HOST` (default `0.0.0.0`)
- `PORT` (default `8787`)
- ingress secret env vars referenced by `ingressSecretEnv`
- forwarding secret env vars referenced by `forwardSecretEnv`

See examples:

- `docs/examples/config/routes.config.json.example`
- `docs/examples/env/webhook-proxy.env.example`
