import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

const listenHost = process.env.HOST ?? '0.0.0.0';
const listenPort = Number(process.env.PORT ?? 8787);

const KRISP_HOST = {
  id: 'tashi',
  targetBaseUrl: 'https://tashi.silverside-mermaid.ts.net',
  timeoutMs: 15000,
};

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  await next();
  const durationMs = Date.now() - startedAt;
  console.log(`[namche-api-proxy] request method=${c.req.method} path=${new URL(c.req.url).pathname} status=${c.res.status} duration_ms=${durationMs}`);
});

function buildKrispHookUrl(baseUrl) {
  const root = String(baseUrl ?? '').replace(/\/$/, '');
  return `${root}/hooks/agent`;
}

async function handleKrispWebhook(c) {
  const path = new URL(c.req.url).pathname;

  const krispSecret = process.env.KRISP_WEBHOOK_SECRET;
  if (!krispSecret) {
    console.error("[namche-api-proxy] config_error missing_env=KRISP_WEBHOOK_SECRET");
    return c.json({ ok: false, error: "Missing env 'KRISP_WEBHOOK_SECRET'" }, 500);
  }

  const expectedAuth = `Bearer ${krispSecret}`;
  const providedAuth = c.req.header('authorization');
  if (!providedAuth || providedAuth !== expectedAuth) {
    console.warn(`[namche-api-proxy] unauthorized source=krisp reason=authorization path=${path}`);
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }

  const openclawHooksToken = process.env.OPENCLAW_HOOKS_TOKEN_TASHI;
  if (!openclawHooksToken) {
    console.error("[namche-api-proxy] config_error missing_env=OPENCLAW_HOOKS_TOKEN_TASHI");
    return c.json({ ok: false, error: "Missing env 'OPENCLAW_HOOKS_TOKEN_TASHI'" }, 500);
  }

  const body = await c.req.arrayBuffer();
  const timeoutMs = Number(KRISP_HOST.timeoutMs ?? 15000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = buildKrispHookUrl(KRISP_HOST.targetBaseUrl);
    const payload = JSON.stringify({
      name: 'notetaker:krisp',
      message: Buffer.from(body).toString('utf8'),
      deliver: true,
      wakeMode: 'now',
    });

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

    console.log(`[namche-api-proxy] source=krisp host=${KRISP_HOST.id} status=${upstream.status} bytes=${body.byteLength}`);
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const message = error instanceof Error ? error.message : 'forward request failed';
    console.error(`[namche-api-proxy] source=krisp host=${KRISP_HOST.id} error=${message}`);
    return c.json({ ok: false, error: message }, code);
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
  });
});

app.post('/v1/webhooks/apps/krisp', handleKrispWebhook);

app.post('/v1/webhooks/apps/*', (c) => {
  console.warn(`[namche-api-proxy] invalid_path family=apps path=${new URL(c.req.url).pathname}`);
  return c.json({ ok: false, error: 'invalid_path' }, 400);
});

app.post('/v1/webhooks/hosts/*', (c) => {
  console.warn(`[namche-api-proxy] invalid_path family=hosts path=${new URL(c.req.url).pathname}`);
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
  console.log(`[namche-api-proxy] listening on ${listenHost}:${listenPort}`);
});
