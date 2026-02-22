import crypto from 'node:crypto';

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

const app = new Hono();

const listenHost = process.env.HOST ?? '0.0.0.0';
const listenPort = Number(process.env.PORT ?? 8787);

const hosts = {
  tashi: {
    targetBaseUrl: 'https://tashi.silverside-mermaid.ts.net',
    timeoutMs: 15000,
  },
  pema: {
    targetBaseUrl: 'https://pema.silverside-mermaid.ts.net',
    timeoutMs: 15000,
  },
  nima: {
    targetBaseUrl: 'https://nima.silverside-mermaid.ts.net',
    timeoutMs: 15000,
  },
};

const sources = {
  github: {
    auth: 'github_signature',
    secretEnv: 'GITHUB_WEBHOOK_SECRET',
  },
  krisp: {
    auth: 'bearer_secret',
    secretEnv: 'KRISP_WEBHOOK_SECRET',
  },
};

function getHost(hostId) {
  return hosts[hostId] ?? null;
}

function getSource(sourceId) {
  return sources[sourceId] ?? null;
}

function buildForwardUrl(baseUrl, source, queryString) {
  const root = String(baseUrl ?? '').replace(/\/$/, '');
  const path = `/webhooks/${encodeURIComponent(source)}`;
  return queryString ? `${root}${path}?${queryString}` : `${root}${path}`;
}

function buildKrispHookUrl(baseUrl) {
  const root = String(baseUrl ?? '').replace(/\/$/, '');
  return `${root}/hooks/agent`;
}

function buildForwardHeaders(requestHeaders, remoteAddress, hostHeader) {
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

  return headers;
}

function verifyGithubSignature(bodyBytes, providedSignature, secret) {
  if (!providedSignature || !providedSignature.startsWith('sha256=')) {
    return false;
  }

  const expectedDigest = crypto
    .createHmac('sha256', secret)
    .update(bodyBytes)
    .digest('hex');
  const expectedSignature = `sha256=${expectedDigest}`;

  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (providedBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

function parseAppsPath(pathParam) {
  const segments = String(pathParam ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length < 2) return null;

  if (segments[1] === 'hosts') {
    if (segments.length < 3) return null;
    return {
      source: segments[0],
      host: segments[2],
      topic: segments[3] ?? segments[0],
    };
  }

  return {
    source: segments[0],
    host: segments[1],
    topic: segments[2] ?? segments[0],
  };
}

function parseHostsPath(pathParam) {
  const segments = String(pathParam ?? '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);

  if (segments.length < 2) return null;

  if (segments[1] === 'apps') {
    if (segments.length < 3) return null;
    return {
      host: segments[0],
      source: segments[2],
      topic: segments[3] ?? segments[2],
    };
  }

  return {
    host: segments[0],
    source: segments[1],
    topic: segments[2] ?? segments[1],
  };
}

async function handleWebhookForward(c, resolved) {
  const sourceId = resolved.source;
  const hostId = resolved.host;
  const topic = resolved.topic;

  const source = getSource(sourceId);
  if (!source) {
    return c.json({ ok: false, error: `Unknown source '${sourceId}'` }, 404);
  }

  const host = getHost(hostId);
  if (!host) {
    return c.json({ ok: false, error: `Unknown host '${hostId}'` }, 404);
  }

  let body;

  if (source.auth === 'github_signature' || sourceId !== 'krisp') {
    body = await c.req.arrayBuffer();
  }

  if (source.auth === 'github_signature') {
    const secret = process.env[source.secretEnv];
    if (!secret) {
      return c.json({ ok: false, error: `Missing env '${source.secretEnv}'` }, 500);
    }

    const signature = c.req.header('x-hub-signature-256');
    const ok = verifyGithubSignature(new Uint8Array(body), signature, secret);
    if (!ok) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  if (source.auth === 'bearer_secret') {
    const secret = process.env[source.secretEnv];
    if (!secret) {
      return c.json({ ok: false, error: `Missing env '${source.secretEnv}'` }, 500);
    }

    const expectedAuth = `Bearer ${secret}`;
    const providedAuth = c.req.header('authorization');
    if (!providedAuth || providedAuth !== expectedAuth) {
      return c.json({ ok: false, error: 'unauthorized' }, 401);
    }
  }

  const timeoutMs = Number(host.timeoutMs ?? 15000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let upstream;

    if (sourceId === 'krisp') {
      if (hostId !== 'tashi') {
        return c.json({ ok: false, error: "krisp_forwarding_only_supported_for_host 'tashi'" }, 400);
      }

      const openclawHooksToken = process.env.OPENCLAW_HOOKS_TOKEN_TASHI;
      if (!openclawHooksToken) {
        return c.json({ ok: false, error: "Missing env 'OPENCLAW_HOOKS_TOKEN_TASHI'" }, 500);
      }

      const url = buildKrispHookUrl(host.targetBaseUrl);
      const payload = JSON.stringify({
        name: 'notetaker:krisp',
        message: Buffer.from(body).toString('utf8'),
        deliver: true,
        wakeMode: 'now',
      });

      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${openclawHooksToken}`,
          'content-type': 'application/json',
          'x-namche-proxy': 'namche-api-proxy',
        },
        body: payload,
        signal: controller.signal,
      });
    } else {
      const queryString = new URL(c.req.url).searchParams.toString();
      const url = buildForwardUrl(host.targetBaseUrl, topic, queryString);
      const headers = buildForwardHeaders(c.req.raw.headers, c.env?.incoming?.remote?.address, c.req.header('host'));

      upstream = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    }

    const responseBody = await upstream.arrayBuffer();
    const responseHeaders = new Headers();
    const contentType = upstream.headers.get('content-type');

    if (contentType) {
      responseHeaders.set('content-type', contentType);
    }

    console.log(`[namche-api-proxy] source=${sourceId} topic=${topic} host=${hostId} status=${upstream.status} bytes=${body ? body.byteLength : 0}`);
    return new Response(responseBody, { status: upstream.status, headers: responseHeaders });
  } catch (error) {
    const code = error?.name === 'AbortError' ? 504 : 502;
    const message = error instanceof Error ? error.message : 'forward request failed';
    console.error(`[namche-api-proxy] source=${sourceId} topic=${topic} host=${hostId} error=${message}`);
    return c.json({ ok: false, error: message }, code);
  } finally {
    clearTimeout(timeout);
  }
}

app.get('/healthz', (c) => {
  return c.json({
    ok: true,
    service: 'namche-api-proxy',
    sources: Object.keys(sources),
    hosts: Object.keys(hosts),
    routes: [
      '/v1/webhooks/apps/*',
      '/v1/webhooks/hosts/*',
    ],
  });
});

app.post('/v1/webhooks/apps/*', async (c) => {
  const resolved = parseAppsPath(c.req.param('*'));
  if (!resolved) {
    return c.json({ ok: false, error: 'invalid_path' }, 400);
  }
  return handleWebhookForward(c, resolved);
});

app.post('/v1/webhooks/hosts/*', async (c) => {
  const resolved = parseHostsPath(c.req.param('*'));
  if (!resolved) {
    return c.json({ ok: false, error: 'invalid_path' }, 400);
  }
  return handleWebhookForward(c, resolved);
});

app.all('*', (c) => {
  return c.json({
    ok: false,
    error: 'not_found',
    usage: [
      'POST /v1/webhooks/apps/:source/hosts/:host',
      'POST /v1/webhooks/apps/:source/:host',
      'POST /v1/webhooks/hosts/:host/apps/:source',
      'POST /v1/webhooks/hosts/:host/:source',
    ],
    sources: Object.keys(sources),
    hosts: Object.keys(hosts),
  }, 404);
});

serve({ fetch: app.fetch, hostname: listenHost, port: listenPort }, () => {
  console.log(`[namche-api-proxy] listening on ${listenHost}:${listenPort}`);
});
