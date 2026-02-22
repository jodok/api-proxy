import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

const listenHost = process.env.HOST ?? '0.0.0.0';
const listenPort = Number(process.env.PORT ?? 8787);

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const configuredLogLevel = String(process.env.LOG_LEVEL ?? 'info').toLowerCase();
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

const KRISP_HOST = {
  id: 'tashi',
  targetBaseUrl: 'https://tashi.silverside-mermaid.ts.net',
  timeoutMs: 15000,
};

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  await next();
  const durationMs = Date.now() - startedAt;
  log('info', `[namche-api-proxy] request method=${c.req.method} path=${new URL(c.req.url).pathname} status=${c.res.status} duration_ms=${durationMs}`);
});

function buildKrispHookUrl(baseUrl) {
  const root = String(baseUrl ?? '').replace(/\/$/, '');
  return `${root}/hooks/agent`;
}

async function handleKrispWebhook(c) {
  const path = new URL(c.req.url).pathname;

  const krispAuthorization = process.env.KRISP_AUTHORIZATION;
  if (!krispAuthorization) {
    log('error', "[namche-api-proxy] config_error missing_env=KRISP_AUTHORIZATION");
    return c.json({ ok: false, error: "Missing env 'KRISP_AUTHORIZATION'" }, 500);
  }

  const providedAuth = c.req.header('authorization');
  if (!providedAuth || providedAuth !== krispAuthorization) {
    log('warn', `[namche-api-proxy] unauthorized source=krisp reason=authorization path=${path}`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const openclawHooksToken = process.env.OPENCLAW_HOOKS_TOKEN_TASHI;
  if (!openclawHooksToken) {
    log('error', "[namche-api-proxy] config_error missing_env=OPENCLAW_HOOKS_TOKEN_TASHI");
    return c.json({ ok: false, error: "Missing env 'OPENCLAW_HOOKS_TOKEN_TASHI'" }, 500);
  }

  const body = await c.req.arrayBuffer();
  const message = Buffer.from(body).toString('utf8');

  if (shouldLog('debug')) {
    log('debug', `[namche-api-proxy] krisp_incoming_payload path=${path} bytes=${body.byteLength} body=${message}`);
  }

  const timeoutMs = Number(KRISP_HOST.timeoutMs ?? 15000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = buildKrispHookUrl(KRISP_HOST.targetBaseUrl);
    const payload = JSON.stringify({
      name: 'notetaker:krisp',
      message,
      deliver: true,
      wakeMode: 'now',
    });

    if (shouldLog('debug')) {
      log('debug', `[namche-api-proxy] krisp_forward_payload host=${KRISP_HOST.id} body=${payload}`);
    }

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${openclawHooksToken}`,
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

    log('info', `[namche-api-proxy] source=krisp host=${KRISP_HOST.id} status=${upstream.status} bytes=${body.byteLength}`);
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const errMessage = error instanceof Error ? error.message : 'forward request failed';
    log('error', `[namche-api-proxy] source=krisp host=${KRISP_HOST.id} error=${errMessage}`);
    return c.json({ ok: false, error: errMessage }, code);
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/healthz', (c) => {
  return c.json({
    ok: true,
    service: 'namche-api-proxy',
    sources: ['krisp'],
    hosts: [KRISP_HOST.id],
    routes: ['/v1/webhooks/apps/krisp'],
    logLevel: configuredLogLevel,
  });
});

app.post('/v1/webhooks/apps/krisp', handleKrispWebhook);

app.post('/v1/webhooks/apps/*', (c) => {
  log('warn', `[namche-api-proxy] invalid_path family=apps path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.post('/v1/webhooks/hosts/*', (c) => {
  log('warn', `[namche-api-proxy] invalid_path family=hosts path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.all('*', (c) => {
  return c.json({
    ok: false,
    error: 'not_found',
    usage: [
      'POST /v1/webhooks/apps/krisp',
    ],
  }, 404);
});

serve({ fetch: app.fetch, hostname: listenHost, port: listenPort }, () => {
  log('info', `[namche-api-proxy] listening on ${listenHost}:${listenPort} log_level=${configuredLogLevel}`);
});
