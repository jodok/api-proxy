# AGENTS.md — api-proxy

## Repository specific rules

- Keep this repository minimal and operationally simple. Do not add automation, abstractions, or tooling unless they clearly reduce maintenance cost.
- Keep runtime behavior in `index.mjs`. Use YAML config for wiring, credentials, and route toggles, not for moving application logic out of code.
- Keep `README.md`, `docs/config.yaml.example`, and `docs/api-proxy.service.example` aligned with the current runtime behavior before finishing changes.
- Keep everything in English: code, docs, commit messages, PR titles, and PR bodies.
- Krisp ingress is `POST /v1/webhooks/agents/:agentId/notetaker/:notetakerId` with `:notetakerId` currently fixed to `krisp`.
- For Krisp auth, use `apps.krisp.agents.<agentId>.incomingAuthorization`. The route `:agentId` selects which configured agent receives the webhook.
- Do not treat the route `:agentId` as an OpenClaw hook payload `agentId`. Krisp routing inside the target agent is done with `sessionKey: hook:notetaker:krisp`.
- GitHub remains an optional app-specific route at `POST /v1/webhooks/apps/github/:owner/:repo`. Gmail and webforms remain agent-scoped routes under `/v1/webhooks/agents/:agentId/...`.
- Production deploy target is `/home/deploy/apps/api-proxy` on `bertrand.batlogg.com` with systemd unit `api-proxy.service`. Do not deploy app source into nginx web root (`/var/www/html`).
- If a rule discovered here should apply across repositories, move it into `jodok/agents` first and then sync it back here.

## Global rules

- Never push directly to `main`.
- Always work on a branch prefixed with the active agent name, for example `tashi/...`, `codex/...`, or `claude/...`.
- Always use commitlint-compatible Conventional Commit messages.
- Always add `Jodok Batlogg <jodok@batlogg.com>` as co-author on commits.
- When work is done, always commit, push, and open a pull request.
- Always squash-merge into `main`.
- Repository-specific rules may add constraints, but must not weaken these global rules.
- If a rule should apply across repositories, add it here first and then update the consuming repositories.

## Gmail config

- `apps.gmail.subscriptions.<subscriptionEmail>.oidcEmail`
- `apps.gmail.subscriptions.<subscriptionEmail>.forwardPort` (optional, defaults to `8788`)
- Omit `apps.gmail` entirely to disable the Gmail route.
