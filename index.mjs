import { existsSync, readFileSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import yaml from 'js-yaml';

const app = new Hono();

const DEFAULT_CONFIG_PATH = '/etc/namche-api-proxy/config.yaml';
const configPath = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH;
const FORWARD_TIMEOUT_MS = 15000;

const APP_DEFINITIONS = {
  krisp: {
    path: '/v1/webhooks/apps/krisp',
    payloadName: 'notetaker:krisp',
  },
};

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

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  await next();
  const durationMs = Date.now() - startedAt;
  log('info', `[namche-api-proxy] request method=${c.req.method} path=${new URL(c.req.url).pathname} status=${c.res.status} duration_ms=${durationMs}`);
});

app.use('/v1/webhooks/agents/*', cors({
  origin: config.webformAllowedOrigins,
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  maxAge: 86400,
}));

app.get('/healthz', (c) => {
  const routes = [
    ...Object.values(APP_DEFINITIONS).map((def) => def.path),
    '/v1/webhooks/agents/:agentId/complaint',
  ];

  return c.json({
    ok: true,
    service: 'namche-api-proxy',
    configPath,
    logLevel: configuredLogLevel,
    apps: Object.keys(APP_DEFINITIONS),
    agents: Object.keys(config.agents),
    webformAllowedOrigins: config.webformAllowedOrigins,
    routes,
  });
});

app.post(APP_DEFINITIONS.krisp.path, handleKrispWebhook);
app.post('/v1/webhooks/agents/:agentId/complaint', handleAgentComplaintWebhook);

app.post('/v1/webhooks/apps/*', (c) => {
  log('warn', `[namche-api-proxy] invalid_path family=apps path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.post('/v1/webhooks/agents/*', (c) => {
  log('warn', `[namche-api-proxy] invalid_path family=agents path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.all('*', (c) => {
  const usage = [
    ...Object.values(APP_DEFINITIONS).map((def) => `POST ${def.path}`),
    'POST /v1/webhooks/agents/:agentId/complaint',
  ];

  return c.json({
    ok: false,
    error: 'not_found',
    usage,
  }, 404);
});

serve({ fetch: app.fetch, hostname: config.listen.host, port: config.listen.port }, () => {
  log('info', `[namche-api-proxy] listening on ${config.listen.host}:${config.listen.port} log_level=${configuredLogLevel} config=${configPath}`);
});

function loadConfig(path) {
  if (!existsSync(path)) {
    throw new Error(`[namche-api-proxy] Config file not found at ${path}`);
  }

  const raw = readFileSync(path, 'utf8');
  const parsed = yaml.load(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('[namche-api-proxy] Config file is empty or invalid');
  }

  return parsed;
}

function normalizeConfig(raw) {
  const listen = raw.listen ?? {};
  const agents = raw.agents ?? {};
  const apps = raw.apps ?? {};
  const webformAllowedOrigins = Array.isArray(raw.WEBFORM_ALLOWED_ORIGINS)
    ? raw.WEBFORM_ALLOWED_ORIGINS
    : ['https://tashi.namche.ai'];

  if (!agents || typeof agents !== 'object') {
    throw new Error('[namche-api-proxy] Config must define agents object');
  }

  if (!apps || typeof apps !== 'object') {
    throw new Error('[namche-api-proxy] Config must define apps object');
  }

  const normalizedWebformAllowedOrigins = webformAllowedOrigins
    .map((origin) => String(origin ?? '').trim())
    .filter(Boolean);

  if (normalizedWebformAllowedOrigins.length === 0) {
    throw new Error('[namche-api-proxy] WEBFORM_ALLOWED_ORIGINS must include at least one origin');
  }

  const normalizedAgents = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent || typeof agent !== 'object') {
      throw new Error(`[namche-api-proxy] Invalid agent config for '${agentId}'`);
    }

    const url = String(agent.url ?? '').trim();
    const openclawHooksToken = String(agent.openclawHooksToken ?? '').trim();

    if (!url) {
      throw new Error(`[namche-api-proxy] Agent '${agentId}' missing url`);
    }

    if (!openclawHooksToken) {
      throw new Error(`[namche-api-proxy] Agent '${agentId}' missing openclawHooksToken`);
    }

    normalizedAgents[agentId] = {
      url,
      openclawHooksToken,
    };
  }

  const normalizedApps = {};
  for (const [appId, appDef] of Object.entries(APP_DEFINITIONS)) {
    const appConfig = apps[appId];
    if (!appConfig || typeof appConfig !== 'object') {
      throw new Error(`[namche-api-proxy] App '${appId}' config is required`);
    }

    const incomingAuthorization = String(appConfig.incomingAuthorization ?? '').trim();
    const targetAgent = String(appConfig.targetAgent ?? '').trim();

    if (!incomingAuthorization) {
      throw new Error(`[namche-api-proxy] App '${appId}' missing incomingAuthorization`);
    }

    if (!targetAgent) {
      throw new Error(`[namche-api-proxy] App '${appId}' missing targetAgent`);
    }

    if (!normalizedAgents[targetAgent]) {
      throw new Error(`[namche-api-proxy] App '${appId}' references unknown agent '${targetAgent}'`);
    }

    normalizedApps[appId] = {
      ...appDef,
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
    webformAllowedOrigins: normalizedWebformAllowedOrigins,
    agents: normalizedAgents,
    apps: normalizedApps,
  };
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
  const appConfig = config.apps.krisp;
  const agentConfig = config.agents[appConfig.targetAgent];

  const providedAuth = c.req.header('authorization');
  if (!authorizationMatches(providedAuth, appConfig.incomingAuthorization)) {
    if (shouldLog('debug')) {
      const providedScheme = getAuthScheme(providedAuth);
      const expectedScheme = getAuthScheme(appConfig.incomingAuthorization);
      const providedLen = providedAuth ? providedAuth.trim().length : 0;
      const expectedLen = appConfig.incomingAuthorization.trim().length;
      log('debug', `[namche-api-proxy] auth_mismatch app=krisp provided_scheme=${providedScheme} expected_scheme=${expectedScheme} provided_len=${providedLen} expected_len=${expectedLen}`);
    }

    log('warn', `[namche-api-proxy] unauthorized app=krisp reason=authorization path=${path}`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const body = await c.req.arrayBuffer();
  const message = Buffer.from(body).toString('utf8');

  if (shouldLog('debug')) {
    log('debug', `[namche-api-proxy] incoming_payload app=krisp bytes=${body.byteLength} body=${message}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const payload = JSON.stringify({
      name: APP_DEFINITIONS.krisp.payloadName,
      message,
      deliver: true,
      wakeMode: 'now',
    });

    if (shouldLog('debug')) {
      log('debug', `[namche-api-proxy] forward_payload app=krisp agent=${appConfig.targetAgent} body=${payload}`);
    }

    const upstream = await forwardToAgent(agentConfig, payload, controller.signal);

    log('info', `[namche-api-proxy] app=krisp agent=${appConfig.targetAgent} status=${upstream.status} bytes=${body.byteLength}`);
    return upstream;
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[namche-api-proxy] app=krisp agent=${appConfig.targetAgent} error=${messageText}`);
    return c.json({ ok: false, error: messageText }, code);
  } finally {
    clearTimeout(timeout);
  }
}

async function handleAgentComplaintWebhook(c) {
  const path = new URL(c.req.url).pathname;
  const agentId = String(c.req.param('agentId') ?? '').trim();
  const agentConfig = config.agents[agentId];

  if (!agentConfig) {
    log('warn', `[namche-api-proxy] unknown_agent path=${path} agent=${agentId || 'none'}`);
    return c.json({ ok: false, error: 'unknown_agent' }, 404);
  }

  const body = await c.req.arrayBuffer();
  const message = Buffer.from(body).toString('utf8');

  if (shouldLog('debug')) {
    log('debug', `[namche-api-proxy] incoming_payload app=webform-complaint agent=${agentId} bytes=${body.byteLength} body=${message}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);

  try {
    const payload = JSON.stringify({
      name: 'complaint:webform',
      message,
      deliver: true,
      wakeMode: 'now',
    });

    if (shouldLog('debug')) {
      log('debug', `[namche-api-proxy] forward_payload app=webform-complaint agent=${agentId} body=${payload}`);
    }

    const upstream = await forwardToAgent(agentConfig, payload, controller.signal);
    log('info', `[namche-api-proxy] app=webform-complaint agent=${agentId} status=${upstream.status} bytes=${body.byteLength}`);
    return upstream;
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[namche-api-proxy] app=webform-complaint agent=${agentId} error=${messageText}`);
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
      'x-namche-proxy': 'namche-api-proxy',
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
