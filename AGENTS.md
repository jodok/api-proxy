# AGENTS.md — namche-api-proxy

## Project

Webhook relay service for Namche.
Current production flow accepts Krisp webhooks and forwards them to OpenClaw on Tashi.

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

## Commit Messages

Use commitlint-compatible Conventional Commits, for example:

- `feat: ...`
- `fix: ...`
- `docs: ...`
- `chore: ...`

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
- Config file: `/etc/namche-api-proxy/config.yaml`
- CI workflow: `.github/workflows/deploy.yaml`

Do not deploy app source into nginx web root (`/var/www/html`).

## Configuration Model

Hardwired app handlers in code (currently `krisp`) use YAML config for wiring and credentials:

- `bots.<shortname>.url`
- `bots.<shortname>.openclawHooksToken`
- `apps.krisp.incomingAuthorization`
- `apps.krisp.targetBot`

No enable/disable flags and no timeout config knobs.

## Logging

- `logLevel` is configured in YAML (`error`, `warn`, `info`, `debug`)
- `debug` logs include payload details

## Key Files

- `index.mjs` — runtime server, config loading, auth checks, forwarding, logging
- `docs/config.yaml.example` — config example (including secrets)
- `docs/namche-api-proxy.service.example` — systemd unit template
- `.github/workflows/deploy.yaml` — deploy to Bertrand
