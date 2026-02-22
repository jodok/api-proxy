# AGENTS.md — namche-api-proxy

## Project

Webhook relay service for Namche.
Receives webhooks from external services (for now: Tashi) and forwards them to an agent endpoint.

Built with Hono + Node.js (ESM JavaScript).

## Language

Everything in English: code, docs, commit messages.

## Git Workflow

1. Always `git pull origin main` before starting work
2. Create a feature branch with `tashi/` prefix (`git checkout -b tashi/<branch-name>`)
3. Commit and push to the branch
4. Open a pull request on GitHub (`gh pr create`)
5. Wait for Jodok's approval
6. After approval, merge to main (`gh pr merge --squash`)

Never commit directly to main.

## Development

```bash
npm install
npm start
```

## Runtime / Deploy

- Public domain: `api.namche.ai`
- Nginx on `bertrand.batlogg.com` proxies to `127.0.0.1:3000`
- App deploy path: `/home/deploy/apps/namche-api-proxy`
- Systemd service: `namche-api-proxy.service`
- Systemd env file: `/etc/namche-api-proxy/proxy.env`
- CI workflow: `.github/workflows/deploy.yaml`

Do not deploy app source into nginx web root (`/var/www/html`).

## Architecture

```
External service (GitHub, ...)
  → api.namche.ai (Cloudflare + nginx)
    → namche-api-proxy (Node service on 127.0.0.1:3000)
      → target agent `/webhooks/:source` endpoint
```

## Config

Routing is baked into `index.mjs` and currently contains only `tashi`.

## Key Files

- `index.mjs` — server and forwarding logic
- `.github/workflows/deploy.yaml` — deploy to Bertrand
- `docs/namche-api-proxy.service.example` — systemd unit template
- `docs/proxy.env.example` — production env template
