import { existsSync, readFileSync } from 'node:fs';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
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

app.get('/healthz', (c) => {
  return c.json({
    ok: true,
    service: 'namche-api-proxy',
    configPath,
    logLevel: configuredLogLevel,
    apps: Object.keys(APP_DEFINITIONS),
    bots: Object.keys(config.bots),
    routes: Object.values(APP_DEFINITIONS).map((def) => def.path),
  });
});

app.post(APP_DEFINITIONS.krisp.path, handleKrispWebhook);

app.post('/v1/webhooks/apps/*', (c) => {
  log('warn', `[namche-api-proxy] invalid_path family=apps path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.post('/v1/webhooks/bots/*', (c) => {
  log('warn', `[namche-api-proxy] invalid_path family=bots path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.all('*', (c) => {
  return c.json({
    ok: false,
    error: 'not_found',
    usage: Object.values(APP_DEFINITIONS).map((def) => `POST ${def.path}`),
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
  const bots = raw.bots ?? {};
  const apps = raw.apps ?? {};

  if (!bots || typeof bots !== 'object') {
    throw new Error('[namche-api-proxy] Config must define bots object');
  }

  if (!apps || typeof apps !== 'object') {
    throw new Error('[namche-api-proxy] Config must define apps object');
  }

  const normalizedBots = {};
  for (const [botId, bot] of Object.entries(bots)) {
    if (!bot || typeof bot !== 'object') {
      throw new Error(`[namche-api-proxy] Invalid bot config for '${botId}'`);
    }

    const url = String(bot.url ?? '').trim();
    const openclawHooksToken = String(bot.openclawHooksToken ?? '').trim();

    if (!url) {
      throw new Error(`[namche-api-proxy] Bot '${botId}' missing url`);
    }

    if (!openclawHooksToken) {
      throw new Error(`[namche-api-proxy] Bot '${botId}' missing openclawHooksToken`);
    }

    normalizedBots[botId] = {
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
    const targetBot = String(appConfig.targetBot ?? '').trim();

    if (!incomingAuthorization) {
      throw new Error(`[namche-api-proxy] App '${appId}' missing incomingAuthorization`);
    }

    if (!targetBot) {
      throw new Error(`[namche-api-proxy] App '${appId}' missing targetBot`);
    }

    if (!normalizedBots[targetBot]) {
      throw new Error(`[namche-api-proxy] App '${appId}' references unknown bot '${targetBot}'`);
    }

    normalizedApps[appId] = {
      ...appDef,
      incomingAuthorization,
      targetBot,
    };
  }

  return {
    listen: {
      host: String(listen.host ?? '127.0.0.1'),
      port: Number(listen.port ?? 3000),
    },
    logLevel: String(raw.logLevel ?? 'info').toLowerCase(),
    bots: normalizedBots,
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
  const botConfig = config.bots[appConfig.targetBot];

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
    const url = buildHooksUrl(botConfig.url);
    const payload = JSON.stringify({
      name: APP_DEFINITIONS.krisp.payloadName,
      message,
      deliver: true,
      wakeMode: 'now',
    });

    if (shouldLog('debug')) {
      log('debug', `[namche-api-proxy] forward_payload app=krisp bot=${appConfig.targetBot} url=${url} body=${payload}`);
    }

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: botConfig.openclawHooksToken,
        'content-type': 'application/json',
        'x-namche-proxy': 'namche-api-proxy',
      },
      body: payload,
      signal: controller.signal,
    });

    const responseBody = await upstream.arrayBuffer();
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get('content-type');

    if (contentType) {
      responseHeaders.set('content-type', contentType);
    }

    log('info', `[namche-api-proxy] app=krisp bot=${appConfig.targetBot} status=${upstream.status} bytes=${body.byteLength}`);
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const messageText = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[namche-api-proxy] app=krisp bot=${appConfig.targetBot} error=${messageText}`);
    return c.json({ ok: false, error: messageText }, code);
  } finally {
    clearTimeout(timeout);
  }
}
