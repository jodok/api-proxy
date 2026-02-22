import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

const listenHost = process.env.HOST ?? '0.0.0.0';
const listenPort = Number(process.env.PORT ?? 8787);
const agents = {
  tashi: {
    targetBaseUrl: 'http://100.64.0.11:8787',
    ingressSecretEnv: 'WEBHOOK_SECRET_TASHI_IN',
    forwardSecretEnv: 'WEBHOOK_SECRET_TASHI_OUT',
    timeoutMs: 15000,
  },
};

function getAgent(agentId) {
  return agents[agentId] ?? null;
}

function buildForwardUrl(baseUrl, source, queryString) {
  const root = String(baseUrl ?? '').replace(/\/$/, '');
  const path = `/webhooks/${encodeURIComponent(source)}`;
  return queryString ? `${root}${path}?${queryString}` : `${root}${path}`;
}

function buildForwardHeaders(requestHeaders, remoteAddress, hostHeader, forwardSecret) {
  const headers = new Headers();

  for (const [key, value] of requestHeaders.entries()) {
    const lower = key.toLowerCase();

    if (lower === 'host' || lower === 'content-length') continue;
    if (lower.startsWith('x-') || lower === 'content-type' || lower === 'user-agent' || lower === 'authorization') {
      headers.set(key, value);
    }
  }

  const existingForwardedFor = headers.get('x-forwarded-for');
  if (!existingForwardedFor && remoteAddress) {
    headers.set('x-forwarded-for', remoteAddress);
  }
  if (hostHeader) headers.set('x-forwarded-host', hostHeader);
  headers.set('x-namche-proxy', 'namche-api-proxy');

  if (forwardSecret) {
    headers.set('x-webhook-secret', forwardSecret);
  }

  return headers;
}

app.get('/healthz', (c) => {
  return c.json({ ok: true, service: 'namche-api-proxy', agents: Object.keys(agents) });
});

app.post('/webhooks/:agent/:source', async (c) => {
  const agentId = c.req.param('agent');
  const source = c.req.param('source');
  const agent = getAgent(agentId);

  if (!agent) {
    return c.json({ ok: false, error: `Unknown agent '${agentId}'` }, 404);
  }

  const ingressSecretEnv = agent.ingressSecretEnv;
  const expectedIngressSecret = ingressSecretEnv ? process.env[ingressSecretEnv] : undefined;

  if (expectedIngressSecret) {
    const provided = c.req.header('x-webhook-secret');
    if (!provided || provided !== expectedIngressSecret) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const targetBaseUrl = agent.targetBaseUrl;
  if (!targetBaseUrl) {
    return c.json({ ok: false, error: `Missing targetBaseUrl for agent '${agentId}'` }, 500);
  }

  const forwardSecretEnv = agent.forwardSecretEnv;
  const forwardSecret = forwardSecretEnv ? process.env[forwardSecretEnv] : undefined;

  const body = await c.req.arrayBuffer();
  const queryString = new URL(c.req.url).searchParams.toString();
  const url = buildForwardUrl(targetBaseUrl, source, queryString);
  const headers = buildForwardHeaders(c.req.raw.headers, c.env?.incoming?.remote?.address, c.req.header('host'), forwardSecret);

  const timeoutMs = Number(agent.timeoutMs ?? 15000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const upstream = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    const responseBody = await upstream.arrayBuffer();
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get('content-type');

    if (contentType) {
      responseHeaders.set('content-type', contentType);
    }

    console.log(`[namche-api-proxy] agent=${agentId} source=${source} status=${upstream.status} bytes=${body.byteLength}`);
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const message = error instanceof Error ? error.message : 'forward request failed';
    console.error(`[namche-api-proxy] agent=${agentId} source=${source} error=${message}`);
    return c.json({ ok: false, error: message }, code);
  } finally {
    clearTimeout(timeout);
  }
});

app.all('*', (c) => {
  return c.json({
    ok: false,
    error: 'not_found',
    usage: 'POST /webhooks/:agent/:source',
    agents: Object.keys(agents),
  }, 404);
});

serve({ fetch: app.fetch, hostname: listenHost, port: listenPort }, () => {
  console.log(`[namche-api-proxy] listening on ${listenHost}:${listenPort}`);
});
