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

Hardwired app handlers in code (currently `krisp`, `complaint`) use YAML config for wiring and credentials:

- `WEBFORM_ALLOWED_ORIGINS`
- `agents.<shortname>.url`
- `agents.<shortname>.openclawHooksToken`
- `apps.krisp.incomingAuthorization`
- `apps.krisp.targetAgent`

No enable/disable flags and no timeout config knobs.

## OpenClaw Hook Parameters

Each app forwards to OpenClaw with a fixed set of hook parameters. These are defined in `APP_DEFINITIONS` in `index.mjs`:

| Parameter | Description |
|-----------|-------------|
| `name` | Payload name identifying the hook type (e.g. `notetaker:krisp`) |
| `agentId` | OpenClaw agent session to target (`main` for the primary agent) |
| `sessionKey` | Routes the payload into a specific hook session within the agent |
| `wakeMode` | When to wake the agent: `now` (immediately) or `next-heartbeat` (at next periodic check) |
| `deliver` | Whether to push a notification to the agent (`true` = wake immediately, `false` = queue silently) |

### Per-endpoint settings

**krisp** (`POST /v1/webhooks/apps/krisp`):
- `sessionKey: hook:notetaker:krisp` — notetaker hook session
- `wakeMode: next-heartbeat` — processed at the next heartbeat, not urgently
- `deliver: false` — queued silently, no immediate notification

**complaint** (`POST /v1/webhooks/agents/:agentId/complaint`):
- `sessionKey: hook:complaint:webform` — complaint webform hook session
- `wakeMode: now` — agent woken immediately to handle the complaint
- `deliver: true` — notification pushed so the agent acts right away

## Logging

- `logLevel` is configured in YAML (`error`, `warn`, `info`, `debug`)
- `debug` logs include payload details

## Key Files

- `index.mjs` — runtime server, config loading, auth checks, forwarding, logging
- `docs/config.yaml.example` — config example (including secrets)
- `docs/namche-api-proxy.service.example` — systemd unit template
- `.github/workflows/deploy.yaml` — deploy to Bertrand
