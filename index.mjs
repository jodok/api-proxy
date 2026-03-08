import { existsSync, readFileSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import yaml from 'js-yaml';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

const app = new Hono();

const DEFAULT_CONFIG_PATH = '/etc/api-proxy/config.yaml';
const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
const FORWARD_TIMEOUT_MS = 15000;
const DEBUG_MESSAGE_PREVIEW_CHARS = 300;

const APP_DEFINITIONS = {
  krisp: {
    path: '/v1/webhooks/agents/:agentId/notetaker/:notetakerId',
    payloadName: 'notetaker:krisp',
    sessionKey: 'hook:notetaker:krisp',
  },
  github: {
    path: '/v1/webhooks/apps/github/:owner/:repo',
  },
  gmail: {
    path: '/v1/webhooks/agents/:agentId/gmail',
  },
};

// webform route — generic, formId from URL path
const WEBFORM_PATH = '/v1/webhooks/agents/:agentId/webform/:formId';

const rawConfig = loadConfig(configPath);
const config = normalizeConfig(rawConfig);

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const configuredLogLevel = config.logLevel;
const activeLogLevel = LOG_LEVELS[configuredLogLevel] ?? LOG_LEVELS.info;

function shouldLog(level) {
  return LOG_LEVELS[level] <= activeLogLevel;
}

function log(level, message) {
  if (!shouldLog(level)) return;
  if (level === 'error') console.error(message);
  else if (level === 'warn') console.warn(message);
  else console.log(message);
}

function toUtf8(bufferLike) {
  return Buffer.from(bufferLike).toString('utf8');
}

function previewText(value, maxChars = DEBUG_MESSAGE_PREVIEW_CHARS) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]`;
}

function buildForwardEnvelopeDebug(payload) {
  let parsed = payload;
  if (typeof payload === 'string') {
    try {
      parsed = JSON.parse(payload);
    } catch {
      return { payloadPreview: previewText(payload) };
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { payloadPreview: previewText(String(payload ?? '')) };
  }

  return {
    name: parsed.name ?? '',
    agentId: parsed.agentId ?? '',
    sessionKey: parsed.sessionKey ?? '',
    wakeMode: parsed.wakeMode ?? '',
    deliver: parsed.deliver ?? '',
    messagePreview: previewText(parsed.message ?? ''),
  };
}

function logDebugPayload(label, details) {
  if (!shouldLog('debug')) return;
  log('debug', `[api-proxy] ${label} ${JSON.stringify(details)}`);
}

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  await next();
  const durationMs = Date.now() - startedAt;
  log('info', `[api-proxy] request method=${c.req.method} path=${new URL(c.req.url).pathname} status=${c.res.status} duration_ms=${durationMs}`);
});

app.use('/v1/webhooks/agents/*', cors({
  origin: config.webformAllowedOrigins,
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400,
}));

app.get('/healthz', (c) => {
  const routes = [];
  if (isAppRouteEnabled('krisp')) routes.push(APP_DEFINITIONS.krisp.path);
  if (isAppRouteEnabled('github')) routes.push(APP_DEFINITIONS.github.path);
  if (config.webform.enabled) routes.push(WEBFORM_PATH);
  if (isAppRouteEnabled('gmail')) routes.push(APP_DEFINITIONS.gmail.path);

  return c.json({
    ok: true,
    service: 'api-proxy',
    configPath,
    logLevel: configuredLogLevel,
    apps: Object.keys(APP_DEFINITIONS),
    routeToggles: {
      krisp: isAppRouteEnabled('krisp'),
      github: isAppRouteEnabled('github'),
      webform: config.webform.enabled,
      gmail: isAppRouteEnabled('gmail'),
    },
    agents: Object.keys(config.agents),
    webformAllowedOrigins: config.webformAllowedOrigins,
    routes,
  });
});

if (isAppRouteEnabled('krisp')) app.post(APP_DEFINITIONS.krisp.path, handleKrispWebhook);
if (isAppRouteEnabled('github')) app.post(APP_DEFINITIONS.github.path, handleGithubWebhook);
if (config.webform.enabled) app.post(WEBFORM_PATH, handleWebformWebhook);
if (isAppRouteEnabled('gmail')) app.post(APP_DEFINITIONS.gmail.path, handleGmailWebhook);

app.post('/v1/webhooks/apps/*', (c) => {
  log('warn', `[api-proxy] invalid_path family=apps path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.post('/v1/webhooks/agents/*', (c) => {
  log('warn', `[api-proxy] invalid_path family=agents path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.all('*', (c) => {
  return c.json({ ok: true }, 200);
});

serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, () => {
  log('info', `[api-proxy] listening on ${config.listen.host}:${config.listen.port} log_level=${configuredLogLevel} config=${configPath}`);
});

function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`[api-proxy] Config file not found at ${path}`);
  }

  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[api-proxy] Config file is empty or invalid');
  }

  return parsed;
}

function normalizeConfig(raw) {
  const listen = raw.listen ?? {};
  const agents = raw.agents ?? {};
  const apps = raw.apps ?? {};
  const webform = raw.webform ?? {};
  const webformAllowedOrigins = Array.isArray(raw.WEBFORM_ALLOWED_ORIGINS)
    ? raw.WEBFORM_ALLOWED_ORIGINS
    : ['https://tashi.namche.ai'];

  if (!agents || typeof agents !== 'object') {
    throw new Error('[api-proxy] Config must define agents object');
  }

  if (!apps || typeof apps !== 'object') {
    throw new Error('[api-proxy] Config must define apps object');
  }
  if (!webform || typeof webform !== 'object' || Array.isArray(webform)) {
    throw new Error('[api-proxy] webform must be an object');
  }

  const webformEnabled = webform.enabled ?? true;
  if (typeof webformEnabled !== 'boolean') {
    throw new Error('[api-proxy] webform.enabled must be a boolean');
  }

  const normalizedWebformAllowedOrigins = webformAllowedOrigins
    .map((origin) => String(origin ?? '').trim())
    .filter(Boolean);

  if (normalizedWebformAllowedOrigins.length === 0) {
    throw new Error('[api-proxy] WEBFORM_ALLOWED_ORIGINS must include at least one origin');
  }

  const normalizedAgents = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== 'object') {
      throw new Error(`[api-proxy] Invalid agent config for '${agentId}'`);
    }

    const url = String(agent.url ?? '').trim();
    const openclawHooksToken = String(agent.openclawHooksToken ?? '').trim();

    if (!url) {
      throw new Error(`[api-proxy] Agent '${agentId}' missing url`);
    }

    if (!openclawHooksToken) {
      throw new Error(`[api-proxy] Agent '${agentId}' missing openclawHooksToken`);
    }

    normalizedAgents[agentId] = {
      url,
      openclawHooksToken,
    };
  }

  const normalizedApps = {};
  for (const [appId, appDef] of Object.entries(APP_DEFINITIONS)) {
    const appConfig = apps[appId];

    if (appId === 'krisp') {
      if (!appConfig || typeof appConfig !== 'object') {
        throw new Error(`[api-proxy] App 'krisp' config is required`);
      }

      const enabled = appConfig.enabled ?? true;
      if (typeof enabled !== 'boolean') {
        throw new Error(`[api-proxy] App 'krisp' enabled must be a boolean`);
      }
      if (!enabled) {
        normalizedApps.krisp = { ...appDef, enabled: false };
        continue;
      }

      const agentsMap = appConfig.agents;
      if (!agentsMap || typeof agentsMap !== 'object' || Array.isArray(agentsMap)) {
        throw new Error(`[api-proxy] App 'krisp' agents must be an object`);
      }

      const normalizedKrispAgents = {};
      for (const [krispAgentId, entry] of Object.entries(agentsMap)) {
        if (!entry || typeof entry !== 'object') {
          throw new Error(`[api-proxy] App 'krisp' agent '${krispAgentId}' config must be an object`);
        }
        if (!normalizedAgents[krispAgentId]) {
          throw new Error(`[api-proxy] App 'krisp' references unknown agent '${krispAgentId}'`);
        }

        const agentIncomingAuthorization = String(entry.incomingAuthorization ?? '').trim();
        if (!agentIncomingAuthorization) {
          throw new Error(`[api-proxy] App 'krisp' agent '${krispAgentId}' missing incomingAuthorization`);
        }

        normalizedKrispAgents[krispAgentId] = {
          incomingAuthorization: agentIncomingAuthorization,
        };
      }

      if (Object.keys(normalizedKrispAgents).length === 0) {
        throw new Error(`[api-proxy] App 'krisp' agents requires at least one agent entry`);
      }

      normalizedApps.krisp = {
        ...appDef,
        enabled: true,
        agents: normalizedKrispAgents,
      };

      continue;
    }

    // github is optional — only active when present in config
    if (appId === 'github') {
      if (!appConfig) continue;
      if (typeof appConfig !== 'object') {
        throw new Error(`[api-proxy] App 'github' config must be an object`);
      }

      const enabled = appConfig.enabled ?? true;
      if (typeof enabled !== 'boolean') {
        throw new Error(`[api-proxy] App 'github' enabled must be a boolean`);
      }
      if (!enabled) {
        normalizedApps.github = { ...appDef, enabled: false };
        continue;
      }

      const targetAgent = String(appConfig.targetAgent ?? '').trim();
      if (!targetAgent) throw new Error(`[api-proxy] App 'github' missing targetAgent`);
      if (!normalizedAgents[targetAgent]) {
        throw new Error(`[api-proxy] App 'github' references unknown agent '${targetAgent}'`);
      }

      const webhookSecret = String(appConfig.webhookSecret ?? '').trim();
      const sessionKey = String(appConfig.sessionKey ?? '').trim();
      if (!webhookSecret) {
        throw new Error(`[api-proxy] App 'github' missing webhookSecret`);
      }
      if (!sessionKey) {
        throw new Error(`[api-proxy] App 'github' missing sessionKey`);
      }

      normalizedApps.github = { ...appDef, enabled: true, targetAgent, webhookSecret, sessionKey };
      continue;
    }

    // gmail is optional — only active when present in config
    if (appId === 'gmail') {
      if (!appConfig) continue;
      if (typeof appConfig !== 'object') {
        throw new Error(`[api-proxy] App 'gmail' config must be an object`);
      }

      const enabled = appConfig.enabled ?? true;
      if (typeof enabled !== 'boolean') {
        throw new Error(`[api-proxy] App 'gmail' enabled must be a boolean`);
      }
      if (!enabled) {
        normalizedApps.gmail = { ...appDef, enabled: false };
        continue;
      }

      const agentsMap = appConfig.agents;
      if (!agentsMap || typeof agentsMap !== 'object' || Array.isArray(agentsMap)) {
        throw new Error(`[api-proxy] App 'gmail' requires an 'agents' map`);
      }

      const normalizedGmailAgents = {};
      for (const [gmailAgentId, entry] of Object.entries(agentsMap)) {
        if (!entry || typeof entry !== 'object') {
          throw new Error(`[api-proxy] App 'gmail' agent '${gmailAgentId}' config must be an object`);
        }
        const oidcEmail = String(entry.oidcEmail ?? '').trim();
        const forwardUrl = String(entry.forwardUrl ?? '').trim();
        if (!oidcEmail) throw new Error(`[api-proxy] App 'gmail' agent '${gmailAgentId}' missing oidcEmail`);
        if (!forwardUrl) throw new Error(`[api-proxy] App 'gmail' agent '${gmailAgentId}' missing forwardUrl`);
        if (!normalizedAgents[gmailAgentId]) {
          throw new Error(`[api-proxy] App 'gmail' references unknown agent '${gmailAgentId}'`);
        }
        normalizedGmailAgents[gmailAgentId] = { oidcEmail, forwardUrl };
      }

      if (Object.keys(normalizedGmailAgents).length === 0) {
        throw new Error(`[api-proxy] App 'gmail' requires at least one agent entry`);
      }

      normalizedApps.gmail = { ...appDef, enabled: true, agents: normalizedGmailAgents };
      continue;
    }

    if (!appConfig || typeof appConfig !== 'object') {
      throw new Error(`[api-proxy] App '${appId}' config is required`);
    }

    const enabled = appConfig.enabled ?? true;
    if (typeof enabled !== 'boolean') {
      throw new Error(`[api-proxy] App '${appId}' enabled must be a boolean`);
    }
    if (!enabled) {
      normalizedApps[appId] = {
        ...appDef,
        enabled: false,
      };
      continue;
    }

    const incomingAuthorization = String(appConfig.incomingAuthorization ?? '').trim();
    const targetAgent = String(appConfig.targetAgent ?? '').trim();

    if (!incomingAuthorization) {
      throw new Error(`[api-proxy] App '${appId}' missing incomingAuthorization`);
    }

    if (!targetAgent) {
      throw new Error(`[api-proxy] App '${appId}' missing targetAgent`);
    }

    if (!normalizedAgents[targetAgent]) {
      throw new Error(`[api-proxy] App '${appId}' references unknown agent '${targetAgent}'`);
    }

    normalizedApps[appId] = {
      ...appDef,
      enabled: true,
      incomingAuthorization,
      targetAgent,
    };
  }

  return {
    listen: {
      host: String(listen.host ?? '127.0.0.1'),
      port: Number(listen.port ?? 3000),
    },
    logLevel: String(raw.logLevel ?? 'info').toLowerCase(),
    webform: {
      enabled: webformEnabled,
    },
    webformAllowedOrigins: normalizedWebformAllowedOrigins,
    agents: normalizedAgents,
    apps: normalizedApps,
  };
}

function isAppRouteEnabled(appId) {
  const appConfig = config.apps[appId];
  return Boolean(appConfig && appConfig.enabled !== false);
}

function buildHooksUrl(baseUrl) {
  const root = String(baseUrl ?? '').replace(/\/$/, '');
  return `${root}/hooks/agent`;
}

function getAuthScheme(value) {
  if (!value) return 'none';
  const trimmed = String(value).trim();
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bearer ')) return 'bearer';
  return 'raw';
}

function extractBearerToken(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';

  const lower = trimmed.toLowerCase();
  if (lower.startsWith('bearer ')) {
    return trimmed.slice(7).trim();
  }

  return trimmed;
}

function authorizationMatches(provided, expected) {
  if (!provided || !expected) return false;

  const providedTrimmed = String(provided).trim();
  const expectedTrimmed = String(expected).trim();

  if (providedTrimmed === expectedTrimmed) {
    return true;
  }

  const providedToken = extractBearerToken(providedTrimmed);
  const expectedToken = extractBearerToken(expectedTrimmed);

  if (!providedToken || !expectedToken) {
    return false;
  }

  return providedToken === expectedToken;
}

async function handleKrispWebhook(c) {
  const path = new URL(c.req.url).pathname;
  const routeAgentId = String(c.req.param('agentId') ?? '').trim();
  const notetakerId = String(c.req.param('notetakerId') ?? '').trim();
  if (notetakerId !== 'krisp') {
    log('warn', `[api-proxy] invalid_notetaker app=krisp path=${path} notetaker_id=${notetakerId || 'none'}`);
    return c.json({ ok: false, error: 'invalid_notetaker' }, 400);
  }

  const appConfig = config.apps.krisp;
  const agentConfig = config.agents[routeAgentId];
  const routeAuthConfig = appConfig.agents?.[routeAgentId];
  const expectedAuthorization = routeAuthConfig?.incomingAuthorization;

  if (!agentConfig || !expectedAuthorization) {
    log('warn', `[api-proxy] unknown_agent app=krisp path=${path} route_agent=${routeAgentId || 'none'}`);
    return c.json({ ok: false, error: 'unknown_agent' }, 404);
  }

  const providedAuth = c.req.header('authorization');
  if (!authorizationMatches(providedAuth, expectedAuthorization)) {
    if (shouldLog('debug')) {
      const providedScheme = getAuthScheme(providedAuth);
      const expectedScheme = getAuthScheme(expectedAuthorization);
      const providedLen = providedAuth ? providedAuth.trim().length : 0;
      const expectedLen = expectedAuthorization.trim().length;
      log('debug', `[api-proxy] auth_mismatch app=krisp auth_scope=agent:${routeAgentId} provided_scheme=${providedScheme} expected_scheme=${expectedScheme} provided_len=${providedLen} expected_len=${expectedLen}`);
    }

    log('warn', `[api-proxy] unauthorized app=krisp reason=authorization path=${path}`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const body = await c.req.arrayBuffer();
  const message = toUtf8(body);
  logDebugPayload('incoming_payload', {
    app: 'krisp',
    path,
    routeAgentId,
    bytes: body.byteLength,
    bodyPreview: previewText(message),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const payload = JSON.stringify({
      name: APP_DEFINITIONS.krisp.payloadName,
      message,
      sessionKey: APP_DEFINITIONS.krisp.sessionKey,
      wakeMode: 'next-heartbeat',
      deliver: false,
    });

    logDebugPayload('forward_payload', {
      app: 'krisp',
      routeAgentId,
      ...buildForwardEnvelopeDebug(payload),
    });

    const upstream = await forwardToAgent(agentConfig, payload, controller.signal);

    log('info', `[api-proxy] app=krisp agent=${routeAgentId} status=${upstream.status} bytes=${body.byteLength}`);
    return upstream;
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[api-proxy] app=krisp agent=${routeAgentId} error=${messageText}`);
    return c.json({ ok: false, error: messageText }, code);
  } finally {
    clearTimeout(timeout);
  }
}

function isValidGithubPathSegment(value) {
  return /^[A-Za-z0-9._-]{1,200}$/.test(value);
}

function verifyGithubSignature(rawBody, signatureHeader, webhookSecret) {
  const signature = String(signatureHeader ?? '').trim();
  if (!signature.toLowerCase().startsWith('sha256=')) return false;

  const providedHex = signature.slice(7).trim();
  if (!/^[A-Fa-f0-9]{64}$/.test(providedHex)) return false;

  const expectedHex = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const provided = Buffer.from(providedHex, 'hex');
  const expected = Buffer.from(expectedHex, 'hex');

  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

async function handleGithubWebhook(c) {
  const path = new URL(c.req.url).pathname;
  const owner = String(c.req.param('owner') ?? '').trim();
  const repo = String(c.req.param('repo') ?? '').trim();
  const appConfig = config.apps.github;

  if (!appConfig) {
    log('warn', `[api-proxy] github_not_configured path=${path}`);
    return c.json({ ok: false, error: 'not_configured' }, 404);
  }

  if (!owner || !isValidGithubPathSegment(owner) || !repo || !isValidGithubPathSegment(repo)) {
    log('warn', `[api-proxy] invalid_repository path=${path} owner=${owner || 'none'} repo=${repo || 'none'}`);
    return c.json({ ok: false, error: 'invalid_repository' }, 400);
  }

  const body = await c.req.arrayBuffer();
  const rawBody = Buffer.from(body);
  const signatureHeader = c.req.header('x-hub-signature-256');

  if (!verifyGithubSignature(rawBody, signatureHeader, appConfig.webhookSecret)) {
    log('warn', `[api-proxy] unauthorized app=github owner=${owner} repo=${repo} reason=signature_invalid`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const event = String(c.req.header('x-github-event') ?? '').trim() || 'unknown';
  const delivery = String(c.req.header('x-github-delivery') ?? '').trim();
  const rawMessage = toUtf8(rawBody);

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(rawMessage);
  } catch {
    parsedPayload = rawMessage;
  }

  const action = typeof parsedPayload === 'object' && parsedPayload !== null
    ? String(parsedPayload.action ?? '').trim()
    : '';

  logDebugPayload('incoming_payload', {
    app: 'github',
    path,
    owner,
    repo,
    event,
    action,
    delivery,
    sessionKey: appConfig.sessionKey,
    bytes: body.byteLength,
    bodyPreview: previewText(rawMessage),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const message = JSON.stringify({
      source: 'github',
      owner,
      repo,
      repository: `${owner}/${repo}`,
      event,
      action,
      delivery,
      payload: parsedPayload,
    });

    const payload = JSON.stringify({
      name: `github:${owner}/${repo}`,
      message,
      sessionKey: appConfig.sessionKey,
      wakeMode: 'now',
      deliver: true,
    });

    logDebugPayload('forward_payload', {
      app: 'github',
      owner,
      repo,
      event,
      action,
      targetAgent: appConfig.targetAgent,
      ...buildForwardEnvelopeDebug(payload),
    });

    const agentConfig = config.agents[appConfig.targetAgent];
    const upstream = await forwardToAgent(agentConfig, payload, controller.signal);

    log('info', `[api-proxy] app=github owner=${owner} repo=${repo} event=${event} action=${action || 'none'} agent=${appConfig.targetAgent} sessionKey=${appConfig.sessionKey} status=${upstream.status} bytes=${body.byteLength}`);
    return upstream;
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[api-proxy] app=github owner=${owner} repo=${repo} event=${event} error=${messageText}`);
    return c.json({ ok: false, error: messageText }, code);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleWebformWebhook(c) {
  const path = new URL(c.req.url).pathname;
  const agentId = String(c.req.param('agentId') ?? '').trim();
  const formId = String(c.req.param('formId') ?? '').trim();
  const agentConfig = config.agents[agentId];

  if (!agentConfig) {
    log('warn', `[api-proxy] unknown_agent path=${path} agent=${agentId || 'none'}`);
    return c.json({ ok: false, error: 'unknown_agent' }, 404);
  }

  if (!formId) {
    log('warn', `[api-proxy] missing_form_id path=${path} agent=${agentId}`);
    return c.json({ ok: false, error: 'missing_form_id' }, 400);
  }

  const body = await c.req.arrayBuffer();
  const message = toUtf8(body);
  logDebugPayload('incoming_payload', {
    app: 'webform',
    path,
    formId,
    agentId,
    bytes: body.byteLength,
    bodyPreview: previewText(message),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const payload = JSON.stringify({
      name: `webform:${formId}`,
      message,
      sessionKey: `hook:webform:${formId}`,
      wakeMode: 'next-heartbeat',
      deliver: false,
    });

    logDebugPayload('forward_payload', {
      app: 'webform',
      ...buildForwardEnvelopeDebug(payload),
    });

    const upstream = await forwardToAgent(agentConfig, payload, controller.signal);
    log('info', `[api-proxy] app=webform form=${formId} agent=${agentId} status=${upstream.status} bytes=${body.byteLength}`);
    return upstream;
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[api-proxy] app=webform form=${formId} agent=${agentId} error=${messageText}`);
    return c.json({ ok: false, error: messageText }, code);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleGmailWebhook(c) {
  const path = new URL(c.req.url).pathname;
  const agentId = String(c.req.param('agentId') ?? '').trim();
  const appConfig = config.apps.gmail;

  if (!appConfig) {
    log('warn', `[api-proxy] gmail_not_configured path=${path}`);
    return c.json({ ok: false, error: 'not_configured' }, 404);
  }

  const agentEntry = appConfig.agents?.[agentId];
  if (!agentEntry) {
    log('warn', `[api-proxy] unknown_agent path=${path} agent=${agentId || 'none'}`);
    return c.json({ ok: false, error: 'unknown_agent' }, 404);
  }

  // Verify GCP Pub/Sub OIDC JWT (sent in Authorization: Bearer header)
  const authHeader = c.req.header('authorization') ?? '';
  const jwt = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!jwt) {
    log('warn', `[api-proxy] unauthorized app=gmail agent=${agentId} reason=missing_jwt`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  try {
    const audience = `https://api.namche.ai/v1/webhooks/agents/${agentId}/gmail`;
    const { payload } = await jwtVerify(jwt, GOOGLE_JWKS, {
      issuer: 'https://accounts.google.com',
      audience,
    });
    if (payload.email !== agentEntry.oidcEmail) {
      log('warn', `[api-proxy] unauthorized app=gmail agent=${agentId} reason=email_mismatch got=${payload.email}`);
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
  } catch (err) {
    log('warn', `[api-proxy] unauthorized app=gmail agent=${agentId} reason=jwt_invalid err=${err?.message}`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const body = await c.req.arrayBuffer();
  const bodyBuffer = Buffer.from(body);
  logDebugPayload('incoming_payload', {
    app: 'gmail',
    path,
    agentId,
    bytes: body.byteLength,
    contentType: c.req.header('content-type') ?? 'application/json',
    bodyPreview: previewText(toUtf8(bodyBuffer)),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    logDebugPayload('forward_payload', {
      app: 'gmail',
      targetUrl: agentEntry.forwardUrl,
      bytes: body.byteLength,
      contentType: c.req.header('content-type') ?? 'application/json',
      bodyPreview: previewText(toUtf8(bodyBuffer)),
    });

    const upstream = await fetch(agentEntry.forwardUrl, {
      method: 'POST',
      headers: {
        'content-type': c.req.header('content-type') ?? 'application/json',
        'x-api-proxy': 'api-proxy',
      },
      body,
      signal: controller.signal,
    });

    const responseBody = await upstream.arrayBuffer();
    log('info', `[api-proxy] app=gmail agent=${agentId} status=${upstream.status} bytes=${body.byteLength}`);
    return new Response(responseBody, { status: upstream.status });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[api-proxy] app=gmail agent=${agentId} error=${messageText}`);
    return c.json({ ok: false, error: messageText }, code);
  } finally {
    clearTimeout(timeout);
  }
}

async function forwardToAgent(agentConfig, payload, signal) {
  const url = buildHooksUrl(agentConfig.url);
  const upstream = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: agentConfig.openclawHooksToken,
      'content-type': 'application/json',
      'x-api-proxy': 'api-proxy',
    },
    body: payload,
    signal,
  });

  const responseBody = await upstream.arrayBuffer();
  const responseHeaders = new Headers();
  const contentType = upstream.headers.get('content-type');

  if (contentType) {
    responseHeaders.set('content-type', contentType);
  }

  return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
}
