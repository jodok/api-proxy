# namche-api-proxy

Hono service for `api.namche.ai`.

## Purpose

- receive external webhooks
- validate app-specific incoming auth
- forward to OpenClaw agents over Tailscale HTTPS

## Current Endpoint

- `POST /v1/webhooks/apps/krisp`

## Configuration

Config is loaded from YAML:

- default: `/etc/namche-api-proxy/config.yaml`
- optional override: `CONFIG_PATH=/custom/path/config.yaml`

Current config shape:

- `listen` (`host`, `port`)
- `logLevel` (`error`, `warn`, `info`, `debug`)
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
