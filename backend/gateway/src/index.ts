/**
 * LUMINA gateway — the software backend, and the only service the browser talks to.
 *
 * It owns browser-facing concerns and nothing else: CORS, the X-User-Id check, the request id,
 * the request log, body validation, the rate limit, and passing the stream through untouched.
 * No provider key is ever read here, and no decision about cost, depth or spend is made here —
 * those live in the agent service, which the browser cannot reach.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cors from 'cors';
import express from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import {
  AskBody,
  CreateSpaceBody,
  CreateThreadBody,
  HealthResponse,
  REQUEST_HEADER,
  ROUTES,
  USER_HEADER
} from '@lumina/contract';
import { env } from './env.js';

const log = pino({ level: env.logLevel });
const app = express();

app.disable('x-powered-by');
app.use(cors({ origin: env.corsOrigins, credentials: false, exposedHeaders: [REQUEST_HEADER] }));

app.use((req, res, next) => {
  const id = (req.header(REQUEST_HEADER) ?? `req_${randomUUID().slice(0, 12)}`).trim();
  res.locals.requestId = id;
  res.setHeader(REQUEST_HEADER, id);
  next();
});

app.use(
  pinoHttp({
    logger: log,
    genReqId: (_req, res) => String(res.locals.requestId),
    customProps: (req, res) => ({
      requestId: res.locals.requestId,
      userId: req.header(USER_HEADER) ?? null
    }),
    autoLogging: true
  })
);

app.use((req, res, next) =>
  req.path.endsWith('/documents') && req.method === 'POST'
    ? next()
    : express.json({ limit: '1mb' })(req, res, next)
);

/**
 * Body that is not JSON at all. express.json throws a SyntaxError, which would otherwise fall
 * through to the catch-all and be reported as 502 — blaming the agent service for a request
 * the browser malformed before anything upstream was ever contacted.
 */
app.use((err: Error & { status?: number; type?: string }, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: `malformed JSON body: ${err.message}`,
      status: 400,
      requestId: String(res.locals.requestId)
    });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'request body too large', status: 413 });
  }
  next(err);
});

// ---------------------------------------------------------------- health

app.get('/health', async (_req, res) => {
  let ai: { status: 'ok' | 'down' } & Record<string, unknown> = { status: 'down' };
  let upstreamBody: Record<string, unknown> = {};
  try {
    const upstream = await fetch(`${env.agentUrl}/health`, { signal: AbortSignal.timeout(3000) });
    upstreamBody = (await upstream.json()) as Record<string, unknown>;
    ai = { status: upstream.ok ? 'ok' : 'down' };
  } catch (err) {
    ai = { status: 'down', error: (err as Error).message };
  }

  const body: HealthResponse = {
    status: ai.status === 'ok' ? 'ok' : 'degraded',
    model: String(upstreamBody.model ?? 'unset'),
    searchProvider: (upstreamBody.searchProvider as HealthResponse['searchProvider']) ?? 'tavily',
    vectorStore: (upstreamBody.vectorStore as HealthResponse['vectorStore']) ?? 'atlas-vector-search',
    db: (upstreamBody.db as HealthResponse['db']) ?? 'down',
    ai
  };
  res.status(ai.status === 'ok' ? 200 : 503).json(body);
});

// ---------------------------------------------------------------- evals page data

/**
 * Public on purpose: a stranger opening the submitted URL has to be able to read the
 * evaluation. Read from disk per request rather than cached at boot, so redeploying the
 * report does not require restarting the gateway.
 */
app.get('/evals/report.json', (_req, res) => {
  const path = resolve(process.cwd(), '../../reports/report.json');
  if (!existsSync(path)) {
    return res.status(404).json({ error: 'no evaluation has been run yet', status: 404 });
  }
  res.type('application/json').send(readFileSync(path, 'utf8'));
});

// ---------------------------------------------------------------- auth & rate limit

const authed = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const userId = String(req.header(USER_HEADER) ?? '').trim();
  if (!userId) {
    return res.status(401).json({
      error: 'X-User-Id is required',
      status: 401,
      requestId: String(res.locals.requestId)
    });
  }
  res.locals.userId = userId;
  next();
};

/**
 * A fixed window per user, held in memory. Deliberately not shared: at one instance it is
 * exact, and the moment the gateway scales out it becomes per-instance, which is the known
 * weakness recorded in DESIGN.md rather than a surprise.
 */
const buckets = new Map<string, { count: number; resetsAt: number }>();

const rateLimited = (_req: express.Request, res: express.Response, next: express.NextFunction) => {
  const key = String(res.locals.userId);
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now >= bucket.resetsAt) {
    buckets.set(key, { count: 1, resetsAt: now + 60_000 });
    return next();
  }
  if (bucket.count >= env.rateLimitPerMinute) {
    return res.status(429).json({
      error: `rate limit of ${env.rateLimitPerMinute} requests/minute exceeded`,
      status: 429,
      resetsAt: new Date(bucket.resetsAt).toISOString(),
      requestId: String(res.locals.requestId)
    });
  }
  bucket.count += 1;
  next();
};

/** Bodies are validated here, against the same schemas the agent service and the UI compile against. */
const validate =
  (schema: { safeParse: (v: unknown) => { success: boolean; error?: { issues: { message: string }[] } } }) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error?.issues[0]?.message ?? 'invalid request body',
        status: 400,
        requestId: String(res.locals.requestId)
      });
    }
    next();
  };

// ---------------------------------------------------------------- the proxy

const hopByHop = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length']);

/**
 * Forward a plain JSON request and hand back exactly what the agent service said. The gateway
 * does not reinterpret a status code it did not generate: a 404 from the agent stays a 404,
 * and only an unreachable agent becomes a 502.
 */
async function proxy(req: express.Request, res: express.Response): Promise<void> {
  const url = `${env.agentUrl}${req.originalUrl}`;
  const headers: Record<string, string> = {
    [USER_HEADER]: String(res.locals.userId),
    [REQUEST_HEADER]: String(res.locals.requestId)
  };

  let body: unknown;
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    if (req.is('multipart/form-data')) {
      // Stream the upload straight through; the gateway never buffers a 25MB file to inspect it.
      for (const [k, v] of Object.entries(req.headers)) {
        if (!hopByHop.has(k) && typeof v === 'string') headers[k] = v;
      }
      body = req;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(req.body ?? {});
    }
  }

  const upstream = await fetch(url, {
    method: req.method,
    headers,
    body,
    // Node needs this to stream a request body rather than buffer it.
    ...(body && req.is('multipart/form-data') ? { duplex: 'half' } : {})
  } as RequestInit);

  res.status(upstream.status);
  const type = upstream.headers.get('content-type');
  if (type) res.setHeader('content-type', type);

  if (upstream.status === 204) {
    res.end();
    return;
  }
  res.send(Buffer.from(await upstream.arrayBuffer()));
}

const forward: express.RequestHandler = (req, res, next) => {
  proxy(req, res).catch(next);
};

/**
 * SSE pass-through. The gateway copies bytes and does not parse frames: a gateway that
 * understood the stream would be a second place for the contract to drift, and any buffering
 * here turns a streamed answer into one that arrives all at once.
 */
const forwardStream: express.RequestHandler = async (req, res, next) => {
  try {
    const upstream = await fetch(`${env.agentUrl}${req.originalUrl}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        [USER_HEADER]: String(res.locals.userId),
        [REQUEST_HEADER]: String(res.locals.requestId)
      },
      body: JSON.stringify(req.body ?? {})
    });

    // Everything that is not a stream is still an ordinary response — a 404, a 429 from the
    // spend cap — and has to reach the browser with its own status code intact.
    if (!upstream.ok || !upstream.body) {
      res.status(upstream.status);
      const type = upstream.headers.get('content-type');
      if (type) res.setHeader('content-type', type);
      return res.send(Buffer.from(await upstream.arrayBuffer()));
    }

    res.status(200);
    res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // If the browser hangs up, stop pulling from the agent rather than finishing a stream
    // nobody is reading.
    const reader = upstream.body.getReader();
    res.on('close', () => void reader.cancel().catch(() => undefined));

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value));
    }
    res.end();
  } catch (err) {
    // The agent is unreachable. Before any byte is written this is an honest 502; after the
    // stream has opened the status is already 200, so the failure travels as an error frame.
    if (res.headersSent) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: 502, error: (err as Error).message })}\n\n`);
      return res.end();
    }
    next(err);
  }
};

// ---------------------------------------------------------------- routes

app.post('/threads', authed, rateLimited, validate(CreateThreadBody), forward);
app.get('/threads', authed, rateLimited, forward);
app.get('/threads/:threadId', authed, rateLimited, forward);
app.post('/threads/:threadId/ask', authed, rateLimited, validate(AskBody), forwardStream);

app.get('/stats', authed, rateLimited, forward);
app.get('/memory', authed, rateLimited, forward);
app.delete('/memory/:memoryId', authed, rateLimited, forward);

app.post('/spaces', authed, rateLimited, validate(CreateSpaceBody), forward);
app.get('/spaces', authed, rateLimited, forward);
app.post('/spaces/:spaceId/documents', authed, rateLimited, forward);
app.get('/spaces/:spaceId/documents', authed, rateLimited, forward);

// A contract route that somehow has no handler is a 501, not a silent 404.
for (const route of ROUTES) {
  const method = route.method.toLowerCase() as 'get' | 'post' | 'delete';
  app[method](route.path, (_req, res) =>
    res.status(501).json({
      error: `not implemented yet: ${route.method} ${route.path}`,
      status: 501,
      requestId: String(res.locals.requestId)
    })
  );
}

// ---------------------------------------------------------------- static UI

if (existsSync(env.webDist)) {
  app.use(express.static(env.webDist));
  app.get(/^(?!\/(health|stats|threads|memory|spaces|artifacts|evals)).*/, (_req, res) => {
    res.sendFile(`${env.webDist}/index.html`);
  });
}

app.use((req, res) => {
  res.status(404).json({ error: `no route ${req.method} ${req.path}`, status: 404 });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log.error({ err, requestId: res.locals.requestId }, 'gateway error');
  if (res.headersSent) return;
  res.status(502).json({ error: err.message, status: 502, requestId: String(res.locals.requestId) });
});

app.listen(env.port, () => {
  log.info({ port: env.port, agentUrl: env.agentUrl, cors: env.corsOrigins }, 'gateway up');
});
